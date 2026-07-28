/**
 * Conformance and differential tests for the Poseidon2 permutation.
 *
 * Three independent sources of truth, because the failure mode of a wrong permutation is output
 * that still looks exactly like a hash:
 *
 * 1. All 23 rows of `conformance/vectors/poseidon2.json` → `permutations`, replayed verbatim.
 * 2. The all-zero state, asserted separately, because it is the row that pins the pre-round
 *    external layer — with that layer omitted, `[0]*12` permutes to a different fixed value and
 *    nothing else about the implementation looks wrong.
 * 3. A deliberately naive second model written below: explicit 12x12 matrix multiplication built
 *    from the layer definitions, with `% P` after every single operation. Cross-checked over 10,000
 *    seeded pseudo-random states. This is what catches a deferred-reduction bound mistake, which no
 *    fixed vector will ever hit.
 */

import { describe, expect, test } from "bun:test";

import { P } from "../../../src/crypto/field/constants.js";
import type { Fp } from "../../../src/crypto/field/fp.js";
import {
  EXTERNAL_ROUND_CONSTANTS,
  INTERNAL_DIAGONAL,
  INTERNAL_ROUND_CONSTANTS,
  OUT,
  RATE,
  ROUNDS_F,
  ROUNDS_F_HALF,
  ROUNDS_P,
  SBOX_DEGREE,
  WIDTH,
} from "../../../src/crypto/poseidon2/constants.generated.js";
import { permute, type State } from "../../../src/crypto/poseidon2/permutation.js";

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

interface PermutationVector {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

interface Poseidon2Vectors {
  readonly width: number;
  readonly constants: {
    readonly width: number;
    readonly rate: number;
    readonly out: number;
    readonly sboxDegree: number;
    readonly roundsF: number;
    readonly roundsFHalf: number;
    readonly roundsP: number;
    /** 8 rows of 12 in the vector file; flattened row-major in the generated module. */
    readonly externalConstants: readonly (readonly string[])[];
    readonly internalConstants: readonly string[];
    readonly matrixDiag12: readonly string[];
  };
  readonly permutations: readonly PermutationVector[];
}

const vectors = (await import("../../../conformance/vectors/poseidon2.json", {
  with: { type: "json" },
})) as unknown as { default: Poseidon2Vectors };

const V: Poseidon2Vectors = vectors.default;

function toState(xs: readonly string[]): State {
  if (xs.length !== 12) throw new Error(`expected 12 lanes, got ${String(xs.length)}`);
  const out = xs.map((x) => BigInt(x) as Fp);
  return out as unknown as State;
}

function toBigints(xs: readonly string[]): bigint[] {
  return xs.map((x) => BigInt(x));
}

/** The twelve lanes as plain `bigint`s, so comparisons are not against the branded `Fp`. */
function lanes(s: State): bigint[] {
  return [...s] as bigint[];
}

// ---------------------------------------------------------------------------------------------
// The naive reference model — deliberately slow, deliberately literal.
//
// Nothing here is shared with `permutation.ts`: the matrices are materialized as explicit 12x12
// tables and every arithmetic step is reduced immediately. If the fast implementation's deferred
// reduction is wrong by any amount, the two disagree.
// ---------------------------------------------------------------------------------------------

const m = (x: bigint): bigint => ((x % P) + P) % P;

/** `M4 = circ(2, 3, 1, 1)`: row `i` of the 4x4 block, written out rather than rotated in code. */
const M4: readonly (readonly bigint[])[] = [
  [2n, 3n, 1n, 1n],
  [1n, 2n, 3n, 1n],
  [1n, 1n, 2n, 3n],
  [3n, 1n, 1n, 2n],
];

/**
 * Build the full 12x12 external matrix `M_E` from its definition:
 * apply `M4` blockwise, then `S[i] = y[i] + sigma[i mod 4]` where `sigma[k] = sum_j y[k + 4j]`.
 *
 * Column `c` of `M_E` is `M_E` applied to the `c`-th basis vector, so this derives the matrix by
 * pushing 12 unit vectors through the definition — no transcription.
 */
function buildExternalMatrix(): bigint[][] {
  const cols: bigint[][] = [];
  for (let c = 0; c < 12; c++) {
    const e: bigint[] = new Array<bigint>(12).fill(0n);
    e[c] = 1n;

    // Blockwise M4.
    const y: bigint[] = new Array<bigint>(12).fill(0n);
    for (let b = 0; b < 3; b++) {
      for (let i = 0; i < 4; i++) {
        let acc = 0n;
        for (let j = 0; j < 4; j++) {
          acc = m(acc + m(M4[i]![j]! * e[b * 4 + j]!));
        }
        y[b * 4 + i] = acc;
      }
    }

    // Column sums.
    const sigma: bigint[] = new Array<bigint>(4).fill(0n);
    for (let k = 0; k < 4; k++) {
      sigma[k] = m(m(y[k]! + y[k + 4]!) + y[k + 8]!);
    }

    const col: bigint[] = new Array<bigint>(12).fill(0n);
    for (let i = 0; i < 12; i++) {
      col[i] = m(y[i]! + sigma[i % 4]!);
    }
    cols.push(col);
  }

  // cols[c][i] is M[i][c].
  const mat: bigint[][] = [];
  for (let i = 0; i < 12; i++) {
    const row: bigint[] = new Array<bigint>(12).fill(0n);
    for (let c = 0; c < 12; c++) row[c] = cols[c]![i]!;
    mat.push(row);
  }
  return mat;
}

/**
 * The full 12x12 internal matrix `M_I`: `S[i] = sum(S) + S[i] * D[i]`, i.e. all-ones plus
 * `diag(D)`.
 */
function buildInternalMatrix(): bigint[][] {
  const mat: bigint[][] = [];
  for (let i = 0; i < 12; i++) {
    const row: bigint[] = new Array<bigint>(12).fill(1n);
    row[i] = m(1n + BigInt(INTERNAL_DIAGONAL[i]!));
    mat.push(row);
  }
  return mat;
}

const ME: bigint[][] = buildExternalMatrix();
const MI: bigint[][] = buildInternalMatrix();

function matVec(mat: readonly (readonly bigint[])[], v: readonly bigint[]): bigint[] {
  const out: bigint[] = new Array<bigint>(12).fill(0n);
  for (let i = 0; i < 12; i++) {
    let acc = 0n;
    for (let j = 0; j < 12; j++) {
      acc = m(acc + m(mat[i]![j]! * v[j]!));
    }
    out[i] = acc;
  }
  return out;
}

/** `x^7` by seven reduced multiplications — no addition-chain cleverness at all. */
function pow7Naive(x: bigint): bigint {
  let acc = 1n;
  for (let i = 0; i < 7; i++) acc = m(acc * m(x));
  return acc;
}

/** The permutation, restated from the layer definitions with a `%` after every operation. */
function permuteNaive(input: readonly bigint[]): bigint[] {
  let s: bigint[] = input.map(m);

  s = matVec(ME, s);

  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 12; i++) {
      s[i] = pow7Naive(m(s[i]! + BigInt(EXTERNAL_ROUND_CONSTANTS[r * 12 + i]!)));
    }
    s = matVec(ME, s);
  }

  for (let r = 0; r < 22; r++) {
    s[0] = pow7Naive(m(s[0]! + BigInt(INTERNAL_ROUND_CONSTANTS[r]!)));
    s = matVec(MI, s);
  }

  for (let r = 4; r < 8; r++) {
    for (let i = 0; i < 12; i++) {
      s[i] = pow7Naive(m(s[i]! + BigInt(EXTERNAL_ROUND_CONSTANTS[r * 12 + i]!)));
    }
    s = matVec(ME, s);
  }

  return s;
}

// ---------------------------------------------------------------------------------------------

describe("poseidon2 parameters", () => {
  test("the generated module matches poseidon2.json -> constants", () => {
    expect(WIDTH).toBe(12);
    expect(RATE).toBe(8);
    expect(OUT).toBe(4);
    expect(SBOX_DEGREE).toBe(7);
    expect(ROUNDS_F).toBe(8);
    expect(ROUNDS_F_HALF).toBe(4);
    expect(ROUNDS_P).toBe(22);

    const c = V.constants;
    expect(c.width).toBe(WIDTH);
    expect(c.rate).toBe(RATE);
    expect(c.out).toBe(OUT);
    expect(c.sboxDegree).toBe(SBOX_DEGREE);
    expect(c.roundsF).toBe(ROUNDS_F);
    expect(c.roundsFHalf).toBe(ROUNDS_F_HALF);
    expect(c.roundsP).toBe(ROUNDS_P);

    expect(EXTERNAL_ROUND_CONSTANTS.length).toBe(8 * 12);
    expect(INTERNAL_ROUND_CONSTANTS.length).toBe(22);
    expect(INTERNAL_DIAGONAL.length).toBe(12);

    expect(c.externalConstants.length).toBe(8);
    for (const row of c.externalConstants) expect(row.length).toBe(12);
    expect([...EXTERNAL_ROUND_CONSTANTS]).toEqual(toBigints(c.externalConstants.flat()));
    expect([...INTERNAL_ROUND_CONSTANTS]).toEqual(toBigints(c.internalConstants));
    expect([...INTERNAL_DIAGONAL]).toEqual(toBigints(c.matrixDiag12));
  });
});

describe("permute", () => {
  test("the all-zero state pins the pre-round external layer", () => {
    // With the pre-round M_E omitted, the four leading full rounds start from the bare round
    // constants and this row lands somewhere else entirely — while every other structural detail
    // of the implementation still looks correct. This is the cheapest possible detector for the
    // single most common Poseidon2 bug (docs/protocol-notes.md 2.2).
    const s: State = toState([
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    permute(s);
    expect(lanes(s)).toEqual([
      7182099517097165596n,
      9311216678150108034n,
      8831900494918587432n,
      10774846510254277933n,
      10601329242472021962n,
      5629867288322699978n,
      140799316430260029n,
      16680789625189310103n,
      16589856342819292996n,
      4940126994627441183n,
      14089387953811494999n,
      8340711910841427341n,
    ]);
  });

  test("the reference's own permutation vector (state = 0..11)", () => {
    const row = V.permutations.find((p) => p.input.join(",") === "0,1,2,3,4,5,6,7,8,9,10,11");
    expect(row).toBeDefined();
    const s: State = toState(row!.input);
    permute(s);
    expect(lanes(s)).toEqual(toBigints(row!.output));
  });

  test("all 23 vector rows reproduce exactly", () => {
    expect(V.permutations.length).toBe(23);
    for (const [i, row] of V.permutations.entries()) {
      const s: State = toState(row.input);
      permute(s);
      expect({ i, out: lanes(s) }).toEqual({ i, out: toBigints(row.output) });
    }
  });

  test("mutates in place, returns undefined, leaves every lane canonical", () => {
    const s: State = toState(V.permutations[3]!.input);
    const same = s;
    const result: void = permute(s);
    expect(result).toBeUndefined();
    expect(s).toBe(same);
    for (const lane of s) {
      expect(typeof lane).toBe("bigint");
      expect(lane >= 0n).toBe(true);
      expect(lane < P).toBe(true);
    }
  });

  test("a permuted state can be permuted again (no hidden state, idempotent setup)", () => {
    const a: State = toState(V.permutations[0]!.input);
    permute(a);
    permute(a);

    const b: State = toState(V.permutations[0]!.input);
    permute(b);
    permute(b);

    expect(lanes(a)).toEqual(lanes(b));
    expect(lanes(a)).toEqual(permuteNaive(permuteNaive(toBigints(V.permutations[0]!.input))));
  });
});

describe("permute vs. a naive 12x12 matrix model", () => {
  test("the derived matrices have the shape the spec describes", () => {
    // M_E row 0 = M4 row 0 plus the column-sum contribution: y0 gets sigma[0] = y0 + y4 + y8, so
    // the first four columns carry the doubled M4 row and columns 4..11 carry M4 rows from the
    // other blocks. Spot-check the two structural facts rather than the 144 entries.
    expect(ME.length).toBe(12);
    expect(MI.length).toBe(12);
    // M_I off-diagonal entries are all 1.
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        if (i !== j) expect(MI[i]![j]).toBe(1n);
      }
      expect(MI[i]![i]).toBe(m(1n + BigInt(INTERNAL_DIAGONAL[i]!)));
    }
  });

  test("agrees with the vectors", () => {
    for (const row of V.permutations) {
      expect(permuteNaive(toBigints(row.input))).toEqual(toBigints(row.output));
    }
  });

  test(
    "agrees on 10,000 seeded pseudo-random states",
    () => {
      // splitmix64, seeded, so a failure is reproducible. The naive model is ~1000x slower than
      // the real one, which is the whole point of it — hence the generous timeout.
      const MASK64 = (1n << 64n) - 1n;
      let seed = 0x9e3779b97f4a7c15n;
      const next = (): bigint => {
        seed = (seed + 0x9e3779b97f4a7c15n) & MASK64;
        let z = seed;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
        return (z ^ (z >> 31n)) % P;
      };

      let mismatch: { iter: number; input: bigint[]; got: bigint[]; want: bigint[] } | null = null;
      let nonCanonical = 0;

      for (let iter = 0; iter < 10_000 && mismatch === null; iter++) {
        const input: bigint[] = [];
        for (let i = 0; i < 12; i++) input.push(next());

        const s = input.map((x) => x as Fp) as unknown as State;
        permute(s);

        const want = permuteNaive(input);
        for (let i = 0; i < 12; i++) {
          const lane = s[i] as bigint;
          if (lane < 0n || lane >= P) nonCanonical++;
          // Compared without `expect` so the loop stays fast; the first disagreement is captured
          // and reported below with its exact input.
          if (lane !== want[i]) {
            mismatch = { iter, input, got: lanes(s), want };
            break;
          }
        }
      }

      expect(mismatch).toBeNull();
      expect(nonCanonical).toBe(0);
    },
    600_000,
  );

  test("agrees on edge states: all zero, all p-1, one hot lane", () => {
    const cases: bigint[][] = [
      new Array<bigint>(12).fill(0n),
      new Array<bigint>(12).fill(P - 1n),
      new Array<bigint>(12).fill(1n),
    ];
    for (let i = 0; i < 12; i++) {
      const hot = new Array<bigint>(12).fill(0n);
      hot[i] = P - 1n;
      cases.push(hot);
    }

    for (const input of cases) {
      const s = input.map((x) => x as Fp) as unknown as State;
      permute(s);
      expect(lanes(s)).toEqual(permuteNaive(input));
    }
  });
});

describe("source hygiene", () => {
  test("no round constant is transcribed, and no platform coupling", async () => {
    const src = await Bun.file(
      new URL("../../../src/crypto/poseidon2/permutation.ts", import.meta.url),
    ).text();
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .join("\n");

    expect(code).not.toMatch(/[0-9]{15,}/);
    expect(code).not.toMatch(/from ['"]node:/);
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/\bprocess\./);
    expect(code).not.toMatch(/WebAssembly/);
    expect(code).not.toMatch(/BigUint64Array|BigInt64Array/);

    for (const d of INTERNAL_DIAGONAL) expect(code).not.toContain(d.toString());
    for (const c of INTERNAL_ROUND_CONSTANTS) expect(code).not.toContain(c.toString());
    for (const c of EXTERNAL_ROUND_CONSTANTS) expect(code).not.toContain(c.toString());

    // Only the three permitted specifiers.
    const specifiers = [...code.matchAll(/from ["']([^"']+)["']/g)].map((mm) => mm[1]);
    expect(new Set(specifiers)).toEqual(
      new Set(["../field/constants.js", "../field/fp.js", "./constants.generated.js"]),
    );
  });
});
