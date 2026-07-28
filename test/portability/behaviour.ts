/**
 * The portability harness, part two: the properties that are not expressible as conformance
 * vectors, checked against the built `dist/` on every target runtime.
 *
 * `run-vectors.ts` proves the library computes the same *values* everywhere. This file proves it
 * *behaves* the same everywhere — which is a different question, and the one that actually breaks
 * across runtimes. A module that reads `globalThis.crypto` at import time works on Node and throws
 * on Cloudflare Workers. A `sign()` that returns a promise on one engine breaks every caller on the
 * others. A missing global `WebSocket` produces a helpful error or a bare `ReferenceError`
 * depending on nothing but luck. None of that is visible in a vector file.
 *
 * Same rules as `run-vectors.ts`, for the same reasons:
 *
 * - **No test framework** — not Bun's built-in runner, not Node's, not Vitest, not the JSR
 *   standard-library assertions.
 * - **No Node built-ins**, static or otherwise. This file needs no filesystem at all, so it runs on
 *   workerd unchanged and with nothing inlined.
 * - **Everything comes from `dist/`**, never `src/`.
 *
 * ## Why there is not a single runtime `import` at the top
 *
 * The first group below asserts that importing the package does nothing: no `fetch`, no
 * `WebSocket`, no timer, no `crypto.getRandomValues`, no mutated global. That can only be checked
 * if the spies are installed *before* the modules load, and a static `import` runs before any
 * statement in this file. So every import here is dynamic and inside a function, and the only
 * static imports are `import type`, which TypeScript erases entirely.
 *
 * ## Usage
 *
 * ```sh
 * bun  test/portability/behaviour.ts
 * node --experimental-strip-types test/portability/behaviour.ts
 * deno run test/portability/behaviour.ts
 * ```
 *
 * Exits non-zero on any failure. Imported instead, {@link runBehaviour} returns the summary and
 * touches no exit code — `process.exit` and `Deno.exit` do not exist on workerd.
 */

/* Type-only. Erased at compile time; nothing here loads a module. */
type CryptoModule = typeof import("../../dist/crypto/index.js");
type TxModule = typeof import("../../dist/tx/index.js");
type RestModule = typeof import("../../dist/rest/index.js");
type WsModule = typeof import("../../dist/ws/index.js");
type ErrorsModule = typeof import("../../dist/errors.js");

import type { WebSocketConstructor } from "../../dist/config/config.js";
import type { RouteDef } from "../../dist/rest/route-types.js";
import type { UnsignedTx } from "../../dist/tx/build.js";

/* -------------------------------------------------------------------------------------------------
 * Public shape
 * ---------------------------------------------------------------------------------------------- */

/**
 * One failed behavioural check.
 *
 * Deliberately *not* the `{ file, section, index }` of `run-vectors.ts`: there is no vector file and
 * no row number here, and inventing one would make the output lie about where to look.
 */
export interface BehaviourFailure {
  readonly group: string;
  readonly check: string;
  readonly detail: string;
}

export interface GroupSummary {
  readonly group: string;
  readonly total: number;
  readonly failures: number;
  readonly skipped: number;
}

export interface BehaviourSummary {
  readonly total: number;
  readonly failures: number;
  readonly failed: readonly BehaviourFailure[];
  /**
   * Checks this runtime could not perform.
   *
   * Distinct from a failure on purpose. There is exactly one of these — hiding a non-configurable
   * global `WebSocket` — and reporting it as passing would be a lie while reporting it as failing
   * would be a false alarm on a runtime that legitimately has one. It is printed either way.
   */
  readonly skipped: readonly BehaviourFailure[];
  readonly groups: readonly GroupSummary[];
}

/**
 * Every subpath in the `exports` map of `package.json`, as a path into `dist/`.
 *
 * Kept as literal specifiers so a bundler targeting workerd can still resolve them. `.` is last on
 * purpose: it re-exports everything, so importing it first would leave every other entry a cache
 * hit and the per-subpath attribution meaningless.
 */
const SUBPATHS: readonly string[] = [
  "lighter-ts/crypto",
  "lighter-ts/tx",
  "lighter-ts/rest",
  "lighter-ts/ws",
  "lighter-ts/config",
  "lighter-ts/errors",
  "lighter-ts/client",
  "lighter-ts",
];

/** The loaded modules, kept so the later groups do not re-import under a different spy regime. */
interface Loaded {
  readonly crypto: CryptoModule;
  readonly tx: TxModule;
  readonly rest: RestModule;
  readonly ws: WsModule;
  readonly errors: ErrorsModule;
}

/** The same, while it is still being filled in one subpath at a time. */
interface PartialLoaded {
  crypto?: CryptoModule;
  tx?: TxModule;
  rest?: RestModule;
  ws?: WsModule;
  errors?: ErrorsModule;
}

/* -------------------------------------------------------------------------------------------------
 * Assertions
 * ---------------------------------------------------------------------------------------------- */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function eqNum(what: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${what}: got ${String(actual)}, want ${String(expected)}`);
}

function eqBool(what: string, actual: boolean, expected: boolean): void {
  if (actual !== expected) {
    throw new Error(`${what}: got ${String(actual)}, want ${String(expected)}`);
  }
}

function eqList(what: string, actual: readonly unknown[], expected: readonly unknown[]): void {
  const a: string = JSON.stringify(actual);
  const b: string = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.constructor.name}: ${e.message}`;
  return String(e);
}

/** Run `fn` and return what it threw, or `null`. Used where a throw is the contract. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e: unknown) {
    return e;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Recorder
 * ---------------------------------------------------------------------------------------------- */

class Recorder {
  readonly #failed: BehaviourFailure[] = [];
  readonly #skipped: BehaviourFailure[] = [];
  readonly #groups = new Map<string, { total: number; failures: number; skipped: number }>();

  #bucket(group: string): { total: number; failures: number; skipped: number } {
    const existing = this.#groups.get(group);
    if (existing !== undefined) return existing;
    const fresh = { total: 0, failures: 0, skipped: 0 };
    this.#groups.set(group, fresh);
    return fresh;
  }

  async check(group: string, name: string, fn: () => void | Promise<void>): Promise<void> {
    const bucket = this.#bucket(group);
    bucket.total += 1;
    try {
      await fn();
    } catch (e: unknown) {
      bucket.failures += 1;
      this.#failed.push({ group, check: name, detail: describe(e) });
    }
  }

  /** A check this runtime cannot perform. Printed, counted, and not a failure — see the header. */
  skip(group: string, name: string, why: string): void {
    const bucket = this.#bucket(group);
    bucket.total += 1;
    bucket.skipped += 1;
    this.#skipped.push({ group, check: name, detail: why });
  }

  summary(): BehaviourSummary {
    const groups: GroupSummary[] = [];
    let total = 0;
    for (const [group, b] of this.#groups) {
      groups.push({ group, total: b.total, failures: b.failures, skipped: b.skipped });
      total += b.total;
    }
    return {
      total,
      failures: this.#failed.length,
      failed: [...this.#failed],
      skipped: [...this.#skipped],
      groups,
    };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Group 1 — importing the package does nothing
 * ---------------------------------------------------------------------------------------------- */

interface Watch {
  readonly label: string;
  readonly calls: () => number;
  readonly stillInstalled: () => boolean;
  readonly restore: () => void;
}

/**
 * Replace `host[name]` with a counting proxy.
 *
 * A `Proxy` rather than a wrapper function because two of the five watched globals are
 * constructors: `apply` and `construct` both have to be observed, and a plain arrow would break
 * `new WebSocket(...)` outright.
 */
function watch(host: object, name: string, label: string): Watch | null {
  const record = host as Record<string, unknown>;
  const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(host, name);
  const original: unknown = record[name];
  let calls = 0;

  const spy: unknown =
    typeof original === "function"
      ? new Proxy(original as (...args: unknown[]) => unknown, {
          apply(target: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[]): unknown {
            calls += 1;
            return Reflect.apply(target, thisArg, args);
          },
          construct(target: (...args: unknown[]) => unknown, args: unknown[]): object {
            calls += 1;
            return Reflect.construct(target as unknown as new (...a: unknown[]) => object, args);
          },
        })
      : // The global is absent in this runtime (Node 20 has no `WebSocket`). A stand-in still has
        // to exist, or "was it called?" is unanswerable.
        function absent(): never {
          calls += 1;
          throw new Error(`${label} was called, and this runtime does not provide it`);
        };

  try {
    Object.defineProperty(host, name, { value: spy, configurable: true, writable: true });
  } catch {
    return null;
  }

  return {
    label,
    calls: (): number => calls,
    stillInstalled: (): boolean => record[name] === spy,
    restore: (): void => {
      if (descriptor === undefined) delete record[name];
      else Object.defineProperty(host, name, descriptor);
    },
  };
}

/**
 * Install spies, import every published subpath, and assert nothing happened.
 *
 * `docs/ARCHITECTURE.md` D5 and the header of `src/index.ts` both claim the package is
 * side-effect-free at import. This is where the claim is checked rather than asserted — and it is
 * checked on every runtime, because "no randomness at module scope" only actually *matters* on
 * Cloudflare Workers, which forbids it (`docs/protocol-notes.md` §5.1).
 */
async function importPurityGroup(rec: Recorder): Promise<Loaded> {
  const group = "import purity";
  const cryptoHost: object | undefined = (globalThis as { crypto?: object }).crypto;

  const watches: Watch[] = [];
  const missing: string[] = [];
  for (const [host, name, label] of [
    [globalThis, "fetch", "fetch"],
    [globalThis, "WebSocket", "WebSocket"],
    [globalThis, "setTimeout", "setTimeout"],
    [globalThis, "setInterval", "setInterval"],
  ] as readonly [object, string, string][]) {
    const w: Watch | null = watch(host, name, label);
    if (w === null) missing.push(label);
    else watches.push(w);
  }
  if (cryptoHost === undefined) {
    missing.push("crypto.getRandomValues (no globalThis.crypto)");
  } else {
    const w: Watch | null = watch(cryptoHost, "getRandomValues", "crypto.getRandomValues");
    if (w === null) missing.push("crypto.getRandomValues");
    else watches.push(w);
  }

  // Snapshot *after* installing, so a runtime that materialises a lazy global on first read (Node
  // does this for `fetch`) does not register as a mutation caused by the import.
  const before: readonly string[] = ownKeys();

  const loaded: PartialLoaded = {};
  for (const subpath of SUBPATHS) {
    // eslint-disable-next-line no-await-in-loop -- order is the point: `.` must be imported last.
    await rec.check(group, `importing "${subpath}" calls nothing`, async (): Promise<void> => {
      switch (subpath) {
        case "lighter-ts/crypto":
          loaded.crypto = await import("../../dist/crypto/index.js");
          break;
        case "lighter-ts/tx":
          loaded.tx = await import("../../dist/tx/index.js");
          break;
        case "lighter-ts/rest":
          loaded.rest = await import("../../dist/rest/index.js");
          break;
        case "lighter-ts/ws":
          loaded.ws = await import("../../dist/ws/index.js");
          break;
        case "lighter-ts/config":
          await import("../../dist/config/index.js");
          break;
        case "lighter-ts/errors":
          loaded.errors = await import("../../dist/errors.js");
          break;
        case "lighter-ts/client":
          await import("../../dist/client/index.js");
          break;
        case "lighter-ts":
          await import("../../dist/index.js");
          break;
        default:
          throw new Error(`no import wired for ${subpath}`);
      }
      for (const w of watches) {
        if (w.calls() !== 0) {
          throw new Error(`${w.label} was called ${String(w.calls())} time(s) while loading ${subpath}`);
        }
      }
    });
  }

  const after: readonly string[] = ownKeys();

  await rec.check(group, "every watched global is spy-able on this runtime", (): void => {
    if (missing.length > 0) {
      throw new Error(
        `could not observe ${missing.join(", ")} — the purity claim is unverified here, not proven`,
      );
    }
  });

  await rec.check(group, "no global was added or removed", (): void => {
    const added: string[] = after.filter((k: string): boolean => !before.includes(k));
    const removed: string[] = before.filter((k: string): boolean => !after.includes(k));
    if (added.length > 0 || removed.length > 0) {
      throw new Error(`globalThis changed: +[${added.join(", ")}] -[${removed.join(", ")}]`);
    }
  });

  await rec.check(group, "no watched global was reassigned", (): void => {
    for (const w of watches) {
      if (!w.stillInstalled()) throw new Error(`${w.label} was replaced during import`);
    }
  });

  for (const w of watches) w.restore();

  const crypto: CryptoModule | undefined = loaded.crypto;
  const tx: TxModule | undefined = loaded.tx;
  const rest: RestModule | undefined = loaded.rest;
  const ws: WsModule | undefined = loaded.ws;
  const errors: ErrorsModule | undefined = loaded.errors;
  if (
    crypto === undefined ||
    tx === undefined ||
    rest === undefined ||
    ws === undefined ||
    errors === undefined
  ) {
    throw new Error("a published subpath failed to import; nothing further can be checked");
  }
  return { crypto, tx, rest, ws, errors };
}

function ownKeys(): readonly string[] {
  return Reflect.ownKeys(globalThis).map((k: string | symbol): string => String(k));
}

/* -------------------------------------------------------------------------------------------------
 * Group 2 — signing is synchronous
 * ---------------------------------------------------------------------------------------------- */

/** An arbitrary but fixed private key, so nothing here depends on the RNG. */
const PRIVATE_KEY_HEX =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

/** A 40-byte "hashed message". Its content is irrelevant; only the width is part of the contract. */
function sampleHash(): Uint8Array {
  const m = new Uint8Array(40);
  for (let i = 0; i < m.length; i += 1) m[i] = (i * 7 + 3) & 0xff;
  return m;
}

/**
 * `docs/decisions.md` D2 rules out any async primitive on the signing path — that is precisely why
 * the nonce is derived with Poseidon2 rather than `crypto.subtle.digest`, which is async. A
 * `Promise` here would be a design regression, not a typo, and it is worth catching on every engine
 * because an engine-specific fallback is exactly how one would sneak in.
 */
async function signingGroup(rec: Recorder, m: Loaded): Promise<void> {
  const group = "signing is synchronous";
  const key = m.crypto.ApiKey.fromPrivateKey(PRIVATE_KEY_HEX);
  const hashed: Uint8Array = sampleHash();

  await rec.check(group, "ApiKey.sign returns 80 bytes, not a Promise", (): void => {
    const sig: Uint8Array = key.sign(hashed);
    assert(sig instanceof Uint8Array, `sign returned ${describe(sig)}, not a Uint8Array`);
    eqBool("sign() instanceof Promise", (sig as unknown) instanceof Promise, false);
    assert(
      typeof (sig as unknown as { then?: unknown }).then !== "function",
      "sign() returned a thenable",
    );
    eqNum("signature width", sig.length, m.crypto.SIGNATURE_BYTES);
  });

  await rec.check(group, "the signature it produces verifies", (): void => {
    const sig: Uint8Array = key.sign(hashed);
    eqBool("verify(sign(m))", m.crypto.verify(key.publicKeyBytes, hashed, sig), true);
  });

  await rec.check(group, "the default nonce is hedged, so two signatures differ", (): void => {
    const a: Uint8Array = key.sign(hashed);
    const b: Uint8Array = key.sign(hashed);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i += 1) same = a[i] === b[i];
    eqBool("two hedged signatures are identical", same, false);
  });

  await rec.check(group, "signTx returns a value, not a Promise", (): void => {
    const unsigned: UnsignedTx = m.tx.buildCreateOrder(
      {
        marketIndex: m.tx.i16(1),
        clientOrderIndex: m.tx.i64(100),
        baseAmount: m.tx.i64(1_000_000),
        price: m.tx.u32(250_000),
        isAsk: m.tx.u8(0),
        orderType: m.tx.u8(0),
        timeInForce: m.tx.u8(1),
        reduceOnly: m.tx.u8(0),
        triggerPrice: m.tx.u32(0),
        orderExpiry: m.tx.i64(1_893_456_000_000n),
      },
      {
        accountIndex: m.tx.i64(1),
        apiKeyIndex: m.tx.u8(0),
        nonce: m.tx.i64(42),
        expiredAt: m.tx.i64(1_893_456_000_000n),
      },
    );
    const signed = m.tx.signTx(unsigned, key, m.tx.CHAIN_ID.mainnet);
    eqBool("signTx() instanceof Promise", (signed as unknown) instanceof Promise, false);
    assert(signed.sig instanceof Uint8Array, "signTx().sig is not a Uint8Array");
    eqNum("signature width", signed.sig.length, m.crypto.SIGNATURE_BYTES);
  });

  await rec.check(group, "ApiKey.generate is available and its key signs synchronously", (): void => {
    const fresh = m.crypto.ApiKey.generate();
    const sig: Uint8Array = fresh.sign(hashed);
    eqBool("generated key sign() instanceof Promise", (sig as unknown) instanceof Promise, false);
    eqBool("generated key verifies", m.crypto.verify(fresh.publicKeyBytes, hashed, sig), true);
  });
}

/* -------------------------------------------------------------------------------------------------
 * Group 3 — verify() is total, and rejects the neutral public key
 * ---------------------------------------------------------------------------------------------- */

/**
 * `docs/decisions.md` D1: the neutral public key is a **universal forgery** — pick any `s`, set
 * `R = [s]G` and `e = H(encode(R) ‖ m)`, and the pair verifies against `pk = 0`. Its rejection is
 * unconditional and takes no opt-out flag.
 *
 * The forgery is constructed here rather than described, and the check that it *would* succeed
 * without the guard is part of the group: otherwise "verify returns false" could be passing for
 * some unrelated reason and nobody would know the guard had been deleted.
 */
async function verifyGroup(rec: Recorder, m: Loaded): Promise<void> {
  const group = "verify() is total";
  const c: CryptoModule = m.crypto;
  const hashBytes: Uint8Array = sampleHash();
  const hashed = c.fp5FromBytes(hashBytes);

  const s: bigint = c.modN(12_345_678_901_234_567_890_123_456_789n);
  const forgedE: bigint = c.challenge(c.encodePoint(c.mulGenerator(s)), hashed);
  const forgedSig: Uint8Array = c.signatureToBytes({ s, e: forgedE });
  const neutralPk: Uint8Array = c.fp5ToBytes(c.encodePoint(c.NEUTRAL));

  await rec.check(group, "verify takes no options parameter (D1 has no opt-out)", (): void => {
    eqNum("verify.length", c.verify.length, 3);
  });

  await rec.check(group, "the neutral public key really is a forgery", (): void => {
    // Reconstruct exactly what a verifier does: R' = [s]G (+) [e]·pk, with pk the neutral element.
    const reconstructed = c.mulAddG(c.NEUTRAL, s, forgedE);
    eqBool(
      "the forged challenge round-trips",
      c.challenge(c.encodePoint(reconstructed), hashed) === forgedE,
      true,
    );
    eqBool("the neutral key encodes to 40 zero bytes", neutralPk.every((b: number): boolean => b === 0), true);
  });

  await rec.check(group, "verify rejects it anyway", (): void => {
    eqBool("verify(neutral, m, forged)", c.verify(neutralPk, hashBytes, forgedSig), false);
  });

  // Every malformed shape returns `false`. Throwing would turn a hostile input into a crash in
  // whatever loop is verifying, which is a denial of service rather than a safety feature.
  const validKey = c.ApiKey.fromPrivateKey(PRIVATE_KEY_HEX);
  const validPk: Uint8Array = validKey.publicKeyBytes;
  const validSig: Uint8Array = validKey.sign(hashBytes);

  /** The first `w` for which `decodePoint` fails, found rather than hard-coded. */
  function undecodableKey(): Uint8Array {
    for (let i = 1n; i < 64n; i += 1n) {
      const w = c.fp5FromLimbs([i, 0n, 0n, 0n, 0n]);
      if (c.decodePoint(w) === null) return c.fp5ToBytes(w);
    }
    throw new Error("no undecodable point encoding found in the first 64 candidates");
  }

  const malformed: readonly (readonly [string, Uint8Array, Uint8Array, Uint8Array])[] = [
    ["empty public key", new Uint8Array(0), hashBytes, validSig],
    ["short public key", new Uint8Array(39), hashBytes, validSig],
    ["long public key", new Uint8Array(41), hashBytes, validSig],
    ["all-0xff public key", new Uint8Array(40).fill(0xff), hashBytes, validSig],
    ["undecodable public key", undecodableKey(), hashBytes, validSig],
    ["empty message", validPk, new Uint8Array(0), validSig],
    ["short message", validPk, new Uint8Array(39), validSig],
    ["long message", validPk, new Uint8Array(41), validSig],
    ["short signature", validPk, hashBytes, new Uint8Array(79)],
    ["long signature", validPk, hashBytes, new Uint8Array(81)],
    ["all-0xff signature (both scalars out of range)", validPk, hashBytes, new Uint8Array(80).fill(0xff)],
  ];

  for (const [label, pk, msg, sig] of malformed) {
    await rec.check(group, `${label}: false, never a throw`, (): void => {
      let got: boolean;
      try {
        got = c.verify(pk, msg, sig);
      } catch (e: unknown) {
        throw new Error(`verify threw ${describe(e)} instead of returning false`);
      }
      eqBool("verify", got, false);
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Group 4 — reconnect backoff is deterministic under an injected random and clock
 * ---------------------------------------------------------------------------------------------- */

/**
 * The delay schedule must be a pure function of `(attempt, close class, injected random)`. If any
 * engine's `Math.random` leaks into it, the sequence below diverges and every reconnect test in the
 * suite becomes runtime-dependent.
 */
async function backoffGroup(rec: Recorder, m: Loaded): Promise<void> {
  const group = "reconnect backoff is deterministic";
  const options = {
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    maxAttempts: 8,
    stableAfterMs: 10_000,
    random: (): number => 0.25,
  };
  const network = m.ws.classifyCloseCode(1006);

  await rec.check(group, "1006 classifies as a reconnectable network close", (): void => {
    eqList(
      "classifyCloseCode(1006)",
      [network.cls, network.reconnect, network.minDelayMs],
      ["network", true, 0],
    );
  });

  await rec.check(group, "a client-initiated 1000 does not reconnect", (): void => {
    const c = m.ws.classifyCloseCode(1000, { clientInitiated: true });
    eqList("classifyCloseCode(1000)", [c.cls, c.reconnect], ["client-initiated", false]);
  });

  await rec.check(group, "the delay schedule is exactly the pinned sequence", (): void => {
    const controller = new m.ws.BackoffController(options);
    const seq: (number | null)[] = [];
    for (let i = 0; i < 9; i += 1) seq.push(controller.nextDelayMs(network));
    // Doubling from `baseDelayMs * random`, capped at `maxDelayMs * random`, then `null` once
    // `maxAttempts` is spent. A runtime-dependent jitter source cannot reproduce this.
    eqList("delays", seq, [25, 50, 100, 200, 400, 800, 1250, 1250, null]);
  });

  await rec.check(group, "two controllers with the same seed agree", (): void => {
    const a = new m.ws.BackoffController(options);
    const b = new m.ws.BackoffController(options);
    const seqA: (number | null)[] = [];
    const seqB: (number | null)[] = [];
    for (let i = 0; i < 9; i += 1) seqA.push(a.nextDelayMs(network));
    for (let i = 0; i < 9; i += 1) seqB.push(b.nextDelayMs(network));
    eqList("independent controllers", seqA, seqB);
  });

  await rec.check(group, "an injected clock drives the stability reset", (): void => {
    const c = new m.ws.BackoffController(options);
    c.nextDelayMs(network);
    c.nextDelayMs(network);
    eqNum("attempt after two delays", c.attempt, 2);

    // Open long enough to count as stable, then close: the counter resets and the ladder restarts.
    c.noteOpen(1_000);
    c.noteClose(1_000 + 20_000);
    eqNum("attempt after a stable session", c.attempt, 0);
    eqNum("next delay after a stable session", c.nextDelayMs(network) ?? -1, 25);

    // A short session is not stable, so the ladder keeps climbing.
    const d = new m.ws.BackoffController(options);
    d.nextDelayMs(network);
    d.nextDelayMs(network);
    d.noteOpen(1_000);
    d.noteClose(1_500);
    eqNum("attempt after a brief session", d.attempt, 2);
    eqNum("next delay after a brief session", d.nextDelayMs(network) ?? -1, 100);
  });
}

/* -------------------------------------------------------------------------------------------------
 * Group 5 — a runtime with no global WebSocket
 * ---------------------------------------------------------------------------------------------- */

/**
 * Hide `globalThis.WebSocket` for the duration of a check, and return how to put it back.
 *
 * `delete` is not enough. On workerd `WebSocket` is not an own property of the global object at
 * all — it is reached through the prototype, so `delete globalThis.WebSocket` returns `true` and
 * changes nothing. Shadowing with an own `undefined` works there and everywhere else, and matches
 * exactly what the transport tests for (`globalThis.WebSocket === undefined`).
 *
 * Returns `null` when the global cannot be hidden, so the caller can say "unverified here" rather
 * than assert against a runtime that still has one.
 */
function hideWebSocket(): (() => void) | null {
  const own: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket",
  );
  if ((globalThis as { WebSocket?: unknown }).WebSocket === undefined) {
    // Genuinely absent — Node 20. Nothing to hide, and nothing to restore.
    return (): void => {
      /* nothing was changed */
    };
  }
  try {
    Object.defineProperty(globalThis, "WebSocket", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  } catch {
    return null;
  }
  if ((globalThis as { WebSocket?: unknown }).WebSocket !== undefined) return null;
  return own === undefined
    ? (): void => {
        Reflect.deleteProperty(globalThis, "WebSocket");
      }
    : (): void => {
        Object.defineProperty(globalThis, "WebSocket", own);
      };
}

/**
 * Risk R20. Node 20 has no global `WebSocket`, so `new WebSocket(url)` inside the transport would
 * be a bare `ReferenceError` naming nothing a caller can act on. The contract is a typed
 * `LighterWsError` that names the fix, and it is checked on *every* runtime by hiding the global
 * — on Bun, Node 22+, Deno and workerd the global exists, so the Node-20 path would otherwise never
 * run anywhere except Node 20 itself.
 */
async function noWebSocketGroup(rec: Recorder, m: Loaded): Promise<void> {
  const group = "no global WebSocket";
  const url = "wss://example.invalid/stream";

  const restore: (() => void) | null = hideWebSocket();
  if (restore === null) {
    // Not a failure: this runtime demonstrably *has* a `WebSocket`, so the Node-20 path is
    // unreachable here. Reported as unverified rather than quietly counted as passing.
    rec.skip(
      group,
      "hide globalThis.WebSocket",
      "the global could not be hidden on this runtime, so R20 is unverified here",
    );
    return;
  }

  try {
    const cases: readonly (readonly [string, () => unknown])[] = [
      ["WsTransport.connect()", (): unknown => new m.ws.WsTransport({ url }).connect()],
      [
        "LighterWsClient.connect()",
        (): unknown => new m.ws.LighterWsClient({ url, autoConnect: false }).connect(),
      ],
    ];

    for (const [label, run] of cases) {
      await rec.check(group, `${label} throws a typed, fix-naming error`, (): void => {
        const e: unknown = caught(run);
        assert(e !== null, `${label} did not throw`);
        assert(
          e instanceof m.ws.LighterWsError,
          `${label} threw ${describe(e)}, not a LighterWsError`,
        );
        assert(
          !(e instanceof ReferenceError) && !(e instanceof TypeError),
          `${label} threw a bare ${describe(e)}`,
        );
        const message: string = (e as Error).message;
        assert(
          message.includes("pass { WebSocket }"),
          `the error does not name the fix: ${JSON.stringify(message)}`,
        );
        assert(
          message.includes("Node 20"),
          `the error does not name the affected runtime: ${JSON.stringify(message)}`,
        );
      });
    }

    await rec.check(group, "the fix the error names actually works", (): void => {
      // A constructor that satisfies the injected seam without opening anything. If this throws,
      // the advice in the error message is wrong, which is worse than no advice.
      const injected = class Stub {
        readonly readyState = 0;
        send(): void {
          /* never reached */
        }
        close(): void {
          /* never reached */
        }
        addEventListener(): void {
          /* the transport registers handlers and then waits forever */
        }
      } as unknown as WebSocketConstructor;

      const transport = new m.ws.WsTransport({ url, WebSocket: injected });
      const e: unknown = caught((): unknown => {
        const pending: Promise<void> = transport.connect();
        pending.catch((): void => {
          /* nothing ever opens this socket; the rejection is expected on teardown */
        });
        return pending;
      });
      assert(e === null, `connect() with an injected constructor threw ${describe(e)}`);
      void transport.close().catch((): void => {
        /* ignore */
      });
    });
  } finally {
    restore();
  }

  await rec.check(group, "the global is back afterwards", (): void => {
    // The harness must not leave the runtime altered for whatever runs next.
    eqBool(
      "globalThis.WebSocket restored",
      (globalThis as { WebSocket?: unknown }).WebSocket !== undefined,
      RUNTIME_HAS_WEBSOCKET,
    );
  });
}

/** Whether this runtime provided a global `WebSocket` before the harness touched anything. */
const RUNTIME_HAS_WEBSOCKET: boolean =
  (globalThis as { WebSocket?: unknown }).WebSocket !== undefined;

/* -------------------------------------------------------------------------------------------------
 * Group 6 — REST cancellation and timeouts
 * ---------------------------------------------------------------------------------------------- */

interface FetchStub {
  readonly calls: (AbortSignal | undefined)[];
  readonly fetch: typeof globalThis.fetch;
}

/**
 * A `fetch` that honours its signal and otherwise never settles.
 *
 * Honouring the signal matters for portability: `AbortSignal.timeout` is unref'd on Node, so a stub
 * that ignores aborts leaves the event loop empty and the process exits before the library's own
 * timeout can fire. A real `fetch` rejects on abort, and so does this.
 */
function hangingFetch(): FetchStub {
  const calls: (AbortSignal | undefined)[] = [];
  const fetchLike = (_input: unknown, init?: { signal?: AbortSignal | null }): Promise<Response> => {
    const signal: AbortSignal | undefined = init?.signal ?? undefined;
    calls.push(signal);
    return new Promise<Response>((_resolve, reject): void => {
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal.addEventListener("abort", (): void => {
        reject(signal.reason as Error);
      });
    });
  };
  return { calls, fetch: fetchLike as unknown as typeof globalThis.fetch };
}

function respondingFetch(body: unknown): FetchStub {
  const calls: (AbortSignal | undefined)[] = [];
  const fetchLike = (_input: unknown, init?: { signal?: AbortSignal | null }): Promise<Response> => {
    calls.push(init?.signal ?? undefined);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { calls, fetch: fetchLike as unknown as typeof globalThis.fetch };
}

/**
 * A guard timer, so a hung request fails the check instead of hanging the harness.
 *
 * It also keeps the event loop alive on Node, where `AbortSignal.timeout` alone does not.
 */
async function withinBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject): void => {
    handle = setTimeout((): void => {
      reject(new Error(`the harness guard fired after ${String(ms)} ms — the request never settled`));
    }, ms);
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

async function restGroup(rec: Recorder, m: Loaded): Promise<void> {
  const group = "REST cancellation and timeouts";
  const route: RouteDef = m.rest.routes.orderBooks as RouteDef;

  await rec.check(group, "a composed AbortSignal reaches the injected fetch", async (): Promise<void> => {
    const stub: FetchStub = respondingFetch({ code: 200, order_books: [] });
    await withinBudget(2_000, (): Promise<unknown> =>
      m.rest.request(route, undefined, { fetch: stub.fetch }),
    );
    eqNum("fetch calls", stub.calls.length, 1);
    const signal: AbortSignal | undefined = stub.calls[0];
    if (!(signal instanceof AbortSignal)) {
      throw new Error(`fetch received ${describe(signal)}, not an AbortSignal`);
    }
    eqBool("the composed signal starts unaborted", signal.aborted, false);
  });

  await rec.check(group, "a caller's abort propagates and is not retried", async (): Promise<void> => {
    const controller = new AbortController();
    const stub: FetchStub = hangingFetch();
    const pending: Promise<unknown> = m.rest.request(route, undefined, {
      fetch: stub.fetch,
      signal: controller.signal,
      sleep: async (): Promise<void> => {
        /* no real delay: a retry here would be the bug */
      },
    });
    controller.abort();
    const e: unknown = await withinBudget(2_000, async (): Promise<unknown> => {
      try {
        await pending;
        return null;
      } catch (err: unknown) {
        return err;
      }
    });
    assert(e !== null, "an aborted request resolved");
    assert(
      e instanceof m.errors.LighterTransportError,
      `aborting produced ${describe(e)}, not a LighterTransportError`,
    );
    // A caller's cancellation is not a timeout, and must not be reported as one.
    eqBool(
      "aborting produced a LighterTimeoutError",
      e instanceof m.errors.LighterTimeoutError,
      false,
    );
    eqNum("fetch calls after an abort", stub.calls.length, 1);
  });

  await rec.check(group, "an already-aborted signal fails immediately", async (): Promise<void> => {
    const stub: FetchStub = hangingFetch();
    const e: unknown = await withinBudget(2_000, async (): Promise<unknown> => {
      try {
        await m.rest.request(route, undefined, {
          fetch: stub.fetch,
          signal: AbortSignal.abort(),
        });
        return null;
      } catch (err: unknown) {
        return err;
      }
    });
    assert(e !== null, "a pre-aborted request resolved");
    assert(
      e instanceof m.errors.LighterTransportError,
      `a pre-aborted request produced ${describe(e)}`,
    );
  });

  await rec.check(group, "a fetch that never settles times out inside the budget", async (): Promise<void> => {
    const stub: FetchStub = hangingFetch();
    const e: unknown = await withinBudget(3_000, async (): Promise<unknown> => {
      try {
        await m.rest.request(route, undefined, {
          fetch: stub.fetch,
          timeoutMs: 30,
          retry: { attempts: 1 },
          sleep: async (): Promise<void> => {
            /* the backoff itself is not what is under test */
          },
        });
        return null;
      } catch (err: unknown) {
        return err;
      }
    });
    assert(e !== null, "a never-settling request resolved");
    assert(
      e instanceof m.errors.LighterTimeoutError,
      `a never-settling request produced ${describe(e)}, not a LighterTimeoutError`,
    );
    // A timeout is retryable, so the whole budget is spent: one attempt plus one retry.
    eqNum("fetch calls", stub.calls.length, 2);
  });
}

/* -------------------------------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------------------------------- */

/**
 * Run every behavioural group.
 *
 * The import-purity group runs first and is the reason nothing above it may touch `dist/`: once a
 * module is in the runtime's cache, "does importing it call `fetch`?" can never be asked again in
 * this process.
 */
export async function runBehaviour(): Promise<BehaviourSummary> {
  const rec = new Recorder();
  const loaded: Loaded = await importPurityGroup(rec);
  await signingGroup(rec, loaded);
  await verifyGroup(rec, loaded);
  await backoffGroup(rec, loaded);
  await noWebSocketGroup(rec, loaded);
  await restGroup(rec, loaded);
  return rec.summary();
}

/* -------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

interface Runtimes {
  readonly Bun?: { version?: string };
  readonly Deno?: { version?: { deno?: string }; exit?: (code: number) => never };
  readonly process?: { argv?: readonly string[]; versions?: Record<string, string | undefined>; exitCode?: number };
  readonly navigator?: { userAgent?: string };
}

function runtimes(): Runtimes {
  return globalThis as unknown as Runtimes;
}

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

export function reportBehaviour(summary: BehaviourSummary, label: string): void {
  const lines: string[] = [`lighter-ts portability behaviour — ${label}`];
  for (const g of summary.groups) {
    const parts: string[] = [];
    if (g.failures > 0) parts.push(`${String(g.failures)} FAILED`);
    if (g.skipped > 0) parts.push(`${String(g.skipped)} skipped`);
    lines.push(
      `  ${g.group.padEnd(34)} ${String(g.total).padStart(3)} ${parts.length === 0 ? "ok" : parts.join(", ")}`,
    );
  }
  lines.push("");
  for (const s of summary.skipped) {
    lines.push(`  SKIP ${s.group} → ${s.check}: ${s.detail}`);
  }
  for (const f of summary.failed) {
    lines.push(`  FAIL ${f.group} → ${f.check}: ${f.detail}`);
  }
  const skippedNote: string =
    summary.skipped.length === 0 ? "" : `, ${String(summary.skipped.length)} skipped`;
  lines.push(
    `${String(summary.total)} checks, ${String(summary.failures)} ${
      summary.failures === 1 ? "failure" : "failures"
    }${skippedNote}`,
  );
  console.log(lines.join("\n"));
}

/** See `run-vectors.ts`: `import.meta.main` where it exists, the script's file name otherwise. */
function isMain(): boolean {
  const meta: Record<string, unknown> = import.meta as unknown as Record<string, unknown>;
  if (typeof meta["main"] === "boolean") return meta["main"];
  const argv1: string | undefined = runtimes().process?.argv?.[1];
  if (argv1 === undefined) return false;
  const name: string = argv1.replace(/\\/g, "/").split("/").pop() ?? "";
  return name.length > 0 && import.meta.url.split("/").pop() === name;
}

/** Neither `process.exit` nor `Deno.exit` exists everywhere; on workerd neither does. */
function exitNonZero(): void {
  const g: Runtimes = runtimes();
  if (g.process !== undefined) {
    g.process.exitCode = 1;
    return;
  }
  if (g.Deno?.exit !== undefined) g.Deno.exit(1);
}

if (isMain()) {
  const summary: BehaviourSummary = await runBehaviour();
  reportBehaviour(summary, runtimeName());
  if (summary.failures > 0) exitNonZero();
}
