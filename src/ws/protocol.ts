/**
 * The WebSocket wire codec: text frame in, discriminated value out, and byte-exact frames out.
 *
 * This module sits between the raw socket and everything above it. It performs no I/O, holds no
 * state, reads no clock, and schedules nothing — `transport.ts` owns the socket and `client.ts`
 * owns subscription bookkeeping. Keeping the codec pure is what lets the whole protocol be tested
 * in-process, which matters more here than anywhere else in the package because the live capture is
 * blocked (below).
 *
 * ## Evidence status — read this before trusting any shape here
 *
 * `test/fixtures/ws/capture.json` contains **no frames**. The wave-0 capture was refused at the
 * upgrade from a restricted jurisdiction (API code 20558; `docs/protocol-notes.md` §8.3), so every
 * inbound shape below comes from `docs/spec/06-websocket.md`, where the markers are `[REF]`
 * (observed in the reference client or its fixtures — solid), `[DOC]` (published documentation —
 * plausible, unverified) or `[INFER]`. Each place this file depends on an unverified shape names the
 * section, so it can be re-checked the moment a capture lands.
 *
 * The practical consequence is a design rule, not a caveat: **decoding is total.** `decodeFrame`
 * never throws and never rejects a frame it does not recognise — an unknown `type` becomes
 * `{ kind: "unknown" }` and the caller warns. The reference Python client raises on any
 * unrecognised message, which kills its own read loop, including on `error` frames and on the
 * `unsubscribed/*` ack (`docs/protocol-notes.md` §10.2). A new server-side message type must not
 * take this client down.
 *
 * ## The three traps this module exists to absorb
 *
 * 1. **Two channel-key spellings, applied inconsistently.** Outbound keys use slashes
 *    (`order_book/0`); inbound `channel` values echo colons (`order_book:0`) — except
 *    `account_market`, which echoes slashes, and `account_orders`, which echoes
 *    `account_orders:{M}` with the account index **missing entirely** (it arrives in a sibling
 *    `account` field). `height` and `rfq` carry no index at all. Routing by string equality on the
 *    inbound `channel` is therefore wrong for at least three channels, which is what
 *    {@link resolveRouteKey} exists for.
 * 2. **The client sends `pong`, never `ping`.** Keepalive is application-level JSON: the server
 *    sends `{"type":"ping"}` and expects `{"type":"pong"}` (`docs/protocol-notes.md` §10.1). These
 *    are not RFC 6455 control frames — which is exactly why no `ws` package is needed and why this
 *    works identically in browsers and Workers, neither of which exposes a control-frame API. The
 *    reference SDK's helper is misleadingly named `ws_ping` and sends `pong`; the name is not
 *    copied here.
 * 3. **`sendtx` and `sendtxbatch` disagree about typing, mandatorily.** In `jsonapi/sendtx`,
 *    `data.tx_info` is an embedded JSON **object**. In `jsonapi/sendtxbatch`, `data.tx_types` and
 *    `data.tx_infos` are JSON-encoded **strings** containing arrays. It leaks from the
 *    form-encoded REST shape (`docs/spec/06-websocket.md` §8.2); emitting one where the other is
 *    required is rejected server-side with an unhelpful error.
 *
 * ## What this module deliberately does not do
 *
 * Prices and sizes pass through untouched, as the decimal strings they arrive as. Parsing them is
 * the channel registry's job; `parseFloat` anywhere on this path would be a defect
 * (`docs/decisions.md` D7). JSON keys are never case-folded either: candle payloads use `v` for
 * base volume and `V` for quote volume, differing only by case.
 */

import { parseFrameJson } from "../util/json.js";
import { LighterValidationError } from "../errors.js";
import {
  WS_ERR_ALREADY_SUBSCRIBED,
  WS_ERR_FAILED_TO_SUBSCRIBE,
  WS_ERR_INVALID_API_KEY_INDEX,
  WS_ERR_API_KEY_NOT_FOUND,
  WS_ERR_INVALID_CHANNEL,
  WS_ERR_INVALID_DATA,
  WS_ERR_INVALID_JSON,
  WS_ERR_INVALID_SIGNATURE,
  WS_ERR_INVALID_TYPE,
  WS_ERR_NOT_SUBSCRIBED,
  WS_ERR_TOO_MANY_ACCOUNTS,
  WS_ERR_TOO_MANY_CONNECTIONS,
  WS_ERR_TOO_MANY_INFLIGHT,
  WS_ERR_TOO_MANY_MESSAGES,
  WS_ERR_TOO_MANY_REQUESTS,
  WS_ERR_TOO_MANY_SUBSCRIPTIONS,
} from "./errors.js";

// ---------------------------------------------------------------------------------------------
// Transport-facing types
// ---------------------------------------------------------------------------------------------

/**
 * The subset of the WHATWG `WebSocket` interface this package uses.
 *
 * Narrow on purpose. Every runtime we target — browsers, Bun, Deno, Cloudflare Workers, Node 22+ —
 * provides these members, and nothing here requires a control-frame API, which only the banned
 * `ws` package exposes. Declaring the shape rather than referencing the global also lets the
 * in-process test harness stand in for a socket without a network.
 *
 * It lives in this module rather than in `transport.ts` so the harness can import it without
 * pulling in the transport.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(t: "open", cb: () => void): void;
  addEventListener(t: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(t: "error", cb: (e: unknown) => void): void;
  addEventListener(t: "close", cb: (e: { code: number; reason: string }) => void): void;
}

/** How a {@link WebSocketLike} is constructed. Injected, so nothing here reaches for a global. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

// ---------------------------------------------------------------------------------------------
// Channel-key codec
// ---------------------------------------------------------------------------------------------

/**
 * Colon spelling → slash spelling. `"order_book:0"` → `"order_book/0"`, `"candle:0:1m"` →
 * `"candle/0/1m"`.
 *
 * Idempotent, and a no-op for keys that already use slashes (`account_market/3/1234`) or carry no
 * index at all (`height`, `rfq`). Nothing else about the string is touched: no trimming, no case
 * folding, no validation. A key the server does not recognise is the server's to reject with 30005
 * — silently rewriting it here would hide the bug.
 *
 * `docs/spec/06-websocket.md` §2.3 (`[REF]` `[DOC]`).
 */
export function normaliseChannelKey(raw: string): string {
  return raw.includes(":") ? raw.replaceAll(":", "/") : raw;
}

/** The inbound `type` prefixes that carry a channel family. Order is irrelevant; all are distinct. */
const FAMILY_PREFIXES: readonly string[] = ["subscribed/", "unsubscribed/", "update/"];

/**
 * Strip the `subscribed/` | `update/` | `unsubscribed/` prefix from an inbound `type`.
 *
 * `"update/order_book"` → `"order_book"`. Returns `null` when the type carries no such prefix
 * (`"connected"`, `"ping"`, `"jsonapi/sendtx"`) or when the remainder is empty.
 *
 * The family is the channel name with **no index suffix**; the index lives in the sibling `channel`
 * field (`docs/spec/06-websocket.md` §2.2, `[REF]`).
 */
export function familyFromType(type: string): string | null {
  for (const prefix of FAMILY_PREFIXES) {
    if (type.startsWith(prefix)) {
      const family: string = type.slice(prefix.length);
      return family.length > 0 ? family : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Outbound frame builders
// ---------------------------------------------------------------------------------------------

/**
 * `{"type":"pong"}` — the only frame this client ever sends unprompted.
 *
 * Answers a server `{"type":"ping"}`, and doubles as the keepalive filler: the server closes a
 * connection that has sent nothing for two minutes, and `pong` is the one type it provably accepts
 * from a client that carries no state (`subscribe` on an active channel returns 30003, and an
 * invented type risks 30001). `docs/spec/06-websocket.md` §9.
 */
export function buildPong(): string {
  return '{"type":"pong"}';
}

/**
 * `{"type":"subscribe","channel":"<slash-key>"}`, with `"auth"` appended only when a token is
 * supplied.
 *
 * The `auth` key is **omitted entirely** when there is no token — not `null`, not `""`
 * (`docs/spec/06-websocket.md` §5.1, `[REF]`). An empty-string token is treated as absent, since
 * that is a caller bug that would otherwise reach the wire as an empty credential.
 *
 * The key is normalised to the slash spelling on the way out, so a colon-spelled key echoed back
 * from an inbound frame and handed straight to this function still produces a valid subscribe.
 */
export function buildSubscribe(channelKey: string, auth?: string): string {
  const channel: string = normaliseChannelKey(channelKey);
  if (auth === undefined || auth.length === 0) {
    return `{"type":"subscribe","channel":${JSON.stringify(channel)}}`;
  }
  return `{"type":"subscribe","channel":${JSON.stringify(channel)},"auth":${JSON.stringify(auth)}}`;
}

/**
 * `{"type":"unsubscribe","channel":"<slash-key>"}`.
 *
 * No `auth`: the documented unsubscribe frame carries only the channel
 * (`docs/spec/06-websocket.md` §5.2, `[DOC]`). Code 30002 comes back when the channel was not
 * subscribed, which {@link classifyWsError} treats as success in that context.
 */
export function buildUnsubscribe(channelKey: string): string {
  return `{"type":"unsubscribe","channel":${JSON.stringify(normaliseChannelKey(channelKey))}}`;
}

/** Payload for {@link buildSendTx}. */
export interface SendTxFrameInput {
  /** Client correlation id, echoed in the ack. Omitted from the frame when absent or empty. */
  readonly id?: string;
  /** The numeric transaction type code. */
  readonly txType: number;
  /**
   * The signed transaction document.
   *
   * A **string** is spliced in verbatim and must be a complete JSON object — that is the form
   * `toTxInfo` / `txSubmission` produce (`src/tx/pipeline.ts`), and passing it through unparsed is
   * the only way to keep 64-bit fields exact. An **object** is serialised here, with `bigint`
   * emitted as a bare integer literal.
   */
  readonly txInfo: object | string;
}

/**
 * `{"type":"jsonapi/sendtx","data":{"id":…,"tx_type":…,"tx_info":{…}}}`.
 *
 * `tx_info` is an embedded JSON **object**. Its twin {@link buildSendTxBatch} needs
 * JSON-encoded strings instead; see this module's header for why, and
 * `docs/spec/06-websocket.md` §8.1–8.2.
 *
 * @throws {LighterValidationError} `WS_TX_INFO_INVALID` if a string `txInfo` is not a JSON object
 * document. Splicing an arbitrary string would emit a malformed frame that the server answers with
 * an unattributable 30000.
 */
export function buildSendTx(d: SendTxFrameInput): string {
  const fields: string[] = [];
  if (d.id !== undefined && d.id.length > 0) fields.push(`"id":${JSON.stringify(d.id)}`);
  fields.push(`"tx_type":${integerLiteral(d.txType, "txType")}`);
  fields.push(`"tx_info":${txDocument(d.txInfo)}`);
  return `{"type":"jsonapi/sendtx","data":{${fields.join(",")}}}`;
}

/** Payload for {@link buildSendTxBatch}. */
export interface SendTxBatchFrameInput {
  /** Client correlation id, echoed in the ack. Omitted from the frame when absent or empty. */
  readonly id?: string;
  /** Numeric transaction type codes, positionally aligned with {@link txInfos}. */
  readonly txTypes: readonly number[];
  /** Signed transaction documents. Same string-or-object rule as {@link SendTxFrameInput.txInfo}. */
  readonly txInfos: readonly (object | string)[];
}

/**
 * `{"type":"jsonapi/sendtxbatch","data":{"id":…,"tx_types":"[14,15]","tx_infos":"[{…},{…}]"}}`.
 *
 * Note the quoting: `tx_types` and `tx_infos` are JSON **strings** whose contents are JSON arrays,
 * not arrays. The asymmetry with {@link buildSendTx} is real and mandatory — it leaks from the
 * form-encoded REST shape, where everything is stringified
 * (`docs/spec/06-websocket.md` §8.2, `[REF]`).
 *
 * The server's 15-transaction ceiling and the same-key/consecutive-nonce rule are the dispatcher's
 * to enforce; this builder only spells the frame. Positional misalignment is caught, because a
 * batch whose types and bodies disagree is signed nonsense.
 *
 * @throws {LighterValidationError} `WS_TX_BATCH_MISALIGNED` when the two arrays differ in length.
 */
export function buildSendTxBatch(d: SendTxBatchFrameInput): string {
  if (d.txTypes.length !== d.txInfos.length) {
    throw new LighterValidationError(
      "WS_TX_BATCH_MISALIGNED",
      `sendtxbatch: ${d.txTypes.length} tx types but ${d.txInfos.length} tx infos`,
      { field: "tx_types" },
    );
  }
  const types: string = `[${d.txTypes.map((t: number): string => integerLiteral(t, "txTypes")).join(",")}]`;
  const infos: string = `[${d.txInfos.map(txDocument).join(",")}]`;
  const fields: string[] = [];
  if (d.id !== undefined && d.id.length > 0) fields.push(`"id":${JSON.stringify(d.id)}`);
  fields.push(`"tx_types":${JSON.stringify(types)}`);
  fields.push(`"tx_infos":${JSON.stringify(infos)}`);
  return `{"type":"jsonapi/sendtxbatch","data":{${fields.join(",")}}}`;
}

/** A JSON integer literal, or a typed refusal. `tx_type` is an integer on the wire, never `1.0e1`. */
function integerLiteral(value: number, field: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new LighterValidationError("WS_TX_TYPE_INVALID", `${field} must be a safe integer`, {
      field,
    });
  }
  return String(value);
}

/** A transaction document as JSON text: verbatim when already serialised, encoded when not. */
function txDocument(txInfo: object | string): string {
  if (typeof txInfo === "string") {
    if (!txInfo.startsWith("{")) {
      throw new LighterValidationError(
        "WS_TX_INFO_INVALID",
        "tx_info given as a string must be a serialised JSON object document",
        { field: "tx_info" },
      );
    }
    return txInfo;
  }
  return encodeJson(txInfo);
}

/**
 * `JSON.stringify` that can also emit `bigint`, as a bare integer literal.
 *
 * `JSON.stringify` throws a bare `TypeError` on a `bigint`, and this package keeps protocol
 * integers as `bigint` by policy (`docs/decisions.md` D7), so a caller handing this builder a typed
 * transaction object would otherwise hit an opaque failure. Insertion order is preserved, matching
 * `JSON.stringify`.
 *
 * Not a substitute for `src/tx/serialize.ts`: that emits schema-ordered bytes and is the canonical
 * producer of `tx_info`. This is the convenience path for an already-plain object.
 */
function encodeJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    const encoded: string | undefined = JSON.stringify(value);
    return encoded ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map(encodeJson).join(",")}]`;
  }
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${encodeJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

// ---------------------------------------------------------------------------------------------
// Inbound decoding
// ---------------------------------------------------------------------------------------------

/**
 * A decoded inbound frame. Total: every possible input maps to exactly one of these, and
 * {@link decodeFrame} never throws.
 *
 * `body` is the **whole** parsed frame, not a stripped payload — the channel registry needs the
 * envelope fields (`channel`, `timestamp`, `offset`) as much as the payload, and re-splitting a
 * frame that was already split is how fields get lost.
 */
export type InboundFrame =
  /** `{"type":"connected"}` — the unsolicited post-handshake greeting. */
  | { kind: "connected" }
  /** `{"type":"ping"}` — answer with {@link buildPong}. */
  | { kind: "ping" }
  /** `subscribed/<family>`: the full current state of a channel. */
  | {
      kind: "snapshot";
      family: string;
      channelRaw?: string;
      normKey?: string;
      body: Record<string, unknown>;
    }
  /** `update/<family>`: a delta for `order_book`, a refresh for most others. */
  | {
      kind: "update";
      family: string;
      channelRaw?: string;
      normKey?: string;
      body: Record<string, unknown>;
    }
  /** `unsubscribed/<family>`: the unsubscribe ack. Shape undocumented (`[INFER]`, §2.2). */
  | {
      kind: "unsubscribed";
      family: string;
      channelRaw?: string;
      normKey?: string;
      body: Record<string, unknown>;
    }
  /** A `jsonapi/sendtx` or `jsonapi/sendtxbatch` reply. Shape unverified (`[INFER]`, §8.3). */
  | { kind: "ack"; id?: string; body: Record<string, unknown> }
  /** Any frame carrying a failure code, whatever its `type`. */
  | { kind: "error"; code: number; message: string; normKey?: string; body: Record<string, unknown> }
  /** A well-formed JSON object whose `type` this version does not know. Never fatal. */
  | { kind: "unknown"; type: string; body: unknown }
  /** Not a JSON object at all. `binary` means the frame data was not a string. */
  | { kind: "malformed"; reason: "binary" | "not-json" | "not-object"; raw: unknown };

/**
 * `code` values that mean success rather than failure when they appear at the top level of a frame.
 *
 * `200` is the REST convention the transaction ack inherits (`docs/spec/06-websocket.md` §8.3);
 * `0` is what the nested `order_book.code` uses. Both are accepted at the top level because the
 * envelope is undocumented and a snapshot that happens to echo its status must not be mistaken for
 * an error.
 */
const SUCCESS_CODES: ReadonlySet<number> = new Set<number>([0, 200]);

/**
 * Decode one inbound frame. Total — never throws, for any input.
 *
 * The classification ladder, in order:
 *
 * 1. Non-string data → `malformed:"binary"`. Binary frames are not part of this protocol
 *    (`docs/spec/06-websocket.md` §1.2/§2.1) and must never be interpreted as data; the transport
 *    closes with 4001.
 * 2. Unparseable text → `malformed:"not-json"`; valid JSON that is not an object (a scalar, an
 *    array, `null`) → `malformed:"not-object"`.
 * 3. `connected` / `ping`.
 * 4. **Anything carrying a failure `code`, whatever its `type`.** The error envelope is
 *    undocumented (`[INFER]`, §11): error frames may not carry `type:"error"` at all, so the
 *    numeric code is the discriminant, not the type. Only the top-level `code` is consulted — the
 *    order-book payload carries its own `order_book.code`, which is a nested status and not an
 *    envelope failure.
 * 5. `subscribed/` / `update/` / `unsubscribed/` prefixes.
 * 6. A transaction ack.
 * 7. Everything else → `unknown`. Not an error, not a throw: a server that adds a message type must
 *    not take this client down (`docs/protocol-notes.md` §10.2).
 *
 * Parsing goes through `parseFrameJson`, never `JSON.parse` directly: `transaction_time` is in
 * microseconds and only ~5.7× below 2^53, and `nonce`, `begin_nonce`, `offset` and
 * `last_updated_at` have no string twin. A `JSON.parse` reviver cannot repair this — by the time a
 * reviver runs the digits are gone — so the rewrite happens on the raw text.
 */
export function decodeFrame(data: unknown): InboundFrame {
  if (typeof data !== "string") return { kind: "malformed", reason: "binary", raw: data };

  let parsed: unknown;
  try {
    parsed = parseFrameJson(data);
  } catch {
    return { kind: "malformed", reason: "not-json", raw: data };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "not-object", raw: parsed };
  }

  const body: Record<string, unknown> = parsed as Record<string, unknown>;
  const type: string = ownString(body, "type") ?? "";

  if (type === "connected") return { kind: "connected" };
  if (type === "ping") return { kind: "ping" };

  const code: number | undefined = ownNumber(body, "code");
  if (type === "error" || (code !== undefined && !SUCCESS_CODES.has(code))) {
    const channelRaw: string | undefined = ownString(body, "channel");
    const message: string = ownString(body, "message") ?? ownString(body, "error") ?? "";
    const frame: { kind: "error"; code: number; message: string; body: Record<string, unknown> } = {
      kind: "error",
      code: code ?? 0,
      message,
      body,
    };
    return channelRaw === undefined
      ? frame
      : { ...frame, normKey: normaliseChannelKey(channelRaw) };
  }

  const family: string | null = familyFromType(type);
  if (family !== null) {
    if (type.startsWith("subscribed/")) return channelFrame("snapshot", family, body);
    if (type.startsWith("unsubscribed/")) return channelFrame("unsubscribed", family, body);
    // `update/`. One documented exception, below.
    return channelFrame(isMislabelledSnapshot(family, body) ? "snapshot" : "update", family, body);
  }

  if (isAckType(type) || ownProperty(body, "tx_hash") !== undefined) {
    const id: string | undefined = ackId(body);
    return id === undefined ? { kind: "ack", body } : { kind: "ack", id, body };
  }

  return { kind: "unknown", type, body };
}

/**
 * The order-book snapshot arrives with a misleading type in the published documentation.
 *
 * The example labelled "Subscribed" shows `"type":"update/order_book"`, while the reference client
 * and its fixtures prove the snapshot type is `subscribed/order_book`
 * (`docs/spec/06-websocket.md` §5.3). Classification is by prefix, with this stateless half of the
 * documented fallback: an `update/order_book` carrying no `begin_nonce` cannot be a delta, because
 * `begin_nonce` is the sequence number a delta expects to be applied on top of. The other half of
 * the rule — "the first message on a fresh subscription" — needs subscription state and belongs to
 * the client.
 *
 * Scoped to `order_book` deliberately. No other family has delta semantics, so no other family has
 * a snapshot/delta distinction to get wrong.
 */
function isMislabelledSnapshot(family: string, body: Record<string, unknown>): boolean {
  if (family !== "order_book") return false;
  if (ownProperty(body, "begin_nonce") !== undefined) return false;
  const nested: unknown = ownProperty(body, "order_book");
  if (typeof nested === "object" && nested !== null) {
    return ownProperty(nested as Record<string, unknown>, "begin_nonce") === undefined;
  }
  return true;
}

/**
 * Transaction-ack types.
 *
 * `docs/spec/06-websocket.md` §8.3 marks the ack envelope `[INFER]`: the working assumption is that
 * the reply echoes the request type. The bare spellings are accepted too, and {@link decodeFrame}
 * additionally treats any frame carrying a top-level `tx_hash` as an ack regardless of type — which
 * is what will keep the dispatcher working if the capture shows a different envelope.
 */
function isAckType(type: string): boolean {
  return (
    type === "jsonapi/sendtx" ||
    type === "jsonapi/sendtxbatch" ||
    type === "sendtx" ||
    type === "sendtxbatch"
  );
}

/** The correlation id, from the envelope or from a `data` wrapper. Numeric ids are stringified. */
function ackId(body: Record<string, unknown>): string | undefined {
  const direct: string | undefined = scalarAsString(ownProperty(body, "id"));
  if (direct !== undefined) return direct;
  const data: unknown = ownProperty(body, "data");
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return scalarAsString(ownProperty(data as Record<string, unknown>, "id"));
  }
  return undefined;
}

/** Build a channel-bearing frame, attaching `channelRaw`/`normKey` only when a channel is present. */
function channelFrame(
  kind: "snapshot" | "update" | "unsubscribed",
  family: string,
  body: Record<string, unknown>,
): InboundFrame {
  const channelRaw: string | undefined = ownString(body, "channel");
  const common =
    channelRaw === undefined
      ? { family, body }
      : { family, channelRaw, normKey: normaliseChannelKey(channelRaw), body };
  if (kind === "snapshot") return { kind: "snapshot", ...common };
  if (kind === "update") return { kind: "update", ...common };
  return { kind: "unsubscribed", ...common };
}

// ---------------------------------------------------------------------------------------------
// Routing resolution
// ---------------------------------------------------------------------------------------------

/**
 * Where a frame belongs, or why it could not be placed.
 *
 * `reason` is diagnostic, not an error: an unroutable frame is dropped with a warning. `ambiguous`
 * and `no-match` are kept distinct because they mean different things operationally — `ambiguous`
 * is a gap in this table, `no-match` is usually a subscription that was already torn down.
 */
export type RouteResult =
  | { routed: true; key: string }
  | { routed: false; reason: "no-channel" | "ambiguous" | "no-match" };

/**
 * Fields that discriminate one subscription of a family from another.
 *
 * Exactly the set named in `docs/spec/06-websocket.md` §2.3 step 3. Deliberately not widened:
 * every extra field is another way to synthesise a candidate, and a candidate that matches the
 * wrong active key routes market data to the wrong consumer — a failure with no visible symptom.
 */
const MARKET_FIELDS: readonly string[] = ["market_id", "market_index"];
const ACCOUNT_FIELDS: readonly string[] = ["account", "account_id"];
const RESOLUTION_FIELDS: readonly string[] = ["resolution"];

/**
 * Resolve which active subscription a frame belongs to. Pure, and it never throws.
 *
 * The five-step ladder from `docs/spec/06-websocket.md` §2.3, which exists because the inbound
 * `channel` value is not the outbound key for at least three channels:
 *
 * 1. Normalise the inbound `channel` to slash form and look it up. Hits for most channels.
 * 2. On a miss, reconstruct candidate keys from the family plus the discriminating fields the body
 *    carries. This is what routes `account_orders`, whose inbound `channel` is `account_orders:{M}`
 *    with the account index missing entirely — the account arrives in a sibling `account` field.
 * 3. On a miss, if exactly one active subscription belongs to that family, route to it. This is
 *    what routes `market_stats/all`, which is subscribed once and echoes a per-market channel.
 * 4. Otherwise `no-match`.
 *
 * **It never guesses between two candidates.** Two distinct active keys matching means `ambiguous`
 * and the frame is dropped; silently picking one would corrupt a book with another market's deltas.
 */
export function resolveRouteKey(f: InboundFrame, activeKeys: Iterable<string>): RouteResult {
  const family: string | undefined = "family" in f ? f.family : undefined;
  const normKey: string | undefined = "normKey" in f ? f.normKey : undefined;
  if (family === undefined && normKey === undefined) {
    return { routed: false, reason: "no-channel" };
  }

  const active: ReadonlySet<string> = activeKeys instanceof Set ? activeKeys : new Set(activeKeys);

  // (1) Exact hit on the normalised inbound channel.
  if (normKey !== undefined && active.has(normKey)) return { routed: true, key: normKey };

  const body: Record<string, unknown> | undefined =
    "body" in f && typeof f.body === "object" && f.body !== null
      ? (f.body as Record<string, unknown>)
      : undefined;

  // (2) Reconstructed candidates.
  if (body !== undefined) {
    const market: string | undefined = discriminator(body, family, MARKET_FIELDS);
    const account: string | undefined = discriminator(body, family, ACCOUNT_FIELDS);
    const resolution: string | undefined = discriminator(body, family, RESOLUTION_FIELDS);

    const candidates: Set<string> = new Set<string>();
    // The `account_orders` case: the inbound channel is a prefix of the real key.
    if (normKey !== undefined && account !== undefined) candidates.add(`${normKey}/${account}`);
    if (family !== undefined) {
      candidates.add(family);
      if (market !== undefined) candidates.add(`${family}/${market}`);
      if (account !== undefined) candidates.add(`${family}/${account}`);
      // Account-scoped per-market channels spell the market first: `account_orders/{M}/{A}`.
      if (market !== undefined && account !== undefined) {
        candidates.add(`${family}/${market}/${account}`);
      }
      // Candles: `candle/{M}/{R}`.
      if (market !== undefined && resolution !== undefined) {
        candidates.add(`${family}/${market}/${resolution}`);
      }
    }

    const matched: string[] = [];
    for (const candidate of candidates) if (active.has(candidate)) matched.push(candidate);
    if (matched.length === 1) return { routed: true, key: matched[0] as string };
    if (matched.length > 1) return { routed: false, reason: "ambiguous" };
  }

  // (3) Sole subscription of the family.
  if (family !== undefined) {
    let sole: string | undefined;
    let count: number = 0;
    for (const key of active) {
      if (familyOfKey(key) !== family) continue;
      count += 1;
      if (count > 1) return { routed: false, reason: "ambiguous" };
      sole = key;
    }
    if (count === 1 && sole !== undefined && familyFallbackIsSafe(normKey, sole)) {
      return { routed: true, key: sole };
    }
  }

  return { routed: false, reason: "no-match" };
}

/**
 * Whether the sole-subscription fallback may take a frame that named a channel we do not hold.
 *
 * This is a deliberate narrowing of step 4 in `docs/spec/06-websocket.md` §2.3, which says only
 * "on miss with exactly one active subscription of that family, route to it". Taken literally, an
 * `order_book:5` frame arriving while the only active book subscription is `order_book/0` would be
 * merged into market 0 — another market's deltas applied to a live book, with no symptom until
 * someone trades on the result. A dropped frame is diagnosed loudly by the client; a misrouted one
 * is invisible, so the asymmetry decides it.
 *
 * The fallback still applies in the three cases it exists for:
 *
 * - the server named no channel at all, so the inference is all there is;
 * - the inbound key is a **prefix** of ours, which is the `account_orders:{M}` wart — the account
 *   index is missing from the channel entirely;
 * - our key carries the `all` wildcard (`market_stats/all`), which is subscribed once and echoes a
 *   per-market channel on every message.
 *
 * Anything else is a genuine conflict: the server named a subscription we do not hold.
 */
function familyFallbackIsSafe(normKey: string | undefined, key: string): boolean {
  if (normKey === undefined) return true;
  const inbound: string[] = normKey.split("/");
  const held: string[] = key.split("/");
  if (held.includes("all")) return true;
  const shared: number = Math.min(inbound.length, held.length);
  for (let i = 0; i < shared; i += 1) {
    if (inbound[i] !== held[i]) return false;
  }
  return true;
}

/** The family of an outbound key: everything before the first `/`. `"order_book/0"` → `"order_book"`. */
function familyOfKey(key: string): string {
  const slash: number = key.indexOf("/");
  return slash < 0 ? key : key.slice(0, slash);
}

/**
 * Read a discriminating field, from the envelope first and then from the family-named payload.
 *
 * The one-level descent is what finds `market_stats.market_id`, which several channels carry only
 * inside their payload object. It is bounded to the payload the family names, so a `market_id`
 * buried in an unrelated nested structure cannot influence routing.
 */
function discriminator(
  body: Record<string, unknown>,
  family: string | undefined,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value: string | undefined = scalarAsString(ownProperty(body, field));
    if (value !== undefined) return value;
  }
  if (family === undefined) return undefined;
  const nested: unknown = ownProperty(body, family);
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return undefined;
  for (const field of fields) {
    const value: string | undefined = scalarAsString(
      ownProperty(nested as Record<string, unknown>, field),
    );
    if (value !== undefined) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------

/**
 * What to do about a WebSocket error code — the `docs/spec/06-websocket.md` §11 table, as data.
 *
 * The two entries that look wrong and are not:
 *
 * - `treat-as-success` for 30003 (`Already Subscribed`) and, on an unsubscribe, 30002
 *   (`Not Subscribed`). Both are the normal outcome of a resubscribe race after a reconnect.
 *   Classifying either as a failure makes reconnect flaky in exactly the situation reconnect exists
 *   for.
 * - `throttle` rather than a disconnect for 30009 / 23000. The socket is fine; only our send rate
 *   is not.
 */
export type WsErrorAction =
  /** Already in the state we wanted. Resolve the pending operation as if it had succeeded. */
  | "treat-as-success"
  /** Halve the outbound refill for 60 s. Do **not** disconnect. */
  | "throttle"
  /** Shrink `maxInflight` by 25 % and retry after 1 s. */
  | "reduce-inflight"
  /** This socket cannot take more subscriptions. Reject further ones, naming the limit. */
  | "fatal-socket"
  /** Get a fresh token and retry once, then surface a `LighterWsAuthError` on that subscription. */
  | "refresh-auth"
  /** We built a bad frame. Log it loudly with the offending payload and do not retry. */
  | "codec-bug"
  /** Nothing specific to do: hand it to the caller with the code intact. */
  | "surface";

/** Context that changes the meaning of a code. Both flags default to false. */
export interface WsErrorContext {
  /** The failing operation was an unsubscribe. Makes 30002 a success. */
  readonly onUnsubscribe?: boolean;
  /** The subscription carried an auth token. Makes 30012 an auth-refresh candidate. */
  readonly authed?: boolean;
}

/**
 * Map a server error code to the action the client should take.
 *
 * Unlisted codes return `surface`, with the numeric code preserved by the caller — the code space is
 * open and server-controlled, and neither reference SDK documents it, so a code this table has never
 * seen must reach the caller rather than be reinterpreted.
 *
 * Note what is deliberately **not** here: 61005 (api token not found) and 61006 (api token revoked)
 * are documented codes but carry no entry in the §11 action table, so they return `surface`. A
 * revoked token is not fixed by fetching another one, and inventing a retry for it would loop.
 */
export function classifyWsError(code: number, ctx?: WsErrorContext): WsErrorAction {
  switch (code) {
    case WS_ERR_ALREADY_SUBSCRIBED:
      return "treat-as-success";
    case WS_ERR_NOT_SUBSCRIBED:
      // Only on an unsubscribe. Anywhere else it means our subscription table is wrong, which the
      // caller needs to see rather than have swallowed.
      return ctx?.onUnsubscribe === true ? "treat-as-success" : "surface";
    case WS_ERR_TOO_MANY_MESSAGES:
    case WS_ERR_TOO_MANY_REQUESTS:
      return "throttle";
    case WS_ERR_TOO_MANY_INFLIGHT:
      return "reduce-inflight";
    case WS_ERR_TOO_MANY_SUBSCRIPTIONS:
    case WS_ERR_TOO_MANY_ACCOUNTS:
    case WS_ERR_TOO_MANY_CONNECTIONS:
      return "fatal-socket";
    case WS_ERR_API_KEY_NOT_FOUND:
    case WS_ERR_INVALID_API_KEY_INDEX:
    case WS_ERR_INVALID_SIGNATURE:
      return "refresh-auth";
    case WS_ERR_FAILED_TO_SUBSCRIBE:
      // 30012 is generic; it is only an auth signal on a channel that carried a token.
      return ctx?.authed === true ? "refresh-auth" : "surface";
    case WS_ERR_INVALID_JSON:
    case WS_ERR_INVALID_TYPE:
    case WS_ERR_INVALID_CHANNEL:
    case WS_ERR_INVALID_DATA:
      return "codec-bug";
    default:
      return "surface";
  }
}

// ---------------------------------------------------------------------------------------------
// Upgrade-failure seam
// ---------------------------------------------------------------------------------------------

/**
 * The plain HTTPS URL to probe when a WebSocket upgrade is refused.
 *
 * A refused upgrade carries **no payload**: the observed close is `1006` with
 * `"Expected 101 status code"`, which names nothing. The same URL requested over HTTPS returns the
 * real reason in a normal error body — HTTP 400 with code 20558 from a restricted jurisdiction, for
 * instance (`docs/protocol-notes.md` §8.3, and the `captureFailed` block in
 * `test/fixtures/ws/capture.json`, which is why that fixture has no frames).
 *
 * Pure: this only rewrites the scheme. The transport performs the request and hands the result to
 * {@link diagnoseUpgradeFailure}.
 */
export function upgradeProbeUrl(streamUrl: string): string {
  if (streamUrl.startsWith("wss://")) return `https://${streamUrl.slice("wss://".length)}`;
  if (streamUrl.startsWith("ws://")) return `http://${streamUrl.slice("ws://".length)}`;
  return streamUrl;
}

/** What a probe of the stream URL revealed about a refused upgrade. */
export interface UpgradeDiagnosis {
  /** The HTTP status the probe saw. */
  readonly status: number;
  /** The API's numeric code, when the body carried one. */
  readonly code?: number;
  /** The API's message, verbatim. Empty when the body was not a Lighter error document. */
  readonly message: string;
  /** True for code 20558 — the geo-block, which is neither a bug nor a transient failure. */
  readonly restricted: boolean;
}

/** Code 20558: accessing Lighter from a restricted jurisdiction. Blocks writes and the stream. */
const RESTRICTED_JURISDICTION: 20558 = 20558;

/**
 * Interpret the body of a probe against the stream URL.
 *
 * Total, like {@link decodeFrame}, and for the same reason: the body may be an HTML interstitial
 * from the CDN rather than a Lighter error document, and a `SyntaxError` thrown while explaining a
 * connection failure would replace one confusing error with another.
 */
export function diagnoseUpgradeFailure(status: number, bodyText: string): UpgradeDiagnosis {
  let parsed: unknown;
  try {
    parsed = parseFrameJson(bodyText);
  } catch {
    return { status, message: "", restricted: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status, message: "", restricted: false };
  }
  const body: Record<string, unknown> = parsed as Record<string, unknown>;
  const code: number | undefined = ownNumber(body, "code");
  const message: string = ownString(body, "message") ?? "";
  const restricted: boolean = code === RESTRICTED_JURISDICTION;
  return code === undefined
    ? { status, message, restricted }
    : { status, code, message, restricted };
}

// ---------------------------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------------------------

/**
 * An own property, or `undefined`.
 *
 * `hasOwn`-guarded so a key that happens to name something on `Object.prototype` cannot be read off
 * the prototype chain, and never case-folded: candle payloads use `v` for base volume and `V` for
 * quote volume, so any case-insensitive lookup silently swaps two different numbers.
 */
function ownProperty(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** An own property that is a string. */
function ownString(o: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = ownProperty(o, key);
  return typeof value === "string" ? value : undefined;
}

/** An own property that is a finite number. */
function ownNumber(o: Record<string, unknown>, key: string): number | undefined {
  const value: unknown = ownProperty(o, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A scalar rendered as the text a channel key would use.
 *
 * Numbers must be integers: a channel key never contains `1.5`, and accepting one would synthesise a
 * candidate that can only ever be wrong. `bigint` is accepted because `parseFrameJson` may hand back
 * a wide id, and strings pass through untouched — the wire's decimal text is authoritative.
 */
function scalarAsString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : undefined;
  if (typeof value === "bigint") return value.toString();
  return undefined;
}
