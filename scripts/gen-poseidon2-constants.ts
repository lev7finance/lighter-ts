/**
 * Generate `src/crypto/poseidon2/constants.generated.ts` from the conformance
 * vectors.
 *
 * Poseidon2 over Goldilocks is parameterised by 130 field constants: an 8x12
 * external round-constant table, 22 internal round constants, and a 12-element
 * internal diagonal. A single wrong digit produces a hash that is wrong for
 * every input, passes no vector, and points at nothing in particular — so the
 * constants are generated from `conformance/vectors/poseidon2.json` and never
 * typed by hand.
 *
 * This is build tooling. It is not shipped, nothing under `src/` imports it,
 * and it may therefore use Node built-ins and top-level `await`.
 *
 *   bun run scripts/gen-poseidon2-constants.ts
 *
 * The output is byte-stable: running it twice leaves the generated file
 * unchanged, which is what CI gates on.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';

/** Goldilocks modulus, p = 2^64 - 2^32 + 1. Every constant must be in [0, p). */
const P = 18446744069414584321n;

/**
 * SHA-256 of the canonical serialisation of the three constant tables. If this
 * does not match, the vectors changed — that is a protocol change to be
 * reviewed, not a number to update here.
 */
const EXPECTED_DIGEST = '229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db';

const VECTORS_URL = new URL('../conformance/vectors/poseidon2.json', import.meta.url);
const OUT_DIR_URL = new URL('../src/crypto/poseidon2/', import.meta.url);
const OUT_URL = new URL('constants.generated.ts', OUT_DIR_URL);

const WIDTH = 12;
const RATE = 8;
const OUT = 4;
const SBOX_DEGREE = 7;
const ROUNDS_F = 8;
const ROUNDS_F_HALF = 4;
const ROUNDS_P = 22;

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

/**
 * Abort. An uncaught throw exits non-zero on every runtime that can run this
 * script, and it needs no `process` global to do it.
 */
function fail(message: string): never {
  throw new Error(`gen-poseidon2-constants: ${message}`);
}

/**
 * Parse a decimal constant. The values exceed 2^53 — `Number` would silently
 * round them — so the string is validated and handed straight to `BigInt`.
 */
function parseFieldElement(raw: unknown, where: string): bigint {
  if (typeof raw !== 'string') fail(`${where}: expected a decimal string, got ${typeof raw}`);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail(`${where}: not a canonical decimal string: ${raw}`);
  const v = BigInt(raw);
  if (v >= P) fail(`${where}: ${raw} is >= p (${P})`);
  return v;
}

function expectScalar(actual: unknown, expected: number, name: string): void {
  if (actual !== expected) fail(`constants.${name}: expected ${expected}, got ${String(actual)}`);
}

// ------------------------------------------------------------------- read

const source = JSON.parse(await readFile(VECTORS_URL, 'utf8')) as { constants?: Poseidon2Constants };
const c = source.constants;
if (c === undefined || typeof c !== 'object') fail('conformance/vectors/poseidon2.json has no `constants` object');

// --------------------------------------------------------------- validate

expectScalar(c.width, WIDTH, 'width');
expectScalar(c.rate, RATE, 'rate');
expectScalar(c.out, OUT, 'out');
expectScalar(c.sboxDegree, SBOX_DEGREE, 'sboxDegree');
expectScalar(c.roundsF, ROUNDS_F, 'roundsF');
expectScalar(c.roundsFHalf, ROUNDS_F_HALF, 'roundsFHalf');
expectScalar(c.roundsP, ROUNDS_P, 'roundsP');

const externalRaw = c.externalConstants;
if (!Array.isArray(externalRaw) || externalRaw.length !== ROUNDS_F) {
  fail(`constants.externalConstants: expected ${ROUNDS_F} rows, got ${Array.isArray(externalRaw) ? externalRaw.length : typeof externalRaw}`);
}
for (const [r, row] of externalRaw.entries()) {
  if (!Array.isArray(row) || row.length !== WIDTH) {
    fail(`constants.externalConstants[${r}]: expected ${WIDTH} lanes, got ${Array.isArray(row) ? row.length : typeof row}`);
  }
}

const internalRaw = c.internalConstants;
if (!Array.isArray(internalRaw) || internalRaw.length !== ROUNDS_P) {
  fail(`constants.internalConstants: expected ${ROUNDS_P} entries, got ${Array.isArray(internalRaw) ? internalRaw.length : typeof internalRaw}`);
}

const diagRaw = c.matrixDiag12;
if (!Array.isArray(diagRaw) || diagRaw.length !== WIDTH) {
  fail(`constants.matrixDiag12: expected ${WIDTH} entries, got ${Array.isArray(diagRaw) ? diagRaw.length : typeof diagRaw}`);
}

// Row-major flattening: index r * WIDTH + i, where r is the round and i the lane.
// A transposed flattening yields a valid-looking 96-entry array and a completely
// wrong hash, so the order is fixed here and pinned in the test.
const external: bigint[] = [];
for (const [r, row] of externalRaw.entries()) {
  for (const [i, value] of row.entries()) {
    external.push(parseFieldElement(value, `constants.externalConstants[${r}][${i}]`));
  }
}
const internal = internalRaw.map((v, i) => parseFieldElement(v, `constants.internalConstants[${i}]`));
const diag = diagRaw.map((v, i) => parseFieldElement(v, `constants.matrixDiag12[${i}]`));

if (external.length !== ROUNDS_F * WIDTH) fail(`flattened external table has ${external.length} entries, expected ${ROUNDS_F * WIDTH}`);

// ----------------------------------------------------------------- digest

/**
 * Canonical serialisation: decimal strings, separators `,` and `:`, keys
 * sorted — exactly what `JSON.stringify` emits for these three keys in this
 * order. `crypto.subtle.digest` is async; that is fine here and only here,
 * since nothing on the signing path may become async because of it.
 */
const canonical = JSON.stringify({
  diag: diagRaw,
  external: externalRaw,
  internal: internalRaw,
});
const digestBytes = new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
);
const digest = Array.from(digestBytes, (b) => b.toString(16).padStart(2, '0')).join('');

if (digest !== EXPECTED_DIGEST) {
  fail(
    `constants digest mismatch\n  expected ${EXPECTED_DIGEST}\n  actual   ${digest}\n` +
      '  The vectors changed. That is a protocol change to review, not a number to update here.',
  );
}

// ------------------------------------------------------------------- emit

function literals(values: readonly bigint[], indent: string): string {
  return values.map((v) => `${indent}${v.toString()}n,`).join('\n');
}

const externalBody = externalRaw
  .map((_row, r) => {
    const start = r * WIDTH;
    return `  // round ${r}\n${literals(external.slice(start, start + WIDTH), '  ')}`;
  })
  .join('\n');

const out = `// GENERATED — do not edit. Source: conformance/vectors/poseidon2.json (constants)
//   ultimately poseidon_crypto v0.0.15 hash/poseidon2_goldilocks_plonky2
// Regenerate: bun run scripts/gen-poseidon2-constants.ts
// Digest: ${EXPECTED_DIGEST}

export const WIDTH: ${WIDTH} = ${WIDTH};
export const RATE: ${RATE} = ${RATE};
export const CAPACITY: ${WIDTH - RATE} = ${WIDTH - RATE};
export const OUT: ${OUT} = ${OUT};
export const SBOX_DEGREE: ${SBOX_DEGREE} = ${SBOX_DEGREE};
export const ROUNDS_F: ${ROUNDS_F} = ${ROUNDS_F};
export const ROUNDS_F_HALF: ${ROUNDS_F_HALF} = ${ROUNDS_F_HALF};
export const ROUNDS_P: ${ROUNDS_P} = ${ROUNDS_P};

/** ${ROUNDS_F} rows × ${WIDTH} lanes, flattened row-major: index r * ${WIDTH} + i. */
export const EXTERNAL_ROUND_CONSTANTS: readonly bigint[] = Object.freeze([
${externalBody}
]);

/** One constant per partial round, added to lane 0 only. */
export const INTERNAL_ROUND_CONSTANTS: readonly bigint[] = Object.freeze([
${literals(internal, '  ')}
]);

/** Internal linear layer: state[i] = sum + state[i] * INTERNAL_DIAGONAL[i]. Raw, unadjusted. */
export const INTERNAL_DIAGONAL: readonly bigint[] = Object.freeze([
${literals(diag, '  ')}
]);

export const CONSTANTS_DIGEST: string =
  ${JSON.stringify(EXPECTED_DIGEST)};
`;

await mkdir(OUT_DIR_URL, { recursive: true });
await writeFile(OUT_URL, out, 'utf8');

console.log(
  `gen-poseidon2-constants: wrote src/crypto/poseidon2/constants.generated.ts ` +
    `(${external.length} external, ${internal.length} internal, ${diag.length} diagonal, digest ok)`,
);
