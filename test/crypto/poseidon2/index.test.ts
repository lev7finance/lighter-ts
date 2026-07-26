/**
 * Conformance tests for the Poseidon2 sponge.
 *
 * The sponge is short and almost all of its risk is in what it *does not* do, so the coverage is
 * layered around the places where a plausible implementation diverges silently:
 *
 * 1. **Vectors** — all 45 `hashToQuinticExtension` rows (limbs *and* `outputLeBytesHex`), all 17
 *    `hashNoPad` rows and all 16 `hashNToMNoPad` rows of `conformance/vectors/poseidon2.json`,
 *    with the row counts themselves asserted so a truncated vector file cannot pass quietly.
 * 2. **The multi-squeeze branch, which the corpus does not reach.** `hashNToMNoPad` only ever asks
 *    for 1, 4, 5 or 8 outputs, and `numOutputs === 8` returns at the end of the first squeeze group
 *    *without* the trailing permutation. So "permute between output groups" is completely untested
 *    by the vector file. Two independent things pin it here: the `hashNToM([], 12)` golden, whose
 *    tail is literally the `permutations` row for the all-zero state, and a squeeze model written
 *    with a deliberately different structure (recompute `permute^g` from scratch per group instead
 *    of advancing incrementally), cross-checked out to 30 outputs.
 * 3. **Digest-fold anchors derived from the corpus rather than restated.** `hashTwoToOne(a, b)` is
 *    by definition `hashNoPad(a ‖ b)`, so an 8-element `hashNoPad` row *is* an explicit
 *    `hashTwoToOne` vector; the length-1/2/3 `hashNToOne` chains are built the same way.
 * 4. **Documented collisions**, asserted as expected behaviour. See the block at the bottom.
 * 5. **Guards** — `m <= 0` (the reference loops forever), the empty fold list (the reference
 *    panics), and the 32-byte codec's length and canonicality checks.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { P } from "../../../src/crypto/field/constants.js";
import type { Fp } from "../../../src/crypto/field/fp.js";
import { fp5ToBytes } from "../../../src/crypto/field/fp5.js";
import {
  CAPACITY,
  EMPTY_HASH_OUT,
  type HashOut,
  OUT,
  RATE,
  WIDTH,
  hashNToM,
  hashNToOne,
  hashNoPad,
  hashTwoToOne,
  hashOutFromLeBytes,
  hashOutToLeBytes,
  hashToQuinticExtension,
  permute,
} from "../../../src/crypto/poseidon2/index.js";
import type { State } from "../../../src/crypto/poseidon2/permutation.js";

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

interface HashToQuinticVector {
  readonly input: readonly string[];
  readonly output: readonly string[];
  readonly outputLeBytesHex: string;
}

interface HashNoPadVector {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

interface HashNToMVector {
  readonly input: readonly string[];
  readonly numOutputs: number;
  readonly output: readonly string[];
}

interface PermutationVector {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

interface Poseidon2Vectors {
  readonly permutations: readonly PermutationVector[];
  readonly hashToQuinticExtension: readonly HashToQuinticVector[];
  readonly hashNoPad: readonly HashNoPadVector[];
  readonly hashNToMNoPad: readonly HashNToMVector[];
}

const vectors = (await import("../../../conformance/vectors/poseidon2.json", {
  with: { type: "json" },
})) as unknown as { default: Poseidon2Vectors };

const V: Poseidon2Vectors = vectors.default;

/** Vector limbs are decimal strings; the sponge takes branded canonical elements. */
function toFp(xs: readonly string[]): Fp[] {
  return xs.map((x) => BigInt(x) as Fp);
}

function strings(xs: readonly bigint[]): string[] {
  return xs.map((x) => x.toString());
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

/** `n` as a {@link HashOut} of plain bigints, for readable literals in the fold tests. */
function digest(xs: readonly bigint[]): HashOut {
  const [a = 0n, b = 0n, c = 0n, d = 0n] = xs;
  return [a as Fp, b as Fp, c as Fp, d as Fp];
}

// ---------------------------------------------------------------------------------------------
// 1. Vector replay
// ---------------------------------------------------------------------------------------------

describe("parameters", () => {
  test("the module re-exports the sponge's shape", () => {
    expect(WIDTH).toBe(12);
    expect(RATE).toBe(8);
    expect(CAPACITY).toBe(4);
    expect(OUT).toBe(4);
    expect(RATE + CAPACITY).toBe(WIDTH);
  });
});

describe("hashToQuinticExtension — conformance/vectors/poseidon2.json", () => {
  test("the corpus still has 45 rows covering input lengths 0..24", () => {
    expect(V.hashToQuinticExtension.length).toBe(45);
    const lengths = new Set(V.hashToQuinticExtension.map((r) => r.input.length));
    for (let n = 0; n <= 24; n += 1) expect(lengths.has(n)).toBe(true);
  });

  for (const [i, row] of V.hashToQuinticExtension.entries()) {
    test(`row ${String(i)} (${String(row.input.length)} elements)`, () => {
      const got = hashToQuinticExtension(toFp(row.input));
      expect(strings(got)).toEqual([...row.output]);
      // The 40-byte encoding comes from the field module, never re-implemented in the sponge.
      expect(hex(fp5ToBytes(got))).toBe(row.outputLeBytesHex);
    });
  }
});

describe("hashNoPad — conformance/vectors/poseidon2.json", () => {
  test("the corpus still has 17 rows covering input lengths 0..16", () => {
    expect(V.hashNoPad.length).toBe(17);
    const lengths = new Set(V.hashNoPad.map((r) => r.input.length));
    for (let n = 0; n <= 16; n += 1) expect(lengths.has(n)).toBe(true);
  });

  for (const [i, row] of V.hashNoPad.entries()) {
    test(`row ${String(i)} (${String(row.input.length)} elements)`, () => {
      expect(strings(hashNoPad(toFp(row.input)))).toEqual([...row.output]);
    });
  }
});

describe("hashNToM — conformance/vectors/poseidon2.json → hashNToMNoPad", () => {
  test("the corpus still has 16 rows, and still never asks for more than 8 outputs", () => {
    expect(V.hashNToMNoPad.length).toBe(16);
    const counts = new Set(V.hashNToMNoPad.map((r) => r.numOutputs));
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 4, 5, 8]);
    // If this ever fails, the multi-squeeze branch has gained real vector coverage and the model
    // cross-check below can be demoted.
    expect(Math.max(...counts)).toBeLessThanOrEqual(RATE);
  });

  for (const [i, row] of V.hashNToMNoPad.entries()) {
    test(`row ${String(i)} (${String(row.input.length)} in, ${String(row.numOutputs)} out)`, () => {
      const got = hashNToM(toFp(row.input), row.numOutputs);
      expect(got.length).toBe(row.numOutputs);
      expect(strings(got)).toEqual([...row.output]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// 2. The multi-squeeze branch — invisible to the whole vector file
// ---------------------------------------------------------------------------------------------

describe("multi-squeeze", () => {
  /** The `permutations` row for the all-zero state: the first squeeze group after `[0]*12`. */
  const zeroPermutation: PermutationVector | undefined = V.permutations.find((p) =>
    p.input.every((x) => x === "0"),
  );

  test("hashNToM([], 12) — the golden that pins the squeeze loop on its own", () => {
    // Twelve outputs from an empty input: eight zeros read out of the untouched state, then ONE
    // permutation, then four more lanes. Off-by-one in either direction (permuting after the 8th
    // output rather than before the 9th, or permuting twice) changes the tail.
    expect(strings(hashNToM([], 12))).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "7182099517097165596",
      "9311216678150108034",
      "8831900494918587432",
      "10774846510254277933",
    ]);
  });

  test("that golden's tail is exactly the all-zero permutation vector", () => {
    // Same assertion, sourced from the vector file instead of a transcribed literal, so the two
    // cannot drift apart: lanes 8..11 of hashNToM([], 12) are lanes 0..3 of permute([0]*12).
    expect(zeroPermutation).toBeDefined();
    const expected = zeroPermutation?.output.slice(0, 4) ?? [];
    expect(strings(hashNToM([], 12).slice(8, 12))).toEqual([...expected]);
  });

  test("hashNToM([], 8) does NOT permute — the boundary case the corpus stops at", () => {
    expect(strings(hashNToM([], 8))).toEqual(["0", "0", "0", "0", "0", "0", "0", "0"]);
  });

  // A squeeze model with a deliberately different shape. The implementation advances one state
  // incrementally; this recomputes `permute^g` from a fresh copy for every output group, so an
  // off-by-one in the incremental version cannot be mirrored here. `permute` itself is pinned by
  // the 23 `permutations` rows, and absorption is pinned by every `m <= 8` row above.
  function absorbed(input: readonly bigint[]): State {
    const s = (new Array<bigint>(WIDTH).fill(0n) as bigint[]) as unknown as State;
    for (let i = 0; i < input.length; i += RATE) {
      const n = Math.min(RATE, input.length - i);
      for (let j = 0; j < n; j += 1) {
        const v = input[i + j] ?? 0n;
        const r = v % P;
        s[j] = (r < 0n ? r + P : r) as Fp;
      }
      permute(s);
    }
    return s;
  }

  function squeezeModel(input: readonly bigint[], m: number): bigint[] {
    const base = absorbed(input);
    const out: bigint[] = [];
    for (let t = 0; t < m; t += 1) {
      const group = Math.floor(t / RATE);
      const lane = t % RATE;
      const s = [...base] as unknown as State;
      for (let g = 0; g < group; g += 1) permute(s);
      out.push(s[lane] ?? 0n);
    }
    return out;
  }

  const modelInputs: readonly (readonly bigint[])[] = [
    [],
    [1n],
    [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n],
    [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
    Array.from({ length: 12 }, (_, i) => BigInt(i) * 1000003n + 7n),
    Array.from({ length: 17 }, (_, i) => BigInt(i) * 6364136223846793005n % P),
  ];

  for (const [i, input] of modelInputs.entries()) {
    test(`model agreement, input ${String(i)} (${String(input.length)} elements), m = 1..30`, () => {
      for (let m = 1; m <= 30; m += 1) {
        expect(strings(hashNToM(input as readonly Fp[], m))).toEqual(strings(squeezeModel(input, m)));
      }
    });
  }

  test("m = 12 for a 12-element input agrees with the corpus on its first 8 outputs", () => {
    const row = V.hashNToMNoPad.find((r) => r.input.length === 12 && r.numOutputs === 8);
    expect(row).toBeDefined();
    const input = toFp(row?.input ?? []);
    const twelve = hashNToM(input, 12);
    expect(strings(twelve.slice(0, 8))).toEqual([...(row?.output ?? [])]);
    expect(strings(twelve)).toEqual(strings(squeezeModel(input, 12)));
  });

  test("prefix consistency: hashNToM(x, m) starts with hashNToM(x, k) for every k < m", () => {
    const input = toFp(V.hashNToMNoPad[12]?.input ?? []);
    const long = hashNToM(input, 24);
    for (let k = 1; k < 24; k += 1) {
      expect(strings(hashNToM(input, k))).toEqual(strings(long.slice(0, k)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Digest folds
// ---------------------------------------------------------------------------------------------

describe("hashTwoToOne", () => {
  test("is an 8-element absorption, not a 12-lane compression", () => {
    // Derived from the corpus rather than restated: an 8-element `hashNoPad` row split down the
    // middle IS an explicit hashTwoToOne vector, because the definition is exactly `a ‖ b`. A
    // 12-lane implementation — anything at all placed in the capacity lanes — fails here.
    const row = V.hashNoPad.find((r) => r.input.length === 8);
    expect(row).toBeDefined();
    const xs = toFp(row?.input ?? []);
    const a = digest(xs.slice(0, 4));
    const b = digest(xs.slice(4, 8));
    expect(strings(hashTwoToOne(a, b))).toEqual([...(row?.output ?? [])]);
  });

  test("the capacity lanes really are zero going in", () => {
    // Independent restatement: absorb the same 8 elements into a 12-lane state whose capacity is
    // zero and permute once. Anything else in lanes 8..11 gives a different digest.
    const a = digest([1n, 2n, 3n, 4n]);
    const b = digest([5n, 6n, 7n, 8n]);
    const s = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 0n, 0n, 0n, 0n] as unknown as State;
    permute(s);
    expect(strings(hashTwoToOne(a, b))).toEqual(strings([...s].slice(0, 4) as bigint[]));
  });
});

describe("hashNToOne — a left fold, not a tree", () => {
  const a = digest([1n, 2n, 3n, 4n]);
  const b = digest([5n, 6n, 7n, 8n]);
  const c = digest([9n, 10n, 11n, 12n]);

  test("length 1 returns the element unchanged", () => {
    expect(hashNToOne([a])).toEqual(a);
    // Not merely equal — it must not have been hashed. Folding `EMPTY_HASH_OUT` into it, which is
    // what a naive accumulator loop does, gives something else entirely.
    expect(strings(hashNToOne([a]))).not.toEqual(strings(hashTwoToOne(EMPTY_HASH_OUT, a)));
  });

  test("length 2 is exactly hashTwoToOne", () => {
    expect(strings(hashNToOne([a, b]))).toEqual(strings(hashTwoToOne(a, b)));
  });

  test("length 3 folds left, not as a balanced tree", () => {
    const left = hashTwoToOne(hashTwoToOne(a, b), c);
    const tree = hashTwoToOne(a, hashTwoToOne(b, c));
    expect(strings(hashNToOne([a, b, c]))).toEqual(strings(left));
    expect(strings(left)).not.toEqual(strings(tree));
  });

  test("the whole chain is expressible through vector-backed hashNoPad", () => {
    // The fold has no primitive of its own: every step is `hashNoPad` of an 8-element list, and
    // `hashNoPad` over 8 elements is pinned by the corpus.
    const step1 = hashNoPad([...a, ...b]);
    const step2 = hashNoPad([...step1, ...c]);
    expect(strings(hashNToOne([a, b, c]))).toEqual(strings(step2));
  });

  test("an empty list throws — the reference indexes element 0 and panics", () => {
    expect(() => hashNToOne([])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Absorption semantics
// ---------------------------------------------------------------------------------------------

describe("absorption", () => {
  test("over-range inputs are reduced, matching the reference's non-canonical storage", () => {
    // Go stores a Goldilocks element as a raw uint64 in [0, 2^64), one ORDER above the true
    // residue (`docs/protocol-notes.md` §1). A caller holding such a value must get the same
    // answer, so absorption reduces.
    const nonCanonical = [P + 1n, P + 2n, P + 3n, 2n ** 64n - 1n, 2n ** 64n - 2n] as Fp[];
    expect(strings(hashNoPad(nonCanonical))).toEqual([
      "14216040864787980138",
      "17275303675000904868",
      "11831395338463193314",
      "281267649235863375",
    ]);
    const reduced = [1n, 2n, 3n, 4294967294n, 4294967293n] as Fp[];
    expect(strings(hashNoPad(nonCanonical))).toEqual(strings(hashNoPad(reduced)));
  });

  test("the int64 -1 mapping: 2^64-1 absorbs as 4294967294, not as p-1", () => {
    // `AccountIndex = -1` is legal and sign-extends to 2^64-1, which reduces to 2^32-2
    // (`docs/protocol-notes.md` §3.1). Both are plausible-looking field elements; only one is
    // right, and `p - 1` is the wrong one.
    const asU64 = [2n ** 64n - 1n] as Fp[];
    expect(strings(hashNoPad(asU64))).toEqual(strings(hashNoPad([4294967294n] as Fp[])));
    expect(strings(hashNoPad(asU64))).not.toEqual(strings(hashNoPad([P - 1n] as Fp[])));
  });

  test("a short final block does not re-zero the remaining rate lanes", () => {
    // For a 9-element input the second block writes S[0] only. Re-zeroing S[1..7] is padding by
    // another name; it would make these two agree, and they must not.
    const nine = Array.from({ length: 9 }, (_, i) => BigInt(i + 1) as Fp);
    const reZeroed = (() => {
      const s = (new Array<bigint>(WIDTH).fill(0n) as bigint[]) as unknown as State;
      for (let j = 0; j < 8; j += 1) s[j] = nine[j] as Fp;
      permute(s);
      for (let j = 0; j < WIDTH; j += 1) if (j < RATE) s[j] = (j === 0 ? nine[8] : 0n) as Fp;
      permute(s);
      return [...s].slice(0, 4) as bigint[];
    })();
    expect(strings(hashNoPad(nine))).not.toEqual(strings(reZeroed));
  });

  test("absorption overwrites rather than accumulating", () => {
    // If lanes were added into rather than assigned, a second block whose values happen to be the
    // additive inverses of the first block's leftovers would collide with something. The cheap
    // observable version: 16 elements where the second block repeats the first must not equal
    // 8 elements doubled.
    const first = Array.from({ length: 8 }, (_, i) => BigInt(i + 1) as Fp);
    const doubled = first.map((x) => ((x * 2n) % P) as Fp);
    expect(strings(hashNoPad([...first, ...first]))).not.toEqual(strings(hashNoPad(doubled)));
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Guards
// ---------------------------------------------------------------------------------------------

describe("guards", () => {
  test("m <= 0 throws RangeError instead of looping forever", () => {
    // `HashNToMNoPad` in the reference checks its length *after* appending, so 0 and negative
    // counts never terminate (`docs/protocol-notes.md` §2.6). Reachable from a caller bug.
    expect(() => hashNToM([1n as Fp], 0)).toThrow(RangeError);
    expect(() => hashNToM([1n as Fp], -1)).toThrow(RangeError);
    expect(() => hashNToM([], 0)).toThrow(RangeError);
  });

  test("a non-integer m throws rather than squeezing an unreachable count", () => {
    expect(() => hashNToM([1n as Fp], 1.5)).toThrow(RangeError);
    expect(() => hashNToM([1n as Fp], Number.NaN)).toThrow(RangeError);
    expect(() => hashNToM([1n as Fp], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("m = 1 is fine", () => {
    expect(hashNToM([1n as Fp], 1).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Codec
// ---------------------------------------------------------------------------------------------

describe("hashOut codec", () => {
  test("EMPTY_HASH_OUT is [0, 0, 0, 0] and is what the empty input hashes to", () => {
    expect(strings(EMPTY_HASH_OUT)).toEqual(["0", "0", "0", "0"]);
    expect(strings(hashNoPad([]))).toEqual(["0", "0", "0", "0"]);
  });

  test("32 bytes, four canonical little-endian lanes, lane 0 first", () => {
    const b = hashOutToLeBytes(digest([1n, 2n, 3n, 4n]));
    expect(b.length).toBe(32);
    expect(hex(b)).toBe(
      "0100000000000000" + "0200000000000000" + "0300000000000000" + "0400000000000000",
    );
  });

  test("round-trips every hashNoPad vector row", () => {
    for (const row of V.hashNoPad) {
      const h = hashNoPad(toFp(row.input));
      const bytes = hashOutToLeBytes(h);
      expect(bytes.length).toBe(32);
      expect(strings(hashOutFromLeBytes(bytes))).toEqual([...row.output]);
    }
  });

  test("decodes p - 1 in every lane", () => {
    const h = digest([P - 1n, P - 1n, P - 1n, P - 1n]);
    expect(strings(hashOutFromLeBytes(hashOutToLeBytes(h)))).toEqual(strings(h));
  });

  test("throws on any length other than 32", () => {
    for (const n of [0, 1, 8, 24, 31, 33, 40, 64]) {
      expect(() => hashOutFromLeBytes(new Uint8Array(n))).toThrow();
    }
  });

  test("rejects a non-canonical lane", () => {
    const b = new Uint8Array(32).fill(0xff); // every lane is 2^64 - 1, well above p
    expect(() => hashOutFromLeBytes(b)).toThrow();
  });

  test("decodes from an offset view without reading past it", () => {
    const backing = new Uint8Array(40).fill(0xaa);
    backing.set(hashOutToLeBytes(digest([7n, 8n, 9n, 10n])), 4);
    expect(strings(hashOutFromLeBytes(backing.subarray(4, 36)))).toEqual(["7", "8", "9", "10"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Documented collisions — EXPECTED BEHAVIOUR. DO NOT "FIX".
//
// There is no padding, no domain separation, no capacity tag and no length encoding. The state
// starts at twelve zeros for every call from every caller, so trailing zeros are invisible below
// the rate and the empty input is a distinguished zero. These are properties of the function the
// sequencer computes. Adding a length prefix, a capacity tag or a domain separator to remove them
// would make every hash this SDK produces incompatible with the exchange, and would be caught only
// by the conformance corpus — not by anything that looks like a security review.
//
// Collision resistance for real inputs comes entirely from the caller's fixed-arity element layout,
// which lives in the transaction codec: every transaction type absorbs a fixed number of elements
// in a fixed order, with the chain id and tx type first.
// ---------------------------------------------------------------------------------------------

describe("documented collisions (expected behaviour — do not fix)", () => {
  test("trailing zeros are invisible for inputs of at most 8 elements", () => {
    const one = strings(hashToQuinticExtension([1n as Fp]));
    expect(strings(hashToQuinticExtension([1n, 0n] as Fp[]))).toEqual(one);
    expect(
      strings(hashToQuinticExtension([1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as Fp[])),
    ).toEqual(one);
  });

  test("H([0]) === H([0, 0]) === H([0] * 8)", () => {
    const zero = strings(hashToQuinticExtension([0n as Fp]));
    expect(strings(hashToQuinticExtension([0n, 0n] as Fp[]))).toEqual(zero);
    expect(
      strings(hashToQuinticExtension([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as Fp[])),
    ).toEqual(zero);
  });

  test("H([]) is the GF(p^5) zero, and is NOT H([0])", () => {
    // The empty input performs zero permutations and reads the all-zero state straight out.
    // H([0]) absorbs one block and permutes once, so the two differ — an implementation that
    // permutes unconditionally collapses them and fails the `"input": []` vector rows first.
    expect(strings(hashToQuinticExtension([]))).toEqual(["0", "0", "0", "0", "0"]);
    expect(hex(fp5ToBytes(hashToQuinticExtension([])))).toBe("0".repeat(80));
    expect(strings(hashToQuinticExtension([0n as Fp]))).not.toEqual(["0", "0", "0", "0", "0"]);
  });

  test("the ninth element breaks the illusion — trailing zeros stop being free at the rate", () => {
    // Nine elements is a second block, and the second block permutes. This is the boundary that
    // makes the collisions above bounded rather than unbounded.
    const eight = strings(hashToQuinticExtension([1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as Fp[]));
    const nine = strings(hashToQuinticExtension([1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as Fp[]));
    expect(nine).not.toEqual(eight);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. State ownership and platform hygiene
// ---------------------------------------------------------------------------------------------

describe("state ownership", () => {
  test("results do not depend on call history — no shared scratch between calls", () => {
    const inputs = V.hashToQuinticExtension.map((r) => toFp(r.input));
    const batch = inputs.map((x) => strings(hashToQuinticExtension(x)));
    // Re-run in reverse, interleaved with unrelated long hashes, and in a fresh order. A
    // module-level scratch state would make at least one of these differ.
    for (let i = inputs.length - 1; i >= 0; i -= 1) {
      hashNToM(inputs[(i + 7) % inputs.length] ?? [], 17);
      expect(strings(hashToQuinticExtension(inputs[i] ?? []))).toEqual(batch[i] ?? []);
    }
  });

  test("the caller's input array is never mutated", () => {
    const input = [P + 1n, 2n, 3n] as Fp[];
    const before = strings(input);
    hashToQuinticExtension(input);
    expect(strings(input)).toEqual(before);
  });

  test("the returned Fp5 and HashOut are independent objects", () => {
    const a = hashToQuinticExtension([1n as Fp]);
    const b = hashToQuinticExtension([1n as Fp]);
    expect(a).not.toBe(b);
    expect(strings(a)).toEqual(strings(b));
  });
});

describe("source hygiene", () => {
  const SOURCE_PATH = new URL("../../../src/crypto/poseidon2/index.ts", import.meta.url);

  test("no Node built-ins, no npm imports, no WASM, no module-level mutable scratch", async () => {
    const src = await readFile(SOURCE_PATH, "utf8");
    expect(src).not.toMatch(/from ["']node:/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bBuffer\b/);
    expect(src).not.toMatch(/\bprocess\./);
    expect(src).not.toMatch(/WebAssembly/);
    // No top-level `let`/`var`: the only mutable state is the per-call `State` inside hashNToM.
    expect(src).not.toMatch(/^(let|var)\s/m);
  });

  test("imports are limited to the four modules this unit depends on", async () => {
    const src = await readFile(SOURCE_PATH, "utf8");
    const allowed = new Set([
      "./permutation.js",
      "./constants.generated.js",
      "../field/fp.js",
      "../field/fp5.js",
      "../../errors.js",
    ]);
    const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(allowed.has(s)).toBe(true);
  });

  test("the 40-byte GF(p^5) codec is not re-implemented here", async () => {
    const src = await readFile(SOURCE_PATH, "utf8");
    // 40 is the Fp5 width; the only byte length this module owns is 32.
    expect(src).not.toMatch(/new Uint8Array\(40\)/);
    expect(src).not.toMatch(/setBigUint64/);
  });
});
