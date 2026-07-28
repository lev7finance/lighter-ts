/**
 * The transaction lifecycle — **build → stamp → validate → hash → sign → serialise → submit →
 * classify** — and the only place in the SDK that touches a nonce lease.
 *
 * Everything below this file already exists: `src/tx/` builds, hashes, signs and serialises;
 * `src/rest/` and `src/ws/` carry bytes; `src/client/nonce/` allocates slots. This file is the
 * order those things happen in, and the rules about what to do when one of them fails.
 *
 * ## The lease is held across sign *and* submit
 *
 * Not "allocated, then used". A lease owns its key's mutex (`./nonce/types.ts`), and releasing it
 * between signing and submitting lets a second transaction on the same key reach the sequencer
 * first — which rejects everything behind it until a resync. So the whole of steps 4–6 happens
 * inside the lease, and the release is in a `finally`: a signer that throws and skips the release
 * deadlocks that key for as long as the client lives.
 *
 * ## The four outcomes, and the one the reference gets wrong
 *
 * | Outcome | Action | Why |
 * | --- | --- | --- |
 * | accepted | `commit()` | The slot is spent. |
 * | rejected | `rollback()` | Definitively refused, or never sent — the slot returns to the pool. |
 * | invalid-nonce | `resync(key)`, **no rollback** | Our counter is wrong in an unknown direction. |
 * | indeterminate | **nothing** | A timeout or abort. The transaction may already be in the mempool. |
 *
 * The last row is the whole point. The Python reference rolls back on a network timeout, so the
 * next transaction on that key reuses a nonce that may already be sequenced — and *that* rejection
 * looks like a server problem (`docs/ARCHITECTURE.md` ADR-14,
 * `docs/spec/07-high-level-client.md` §4.6). Doing nothing burns one slot; rolling back corrupts
 * the sequence.
 *
 * ## Never retried
 *
 * `sendTx` and `sendTxBatch` are nonce-bound: a duplicate submission is not idempotent, it is a
 * second order. The transport's policy is already GET-only, and this file **also** passes
 * `retry: { attempts: 0 }` on both routes rather than relying on that — a policy inherited by
 * accident is a policy that can be changed by accident (`spec/05-rest-api.md` §6).
 *
 * ## Two wire shapes that look like bugs and are not
 *
 * - **HTTP** is `application/x-www-form-urlencoded` for both routes. `sendTxBatch` sends
 *   `tx_types` as a JSON array of ints *encoded as a string* (`"[14,15]"`) and `tx_infos` as a JSON
 *   array of `tx_info` **strings**, also encoded as a string.
 * - **WebSocket** nests `tx_info` as a **parsed object** for a single transaction, while the batch
 *   frame passes JSON-encoded strings for both fields, mirroring the form encoding
 *   (`spec/07-high-level-client.md` §5.2, `spec/06-websocket.md` §8.1–8.2).
 *
 * Parsing `tx_info` back into an object for the single-tx frame is where a naive `JSON.parse`
 * silently corrupts a transaction: `Index` reaches `2^60 − 1` and `JSON.parse` rounds every
 * integer above `2^53` to a nearby double. {@link parseTxInfoDocument} therefore decodes integers
 * to `bigint`, which the WS client's frame encoder writes back as bare integer literals — so the
 * bytes that reach the sequencer are the bytes that were signed.
 *
 * No Node built-ins, no module-level mutable state, no repeating timers.
 */

import type { Diagnostic } from "../config/config.js";
import type { ApiKey, SignOptions } from "../crypto/key.js";
import {
  LighterApiError,
  LighterConfigError,
  LighterNonceError,
  LighterValidationError,
} from "../errors.js";
import type { RespSendTx, RespSendTxBatch } from "../models/transaction.js";
import type { CallOptions } from "../rest/client.js";
import { type TxAttributes, normalizeAttributes, validateAttributes } from "../tx/attributes.js";
import { i64, u8 } from "../tx/brands.js";
import type { SignedTx, UnsignedTx } from "../tx/build.js";
import { MAX_ACCOUNT_INDEX, MAX_TIMESTAMP, MIN_ACCOUNT_INDEX } from "../tx/constants.js";
import { signTx, toTxInfo, txHashHex } from "../tx/pipeline.js";
import type { SendTxAck, SendTxBatchAck } from "../ws/send-tx.js";
import { MAX_TX_BATCH_SIZE, WS_ACK_CODE_MISSING, WS_ACK_CODE_OK } from "../ws/send-tx.js";
import { createOutcomeClassifier } from "./nonce/types.js";
import type { NonceLease, NonceOutcome, NonceSource } from "./nonce/types.js";
import {
  type ReceiptDeps,
  type ReceiptTransport,
  type TxReceipt,
  assertTxHashMatch,
  createReceipt,
} from "./receipt.js";

/* ---------------------------------------------------------------------------------------------- */
/* The seams: what this file needs from the transports                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The three REST operations the write path uses.
 *
 * Structural on purpose: `LighterRestClient` satisfies it, and so does a fake with three methods,
 * so no test here touches the network. `tx` comes in from {@link ReceiptTransport} because a
 * receipt polls it.
 */
export interface SubmitTransport extends ReceiptTransport {
  readonly transaction: ReceiptTransport["transaction"] & {
    sendTx(
      params: { tx_type: number; tx_info: string; price_protection?: boolean },
      opts?: CallOptions,
    ): Promise<RespSendTx>;
    sendTxBatch(
      params: { tx_types: string; tx_infos: string },
      opts?: CallOptions,
    ): Promise<RespSendTxBatch>;
  };
}

/**
 * The transaction half of a WebSocket connection — `createTxDispatcher()` from `src/ws/send-tx.ts`.
 *
 * Declared structurally so this module does not depend on the WS client class, and so a caller who
 * never submits over a socket never pulls it into a bundle.
 */
export interface WsTxSubmitter {
  sendTx(
    txType: number,
    txInfo: object,
    opts?: { id?: string; timeoutMs?: number; txHash?: string },
  ): Promise<{ id: string; txHash?: string; ack: Promise<SendTxAck> }>;
  sendTxBatch(
    txTypes: readonly number[],
    txInfos: readonly object[],
    opts?: { id?: string; timeoutMs?: number; txHashes?: readonly string[] },
  ): Promise<{ id: string; txHashes?: string[]; ack: Promise<SendTxBatchAck> }>;
}

/** Which transport carries a submission. */
export type SubmitChannel = "http" | "ws";

/**
 * Everything {@link submit} needs. Assembled once per account by `./account.ts`.
 *
 * Nothing here is mutable state owned by this module: the counters live in {@link nonces}, the
 * keys in {@link keys}, and this file allocates nothing that outlives a call
 * (`docs/decisions.md` D8).
 */
export interface SubmitContext {
  /** Signing domain. An input to every hash, never inferred from a URL (`protocol-notes.md` §7). */
  readonly chainId: number;
  /** The signing account, for error messages and diagnostics. */
  readonly accountIndex: bigint;
  readonly rest: SubmitTransport;
  /**
   * Resolves the WS dispatcher, lazily, so that constructing an account never opens a socket.
   * Absent when the client has no WebSocket available.
   *
   * **Cloudflare Workers caveat (risk R12):** outside a Durable Object a Worker cannot hold an
   * outbound WebSocket across requests, so `channel: 'ws'` there means "open, submit, close" —
   * which is slower than HTTP, not faster. Prefer `'http'` on Workers.
   */
  readonly ws?: (() => WsTxSubmitter) | undefined;
  readonly nonces: NonceSource;
  /** `apiKeyIndex → ApiKey`. The only place secret material is reachable from this file. */
  readonly keys: ReadonlyMap<number, ApiKey>;
  /** Default transport when a call does not name one. */
  readonly channel: SubmitChannel;
  /** Failure classifier, normally from `createOutcomeClassifier()`. */
  readonly classify?: ((e: unknown) => NonceOutcome) | undefined;
  /** Injected clock, ms. */
  readonly now?: (() => number) | undefined;
  /** Injected sleep, for a receipt's polling. */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly onDiagnostic?: ((d: Diagnostic) => void) | undefined;
}

/* ---------------------------------------------------------------------------------------------- */
/* Options                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** What may be restated between building a transaction and signing it. */
export interface PrepareOpts {
  /**
   * An explicit nonce. Together with {@link apiKeyIndex} this selects **caller-managed mode**: the
   * nonce source is not consulted, no counter moves, and no rollback can happen. Supplying only one
   * of the two is a configuration error rather than a half-managed submission.
   */
  readonly nonce?: bigint;
  /** An explicit API key index. See {@link nonce}. */
  readonly apiKeyIndex?: number;
  /** Overrides the transaction's `ExpiredAt`. Unix **milliseconds**. */
  readonly expiredAt?: bigint;
  /** Replaces the transaction's L2 attributes wholesale. Nil-valued entries are dropped. */
  readonly attributes?: TxAttributes;
  /** Pin the key the lease is taken on, without leaving managed mode. Ignored in caller-managed mode. */
  readonly preferKey?: number;
  /**
   * Passed through to the signer. `{ nonce: k }` pins the Schnorr nonce and is how conformance
   * signatures are replayed; it is never a default, and reusing one `k` across two messages
   * recovers the private key.
   */
  readonly sign?: SignOptions;
}

/** {@link PrepareOpts} plus the transport-level knobs. */
export interface SendOpts extends PrepareOpts {
  /** Overrides the account's default transport for this call. */
  readonly channel?: SubmitChannel;
  readonly signal?: AbortSignal;
  /** Per-call budget. HTTP: the request timeout. WS: the acknowledgement budget. */
  readonly timeoutMs?: number;
  /**
   * `price_protection` on `POST /api/v1/sendTx`. Undocumented upstream and set by nothing in either
   * reference SDK; passed through when given and omitted entirely otherwise, because the server
   * distinguishes absent from `false` on several endpoints.
   */
  readonly priceProtection?: boolean;
}

/* ---------------------------------------------------------------------------------------------- */
/* Stamping                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** L2 attribute type `4`: "this nonce is claimed out of order". Set only by a pipelined lease. */
const SKIP_NONCE_ATTRIBUTE: 4 = 4;

/** The value attribute `4` takes when set. `0` is its nil value and is dropped. */
const SKIP_NONCE_ON: 1 = 1;

/** What {@link restampTx} writes onto a transaction. */
interface Stamp {
  readonly nonce: bigint;
  readonly apiKeyIndex: number;
  readonly expiredAt?: bigint | undefined;
  readonly attributes?: TxAttributes | undefined;
  /** When true, attribute `4` is added: the slot was claimed out of order. */
  readonly skipNonce?: boolean | undefined;
}

/**
 * Return a copy of `tx` carrying the identity the lease (or the caller) decided.
 *
 * A transaction is built before its nonce is known — the builders need *a* nonce, the lease decides
 * *the* nonce, and the lease must not be taken until the transaction is otherwise ready. So the
 * final `Nonce`, `ApiKeyIndex` and, where the caller overrode them, `ExpiredAt` and the attributes
 * are written here, immediately before hashing. Nothing downstream reads a value this function did
 * not settle.
 *
 * The result is frozen: the hash is computed from these bytes and any later mutation would leave a
 * signature describing a transaction that no longer exists.
 *
 * @throws {LighterValidationError} for a negative nonce, an out-of-range `ExpiredAt`, or an invalid
 * attribute map — the same codes the builders use, checked here because a stamp bypasses them.
 */
export function restampTx<T extends UnsignedTx>(tx: T, stamp: Stamp): T {
  if (stamp.nonce < 0n) {
    throw new LighterValidationError("NONCE_TOO_LOW", `nonce must be >= 0, received ${stamp.nonce}`, {
      field: "Nonce",
      bound: 0n,
    });
  }
  const expiredAt: bigint = stamp.expiredAt ?? (tx.expiredAt as unknown as bigint);
  if (expiredAt < 0n || expiredAt > MAX_TIMESTAMP) {
    throw new LighterValidationError(
      "EXPIRED_AT_INVALID",
      `ExpiredAt must be within [0, ${MAX_TIMESTAMP}] milliseconds, received ${expiredAt}`,
      { field: "ExpiredAt", bound: MAX_TIMESTAMP },
    );
  }

  // An absent map and an empty one are indistinguishable downstream: both hash and serialise as
  // "no attributes".
  let attributes: TxAttributes = stamp.attributes ?? tx.attributes ?? {};
  if (stamp.skipNonce === true) {
    attributes = { ...attributes, [SKIP_NONCE_ATTRIBUTE]: SKIP_NONCE_ON };
  }
  // The §6.2 rules run on what was asked for; nil-valued entries are dropped afterwards, exactly as
  // `resolveOpts` does at build time, so a stamped transaction and a built one hash identically.
  validateAttributes(attributes);

  // The union's member types differ, so the spread is widened deliberately and narrowed back: every
  // key written here exists on all twenty shapes with the same type.
  const next: T = {
    ...(tx as object),
    nonce: i64(stamp.nonce),
    apiKeyIndex: u8(stamp.apiKeyIndex),
    expiredAt: i64(expiredAt),
    attributes: normalizeAttributes(attributes),
  } as unknown as T;
  return Object.freeze(next);
}

/**
 * The signing key for an index, or a typed refusal.
 *
 * @throws {LighterNonceError} `KEY_UNKNOWN` — the message names the index and the configured ones,
 * and never any key material.
 */
function keyFor(ctx: SubmitContext, apiKeyIndex: number): ApiKey {
  const key: ApiKey | undefined = ctx.keys.get(apiKeyIndex);
  if (key === undefined) {
    const configured: string = [...ctx.keys.keys()].join(", ");
    throw new LighterNonceError(
      "KEY_UNKNOWN",
      `no private key is configured for api key index ${String(apiKeyIndex)}; this account holds ` +
        `${configured.length === 0 ? "none" : `[${configured}]`}`,
    );
  }
  return key;
}

/** A signed transaction and its digest. */
interface Signed {
  readonly signed: SignedTx;
  /** 80 lowercase hex characters, no `0x` — `txHashHex`'s spelling. */
  readonly txHash: string;
}

/** {@link Signed} plus the document that goes on the wire. */
interface Sealed extends Signed {
  /** The exact `tx_info` document. Always starts with `{`. */
  readonly txInfo: string;
}

/**
 * Stamp, then sign. **Does not serialise.**
 *
 * The split matters for the four L1 flows: `ChangePubKey`, `Transfer` and `ApproveIntegrator` carry
 * an `L1Sig` field that the serialiser requires and that an outside wallet has not produced yet, so
 * a transaction is signable long before it is serialisable. `prepare()` therefore stops here, and
 * the caller resumes through `submitWithL1Signature`.
 */
function signStamped(
  ctx: SubmitContext,
  tx: UnsignedTx,
  stamp: Stamp,
  sign: SignOptions | undefined,
): Signed {
  const key: ApiKey = keyFor(ctx, stamp.apiKeyIndex);
  const stamped: UnsignedTx = restampTx(tx, stamp);
  const signed: SignedTx = signTx(stamped, key, ctx.chainId, sign);
  // Recomputed from the signed object rather than carried alongside it, so the hash can never
  // describe a different chain id — or a different nonce — than the one just signed for.
  return { signed, txHash: txHashHex(signed, ctx.chainId) };
}

/**
 * Emit the `tx_info` document.
 *
 * @throws {LighterValidationError} `FIELD_MISSING` when a declared field is absent — which is what
 * an L1-bearing transaction with no `L1Sig` looks like.
 */
function serializeSealed(value: Signed): Sealed {
  return { ...value, txInfo: toTxInfo(value.signed) };
}

/** Stamp, sign and serialise, for the paths that are about to send. */
function sealTx(
  ctx: SubmitContext,
  tx: UnsignedTx,
  stamp: Stamp,
  sign: SignOptions | undefined,
): Sealed {
  return serializeSealed(signStamped(ctx, tx, stamp, sign));
}

/* ---------------------------------------------------------------------------------------------- */
/* tx_info → object, without losing an int64                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Parse a `tx_info` document into the object the WebSocket single-tx frame embeds, decoding every
 * integer literal to `bigint`.
 *
 * `JSON.parse` cannot be used here. `tx_info` carries `Index` up to `2^60 − 1`, `ClientOrderIndex`
 * up to `2^48 − 1` and `OrderExpiry`/`ExpiredAt` as millisecond epochs, all as **unquoted JSON
 * numbers** (`spec/04-tx-types.md` §9.2). `JSON.parse` produces doubles, so
 * `1152921504606846975` comes back as `1152921504606846976`, and re-encoding it would put a
 * transaction on the wire that differs from the one that was signed — with a valid signature over
 * the original. The failure is silent at every layer until the sequencer rejects it.
 *
 * The WS client's frame encoder emits `bigint` as a bare integer literal, so decoding to `bigint`
 * here round-trips the document byte-for-byte.
 *
 * Deliberately minimal: it accepts the subset of JSON that `src/tx/serialize.ts` emits — objects,
 * arrays, strings, integers, and `null`. A non-integer number is kept as a `number`; there are none
 * in any transaction document, and rejecting one would be a worse failure than passing it through.
 *
 * @throws {LighterValidationError} `TX_INFO_MALFORMED` if the text is not a JSON object.
 */
export function parseTxInfoDocument(txInfo: string): Record<string, unknown> {
  const parser: JsonScanner = new JsonScanner(txInfo);
  const value: unknown = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd() || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LighterValidationError(
      "TX_INFO_MALFORMED",
      "tx_info must be a single JSON object; it is the document that was signed, so it is never rewritten here",
      { field: "tx_info" },
    );
  }
  return value as Record<string, unknown>;
}

/**
 * A recursive-descent JSON reader whose only difference from `JSON.parse` is that integer literals
 * become `bigint`.
 *
 * Small enough to audit, and it has to exist: a `JSON.parse` reviver is handed the already-rounded
 * `number`, so by the time a reviver could act the digits are gone.
 */
class JsonScanner {
  readonly #text: string;
  #index: number = 0;

  constructor(text: string) {
    this.#text = text;
  }

  atEnd(): boolean {
    return this.#index >= this.#text.length;
  }

  skipWhitespace(): void {
    while (this.#index < this.#text.length) {
      const ch: string = this.#text.charAt(this.#index);
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return;
      this.#index += 1;
    }
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const ch: string = this.#text.charAt(this.#index);
    switch (ch) {
      case "{":
        return this.#parseObject();
      case "[":
        return this.#parseArray();
      case '"':
        return this.#parseString();
      case "t":
        return this.#parseLiteral("true", true);
      case "f":
        return this.#parseLiteral("false", false);
      case "n":
        return this.#parseLiteral("null", null);
      default:
        return this.#parseNumber();
    }
  }

  #fail(what: string): never {
    throw new LighterValidationError(
      "TX_INFO_MALFORMED",
      `tx_info is not valid JSON: expected ${what} at offset ${String(this.#index)}`,
      { field: "tx_info" },
    );
  }

  #expect(ch: string): void {
    if (this.#text.charAt(this.#index) !== ch) this.#fail(`"${ch}"`);
    this.#index += 1;
  }

  #parseObject(): Record<string, unknown> {
    this.#expect("{");
    // Null-prototype: keys come from a document, and one named `__proto__` must be an ordinary own
    // property rather than a prototype write.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    this.skipWhitespace();
    if (this.#text.charAt(this.#index) === "}") {
      this.#index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      const key: string = this.#parseString();
      this.skipWhitespace();
      this.#expect(":");
      out[key] = this.parseValue();
      this.skipWhitespace();
      const ch: string = this.#text.charAt(this.#index);
      if (ch === ",") {
        this.#index += 1;
        continue;
      }
      if (ch === "}") {
        this.#index += 1;
        return out;
      }
      this.#fail('"," or "}"');
    }
  }

  #parseArray(): unknown[] {
    this.#expect("[");
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.#text.charAt(this.#index) === "]") {
      this.#index += 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWhitespace();
      const ch: string = this.#text.charAt(this.#index);
      if (ch === ",") {
        this.#index += 1;
        continue;
      }
      if (ch === "]") {
        this.#index += 1;
        return out;
      }
      this.#fail('"," or "]"');
    }
  }

  /** Delegates the escape rules to `JSON.parse` on the isolated token — strings lose no precision. */
  #parseString(): string {
    const start: number = this.#index;
    if (this.#text.charAt(start) !== '"') this.#fail("a string");
    let i: number = start + 1;
    for (;;) {
      if (i >= this.#text.length) this.#fail("a closing quote");
      const ch: string = this.#text.charAt(i);
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') break;
      i += 1;
    }
    const token: string = this.#text.slice(start, i + 1);
    this.#index = i + 1;
    return JSON.parse(token) as string;
  }

  #parseLiteral<T>(text: string, value: T): T {
    if (this.#text.startsWith(text, this.#index)) {
      this.#index += text.length;
      return value;
    }
    return this.#fail(text);
  }

  /** An integer token becomes `bigint`; anything with a `.`, `e` or `E` stays a `number`. */
  #parseNumber(): bigint | number {
    const start: number = this.#index;
    if (this.#text.charAt(this.#index) === "-") this.#index += 1;
    const digitsFrom: number = this.#index;
    while (this.#index < this.#text.length) {
      const code: number = this.#text.charCodeAt(this.#index);
      if (code < 0x30 || code > 0x39) break;
      this.#index += 1;
    }
    if (this.#index === digitsFrom) this.#fail("a number");
    const ch: string = this.#text.charAt(this.#index);
    if (ch === "." || ch === "e" || ch === "E") {
      // Not reachable from any transaction document; handled so a hand-built one cannot crash.
      while (this.#index < this.#text.length && /[0-9eE+\-.]/.test(this.#text.charAt(this.#index))) {
        this.#index += 1;
      }
      return Number(this.#text.slice(start, this.#index));
    }
    return BigInt(this.#text.slice(start, this.#index));
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Dispatch                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Per-call REST options for the two write routes.
 *
 * `retry: { attempts: 0 }` is **explicit**. The transport's policy is already GET-only, and this
 * says so a second time at the one call site where a retry would place a duplicate order.
 */
function writeOptions(opts: SendOpts | undefined): CallOptions {
  return {
    retry: { attempts: 0 },
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

/** Resolve the WS dispatcher, or explain why there is none. */
function wsOf(ctx: SubmitContext): WsTxSubmitter {
  if (ctx.ws === undefined) {
    throw new LighterConfigError(
      "this client has no WebSocket available, so submit: 'ws' cannot be used. Pass a WebSocket " +
        "implementation (`new LighterClient({ WebSocket })`) — Node 20 has no global one — or " +
        "submit over HTTP",
    );
  }
  return ctx.ws();
}

/**
 * Turn a WebSocket acknowledgement into either "accepted" or a typed rejection.
 *
 * `code: 200` is accepted-for-sequencing. {@link WS_ACK_CODE_MISSING} means the frame carried no
 * numeric code at all — the ack envelope is unpublished (`spec/06-websocket.md` §8.3) — and is
 * treated as accepted **only because the frame was correlated to this submission by id**; the
 * locally computed hash is authoritative either way. Any other code is the server having refused.
 */
function assertAckAccepted(code: number, message: string | undefined, path: string): void {
  if (code === WS_ACK_CODE_OK || code === WS_ACK_CODE_MISSING) return;
  throw new LighterApiError({
    status: 200,
    code,
    ...(message !== undefined ? { message } : {}),
    path,
  });
}

/** What one dispatch returns, before it becomes a receipt. */
interface Dispatched {
  readonly txHashes: readonly (string | undefined)[];
  readonly predictedExecutionTimeMs: number | undefined;
  readonly volumeQuotaRemaining: number | undefined;
}

async function dispatchSingle(
  ctx: SubmitContext,
  channel: SubmitChannel,
  txType: number,
  txInfo: string,
  localHash: string,
  opts: SendOpts | undefined,
): Promise<Dispatched> {
  if (channel === "ws") {
    const submitter: WsTxSubmitter = wsOf(ctx);
    const sent: { ack: Promise<SendTxAck> } = await submitter.sendTx(
      txType,
      // The asymmetry: a **parsed object** here, JSON-encoded strings in the batch frame.
      parseTxInfoDocument(txInfo),
      {
        txHash: localHash,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    );
    const ack: SendTxAck = await sent.ack;
    assertAckAccepted(ack.code, ack.message, "jsonapi/sendtx");
    return {
      txHashes: [ack.txHash],
      predictedExecutionTimeMs: ack.predictedExecutionTimeMs,
      volumeQuotaRemaining: ack.volumeQuotaRemaining,
    };
  }

  const response: RespSendTx = await ctx.rest.transaction.sendTx(
    {
      tx_type: txType,
      tx_info: txInfo,
      ...(opts?.priceProtection !== undefined ? { price_protection: opts.priceProtection } : {}),
    },
    writeOptions(opts),
  );
  return {
    txHashes: [response.tx_hash],
    predictedExecutionTimeMs: response.predicted_execution_time_ms,
    volumeQuotaRemaining: response.volume_quota_remaining,
  };
}

async function dispatchBatch(
  ctx: SubmitContext,
  channel: SubmitChannel,
  txTypes: readonly number[],
  txInfos: readonly string[],
  localHashes: readonly string[],
  opts: SendOpts | undefined,
): Promise<Dispatched> {
  if (channel === "ws") {
    const submitter: WsTxSubmitter = wsOf(ctx);
    // The dispatcher owns the batch frame's spelling: it JSON-encodes both fields into strings
    // (`spec/06-websocket.md` §8.2). Note that §8.2 renders `tx_infos` as an array of *objects*
    // while `spec/07-high-level-client.md` §5.2 renders it as an array of *strings*; the two specs
    // disagree, neither is backed by a capture, and the WS unit owns that call. This file passes
    // documents and does not second-guess it.
    const sent: { ack: Promise<SendTxBatchAck> } = await submitter.sendTxBatch(
      txTypes,
      txInfos.map(parseTxInfoDocument),
      {
        txHashes: localHashes,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    );
    const ack: SendTxBatchAck = await sent.ack;
    assertAckAccepted(ack.code, ack.message, "jsonapi/sendtxbatch");
    return {
      txHashes: ack.txHashes ?? [],
      predictedExecutionTimeMs: ack.predictedExecutionTimeMs,
      volumeQuotaRemaining: ack.volumeQuotaRemaining,
    };
  }

  const response: RespSendTxBatch = await ctx.rest.transaction.sendTxBatch(
    {
      // `"[14,15]"` — a JSON array of ints, itself encoded as a string.
      tx_types: `[${txTypes.map((t: number): string => String(t)).join(",")}]`,
      // A JSON array of `tx_info` **strings**, itself encoded as a string.
      tx_infos: JSON.stringify(txInfos),
    },
    writeOptions(opts),
  );
  return {
    // Singular name, plural value: `RespSendTxBatch.tx_hash` is an array.
    txHashes: response.tx_hash ?? [],
    predictedExecutionTimeMs: response.predicted_execution_time_ms,
    volumeQuotaRemaining: response.volume_quota_remaining,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Leases                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** Whether the caller took nonce management into their own hands, per §4.3. */
function isCallerManaged(opts: PrepareOpts | undefined): boolean {
  return opts?.nonce !== undefined && opts.apiKeyIndex !== undefined;
}

/**
 * Reject the half-managed call, which is the one shape that silently corrupts a counter.
 *
 * @throws {LighterConfigError} when exactly one of `nonce` / `apiKeyIndex` was supplied.
 */
function assertNonceOptsCoherent(opts: PrepareOpts | undefined): void {
  const hasNonce: boolean = opts?.nonce !== undefined;
  const hasKey: boolean = opts?.apiKeyIndex !== undefined;
  if (hasNonce === hasKey) return;
  throw new LighterConfigError(
    hasNonce
      ? "an explicit nonce needs an explicit apiKeyIndex: a nonce is scoped to (account, apiKey), " +
        "and letting the pool rotate the key underneath a chosen nonce sends it on the wrong sequence"
      : "an explicit apiKeyIndex without a nonce would take a lease on that key; use " +
        "`preferKey` to pin the key while the nonce source still allocates",
  );
}

/**
 * Settle a lease according to the classified outcome. Exactly one of the four branches runs.
 *
 * `indeterminate` deliberately does nothing at all: the slot is burned, which costs one nonce and
 * cannot collide, whereas a rollback after a timeout can hand out a nonce that is already in the
 * sequencer.
 */
async function settle(
  ctx: SubmitContext,
  leases: readonly NonceLease[],
  outcome: NonceOutcome,
): Promise<void> {
  switch (outcome) {
    case "accepted":
      for (const lease of leases) lease.commit();
      return;
    case "rejected":
      rollbackAll(leases);
      return;
    case "invalid-nonce": {
      // Exactly one resync, and no rollback: the counter is wrong in an unknown direction, so
      // moving it by one would be a guess.
      const key: number | undefined = leases[0]?.apiKeyIndex;
      if (key !== undefined) await ctx.nonces.resync(key);
      return;
    }
    case "indeterminate": {
      // Nothing at all — and it is worth saying so out loud, because a burned slot is the one
      // outcome with no visible consequence until the next transaction on that key.
      const lease: NonceLease | undefined = leases[0];
      if (lease !== undefined && ctx.onDiagnostic !== undefined) {
        ctx.onDiagnostic({
          level: "warn",
          event: "tx.indeterminate",
          detail: {
            apiKeyIndex: lease.apiKeyIndex,
            nonce: lease.nonce.toString(10),
            count: leases.length,
            reason:
              "the outcome is unknown, so the nonce is burned rather than returned: the transaction may already be sequenced",
          },
        });
      }
      return;
    }
  }
}

/** Release every lease. `release()` is idempotent, so calling it on a released lease is free. */
function releaseAll(leases: readonly NonceLease[]): void {
  for (const lease of leases) lease.release();
}

/**
 * Roll every lease back, newest first.
 *
 * `rollback()` decrements only while the lease still holds its key's highest issued nonce, so the
 * order matters: unwinding a batch back-to-front returns every slot, while front-to-back would
 * return one and force a resync for the rest.
 */
function rollbackAll(leases: readonly NonceLease[]): void {
  for (let i: number = leases.length - 1; i >= 0; i -= 1) {
    const lease: NonceLease | undefined = leases[i];
    if (lease !== undefined) lease.rollback();
  }
}

/**
 * Take `count` slots on one key with strictly consecutive nonces.
 *
 * A batch must share one API key and carry consecutive nonces (§5.3), and this is where that is
 * enforced structurally rather than documented. Each lease is released as soon as it is allocated,
 * because the key's mutex is not reentrant — leasing twice while holding it would deadlock the key
 * forever — and the leases themselves are kept so the batch can still commit or roll back as a
 * unit afterwards.
 *
 * If another caller interleaves on the same key between two allocations the nonces come back
 * non-consecutive; the batch is abandoned **before anything is signed** and every slot taken is
 * rolled back in reverse order, which fully restores an optimistic counter.
 *
 * @throws {LighterNonceError} `LEASE_EXHAUSTED` when consecutive slots cannot be obtained — which
 * is the normal answer from the `server` strategy, since it re-reads a counter the sequencer has
 * not advanced yet.
 */
async function leaseConsecutive(
  nonces: NonceSource,
  count: number,
  preferKey: number | undefined,
): Promise<readonly NonceLease[]> {
  const taken: NonceLease[] = [];
  try {
    for (let i: number = 0; i < count; i += 1) {
      const previous: NonceLease | undefined = taken[i - 1];
      const lease: NonceLease = await nonces.lease(previous?.apiKeyIndex ?? preferKey);
      // Free the mutex immediately: the next allocation on this key would otherwise wait on us.
      lease.release();
      taken.push(lease);
      if (previous !== undefined) {
        if (lease.apiKeyIndex !== previous.apiKeyIndex || lease.nonce !== previous.nonce + 1n) {
          throw new LighterNonceError(
            "LEASE_EXHAUSTED",
            `a batch needs ${String(count)} consecutive nonces on one api key; the ${nonces.kind} ` +
              `strategy produced key ${String(previous.apiKeyIndex)}/nonce ${previous.nonce} then ` +
              `key ${String(lease.apiKeyIndex)}/nonce ${lease.nonce}. Use the optimistic strategy, ` +
              `or supply the first nonce and apiKeyIndex explicitly`,
          );
        }
      }
    }
    return taken;
  } catch (error: unknown) {
    for (let i: number = taken.length - 1; i >= 0; i -= 1) {
      const lease: NonceLease | undefined = taken[i];
      if (lease !== undefined) lease.rollback();
    }
    releaseAll(taken);
    throw error;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Preparation                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Stamp, validate, hash and sign — everything except the network.
 *
 * In managed mode this allocates a slot and **spends** it: the lease is released without a commit
 * or a rollback, which burns the nonce. That is the correct accounting, because the caller now
 * holds a transaction signed with it and the SDK cannot know whether it will be sent. A caller who
 * wants the slot returned should not have prepared. `send()` on the *unsigned* transaction keeps
 * the lease across the submission instead, which is why it, not this, is the ordinary path.
 *
 * A failure before anything is signed rolls the slot back: nothing was sent.
 */
export async function prepareTx(
  ctx: SubmitContext,
  tx: UnsignedTx,
  opts?: PrepareOpts,
): Promise<SignedTx> {
  assertNonceOptsCoherent(opts);
  if (isCallerManaged(opts)) {
    return signStamped(
      ctx,
      tx,
      {
        nonce: opts?.nonce as bigint,
        apiKeyIndex: opts?.apiKeyIndex as number,
        expiredAt: opts?.expiredAt,
        attributes: opts?.attributes,
      },
      opts?.sign,
    ).signed;
  }

  const lease: NonceLease = await ctx.nonces.lease(opts?.preferKey);
  try {
    return signStamped(
      ctx,
      tx,
      {
        nonce: lease.nonce,
        apiKeyIndex: lease.apiKeyIndex,
        expiredAt: opts?.expiredAt,
        attributes: opts?.attributes,
        skipNonce: lease.skipNonce,
      },
      opts?.sign,
    ).signed;
  } catch (error: unknown) {
    // Nothing left this process, so the slot is definitively unused.
    lease.rollback();
    throw error;
  } finally {
    lease.release();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Submission                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Receipt dependencies, derived from the context once per call. */
function receiptDeps(ctx: SubmitContext): ReceiptDeps {
  return {
    rest: ctx.rest,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...(ctx.sleep !== undefined ? { sleep: ctx.sleep } : {}),
  };
}

/** `ctx.classify`, or the default classifier. */
function classifierOf(ctx: SubmitContext): (e: unknown) => NonceOutcome {
  return ctx.classify ?? createOutcomeClassifier();
}

/**
 * The full lifecycle for one transaction.
 *
 * 1. resolve options; 2. caller-managed check; 3. lease; 4. stamp → validate → hash → sign →
 * serialise; 5. submit **while still holding the lease**; 6. classify; 7. release in `finally`.
 *
 * @throws {LighterApiError} the sequencer refused it (`code` is the raw domain code).
 * @throws {LighterValidationError} a local rule rejected it, or the server echoed a different hash.
 * @throws {LighterTransportError} the network failed — the transaction may still have landed, and
 * the nonce is deliberately **not** returned to the pool.
 */
export async function submit(
  ctx: SubmitContext,
  tx: UnsignedTx,
  opts?: SendOpts,
): Promise<TxReceipt> {
  assertNonceOptsCoherent(opts);
  const channel: SubmitChannel = opts?.channel ?? ctx.channel;
  const classify: (e: unknown) => NonceOutcome = classifierOf(ctx);

  if (isCallerManaged(opts)) {
    const stamp: Stamp = {
      nonce: opts?.nonce as bigint,
      apiKeyIndex: opts?.apiKeyIndex as number,
      expiredAt: opts?.expiredAt,
      attributes: opts?.attributes,
    };
    const sealed: Sealed = sealTx(ctx, tx, stamp, opts?.sign);
    try {
      const result: Dispatched = await dispatchSingle(
        ctx,
        channel,
        sealed.signed.type,
        sealed.txInfo,
        sealed.txHash,
        opts,
      );
      assertTxHashMatch(sealed.txHash, result.txHashes[0]);
      return toReceipt(ctx, sealed, stamp, result);
    } catch (error: unknown) {
      // No lease exists to settle, but the counter the *managed* users of this key share may now
      // be wrong; one resync is still the right response.
      if (classify(error) === "invalid-nonce") await ctx.nonces.resync(stamp.apiKeyIndex);
      throw error;
    }
  }

  const lease: NonceLease = await ctx.nonces.lease(opts?.preferKey);
  try {
    const stamp: Stamp = {
      nonce: lease.nonce,
      apiKeyIndex: lease.apiKeyIndex,
      expiredAt: opts?.expiredAt,
      attributes: opts?.attributes,
      skipNonce: lease.skipNonce,
    };

    let sealed: Sealed;
    try {
      sealed = sealTx(ctx, tx, stamp, opts?.sign);
    } catch (error: unknown) {
      // Stamping, validation or signing threw. Nothing reached the network, so the slot is
      // definitively unused and goes straight back to the pool.
      lease.rollback();
      throw error;
    }

    try {
      const result: Dispatched = await dispatchSingle(
        ctx,
        channel,
        sealed.signed.type,
        sealed.txInfo,
        sealed.txHash,
        opts,
      );
      assertTxHashMatch(sealed.txHash, result.txHashes[0]);
      lease.commit();
      return toReceipt(ctx, sealed, stamp, result);
    } catch (error: unknown) {
      await settle(ctx, [lease], classify(error));
      throw error;
    }
  } finally {
    // Always, on every path. A lease that is never released deadlocks its key for good.
    lease.release();
  }
}

/**
 * The full lifecycle for a batch: one API key, `N` consecutive nonces, one request.
 *
 * The array is non-empty, at most {@link MAX_TX_BATCH_SIZE}, and every transaction is signed with
 * the same key before anything is sent. In caller-managed mode `opts.nonce` is the **first** nonce
 * and the rest follow consecutively.
 */
export async function submitBatch(
  ctx: SubmitContext,
  txs: readonly UnsignedTx[],
  opts?: SendOpts,
): Promise<TxReceipt[]> {
  assertNonceOptsCoherent(opts);
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new LighterValidationError(
      "BATCH_EMPTY",
      "a batch needs at least one transaction; an empty sendTxBatch has nothing to submit",
      { field: "tx_infos" },
    );
  }
  if (txs.length > MAX_TX_BATCH_SIZE) {
    throw new LighterValidationError(
      "BATCH_TOO_LARGE",
      `a batch carries at most ${String(MAX_TX_BATCH_SIZE)} transactions, received ${String(txs.length)}`,
      { field: "tx_infos", bound: MAX_TX_BATCH_SIZE },
    );
  }

  const channel: SubmitChannel = opts?.channel ?? ctx.channel;
  const classify: (e: unknown) => NonceOutcome = classifierOf(ctx);
  const leases: readonly NonceLease[] = isCallerManaged(opts)
    ? []
    : await leaseConsecutive(ctx.nonces, txs.length, opts?.preferKey);

  try {
    const stamps: Stamp[] = [];
    for (let i: number = 0; i < txs.length; i += 1) {
      const lease: NonceLease | undefined = leases[i];
      stamps.push({
        // Caller-managed: `opts.nonce` is the first of `N` consecutive slots.
        nonce: lease === undefined ? (opts?.nonce as bigint) + BigInt(i) : lease.nonce,
        apiKeyIndex: lease === undefined ? (opts?.apiKeyIndex as number) : lease.apiKeyIndex,
        expiredAt: opts?.expiredAt,
        attributes: opts?.attributes,
        skipNonce: lease?.skipNonce,
      });
    }

    let sealed: Sealed[];
    try {
      sealed = txs.map((tx: UnsignedTx, i: number): Sealed =>
        sealTx(ctx, tx, stamps[i] as Stamp, opts?.sign),
      );
    } catch (error: unknown) {
      // Nothing was sent. Unwind newest-first so an optimistic counter is fully restored.
      rollbackAll(leases);
      throw error;
    }

    try {
      const result: Dispatched = await dispatchBatch(
        ctx,
        channel,
        sealed.map((s: Sealed): number => s.signed.type),
        sealed.map((s: Sealed): string => s.txInfo),
        sealed.map((s: Sealed): string => s.txHash),
        opts,
      );
      // One hash per transaction, in submission order — when the server echoed any at all.
      for (let i: number = 0; i < sealed.length; i += 1) {
        assertTxHashMatch((sealed[i] as Sealed).txHash, result.txHashes[i]);
      }
      await settle(ctx, leases, "accepted");
      return sealed.map((s: Sealed, i: number): TxReceipt =>
        toReceipt(ctx, s, stamps[i] as Stamp, result),
      );
    } catch (error: unknown) {
      await settle(ctx, leases, classify(error));
      throw error;
    }
  } finally {
    releaseAll(leases);
  }
}

/**
 * Submit a transaction that is already signed.
 *
 * The nonce is baked into the signature, so no lease is taken and no counter moves: this is
 * caller-managed by construction. An `invalid nonce` refusal still triggers exactly one resync,
 * because the counter that produced it is now known to be wrong.
 */
export async function submitPrepared(
  ctx: SubmitContext,
  signed: SignedTx,
  opts?: SendOpts,
): Promise<TxReceipt> {
  const channel: SubmitChannel = opts?.channel ?? ctx.channel;
  const sealed: Sealed = {
    signed,
    txInfo: toTxInfo(signed),
    txHash: txHashHex(signed, ctx.chainId),
  };
  const stamp: Stamp = { nonce: signed.nonce, apiKeyIndex: signed.apiKeyIndex };
  try {
    const result: Dispatched = await dispatchSingle(
      ctx,
      channel,
      signed.type,
      sealed.txInfo,
      sealed.txHash,
      opts,
    );
    assertTxHashMatch(sealed.txHash, result.txHashes[0]);
    return toReceipt(ctx, sealed, stamp, result);
  } catch (error: unknown) {
    if (classifierOf(ctx)(error) === "invalid-nonce") await ctx.nonces.resync(stamp.apiKeyIndex);
    throw error;
  }
}

/**
 * Submit a batch of already-signed transactions.
 *
 * Their nonces were fixed when they were signed, so this checks the invariant it can still check —
 * one key, consecutive nonces — and refuses rather than letting the sequencer discover it.
 */
export async function submitPreparedBatch(
  ctx: SubmitContext,
  signed: readonly SignedTx[],
  opts?: SendOpts,
): Promise<TxReceipt[]> {
  if (!Array.isArray(signed) || signed.length === 0) {
    throw new LighterValidationError(
      "BATCH_EMPTY",
      "a batch needs at least one transaction; an empty sendTxBatch has nothing to submit",
      { field: "tx_infos" },
    );
  }
  if (signed.length > MAX_TX_BATCH_SIZE) {
    throw new LighterValidationError(
      "BATCH_TOO_LARGE",
      `a batch carries at most ${String(MAX_TX_BATCH_SIZE)} transactions, received ${String(signed.length)}`,
      { field: "tx_infos", bound: MAX_TX_BATCH_SIZE },
    );
  }
  for (let i: number = 1; i < signed.length; i += 1) {
    const previous: SignedTx = signed[i - 1] as SignedTx;
    const current: SignedTx = signed[i] as SignedTx;
    const sameKey: boolean = current.apiKeyIndex === previous.apiKeyIndex;
    const consecutive: boolean = current.nonce === previous.nonce + 1n;
    if (!sameKey || !consecutive) {
      throw new LighterValidationError(
        "BATCH_NONCES_NOT_CONSECUTIVE",
        `every transaction in a batch must be signed by one api key with consecutive nonces; ` +
          `entry ${String(i - 1)} is key ${String(previous.apiKeyIndex)}/nonce ${String(previous.nonce)} ` +
          `and entry ${String(i)} is key ${String(current.apiKeyIndex)}/nonce ${String(current.nonce)}`,
        { field: "Nonce" },
      );
    }
  }

  const channel: SubmitChannel = opts?.channel ?? ctx.channel;
  const sealed: Sealed[] = signed.map((tx: SignedTx): Sealed => ({
    signed: tx,
    txInfo: toTxInfo(tx),
    txHash: txHashHex(tx, ctx.chainId),
  }));
  const stamps: Stamp[] = signed.map((tx: SignedTx): Stamp => ({
    nonce: tx.nonce,
    apiKeyIndex: tx.apiKeyIndex,
  }));

  try {
    const result: Dispatched = await dispatchBatch(
      ctx,
      channel,
      sealed.map((s: Sealed): number => s.signed.type),
      sealed.map((s: Sealed): string => s.txInfo),
      sealed.map((s: Sealed): string => s.txHash),
      opts,
    );
    for (let i: number = 0; i < sealed.length; i += 1) {
      assertTxHashMatch((sealed[i] as Sealed).txHash, result.txHashes[i]);
    }
    return sealed.map((s: Sealed, i: number): TxReceipt =>
      toReceipt(ctx, s, stamps[i] as Stamp, result),
    );
  } catch (error: unknown) {
    const first: Stamp | undefined = stamps[0];
    if (first !== undefined && classifierOf(ctx)(error) === "invalid-nonce") {
      await ctx.nonces.resync(first.apiKeyIndex);
    }
    throw error;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Assemble a receipt from what was signed and what came back. */
function toReceipt(
  ctx: SubmitContext,
  sealed: Sealed,
  stamp: Stamp,
  result: Dispatched,
): TxReceipt {
  return createReceipt(
    {
      // The local digest, always — the server's echo has already been asserted equal to it.
      txHash: sealed.txHash,
      txType: sealed.signed.type,
      txInfo: sealed.txInfo,
      nonce: stamp.nonce,
      apiKeyIndex: stamp.apiKeyIndex,
      predictedExecutionTimeMs: result.predictedExecutionTimeMs,
      volumeQuotaRemaining: result.volumeQuotaRemaining,
    },
    receiptDeps(ctx),
  );
}

/**
 * Range guard shared by the account layer.
 *
 * Exported here rather than in `./account.ts` because the bound is a protocol fact
 * (`[-1, 2^48 − 2]`) and belongs beside the other stamping rules. Named for the signing account
 * specifically: `./nonce/optimistic.ts` exports a `requireAccountIndex` of its own that checks a
 * `number` for the nonce-scoping key, and a barrel that re-exported both would be ambiguous.
 *
 * @throws {LighterValidationError} `ACCOUNT_INDEX_TOO_LOW` / `ACCOUNT_INDEX_TOO_HIGH`.
 */
export function requireSigningAccountIndex(accountIndex: bigint): bigint {
  if (accountIndex < MIN_ACCOUNT_INDEX) {
    throw new LighterValidationError(
      "ACCOUNT_INDEX_TOO_LOW",
      `accountIndex must be >= ${MIN_ACCOUNT_INDEX}, received ${accountIndex}`,
      { field: "AccountIndex", bound: MIN_ACCOUNT_INDEX },
    );
  }
  if (accountIndex > MAX_ACCOUNT_INDEX) {
    throw new LighterValidationError(
      "ACCOUNT_INDEX_TOO_HIGH",
      `accountIndex must be <= ${MAX_ACCOUNT_INDEX}, received ${accountIndex}`,
      { field: "AccountIndex", bound: MAX_ACCOUNT_INDEX },
    );
  }
  return accountIndex;
}
