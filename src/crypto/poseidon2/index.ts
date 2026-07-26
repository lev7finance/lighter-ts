/**
 * The Poseidon2 sponge — the surface the rest of the SDK actually calls.
 *
 * Every L2 transaction hash is {@link hashToQuinticExtension} over an ordered list of field
 * elements. Grouped orders hash each leg with {@link hashNoPad} and fold the legs with
 * {@link hashTwoToOne}. The Schnorr challenge is {@link hashToQuinticExtension} over a 10-element
 * input, and so are the read-only auth token and (per `docs/decisions.md` D2) the hedged signing
 * nonce. One function, one permutation, one set of parameters, everywhere.
 *
 * Despite the file name this is **not** a barrel for the crypto layer: it is the Poseidon2 module's
 * own surface. The permutation lives in `./permutation.ts` and the constants in
 * `./constants.generated.ts`; both are re-exported here so callers never reach past this module.
 *
 * ## The sponge is defined by what it does not do
 *
 * There is **no padding, no domain separation, no capacity tag and no length encoding**. The state
 * starts at twelve zeros for every call from every caller, absorption *overwrites* rate lanes, and a
 * short final block leaves the untouched rate lanes holding whatever the previous permutation put
 * there. Everything below follows from that, and none of it is a defect to be repaired:
 *
 * 1. **Absorption assigns.** `S[j] = input[i + j]`. Never `+=`, never `^=`. Capacity lanes 8..11 are
 *    never written by absorption at all — they start at zero and evolve only through the permutation
 *    (`docs/protocol-notes.md` §2.5).
 * 2. **A short final block does not re-zero the rest of the rate.** For a 9-element input the second
 *    block writes `S[0]` only; `S[1..7]` keep the previous permutation's output. Re-zeroing them is
 *    padding by another name and produces a different hash for every input whose length is not a
 *    multiple of 8. Pinned by the length-9, -17 rows of `poseidon2.json`.
 * 3. **Empty input performs zero permutations.** `hashToQuinticExtension([])` is the `GF(p^5)` zero
 *    and `hashNoPad([])` is `[0, 0, 0, 0]`, read straight out of the all-zero state. Pinned by the
 *    `"input": []` rows.
 * 4. **Trailing zeros are invisible below the rate.** `H([1]) === H([1, 0]) === H([1, 0, …, 0])` for
 *    up to eight elements, and `H([])` is a distinguished zero. These collisions are *expected
 *    behaviour*; the tests assert them. Collision resistance for transactions comes entirely from
 *    the caller's fixed-arity element layout, which lives in the transaction codec. Adding a length
 *    prefix or a capacity tag here would make every hash this SDK produces incompatible with the
 *    sequencer.
 *
 * ## Naming
 *
 * The vector file calls the general form `hashNToMNoPad`; the export is {@link hashNToM}. The
 * `…NoPad` suffix is dropped throughout the TypeScript API because there is no padded variant to
 * disambiguate from. {@link hashToQuinticExtension} keeps its exact reference spelling — it is the
 * name a downstream reader will grep for.
 *
 * ## State ownership
 *
 * Each call to {@link hashNToM} allocates exactly one twelve-lane {@link State} and reuses it across
 * every block and every squeeze group of that call. There is deliberately **no** module-level
 * scratch buffer: it would be a reentrancy hazard for no measurable gain, since the allocation is
 * tens of nanoseconds against a permutation costing tens of microseconds. This module holds no
 * mutable state between calls and has no top-level side effects beyond freezing one constant.
 *
 * @see `conformance/vectors/poseidon2.json` → `hashToQuinticExtension` (45), `hashNoPad` (17),
 *      `hashNToMNoPad` (16)
 * @see `docs/protocol-notes.md` §2
 */

import { LighterError } from "../../errors.js";
import {
  type Fp,
  FP_ZERO,
  fpArrayFromBytes,
  fpArrayToBytes,
  fpFromInt,
} from "../field/fp.js";
import type { Fp5 } from "../field/fp5.js";

import { OUT, RATE } from "./constants.generated.js";
import { permute, type State } from "./permutation.js";

export { permute } from "./permutation.js";
export type { State } from "./permutation.js";
export {
  CAPACITY,
  OUT,
  RATE,
  ROUNDS_F,
  ROUNDS_P,
  WIDTH,
} from "./constants.generated.js";

/**
 * A four-element Poseidon2 digest: the output of {@link hashNoPad} and the unit that
 * {@link hashTwoToOne} and {@link hashNToOne} fold.
 *
 * A fixed-length readonly tuple rather than `Fp[]`, because the arity is part of the contract —
 * {@link hashTwoToOne} concatenates two of these into exactly eight absorbed elements, and a
 * mis-sized digest would change the hash rather than fail.
 *
 * The 40-byte `GF(p^5)` codec is **not** duplicated here: {@link hashToQuinticExtension} returns an
 * `Fp5` and callers encode it with `fp5ToBytes` from `../field/fp5.js`. {@link hashOutToLeBytes} is
 * this module's, because `HashOut` is this module's type.
 */
export type HashOut = readonly [Fp, Fp, Fp, Fp];

/** Serialized width of a {@link HashOut}: four canonical little-endian `uint64`s. */
const HASH_OUT_BYTES: number = 4 * 8;

/** Number of `GF(p^5)` coefficients, i.e. the squeeze length of {@link hashToQuinticExtension}. */
const DEGREE: number = 5;

/**
 * The all-zero digest, `[0, 0, 0, 0]`.
 *
 * It is a real value, not a sentinel: it is what {@link hashNoPad} returns for the empty input. The
 * grouped-order fold initializes its accumulator to this and then **overwrites** it with the first
 * leg's hash rather than folding into it (`docs/protocol-notes.md` §4) — see {@link hashNToOne}.
 */
export const EMPTY_HASH_OUT: HashOut = Object.freeze<HashOut>([
  FP_ZERO,
  FP_ZERO,
  FP_ZERO,
  FP_ZERO,
]);

/**
 * A fresh, all-zero permutation state.
 *
 * Written out as twelve literals so the result is a tuple of exactly {@link WIDTH} lanes with no
 * cast and no `fill`: `State` is a fixed-arity tuple, so a miscount here is a compile error rather
 * than a wrong hash.
 */
function zeroState(): State {
  return [
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
    FP_ZERO,
  ];
}

/**
 * The general sponge: absorb `input` in {@link RATE}-element blocks, then squeeze `m` elements.
 *
 * ```text
 * S <- [0] * 12
 * for each block of up to 8 inputs:
 *     S[0..n-1] <- block            # OVERWRITE; lanes n..7 and 8..11 are left alone
 *     permute(S)
 * out <- []
 * loop:
 *     for k in 0..7:
 *         out.append(S[k]);  if len(out) == m: return out
 *     permute(S)
 * ```
 *
 * **Inputs are reduced on absorption.** Each element goes through `fpFromInt`, so a caller holding a
 * lazily-reduced or over-range value — the Go reference stores field elements non-canonically, in
 * `[0, 2^64)` (`docs/protocol-notes.md` §1) — gets the same answer the reference gives. Pinned by
 * the non-canonical KAT in the tests.
 *
 * **`m <= 0` throws.** The reference's `HashNToMNoPad` checks its output length *after* appending,
 * so zero or negative counts loop forever (`docs/protocol-notes.md` §2.6). That is reachable from a
 * caller bug, not a theoretical case, so it is rejected before the squeeze loop is entered.
 *
 * @param input the elements to absorb, in order. May be empty — that performs zero permutations.
 * @param m how many field elements to squeeze; must be a positive integer.
 * @returns exactly `m` canonical field elements.
 * @throws RangeError if `m` is not a positive integer.
 */
export function hashNToM(input: readonly Fp[], m: number): Fp[] {
  if (!Number.isInteger(m) || m <= 0) {
    throw new RangeError(
      `hashNToM: output count must be a positive integer, got ${String(m)}` +
        " (the Go reference loops forever here)",
    );
  }

  // One state per call, reused across every block and every squeeze group. Not module-level: that
  // would be a reentrancy hazard, and the allocation is negligible against the permutation.
  const s: State = zeroState();

  for (let i = 0; i < input.length; i += RATE) {
    const n = Math.min(RATE, input.length - i);
    for (let j = 0; j < n; j += 1) {
      // Assignment, never accumulation. Lanes n..7 keep the previous permutation's output and
      // lanes 8..11 are never touched here at all.
      s[j] = fpFromInt(input[i + j] ?? FP_ZERO);
    }
    permute(s);
  }

  const out: Fp[] = [];
  for (;;) {
    for (let k = 0; k < RATE; k += 1) {
      // `k < RATE < WIDTH`, so the lane always exists; the coalesce satisfies
      // `noUncheckedIndexedAccess` without a cast.
      out.push(s[k] ?? FP_ZERO);
      // Checked after appending but *before* the next append — the reference checks after
      // appending too, which is precisely why `m <= 0` had to be rejected above.
      if (out.length === m) return out;
    }
    // Only reached when more than 8 elements are wanted. Squeeze groups are separated by exactly
    // one permutation: none before the first group, one before each subsequent group.
    permute(s);
  }
}

/** Narrow a squeezed array to a {@link HashOut}, checking the arity once. */
function toHashOut(xs: readonly Fp[]): HashOut {
  const [a = FP_ZERO, b = FP_ZERO, c = FP_ZERO, d = FP_ZERO] = xs;
  return [a, b, c, d];
}

/**
 * The four-element digest of an arbitrary element list: {@link hashNToM} with `m = 4`, lanes 0..3 in
 * order.
 *
 * "NoPad" in the reference's name is the whole story — see the module header. `hashNoPad([])` is
 * {@link EMPTY_HASH_OUT}, produced without permuting.
 */
export function hashNoPad(input: readonly Fp[]): HashOut {
  return toHashOut(hashNToM(input, OUT));
}

/**
 * Fold two digests into one.
 *
 * This is an **8-element absorption**, not a 12-lane compression: `a` occupies lanes 0..3, `b` lanes
 * 4..7, and the four capacity lanes are zero going into the single permutation. Populating all
 * twelve lanes — placing anything at all in 8..11 — computes a different function
 * (`docs/protocol-notes.md` §2.5).
 */
export function hashTwoToOne(a: HashOut, b: HashOut): HashOut {
  return hashNoPad([a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]]);
}

/**
 * Fold a list of digests **left to right**, sequentially. This is not a Merkle tree.
 *
 * ```text
 * acc = inputs[0]                                   # assigned, not folded into an empty accumulator
 * for i in 1..n-1:  acc = hashTwoToOne(acc, inputs[i])
 * ```
 *
 * A single-element list returns that element unchanged. Grouped orders depend on exactly this: the
 * accumulator is initialized to an empty hash, but that value is dead because index 0 assigns the
 * first leg's hash directly. Folding from {@link EMPTY_HASH_OUT} instead produces a different result
 * for every group (`docs/protocol-notes.md` §4).
 *
 * The reference never calls this with more than two elements, so in practice it *is*
 * {@link hashTwoToOne} — the general form still has to be right.
 *
 * @throws RangeError on an empty list. The reference indexes element 0 unconditionally and panics.
 */
export function hashNToOne(inputs: readonly HashOut[]): HashOut {
  const first = inputs[0];
  if (first === undefined) {
    throw new RangeError("hashNToOne: input list must contain at least one digest");
  }
  let acc: HashOut = first;
  for (let i = 1; i < inputs.length; i += 1) {
    acc = hashTwoToOne(acc, inputs[i] ?? EMPTY_HASH_OUT);
  }
  return acc;
}

/**
 * Hash to an element of `GF(p^5)` — the transaction message hash, the Schnorr challenge, and the
 * auth-token hash.
 *
 * {@link hashNToM} with `m = 5`; squeezed lanes 0..4 become coefficients `c0..c4` **in order**. No
 * reordering, no reversal, no extra permutation. Encode the result for the wire with `fp5ToBytes`
 * from `../field/fp5.js` (40 bytes, five canonical little-endian `uint64`s).
 *
 * `hashToQuinticExtension([])` is the `GF(p^5)` zero, read out of the all-zero state without
 * permuting.
 */
export function hashToQuinticExtension(input: readonly Fp[]): Fp5 {
  const o = hashNToM(input, DEGREE);
  const [c0 = FP_ZERO, c1 = FP_ZERO, c2 = FP_ZERO, c3 = FP_ZERO, c4 = FP_ZERO] = o;
  return [c0, c1, c2, c3, c4];
}

/**
 * Encode a digest as 32 bytes: four canonical 8-byte little-endian lanes, lane 0 first.
 *
 * Every {@link Fp} is canonical by construction, so this is unconditionally the canonical encoding
 * (`docs/decisions.md` D3: encoders always are).
 */
export function hashOutToLeBytes(h: HashOut): Uint8Array {
  return fpArrayToBytes(h);
}

/**
 * Decode 32 little-endian bytes into a digest. **Strict**: a lane `>= p` is rejected, not reduced.
 *
 * The reducing/rejecting split (`docs/decisions.md` D3) is about the sign/verify interop path, where
 * the reference accepts non-canonical input and a strict parser would reject signatures the
 * sequencer accepts. A 32-byte `HashOut` never travels on that path — the wire form of a hash is the
 * 40-byte `GF(p^5)` encoding — so this keeps the strict default, matching `fpFromBytes` in
 * `../field/fp.js`. The asymmetry is deliberate and is documented at both sites.
 *
 * @throws LighterError `decode` on any length other than 32, or on a non-canonical lane.
 */
export function hashOutFromLeBytes(b: Uint8Array): HashOut {
  if (b.length !== HASH_OUT_BYTES) {
    throw new LighterError(
      "decode",
      `hashOutFromLeBytes: expected ${String(HASH_OUT_BYTES)} bytes, got ${String(b.length)}`,
    );
  }
  return toHashOut(fpArrayFromBytes(b));
}
