/**
 * The one function in the REST stack that touches the network.
 *
 * Everything above it — the grouped facade, pagination, the trading client — routes through
 * {@link request}. Everything below it is data: `./routes.js` describes all 78 operations,
 * `../models/*` types them, `../errors.js` defines the hierarchy, and `../config/config.js`
 * resolves the endpoint profile and the injectable `fetch`.
 *
 * Four things here are easy to write wrongly, and each has already shipped wrong in a reference
 * SDK:
 *
 * 1. **The success predicate.** A response succeeded iff the HTTP status is 2xx **and** (`code` is
 *    absent **or** `code === 200`). A *missing* `code` is success —
 *    `GET /api/v1/withdrawalDelay?account_index=1` answers `{"seconds":1805}` with no `code` field
 *    at all, and so do `executeStats` and `referral/points`
 *    (`test/fixtures/rest/responses.json`, `docs/protocol-notes.md` §8.1). The Go reference reads
 *    `code` first and only then the status, and misclassifies exactly those three.
 * 2. **A non-JSON body is normal.** CloudFront sits in front of the origin and answers some
 *    requests itself with HTTP 403 and an HTML interstitial, on IP reputation rather than on path
 *    validity (`docs/protocol-notes.md` §8.2). The body is therefore read **once, as text**, and
 *    parsed by hand; the convenience parser on `Response` would throw a bare `SyntaxError` that
 *    names nothing and would consume the one read we get.
 * 3. **Authentication is undocumented in both reference SDKs.** The token travels either in the
 *    `Authorization` header with **no scheme prefix at all** or, interchangeably, in an `auth`
 *    query parameter — discovered from the error text
 *    `"invalid param : auth query param and Authorization header are empty"`. The header is
 *    preferred: the query form puts a bearer credential into URLs, access logs and referrers,
 *    which is also why {@link LighterApiError.path} carries no query string.
 * 4. **`User-Agent` is runtime-conditional** (`docs/decisions.md` D5). In a browser it is a
 *    forbidden header name and any header outside the server's closed CORS allow-list
 *    (`Content-Type, Origin, X-CSRF-Token, Authorization, AccessToken, Token, Range`) fails the
 *    preflight and takes the request down. Everywhere else its absence earns a 403 HTML
 *    interstitial on some paths. The environment check lives in `isBrowserLike()` and looks at the
 *    environment, never at a runtime name or an environment variable.
 *
 * Retry policy, stated once: idempotent `GET`s only, on transport failure, HTTP 429 and HTTP 5xx,
 * full-jittered exponential backoff (base 200 ms, factor 2, cap 5 s, 2 retries), honouring
 * `Retry-After`. **A `POST` is never retried** — `sendTx` is nonce-bound and a duplicate
 * submission is a real economic loss. The single bounded exception is an auth failure on a route
 * that carried a credential, which replays exactly once after re-invoking the `AuthProvider`
 * (clock skew, or a token that expired in flight).
 *
 * Platform surface: `fetch`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal`,
 * `setTimeout`. No Node built-ins, no globals read at module scope, no timers or randomness at
 * import time.
 */

import type { AuthProvider, LighterConfig, ResolvedConfig } from "../config/config.js";
import { resolveConfig } from "../config/config.js";
import type { LighterAuthReason } from "../errors.js";
import {
  isLighterError,
  isRetryable,
  LighterApiError,
  LighterAuthError,
  LighterBlockedError,
  LighterConfigError,
  LighterError,
  LighterTimeoutError,
  LighterTransportError,
  LighterValidationError,
} from "../errors.js";
import { redact } from "../util/redact.js";
import type { ParamsOf, ResponseOf, RouteDef } from "./route-types.js";

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * CloudFront's per-request identifier. The only response header worth keeping: it is what a
 * support ticket is answered from, and it is the sole identifier on a CDN interstitial that never
 * reached the API.
 */
export const REQUEST_ID_HEADER: "x-amz-cf-id" = "x-amz-cf-id";

/** 17 of the 18 `POST` operations. */
const FORM_CONTENT_TYPE: "application/x-www-form-urlencoded" = "application/x-www-form-urlencoded";

/** `setAccountMetadata` alone. */
const JSON_CONTENT_TYPE: "application/json" = "application/json";

/** Body `code` for success, where the endpoint sends one at all. */
const CODE_OK: 200 = 200;

/** HTTP **401** with this code: the auth token was refused. */
const CODE_INVALID_AUTH: 20013 = 20013;

/** HTTP 400 with this code: geo-restriction. Not a validation failure — see {@link LighterGeoRestrictedError}. */
const CODE_RESTRICTED_JURISDICTION: 20558 = 20558;

/**
 * Sentinel `code` for a non-2xx response whose JSON body carried no `code` field.
 *
 * `0` is safe as a sentinel because the protocol never assigns it meaning — it appears only on
 * vestigial nested structs (`spec/05-rest-api.md` §2.5, §3.3).
 */
const CODE_ABSENT: 0 = 0;

/* ---------------------------------------------------------------------------------------------- */
/* Geo-restriction                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Code `20558` — the request came from a restricted jurisdiction.
 *
 * Its own class because it arrives as **HTTP 400**, which makes it look like a parameter error,
 * and because the failure is bafflingly partial: every public read succeeds while `sendTx` and the
 * WebSocket upgrade fail (`docs/protocol-notes.md` §8.3). Flattened into a generic validation
 * error it costs hours; surfaced with the jurisdiction message verbatim it costs seconds.
 *
 * Structurally a {@link LighterApiError} (`kind: "http"`, `code: 20558`), so
 * `isLighterApiError()` and `hasCode(e, 20558)` both work across bundler chunks and realms.
 */
export class LighterGeoRestrictedError extends LighterApiError {
  /** Always `true`. The structural marker, since class identity does not survive minification. */
  readonly restricted: true = true;

  constructor(options: Omit<ConstructorParameters<typeof LighterApiError>[0], "kind">) {
    super(options);
    this.name = "LighterGeoRestrictedError";
  }
}

/** Structural guard for {@link LighterGeoRestrictedError}. Keys on the code, never on the class. */
export function isLighterGeoRestrictedError(e: unknown): e is LighterGeoRestrictedError {
  if (!isLighterError(e)) return false;
  return (e as unknown as Record<string, unknown>)["code"] === CODE_RESTRICTED_JURISDICTION;
}

/* ---------------------------------------------------------------------------------------------- */
/* Options                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Per-request options: everything {@link LighterConfig} carries, plus the four knobs that only
 * make sense for a single call.
 *
 * `sleep` and `random` are test seams, in the same spirit as the injected `fetch` and `now` on
 * {@link LighterConfig}: backoff is otherwise untestable without real timers and real jitter.
 * Production callers never set them.
 */
export interface RequestOptions extends LighterConfig {
  /** Caller's cancellation signal, composed with the per-attempt timeout. */
  signal?: AbortSignal;
  /** Return the untouched `Response` instead of a parsed body. The body is not read. */
  raw?: boolean;
  /**
   * Which channel carries the credential. Default `"header"`, and there is rarely a reason to
   * change it: `"query"` puts a bearer token into the URL, and therefore into access logs and
   * referrer headers. It exists for environments that strip the `Authorization` header.
   */
  authIn?: "header" | "query";
  /** Backoff sleeper. Default: `setTimeout`, cancelled by `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source in `[0, 1)`. Default `Math.random`. */
  random?: () => number;
}

/* ---------------------------------------------------------------------------------------------- */
/* URL and query serialisation                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** Drop every trailing `/` so `https://host/` and `https://host` behave identically. */
export function stripTrailingSlash(base: string): string {
  let end: number = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end -= 1;
  return base.slice(0, end);
}

/**
 * Render one scalar parameter.
 *
 * - `boolean` → `"true"` / `"false"` (lowercase literals, `spec/05-rest-api.md` §2.2).
 * - `bigint` → decimal, always exact. This is the channel for anything monetary.
 * - `number` → plain decimal, **never** exponent form. `String(5e21)` is `"5e+21"`, which the
 *   server rejects as an invalid param, and `String(2 ** 53)` has already lost precision before
 *   we see it. Both are refused here rather than sent as garbage.
 * - `string` → verbatim; percent-encoding is `URLSearchParams`' job, and it encodes the `:`
 *   separators inside an auth token exactly as the server expects.
 */
function formatScalar(value: unknown, key: string): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      return formatNumber(value, key);
    default:
      throw new LighterValidationError(
        "PARAM_NOT_SCALAR",
        `parameter "${key}" must be a string, number, bigint or boolean; received ${describe(value)}. ` +
          `Structured values travel as JSON-encoded strings in a single field ` +
          `(spec/05-rest-api.md §2.3), not as objects`,
        { field: key },
      );
  }
}

function formatNumber(value: number, key: string): string {
  if (!Number.isFinite(value)) {
    throw new LighterValidationError(
      "PARAM_NOT_FINITE",
      `parameter "${key}" must be a finite number; received ${String(value)}`,
      { field: key },
    );
  }
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new LighterValidationError(
        "UNSAFE_INTEGER",
        `parameter "${key}" is an integer outside the safe range and would serialise in exponent ` +
          `form or with lost precision (${String(value)}); pass a bigint or a decimal string`,
        { field: key },
      );
    }
    // A safe integer is always below 1e21, so `String` never reaches exponent notation.
    return String(value);
  }
  const rendered: string = String(value);
  if (rendered.includes("e") || rendered.includes("E")) {
    throw new LighterValidationError(
      "PARAM_NOT_REPRESENTABLE",
      `parameter "${key}" serialises in exponent form (${rendered}), which the server rejects; ` +
        `pass a decimal string`,
      { field: key },
    );
  }
  return rendered;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a nested array";
  return typeof value;
}

/**
 * Serialise a parameter object into a query string / form body.
 *
 * - `undefined` and `null` keys are **omitted entirely**. Several endpoints treat an empty string
 *   differently from an absent key, so sending `key=` is not equivalent.
 * - Arrays repeat the key (`?types=14&types=15`). Exactly two parameters are shaped that way:
 *   `accountTxs.types` and `transfer/history.type`. Every other array-shaped input is a
 *   JSON-encoded string in a single field and arrives here already stringified.
 * - Key order is the caller's insertion order, which keeps the output deterministic for tests.
 */
export function buildQuery(params?: unknown): URLSearchParams {
  const out: URLSearchParams = new URLSearchParams();
  if (params === undefined || params === null) return out;
  if (typeof params !== "object") {
    throw new LighterValidationError(
      "PARAMS_NOT_AN_OBJECT",
      `request parameters must be an object; received ${typeof params}`,
    );
  }
  const record: Record<string, unknown> = params as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value: unknown = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const element of value as readonly unknown[]) {
        if (element === undefined || element === null) continue;
        out.append(key, formatScalar(element, key));
      }
      continue;
    }
    out.append(key, formatScalar(value, key));
  }
  return out;
}

/**
 * Compose the absolute request URL.
 *
 * `base` is an **origin** — `/api/v1` belongs to the route, because `GET /` and `GET /info` sit at
 * the root and would be unreachable if the prefix lived in the base URL.
 *
 * Parameters become a query string for `GET` only; a `POST` carries them in its body. `extra`
 * appends already-formatted pairs (the `auth` query channel) after the caller's own.
 */
export function buildUrl(
  route: RouteDef,
  params?: unknown,
  base: string = "",
  extra?: Readonly<Record<string, string>>,
): string {
  const origin: string = stripTrailingSlash(base);
  const query: URLSearchParams = route.method === "GET" ? buildQuery(params) : new URLSearchParams();
  if (extra !== undefined) {
    for (const key of Object.keys(extra)) {
      const value: string | undefined = extra[key];
      if (value !== undefined) query.append(key, value);
    }
  }
  const serialised: string = query.toString();
  return serialised.length > 0 ? `${origin}${route.path}?${serialised}` : `${origin}${route.path}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Classification                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** Everything {@link classifyResponse} needs. Deliberately not a `Response`, so it is trivially testable. */
export interface ResponseFacts {
  /** HTTP status. */
  readonly status: number;
  /** The body, read **once**, as text. */
  readonly bodyText: string;
  /** Request path. A query string is stripped by the error constructors; pass the bare path. */
  readonly path: string;
  /** `x-amz-cf-id`, when the response carried one. */
  readonly requestId?: string;
}

/** The outcome of classifying one response. Total: {@link classifyResponse} never throws. */
export type Classification =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: LighterError };

/**
 * The success predicate, in one place so nobody re-derives it:
 *
 * > a response succeeded iff the HTTP status is 2xx **and** (`code` is absent **or** `code === 200`).
 *
 * `code` is `undefined` for the three endpoints that omit the field entirely.
 */
export function isSuccess(status: number, code: number | undefined): boolean {
  if (status < 200 || status > 299) return false;
  return code === undefined || code === CODE_OK;
}

/**
 * Turn a status + body text into either the parsed body or the right error. Pure and total.
 *
 * Order matters (`spec/05-rest-api.md` §11.3):
 *
 * 1. body is not JSON → {@link LighterBlockedError} carrying `rawBody`. The CloudFront/WAF case,
 *    and 5xx interstitials. **No `SyntaxError` ever escapes.**
 * 2. status not 2xx, body is JSON → {@link LighterApiError}, specialised to
 *    {@link LighterGeoRestrictedError} for code 20558 and {@link LighterAuthError} for HTTP 401 or
 *    code 20013.
 * 3. status 2xx and `code` present and not 200 → {@link LighterApiError}. Defence in depth: the
 *    two failure channels are independent, even though they have never been observed disagreeing.
 * 4. otherwise → the parsed body.
 */
export function classifyResponse(facts: ResponseFacts): Classification {
  const status: number = facts.status;
  const path: string = facts.path;

  let parsed: unknown;
  if (facts.bodyText.length === 0) {
    return {
      ok: false,
      error: blocked(facts, "the response body was empty"),
    };
  }
  try {
    parsed = JSON.parse(facts.bodyText) as unknown;
  } catch {
    // Not exceptional. The CDN answers some requests itself, on IP reputation rather than on path
    // validity: `/api/v1/currentHeight` — documented and working — returned 403 HTML from a
    // datacenter address (`docs/protocol-notes.md` §8.2).
    //
    // The parse failure is deliberately **not** attached as `cause`. A syntax error is not the
    // story — the intermediary is — and keeping it out of the causal chain is what guarantees no
    // caller ever unwraps one and starts branching on it.
    return { ok: false, error: blocked(facts) };
  }

  const code: number | undefined = readCode(parsed);
  if (isSuccess(status, code)) return { ok: true, body: parsed };

  const effectiveCode: number = code ?? CODE_ABSENT;
  const messageText: string | undefined = readMessage(parsed);
  const base = {
    status,
    code: effectiveCode,
    path,
    body: parsed,
    ...(messageText !== undefined ? { message: messageText } : {}),
    ...(facts.requestId !== undefined ? { requestId: facts.requestId } : {}),
  };

  if (effectiveCode === CODE_RESTRICTED_JURISDICTION) {
    return { ok: false, error: new LighterGeoRestrictedError(base) };
  }
  if (status === 401 || effectiveCode === CODE_INVALID_AUTH) {
    return { ok: false, error: new LighterAuthError({ ...base, reason: authReason(messageText) }) };
  }
  return { ok: false, error: new LighterApiError(base) };
}

function blocked(facts: ResponseFacts, message?: string): LighterBlockedError {
  return new LighterBlockedError({
    rawBody: facts.bodyText,
    status: facts.status,
    path: facts.path,
    ...(facts.requestId !== undefined ? { requestId: facts.requestId } : {}),
    ...(message !== undefined ? { message: `${message} (HTTP ${String(facts.status)})` } : {}),
  });
}

/** `code` off a JSON body, when it is present and numeric. Absence is meaningful — it means success. */
function readCode(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value: unknown = (parsed as Record<string, unknown>)["code"];
  return typeof value === "number" ? value : undefined;
}

/** `message` off a JSON body, verbatim — trailing whitespace and all. */
function readMessage(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value: unknown = (parsed as Record<string, unknown>)["message"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Best-effort reason for an auth refusal, for **display only**.
 *
 * Nothing in this SDK branches on message text — that rule is what keeps us honest about
 * `"invalid param "` and its trailing space. This is the one place text is read at all, and the
 * default is the honest one: `20013` deliberately conflates a bad deadline with a bad signature,
 * presumably to avoid a signature oracle, so `"deadline-or-signature"` is what we claim unless the
 * server itself distinguished the case.
 */
function authReason(messageText: string | undefined): LighterAuthReason {
  if (messageText === undefined) return "deadline-or-signature";
  const lower: string = messageText.toLowerCase();
  if (lower.includes("expired")) return "expired";
  if (lower.includes("invalid auth string")) return "malformed";
  return "deadline-or-signature";
}

/* ---------------------------------------------------------------------------------------------- */
/* Retry policy                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** Statuses worth repeating a **`GET`** for: rate limiting and origin failures. Never any other 4xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * `Retry-After`, in milliseconds. Both RFC forms: delta-seconds, and an HTTP-date.
 *
 * `undefined` when the header is absent or unparseable — a malformed hint is not a reason to fail
 * or to stall, only a reason to fall back to the jittered backoff.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === undefined || header === null) return undefined;
  const trimmed: string = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds: number = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  const at: number = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/**
 * Full-jittered exponential backoff: `random() * min(cap, base * 2^attempt)`, `attempt` 0-based.
 *
 * Full jitter, not "exponential plus a little noise", because the failure being backed off is
 * usually correlated across callers; spreading uniformly over the whole window is what actually
 * de-synchronises a thundering herd.
 *
 * A `Retry-After` hint wins over the computed delay but is **clamped to `capMs`**: honouring an
 * unbounded server hint would let one header stall a trading client for minutes.
 */
export function retryDelayMs(
  attempt: number,
  policy: { readonly baseMs: number; readonly capMs: number },
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.capMs);
  const ceiling: number = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/* ---------------------------------------------------------------------------------------------- */
/* Signals                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

function noop(): void {
  /* nothing to dispose */
}

/**
 * Compose signals, preferring the platform's `AbortSignal.any`.
 *
 * The manual fallback is six lines and removes the only real portability doubt in this file: on
 * the oldest supported Node 20 patch `AbortSignal.any` may be missing, and a polyfill dependency
 * is not available to us — zero runtime dependencies is enforced by `scripts/check-no-deps.ts`.
 */
function composeSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const first: AbortSignal | undefined = signals[0];
  if (first === undefined) throw new LighterConfigError("composeSignals requires at least one signal");
  if (signals.length === 1) return { signal: first, dispose: noop };

  const platform: unknown = (AbortSignal as unknown as { any?: unknown }).any;
  if (typeof platform === "function") {
    return {
      signal: (platform as (list: readonly AbortSignal[]) => AbortSignal).call(AbortSignal, signals),
      dispose: noop,
    };
  }

  const controller: AbortController = new AbortController();
  const listeners: (() => void)[] = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort((source as { reason?: unknown }).reason);
      break;
    }
    const listener = (): void => {
      controller.abort((source as { reason?: unknown }).reason);
    };
    source.addEventListener("abort", listener);
    listeners.push((): void => {
      source.removeEventListener("abort", listener);
    });
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      for (const remove of listeners) remove();
    },
  };
}

/** Default sleeper. `setTimeout` is a global on every target runtime; the abort path is what makes it cancellable. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
    let onAbort: (() => void) | undefined;
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) {
      onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedError(signal, undefined));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * The error an abort should surface as.
 *
 * A caller's own abort is **not** retryable — repeating a request the caller cancelled is the one
 * thing they asked us not to do. Our timeout is.
 */
function abortedError(signal: AbortSignal | undefined, timeoutMs: number | undefined): LighterError {
  const reason: unknown = signal === undefined ? undefined : (signal as { reason?: unknown }).reason;
  if (timeoutMs === undefined) {
    return new LighterTransportError("request aborted by the caller", {
      retryable: false,
      ...(reason !== undefined ? { cause: reason } : {}),
    });
  }
  return new LighterTimeoutError(`request timed out after ${String(timeoutMs)} ms`);
}

/* ---------------------------------------------------------------------------------------------- */
/* The request pipeline                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Issue one REST operation.
 *
 * @param route  an entry from `./routes.js`. Its `auth`, `encoding` and `method` are the policy.
 * @param params query parameters (`GET`) or body fields (`POST`), as one plain object.
 * @param options per-call configuration; see {@link RequestOptions}.
 *
 * @throws {LighterApiError} the API was reached and refused — including
 *   {@link LighterGeoRestrictedError} (code 20558) and {@link LighterAuthError} (HTTP 401 / code
 *   20013). Note that "not found" is **HTTP 400 with code 29404**, never a 404.
 * @throws {LighterBlockedError} an intermediary answered instead of the API, with a body that is
 *   not JSON.
 * @throws {LighterTimeoutError} the per-request budget elapsed.
 * @throws {LighterTransportError} `fetch` rejected, or the caller aborted.
 * @throws {LighterConfigError} the route requires a credential and none is configured.
 */
export async function request<R extends RouteDef>(
  route: R,
  params: ParamsOf<R> | undefined,
  options: RequestOptions & { raw: true },
): Promise<Response>;
export async function request<R extends RouteDef>(
  route: R,
  params?: ParamsOf<R>,
  options?: RequestOptions,
): Promise<ResponseOf<R>>;
export async function request<R extends RouteDef>(
  route: R,
  params?: ParamsOf<R>,
  options?: RequestOptions,
): Promise<ResponseOf<R> | Response> {
  const cfg: ResolvedConfig = resolveConfig(options);
  const raw: boolean = options?.raw === true;
  const userSignal: AbortSignal | undefined = options?.signal;
  const sleep: (ms: number, signal?: AbortSignal) => Promise<void> = options?.sleep ?? defaultSleep;
  const random: () => number = options?.random ?? Math.random;
  const authIn: "header" | "query" = options?.authIn ?? "header";

  // `sendTx` / `sendTxBatch` get the longer budget; so does every other write. A stuck order-book
  // read must fail in seconds, and the Python reference's 300 s default is unusable here.
  const timeoutMs: number = route.method === "POST" ? cfg.timeouts.writeMs : cfg.timeouts.readMs;

  const provider: AuthProvider | null = route.auth === "none" ? null : cfg.auth;
  if (route.auth === "required" && provider === null) {
    throw new LighterConfigError(
      `${route.method} ${route.path} requires an auth token and none is configured. Pass ` +
        `\`auth\` as a token string or an AuthProvider; the server would otherwise answer ` +
        `\`{"code":20001,"message":"invalid param : auth query param and Authorization header are empty"}\``,
    );
  }
  const authContext: { accountIndex?: number } = accountIndexOf(params);
  let token: string | null = provider === null ? null : await resolveToken(provider, authContext, route);

  const body: { init?: string; contentType?: string } = encodeBody(route, params);

  let attempt: number = 0;
  let authReplayed: boolean = false;

  for (;;) {
    const url: string = buildUrl(
      route,
      params,
      cfg.profile.restBase,
      token !== null && authIn === "query" ? { auth: token } : undefined,
    );
    const headers: Record<string, string> = buildHeaders(cfg, token, authIn, body.contentType);

    diagnose(cfg, "debug", "rest.request", { method: route.method, path: route.path, attempt });

    let response: Response;
    try {
      response = await fetchOnce(cfg, url, route.method, headers, body.init, timeoutMs, userSignal);
    } catch (failure: unknown) {
      if (canRetry(route, attempt, cfg) && isRetryable(failure)) {
        attempt += 1;
        await backoff(cfg, sleep, random, attempt - 1, undefined, route, userSignal, undefined);
        continue;
      }
      throw failure;
    }

    const retryable: boolean = isRetryableStatus(response.status) && canRetry(route, attempt, cfg);

    if (raw) {
      if (retryable) {
        discardBody(response);
        attempt += 1;
        await backoff(
          cfg,
          sleep,
          random,
          attempt - 1,
          retryAfterOf(response, cfg),
          route,
          userSignal,
          response.status,
        );
        continue;
      }
      return response;
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (failure: unknown) {
      if (canRetry(route, attempt, cfg)) {
        attempt += 1;
        await backoff(cfg, sleep, random, attempt - 1, undefined, route, userSignal, response.status);
        continue;
      }
      throw new LighterTransportError("the response body could not be read to completion", {
        cause: failure,
        retryable: true,
      });
    }

    const requestId: string | undefined = requestIdOf(response);
    const result: Classification = classifyResponse({
      status: response.status,
      bodyText,
      path: route.path,
      ...(requestId !== undefined ? { requestId } : {}),
    });

    if (result.ok) return result.body as ResponseOf<R>;

    // The one bounded exception to "never retry a 4xx": the token was refused, and the likeliest
    // cause is clock skew or a token that expired in flight. Re-invoke the provider — whose own
    // caching decides whether that mints a fresh token — and replay exactly once.
    if (
      !authReplayed &&
      provider !== null &&
      token !== null &&
      isAuthFailure(response.status, result.error)
    ) {
      authReplayed = true;
      diagnose(cfg, "warn", "rest.auth.replay", { path: route.path, status: response.status });
      token = await resolveToken(provider, authContext, route);
      continue;
    }

    if (retryable) {
      attempt += 1;
      await backoff(
        cfg,
        sleep,
        random,
        attempt - 1,
        retryAfterOf(response, cfg),
        route,
        userSignal,
        response.status,
      );
      continue;
    }

    throw result.error;
  }
}

/**
 * Whether another attempt is permitted.
 *
 * `GET` only. **A `POST` is never retried, under any status** — `sendTx` is nonce-bound and a
 * duplicate submission is a real economic loss, not a tidiness concern.
 */
function canRetry(route: RouteDef, attempt: number, cfg: ResolvedConfig): boolean {
  return route.method === "GET" && attempt < cfg.retry.attempts;
}

/** HTTP 401, or code 20013 at any status. Structural, never message text. */
function isAuthFailure(status: number, error: LighterError): boolean {
  if (status === 401) return true;
  return (error as unknown as Record<string, unknown>)["code"] === CODE_INVALID_AUTH;
}

async function backoff(
  cfg: ResolvedConfig,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  random: () => number,
  attemptIndex: number,
  retryAfterMs: number | undefined,
  route: RouteDef,
  signal: AbortSignal | undefined,
  status: number | undefined,
): Promise<void> {
  const delayMs: number = retryDelayMs(attemptIndex, cfg.retry, retryAfterMs, random);
  diagnose(cfg, "warn", "rest.retry", {
    path: route.path,
    attempt: attemptIndex + 1,
    delayMs,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
  await sleep(delayMs, signal);
}

/** One `fetch`, bounded by the per-attempt timeout composed with the caller's signal. */
async function fetchOnce(
  cfg: ResolvedConfig,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  userSignal: AbortSignal | undefined,
): Promise<Response> {
  const timeoutSignal: AbortSignal = AbortSignal.timeout(timeoutMs);
  const composed = composeSignals(
    userSignal === undefined ? [timeoutSignal] : [timeoutSignal, userSignal],
  );
  const signal: AbortSignal = composed.signal;

  const init: RequestInit = {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body } : {}),
  };

  let onAbort: (() => void) | undefined;
  try {
    const inFlight: Promise<Response> = cfg.fetch(url, init);
    // A late rejection, after the race has already been decided by an abort, must not surface as
    // an unhandled rejection. This handler is additive: the race still observes the original.
    inFlight.then(undefined, noop);

    // Racing the signal rather than trusting `fetch` to reject on abort is deliberate. The budget
    // must hold even against an injected or exotic `fetch` that ignores its signal entirely;
    // otherwise a stuck implementation hangs the caller forever.
    const abortRace: Promise<never> = new Promise<never>((_resolve, reject): void => {
      onAbort = (): void => {
        reject(abortedError(signal, userSignal?.aborted === true ? undefined : timeoutMs));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    return await Promise.race([inFlight, abortRace]);
  } catch (failure: unknown) {
    if (isLighterError(failure)) throw failure;
    if (signal.aborted) {
      throw abortedError(signal, userSignal?.aborted === true ? undefined : timeoutMs);
    }
    // DNS, TLS, a reset: nothing is known to have reached the origin, so this stays retryable.
    throw new LighterTransportError(`the request to ${pathOf(url)} could not be completed`, {
      cause: failure,
      retryable: true,
    });
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    composed.dispose();
  }
}

/** Path of a URL, for an error message. Never the query string: it can carry the `auth` token. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const cut: number = url.indexOf("?");
    return cut >= 0 ? url.slice(0, cut) : url;
  }
}

/**
 * Request headers, and nothing beyond them.
 *
 * The server's CORS allow-list is closed — `Content-Type, Origin, X-CSRF-Token, Authorization,
 * AccessToken, Token, Range` — so a stray `X-Client-Version` or trace header fails the preflight
 * and takes the whole request down from a browser. `User-Agent` is set only when
 * `cfg.userAgent` is non-null, which `resolveConfig` decides by looking at the *environment*
 * (`isBrowserLike()`), not at a runtime name and never at an environment variable
 * (`docs/decisions.md` D5).
 */
function buildHeaders(
  cfg: ResolvedConfig,
  token: string | null,
  authIn: "header" | "query",
  contentType: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token !== null && authIn === "header") {
    // No scheme prefix of any kind, and it is not a JWT. The OpenAPI `securitySchemes.apiKey`
    // entry that says otherwise is referenced by zero of the 78 operations — dead metadata that
    // will mislead anyone who trusts it (`spec/05-rest-api.md` §5.1).
    headers["Authorization"] = token;
  }
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (cfg.userAgent !== null) headers["User-Agent"] = cfg.userAgent;
  return headers;
}

/** Body encoding per `route.encoding`: form for 17 of the 18 `POST`s, JSON for `setAccountMetadata`. */
function encodeBody(route_: RouteDef, params: unknown): { init?: string; contentType?: string } {
  if (route_.method !== "POST") return {};
  if (route_.encoding === "json") {
    return { init: JSON.stringify(params ?? {}, jsonReplacer), contentType: JSON_CONTENT_TYPE };
  }
  return { init: buildQuery(params).toString(), contentType: FORM_CONTENT_TYPE };
}

/** `bigint` has no JSON representation; a scaled integer must survive as an exact decimal string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function resolveToken(
  provider: AuthProvider,
  context: { accountIndex?: number },
  route_: RouteDef,
): Promise<string> {
  const token: string = await provider(context);
  if (typeof token !== "string" || token.length === 0) {
    throw new LighterConfigError(
      `the configured AuthProvider returned no token for ${route_.method} ${route_.path}`,
    );
  }
  return token;
}

/** Advisory context for the provider. Most providers ignore it; a per-account minting cache does not. */
function accountIndexOf(params: unknown): { accountIndex?: number } {
  if (typeof params !== "object" || params === null) return {};
  const value: unknown = (params as Record<string, unknown>)["account_index"];
  return typeof value === "number" && Number.isSafeInteger(value) ? { accountIndex: value } : {};
}

function requestIdOf(response: Response): string | undefined {
  const value: string | null = response.headers.get(REQUEST_ID_HEADER);
  return value === null ? undefined : value;
}

function retryAfterOf(response: Response, cfg: ResolvedConfig): number | undefined {
  return parseRetryAfterMs(response.headers.get("retry-after"), cfg.now());
}

/** Release a body we are about to abandon on a `raw` retry. Best effort; a failure here is noise. */
function discardBody(response: Response): void {
  const body: { cancel?: () => Promise<void> } | null | undefined = (
    response as unknown as { body?: { cancel?: () => Promise<void> } | null }
  ).body;
  if (body !== null && body !== undefined && typeof body.cancel === "function") {
    void body.cancel().then(undefined, noop);
  }
}

/** Every diagnostic leaves through `redact`, so no auth token or key material can ride out on one. */
function diagnose(
  cfg: ResolvedConfig,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  detail: Record<string, unknown>,
): void {
  cfg.onDiagnostic({ level, event, detail: redact(detail) as Record<string, unknown> });
}
