/**
 * What a caller holds after a transaction has been handed to the sequencer, and how it learns what
 * happened next.
 *
 * A receipt is **not** a fill and not even a commitment: `code == 200` on `sendTx` means
 * *accepted for sequencing* (`docs/spec/07-high-level-client.md` §5.2). Execution is a later,
 * separate event, which is why {@link TxReceipt.wait} exists and why nothing here is named
 * `confirmed`.
 *
 * ## Three things this file is careful about
 *
 * **The hash is ours, not theirs.** The digest computed locally *is* the transaction hash — if the
 * server had derived a different one the signature would not verify (§5.1). So a receipt is
 * meaningful the moment the transaction is signed, and the server's echo is only ever a free
 * end-to-end integrity check. {@link assertTxHashMatch} performs that check; it is the caller of
 * this module, `./submit.ts`, that decides when.
 *
 * **One normalisation, stated once.** `txHashHex()` in `src/tx/` returns 80 lowercase hex
 * characters with **no** `0x`; the API echoes something that may or may not carry a prefix and may
 * or may not be lowercase; {@link TxReceipt.txHash} is typed `` `0x${string}` ``. Everything
 * crossing this boundary goes through {@link normalizeTxHash}, and every comparison goes through
 * {@link txHashesEqual}. A naive `===` between the two spellings fails on every transaction.
 *
 * **`event_info` is a JSON document carried as a string, and it is parsed lazily.** Block and
 * account listings return these by the hundred and most callers read none of them, so
 * {@link TxResult.eventInfo} is a memoised getter that runs `JSON.parse` on first access and never
 * before. This is where `createPublicPool().wait()` gets the new pool's account index from
 * (§2.5).
 *
 * ## Polling
 *
 * `wait()` polls `GET /api/v1/tx?by=hash`, seeding its first delay from
 * `predicted_execution_time_ms` — the sequencer's own estimate, and the right input for an adaptive
 * interval (§5.6) — and doubling from there up to a cap. `setTimeout` only: never a repeating
 * timer, which a Cloudflare Durable Object cannot hibernate through.
 *
 * No Node built-ins, no module-level mutable state, no clock read at import.
 */

import {
  ERR_NOT_FOUND,
  ERR_TX_NOT_FOUND,
  LighterTimeoutError,
  LighterTransportError,
  LighterValidationError,
} from "../errors.js";
import type { EnrichedTx } from "../models/transaction.js";

/* ---------------------------------------------------------------------------------------------- */
/* Hash normalisation — one spelling, chosen here                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** A transaction hash is a 40-byte digest: 80 hex characters. */
const TX_HASH_HEX_CHARS: 80 = 80;

/** Anything that is 80 hex characters, with or without a `0x`, in either case. */
const TX_HASH_PATTERN: RegExp = /^(?:0x)?[0-9a-fA-F]{80}$/;

/**
 * The canonical spelling used by {@link TxReceipt.txHash}: `0x` followed by 80 **lowercase** hex
 * characters.
 *
 * The SDK's own `txHashHex()` emits the same 80 characters with no prefix, and the API echoes
 * either form; picking one spelling at this boundary is what keeps every downstream comparison a
 * plain string equality.
 *
 * @throws {LighterValidationError} `TX_HASH_MALFORMED` if the input is not 80 hex characters. A
 * hash that is the wrong length is never "close enough": it names a different transaction, or it
 * is not a transaction hash at all.
 */
export function normalizeTxHash(hash: string): `0x${string}` {
  if (typeof hash !== "string" || !TX_HASH_PATTERN.test(hash)) {
    throw new LighterValidationError(
      "TX_HASH_MALFORMED",
      `a transaction hash is ${String(TX_HASH_HEX_CHARS)} hex characters, optionally 0x-prefixed; ` +
        `received ${String(typeof hash === "string" ? `${String(hash.length)} characters` : typeof hash)}`,
      { field: "tx_hash" },
    );
  }
  const bare: string = hash.startsWith("0x") ? hash.slice(2) : hash;
  return `0x${bare.toLowerCase()}`;
}

/**
 * Compare two transaction hashes case-insensitively and prefix-insensitively.
 *
 * Total: a malformed input is simply unequal rather than an exception, because this predicate is
 * used to *detect* a malformed echo and must not itself be the thing that throws.
 */
export function txHashesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left: string = (a.startsWith("0x") ? a.slice(2) : a).toLowerCase();
  const right: string = (b.startsWith("0x") ? b.slice(2) : b).toLowerCase();
  return left.length === TX_HASH_HEX_CHARS && left === right;
}

/**
 * Assert that the server echoed the hash we computed.
 *
 * Free, and worth doing on every transaction: the two values are derived independently — ours from
 * the fields we signed, theirs from the fields they parsed — so a mismatch means the document that
 * reached the sequencer is not the document we signed. That can only end as a rejected signature,
 * and finding out here names both hashes instead of leaving a bare "invalid signature" from the
 * far end.
 *
 * An **absent** echo is not an error: `RespSendTx.tx_hash` is `omitempty` on a Go server, and the
 * WS ack shape is not published at all (`docs/spec/06-websocket.md` §8.3). The local hash is
 * authoritative in both cases.
 *
 * @throws {LighterValidationError} `TX_HASH_MISMATCH`, naming both hashes.
 */
export function assertTxHashMatch(local: string, echoed: string | undefined): void {
  if (echoed === undefined || echoed === "") return;
  if (txHashesEqual(local, echoed)) return;
  throw new LighterValidationError(
    "TX_HASH_MISMATCH",
    `the server returned transaction hash ${echoed} but this transaction hashes to ${normalizeTxHash(local)}. ` +
      `The locally computed digest is the transaction hash — a different one means the document the ` +
      `sequencer parsed is not the document that was signed`,
    { field: "tx_hash" },
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Results                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The transaction as the chain recorded it, once `GET /api/v1/tx?by=hash` returns one.
 *
 * `tx` is the raw response, untouched, so nothing here has to keep up with fields the API adds.
 * {@link eventInfo} is the decoded `event_info` document and is the reason most callers await at
 * all.
 */
export interface TxResult {
  /** `0x` + 80 lowercase hex. The same value as {@link TxReceipt.txHash}. */
  readonly txHash: `0x${string}`;
  /** The sequencer's status code for the transaction, when it reported one. */
  readonly status: number | undefined;
  /** Epoch milliseconds; absent until the transaction has actually executed. */
  readonly executedAtMs: number | undefined;
  /** The `GET /api/v1/tx` response, verbatim. */
  readonly tx: EnrichedTx;
  /**
   * The decoded `event_info` document — the new pool's account index after `createPublicPool`, and
   * so on.
   *
   * Parsed on **first access** and memoised: it is a JSON string on the wire, most callers never
   * read it, and a failed parse must not fail a `wait()` that succeeded.
   *
   * `undefined` when the response carried no `event_info`.
   *
   * @throws {LighterValidationError} `EVENT_INFO_MALFORMED` if the field is present but is not JSON.
   */
  readonly eventInfo: unknown;
}

/**
 * Build a {@link TxResult} whose `eventInfo` is a lazily parsed, memoised getter.
 *
 * `Object.defineProperty` rather than a class: the laziness is the only behaviour, and a getter on
 * a frozen literal keeps the value a plain data object for anyone who logs it.
 */
function toResult(txHash: `0x${string}`, tx: EnrichedTx): TxResult {
  let parsed: unknown;
  let done: boolean = false;
  const result: Omit<TxResult, "eventInfo"> = {
    txHash,
    status: tx.status,
    executedAtMs: tx.executed_at,
    tx,
  };
  Object.defineProperty(result, "eventInfo", {
    get(): unknown {
      if (done) return parsed;
      done = true;
      const raw: string | undefined = tx.event_info;
      if (raw === undefined || raw === "") return (parsed = undefined);
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (cause: unknown) {
        throw new LighterValidationError(
          "EVENT_INFO_MALFORMED",
          "the transaction's event_info is not valid JSON",
          { field: "event_info", cause },
        );
      }
      return parsed;
    },
    enumerable: true,
    configurable: true,
  });
  return Object.freeze(result) as TxResult;
}

/* ---------------------------------------------------------------------------------------------- */
/* Receipts                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Lower bound on the first poll delay. A prediction of `0` must not become a spin loop. */
const MIN_POLL_DELAY_MS: 50 = 50;

/** Upper bound on any single poll delay, however far the backoff has run. */
const MAX_POLL_DELAY_MS: 5_000 = 5_000;

/** Default budget for {@link TxReceipt.wait}. */
const DEFAULT_WAIT_TIMEOUT_MS: 30_000 = 30_000;

/** Backoff factor between polls. */
const POLL_BACKOFF: 2 = 2;

/** Domain codes that mean "not in the index yet", i.e. keep polling rather than fail. */
const PENDING_CODES: ReadonlySet<number> = new Set<number>([ERR_TX_NOT_FOUND, ERR_NOT_FOUND]);

/** Per-call overrides for {@link TxReceipt.wait}. */
export interface WaitOptions {
  /** Total budget. Default `30_000`. */
  readonly timeoutMs?: number;
  /** Caller cancellation. Aborting rejects; it does not resolve with a partial result. */
  readonly signal?: AbortSignal;
  /**
   * Fixed poll interval, overriding the adaptive one seeded from `predicted_execution_time_ms`.
   * For tests and for callers who know their own latency better than the sequencer's estimate.
   */
  readonly pollIntervalMs?: number;
}

/**
 * The handle returned by every submission.
 *
 * Every field is known **locally** at signing time except the three the server reports, so a
 * receipt exists even when the response was lost — which is exactly when a caller needs the hash.
 */
export interface TxReceipt {
  /** `0x` + 80 lowercase hex; see {@link normalizeTxHash}. */
  readonly txHash: `0x${string}`;
  /** The `tx_type` discriminant that was submitted. */
  readonly txType: number;
  /** The exact `tx_info` document that was submitted, as the string that went on the wire. */
  readonly txInfo: string;
  /** The nonce this transaction was signed with. */
  readonly nonce: bigint;
  /** The API key index this transaction was signed with. */
  readonly apiKeyIndex: number;
  /** The sequencer's execution estimate in ms, or `0` when it reported none. */
  readonly predictedExecutionTimeMs: number;
  /** Remaining volume quota, as `bigint` — it is an `int64` (risk R9). `0n` when not reported. */
  readonly volumeQuotaRemaining: bigint;
  /**
   * Poll `GET /api/v1/tx?by=hash` until the transaction appears, then decode it.
   *
   * The first delay is seeded from {@link predictedExecutionTimeMs} and doubles up to a 5 s cap.
   * A "not found" answer is not a failure — it is the expected answer before execution — so it is
   * polled through; any other API error propagates immediately.
   *
   * @throws {LighterTimeoutError} the budget elapsed with no result. The transaction may still
   * land: a timeout here says nothing about its fate.
   * @throws {LighterTransportError} the caller's signal aborted.
   */
  wait(opts?: WaitOptions): Promise<TxResult>;
}

/** The single REST operation a receipt needs, structurally: `LighterRestClient` satisfies it. */
export interface ReceiptTransport {
  readonly transaction: {
    tx(
      params: { by: "hash" | "sequence_index"; value: string },
      opts?: { signal?: AbortSignal },
    ): Promise<EnrichedTx>;
  };
}

/** Everything {@link createReceipt} needs that is not on the receipt itself. */
export interface ReceiptDeps {
  readonly rest: ReceiptTransport;
  /** Injected clock, ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected sleep. Defaults to a `setTimeout`-backed, signal-cancellable delay. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The locally known half of a receipt — everything except what the server said. */
export interface ReceiptFields {
  /** The local hash, in either spelling; normalised on the way in. */
  readonly txHash: string;
  readonly txType: number;
  readonly txInfo: string;
  readonly nonce: bigint;
  readonly apiKeyIndex: number;
  readonly predictedExecutionTimeMs?: number | undefined;
  readonly volumeQuotaRemaining?: number | bigint | string | undefined;
}

/**
 * `setTimeout`-backed delay, cancellable by a signal, with the handle always cleared.
 *
 * Never a repeating timer: a Durable Object cannot hibernate while one is live, and this package is
 * expected to run inside one.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
    if (signal !== undefined && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const handle: ReturnType<typeof setTimeout> = setTimeout((): void => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(handle);
      reject(abortError(signal));
    }
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The caller's own abort, as a typed error the nonce classifier reads as `indeterminate`. */
function abortError(signal: AbortSignal | undefined): LighterTransportError {
  return new LighterTransportError("the caller aborted while waiting for the transaction", {
    retryable: false,
    ...(signal !== undefined && signal.reason !== undefined ? { cause: signal.reason } : {}),
  });
}

/**
 * Read a count that is an `int64` on the wire.
 *
 * `JSON.parse` has already turned it into a `number` by the time it reaches us, so a value above
 * 2^53 arrived rounded — that loss belongs to the transport and cannot be undone here. What this
 * does guarantee is that no *further* precision is lost: the conversion is `BigInt` on an exact
 * integer, never arithmetic on a float, and a string form (should the API ever emit one) is taken
 * verbatim. Risk R9.
 */
function toCount(value: number | bigint | string | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
  }
  return Number.isSafeInteger(value) ? BigInt(value) : 0n;
}

/** The domain code carried by a thrown API error, if it has one. */
function codeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as Record<string, unknown>)["code"];
  return typeof code === "number" ? code : undefined;
}

/**
 * Whether this response is the transaction, or merely the API saying "not yet".
 *
 * A `GET /api/v1/tx` for an unknown hash answers with a *successful* envelope carrying no `hash` on
 * some deployments and with `code: 21500` on others, so both are treated as "keep polling".
 */
function isFound(tx: EnrichedTx): boolean {
  return tx.hash !== undefined && tx.hash !== "";
}

/**
 * Build a receipt.
 *
 * Pure: no clock is read and no timer scheduled until {@link TxReceipt.wait} is called.
 */
export function createReceipt(fields: ReceiptFields, deps: ReceiptDeps): TxReceipt {
  const txHash: `0x${string}` = normalizeTxHash(fields.txHash);
  const sleep: (ms: number, signal?: AbortSignal) => Promise<void> = deps.sleep ?? defaultSleep;
  const now: () => number = deps.now ?? ((): number => Date.now());
  const predicted: number =
    fields.predictedExecutionTimeMs !== undefined && Number.isFinite(fields.predictedExecutionTimeMs)
      ? fields.predictedExecutionTimeMs
      : 0;

  async function wait(opts?: WaitOptions): Promise<TxResult> {
    const budgetMs: number = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const signal: AbortSignal | undefined = opts?.signal;
    const deadline: number = now() + budgetMs;
    let delay: number =
      opts?.pollIntervalMs ??
      Math.min(Math.max(predicted, MIN_POLL_DELAY_MS), MAX_POLL_DELAY_MS);

    for (;;) {
      if (signal !== undefined && signal.aborted) throw abortError(signal);

      let found: EnrichedTx | undefined;
      try {
        const answer: EnrichedTx = await deps.rest.transaction.tx(
          { by: "hash", value: txHash },
          signal !== undefined ? { signal } : undefined,
        );
        if (isFound(answer)) found = answer;
      } catch (error: unknown) {
        const code: number | undefined = codeOf(error);
        // "Not found" is the expected answer right up until the sequencer executes it.
        if (code === undefined || !PENDING_CODES.has(code)) throw error;
      }
      if (found !== undefined) return toResult(txHash, found);

      const remaining: number = deadline - now();
      if (remaining <= 0) {
        throw new LighterTimeoutError(
          `transaction ${txHash} did not appear within ${String(budgetMs)} ms. It may still be ` +
            `in the mempool — the signed hash is authoritative, so re-poll GET /api/v1/tx?by=hash ` +
            `rather than re-sending`,
          { retryable: false },
        );
      }
      await sleep(Math.min(delay, remaining), signal);
      if (opts?.pollIntervalMs === undefined) {
        delay = Math.min(delay * POLL_BACKOFF, MAX_POLL_DELAY_MS);
      }
    }
  }

  return Object.freeze({
    txHash,
    txType: fields.txType,
    txInfo: fields.txInfo,
    nonce: fields.nonce,
    apiKeyIndex: fields.apiKeyIndex,
    predictedExecutionTimeMs: predicted,
    volumeQuotaRemaining: toCount(fields.volumeQuotaRemaining),
    wait,
  });
}
