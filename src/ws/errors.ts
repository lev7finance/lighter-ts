/**
 * WebSocket error taxonomy: seven classes, one structural guard, and the documented code bands.
 *
 * Everything here extends `LighterError` with `kind: "ws"`, so a caller that only knows about
 * `isLighterError` still gets a useful error, and a caller that wants to branch on the WebSocket
 * layer specifically uses {@link isLighterWsError} plus {@link LighterWsError.wsKind}.
 *
 * Three properties of this module are load-bearing:
 *
 * 1. **Guards are structural, never `instanceof`.** `docs/ARCHITECTURE.md` ADR-8: `instanceof`
 *    breaks across bundler chunks and realms, and this package ships ESM-only partly for the same
 *    reason. The brand (`_tag`) and the discriminant (`kind`) are plain data, so an error that
 *    crossed a structured-clone or a duplicated-module boundary is still recognised.
 * 2. **The numeric code survives intact.** Neither reference SDK documents the WebSocket error
 *    envelope, and the server's code set is open (`docs/spec/06-websocket.md` §11 is `[DOC]` for the
 *    codes and `[INFER]` for the envelope). `code` is therefore `number`, never a closed union, and
 *    an unlisted code reaches the caller unmodified rather than being flattened into a generic
 *    failure.
 * 3. **The constants below are conveniences, not an enumeration.** They exist so call sites read as
 *    `WS_ERR_ALREADY_SUBSCRIBED` rather than `30003`; they do not constrain what may arrive.
 *
 * `LighterWsPool` was cut from v1 (`docs/decisions.md` D10) and is deliberately not named in any
 * message here.
 *
 * Side-effect free at import: constructing an error reads no clock, opens no socket, and touches no
 * global.
 */

import { LighterError, isLighterError, type LighterErrorOptions } from "../errors.js";

/**
 * Which WebSocket failure this is, as plain data.
 *
 * Exists because the class identity cannot be trusted across a realm boundary (ADR-8) — this is the
 * field a consumer switches on.
 */
export type WsErrorTag =
  | "generic"
  | "auth"
  | "rate-limit"
  | "timeout"
  | "read-only"
  | "overflow"
  | "closed";

/** Options common to every WebSocket error. */
export interface LighterWsErrorOptions extends LighterErrorOptions {
  /**
   * The server's numeric code, verbatim. Absent for failures we raised locally (a read-only socket,
   * a dropped-frame overflow) that the server never saw.
   */
  readonly code?: number;
  /**
   * The subscription this failure belongs to, in the outbound slash spelling where the caller knows
   * it. Absent for connection-level failures.
   */
  readonly channel?: string;
  /** @internal Subclass hook so each class stamps its own {@link WsErrorTag}. */
  readonly wsKind?: WsErrorTag;
}

/**
 * Base of the WebSocket hierarchy, and directly constructible — an inbound `error` frame whose code
 * falls in none of the specialised bands becomes exactly this.
 */
export class LighterWsError extends LighterError {
  declare readonly code?: number;
  /** Discriminant for structural branching. See {@link WsErrorTag}. */
  readonly wsKind: WsErrorTag;
  declare readonly channel?: string;

  constructor(message: string, options?: LighterWsErrorOptions) {
    super("ws", message, options);
    this.name = "LighterWsError";
    this.wsKind = options?.wsKind ?? "generic";
    if (options?.channel !== undefined) this.channel = options.channel;
  }
}

/**
 * A per-subscription auth token was refused, or refused again after one refresh.
 *
 * Authentication on this protocol is per-subscription, not per-connection
 * (`docs/spec/06-websocket.md` §1.4), so this error scopes to a channel and never to the socket.
 */
export class LighterWsAuthError extends LighterWsError {
  constructor(message: string, options?: LighterWsErrorOptions) {
    super(message, { ...options, wsKind: "auth" });
    this.name = "LighterWsAuthError";
  }
}

/** Options for {@link LighterWsRateLimitError}. */
export interface LighterWsRateLimitErrorOptions extends LighterWsErrorOptions {
  /**
   * Which budget was exhausted, named the way the documentation names it — `"subscriptions"`,
   * `"connections"`, `"messages"`. Required: an unnamed limit is not actionable.
   */
  readonly limit: string;
}

/** A documented server budget was exhausted (the 23000–23004 band, or 30009 / 30010). */
export class LighterWsRateLimitError extends LighterWsError {
  readonly limit: string;

  constructor(message: string, options: LighterWsRateLimitErrorOptions) {
    super(message, { ...options, wsKind: "rate-limit" });
    this.name = "LighterWsRateLimitError";
    this.limit = options.limit;
  }
}

/** Options for {@link LighterWsTimeoutError}. */
export interface LighterWsTimeoutErrorOptions extends LighterWsErrorOptions {
  /**
   * The locally computed transaction hash, when the timeout was a transaction ack.
   *
   * Carried because a missing ack does **not** mean the transaction failed: the signed hash is
   * authoritative and identical to the server's (`docs/spec/06-websocket.md` §8.4), so the caller
   * can still resolve the outcome with `GET /api/v1/tx?by=hash`. Dropping the hash here would strip
   * the only recovery path.
   */
  readonly txHash?: string;
}

/** No reply arrived inside the budget — a transaction ack, or the post-upgrade `connected` frame. */
export class LighterWsTimeoutError extends LighterWsError {
  declare readonly txHash?: string;

  constructor(message: string, options?: LighterWsTimeoutErrorOptions) {
    super(message, { ...options, wsKind: "timeout" });
    this.name = "LighterWsTimeoutError";
    if (options?.txHash !== undefined) this.txHash = options.txHash;
  }
}

/**
 * A transaction frame was attempted on a socket opened with `?readonly=true`.
 *
 * Raised client-side before anything reaches the wire (`docs/spec/06-websocket.md` §8.5) — the
 * server's refusal of such a frame is undocumented and would be harder to attribute.
 */
export class LighterWsReadOnlyError extends LighterWsError {
  constructor(
    message: string = "this socket was opened read-only and cannot send transactions",
    options?: LighterWsErrorOptions,
  ) {
    super(message, { ...options, wsKind: "read-only" });
    this.name = "LighterWsReadOnlyError";
  }
}

/** Options for {@link LighterWsOverflowError}. */
export interface LighterWsOverflowErrorOptions extends LighterWsErrorOptions {
  /** How many frames were discarded. Required — an overflow with an unknown count is not a report. */
  readonly dropped: number;
}

/**
 * A consumer fell behind and frames were discarded rather than buffered without bound.
 *
 * Purely local: the server is not involved and there is no code.
 */
export class LighterWsOverflowError extends LighterWsError {
  readonly dropped: number;

  constructor(message: string, options: LighterWsOverflowErrorOptions) {
    super(message, { ...options, wsKind: "overflow" });
    this.name = "LighterWsOverflowError";
    this.dropped = options.dropped;
  }
}

/** Options for {@link LighterWsClosedError}. */
export interface LighterWsClosedErrorOptions extends LighterWsErrorOptions {
  /** The RFC 6455 close code. `4000` (staleness) and `4001` (fatal protocol error) are ours. */
  readonly wsCode: number;
  /** The close frame's reason text, verbatim. Often empty, and often uninformative when present. */
  readonly wsReason?: string;
}

/**
 * The socket closed, or never opened.
 *
 * **A refused upgrade is the important case.** It carries no payload at all: the observed close is
 * `1006` with `"Expected 101 status code"`, which names nothing. The real cause is only visible by
 * issuing a plain HTTPS GET against the same stream URL, which returns HTTP 400 with a body such as
 * code `20558` (restricted jurisdiction) — `docs/protocol-notes.md` §8.3, and the reason
 * `test/fixtures/ws/capture.json` is empty. The seam for that probe is
 * `diagnoseUpgradeFailure` / `upgradeProbeUrl` in `./protocol.js`; its result belongs in `code` and
 * `message` on this error, so the caller sees the jurisdiction text rather than
 * `"Expected 101 status code"`.
 */
export class LighterWsClosedError extends LighterWsError {
  readonly wsCode: number;
  declare readonly wsReason?: string;

  constructor(message: string, options: LighterWsClosedErrorOptions) {
    super(message, { ...options, wsKind: "closed" });
    this.name = "LighterWsClosedError";
    this.wsCode = options.wsCode;
    if (options.wsReason !== undefined) this.wsReason = options.wsReason;
  }
}

/**
 * Structural guard for every error in this module.
 *
 * True for any object carrying the `LighterError` brand and `kind: "ws"`, whoever constructed it —
 * including a plain object rebuilt from `toJSON` or delivered by `structuredClone`, which is
 * precisely the case `instanceof` gets wrong (ADR-8).
 */
export function isLighterWsError(e: unknown): e is LighterWsError {
  return isLighterError(e) && (e as unknown as Record<string, unknown>)["kind"] === "ws";
}

/*
 * Documented codes. `docs/spec/06-websocket.md` §11, sourced `[DOC]` from
 * `apidocs.lighter.xyz/docs/data-structures-constants-and-errors`. The set is open and
 * server-controlled: these are names for the codes we know about, not a bound on what may arrive.
 *
 * None of them is verified by live capture — see the header of `docs/spec/06-websocket.md` and the
 * `captureFailed` block in `test/fixtures/ws/capture.json`.
 */

/** 30000 — `Invalid Json`. Our frame was not parseable. A codec bug on our side. */
export const WS_ERR_INVALID_JSON: 30000 = 30000;
/** 30001 — `Invalid Type`. The `type` we sent is not one the server knows. A codec bug on our side. */
export const WS_ERR_INVALID_TYPE: 30001 = 30001;
/** 30002 — `Not Subscribed to _`. On an unsubscribe this is the success case, not a failure. */
export const WS_ERR_NOT_SUBSCRIBED: 30002 = 30002;
/** 30003 — `Already Subscribed to _`. The normal outcome of a resubscribe race; treat as success. */
export const WS_ERR_ALREADY_SUBSCRIBED: 30003 = 30003;
/** 30004 — `Failed to fetch _`. Server-side data fetch failed; retryable. */
export const WS_ERR_FAILED_TO_FETCH: 30004 = 30004;
/** 30005 — `Invalid Channel`. We built a channel key the server does not recognise. */
export const WS_ERR_INVALID_CHANNEL: 30005 = 30005;
/** 30006 — `Operation isn't supported _`. */
export const WS_ERR_OPERATION_NOT_SUPPORTED: 30006 = 30006;
/** 30007 — `Invalid Data`. Our payload was structurally wrong. A codec bug on our side. */
export const WS_ERR_INVALID_DATA: 30007 = 30007;
/** 30008 — `Invalid account type`. */
export const WS_ERR_INVALID_ACCOUNT_TYPE: 30008 = 30008;
/** 30009 — `Too Many Websocket Messages!`. Tighten the outbound bucket; do **not** disconnect. */
export const WS_ERR_TOO_MANY_MESSAGES: 30009 = 30009;
/** 30010 — `Too Many Inflight Messages!`. Shrink the inflight ceiling and retry. */
export const WS_ERR_TOO_MANY_INFLIGHT: 30010 = 30010;
/** 30011 — `Failed to connect`. */
export const WS_ERR_FAILED_TO_CONNECT: 30011 = 30011;
/** 30012 — `Failed to subscribe`. On an authed channel this is usually a stale token. */
export const WS_ERR_FAILED_TO_SUBSCRIBE: 30012 = 30012;

/** 23000 — `Too Many Requests!`. Same treatment as 30009. */
export const WS_ERR_TOO_MANY_REQUESTS: 23000 = 23000;
/** 23001 — `Too Many Subscriptions!`. Fatal for this socket: no further subscribes will succeed. */
export const WS_ERR_TOO_MANY_SUBSCRIPTIONS: 23001 = 23001;
/** 23002 — `Too Many Different Accounts!`. The 500-unique-accounts-per-connection ceiling. */
export const WS_ERR_TOO_MANY_ACCOUNTS: 23002 = 23002;
/** 23003 — `Too Many Connections!`. The per-IP connection ceiling. */
export const WS_ERR_TOO_MANY_CONNECTIONS: 23003 = 23003;
/** 23004 — `Too Many L2 Withdrawal Requests!`. */
export const WS_ERR_TOO_MANY_WITHDRAWALS: 23004 = 23004;

/** 21109 — api key not found. */
export const WS_ERR_API_KEY_NOT_FOUND: 21109 = 21109;
/** 21110 — invalid api key index. */
export const WS_ERR_INVALID_API_KEY_INDEX: 21110 = 21110;
/** 21120 — invalid signature. */
export const WS_ERR_INVALID_SIGNATURE: 21120 = 21120;
/** 61005 — api token not found, or does not belong to this account. */
export const WS_ERR_API_TOKEN_NOT_FOUND: 61005 = 61005;
/** 61006 — api token has already been revoked. */
export const WS_ERR_API_TOKEN_REVOKED: 61006 = 61006;

/**
 * The name of the budget a rate-limit code refers to, for {@link LighterWsRateLimitError.limit}.
 *
 * `undefined` for any code that is not a rate limit, so a caller can use this as the test as well as
 * the lookup.
 */
export function wsLimitName(code: number): string | undefined {
  switch (code) {
    case WS_ERR_TOO_MANY_MESSAGES:
    case WS_ERR_TOO_MANY_REQUESTS:
      return "messages";
    case WS_ERR_TOO_MANY_INFLIGHT:
      return "inflight";
    case WS_ERR_TOO_MANY_SUBSCRIPTIONS:
      return "subscriptions";
    case WS_ERR_TOO_MANY_ACCOUNTS:
      return "accounts";
    case WS_ERR_TOO_MANY_CONNECTIONS:
      return "connections";
    case WS_ERR_TOO_MANY_WITHDRAWALS:
      return "l2-withdrawals";
    default:
      return undefined;
  }
}
