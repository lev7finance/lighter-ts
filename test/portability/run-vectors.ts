/**
 * The portability harness: one framework-free ES module that replays every conformance vector
 * against the **built `dist/`**, and runs unchanged on Bun, Node 20/22/24, Deno and workerd.
 *
 * ## Why this file exists at all, when `bun test` already replays the same vectors
 *
 * `bun test` proves the library is correct *on Bun*. It cannot prove the claim on the tin — that
 * the published artifact runs unmodified on five runtimes with zero Node built-ins — because the
 * test suite itself imports Bun's built-in runner and Node's filesystem module, so it can only
 * ever run where both exist.
 * This file imports neither. It is the only executable in the project that can be handed to
 * workerd with `nodejs_compat` **off**, which is the one environment where an accidental
 * `node:buffer` somewhere under `src/` fails loudly instead of silently working.
 *
 * Three rules follow from that, and they are the whole design:
 *
 * 1. **No test framework** — not Bun's built-in runner, not Node's, not Vitest, not the JSR
 *    standard-library assertions. (The acceptance grep for those four names must come up empty in
 *    this directory, which is also why none of them is spelled out here.) The assertions below are
 *    eleven lines of `if (a !== b) throw`.
 * 2. **No static Node import.** A top-level `import fs from "node:fs"` would kill the harness under
 *    Deno and workerd — which is precisely the failure this file exists to detect. The Node branch
 *    of {@link loadVectors} is a *dynamic* import behind a runtime check, and its specifier is
 *    assembled at run time so a bundler cannot hoist it into a static dependency.
 * 3. **Imports come from `dist/`, never `src/`.** The point is the published artifact: the
 *    `.js`-extension discipline and the emitted module graph are part of what is under test, and
 *    importing `src/` would skip both.
 *
 * ## Counting, and why it is asserted
 *
 * A harness that silently skips a section is worse than no harness, because it reports green. So
 * every section declares its length **read from the JSON at run time**, the executed count is
 * compared against it per section and in total, and a section whose executed count drifts from its
 * declared length is itself a failure. Corrupting one byte of one expected value in
 * `conformance/vectors/` must make this exit non-zero and name the file, the section and the index.
 *
 * ## Numbers
 *
 * Every `uint64`, scalar and field element in the vectors is a decimal string or an LE hex string,
 * never a JSON number — `JSON.parse` corrupts above 2^53. Nothing in the comparison path calls
 * `Number(...)` on a value that can exceed that: comparisons are `bigint` or hex string. The one
 * place `Number` appears is on fields the protocol itself declares 32 bits or narrower, and it is
 * routed through {@link num} so the rule is visible in one place.
 *
 * ## One thing deliberately not asserted
 *
 * - `tx.json` → `txHashes[*].txInfoJson` is `""` in every current row: the Go oracle does not emit
 *   the JSON. Comparing `"" === ""` would look like coverage and be none, so it is skipped
 *   explicitly. `toTxInfo` is gated by hand-authored goldens in `test/tx/pipeline.test.ts`.
 *
 * `tx.json` → `l1Messages[*].eip191HashHex` is a Keccak-256 digest. The published package correctly
 * ships no Keccak implementation (`docs/decisions.md` D6, D10), but the portability verifier has a
 * small independent implementation below. A digest vector is an acceptance oracle, so merely
 * checking that it looks like 32 bytes would let any same-shaped corruption pass.
 *
 * ## Usage
 *
 * ```sh
 * bun  test/portability/run-vectors.ts
 * node --experimental-strip-types test/portability/run-vectors.ts
 * deno run --allow-read test/portability/run-vectors.ts
 * node .tmp/port/run-vectors.js "$PWD/conformance/vectors"   # Node 20, transpiled first
 * ```
 *
 * The vector directory defaults to `../../conformance/vectors/` relative to this module, and is
 * overridable by the first CLI argument or by `LIGHTER_VECTORS` — the Node-20 job transpiles this
 * file to a temporary directory, where a hard-coded `import.meta.url` path would not resolve.
 *
 * workerd has no filesystem, so it never calls {@link loadVectors}: `test/portability/worker.ts`
 * inlines the six JSON files at build time and calls {@link runVectors} with the bundle. That split
 * is the entire reason the two functions are separate.
 */

import {
  EPSILON,
  P,
  POWER_OF_TWO_GENERATOR,
  TWO_ADICITY,
} from "../../dist/crypto/field/constants.js";
import type { Fp } from "../../dist/crypto/field/fp.js";
import {
  fpAdd,
  fpDouble,
  fpExp,
  fpExpPow2,
  fpFromBytes,
  fpFromInt,
  fpIsQuadraticResidue,
  fpMul,
  fpNeg,
  fpSqrt,
  fpSquare,
  fpSub,
  fpToBytes,
} from "../../dist/crypto/field/fp.js";
import type { Fp5 } from "../../dist/crypto/field/fp5.js";
import {
  fp5Add,
  fp5CanonicalSqrt,
  fp5Div,
  fp5Double,
  fp5Frobenius,
  fp5FromLimbs,
  fp5InverseOrZero,
  fp5IsZero,
  fp5Legendre,
  fp5Mul,
  fp5Neg,
  fp5RepeatedFrobenius,
  fp5ScalarMul,
  fp5Sgn0,
  fp5Sqrt,
  fp5Square,
  fp5Sub,
  fp5ToBytes,
  fp5Triple,
} from "../../dist/crypto/field/fp5.js";
import { ApiKey } from "../../dist/crypto/key.js";
import {
  GENERATOR,
  NEUTRAL,
  decodePoint,
  encodePoint,
  pointAdd,
  pointDouble,
  pointIsOnCurve,
} from "../../dist/crypto/point.js";
import {
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
} from "../../dist/crypto/poseidon2/constants.generated.js";
import type { State } from "../../dist/crypto/poseidon2/permutation.js";
import {
  hashNToM,
  hashNoPad,
  hashToQuinticExtension,
  permute,
} from "../../dist/crypto/poseidon2/index.js";
import {
  scalarFromBytes,
  scalarIsCanonicalBytes,
  scalarToBytes,
} from "../../dist/crypto/scalar.js";
import { mulGenerator } from "../../dist/crypto/scalarmul.js";
import {
  publicKeyFromPrivateKey,
  signHashed,
  signatureToBytes,
  verify,
} from "../../dist/crypto/schnorr.js";
import {
  authTokenMessage,
  authTokenMessageHash,
  createAuthToken,
  packAuthMessage,
} from "../../dist/client/auth-token.js";
import type { TxAttributes } from "../../dist/tx/attributes.js";
import type { UnsignedTx } from "../../dist/tx/build.js";
import type { OrderInfo } from "../../dist/tx/types/orders.js";
import type { TransactOpts } from "../../dist/tx/opts.js";
import {
  EIP191_PREFIX,
  TxType,
  aggregateTxHash,
  approveIntegratorMessage,
  attributesAreEmpty,
  attributesHash,
  buildApproveIntegrator,
  buildBurnShares,
  buildCancelAllOrders,
  buildCancelOrder,
  buildChangePubKey,
  buildCreateGroupedOrders,
  buildCreateOrder,
  buildCreatePublicPool,
  buildCreateSubAccount,
  buildMintShares,
  buildModifyOrder,
  buildStakeAssets,
  buildTransfer,
  buildUnstakeAssets,
  buildUpdateAccountAssetConfig,
  buildUpdateAccountConfig,
  buildUpdateLeverage,
  buildUpdateMargin,
  buildUpdatePublicPool,
  buildWithdraw,
  changePubKeyMessage,
  createSubAccountMessage,
  eip191Message,
  i16,
  i64,
  l1MessageFor,
  signTx,
  transferMessage,
  txHashHex,
  u8,
  u16,
  u32,
  u64,
} from "../../dist/tx/index.js";

/* -------------------------------------------------------------------------------------------------
 * Public shape
 * ---------------------------------------------------------------------------------------------- */

/** The six vector files, parsed. Keys are file names exactly as they appear on disk. */
export interface VectorBundle {
  readonly [file: string]: unknown;
}

/** One divergence, named precisely enough to find without a debugger. */
export interface VectorFailure {
  readonly file: string;
  readonly section: string;
  readonly index: number;
  readonly detail: string;
}

/** Per-section accounting. `declared` is read from the JSON; `executed` is what actually ran. */
export interface SectionSummary {
  readonly file: string;
  readonly section: string;
  readonly declared: number;
  readonly executed: number;
  readonly failures: number;
}

export interface RunSummary {
  readonly total: number;
  readonly failures: number;
  readonly failed: readonly VectorFailure[];
  readonly sections: readonly SectionSummary[];
}

/** The file names {@link loadVectors} reads and {@link runVectors} requires. */
export const VECTOR_FILES: readonly string[] = [
  "goldilocks.json",
  "gfp5.json",
  "poseidon2.json",
  "curve.json",
  "schnorr.json",
  "tx.json",
];

/* -------------------------------------------------------------------------------------------------
 * Runtime shim — the only runtime-specific code in the file
 * ---------------------------------------------------------------------------------------------- */

interface BunGlobal {
  readonly file: (p: string | URL) => { text: () => Promise<string> };
  readonly version?: string;
}

interface DenoGlobal {
  readonly readTextFile: (p: string | URL) => Promise<string>;
  readonly args?: readonly string[];
  readonly env?: { get: (n: string) => string | undefined };
  readonly exit?: (code: number) => never;
  readonly version?: { deno?: string };
}

interface ProcessGlobal {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  exitCode?: number;
  versions?: Record<string, string | undefined>;
  exit?: (code: number) => never;
}

interface Runtimes {
  readonly Bun?: BunGlobal;
  readonly Deno?: DenoGlobal;
  readonly process?: ProcessGlobal;
  readonly navigator?: { userAgent?: string };
}

function runtimes(): Runtimes {
  return globalThis as unknown as Runtimes;
}

/** A human name for the banner. Never used for control flow — only the three checks below are. */
function runtimeName(): string {
  const g: Runtimes = runtimes();
  if (g.Bun !== undefined) return `Bun ${g.Bun.version ?? "?"}`;
  if (g.Deno !== undefined) return `Deno ${g.Deno.version?.deno ?? "?"}`;
  const ua: string | undefined = g.navigator?.userAgent;
  if (ua !== undefined && ua.includes("Cloudflare-Workers")) return "workerd";
  const node: string | undefined = g.process?.versions?.["node"];
  if (node !== undefined) return `Node ${node}`;
  return "unknown runtime";
}

/**
 * Read one text file, three ways.
 *
 * The Node branch is a dynamic import whose specifier is built at run time. That is not
 * superstition: a static `import`, or even a dynamic one with a literal specifier, is enough for a
 * bundler targeting workerd-without-`nodejs_compat` to try to resolve `node:fs/promises` and fail
 * the build — turning the one test that proves the absence of Node built-ins into a build error.
 */
async function readText(target: string | URL): Promise<string> {
  const g: Runtimes = runtimes();
  if (g.Bun !== undefined) return await g.Bun.file(target).text();
  if (g.Deno !== undefined) return await g.Deno.readTextFile(target);
  const specifier: string = ["node", "fs/promises"].join(":");
  const fs = (await import(specifier)) as {
    readFile: (p: string | URL, enc: string) => Promise<string>;
  };
  return await fs.readFile(target, "utf8");
}

function withTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : `${s}/`;
}

/** Resolve `name` against a base that may be a URL, a URL string, or a plain filesystem path. */
function resolveVector(base: string | URL, name: string): string | URL {
  if (base instanceof URL) return new URL(name, withTrailingSlash(base.href));
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(base)) return new URL(name, withTrailingSlash(base));
  return withTrailingSlash(base) + name;
}

/** CLI arguments, minus the interpreter and script path. Empty where there is no CLI. */
function cliArgs(): readonly string[] {
  const g: Runtimes = runtimes();
  if (g.Deno?.args !== undefined) return g.Deno.args;
  const argv: readonly string[] | undefined = g.process?.argv;
  return argv === undefined ? [] : argv.slice(2);
}

/** An environment variable, or `undefined` — including when the runtime denies permission. */
function envVar(name: string): string | undefined {
  const g: Runtimes = runtimes();
  try {
    if (g.Deno?.env !== undefined) return g.Deno.env.get(name);
  } catch {
    // `deno run` without `--allow-env`. Not an error: the default base is what we want anyway.
    return undefined;
  }
  return g.process?.env?.[name];
}

/**
 * Where the vectors live, in precedence order: explicit argument, first CLI argument,
 * `LIGHTER_VECTORS`, then a path relative to this module.
 */
function defaultBase(): string | URL {
  const arg: string | undefined = cliArgs()[0];
  if (arg !== undefined && arg.length > 0) return arg;
  const env: string | undefined = envVar("LIGHTER_VECTORS");
  if (env !== undefined && env.length > 0) return env;
  return new URL("../../conformance/vectors/", import.meta.url);
}

/**
 * Load the six vector files.
 *
 * Not called on workerd, which has no filesystem — see the module header.
 */
export async function loadVectors(baseDir?: string | URL): Promise<VectorBundle> {
  const base: string | URL = baseDir ?? defaultBase();
  const bundle: Record<string, unknown> = {};
  for (const name of VECTOR_FILES) {
    const target: string | URL = resolveVector(base, name);
    bundle[name] = JSON.parse(await readText(target)) as unknown;
  }
  return bundle;
}

/* -------------------------------------------------------------------------------------------------
 * Assertions — the whole framework
 * ---------------------------------------------------------------------------------------------- */

class VectorMismatch extends Error {}

function render(v: unknown): string {
  if (typeof v === "bigint") return v.toString(10);
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return `[${(v as readonly unknown[]).map(render).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function fail(what: string, actual: unknown, expected: unknown): never {
  throw new VectorMismatch(`${what}: got ${render(actual)}, want ${render(expected)}`);
}

function eqBig(what: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) fail(what, actual, expected);
}

function eqStr(what: string, actual: string, expected: string): void {
  if (actual !== expected) fail(what, actual, expected);
}

function eqNum(what: string, actual: number, expected: number): void {
  if (actual !== expected) fail(what, actual, expected);
}

function eqBool(what: string, actual: boolean, expected: boolean): void {
  if (actual !== expected) fail(what, actual, expected);
}

/** Compare a limb tuple against the vector's decimal strings, element by element. */
function eqLimbs(what: string, actual: readonly bigint[], expected: readonly string[]): void {
  if (actual.length !== expected.length) {
    fail(`${what} length`, actual.length, expected.length);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const want: bigint = BigInt(expected[i] as string);
    if ((actual[i] as bigint) !== want) fail(`${what}[${String(i)}]`, actual[i], want);
  }
}

function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Bytes and limbs
 * ---------------------------------------------------------------------------------------------- */

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`odd-length hex string of ${String(s.length)} chars`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const UTF8: TextEncoder = new TextEncoder();

/* -------------------------------------------------------------------------------------------------
 * Keccak-256 — verifier-only, never part of the published package
 * ---------------------------------------------------------------------------------------------- */

const U64_MASK = 0xffff_ffff_ffff_ffffn;
const KECCAK_RATE = 136;
const KECCAK_RHO: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const KECCAK_ROUND_CONSTANTS: readonly bigint[] = [
  0x0000_0000_0000_0001n,
  0x0000_0000_0000_8082n,
  0x8000_0000_0000_808an,
  0x8000_0000_8000_8000n,
  0x0000_0000_0000_808bn,
  0x0000_0000_8000_0001n,
  0x8000_0000_8000_8081n,
  0x8000_0000_0000_8009n,
  0x0000_0000_0000_008an,
  0x0000_0000_0000_0088n,
  0x0000_0000_8000_8009n,
  0x0000_0000_8000_000an,
  0x0000_0000_8000_808bn,
  0x8000_0000_0000_008bn,
  0x8000_0000_0000_8089n,
  0x8000_0000_0000_8003n,
  0x8000_0000_0000_8002n,
  0x8000_0000_0000_0080n,
  0x0000_0000_0000_800an,
  0x8000_0000_8000_000an,
  0x8000_0000_8000_8081n,
  0x8000_0000_0000_8080n,
  0x0000_0000_8000_0001n,
  0x8000_0000_8000_8008n,
];

function rotateLeft64(value: bigint, shift: number): bigint {
  if (shift === 0) return value & U64_MASK;
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (64n - bits))) & U64_MASK;
}

function keccakF1600(state: bigint[]): void {
  const columns = new Array<bigint>(5).fill(0n);
  const mixed = new Array<bigint>(25).fill(0n);
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x += 1) {
      columns[x] =
        (state[x] as bigint) ^
        (state[x + 5] as bigint) ^
        (state[x + 10] as bigint) ^
        (state[x + 15] as bigint) ^
        (state[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x += 1) {
      const delta =
        (columns[(x + 4) % 5] as bigint) ^
        rotateLeft64(columns[(x + 1) % 5] as bigint, 1);
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        state[index] = (state[index] as bigint) ^ delta;
      }
    }

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const source = x + 5 * y;
        const destination = y + 5 * ((2 * x + 3 * y) % 5);
        mixed[destination] = rotateLeft64(
          state[source] as bigint,
          KECCAK_RHO[source] as number,
        );
      }
    }

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const index = x + 5 * y;
        const next = ((x + 1) % 5) + 5 * y;
        const afterNext = ((x + 2) % 5) + 5 * y;
        state[index] =
          ((mixed[index] as bigint) ^
            ((~(mixed[next] as bigint)) & (mixed[afterNext] as bigint))) &
          U64_MASK;
      }
    }
    state[0] = (state[0] as bigint) ^ roundConstant;
  }
}

/** Ethereum's Keccak-256, whose domain suffix is 0x01 rather than SHA3-256's 0x06. */
function keccak256(input: Uint8Array): Uint8Array {
  const padding = KECCAK_RATE - (input.length % KECCAK_RATE);
  const padded = new Uint8Array(input.length + padding);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] as number) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE) {
    for (let lane = 0; lane < KECCAK_RATE / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[offset + lane * 8 + byte] as number) << BigInt(byte * 8);
      }
      state[lane] = (state[lane] as bigint) ^ value;
    }
    keccakF1600(state);
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index += 1) {
    const lane = state[Math.floor(index / 8)] as bigint;
    digest[index] = Number((lane >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return digest;
}

/** Decimal strings to an `Fp5`. Every coefficient in every vector file is canonical. */
function el(limbs: readonly string[]): Fp5 {
  return fp5FromLimbs(limbs.map((s: string): bigint => BigInt(s)));
}

/** Decimal strings to branded base-field elements, for the Poseidon2 entry points. */
function fps(limbs: readonly string[]): Fp[] {
  return limbs.map((s: string): Fp => fpFromInt(BigInt(s)));
}

function strings(v: readonly bigint[]): string[] {
  return v.map((x: bigint): string => x.toString(10));
}

/** Five 64-bit little-endian limbs to the integer they denote. */
function fromLimbs(limbs: readonly string[]): bigint {
  let acc = 0n;
  for (let i = limbs.length - 1; i >= 0; i -= 1) acc = (acc << 64n) | BigInt(limbs[i] as string);
  return acc;
}

/* -------------------------------------------------------------------------------------------------
 * Section plumbing
 * ---------------------------------------------------------------------------------------------- */

type Check = () => void | Promise<void>;

interface Section {
  readonly file: string;
  readonly name: string;
  readonly checks: readonly Check[];
}

function section(file: string, name: string, checks: readonly Check[]): Section {
  return { file, name, checks };
}

/**
 * The inventory: every section that must run, and where its length comes from.
 *
 * This list is deliberately *not* derived from the section builders below. The count each builder
 * produces is compared against the count this list reads out of the JSON, so a builder that
 * silently drops a section — or slices a row list — fails rather than reporting a smaller green
 * run. `key` names a JSON array whose length is read at run time; `fixed` is for the handful of
 * sections that assert named scalars rather than rows, and states how many assertions that is.
 */
interface SectionSpec {
  readonly file: string;
  readonly section: string;
  readonly key?: string;
  readonly fixed?: number;
}

const INVENTORY: readonly SectionSpec[] = [
  // `order`, `epsilon`, `twoAdicity`, `powerOfTwoGenerator`.
  { file: "goldilocks.json", section: "constants", fixed: 4 },
  { file: "goldilocks.json", section: "cases", key: "cases" },
  { file: "goldilocks.json", section: "encoding", key: "encoding" },
  { file: "gfp5.json", section: "cases", key: "cases" },
  // The whole round-constant table plus its digest, asserted as one case.
  { file: "poseidon2.json", section: "constants", fixed: 1 },
  { file: "poseidon2.json", section: "permutations", key: "permutations" },
  { file: "poseidon2.json", section: "hashToQuinticExtension", key: "hashToQuinticExtension" },
  { file: "poseidon2.json", section: "hashNoPad", key: "hashNoPad" },
  { file: "poseidon2.json", section: "hashNToMNoPad", key: "hashNToMNoPad" },
  { file: "curve.json", section: "generatorEncoded", fixed: 1 },
  { file: "curve.json", section: "neutralEncoded", fixed: 1 },
  { file: "curve.json", section: "cases", key: "cases" },
  { file: "curve.json", section: "scalarCases", key: "scalarCases" },
  { file: "schnorr.json", section: "cases", key: "cases" },
  { file: "schnorr.json", section: "negative", key: "negative" },
  { file: "schnorr.json", section: "malleable", key: "malleable" },
  { file: "tx.json", section: "attributeHashes", key: "attributeHashes" },
  { file: "tx.json", section: "txHashes", key: "txHashes" },
  { file: "tx.json", section: "l1Messages", key: "l1Messages" },
  { file: "tx.json", section: "authTokens", key: "authTokens" },
];

function declaredCount(bundle: VectorBundle, spec: SectionSpec): number {
  if (spec.key !== undefined) return rows(bundle, spec.file, spec.key).length;
  if (spec.fixed === undefined) {
    throw new Error(`inventory entry ${spec.file}/${spec.section} declares neither key nor fixed`);
  }
  return spec.fixed;
}

/** Read a required top-level section, failing loudly rather than running zero cases. */
function rows<T>(bundle: VectorBundle, file: string, key: string): readonly T[] {
  const parsed: unknown = bundle[file];
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    throw new Error(`vector bundle is missing ${file}`);
  }
  const value: unknown = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    throw new Error(`${file} has no array section named ${key}`);
  }
  return value as readonly T[];
}

function fileOf<T>(bundle: VectorBundle, file: string): T {
  const parsed: unknown = bundle[file];
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    throw new Error(`vector bundle is missing ${file}`);
  }
  return parsed as T;
}

/* -------------------------------------------------------------------------------------------------
 * goldilocks.json
 * ---------------------------------------------------------------------------------------------- */

interface GoldilocksCase {
  readonly a: string;
  readonly b: string;
  readonly add: string;
  readonly sub: string;
  readonly mul: string;
  readonly squareA: string;
  readonly doubleA: string;
  readonly negA: string;
  readonly exp: string;
  readonly expPow2: string;
  readonly isQuadraticResidueA: boolean;
  readonly sqrtA: string | null;
}

interface GoldilocksFile {
  readonly order: string;
  readonly epsilon: string;
  readonly twoAdicity: number;
  readonly powerOfTwoGenerator: string;
}

function goldilocksSections(bundle: VectorBundle): readonly Section[] {
  const file = "goldilocks.json";
  const consts: GoldilocksFile = fileOf<GoldilocksFile>(bundle, file);
  const cases: readonly GoldilocksCase[] = rows<GoldilocksCase>(bundle, file, "cases");
  const encoding: readonly { readonly value: string; readonly leBytesHex: string }[] = rows(
    bundle,
    file,
    "encoding",
  );

  // Four named constants, so `declared` is the number of keys asserted rather than an array length.
  const constantChecks: readonly Check[] = [
    (): void => {
      eqBig("order", P, BigInt(consts.order));
    },
    (): void => {
      eqBig("epsilon", EPSILON, BigInt(consts.epsilon));
    },
    (): void => {
      eqNum("twoAdicity", TWO_ADICITY, consts.twoAdicity);
    },
    (): void => {
      eqBig("powerOfTwoGenerator", POWER_OF_TWO_GENERATOR, BigInt(consts.powerOfTwoGenerator));
    },
  ];

  return [
    section(file, "constants", constantChecks),
    section(
      file,
      "cases",
      cases.map((c: GoldilocksCase): Check => (): void => {
        const a: Fp = fpFromInt(BigInt(c.a));
        const b: Fp = fpFromInt(BigInt(c.b));
        eqBig("add", fpAdd(a, b), BigInt(c.add));
        eqBig("sub", fpSub(a, b), BigInt(c.sub));
        eqBig("mul", fpMul(a, b), BigInt(c.mul));
        eqBig("squareA", fpSquare(a), BigInt(c.squareA));
        eqBig("doubleA", fpDouble(a), BigInt(c.doubleA));
        eqBig("negA", fpNeg(a), BigInt(c.negA));
        eqBig("exp", fpExp(a, BigInt(c.b)), BigInt(c.exp));
        // The oracle emits `a^(2^7)`; `fpExpPow2(a, 7)` must agree with the generic path too.
        eqBig("expPow2", fpExpPow2(a, 7), BigInt(c.expPow2));
        eqBig("expPow2 via fpExp", fpExp(a, 128n), BigInt(c.expPow2));
        eqBool("isQuadraticResidueA", fpIsQuadraticResidue(a), c.isQuadraticResidueA);
        const root: Fp | null = fpSqrt(a);
        if (c.sqrtA === null) {
          if (root !== null) fail("sqrtA", root, null);
        } else {
          if (root === null) fail("sqrtA", null, BigInt(c.sqrtA));
          eqBig("sqrtA", root, BigInt(c.sqrtA));
        }
      }),
    ),
    section(
      file,
      "encoding",
      encoding.map(
        (row: { readonly value: string; readonly leBytesHex: string }): Check =>
          (): void => {
            const v: Fp = fpFromInt(BigInt(row.value));
            eqStr("leBytesHex", toHex(fpToBytes(v)), row.leBytesHex);
            eqBig("fpFromBytes", fpFromBytes(fromHex(row.leBytesHex)), v);
          },
      ),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * gfp5.json
 * ---------------------------------------------------------------------------------------------- */

interface Gfp5Case {
  readonly a: readonly string[];
  readonly b: readonly string[];
  readonly add: readonly string[];
  readonly sub: readonly string[];
  readonly mul: readonly string[];
  readonly squareA: readonly string[];
  readonly doubleA: readonly string[];
  readonly tripleA: readonly string[];
  readonly negA: readonly string[];
  readonly inverseA: readonly string[];
  readonly divAB: readonly string[];
  readonly frobeniusA: readonly string[];
  readonly frobenius2A: readonly string[];
  readonly scalarMulA: readonly string[];
  readonly legendreA: string;
  readonly sgn0A: boolean;
  readonly sqrtA: readonly string[];
  readonly sqrtAExists: boolean;
  readonly canonicalSqrtA: readonly string[];
  readonly canonicalSqrtAExists: boolean;
  readonly aLeBytesHex: string;
}

function gfp5Sections(bundle: VectorBundle): readonly Section[] {
  const file = "gfp5.json";
  const byteWidth: number = fileOf<{ readonly bytes: number }>(bundle, file).bytes;
  const cases: readonly Gfp5Case[] = rows<Gfp5Case>(bundle, file, "cases");

  return [
    section(
      file,
      "cases",
      cases.map((c: Gfp5Case): Check => (): void => {
        const a: Fp5 = el(c.a);
        const b: Fp5 = el(c.b);
        eqLimbs("add", fp5Add(a, b), c.add);
        eqLimbs("sub", fp5Sub(a, b), c.sub);
        eqLimbs("mul", fp5Mul(a, b), c.mul);
        eqLimbs("squareA", fp5Square(a), c.squareA);
        eqLimbs("doubleA", fp5Double(a), c.doubleA);
        eqLimbs("tripleA", fp5Triple(a), c.tripleA);
        eqLimbs("negA", fp5Neg(a), c.negA);
        eqLimbs("inverseA", fp5InverseOrZero(a), c.inverseA);
        eqLimbs("frobeniusA", fp5Frobenius(a), c.frobeniusA);
        eqLimbs("repeatedFrobenius(1)", fp5RepeatedFrobenius(a, 1), c.frobeniusA);
        eqLimbs("frobenius2A", fp5RepeatedFrobenius(a, 2), c.frobenius2A);
        // `scalarMulA` is multiplication by `b`'s *base-field* coefficient 0, not by `b`.
        eqLimbs("scalarMulA", fp5ScalarMul(a, fpFromInt(BigInt(c.b[0] as string))), c.scalarMulA);

        if (fp5IsZero(b)) {
          // The Go `Div` panics on a zero divisor, so the oracle zero-fills the row. Comparing
          // against those zeros would pass an implementation that returns garbage; the contract is
          // that this SDK throws. (`test/crypto/field/fp5.test.ts` makes the same distinction.)
          if (!c.divAB.every((s: string): boolean => s === "0")) {
            fail("divAB decoy", c.divAB, "all zeros");
          }
          if (!threw((): unknown => fp5Div(a, b))) fail("fp5Div(a, 0)", "returned", "throw");
        } else {
          eqLimbs("divAB", fp5Div(a, b), c.divAB);
        }

        eqBig("legendreA", fp5Legendre(a), BigInt(c.legendreA));
        eqBool("sgn0A", fp5Sgn0(a), c.sgn0A);

        const root = fp5Sqrt(a);
        eqBool("sqrtAExists", root.exists, c.sqrtAExists);
        eqLimbs("sqrtA", root.root, c.sqrtA);

        const canonical = fp5CanonicalSqrt(a);
        eqBool("canonicalSqrtAExists", canonical.exists, c.canonicalSqrtAExists);
        eqLimbs("canonicalSqrtA", canonical.root, c.canonicalSqrtA);

        const bytes: Uint8Array = fp5ToBytes(a);
        eqNum("encoded width", bytes.length, byteWidth);
        eqStr("aLeBytesHex", toHex(bytes), c.aLeBytesHex);
      }),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * poseidon2.json
 * ---------------------------------------------------------------------------------------------- */

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

async function sha256Hex(text: string): Promise<string> {
  const digest: ArrayBuffer = await crypto.subtle.digest("SHA-256", UTF8.encode(text));
  return toHex(new Uint8Array(digest));
}

function poseidon2Sections(bundle: VectorBundle): readonly Section[] {
  const file = "poseidon2.json";
  const c: Poseidon2Constants = fileOf<{ readonly constants: Poseidon2Constants }>(
    bundle,
    file,
  ).constants;
  const permutations: readonly { readonly input: readonly string[]; readonly output: readonly string[] }[] =
    rows(bundle, file, "permutations");
  const quintic: readonly {
    readonly input: readonly string[];
    readonly output: readonly string[];
    readonly outputLeBytesHex: string;
  }[] = rows(bundle, file, "hashToQuinticExtension");
  const noPad: readonly { readonly input: readonly string[]; readonly output: readonly string[] }[] =
    rows(bundle, file, "hashNoPad");
  const nToM: readonly {
    readonly input: readonly string[];
    readonly numOutputs: number;
    readonly output: readonly string[];
  }[] = rows(bundle, file, "hashNToMNoPad");

  /**
   * The generated constant table, compared element by element and then pinned by its digest.
   *
   * A single wrong digit here makes every Poseidon2 hash wrong for every input, and nothing in the
   * resulting failure points at the cause — which is exactly why the digest exists.
   */
  const constantsCheck: Check = async (): Promise<void> => {
    eqNum("width", WIDTH, c.width);
    eqNum("rate", RATE, c.rate);
    eqNum("out", OUT, c.out);
    eqNum("sboxDegree", SBOX_DEGREE, c.sboxDegree);
    eqNum("roundsF", ROUNDS_F, c.roundsF);
    eqNum("roundsFHalf", ROUNDS_F_HALF, c.roundsFHalf);
    eqNum("roundsP", ROUNDS_P, c.roundsP);
    // The module stores the external constants flat, `roundsF * width` of them; the vector nests
    // them per round. Flatten the vector rather than reshaping the module, so the comparison
    // still fails if a round boundary moves.
    const flatExternal: string[] = [];
    for (const round of c.externalConstants) flatExternal.push(...round);
    eqNum("externalConstants length", EXTERNAL_ROUND_CONSTANTS.length, c.roundsF * c.width);
    eqLimbs("externalConstants", EXTERNAL_ROUND_CONSTANTS, flatExternal);
    eqLimbs("internalConstants", INTERNAL_ROUND_CONSTANTS, c.internalConstants);
    eqLimbs("matrixDiag12", INTERNAL_DIAGONAL, c.matrixDiag12);

    const canonical: string = JSON.stringify({
      diag: c.matrixDiag12,
      external: c.externalConstants,
      internal: c.internalConstants,
    });
    eqStr("CONSTANTS_DIGEST", CONSTANTS_DIGEST, await sha256Hex(canonical));
  };

  return [
    section(file, "constants", [constantsCheck]),
    section(
      file,
      "permutations",
      permutations.map(
        (row: { readonly input: readonly string[]; readonly output: readonly string[] }): Check =>
          (): void => {
            const state: State = fps(row.input) as unknown as State;
            eqNum("state width", state.length, c.width);
            permute(state);
            eqLimbs("permute", state, row.output);
          },
      ),
    ),
    section(
      file,
      "hashToQuinticExtension",
      quintic.map(
        (row: {
          readonly input: readonly string[];
          readonly output: readonly string[];
          readonly outputLeBytesHex: string;
        }): Check =>
          (): void => {
            const got: Fp5 = hashToQuinticExtension(fps(row.input));
            eqLimbs("hashToQuinticExtension", got, row.output);
            eqStr("outputLeBytesHex", toHex(fp5ToBytes(got)), row.outputLeBytesHex);
          },
      ),
    ),
    section(
      file,
      "hashNoPad",
      noPad.map(
        (row: { readonly input: readonly string[]; readonly output: readonly string[] }): Check =>
          (): void => {
            eqLimbs("hashNoPad", hashNoPad(fps(row.input)), row.output);
          },
      ),
    ),
    section(
      file,
      "hashNToMNoPad",
      nToM.map(
        (row: {
          readonly input: readonly string[];
          readonly numOutputs: number;
          readonly output: readonly string[];
        }): Check =>
          (): void => {
            eqLimbs("hashNToM", hashNToM(fps(row.input), row.numOutputs), row.output);
          },
      ),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * curve.json
 * ---------------------------------------------------------------------------------------------- */

interface CurveCase {
  readonly scalarLeHex: string;
  readonly scalar: readonly string[];
  readonly mulGenEncoded: readonly string[];
  readonly mulGenLeBytesHex: string;
  readonly doubleEncoded: readonly string[];
  readonly addGenEncoded: readonly string[];
  readonly decodeRoundTrip: boolean;
}

interface ScalarCase {
  readonly inputLeHex: string;
  readonly scalar: readonly string[];
  readonly inputWasInRange: boolean;
  readonly wasReduced: boolean;
  readonly outputLeHex: string;
}

function curveSections(bundle: VectorBundle): readonly Section[] {
  const file = "curve.json";
  const whole = fileOf<{
    readonly generatorEncoded: readonly string[];
    readonly neutralEncoded: readonly string[];
  }>(bundle, file);
  const cases: readonly CurveCase[] = rows<CurveCase>(bundle, file, "cases");
  const scalarCases: readonly ScalarCase[] = rows<ScalarCase>(bundle, file, "scalarCases");

  return [
    // The cheapest falsification in the stack: if `encode(G)` is not `[4,0,0,0,0]`, nothing above
    // it can be right, and every later failure is noise.
    section(file, "generatorEncoded", [
      (): void => {
        eqLimbs("encode(G)", encodePoint(GENERATOR), whole.generatorEncoded);
      },
    ]),
    section(file, "neutralEncoded", [
      (): void => {
        eqLimbs("encode(N)", encodePoint(NEUTRAL), whole.neutralEncoded);
      },
    ]),
    section(
      file,
      "cases",
      cases.map((c: CurveCase): Check => (): void => {
        const s: bigint = scalarFromBytes(fromHex(c.scalarLeHex));
        eqBig("scalar limbs", s, fromLimbs(c.scalar));

        const p = mulGenerator(s);
        const encoded: Fp5 = encodePoint(p);
        eqLimbs("mulGenEncoded", encoded, c.mulGenEncoded);
        eqStr("mulGenLeBytesHex", toHex(fp5ToBytes(encoded)), c.mulGenLeBytesHex);
        eqBool("on curve", pointIsOnCurve(p), true);

        const decoded = decodePoint(encoded);
        eqBool("decodeRoundTrip", decoded !== null, c.decodeRoundTrip);
        if (decoded === null) fail("decodePoint", null, "a point");
        eqLimbs("encode(decode(w))", encodePoint(decoded), c.mulGenEncoded);

        eqLimbs("doubleEncoded", encodePoint(pointDouble(p)), c.doubleEncoded);
        eqLimbs("addGenEncoded", encodePoint(pointAdd(p, GENERATOR)), c.addGenEncoded);
      }),
    ),
    section(
      file,
      "scalarCases",
      scalarCases.map((c: ScalarCase): Check => (): void => {
        const bytes: Uint8Array = fromHex(c.inputLeHex);
        const s: bigint = scalarFromBytes(bytes);
        eqBig("scalarFromBytes", s, fromLimbs(c.scalar));
        eqStr("outputLeHex", toHex(scalarToBytes(s)), c.outputLeHex);
        eqBool("inputWasInRange", scalarIsCanonicalBytes(bytes), c.inputWasInRange);
        eqBool("wasReduced", c.outputLeHex !== c.inputLeHex, c.wasReduced);
      }),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * schnorr.json
 * ---------------------------------------------------------------------------------------------- */

interface SchnorrCase {
  readonly privateKeyLeHex: string;
  readonly publicKey: readonly string[];
  readonly publicKeyLeHex: string;
  readonly messageElements: readonly string[];
  readonly hashedMessage: readonly string[];
  readonly hashedMessageLeHex: string;
  readonly nonceKLeHex: string;
  readonly sigS: readonly string[];
  readonly sigE: readonly string[];
  readonly signatureBytesHex: string;
  readonly valid: boolean;
}

interface SchnorrNegative {
  readonly description: string;
  readonly publicKeyLeHex: string;
  readonly hashedMessageLeHex: string;
  readonly signatureHex: string;
  readonly valid: boolean;
}

interface SchnorrMalleable {
  readonly description: string;
  readonly publicKeyLeHex: string;
  readonly hashedMessageLeHex: string;
  readonly shiftedSignatureHex: string;
  readonly shiftedValidates: boolean;
}

function schnorrSections(bundle: VectorBundle): readonly Section[] {
  const file = "schnorr.json";
  const widths = fileOf<{ readonly signatureBytes: number; readonly pubKeyBytes: number }>(
    bundle,
    file,
  );
  const cases: readonly SchnorrCase[] = rows<SchnorrCase>(bundle, file, "cases");
  const negative: readonly SchnorrNegative[] = rows<SchnorrNegative>(bundle, file, "negative");
  const malleable: readonly SchnorrMalleable[] = rows<SchnorrMalleable>(bundle, file, "malleable");

  return [
    section(
      file,
      "cases",
      cases.map((c: SchnorrCase): Check => (): void => {
        const sk: bigint = scalarFromBytes(fromHex(c.privateKeyLeHex));

        const pub: Fp5 = publicKeyFromPrivateKey(sk);
        eqLimbs("publicKey", pub, c.publicKey);
        eqStr("publicKeyLeHex", toHex(fp5ToBytes(pub)), c.publicKeyLeHex);

        // The message hash comes through the Poseidon2 seam, which is where a message assembled by
        // a different route diverges from one assembled correctly.
        const hashed: Fp5 = hashToQuinticExtension(fps(c.messageElements));
        eqLimbs("hashedMessage", hashed, c.hashedMessage);
        const hashedBytes: Uint8Array = fp5ToBytes(hashed);
        eqStr("hashedMessageLeHex", toHex(hashedBytes), c.hashedMessageLeHex);

        // Signed with the row's pinned `k`. The library's default is hedged-deterministic
        // (`docs/decisions.md` D2) and would produce a different — equally valid — signature that
        // does not match the vector, so the explicit-`k` seam is the only thing that can be
        // compared byte for byte. Relaxing this to "it verifies" would delete the assertion.
        const k: bigint = scalarFromBytes(fromHex(c.nonceKLeHex));
        const sig = signHashed(hashed, sk, k);
        eqBig("sigS", sig.s, fromLimbs(c.sigS));
        eqBig("sigE", sig.e, fromLimbs(c.sigE));

        const sigBytes: Uint8Array = signatureToBytes(sig);
        eqNum("signature width", sigBytes.length, widths.signatureBytes);
        eqStr("signatureBytesHex", toHex(sigBytes), c.signatureBytesHex);

        eqBool("verify", verify(fp5ToBytes(pub), hashedBytes, sigBytes), c.valid);

        // And the same thing through the public `ApiKey` surface, which is what callers touch.
        const key: ApiKey = ApiKey.fromPrivateKey(c.privateKeyLeHex);
        // `publicKeyHex` is `0x`-prefixed; the vectors are raw. Both forms are checked so a change
        // to either convention is caught here rather than in a caller.
        eqStr("ApiKey.publicKeyHex", key.publicKeyHex, `0x${c.publicKeyLeHex}`);
        eqStr("ApiKey.publicKeyBytes", toHex(key.publicKeyBytes), c.publicKeyLeHex);
        eqNum("ApiKey.publicKeyBytes width", key.publicKeyBytes.length, widths.pubKeyBytes);
        const viaKey: Uint8Array = key.sign(hashedBytes, { nonce: k });
        eqStr("ApiKey.sign", toHex(viaKey), c.signatureBytesHex);
        // Synchronous, on every runtime: a `Promise` here would break every caller.
        eqBool("ApiKey.sign is not a Promise", (viaKey as unknown) instanceof Promise, false);
      }),
    ),
    section(
      file,
      "negative",
      negative.map((c: SchnorrNegative): Check => (): void => {
        eqBool(
          `negative (${c.description})`,
          verify(
            fromHex(c.publicKeyLeHex),
            fromHex(c.hashedMessageLeHex),
            fromHex(c.signatureHex),
          ),
          c.valid,
        );
      }),
    ),
    section(
      file,
      "malleable",
      malleable.map((c: SchnorrMalleable): Check => (): void => {
        // These must VERIFY. The reference reduces rather than rejects on the sign/verify path, so
        // signatures re-encoded with `s+n`, `e+n` or both are accepted by the sequencer
        // (`docs/decisions.md` D3). Asserting rejection here would pin an interop bug.
        eqBool(
          `malleable (${c.description}) must verify`,
          verify(
            fromHex(c.publicKeyLeHex),
            fromHex(c.hashedMessageLeHex),
            fromHex(c.shiftedSignatureHex),
          ),
          c.shiftedValidates,
        );
      }),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * tx.json
 * ---------------------------------------------------------------------------------------------- */

interface AttributeRow {
  readonly attributes: Readonly<Record<string, number>>;
  readonly isEmpty: boolean;
  readonly attributesHash: readonly string[];
  readonly inputTxHash: readonly string[];
  readonly aggregatedLeBytesHex: string;
}

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
  readonly messageHashLeHex: string;
  readonly signatureBytesHex: string;
  readonly nonceKLeHex: string;
  readonly txInfoJson: string;
}

interface L1MessageRow {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyUtf8Hex: string;
  readonly eip191HashHex: string;
}

interface AuthTokenRow {
  readonly deadline: string;
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly message: string;
  readonly messageUtf8Hex: string;
  readonly packedFieldElements: readonly string[];
  readonly messageHashLeHex: string;
  readonly nonceKLeHex: string;
  readonly signatureBytesHex: string;
  readonly token: string;
}

/**
 * The signing key behind every signature in `tx.json`.
 *
 * `tx.json` does not carry it. It carries the pinned nonce, and Schnorr gives the rest:
 * `sk = (k − s)·e⁻¹ (mod n)`. The recovery is done in `test/tx/pipeline.test.ts` over all 41 signed
 * rows, which all agree; the result is written out here rather than recomputed, so this file
 * inherits an assertion rather than a tautology.
 */
const TX_KEY_HEX =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

/** A required field. Missing means the vector changed shape — never coerce it to zero. */
function str(f: Readonly<Record<string, string>>, key: string): string {
  const value: string | undefined = f[key];
  if (value === undefined) throw new Error(`vector row is missing field ${key}`);
  return value;
}

/** A decimal-string field as `bigint`. Never via `Number` — `Index` reaches `2^60 − 1`. */
function big(f: Readonly<Record<string, string>>, key: string): bigint {
  return BigInt(str(f, key));
}

/** A decimal-string field as `number`. Only for fields the protocol declares 32 bits or narrower. */
function num(f: Readonly<Record<string, string>>, key: string): number {
  return Number(big(f, key));
}

function optsOf(row: TxHashRow): TransactOpts {
  const f: Readonly<Record<string, string>> = row.fields;
  const accountKey: string = "AccountIndex" in f ? "AccountIndex" : "FromAccountIndex";
  return {
    accountIndex: i64(big(f, accountKey)),
    apiKeyIndex: u8(num(f, "ApiKeyIndex")),
    nonce: i64(big(f, "Nonce")),
    expiredAt: i64(big(f, "ExpiredAt")),
    attributes: row.attributes as unknown as TxAttributes,
    // The reference has no lower bound on `L2UpdateMargin.USDCAmount`; this SDK's default rejects
    // negatives, so the three negative rows replay with that tightening off.
    strict: !row.name.startsWith("update_margin/negative"),
    now: (): number => {
      throw new Error("the clock must not be read when expiredAt is supplied");
    },
  };
}

function leg(f: Readonly<Record<string, string>>, index: number): OrderInfo {
  const p = `Order${String(index)}.`;
  return {
    marketIndex: i16(num(f, `${p}MarketIndex`)),
    clientOrderIndex: i64(big(f, `${p}ClientOrderIndex`)),
    baseAmount: i64(big(f, `${p}BaseAmount`)),
    price: u32(num(f, `${p}Price`)),
    isAsk: u8(num(f, `${p}IsAsk`)),
    type: u8(num(f, `${p}Type`)),
    timeInForce: u8(num(f, `${p}TimeInForce`)),
    reduceOnly: u8(num(f, `${p}ReduceOnly`)),
    triggerPrice: u32(num(f, `${p}TriggerPrice`)),
    orderExpiry: i64(big(f, `${p}OrderExpiry`)),
  };
}

/** Dispatch a vector row to its builder. Every one of the twenty constructible types appears. */
function buildFromRow(row: TxHashRow): UnsignedTx {
  const f: Readonly<Record<string, string>> = row.fields;
  const o: TransactOpts = optsOf(row);

  switch (row.txType) {
    case TxType.L2ChangePubKey:
      return buildChangePubKey({ pubKey: fromHex(str(f, "PubKeyLeHex")) }, o);
    case TxType.L2CreateSubAccount:
      return buildCreateSubAccount({}, o);
    case TxType.L2CreatePublicPool:
      return buildCreatePublicPool(
        {
          operatorFee: i64(big(f, "OperatorFee")),
          initialTotalShares: i64(big(f, "InitialTotalShares")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2UpdatePublicPool:
      return buildUpdatePublicPool(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          status: u8(num(f, "Status")),
          operatorFee: i64(big(f, "OperatorFee")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2Transfer:
      return buildTransfer(
        {
          toAccountIndex: i64(big(f, "ToAccountIndex")),
          assetIndex: i16(num(f, "AssetIndex")),
          fromRouteType: u8(num(f, "FromRouteType")),
          toRouteType: u8(num(f, "ToRouteType")),
          amount: i64(big(f, "Amount")),
          usdcFee: i64(big(f, "USDCFee")),
          // Not in the hash — it is bound to the transaction only by the L1 signature — so a zero
          // memo here cannot affect the assertion.
          memo: new Uint8Array(32),
        },
        o,
      );
    case TxType.L2Withdraw:
      return buildWithdraw(
        {
          assetIndex: i16(num(f, "AssetIndex")),
          routeType: u8(num(f, "RouteType")),
          amount: u64(big(f, "Amount")),
        },
        o,
      );
    case TxType.L2CreateOrder:
      return buildCreateOrder(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          clientOrderIndex: i64(big(f, "ClientOrderIndex")),
          baseAmount: i64(big(f, "BaseAmount")),
          price: u32(num(f, "Price")),
          isAsk: u8(num(f, "IsAsk")),
          orderType: u8(num(f, "Type")),
          timeInForce: u8(num(f, "TimeInForce")),
          reduceOnly: u8(num(f, "ReduceOnly")),
          triggerPrice: u32(num(f, "TriggerPrice")),
          orderExpiry: i64(big(f, "OrderExpiry")),
        },
        o,
      );
    case TxType.L2CancelOrder:
      return buildCancelOrder(
        { marketIndex: i16(num(f, "MarketIndex")), index: i64(big(f, "Index")) },
        o,
      );
    case TxType.L2CancelAllOrders:
      return buildCancelAllOrders(
        { timeInForce: u8(num(f, "TimeInForce")), time: i64(big(f, "Time")) },
        o,
      );
    case TxType.L2ModifyOrder:
      return buildModifyOrder(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          index: i64(big(f, "Index")),
          baseAmount: i64(big(f, "BaseAmount")),
          price: u32(num(f, "Price")),
          triggerPrice: u32(num(f, "TriggerPrice")),
        },
        o,
      );
    case TxType.L2MintShares:
      return buildMintShares(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2BurnShares:
      return buildBurnShares(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UpdateLeverage:
      return buildUpdateLeverage(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          initialMarginFraction: u16(num(f, "InitialMarginFraction")),
          marginMode: u8(num(f, "MarginMode")),
        },
        o,
      );
    case TxType.L2CreateGroupedOrders: {
      const count: number = num(f, "OrderCount");
      const orders: OrderInfo[] = [];
      for (let i = 0; i < count; i += 1) orders.push(leg(f, i));
      return buildCreateGroupedOrders({ groupingType: u8(num(f, "GroupingType")), orders }, o);
    }
    case TxType.L2UpdateMargin:
      return buildUpdateMargin(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          usdcAmount: i64(big(f, "USDCAmount")),
          direction: u8(num(f, "Direction")),
        },
        o,
      );
    case TxType.L2StakeAssets:
      return buildStakeAssets(
        {
          stakingPoolIndex: i64(big(f, "StakingPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UnstakeAssets:
      return buildUnstakeAssets(
        {
          stakingPoolIndex: i64(big(f, "StakingPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UpdateAccountConfig:
      return buildUpdateAccountConfig({ accountTradingMode: u8(num(f, "AccountTradingMode")) }, o);
    case TxType.L2UpdateAccountAssetConfig:
      return buildUpdateAccountAssetConfig(
        { assetIndex: i16(num(f, "AssetIndex")), assetMarginMode: u8(num(f, "AssetMarginMode")) },
        o,
      );
    case TxType.L2ApproveIntegrator:
      return buildApproveIntegrator(
        {
          integratorAccountIndex: i64(big(f, "IntegratorAccountIndex")),
          maxPerpsTakerFee: u32(num(f, "MaxPerpsTakerFee")),
          maxPerpsMakerFee: u32(num(f, "MaxPerpsMakerFee")),
          maxSpotTakerFee: u32(num(f, "MaxSpotTakerFee")),
          maxSpotMakerFee: u32(num(f, "MaxSpotMakerFee")),
          approvalExpiry: i64(big(f, "ApprovalExpiry")),
        },
        o,
      );
    default:
      throw new Error(`vector row has no builder for tx type ${String(row.txType)}`);
  }
}

/** An `expiredAt` that appears in no L1 message body, so a mapping that reached for it is visible. */
const UNRENDERED_EXPIRED_AT = 1712345678901n;

/** A row's L1 message, built twice: from the template, and from a transaction object. */
function l1BodyPair(row: L1MessageRow, chainId: number): readonly [string, string] {
  const f: Readonly<Record<string, string>> = row.fields;
  const chain: number = f["ChainId"] === undefined ? chainId : num(f, "ChainId");

  if (row.name === "change_pub_key") {
    return [
      changePubKeyMessage({
        pubKey: fromHex(str(f, "PubKeyLeHex")),
        nonce: big(f, "Nonce"),
        accountIndex: big(f, "AccountIndex"),
        apiKeyIndex: num(f, "ApiKeyIndex"),
      }),
      l1MessageFor(
        {
          type: TxType.L2ChangePubKey,
          nonce: i64(big(f, "Nonce")),
          expiredAt: i64(UNRENDERED_EXPIRED_AT),
          accountIndex: i64(big(f, "AccountIndex")),
          apiKeyIndex: u8(num(f, "ApiKeyIndex")),
          pubKey: fromHex(str(f, "PubKeyLeHex")),
        } as unknown as UnsignedTx,
        chain,
      ) as string,
    ];
  }
  if (row.name.startsWith("transfer/")) {
    return [
      transferMessage({
        nonce: big(f, "Nonce"),
        fromAccountIndex: big(f, "FromAccountIndex"),
        fromRouteType: num(f, "FromRouteType"),
        apiKeyIndex: num(f, "ApiKeyIndex"),
        toAccountIndex: big(f, "ToAccountIndex"),
        toRouteType: num(f, "ToRouteType"),
        assetIndex: num(f, "AssetIndex"),
        amount: big(f, "Amount"),
        usdcFee: big(f, "USDCFee"),
        chainId: chain,
        memo: fromHex(str(f, "MemoHex")),
      }),
      l1MessageFor(
        {
          type: TxType.L2Transfer,
          nonce: i64(big(f, "Nonce")),
          expiredAt: i64(UNRENDERED_EXPIRED_AT),
          fromAccountIndex: i64(big(f, "FromAccountIndex")),
          apiKeyIndex: u8(num(f, "ApiKeyIndex")),
          toAccountIndex: i64(big(f, "ToAccountIndex")),
          assetIndex: i16(num(f, "AssetIndex")),
          fromRouteType: u8(num(f, "FromRouteType")),
          toRouteType: u8(num(f, "ToRouteType")),
          amount: i64(big(f, "Amount")),
          usdcFee: i64(big(f, "USDCFee")),
          memo: fromHex(str(f, "MemoHex")),
        } as unknown as UnsignedTx,
        chain,
      ) as string,
    ];
  }
  if (row.name === "approve_integrator") {
    return [
      approveIntegratorMessage({
        nonce: big(f, "Nonce"),
        accountIndex: big(f, "AccountIndex"),
        apiKeyIndex: num(f, "ApiKeyIndex"),
        integratorAccountIndex: big(f, "IntegratorAccountIndex"),
        maxPerpsTakerFee: num(f, "MaxPerpsTakerFee"),
        maxPerpsMakerFee: num(f, "MaxPerpsMakerFee"),
        maxSpotTakerFee: num(f, "MaxSpotTakerFee"),
        maxSpotMakerFee: num(f, "MaxSpotMakerFee"),
        approvalExpiry: big(f, "ApprovalExpiry"),
        chainId: chain,
      }),
      l1MessageFor(
        {
          type: TxType.L2ApproveIntegrator,
          nonce: i64(big(f, "Nonce")),
          // Deliberately *not* ApprovalExpiry: the two are easy to confuse and the body renders one.
          expiredAt: i64(UNRENDERED_EXPIRED_AT),
          accountIndex: i64(big(f, "AccountIndex")),
          apiKeyIndex: u8(num(f, "ApiKeyIndex")),
          integratorAccountIndex: i64(big(f, "IntegratorAccountIndex")),
          maxPerpsTakerFee: u32(num(f, "MaxPerpsTakerFee")),
          maxPerpsMakerFee: u32(num(f, "MaxPerpsMakerFee")),
          maxSpotTakerFee: u32(num(f, "MaxSpotTakerFee")),
          maxSpotMakerFee: u32(num(f, "MaxSpotMakerFee")),
          approvalExpiry: i64(big(f, "ApprovalExpiry")),
        } as unknown as UnsignedTx,
        chain,
      ) as string,
    ];
  }
  if (row.name.startsWith("create_sub_account/")) {
    return [
      createSubAccountMessage({ masterAccountIndex: big(f, "MasterAccountIndex") }),
      l1MessageFor(
        {
          type: TxType.L2CreateSubAccount,
          nonce: i64(7n),
          expiredAt: i64(UNRENDERED_EXPIRED_AT),
          accountIndex: i64(big(f, "MasterAccountIndex")),
          apiKeyIndex: u8(0),
        } as unknown as UnsignedTx,
        chain,
      ) as string,
    ];
  }
  throw new Error(`no L1 builder for vector row ${row.name}`);
}

function txSections(bundle: VectorBundle): readonly Section[] {
  const file = "tx.json";
  const chainId: number = fileOf<{ readonly chainId: number }>(bundle, file).chainId;
  const attributeHashes: readonly AttributeRow[] = rows<AttributeRow>(
    bundle,
    file,
    "attributeHashes",
  );
  const txHashes: readonly TxHashRow[] = rows<TxHashRow>(bundle, file, "txHashes");
  const l1Messages: readonly L1MessageRow[] = rows<L1MessageRow>(bundle, file, "l1Messages");
  const authTokens: readonly AuthTokenRow[] = rows<AuthTokenRow>(bundle, file, "authTokens");

  const key: ApiKey = ApiKey.fromPrivateKey(TX_KEY_HEX);

  return [
    section(
      file,
      "attributeHashes",
      attributeHashes.map((row: AttributeRow): Check => (): void => {
        const attrs: TxAttributes = row.attributes as unknown as TxAttributes;
        eqBool("isEmpty", attributesAreEmpty(attrs), row.isEmpty);
        eqLimbs("attributesHash", attributesHash(attrs), row.attributesHash);
        eqStr(
          "aggregatedLeBytesHex",
          toHex(aggregateTxHash(el(row.inputTxHash), attrs)),
          row.aggregatedLeBytesHex,
        );
      }),
    ),
    section(
      file,
      "txHashes",
      txHashes.map((row: TxHashRow): Check => (): void => {
        const tx: UnsignedTx = buildFromRow(row);
        eqNum("txType", tx.type as number, row.txType);
        eqStr(`${row.name} messageHashLeHex`, txHashHex(tx, chainId), row.messageHashLeHex);

        const signed = signTx(tx, key, chainId, {
          nonce: scalarFromBytes(fromHex(row.nonceKLeHex)),
        });
        eqStr(`${row.name} signatureBytesHex`, toHex(signed.sig), row.signatureBytesHex);

        // `txInfoJson` is deliberately NOT compared: it is the empty string in every current row
        // because the Go oracle does not emit it. Comparing `"" === ""` would be theatre.
        // `toTxInfo` is gated by hand-authored goldens in `test/tx/pipeline.test.ts`.
        eqStr(`${row.name} txInfoJson is still unpopulated`, row.txInfoJson, "");
      }),
    ),
    section(
      file,
      "l1Messages",
      l1Messages.map((row: L1MessageRow): Check => (): void => {
        const [fromTemplate, fromTx] = l1BodyPair(row, chainId);
        eqStr(`${row.name} body (template)`, fromTemplate, row.body);
        // A template check alone passes with `from` and `to` swapped in the tx mapping.
        eqStr(`${row.name} body (l1MessageFor)`, fromTx, row.body);
        eqStr(`${row.name} bodyUtf8Hex`, toHex(UTF8.encode(row.body)), row.bodyUtf8Hex);

        const prefixed: Uint8Array = eip191Message(row.body);
        const expectedPrefix: Uint8Array = UTF8.encode(
          `${EIP191_PREFIX}${String(UTF8.encode(row.body).length)}`,
        );
        eqStr(
          `${row.name} eip191Message`,
          toHex(prefixed),
          toHex(expectedPrefix) + row.bodyUtf8Hex,
        );
        eqStr(
          "Keccak-256 verifier self-test",
          toHex(keccak256(new Uint8Array())),
          "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        );
        eqStr(`${row.name} eip191HashHex`, toHex(keccak256(prefixed)), row.eip191HashHex);
      }),
    ),
    section(
      file,
      "authTokens",
      authTokens.map((row: AuthTokenRow): Check => (): void => {
        const deadline: bigint = BigInt(row.deadline);
        const accountIndex: bigint = BigInt(row.accountIndex);
        const apiKeyIndex: number = Number(BigInt(row.apiKeyIndex));

        const message: string = authTokenMessage(deadline, accountIndex, apiKeyIndex);
        eqStr("message", message, row.message);
        eqStr("messageUtf8Hex", toHex(UTF8.encode(message)), row.messageUtf8Hex);

        const packed: readonly Fp[] = packAuthMessage(UTF8.encode(row.message));
        const packedStrings: readonly string[] = strings(packed);
        if (packedStrings.join(",") !== row.packedFieldElements.join(",")) {
          fail("packedFieldElements", packedStrings, row.packedFieldElements);
        }
        // The count is the padding assertion: 30 bytes must be four elements, not three-and-a-bit.
        eqNum("packed element count", packed.length, Math.ceil(row.message.length / 8));

        eqStr("messageHashLeHex", toHex(authTokenMessageHash(row.message)), row.messageHashLeHex);

        const token: string = createAuthToken(
          { accountIndex, keys: new Map<number, ApiKey>([[apiKeyIndex, key]]) },
          {
            // `deadline = timestamp + expirySeconds`, so a zero timestamp makes the two the same.
            timestamp: 0,
            expirySeconds: Number(deadline),
            maxLifetimeSeconds: Number(deadline),
            apiKeyIndex,
            sign: { nonce: scalarFromBytes(fromHex(row.nonceKLeHex)) },
          },
        );
        eqStr("token", token, row.token);
        eqStr("token signature", token.slice(row.message.length + 1), row.signatureBytesHex);
      }),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------------------------------- */

function allSections(bundle: VectorBundle): readonly Section[] {
  return [
    ...goldilocksSections(bundle),
    ...gfp5Sections(bundle),
    ...poseidon2Sections(bundle),
    ...curveSections(bundle),
    ...schnorrSections(bundle),
    ...txSections(bundle),
  ];
}

/**
 * Replay every section against `dist/`.
 *
 * Never throws for a vector mismatch — mismatches are collected into the summary so a single run
 * reports every divergence. It does throw if the bundle itself is unusable, because that is a
 * harness bug rather than a library failure and must not be reported as "1 failure".
 */
export async function runVectors(bundle: VectorBundle): Promise<RunSummary> {
  const sections: readonly Section[] = allSections(bundle);
  const failed: VectorFailure[] = [];
  const summaries: SectionSummary[] = [];
  let total = 0;

  // Declared lengths, read from the JSON through the inventory rather than from the builders.
  const declared = new Map<string, number>();
  for (const spec of INVENTORY) {
    declared.set(`${spec.file}/${spec.section}`, declaredCount(bundle, spec));
  }
  const seen = new Set<string>();

  for (const s of sections) {
    const id = `${s.file}/${s.name}`;
    const want: number | undefined = declared.get(id);
    if (want === undefined) {
      throw new Error(`section ${id} ran but is not in the inventory — update INVENTORY`);
    }
    seen.add(id);

    let executed = 0;
    let failures = 0;
    for (let i = 0; i < s.checks.length; i += 1) {
      executed += 1;
      total += 1;
      try {
        await (s.checks[i] as Check)();
      } catch (e: unknown) {
        failures += 1;
        failed.push({
          file: s.file,
          section: s.name,
          index: i,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // A section that runs fewer cases than the JSON declares is itself a failure: a silently
    // skipped section is the one bug a green harness cannot otherwise reveal.
    if (executed !== want) {
      failures += 1;
      failed.push({
        file: s.file,
        section: s.name,
        index: -1,
        detail: `executed ${String(executed)} cases but the vector file declares ${String(want)}`,
      });
    }
    summaries.push({ file: s.file, section: s.name, declared: want, executed, failures });
  }

  // And a section that did not run at all.
  for (const spec of INVENTORY) {
    const id = `${spec.file}/${spec.section}`;
    if (seen.has(id)) continue;
    const want: number = declared.get(id) ?? 0;
    failed.push({
      file: spec.file,
      section: spec.section,
      index: -1,
      detail: `section did not run; the vector file declares ${String(want)} cases`,
    });
    summaries.push({
      file: spec.file,
      section: spec.section,
      declared: want,
      executed: 0,
      failures: 1,
    });
  }

  let declaredTotal = 0;
  for (const want of declared.values()) declaredTotal += want;
  if (total !== declaredTotal) {
    failed.push({
      file: "(all)",
      section: "(total)",
      index: -1,
      detail: `executed ${String(total)} cases but the vector files declare ${String(declaredTotal)}`,
    });
  }

  return { total, failures: failed.length, failed, sections: summaries };
}

/* -------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

/** Print the per-section table and the verdict. `console.log` exists in every target runtime. */
export function reportSummary(summary: RunSummary, label: string): void {
  const lines: string[] = [`lighter-ts portability vectors — ${label}`];
  let currentFile = "";
  for (const s of summary.sections) {
    if (s.file !== currentFile) {
      currentFile = s.file;
      lines.push(`  ${s.file}`);
    }
    const status: string = s.failures === 0 ? "ok" : `${String(s.failures)} FAILED`;
    lines.push(
      `    ${s.section.padEnd(24)} ${String(s.executed).padStart(4)}/${String(s.declared).padEnd(4)} ${status}`,
    );
  }
  lines.push("");
  for (const f of summary.failed) {
    lines.push(`  FAIL ${f.file} → ${f.section}[${String(f.index)}]: ${f.detail}`);
  }
  lines.push(
    `${String(summary.total)} cases, ${String(summary.failures)} ${
      summary.failures === 1 ? "failure" : "failures"
    }`,
  );
  console.log(lines.join("\n"));
}

/**
 * Was this module executed, rather than imported?
 *
 * `import.meta.main` is the direct answer on Bun and Deno and on new enough Node; everywhere else
 * the script path in `argv[1]` is compared by file name, which is enough to keep the CLI from
 * firing when `worker.ts` imports {@link runVectors}.
 */
function isMain(): boolean {
  const meta: Record<string, unknown> = import.meta as unknown as Record<string, unknown>;
  if (typeof meta["main"] === "boolean") return meta["main"];
  const argv1: string | undefined = runtimes().process?.argv?.[1];
  if (argv1 === undefined) return false;
  const name: string = argv1.replace(/\\/g, "/").split("/").pop() ?? "";
  return name.length > 0 && import.meta.url.split("/").pop() === name;
}

/** `process.exit` and `Deno.exit` are not universal; neither is reachable on workerd. */
function exitNonZero(): void {
  const g: Runtimes = runtimes();
  if (g.process !== undefined) {
    g.process.exitCode = 1;
    return;
  }
  if (g.Deno?.exit !== undefined) g.Deno.exit(1);
}

if (isMain()) {
  const bundle: VectorBundle = await loadVectors();
  const summary: RunSummary = await runVectors(bundle);
  reportSummary(summary, runtimeName());
  if (summary.failures > 0) exitNonZero();
}
