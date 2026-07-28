/**
 * Poseidon2 over Goldilocks — the raw 12-lane permutation.
 *
 * Everything algebraic in this SDK stands on this function: the sponge, `hashToQuinticExtension`,
 * every L2 transaction hash, the read-only auth token, the Schnorr challenge, and (per
 * `docs/decisions.md` D2) the hedged-deterministic signing nonce. If one operation here is wrong,
 * every hash the SDK produces is wrong for every input and traceable to nothing.
 *
 * The reference crypto library ships two Poseidon2 implementations and the reference SDK imports
 * both — `poseidon2_goldilocks_plonky2` for transaction hashing, `poseidon2_goldilocks` for auth
 * tokens. Run over the same input they produce byte-identical output; they differ in internal field
 * representation, not in the function computed. There is one permutation here, used everywhere
 * (`docs/protocol-notes.md` §2).
 *
 * ## The four ways this goes silently wrong
 *
 * 1. **There is an external linear layer *before* round 0**, with no round constants. Omitting it is
 *    the classic Poseidon2 bug and yields a completely wrong hash that still looks like a hash
 *    (`docs/protocol-notes.md` §2.2). The all-zero-state vector pins it.
 * 2. **The 4-lane chunk step reads the *original* inputs.** `y3 = t + x3 + 2*x0` needs `x0` before
 *    it is overwritten, so the four assignments cannot be done in place in order
 *    (`docs/protocol-notes.md` §2.3). {@link externalLayer} snapshots all twelve lanes into locals
 *    up front, which makes the mistake structurally impossible rather than merely avoided.
 * 3. **`M4` is `circ(2, 3, 1, 1)`** — the Plonky3 `MDSMat4` — not the `[[5,7,1,3],[4,6,1,1],
 *    [1,3,5,7],[1,1,4,6]]` matrix that appears in some Poseidon2 papers. That is a different
 *    function with plausible-looking output.
 * 4. **The internal layer is `sum + state[i] * diag[i]`**, `sum` over all twelve lanes, the diagonal
 *    used raw. The shape comes from the reference's `MulAccF(self, x, y) = self + x*y`. Do not
 *    subtract one from the diagonal — it already encodes that convention — and do not special-case
 *    lane 0 (`docs/protocol-notes.md` §2.4).
 *
 * ## Reduction strategy
 *
 * Plain `%` throughout, per `docs/decisions.md` D4: the classic Goldilocks `hi * epsilon` fold is
 * 2–3x *slower* under BigInt, where every folding intermediate is a heap allocation.
 *
 * Reduction is deferred exactly once, inside {@link externalLayer}: the `M4` step and the column-sum
 * step run unreduced and a single `%` lands at the end. The bound argument, with all lanes canonical
 * (`< p < 2^64`) on entry:
 *
 * - `t = x0 + x1 + x2 + x3 < 2^66`
 * - `y = t + x + 2*x' < 2^66 + 2^64 + 2^65 < 2^67`
 * - `sigma = y[k] + y[k+4] + y[k+8] < 3 * 2^67 < 2^69`
 * - `y[i] + sigma < 2^67 + 2^69 < 2^70`
 *
 * `bigint` is arbitrary precision, so `2^70` is exact. This is also why the state is a plain tuple
 * and never a `BigUint64Array`: those intermediates would wrap silently, and every typed-array read
 * boxes a fresh BigInt anyway.
 *
 * **Every operand of every `%` in this file is non-negative.** There are no subtractions anywhere in
 * the permutation, which is what makes bare `%` safe here — JavaScript's `%` follows the sign of the
 * dividend, so `(-1n) % P === -1n`. If a subtraction is ever introduced, this invariant dies with it.
 *
 * @see `conformance/vectors/poseidon2.json` → `permutations` (23 rows, all replayed in the tests)
 */

import { P } from "../field/constants.js";
import type { Fp } from "../field/fp.js";
import {
  EXTERNAL_ROUND_CONSTANTS,
  INTERNAL_DIAGONAL,
  INTERNAL_ROUND_CONSTANTS,
  ROUNDS_F,
  ROUNDS_P,
  WIDTH,
} from "./constants.generated.js";

/**
 * The permutation state: exactly twelve field elements, mutated in place.
 *
 * A fixed-arity tuple rather than `Fp[]` so that every literal index is statically known to exist
 * under `noUncheckedIndexedAccess` — no `!`, no `undefined` union, no bounds check to reason about.
 */
export type State = [Fp, Fp, Fp, Fp, Fp, Fp, Fp, Fp, Fp, Fp, Fp, Fp];

/** Twelve constants addressed by literal index only, for the same reason {@link State} is a tuple. */
type Vec12 = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

/**
 * Slice twelve consecutive constants out of a generated table, checking the shape once at module
 * load. A truncated or mis-generated table is a build error, not a wrong hash.
 */
function vec12(src: readonly bigint[], base: number, what: string): Vec12 {
  const out: bigint[] = [];
  for (let i = 0; i < WIDTH; i++) {
    const v = src[base + i];
    if (v === undefined) {
      throw new Error(`poseidon2: ${what} table is short at index ${String(base + i)}`);
    }
    out.push(v);
  }
  return out as unknown as Vec12;
}

if (EXTERNAL_ROUND_CONSTANTS.length !== ROUNDS_F * WIDTH) {
  throw new Error(
    `poseidon2: expected ${String(ROUNDS_F * WIDTH)} external round constants, got ${String(
      EXTERNAL_ROUND_CONSTANTS.length,
    )}`,
  );
}
if (INTERNAL_ROUND_CONSTANTS.length !== ROUNDS_P) {
  throw new Error(
    `poseidon2: expected ${String(ROUNDS_P)} internal round constants, got ${String(
      INTERNAL_ROUND_CONSTANTS.length,
    )}`,
  );
}
if (INTERNAL_DIAGONAL.length !== WIDTH) {
  throw new Error(
    `poseidon2: expected ${String(WIDTH)} diagonal entries, got ${String(INTERNAL_DIAGONAL.length)}`,
  );
}

/** The eight external rounds' constants, one row of twelve each. Row `r` starts at `r * 12`. */
const EC: readonly [Vec12, Vec12, Vec12, Vec12, Vec12, Vec12, Vec12, Vec12] = [
  vec12(EXTERNAL_ROUND_CONSTANTS, 0 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 1 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 2 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 3 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 4 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 5 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 6 * WIDTH, "external"),
  vec12(EXTERNAL_ROUND_CONSTANTS, 7 * WIDTH, "external"),
];

/** The internal linear layer's diagonal, used raw — it already encodes "diagonal minus one". */
const D: Vec12 = vec12(INTERNAL_DIAGONAL, 0, "diagonal");

/**
 * `x^7`, the S-box, as `x^3 * x^4` — four multiplications rather than six.
 *
 * @param v a non-negative `bigint`; callers pass `lane + roundConstant`, which is `< 2^65`.
 * @returns `(v mod p)^7 mod p`, canonical.
 */
function sbox7(v: bigint): Fp {
  const x = v % P;
  const x2 = (x * x) % P;
  const x3 = (x2 * x) % P;
  const x4 = (x2 * x2) % P;
  return ((x3 * x4) % P) as Fp;
}

/**
 * The external linear layer `M_E`, in place.
 *
 * `M4 = circ(2, 3, 1, 1)` over each of the three 4-lane chunks, then the column-sum step
 * `sigma[k] = y[k] + y[k+4] + y[k+8]`, `S[i] = y[i] + sigma[i mod 4]`.
 *
 * Fully unrolled into locals. Every `y` is computed from `a0..a11`, which are read before any write,
 * so the order-dependence trap (`docs/protocol-notes.md` §2.3) cannot be reintroduced by an edit
 * here — there is nothing to overwrite early.
 *
 * All twelve lanes are canonical on entry and canonical on exit; see the module header for the
 * deferred-reduction bound.
 */
function externalLayer(s: State): void {
  // Snapshot BEFORE any write. This is the whole point.
  const a0 = s[0];
  const a1 = s[1];
  const a2 = s[2];
  const a3 = s[3];
  const a4 = s[4];
  const a5 = s[5];
  const a6 = s[6];
  const a7 = s[7];
  const a8 = s[8];
  const a9 = s[9];
  const a10 = s[10];
  const a11 = s[11];

  // M4 on chunk 0. Rows are (2,3,1,1) rotated right:
  //   y0 = 2a0 + 3a1 +  a2 +  a3 = t + a0 + 2a1
  //   y1 =  a0 + 2a1 + 3a2 +  a3 = t + a1 + 2a2
  //   y2 =  a0 +  a1 + 2a2 + 3a3 = t + a2 + 2a3
  //   y3 = 3a0 +  a1 +  a2 + 2a3 = t + a3 + 2a0
  const t0 = a0 + a1 + a2 + a3;
  const y0 = t0 + a0 + 2n * a1;
  const y1 = t0 + a1 + 2n * a2;
  const y2 = t0 + a2 + 2n * a3;
  const y3 = t0 + a3 + 2n * a0;

  // M4 on chunk 1.
  const t1 = a4 + a5 + a6 + a7;
  const y4 = t1 + a4 + 2n * a5;
  const y5 = t1 + a5 + 2n * a6;
  const y6 = t1 + a6 + 2n * a7;
  const y7 = t1 + a7 + 2n * a4;

  // M4 on chunk 2.
  const t2 = a8 + a9 + a10 + a11;
  const y8 = t2 + a8 + 2n * a9;
  const y9 = t2 + a9 + 2n * a10;
  const y10 = t2 + a10 + 2n * a11;
  const y11 = t2 + a11 + 2n * a8;

  // Column sums across the three chunks, then a single reduction per lane.
  const c0 = y0 + y4 + y8;
  const c1 = y1 + y5 + y9;
  const c2 = y2 + y6 + y10;
  const c3 = y3 + y7 + y11;

  s[0] = ((y0 + c0) % P) as Fp;
  s[1] = ((y1 + c1) % P) as Fp;
  s[2] = ((y2 + c2) % P) as Fp;
  s[3] = ((y3 + c3) % P) as Fp;
  s[4] = ((y4 + c0) % P) as Fp;
  s[5] = ((y5 + c1) % P) as Fp;
  s[6] = ((y6 + c2) % P) as Fp;
  s[7] = ((y7 + c3) % P) as Fp;
  s[8] = ((y8 + c0) % P) as Fp;
  s[9] = ((y9 + c1) % P) as Fp;
  s[10] = ((y10 + c2) % P) as Fp;
  s[11] = ((y11 + c3) % P) as Fp;
}

/** One full round: add this round's twelve constants, `x^7` every lane, then `M_E`. */
function fullRound(s: State, rc: Vec12): void {
  s[0] = sbox7(s[0] + rc[0]);
  s[1] = sbox7(s[1] + rc[1]);
  s[2] = sbox7(s[2] + rc[2]);
  s[3] = sbox7(s[3] + rc[3]);
  s[4] = sbox7(s[4] + rc[4]);
  s[5] = sbox7(s[5] + rc[5]);
  s[6] = sbox7(s[6] + rc[6]);
  s[7] = sbox7(s[7] + rc[7]);
  s[8] = sbox7(s[8] + rc[8]);
  s[9] = sbox7(s[9] + rc[9]);
  s[10] = sbox7(s[10] + rc[10]);
  s[11] = sbox7(s[11] + rc[11]);
  externalLayer(s);
}

/**
 * One partial round: add `rc` to lane 0, `x^7` on lane 0 only, then the internal layer `M_I`.
 *
 * `sum` is taken over all twelve lanes *after* the S-box, and lane 0 is then multiplied by `D[0]`
 * exactly like every other lane. `sum < 12 * 2^64 < 2^68` and `lane * D[i] < 2^128`, both exact.
 */
function internalRound(s: State, rc: bigint): void {
  s[0] = sbox7(s[0] + rc);

  const sum =
    s[0] + s[1] + s[2] + s[3] + s[4] + s[5] + s[6] + s[7] + s[8] + s[9] + s[10] + s[11];

  s[0] = ((s[0] * D[0] + sum) % P) as Fp;
  s[1] = ((s[1] * D[1] + sum) % P) as Fp;
  s[2] = ((s[2] * D[2] + sum) % P) as Fp;
  s[3] = ((s[3] * D[3] + sum) % P) as Fp;
  s[4] = ((s[4] * D[4] + sum) % P) as Fp;
  s[5] = ((s[5] * D[5] + sum) % P) as Fp;
  s[6] = ((s[6] * D[6] + sum) % P) as Fp;
  s[7] = ((s[7] * D[7] + sum) % P) as Fp;
  s[8] = ((s[8] * D[8] + sum) % P) as Fp;
  s[9] = ((s[9] * D[9] + sum) % P) as Fp;
  s[10] = ((s[10] * D[10] + sum) % P) as Fp;
  s[11] = ((s[11] * D[11] + sum) % P) as Fp;
}

/**
 * The Poseidon2 permutation, in place on the caller's state.
 *
 * ```text
 * S <- M_E(S)                       # pre-round external layer, NO round constants
 * for r = 0..3:   S <- M_E(SBOX_FULL(S + EC[r]))
 * for r = 0..21:  S[0] <- (S[0] + IC[r])^7 ; S <- M_I(S)
 * for r = 4..7:   S <- M_E(SBOX_FULL(S + EC[r]))
 * ```
 *
 * @param s twelve canonical field elements, overwritten with the permuted state.
 * @returns nothing — the result is `s` itself.
 *
 * Post-condition: all twelve lanes are canonical, in `[0, p)`.
 */
export function permute(s: State): void {
  // The pre-round linear layer. Not part of any round; omitting it is trap 1.
  externalLayer(s);

  fullRound(s, EC[0]);
  fullRound(s, EC[1]);
  fullRound(s, EC[2]);
  fullRound(s, EC[3]);

  // All 22 internal constants, in order. `for..of` over the frozen table rather than an indexed
  // loop so that no element can be skipped or repeated by an off-by-one.
  for (const rc of INTERNAL_ROUND_CONSTANTS) {
    internalRound(s, rc);
  }

  fullRound(s, EC[4]);
  fullRound(s, EC[5]);
  fullRound(s, EC[6]);
  fullRound(s, EC[7]);
}
