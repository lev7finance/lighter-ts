/**
 * `jsonapi/sendtx` and `jsonapi/sendtxbatch` — correlated transaction submission over the socket
 * the client already holds.
 *
 * Attaches to a {@link WsFrameChannel}, never to the concrete client class, so a market-data-only
 * bundle never pulls the transaction path in and so this file can be driven by a test double with
 * no socket behind it. Nothing here signs, hashes, or validates a transaction body: the bodies are
 * opaque objects produced by `src/tx/`, and `txHash` is whatever the caller was handed at signing
 * time.
 *
 * ## What the reference does, and why we do not
 *
 * In the Python SDK, sending a transaction over the WebSocket means hand-assembling the envelope in
 * userland — from `examples/utils.py`, which is not part of the shipped package — and then doing a
 * blocking `recv()` that consumes whatever frame arrives next. On a socket that also carries market
 * data, that is an order-book update being swallowed as if it were an acknowledgement
 * (`docs/spec/06-websocket.md` §12.3, item 16). This dispatcher taps frames instead, consumes only
 * the ones it recognises, and correlates.
 *
 * ## Two protocol facts shape everything below
 *
 * 1. **The ack envelope is not published.** Every field name read here is `[INFER]`
 *    (`docs/spec/06-websocket.md` §8.3 and §15 item 1) and no live capture exists — the wave-0
 *    capture was refused at the upgrade from a restricted jurisdiction (`docs/protocol-notes.md`
 *    §8.3, API code 20558). So: two matching strategies chosen per connection, every field read
 *    defensively at two nesting levels, an unrecognised shape treated as a diagnostic plus a
 *    best-effort resolve rather than a throw, and {@link SendTxAck.raw} carrying the frame untouched
 *    so a caller can see what actually arrived. The moment a capture lands, the assertions in
 *    `test/ws/send-tx.test.ts` are the list of things to re-check.
 * 2. **A missing ack is not a failed transaction.** The transaction hash is fixed at signing time,
 *    and if the server had computed a different one the signature would not verify
 *    (`docs/spec/06-websocket.md` §8.4). A timeout, a dropped frame or a reconnect therefore says
 *    nothing about the transaction's fate. Both recovery routes are named in the error message:
 *    `GET /api/v1/tx?by=hash`, or the `account_tx/{account_index}` channel — which exists for
 *    exactly this.
 *
 * ## The wire asymmetry is mandatory
 *
 * `jsonapi/sendtx` carries `tx_info` as an **embedded JSON object**; `jsonapi/sendtxbatch` carries
 * `tx_types` and `tx_infos` as **JSON-encoded strings containing arrays** (§8.1, §8.2, both `[REF]`).
 * It is accidental complexity leaking out of the form-encoded REST endpoints into a JSON transport,
 * it looks like a bug, and it is not optional. Callers pass typed values; this file emits the
 * correct spelling per envelope, and the tests pin it by exact string comparison of the serialised
 * frame rather than structurally — a structural assertion cannot tell `[14,15]` from `"[14,15]"`.
 *
 * ## Mutable state owned here (`docs/decisions.md` D8), all instance-scoped
 *
 * The pending-correlation map, the per-connection matching mode, the correlation-id counter, and the
 * closed latch. Nothing at module scope — in particular `crypto.getRandomValues` is called once per
 * correlation id and never at import, which Cloudflare Workers forbids (D2,
 * `docs/protocol-notes.md` §5.1).
 */

import { bytesToHex } from "../util/bytes.js";
import type { WsFrameChannel } from "./client.js";
import {
  LighterWsClosedError,
  LighterWsError,
  LighterWsReadOnlyError,
  LighterWsTimeoutError,
} from "./errors.js";

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Default ack budget (`docs/spec/06-websocket.md` §8.3). */
const DEFAULT_SEND_TX_TIMEOUT_MS: 10_000 = 10_000;

/** Default correlation-id prefix. */
const DEFAULT_ID_PREFIX: "tx" = "tx";

/**
 * Transactions per `jsonapi/sendtxbatch` (`docs/spec/06-websocket.md` §8.2, `[DOC]` `[REF]`).
 *
 * Enforced client-side because the server's refusal of a 16-transaction batch is undocumented and
 * would be attributed to the wrong thing.
 */
export const MAX_TX_BATCH_SIZE: 15 = 15;

/**
 * {@link SendTxAck.code} when the ack carried no numeric `code` at all.
 *
 * Not `0`: `0` and `200` both read as success elsewhere in this package (`SUCCESS_CODES` in
 * `./protocol.js`), and an ack whose shape we did not recognise must not be mistaken for an
 * acceptance. Negative values cannot collide with a server code.
 */
export const WS_ACK_CODE_MISSING: -1 = -1;

/** `code` that means "accepted into the mempool" (`docs/spec/06-websocket.md` §8.3, `[DOC]`). */
export const WS_ACK_CODE_OK: 200 = 200;

/** Close code reported when the dispatcher itself, rather than the socket, ended a wait. */
const UNKNOWN_CLOSE_CODE: 1006 = 1006;

/** Randomness in a correlation id. Four bytes is ample to separate two dispatchers on one socket. */
const ID_RANDOM_BYTES: 4 = 4;

/** The recovery routes, named in every error a caller might see instead of an ack. */
const RECOVERY_HINT: string =
  "the transaction may still be in the mempool — the signed hash is authoritative, so resolve the " +
  "outcome with GET /api/v1/tx?by=hash or the account_tx/{account_index} channel";

/* ---------------------------------------------------------------------------------------------- */
/* Public types                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A single-transaction acknowledgement.
 *
 * Field names mirror `RespSendTx` from the REST equivalent, which is the only published shape
 * (`docs/spec/06-websocket.md` §8.3). Every one of them is `[INFER]` on this transport, so all are
 * optional except {@link code}, and {@link raw} always carries the frame verbatim.
 */
export interface SendTxAck {
  /** `200` means accepted into the mempool. {@link WS_ACK_CODE_MISSING} means the ack carried none. */
  code: number;
  /** The server's message, when it sent one. Never matched on — match on {@link code}. */
  message?: string;
  /**
   * The hash the server echoed, when it echoed one.
   *
   * Identical to the locally computed hash by construction (§8.4), so it is a confirmation, never a
   * source of truth. Kept as the string it arrived as; never coerced.
   */
  txHash?: string;
  /** Server's estimate, in ms. A count, not money. Absent unless it arrived as a JSON number. */
  predictedExecutionTimeMs?: number;
  /** Remaining volume quota. A count, not money. Absent unless it arrived as a JSON number. */
  volumeQuotaRemaining?: number;
  /** The ack frame, untouched and unreparsed. The only field guaranteed to be complete. */
  raw: unknown;
}

/**
 * A batch acknowledgement.
 *
 * `RespSendTxBatch.tx_hash` is an **array despite the singular key name** (§8.3), so both spellings
 * and both cardinalities are accepted into {@link txHashes}.
 */
export interface SendTxBatchAck extends Omit<SendTxAck, "txHash"> {
  txHashes?: string[];
}

/** Construction options. Every one has a default; none is read at import. */
export interface TxDispatcherOptions {
  /** Ack budget per submission, overridable per call. Default `10_000` (§8.3). */
  sendTxTimeoutMs?: number;
  /** Correlation-id prefix. Default `'tx'`. */
  idPrefix?: string;
  /** Clock in ms, for diagnostics only. Defaults to `Date.now`, read lazily. */
  now?: () => number;
  /**
   * Structured events. `kind` is a stable slug, never prose: `'sent'`, `'ack'`, `'match-mode'`,
   * `'ack-unmatched'`, `'ack-missing-id'`, `'timeout'`, `'abort'`, `'reconnect'`, `'tap-error'`,
   * `'send-failed'`. A throwing sink is swallowed — a diagnostic must never break submission.
   */
  onDiagnostic?: (d: { kind: string; [k: string]: unknown }) => void;
  /**
   * Timer pair. A test seam, and the reason the 10 s ack deadline is exercised in microseconds
   * against `test/ws-harness.ts` instead of against a wall clock.
   *
   * Defaults to `globalThis.setTimeout` / `clearTimeout`, read lazily. Never a repeating-interval
   * timer: a Durable Object cannot hibernate while one is live (`docs/spec/06-websocket.md` §13.2).
   */
  timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(h: number): void;
  };
}

/** Per-submission overrides. */
export interface SendTxOptions {
  /** Correlation id. Generated when absent; supply one only to match an external ledger. */
  id?: string;
  /** Ack budget for this submission. Defaults to {@link TxDispatcherOptions.sendTxTimeoutMs}. */
  timeoutMs?: number;
  /**
   * The hash the signer computed. Never derived here, and carried on a timeout so the recovery
   * route survives a lost ack (§8.4).
   */
  txHash?: string;
}

/** Per-submission overrides for a batch. See {@link SendTxOptions}. */
export interface SendTxBatchOptions extends Omit<SendTxOptions, "txHash"> {
  /** The hashes the signer computed, in submission order. */
  txHashes?: readonly string[];
}

/**
 * The transaction half of a socket.
 *
 * Every failure — a read-only socket, an over-long batch, a closed connection — arrives as a
 * **rejection of the returned promise**, never a synchronous throw, so one `try`/`catch` around an
 * `await` covers all of them.
 */
export interface TxDispatcher {
  /**
   * Submit one signed transaction.
   *
   * The returned promise settles once the frame has been written to the socket; `ack` settles when
   * the correlated reply arrives, or rejects on timeout, reconnect or {@link abortPending}.
   *
   * @param txType the transaction type discriminant, emitted as a JSON number
   * @param txInfo the signed body, emitted as an embedded JSON **object** (§8.1)
   */
  sendTx(
    txType: number,
    txInfo: object,
    opts?: SendTxOptions,
  ): Promise<{ id: string; txHash?: string; ack: Promise<SendTxAck> }>;
  /**
   * Submit up to {@link MAX_TX_BATCH_SIZE} signed transactions as one frame.
   *
   * `tx_types` and `tx_infos` go on the wire as JSON-encoded **strings** (§8.2).
   *
   * **Every transaction in a batch must be signed by the same API key index with strictly
   * consecutive nonces**, so the server can order them deterministically (§8.2). This dispatcher
   * cannot check that — the bodies are opaque to it — and does not try. The nonce manager is what
   * enforces it: ask it to advance the nonce *without* rotating the key for every transaction after
   * the first.
   */
  sendTxBatch(
    txTypes: readonly number[],
    txInfos: readonly object[],
    opts?: SendTxBatchOptions,
  ): Promise<{ id: string; txHashes?: string[]; ack: Promise<SendTxBatchAck> }>;
  /**
   * Reject and clear every pending correlation. Called automatically on reconnect and on
   * {@link close}.
   *
   * An entry whose caller supplied exactly one transaction hash is rejected with a
   * {@link LighterWsTimeoutError} carrying it and `reason` as the cause, because that hash is the
   * only recovery route and `reason` has nowhere to put it. Everything else is rejected with
   * `reason` verbatim.
   */
  abortPending(reason: Error): void;
  /** Unregister the frame and reconnect handlers, and abort anything still pending. Idempotent. */
  close(): void;
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * How acks are matched on the current connection.
 *
 * A property of the *connection*, not of the dispatcher: the decision is made by the first ack seen
 * and thrown away on every reconnect, because the next socket may be answered by a different server
 * build (§8.3, `[DESIGN]`).
 */
type MatchMode = "unknown" | "id" | "fifo";

/** One awaited acknowledgement. */
interface Pending {
  readonly id: string;
  readonly batch: boolean;
  /** The caller's hashes, in submission order. Empty when the caller supplied none. */
  readonly hashes: readonly string[];
  readonly sentAt: number;
  readonly budgetMs: number;
  timer: number | undefined;
  readonly resolve: (ack: SendTxAck | SendTxBatchAck) => void;
  readonly reject: (err: Error) => void;
}

/** Narrowing guard for a JSON object — arrays and `null` are not one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `key` from the frame, then from a `data` wrapper.
 *
 * The ack envelope is unpublished (§8.3): the fields may sit at the top level or nested under
 * `data`, and reading only one of the two would make the dispatcher silently mode-dependent on a
 * shape nobody has observed.
 */
function pick(frame: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(frame, key)) {
    const direct: unknown = frame[key];
    if (direct !== undefined) return direct;
  }
  const data: unknown = frame["data"];
  if (isPlainObject(data) && Object.hasOwn(data, key)) return data[key];
  return undefined;
}

/**
 * The correlation id an ack echoes, as a string.
 *
 * A JSON number or a `bigint` is stringified rather than compared numerically — the ids this file
 * generates are strings, and `String()` on an integer is exact at any width. This is not a numeric
 * coercion of a monetary field (`docs/decisions.md` D7); nothing here goes the other way.
 */
function readAckId(frame: Record<string, unknown>): string | undefined {
  const value: unknown = pick(frame, "id");
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

/** Read a field only when it arrived as a JSON number. A count that arrived otherwise stays absent. */
function readCount(frame: Record<string, unknown>, key: string): number | undefined {
  const value: unknown = pick(frame, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Every string in `value`, whether it arrived as one string or as an array of them. */
function readHashes(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry === "string" && entry !== "") out.push(entry);
  }
  return out;
}

/**
 * JSON text with `bigint` emitted as a bare integer literal.
 *
 * Needed because `JSON.stringify` throws on a `bigint`, and quoting one would change the wire type
 * of a field that is unquoted on the protocol (§3.3). Only the **batch** envelope needs it — there
 * the arrays are pre-serialised into strings before the client's own encoder ever sees them (§8.2),
 * so the client's encoder cannot do this job. Kept local rather than imported: the equivalent in
 * `./client.js` is deliberately not exported, and this file may not edit that one.
 */
function encodeJsonValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    const encoded: string | undefined = JSON.stringify(value);
    return encoded ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map(encodeJsonValue).join(",")}]`;
  }
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${encodeJsonValue(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* The dispatcher                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Attach a transaction dispatcher to a frame channel.
 *
 * Construction registers one inbound tap and one reconnect hook and does nothing else: no clock is
 * read, no timer scheduled, no randomness drawn. The tap is deliberately narrow — it consumes only
 * frames it recognises as transaction acks, because `onFrame` returning `true` marks a frame
 * consumed and a greedy predicate would blackhole an order-book update, which fails invisibly: the
 * subscription simply goes quiet.
 */
export function createTxDispatcher(
  channel: WsFrameChannel,
  opts: TxDispatcherOptions = {},
): TxDispatcher {
  const defaultTimeoutMs: number = requirePositive(
    "sendTxTimeoutMs",
    opts.sendTxTimeoutMs ?? DEFAULT_SEND_TX_TIMEOUT_MS,
  );
  const idPrefix: string = opts.idPrefix ?? DEFAULT_ID_PREFIX;
  const now: () => number = opts.now ?? ((): number => Date.now());
  const onDiagnostic: ((d: { kind: string; [k: string]: unknown }) => void) | undefined =
    opts.onDiagnostic;
  const timers: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(h: number): void;
  } = opts.timers ?? {
    setTimeout: (fn: () => void, ms: number): number =>
      globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h: number): void => {
      globalThis.clearTimeout(h as unknown as ReturnType<typeof globalThis.setTimeout>);
    },
  };

  // ---- instance state (D8) ---------------------------------------------------------------------
  /** Insertion-ordered, which is what makes FIFO matching a `values().next()` and not a second list. */
  const pending: Map<string, Pending> = new Map<string, Pending>();
  let mode: MatchMode = "unknown";
  let counter: number = 0;
  let closed: boolean = false;

  function diag(kind: string, detail: Record<string, unknown> = {}): void {
    if (onDiagnostic === undefined) return;
    try {
      onDiagnostic({ kind, ...detail });
    } catch {
      // A diagnostic sink is an observer. It never gets to break a submission or the read loop.
    }
  }

  function nextId(): string {
    counter += 1;
    return `${idPrefix}-${String(counter)}-${randomSuffix()}`;
  }

  /**
   * Per-call randomness, never at module scope: Cloudflare Workers throws on `getRandomValues`
   * outside a request (`docs/decisions.md` D2).
   *
   * The counter alone already makes ids unique within one dispatcher; the random tail only separates
   * two dispatchers sharing a socket, so a runtime without a global `crypto` degrades to the counter
   * rather than failing.
   */
  function randomSuffix(): string {
    const source: Crypto | undefined = globalThis.crypto as Crypto | undefined;
    if (source === undefined || typeof source.getRandomValues !== "function") return "0";
    const bytes: Uint8Array = new Uint8Array(ID_RANDOM_BYTES);
    source.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function firstPending(): Pending | undefined {
    for (const entry of pending.values()) return entry;
    return undefined;
  }

  /* ---- inbound ------------------------------------------------------------------------------- */

  /**
   * Is this frame ours?
   *
   * Three clauses, in order of confidence, and deliberately no fourth:
   *
   * 1. the `jsonapi/sendtx` / `jsonapi/sendtxbatch` type prefix (§8.1, §8.2);
   * 2. `code` **and** `tx_hash` together — the published `RespSendTx` shape (§8.3). `code` alone is
   *    not enough: every `error` frame carries one, and consuming those would swallow subscription
   *    failures;
   * 3. `code` plus an `id` that exactly matches a live correlation we generated. Narrow on purpose:
   *    it exists so a *rejection* ack — which may carry no `tx_hash` at all — reaches the caller
   *    instead of hanging until the timeout. Nothing else on this protocol echoes one of our ids.
   */
  function isTxAckFrame(frame: Record<string, unknown>): boolean {
    const type: unknown = frame["type"];
    if (typeof type === "string" && type.startsWith("jsonapi/sendtx")) return true;
    if (pick(frame, "code") === undefined) return false;
    if (pick(frame, "tx_hash") !== undefined || pick(frame, "tx_hashes") !== undefined) return true;
    const id: string | undefined = readAckId(frame);
    return id !== undefined && pending.has(id);
  }

  /** Build the caller-facing ack. Total: any shape produces an object, and `raw` is always intact. */
  function parseAck(frame: Record<string, unknown>, batch: boolean): SendTxAck | SendTxBatchAck {
    const codeValue: unknown = pick(frame, "code");
    const code: number =
      typeof codeValue === "number" && Number.isFinite(codeValue) ? codeValue : WS_ACK_CODE_MISSING;
    const messageValue: unknown = pick(frame, "message");
    const predicted: number | undefined = readCount(frame, "predicted_execution_time_ms");
    const quota: number | undefined = readCount(frame, "volume_quota_remaining");
    const hashes: string[] = readHashes(pick(frame, "tx_hash") ?? pick(frame, "tx_hashes"));

    const common: Omit<SendTxAck, "txHash"> = {
      code,
      raw: frame,
      ...(typeof messageValue === "string" ? { message: messageValue } : {}),
      ...(predicted === undefined ? {} : { predictedExecutionTimeMs: predicted }),
      ...(quota === undefined ? {} : { volumeQuotaRemaining: quota }),
    };
    if (batch) {
      return hashes.length === 0 ? common : { ...common, txHashes: hashes };
    }
    const first: string | undefined = hashes[0];
    return first === undefined ? common : { ...common, txHash: first };
  }

  /** Correlate one recognised ack and settle its promise. Never throws past its own guard. */
  function handleAck(frame: Record<string, unknown>): void {
    const id: string | undefined = readAckId(frame);

    if (mode === "unknown") {
      // The first ack on this connection decides, and the decision dies with the connection.
      mode = id === undefined ? "fifo" : "id";
      diag("match-mode", { mode, ...(id === undefined ? {} : { id }) });
    }

    let entry: Pending | undefined;
    if (mode === "id") {
      if (id === undefined) {
        // Defensive, not fatal: the shape is unverified, so one ack disagreeing with the mode falls
        // back rather than being dropped.
        diag("ack-missing-id", {});
        entry = firstPending();
      } else {
        entry = pending.get(id);
      }
    } else {
      // FIFO is sound because transaction frames are serialised on the wire (§8.3).
      entry = firstPending();
    }

    if (entry === undefined) {
      diag("ack-unmatched", { ...(id === undefined ? {} : { id }), pending: pending.size });
      return;
    }
    settle(entry, frame);
  }

  function settle(entry: Pending, frame: Record<string, unknown>): void {
    pending.delete(entry.id);
    if (entry.timer !== undefined) timers.clearTimeout(entry.timer);
    entry.timer = undefined;
    const ack: SendTxAck | SendTxBatchAck = parseAck(frame, entry.batch);
    if (ack.code === WS_ACK_CODE_MISSING) {
      diag("ack-unrecognised", { id: entry.id });
    }
    diag("ack", { id: entry.id, code: ack.code, batch: entry.batch });
    entry.resolve(ack);
  }

  /* ---- outbound ------------------------------------------------------------------------------ */

  /**
   * Create the correlation, register it, write the frame, then arm the timeout.
   *
   * Registration precedes the write because an ack may in principle be observed before `sendFrame`
   * returns; the timeout is armed after, because a frame that never reached the socket has nothing
   * to wait for and its entry is removed synchronously.
   */
  function register(
    id: string,
    batch: boolean,
    hashes: readonly string[],
    budgetMs: number,
    frame: object,
  ): Promise<SendTxAck | SendTxBatchAck> {
    let resolve!: (ack: SendTxAck | SendTxBatchAck) => void;
    let reject!: (err: Error) => void;
    const ack: Promise<SendTxAck | SendTxBatchAck> = new Promise<SendTxAck | SendTxBatchAck>(
      (res: (ack: SendTxAck | SendTxBatchAck) => void, rej: (err: Error) => void): void => {
        resolve = res;
        reject = rej;
      },
    );
    // A caller is entitled to ignore `ack` entirely — the signed hash is authoritative (§8.4), so
    // fire-and-forget is a legitimate mode. Without this, a reconnect would turn every ignored ack
    // into an unhandled rejection and, under Node's default, take the process down. Every rejection
    // is still reported through `onDiagnostic`, so nothing becomes invisible.
    void ack.catch((): void => undefined);

    const entry: Pending = {
      id,
      batch,
      hashes,
      sentAt: now(),
      budgetMs,
      timer: undefined,
      resolve,
      reject,
    };
    if (pending.has(id)) {
      throw new LighterWsError(`correlation id ${JSON.stringify(id)} is already in flight`);
    }
    pending.set(id, entry);

    try {
      // Lane `'tx'`: excluded from the 200-messages-per-minute budget and the inflight ceiling
      // because transaction frames count against the REST limits instead (§8.6) — still serialised.
      channel.sendFrame(frame, { lane: "tx" });
    } catch (e: unknown) {
      pending.delete(id);
      diag("send-failed", { id, error: String(e) });
      reject(e instanceof Error ? e : new LighterWsError(String(e)));
      throw e;
    }

    entry.timer = timers.setTimeout((): void => {
      expire(id);
    }, budgetMs);
    diag("sent", { id, batch, at: entry.sentAt });
    return ack;
  }

  function expire(id: string): void {
    const entry: Pending | undefined = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    entry.timer = undefined;
    diag("timeout", {
      id,
      budgetMs: entry.budgetMs,
      waitedMs: now() - entry.sentAt,
      hashes: [...entry.hashes],
    });
    entry.reject(
      timeoutError(entry, `no acknowledgement for ${id} within ${String(entry.budgetMs)} ms`),
    );
  }

  /**
   * A {@link LighterWsTimeoutError} that keeps the recovery route.
   *
   * `txHash` is populated only when the entry has exactly one hash — the error class has no plural
   * field, and putting the first of fifteen there would be worse than putting none. A batch's hashes
   * are listed in the message and in the `timeout` / `abort` diagnostic; the caller already holds
   * them, since it supplied them.
   */
  function timeoutError(entry: Pending, headline: string, cause?: unknown): LighterWsTimeoutError {
    const only: string | undefined = entry.hashes.length === 1 ? entry.hashes[0] : undefined;
    const listed: string =
      entry.hashes.length > 1 ? ` (hashes: ${entry.hashes.join(", ")})` : "";
    return new LighterWsTimeoutError(`${headline}${listed} — ${RECOVERY_HINT}`, {
      ...(only === undefined ? {} : { txHash: only }),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  function abortPending(reason: Error): void {
    if (pending.size === 0) return;
    const entries: Pending[] = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) timers.clearTimeout(entry.timer);
      entry.timer = undefined;
      const failure: Error =
        entry.hashes.length === 0
          ? reason
          : timeoutError(entry, `${reason.message} before the acknowledgement arrived`, reason);
      entry.reject(failure);
    }
    diag("abort", { count: entries.length, reason: reason.message });
  }

  function requireOpenForTx(): void {
    if (closed) {
      throw new LighterWsError("this transaction dispatcher has been closed");
    }
    // Checked here as well as in `sendFrame` so nothing is registered and no id is burned on a
    // socket that will refuse the frame (§8.5).
    if (channel.readOnly) throw new LighterWsReadOnlyError();
  }

  /* ---- the two entry points ------------------------------------------------------------------ */

  async function sendTx(
    txType: number,
    txInfo: object,
    o: SendTxOptions = {},
  ): Promise<{ id: string; txHash?: string; ack: Promise<SendTxAck> }> {
    requireOpenForTx();
    if (!Number.isInteger(txType)) {
      throw new LighterWsError(`sendTx: txType must be an integer, got ${String(txType)}`);
    }
    if (!isPlainObject(txInfo)) {
      throw new LighterWsError("sendTx: txInfo must be a plain object — it goes on the wire as one");
    }
    const id: string = o.id ?? nextId();
    const budgetMs: number = requirePositive("timeoutMs", o.timeoutMs ?? defaultTimeoutMs);
    // `tx_info` is an embedded JSON **object** here, unlike the batch envelope. Key order is the
    // wire order: the client's encoder walks `Object.entries` and does not sort.
    const frame: object = {
      type: "jsonapi/sendtx",
      data: { id, tx_type: txType, tx_info: txInfo },
    };
    const hashes: readonly string[] = o.txHash === undefined ? [] : [o.txHash];
    // Deliberately not awaited: this promise is the caller's to await, and `register` has already
    // written the frame by the time it returns.
    const ack: Promise<SendTxAck> = register(
      id,
      false,
      hashes,
      budgetMs,
      frame,
    ) as Promise<SendTxAck>;
    return o.txHash === undefined ? { id, ack } : { id, txHash: o.txHash, ack };
  }

  async function sendTxBatch(
    txTypes: readonly number[],
    txInfos: readonly object[],
    o: SendTxBatchOptions = {},
  ): Promise<{ id: string; txHashes?: string[]; ack: Promise<SendTxBatchAck> }> {
    requireOpenForTx();
    if (!Array.isArray(txTypes) || !Array.isArray(txInfos)) {
      throw new LighterWsError("sendTxBatch: txTypes and txInfos must both be arrays");
    }
    if (txTypes.length !== txInfos.length) {
      throw new LighterWsError(
        `sendTxBatch: txTypes has ${String(txTypes.length)} entries and txInfos has ${String(txInfos.length)} — they must match`,
      );
    }
    if (txTypes.length === 0) {
      throw new LighterWsError("sendTxBatch: an empty batch has nothing to send");
    }
    if (txTypes.length > MAX_TX_BATCH_SIZE) {
      throw new LighterWsError(
        `sendTxBatch: ${String(txTypes.length)} transactions exceeds the protocol maximum of ${String(MAX_TX_BATCH_SIZE)} per batch`,
      );
    }
    for (const txType of txTypes) {
      if (!Number.isInteger(txType)) {
        throw new LighterWsError(`sendTxBatch: every txType must be an integer, got ${String(txType)}`);
      }
    }
    for (const txInfo of txInfos) {
      if (!isPlainObject(txInfo)) {
        throw new LighterWsError("sendTxBatch: every txInfo must be a plain object");
      }
    }

    const id: string = o.id ?? nextId();
    const budgetMs: number = requirePositive("timeoutMs", o.timeoutMs ?? defaultTimeoutMs);
    // `tx_types` and `tx_infos` are JSON-encoded **strings** here, unlike the single envelope (§8.2).
    const frame: object = {
      type: "jsonapi/sendtxbatch",
      data: {
        id,
        tx_types: encodeJsonValue(txTypes),
        tx_infos: encodeJsonValue(txInfos),
      },
    };
    const hashes: readonly string[] = o.txHashes === undefined ? [] : [...o.txHashes];
    // Deliberately not awaited — see `sendTx`.
    const ack: Promise<SendTxBatchAck> = register(
      id,
      true,
      hashes,
      budgetMs,
      frame,
    ) as Promise<SendTxBatchAck>;
    return o.txHashes === undefined ? { id, ack } : { id, txHashes: [...o.txHashes], ack };
  }

  /* ---- wiring -------------------------------------------------------------------------------- */

  const detachFrame: () => void = channel.onFrame((frame: Record<string, unknown>): boolean => {
    let recognised: boolean = false;
    try {
      recognised = isTxAckFrame(frame);
      if (recognised) handleAck(frame);
    } catch (e: unknown) {
      // Nothing thrown while settling an ack may escape into the socket read loop: one bad frame
      // would otherwise take every subscription on this socket down with it.
      diag("tap-error", { error: String(e) });
    }
    return recognised;
  });

  const detachReconnect: () => void = channel.onReconnect(
    (info: { code: number; reason: string }): void => {
      try {
        // The mode is a property of the connection: the next socket re-evaluates it from scratch.
        mode = "unknown";
        diag("reconnect", { code: info.code, reason: info.reason, pending: pending.size });
        abortPending(
          new LighterWsClosedError(
            `the socket closed (${String(info.code)}) with ${JSON.stringify(info.reason)}`,
            info.reason === ""
              ? { wsCode: info.code }
              : { wsCode: info.code, wsReason: info.reason },
          ),
        );
      } catch (e: unknown) {
        diag("tap-error", { error: String(e) });
      }
    },
  );

  function close(): void {
    if (closed) return;
    closed = true;
    detachFrame();
    detachReconnect();
    abortPending(
      new LighterWsClosedError("the transaction dispatcher was closed", {
        wsCode: UNKNOWN_CLOSE_CODE,
      }),
    );
  }

  return { sendTx, sendTxBatch, abortPending, close };
}

/** Reject a non-positive or non-finite timeout at the point it is configured, not when it fires. */
function requirePositive(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LighterWsError(`${name} must be a finite number greater than 0`);
  }
  return value;
}
