/**
 * The one error hierarchy for `lighter-ts`.
 *
 * Every failure the SDK can produce — a bad config, a rejected transaction, a CDN interstitial, an
 * expired auth token — surfaces as a {@link LighterError}, and every diagnostic that leaves the SDK
 * has been through {@link redact} first.
 *
 * Three properties are load-bearing and easy to get backwards:
 *
 * 1. **Guards are structural.** They key on `_tag` and `kind`, never on `instanceof`. `instanceof`
 *    breaks across bundler chunks and realms (Workers, iframes, `vm` contexts) — the same reason
 *    this package refuses a CJS build. Class names do not survive minification either, so `name` is
 *    set explicitly but never used for dispatch.
 * 2. **The domain code set is open.** `LighterApiError.code` is `number`, not a union. The named
 *    constants below are conveniences, not an enumeration: neither reference SDK documents any of
 *    these codes (Go defines only `CodeOK = 200`, Python's `errors.py` is two lines), so an
 *    unobserved code such as `31337` must reach the caller intact.
 * 3. **No query strings on errors.** The API accepts the auth token as an `auth` query parameter
 *    (`docs/protocol-notes.md` §8.1.1), so {@link LighterApiError.path} is the path alone. That is
 *    why `path` and `requestId` are separate fields rather than a stashed `Request`.
 *
 * Two shapes that look like they should exist and must not:
 *
 * - There is no 404-keyed error. "Not found" is **HTTP 400 with `code: 29404`**
 *   (`GET /api/v1/account?by=index&value=999999999`), so anything keyed on HTTP 404 can never fire.
 * - There is no helper here that decides whether a response succeeded. The rule is HTTP-status-first
 *   — a response is an error if the status is not 2xx, **or** `code` is present and not 200 — and a
 *   missing `code` is success (`GET /withdrawalDelay?account_index=1` returns `{"seconds":1542}`
 *   with no `code` at all). The transport unit owns that predicate.
 *
 * Constructing an error is side-effect free: no clock, no network, no `crypto`.
 */

import { redact } from "./util/redact.js";

/** Coarse failure domain. The discriminant every structural guard reads. */
export type LighterErrorKind =
  | "config"
  | "validation"
  | "math"
  | "signature"
  | "nonce"
  | "network"
  | "timeout"
  | "http"
  | "auth"
  | "blocked"
  | "decode"
  | "ws";

/**
 * Stable machine-readable identifiers for local (client-side) validation failures.
 *
 * These are **ours**, not the server's — they mirror the reference validator's sentinel errors so a
 * transaction that the sequencer would reject is rejected here first, with the same identity. The
 * union carries the known set for autocompletion while `(string & {})` keeps it open, so a unit
 * that needs a new identifier is not blocked on editing this file.
 */
export type LighterValidationCode =
  "ACCOUNT_INDEX_TOO_HIGH"
  | "ACCOUNT_INDEX_TOO_LOW"
  | "ACCOUNT_MUST_BE_INSURANCE_OPERATOR"
  | "ACCOUNT_MUST_BE_TREASURY"
  | "ACCOUNT_TRADING_MODE_INVALID"
  | "API_KEY_INDEX_TOO_HIGH"
  | "API_KEY_INDEX_TOO_LOW"
  | "APPROVAL_EXPIRY_INVALID"
  | "APPROVAL_EXPIRY_ZERO_ON_REVOCATION"
  | "ASSET_INDEX_TOO_HIGH"
  | "ASSET_INDEX_TOO_LOW"
  | "ASSET_MARGIN_MODE_INVALID"
  | "ATTRIBUTE_TYPE_INVALID"
  | "ATTRIBUTE_VALUE_OUT_OF_RANGE"
  | "BASE_AMOUNT_NOT_NIL"
  | "BASE_AMOUNT_TOO_HIGH"
  | "BASE_AMOUNT_TOO_LOW"
  | "BASE_AMOUNTS_NOT_EQUAL"
  | "CANCEL_ALL_MARKET_CANT_BE_SCHEDULED"
  | "CANCEL_ALL_MARKET_INDEX_RANGE"
  | "CANCEL_ALL_TIF_INVALID"
  | "CANCEL_ALL_TIME_NOT_NIL"
  | "CANCEL_ALL_TIME_OUT_OF_RANGE"
  | "CANCEL_MODE_INVALID"
  | "CHILD_REDUCE_ONLY_MISMATCH"
  | "CLIENT_ORDER_INDEX_DUPLICATE"
  | "CLIENT_ORDER_INDEX_NOT_NIL"
  | "CLIENT_ORDER_INDEX_TOO_HIGH"
  | "CLIENT_ORDER_INDEX_TOO_LOW"
  | "EXPIRED_AT_INVALID"
  | "FEE_TOO_HIGH"
  | "FROM_ACCOUNT_INDEX_TOO_HIGH"
  | "FROM_ACCOUNT_INDEX_TOO_LOW"
  | "GROUPING_TYPE_INVALID"
  | "IMF_TOO_HIGH"
  | "IMF_TOO_LOW"
  | "INTEGRATOR_ACCOUNT_INDEX_RANGE"
  | "INTEGRATOR_ACCOUNT_INDEX_TOO_HIGH"
  | "INTEGRATOR_ACCOUNT_INDEX_TOO_LOW"
  | "INTEGRATOR_FEE_RANGE"
  | "INTEGRATOR_REQUIRED_FOR_FEES"
  | "IS_ASK_INVALID"
  | "MARGIN_MODE_INVALID"
  | "MARKET_INDEX_INVALID"
  | "MARKET_INDEX_MISMATCH"
  | "MARKET_INDEX_NOT_PERPS"
  | "MARKET_INDEX_TOO_HIGH"
  | "MARKET_INDEX_TOO_LOW"
  | "MEMO_LENGTH_INVALID"
  | "NEGATIVE_MARGIN_AMOUNT"
  | "NONCE_SKIP_ATTRIBUTE_INVALID"
  | "NONCE_TOO_LOW"
  | "ORDER_EXPIRY_INVALID"
  | "ORDER_GROUP_SIZE_INVALID"
  | "ORDER_INDEX_TOO_HIGH"
  | "ORDER_INDEX_TOO_LOW"
  | "ORDER_REDUCE_ONLY_INVALID"
  | "ORDER_TIF_INVALID"
  | "ORDER_TRIGGER_PRICE_INVALID"
  | "ORDER_TYPE_INVALID"
  | "POOL_BURN_AMOUNT_TOO_HIGH"
  | "POOL_BURN_AMOUNT_TOO_LOW"
  | "POOL_INITIAL_SHARES_TOO_HIGH"
  | "POOL_INITIAL_SHARES_TOO_LOW"
  | "POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH"
  | "POOL_MIN_OPERATOR_SHARE_RATE_TOO_LOW"
  | "POOL_MINT_AMOUNT_TOO_HIGH"
  | "POOL_MINT_AMOUNT_TOO_LOW"
  | "POOL_OPERATOR_FEE_INVALID"
  | "POOL_STATUS_INVALID"
  | "PRICE_TOO_HIGH"
  | "PRICE_TOO_LOW"
  | "PUBKEY_INVALID"
  | "PUBLIC_POOL_INDEX_TOO_HIGH"
  | "PUBLIC_POOL_INDEX_TOO_LOW"
  | "ROUTE_TYPE_INVALID"
  | "SELF_TRADE_BEHAVIOR_MODE_RANGE"
  | "SELF_TRADE_EQUALITY_MODE_RANGE"
  | "SELF_TRADE_REDUCE_WITH_MAI"
  | "SELF_TRADE_SPEC_WITH_FEES"
  | "SIGNATURE_INVALID"
  | "STAKE_AMOUNT_TOO_HIGH"
  | "STAKE_AMOUNT_TOO_LOW"
  | "STAKING_POOL_INDEX_TOO_HIGH"
  | "STAKING_POOL_INDEX_TOO_LOW"
  | "STRATEGY_INDEX_INVALID"
  | "TO_ACCOUNT_INDEX_TOO_HIGH"
  | "TO_ACCOUNT_INDEX_TOO_LOW"
  | "TOO_MANY_ATTRIBUTES"
  | "TRANSFER_AMOUNT_TOO_HIGH"
  | "TRANSFER_AMOUNT_TOO_LOW"
  | "TRANSFER_FEE_NEGATIVE"
  | "TRANSFER_FEE_TOO_HIGH"
  | "UNSAFE_INTEGER"
  | "UNSTAKE_AMOUNT_TOO_HIGH"
  | "UNSTAKE_AMOUNT_TOO_LOW"
  | "UPDATE_MARGIN_DIRECTION_INVALID"
  | "WITHDRAWAL_AMOUNT_TOO_HIGH"
  | "WITHDRAWAL_AMOUNT_TOO_LOW"
  // The set is open: a new identifier does not require editing this file.
  | (string & {});

/** Options common to every error in the hierarchy. */
export interface LighterErrorOptions {
  /** The underlying failure, preserved verbatim. Serialised through `redact` in {@link LighterError.toJSON}. */
  readonly cause?: unknown;
  /** Machine-readable code. Subclasses narrow this; the base leaves it open. */
  readonly code?: string | number;
}

/** Values that can be serialised into a diagnostic object. */
type Json = Record<string, unknown>;

/** Convert `bigint` (and other non-JSON primitives) so `JSON.stringify` cannot throw on a diagnostic. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return (value as readonly unknown[]).map(jsonSafe);
  if (Object.prototype.toString.call(value) !== "[object Object]") return value;
  const out: Json = {};
  for (const key of Object.keys(value)) {
    out[key] = jsonSafe((value as Json)[key]);
  }
  return out;
}

/**
 * Base of the hierarchy. Directly constructible, which is what the `decode` and `ws` kinds use
 * until they need fields of their own.
 */
export class LighterError extends Error {
  /** Brand. Survives minification and realm boundaries; the guards read this, never the class. */
  readonly _tag: "LighterError" = "LighterError";
  readonly kind: LighterErrorKind;
  declare readonly code?: string | number;

  constructor(kind: LighterErrorKind, message: string, options?: LighterErrorOptions) {
    // ES2022 `Error(message, { cause })`. Passed only when present so `cause` is not installed as
    // an own property holding `undefined`.
    super(message, options !== undefined && options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LighterError";
    this.kind = kind;
    if (options !== undefined && options.code !== undefined) this.code = options.code;
  }

  /**
   * Plain, JSON-safe, **redacted** projection of this error.
   *
   * Contains `name`, `_tag`, `kind`, `code`, `message`, the subclass's own fields and `cause`.
   * Never contains a stack (noisy, environment-specific, and able to quote credential-bearing
   * source text) and never a query string (`path` is stripped at construction).
   */
  toJSON(): Record<string, unknown> {
    const out: Json = {
      name: this.name,
      _tag: this._tag,
      kind: this.kind,
      message: this.message,
    };
    if (this.code !== undefined) out["code"] = this.code;
    for (const key of Object.keys(this)) {
      if (key === "_tag" || key === "kind" || key === "name" || key === "message") continue;
      out[key] = (this as unknown as Json)[key];
    }
    if (this.cause !== undefined) out["cause"] = this.cause;
    return jsonSafe(redact(out)) as Record<string, unknown>;
  }
}

/** Bad or missing configuration: no base URL, no chain id, an unusable key. */
export class LighterConfigError extends LighterError {
  constructor(message: string, options?: LighterErrorOptions) {
    super("config", message, options);
    this.name = "LighterConfigError";
  }
}

/** Options for {@link LighterValidationError}. */
export interface LighterValidationErrorOptions extends LighterErrorOptions {
  /** The offending field, spelled as the protocol spells it (`"Price"`, `"BaseAmount"`). */
  readonly field?: string;
  /** The transaction type code the rule belongs to, when it is type-specific. */
  readonly txType?: number;
  /** The bound that was violated, for message interpolation. `bigint` for protocol integers, `number` for indices and counts. */
  readonly bound?: bigint | number;
}

/**
 * A local validation rule rejected the input before anything was signed or sent.
 *
 * `code` is a stable string identifier, so callers branch on it rather than on message text.
 */
export class LighterValidationError extends LighterError {
  declare readonly code: LighterValidationCode;
  declare readonly field?: string;
  declare readonly txType?: number;
  declare readonly bound?: bigint | number;

  constructor(
    code: LighterValidationCode,
    message?: string,
    options?: LighterValidationErrorOptions,
  ) {
    super("validation", message ?? code, { ...options, code });
    this.name = "LighterValidationError";
    if (options !== undefined) {
      if (options.field !== undefined) this.field = options.field;
      if (options.txType !== undefined) this.txType = options.txType;
      if (options.bound !== undefined) this.bound = options.bound;
    }
  }
}

/** Codes for {@link LighterMathError}. Closed: these are ours and the set is small. */
export type LighterMathCode =
  | "EXCESSIVE_SLIPPAGE"
  | "INSUFFICIENT_DEPTH"
  | "NO_LIQUIDITY"
  | "NOT_REPRESENTABLE"
  | "SCALE_INVARIANT_VIOLATED";

/**
 * Order-sizing or decimal arithmetic could not produce a representable, safe answer.
 *
 * This is the class that fires instead of silently rounding — see `docs/protocol-notes.md` §9 for
 * the four float hazards in the reference that motivate it.
 */
export class LighterMathError extends LighterError {
  declare readonly code: LighterMathCode;

  constructor(code: LighterMathCode, message?: string, options?: LighterErrorOptions) {
    super("math", message ?? code, { ...options, code });
    this.name = "LighterMathError";
  }
}

/** Signing or verification failed: a malformed key, a rejected signature, a neutral public key. */
export class LighterSignatureError extends LighterError {
  constructor(message: string, options?: LighterErrorOptions) {
    super("signature", message, options);
    this.name = "LighterSignatureError";
  }
}

/** Options for {@link L1SignatureRequiredError}. */
export interface L1SignatureRequiredErrorOptions extends LighterErrorOptions {
  /** The exact EIP-191 message body the caller must have signed. Vector-pinned in `tx.json` → `l1Messages`. */
  readonly template: string;
  /** The L2 transaction type that requires the L1 signature. */
  readonly txType: number;
  readonly message?: string;
}

/**
 * A transaction type needs an Ethereum `personal_sign` and no `L1Signer` was supplied.
 *
 * Four flows reach this: `change_pub_key`, `transfer`, `approve_integrator`, `create_sub_account`
 * (`docs/decisions.md` D6). The SDK owns building the message; it never holds an L1 key.
 */
export class L1SignatureRequiredError extends LighterSignatureError {
  readonly template: string;
  readonly txType: number;

  constructor(options: L1SignatureRequiredErrorOptions) {
    super(
      options.message ?? `an L1 personal_sign is required for transaction type ${options.txType}`,
      options,
    );
    this.name = "L1SignatureRequiredError";
    this.template = options.template;
    this.txType = options.txType;
  }
}

/** Codes for {@link LighterNonceError}. */
export type LighterNonceCode = "INVALID_NONCE" | "LEASE_EXHAUSTED" | "KEY_UNKNOWN";

/**
 * Nonce allocation failed.
 *
 * A network timeout does **not** roll a lease back (`docs/ARCHITECTURE.md` ADR-14), so an exhausted
 * lease is a distinct, expected condition rather than a bug.
 */
export class LighterNonceError extends LighterError {
  declare readonly code: LighterNonceCode;

  constructor(code: LighterNonceCode, message?: string, options?: LighterErrorOptions) {
    super("nonce", message ?? code, { ...options, code });
    this.name = "LighterNonceError";
  }
}

/** Options for {@link LighterTransportError}. */
export interface LighterTransportErrorOptions extends LighterErrorOptions {
  /**
   * Whether the request may be safely re-attempted. Defaults to `true`: a `fetch` rejection means
   * DNS, TLS or a reset, none of which are known to have reached the origin.
   *
   * This is the predicate only. The GET-only retry **policy** lives in the transport unit.
   */
  readonly retryable?: boolean;
  /** @internal Subclass hook so {@link LighterTimeoutError} can carry `kind: "timeout"`. */
  readonly kind?: "network" | "timeout";
}

/** `fetch` never returned a response: DNS failure, TLS failure, connection reset, abort. */
export class LighterTransportError extends LighterError {
  readonly retryable: boolean;

  constructor(message: string, options?: LighterTransportErrorOptions) {
    super(options?.kind ?? "network", message, options);
    this.name = "LighterTransportError";
    this.retryable = options?.retryable ?? true;
  }
}

/** Our own `AbortSignal` fired before the response completed. */
export class LighterTimeoutError extends LighterTransportError {
  constructor(message: string = "request timed out", options?: LighterTransportErrorOptions) {
    super(message, { ...options, kind: "timeout", retryable: options?.retryable ?? true });
    this.name = "LighterTimeoutError";
  }
}

/** Options for {@link LighterApiError}. */
export interface LighterApiErrorOptions extends LighterErrorOptions {
  /** HTTP status. `400` for almost every domain error, `401` for `20013`. */
  readonly status: number;
  /** The **raw** domain code from the body. Never normalised, never remapped, never flattened. */
  readonly code: number;
  /** The server's `message`, verbatim — trailing whitespace and all. */
  readonly message?: string;
  /** Request path. A query string, if present, is stripped: it can carry the `auth` token. */
  readonly path?: string;
  /** `x-amz-cf-id`, when the response carried one. Useful on a support ticket. */
  readonly requestId?: string;
  /** The parsed body, redacted on serialisation. */
  readonly body?: unknown;
  /** @internal Subclass hook so {@link LighterAuthError} can carry `kind: "auth"`. */
  readonly kind?: "http" | "auth";
}

/**
 * The request reached the API and the API returned a structured refusal.
 *
 * Never retryable: the server made a decision, and repeating the request repeats the decision.
 */
export class LighterApiError extends LighterError {
  declare readonly code: number;
  readonly status: number;
  /** Server `message`, byte-for-byte. `"invalid param "` keeps its trailing space. */
  readonly messageText: string;
  /** {@link messageText} trimmed. For display only — nothing in the SDK may branch on message text. */
  readonly shortMessage: string;
  /** Path with no query string and no fragment. */
  readonly path: string;
  declare readonly requestId?: string;
  readonly body: unknown;

  constructor(options: LighterApiErrorOptions) {
    const messageText: string = options.message ?? "";
    const shortMessage: string = messageText.trim();
    const path: string = stripQuery(options.path ?? "");
    super(
      options.kind ?? "http",
      shortMessage.length > 0
        ? `${shortMessage} (code ${options.code}, HTTP ${options.status})`
        : `Lighter API error (code ${options.code}, HTTP ${options.status})`,
      { ...options, code: options.code },
    );
    this.name = "LighterApiError";
    this.status = options.status;
    this.messageText = messageText;
    this.shortMessage = shortMessage;
    this.path = path;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    this.body = options.body;
  }
}

/**
 * Why authentication was refused.
 *
 * `"deadline-or-signature"` is not laziness: `20013` deliberately conflates a bad deadline with a
 * bad signature, presumably to avoid a signature oracle. Do not try to infer which it was.
 */
export type LighterAuthReason = "malformed" | "expired" | "deadline-or-signature";

/** Options for {@link LighterAuthError}. */
export interface LighterAuthErrorOptions extends LighterApiErrorOptions {
  readonly reason: LighterAuthReason;
}

/**
 * The auth token was rejected — HTTP 401 with `code: 20013`.
 *
 * Note the status: every other domain error arrives as HTTP 400, so `kind` is never derived from
 * the status alone.
 */
export class LighterAuthError extends LighterApiError {
  readonly reason: LighterAuthReason;

  constructor(options: LighterAuthErrorOptions) {
    super({ ...options, kind: "auth" });
    this.name = "LighterAuthError";
    this.reason = options.reason;
  }
}

/** Options for {@link LighterBlockedError}. */
export interface LighterBlockedErrorOptions extends LighterErrorOptions {
  /** The body exactly as received — usually an HTML interstitial. */
  readonly rawBody: string;
  readonly status?: number;
  readonly path?: string;
  readonly requestId?: string;
  readonly message?: string;
}

/**
 * The CDN answered instead of the API — typically HTTP 403 with an HTML body from CloudFront
 * (`X-Cache: FunctionGeneratedResponse from cloudfront`), which never reached Lighter at all.
 *
 * This class exists so a raw `SyntaxError` from `JSON.parse` never reaches a caller.
 */
export class LighterBlockedError extends LighterError {
  readonly rawBody: string;
  declare readonly status?: number;
  declare readonly path?: string;
  declare readonly requestId?: string;

  constructor(options: LighterBlockedErrorOptions) {
    super(
      "blocked",
      options.message ??
        `request was answered by an intermediary, not the Lighter API${options.status !== undefined ? ` (HTTP ${options.status})` : ""}`,
      options,
    );
    this.name = "LighterBlockedError";
    this.rawBody = options.rawBody;
    if (options.status !== undefined) this.status = options.status;
    if (options.path !== undefined) this.path = stripQuery(options.path);
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
}

/**
 * Reduce a path-or-URL to its path. The query string is dropped unconditionally because the auth
 * token is accepted as an `auth` query parameter and would otherwise land in every log line.
 */
function stripQuery(pathOrUrl: string): string {
  let path: string = pathOrUrl;
  if (path.includes("://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* fall through to the string split */
    }
  }
  const query: number = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  const fragment: number = path.indexOf("#");
  if (fragment >= 0) path = path.slice(0, fragment);
  return path;
}

/**
 * Structural guard. True for anything carrying the brand and a string `kind`, whether or not it was
 * constructed by this module instance — which is the point: `instanceof` fails across bundler
 * chunks and realms.
 */
export function isLighterError(e: unknown): e is LighterError {
  if (typeof e !== "object" || e === null) return false;
  const candidate: Record<string, unknown> = e as Record<string, unknown>;
  return candidate["_tag"] === "LighterError" && typeof candidate["kind"] === "string";
}

/** Structural guard for {@link LighterApiError}: the API was reached and refused the request. */
export function isLighterApiError(e: unknown): e is LighterApiError {
  if (!isLighterError(e)) return false;
  const candidate: Record<string, unknown> = e as unknown as Record<string, unknown>;
  const kind: unknown = candidate["kind"];
  return (
    (kind === "http" || kind === "auth") &&
    typeof candidate["status"] === "number" &&
    typeof candidate["code"] === "number"
  );
}

/** Structural guard for {@link LighterAuthError}. */
export function isLighterAuthError(e: unknown): e is LighterAuthError {
  if (!isLighterApiError(e)) return false;
  const candidate: Record<string, unknown> = e as unknown as Record<string, unknown>;
  return candidate["kind"] === "auth" && typeof candidate["reason"] === "string";
}

/**
 * Whether re-issuing the request could plausibly succeed.
 *
 * True only for transport failures — a {@link LighterTransportError} marked `retryable` and every
 * {@link LighterTimeoutError}. Every {@link LighterApiError} is false, 429-derived ones included:
 * the server made a decision and repeating the request repeats it. Which *methods* may be retried
 * (GET only) is the transport unit's policy; this is just the predicate.
 */
export function isRetryable(e: unknown): boolean {
  if (!isLighterError(e)) return false;
  const candidate: Record<string, unknown> = e as unknown as Record<string, unknown>;
  const kind: unknown = candidate["kind"];
  if (kind === "timeout") return true;
  if (kind === "network") return candidate["retryable"] === true;
  return false;
}

/**
 * Compare an error's `code` without knowing its class — `hasCode(err, ERR_NOT_FOUND)`,
 * `hasCode(err, "ORDER_PRICE_TOO_LOW")`. Strict equality, so an unobserved numeric code works
 * exactly as well as a named one.
 */
export function hasCode(e: unknown, code: number | string): boolean {
  if (!isLighterError(e)) return false;
  return (e as unknown as Record<string, unknown>)["code"] === code;
}

/*
 * Observed domain codes. Conveniences, not an enumeration — the set is open and server-controlled,
 * and `LighterApiError.code` stays `number` precisely so an unlisted code survives intact.
 * Sources: `docs/protocol-notes.md` §8.1/§8.1.1 and `spec/05-rest-api.md` §4.2.
 */

/** Success, when the body carries a `code` at all. Some endpoints omit the field entirely. */
export const RESULT_OK: 200 = 200;
/** HTTP 400. Missing/invalid parameter, bad enum, absent auth. Message has a trailing space. */
export const ERR_INVALID_PARAM: 20001 = 20001;
/** HTTP **401**. Token unparseable, expired, or with a bad deadline/signature — deliberately conflated. */
export const ERR_INVALID_AUTH: 20013 = 20013;
/** HTTP 400. Geo-block. Fires on writes and the WS upgrade; public reads still succeed. */
export const ERR_RESTRICTED_JURISDICTION: 20558 = 20558;
/** HTTP 400. Unknown account. */
export const ERR_ACCOUNT_NOT_FOUND: 21100 = 21100;
/** HTTP 400. Unknown tx hash, sequence index, or L1 hash. */
export const ERR_TX_NOT_FOUND: 21500 = 21500;
/** HTTP 400. `market_id` out of range. */
export const ERR_INVALID_MARKET_INDEX: 21602 = 21602;
/** HTTP 400. Candle/PnL window too wide for the requested resolution. */
export const ERR_TIME_RANGE_EXCEEDED: 22403 = 22403;
/** HTTP **400** — not 404. Generic entity miss; the not-found signal lives entirely in `code`. */
export const ERR_NOT_FOUND: 29404 = 29404;
