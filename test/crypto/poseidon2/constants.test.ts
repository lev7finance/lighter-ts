/**
 * The generated constants module is data, and data is exactly what a hand-edit
 * can corrupt invisibly: a wrong digit anywhere here makes every Poseidon2 hash
 * wrong for every input, with nothing in the failure pointing at the cause.
 *
 * So this test re-derives all 130 constants from `conformance/vectors/poseidon2.json`
 * and compares them element by element against the module, rather than trusting
 * that the generator ran.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  CAPACITY,
  CONSTANTS_DIGEST,
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
} from '../../../src/crypto/poseidon2/constants.generated.js';

const P = 18446744069414584321n;

interface Poseidon2Constants {
  readonly width: number;
  readonly rate: number;
  readonly out: number;
  readonly sboxDegree: number;
  readonly roundsF: number;
  readonly roundsFHalf: number;
  readonly roundsP: number;
  readonly externalConstants: readonly (readonly string[])[];
  readonly internalConstants: readonly string[];
  readonly matrixDiag12: readonly string[];
}

const vectorsUrl = new URL('../../../conformance/vectors/poseidon2.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8')) as {
  constants: Poseidon2Constants;
};
const c = vectors.constants;

describe('poseidon2 constants — scalars match the vectors', () => {
  test('width, rate, output and s-box degree', () => {
    expect<number>(WIDTH).toBe(c.width);
    expect<number>(RATE).toBe(c.rate);
    expect<number>(OUT).toBe(c.out);
    expect<number>(SBOX_DEGREE).toBe(c.sboxDegree);
  });

  test('round counts', () => {
    expect<number>(ROUNDS_F).toBe(c.roundsF);
    expect<number>(ROUNDS_F_HALF).toBe(c.roundsFHalf);
    expect<number>(ROUNDS_P).toBe(c.roundsP);
    // The full rounds are split evenly around the partial rounds.
    expect<number>(ROUNDS_F_HALF * 2).toBe(ROUNDS_F);
  });

  test('capacity is the lanes the rate does not cover', () => {
    expect<number>(CAPACITY).toBe(WIDTH - RATE);
  });
});

describe('poseidon2 constants — tables match the vectors element by element', () => {
  test('lengths', () => {
    expect(EXTERNAL_ROUND_CONSTANTS.length).toBe(96);
    expect(INTERNAL_ROUND_CONSTANTS.length).toBe(22);
    expect(INTERNAL_DIAGONAL.length).toBe(12);
    expect(c.externalConstants.length).toBe(8);
    for (const row of c.externalConstants) expect(row.length).toBe(12);
  });

  test('external table is flattened row-major: index r * 12 + i', () => {
    for (let r = 0; r < ROUNDS_F; r += 1) {
      const row = c.externalConstants[r];
      expect(row).toBeDefined();
      for (let i = 0; i < WIDTH; i += 1) {
        const expected = BigInt(row?.[i] as string);
        expect(EXTERNAL_ROUND_CONSTANTS[r * WIDTH + i]).toBe(expected);
      }
    }
  });

  test('internal round constants', () => {
    for (let i = 0; i < ROUNDS_P; i += 1) {
      expect(INTERNAL_ROUND_CONSTANTS[i]).toBe(BigInt(c.internalConstants[i] as string));
    }
  });

  test('internal diagonal is used raw — no minus one, no lane-0 special case', () => {
    for (let i = 0; i < WIDTH; i += 1) {
      expect(INTERNAL_DIAGONAL[i]).toBe(BigInt(c.matrixDiag12[i] as string));
    }
  });
});

describe('poseidon2 constants — spot pins catch a transposition', () => {
  // A column-major flattening still produces 96 plausible entries, but moves
  // everything except index 0. [11] is the end of row 0 and [95] the end of row 7.
  test('external endpoints', () => {
    expect(EXTERNAL_ROUND_CONSTANTS[0]).toBe(15492826721047263190n);
    expect(EXTERNAL_ROUND_CONSTANTS[11]).toBe(12084856431752384512n);
    expect(EXTERNAL_ROUND_CONSTANTS[95]).toBe(176665553780565743n);
  });

  test('internal and diagonal endpoints', () => {
    expect(INTERNAL_ROUND_CONSTANTS[0]).toBe(11921381764981422944n);
    expect(INTERNAL_ROUND_CONSTANTS[21]).toBe(838728605080212101n);
    expect(INTERNAL_DIAGONAL[0]).toBe(14102670999874605824n);
    expect(INTERNAL_DIAGONAL[11]).toBe(15167485180850043744n);
  });
});

describe('poseidon2 constants — shape and range invariants', () => {
  test('every constant is a bigint in [0, p)', () => {
    const all = [...EXTERNAL_ROUND_CONSTANTS, ...INTERNAL_ROUND_CONSTANTS, ...INTERNAL_DIAGONAL];
    expect(all.length).toBe(130);
    for (const v of all) {
      expect(typeof v).toBe('bigint');
      expect(v >= 0n).toBe(true);
      expect(v < P).toBe(true);
    }
  });

  test('all three tables are frozen at module scope', () => {
    expect(Object.isFrozen(EXTERNAL_ROUND_CONSTANTS)).toBe(true);
    expect(Object.isFrozen(INTERNAL_ROUND_CONSTANTS)).toBe(true);
    expect(Object.isFrozen(INTERNAL_DIAGONAL)).toBe(true);
  });
});

describe('poseidon2 constants — the digest pins the whole table', () => {
  test('CONSTANTS_DIGEST is the SHA-256 of the canonical serialisation', async () => {
    const canonical = JSON.stringify({
      diag: c.matrixDiag12,
      external: c.externalConstants,
      internal: c.internalConstants,
    });
    const bytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
    );
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

    expect(hex).toBe('229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db');
    expect(CONSTANTS_DIGEST).toBe(hex);
  });
});

describe('poseidon2 constants — the generated module stays pure data', () => {
  test('zero imports and zero BigInt() calls in the emitted source', async () => {
    const src = await readFile(
      new URL('../../../src/crypto/poseidon2/constants.generated.ts', import.meta.url),
      'utf8',
    );
    // Zero imports: a consumer wanting only WIDTH must not pull in the field
    // layer or the permutation.
    expect(/^\s*import\s/m.test(src)).toBe(false);
    // Literals are parsed once by the engine; BigInt("…") x130 would run on
    // every cold start, including every Worker isolate spin-up.
    expect(src.includes('BigInt(')).toBe(false);
  });
});
