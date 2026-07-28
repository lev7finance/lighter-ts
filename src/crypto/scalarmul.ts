/**
 * Scalar multiplication on the ECgFp5 group: `[s]P`, `[s]G`, and `[s]G (+) [e]P`.
 *
 * Everything expensive in the signing path is here. Deriving a public key is `[sk]G`, signing is
 * `[k]G`, verifying is `[s]G (+) [e]P`. Each one is a signed 5-bit window over the 64 recoded digits
 * that `src/crypto/scalar.ts` produces: 63 rounds of five doublings plus one mixed addition, so
 * roughly 320 doublings and 64 mixed additions, which is where the project's performance budget
 * lives (`docs/decisions.md` D4).
 *
 * ## Structure, and why it is shaped this way
 *
 * D4 pre-authorises a fixed-base comb table on `G` if the deployed-Worker gate fails. That
 * constrains the layout of this file rather than its behaviour: *recode -> lookup -> accumulate* are
 * three separable pieces, the generator's table is reached only through {@link generatorWindow}, and
 * the accumulation loop takes a table as an argument. Swapping in a comb replaces that accessor and
 * {@link mulGenerator}'s loop; {@link mulScalar}, {@link mulAddG} and every caller above are
 * untouched.
 *
 * ## What the branchless lookup does and does not buy
 *
 * **Constant-time execution is not achievable in portable TypeScript, and this file does not claim
 * it.** `BigInt` operations allocate, their cost tracks operand magnitude, there is no way to pin a
 * value to a fixed width, and the engine is free to specialise on observed values. The field layer
 * itself branches on zero in a few places. What {@link lookupWindow} provides is the removal of
 * *secret-dependent table indexing and secret-dependent control flow* from the window lookup: it
 * touches all 16 entries in the same order every time and selects arithmetically. That is meaningful
 * against coarse remote timing, and it is **not** a defence against a co-resident attacker observing
 * cache lines or against `BigInt` allocation side channels. Treat a private key used in this runtime
 * as exposed to local attackers.
 *
 * The reference implementation is inconsistent here — it masks the in-loop lookup but reads the top
 * digit with a variable-time one, leaking the top five bits of the secret scalar. That is not
 * reproduced: {@link mulScalar} and {@link mulGenerator} use the branchless lookup for **every**
 * digit including the top. {@link mulAddG} sees only public data and uses the variable-time path
 * throughout.
 *
 * ## Traps
 *
 * - `win[i]` is `[i+1]P`, **not** `[i]P`. There is no `win[-1]`, and digit `0` maps to the affine
 *   neutral `(0, 0)` rather than to `win[0]`.
 * - Always 64 digits, no early exit, no sizing the loop from the scalar's bit length. Leading zero
 *   digits are processed like any other.
 * - Exactly five doublings between digits, and the top digit is loaded *before* the loop rather than
 *   doubled into it.
 * - The table is never built at module scope. Cloudflare Workers budgets startup CPU in the
 *   isolate's global scope, so {@link generatorWindow} builds on first call and memoises.
 *
 * No dependencies and no Node built-ins: `BigInt`, the `GF(p^5)` layer and the group law only.
 */

import { P } from './field/constants.js';
import type { Fp } from './field/fp.js';
import { type Fp5, FP5_ONE, FP5_ZERO } from './field/fp5.js';
import {
  type AffinePoint,
  type CurvePoint,
  GENERATOR,
  batchToAffine,
  pointAdd,
  pointAddAffine,
  pointDouble,
  pointDoubleN,
  pointEquals,
} from './point.js';
import { type Scalar, modN, recodeScalar5 } from './scalar.js';

// ---------------------------------------------------------------------------------------------
// Window parameters
// ---------------------------------------------------------------------------------------------

/** Window width in bits. Digits are signed and lie in `[-15, 16]`. */
export const WINDOW: 5 = 5;

/** Table size, `2^(w-1)`: entry `i` holds `[i+1]P`, so the table covers `[1]P` through `[16]P`. */
export const WINDOW_SIZE: 16 = 16;

/** Digits per scalar, `ceil(320 / 5)`. Must match `recodeScalar5`; see the module header. */
const DIGITS: 64 = 64;

/** All-ones over the width of a base-field element. Every `Fp` is below `p < 2^64`. */
const MASK64: bigint = 0xffffffffffffffffn;

/**
 * The affine neutral `(x, u) = (0, 0)`, which digit `0` selects.
 *
 * Mixed-adding it leaves the accumulator unchanged up to a common projective factor, which is
 * exactly what a zero digit must do.
 */
const AFFINE_NEUTRAL: AffinePoint = Object.freeze({ x: FP5_ZERO, u: FP5_ZERO });

// ---------------------------------------------------------------------------------------------
// Window construction
// ---------------------------------------------------------------------------------------------

/**
 * Build the odd-and-even window table for `p`: `win[i] = [i+1]P` for `i` in `[0, 15]`.
 *
 * The build order is `even -> add P`, `odd -> double the half index`, which reaches `[16]P` in 15
 * group operations and never needs a multiple outside the table. All 16 results are converted to
 * `(x, u)` affine with a **single** `GF(p^5)` inversion via Montgomery's trick, which is what makes
 * the table affordable — an inversion costs on the order of a hundred multiplications.
 *
 * The off-by-one is the trap: `win[0]` is `P`, not the neutral. A table shifted by one produces a
 * result wrong by a multiple of `P`, which looks like a field bug.
 */
export function makeWindow(p: CurvePoint): AffinePoint[] {
  const tmp: CurvePoint[] = new Array<CurvePoint>(WINDOW_SIZE);
  tmp[0] = p;
  for (let i: number = 1; i < WINDOW_SIZE; i += 1) {
    //  `pointAdd`, not `pointAddAffine`: `p` is a general fractional point (`GENERATOR` has T = 4).
    tmp[i] =
      (i & 1) === 0
        ? pointAdd(tmp[i - 1] as CurvePoint, p)
        : pointDouble(tmp[i >> 1] as CurvePoint);
  }
  return batchToAffine(tmp);
}

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

/**
 * Select `[d]P` from `win` for a signed digit `d` in `[-15, 16]`, without branching on `d` and
 * without indexing memory by `d`.
 *
 * Every one of the 16 entries is read, in the same order, on every call. The match is an arithmetic
 * mask: `~(((i - idx) | (idx - i)) >> 31)` is all-ones exactly when `i === idx` and zero otherwise, so
 * the selection is an OR of masked coefficients. `d = 0` gives `idx = -1`, which matches nothing and
 * therefore yields the affine neutral `(0, 0)`.
 *
 * Negation is `(x, u) |-> (x, -u)` and is also selected arithmetically. `(p - u) mod p` is used
 * rather than the field layer's `fp5Neg`, because the latter branches on a zero coefficient.
 *
 * Read the module header before relying on this: it removes secret-dependent indexing, not every
 * timing signal.
 */
export function lookupWindow(win: readonly AffinePoint[], digit: number): AffinePoint {
  //  sign is -1 for a negative digit and 0 otherwise; mag = |digit|; idx = mag - 1, so 0 -> -1.
  const sign: number = digit >> 31;
  const idx: number = ((digit ^ sign) - sign) - 1;

  const negMask: bigint = BigInt(sign) & MASK64;
  const posMask: bigint = negMask ^ MASK64;

  let x0: bigint = 0n;
  let x1: bigint = 0n;
  let x2: bigint = 0n;
  let x3: bigint = 0n;
  let x4: bigint = 0n;
  let u0: bigint = 0n;
  let u1: bigint = 0n;
  let u2: bigint = 0n;
  let u3: bigint = 0n;
  let u4: bigint = 0n;

  for (let i: number = 0; i < WINDOW_SIZE; i += 1) {
    const e: AffinePoint = win[i] as AffinePoint;
    const diff: number = i - idx;
    const m: bigint = BigInt(~((diff | -diff) >> 31)) & MASK64;
    const ex: Fp5 = e.x;
    const eu: Fp5 = e.u;
    x0 |= ex[0] & m;
    x1 |= ex[1] & m;
    x2 |= ex[2] & m;
    x3 |= ex[3] & m;
    x4 |= ex[4] & m;
    u0 |= eu[0] & m;
    u1 |= eu[1] & m;
    u2 |= eu[2] & m;
    u3 |= eu[3] & m;
    u4 |= eu[4] & m;
  }

  return {
    x: [x0 as Fp, x1 as Fp, x2 as Fp, x3 as Fp, x4 as Fp],
    u: [
      ((u0 & posMask) | (((P - u0) % P) & negMask)) as Fp,
      ((u1 & posMask) | (((P - u1) % P) & negMask)) as Fp,
      ((u2 & posMask) | (((P - u2) % P) & negMask)) as Fp,
      ((u3 & posMask) | (((P - u3) % P) & negMask)) as Fp,
      ((u4 & posMask) | (((P - u4) % P) & negMask)) as Fp,
    ],
  };
}

/**
 * The same selection, written the obvious way. **Public inputs only** — verification.
 *
 * Agrees with {@link lookupWindow} on all 32 digits, which is asserted rather than assumed.
 */
export function lookupWindowVarTime(win: readonly AffinePoint[], digit: number): AffinePoint {
  if (digit === 0) return AFFINE_NEUTRAL;
  if (digit > 0) return win[digit - 1] as AffinePoint;
  const e: AffinePoint = win[-digit - 1] as AffinePoint;
  const u: Fp5 = e.u;
  return {
    x: e.x,
    u: [
      ((P - u[0]) % P) as Fp,
      ((P - u[1]) % P) as Fp,
      ((P - u[2]) % P) as Fp,
      ((P - u[3]) % P) as Fp,
      ((P - u[4]) % P) as Fp,
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The generator's table
// ---------------------------------------------------------------------------------------------

/**
 * Memo for {@link generatorWindow}. Starts `undefined`; nothing populates it at module scope.
 *
 * This is the file's only mutable state. It is a pure function of `G`, so a torn or duplicated
 * build across isolates is harmless.
 */
let generatorWindowMemo: readonly AffinePoint[] | undefined = undefined;

/**
 * The window table for `G`, built on first call and memoised for the life of the module instance.
 *
 * Deliberately not a module-scope constant and deliberately not a hard-coded literal: Cloudflare
 * Workers budgets startup CPU in the isolate's global scope, and a baked-in table would add ~10 KB
 * of hex to the bundle to save a few hundred field multiplications performed once.
 *
 * This accessor is the seam D4's comb fallback replaces.
 */
export function generatorWindow(): readonly AffinePoint[] {
  if (generatorWindowMemo === undefined) {
    generatorWindowMemo = Object.freeze(makeWindow(GENERATOR));
  }
  return generatorWindowMemo;
}

/**
 * Whether {@link generatorWindow} has been called yet in this module instance.
 *
 * Exists so the memoisation and the absence of module-scope work can be asserted rather than
 * assumed. Not part of the SDK's surface; no production code path calls it.
 */
export function generatorWindowIsBuilt(): boolean {
  return generatorWindowMemo !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------------------------

/** `(x, u)` to fractional `(x:1, u:1)`. The affine neutral `(0, 0)` maps to the neutral. */
function affineToPoint(a: AffinePoint): CurvePoint {
  return { X: a.x, Z: FP5_ONE, U: a.u, T: FP5_ONE };
}

/**
 * The shared accumulation loop: top digit first, then 63 rounds of five doublings and one mixed
 * addition. `lookup` decides whether the walk is branchless or variable-time.
 */
function accumulate(
  win: readonly AffinePoint[],
  digits: Int32Array,
  lookup: (w: readonly AffinePoint[], d: number) => AffinePoint,
): CurvePoint {
  let acc: CurvePoint = affineToPoint(lookup(win, digits[DIGITS - 1] as number));
  for (let i: number = DIGITS - 2; i >= 0; i -= 1) {
    acc = pointDoubleN(acc, WINDOW);
    acc = pointAddAffine(acc, lookup(win, digits[i] as number));
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------------------------

/**
 * `[s]P` for an arbitrary base point — the variable-base path, used by verification.
 *
 * `s` is reduced with `modN` on entry rather than trusting the caller, so `[0]P` is the neutral and
 * `[n]P` is the neutral, not `P`. The window table is rebuilt per call, which is inherent to a
 * variable base.
 */
export function mulScalar(p: CurvePoint, s: Scalar): CurvePoint {
  return accumulate(makeWindow(p), recodeScalar5(modN(s)), lookupWindow);
}

/**
 * `[s]G` — the fixed-base path, used by key derivation and by signing's `[k]G`.
 *
 * Uses the memoised generator table and the branchless lookup for every digit, top one included:
 * `s` is a private key or a nonce on this path.
 */
export function mulGenerator(s: Scalar): CurvePoint {
  return accumulate(generatorWindow(), recodeScalar5(modN(s)), lookupWindow);
}

/**
 * `[s]G (+) [e]P`, the verification equation, over **one** shared doubling chain.
 *
 * Two tables and two mixed additions per round, so the 320 doublings are paid once instead of twice.
 * Every input is public — a signature and a public key — so the variable-time lookup is used
 * throughout; there is no secret to leak and the masked scan would only cost time.
 */
export function mulAddG(p: CurvePoint, s: Scalar, e: Scalar): CurvePoint {
  const gWin: readonly AffinePoint[] = generatorWindow();
  const pWin: readonly AffinePoint[] = makeWindow(p);
  const ds: Int32Array = recodeScalar5(modN(s));
  const de: Int32Array = recodeScalar5(modN(e));

  let acc: CurvePoint = affineToPoint(lookupWindowVarTime(gWin, ds[DIGITS - 1] as number));
  acc = pointAddAffine(acc, lookupWindowVarTime(pWin, de[DIGITS - 1] as number));
  for (let i: number = DIGITS - 2; i >= 0; i -= 1) {
    acc = pointDoubleN(acc, WINDOW);
    acc = pointAddAffine(acc, lookupWindowVarTime(gWin, ds[i] as number));
    acc = pointAddAffine(acc, lookupWindowVarTime(pWin, de[i] as number));
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

/**
 * Does `win` hold `[1]P .. [16]P` for `p`? A test helper, checked against repeated {@link pointAdd}.
 *
 * Not called on any hot path; it exists so the off-by-one that {@link makeWindow} is most likely to
 * acquire has a name.
 */
export function windowIsWellFormed(win: readonly AffinePoint[], p: CurvePoint): boolean {
  if (win.length !== WINDOW_SIZE) return false;
  let expected: CurvePoint = p;
  for (let i: number = 0; i < WINDOW_SIZE; i += 1) {
    if (!pointEquals(affineToPoint(win[i] as AffinePoint), expected)) return false;
    expected = pointAdd(expected, p);
  }
  return true;
}
