/**
 * Runtime configuration: one frozen object carrying every capability the SDK is allowed to reach for.
 *
 * `fetch`, `WebSocket` and `now()` are **injected, not imported**. That is the same discipline as the
 * zero-dependency rule, applied to globals:
 *
 * - Tests need no network and no fake timers — they hand in a function.
 * - Node 20 has no global `WebSocket`; passing `undici`'s works, and a REST-only caller never needs
 *   one at all, which is why an absent `WebSocket` resolves to `null` here instead of throwing.
 * - Cloudflare Workers and browsers each supply their own; nothing is captured at module scope, so
 *   importing this file inside a Worker's global evaluation phase is legal.
 *
 * The resolved object also carries the chain id, taken from the endpoint profile rather than passed
 * alongside it — see `./endpoints.js` for why signing and routing must not be separable.
 *
 * **Nothing runs at import time.** Every `globalThis` lookup, the `Date.now` default and the
 * environment sniffing all happen inside {@link resolveConfig}. Cloudflare Workers forbids
 * `crypto.getRandomValues` at module scope outright, and the package's `sideEffects: false` claim is
 * verified by a test that imports this module with throwing spies installed on the globals.
 */

import { LighterConfigError } from "../errors.js";
import type { EndpointProfile, ProfileName } from "./endpoints.js";
import { defineProfile, getProfile, profiles } from "./endpoints.js";

/**
 * The subset of WHATWG `WebSocket` the SDK uses.
 *
 * Deliberately structural and deliberately small: it is satisfied by the browser/Workers/Deno/Bun
 * global, by `undici`'s `WebSocket` on Node 20, and by a fake in a test. Note the absence of
 * `ping`/`pong` — control frames are unreachable from the WHATWG API, and Lighter's keepalive is an
 * application-level JSON `{"type":"pong"}` anyway (`docs/protocol-notes.md` §10.1).
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

/** Anything `new`-able into a {@link WebSocketLike} from a URL. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Supplies an auth token for an authenticated read or a private WS channel.
 *
 * Async by permission, not by requirement: a token may come from a signer, a cache, or a remote
 * service. The context is advisory — most providers ignore it.
 */
export type AuthProvider = (ctx: { accountIndex?: number; channel?: string }) => string | Promise<string>;

/** A structured log line leaving the SDK. Already redacted by the emitter. */
export interface Diagnostic {
  readonly level: "debug" | "info" | "warn" | "error";
  /** Stable dotted event name, e.g. `"ws.reconnect"`. Branch on this, never on prose. */
  readonly event: string;
  readonly detail?: Record<string, unknown>;
}

/** Everything a caller may pass. Every field is optional; `resolveConfig()` with no argument works. */
export interface LighterConfig {
  /** A built-in profile name, or a full custom profile. Default: `mainnet`. */
  endpoint?: ProfileName | EndpointProfile;
  /** Defaults to `globalThis.fetch`, bound. Required where there is none. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `globalThis.WebSocket` when present; otherwise the WS layer is unusable. */
  WebSocket?: WebSocketConstructor;
  /** Clock, in epoch milliseconds. Default `() => Date.now()`. */
  now?: () => number;
  /** Default transaction validity window. Default `599_000`. */
  defaultTxExpiryMs?: number;
  /** A scalar sets both read and write timeouts. Default `{ readMs: 10_000, writeMs: 30_000 }`. */
  timeoutMs?: number | { readMs?: number; writeMs?: number };
  /** Retry budget. Default `{ attempts: 2, baseMs: 200, capMs: 5_000 }`. Policy lives in the transport. */
  retry?: { attempts?: number; baseMs?: number; capMs?: number };
  /** A constant token, or a provider called per request. */
  auth?: string | AuthProvider;
  /** Overrides {@link DEFAULT_USER_AGENT}. Ignored in browser-like environments. */
  userAgent?: string;
  /** Diagnostics sink. Default: a no-op. */
  onDiagnostic?: (d: Diagnostic) => void;
}

/** The frozen result of {@link resolveConfig}. Every field is present and non-optional. */
export interface ResolvedConfig {
  readonly profile: EndpointProfile;
  /** Mirrors `profile.chainId`. Duplicated for reach: the signer takes this and nothing else. */
  readonly chainId: number;
  readonly fetch: typeof globalThis.fetch;
  /** `null` when the runtime has none and none was injected — REST still works. */
  readonly WebSocket: WebSocketConstructor | null;
  readonly now: () => number;
  readonly defaultTxExpiryMs: number;
  readonly timeouts: { readonly readMs: number; readonly writeMs: number };
  readonly retry: { readonly attempts: number; readonly baseMs: number; readonly capMs: number };
  readonly auth: AuthProvider | null;
  /** `null` in browser-like environments, where the header is forbidden. See {@link isBrowserLike}. */
  readonly userAgent: string | null;
  readonly onDiagnostic: (d: Diagnostic) => void;
}

/**
 * Default transaction validity window: 600 000 ms minus a one-second haircut.
 *
 * The haircut absorbs millisecond-versus-second rounding at the sequencer, which compares against a
 * second-resolution clock. Ten minutes exactly is intermittently one tick too long.
 */
export const DEFAULT_TX_EXPIRY_MS: 599_000 = 599_000;

/**
 * `User-Agent` sent from every non-browser runtime.
 *
 * Browser-like on purpose (`docs/decisions.md` D5): server runtimes that send no UA, or an obviously
 * programmatic one, get a 403 HTML interstitial from CloudFront on some paths — a failure that looks
 * like an API error but never reached the API. Browsers are handled by *not* setting the header at
 * all; see {@link isBrowserLike}.
 *
 * Overridable via `LighterConfig.userAgent`, and deliberately so: the wave-0 probe of workerd's
 * *default* UA against the CDN is still outstanding (`docs/decisions.md` D5, D9.5). If that probe
 * shows workerd's default is accepted — or that this string is not — the value changes without any
 * caller being stuck with it.
 */
export const DEFAULT_USER_AGENT: string =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/125.0.0.0 Safari/537.36";

/** Read a global by name without asserting it exists in the type system. Never called at module scope. */
function globalProperty<T>(key: string): T | undefined {
  return (globalThis as unknown as Record<string, T | undefined>)[key];
}

/**
 * Whether this looks like a browser *environment* — a `document` **and** a `window` on `globalThis`.
 *
 * Detects the environment, not the runtime name: a jsdom-backed test runner, an Electron renderer
 * and an extension content script all behave like browsers for our purposes, while workerd and Deno
 * do not. `navigator` is not consulted — Workers and Node 20+ both define one.
 *
 * When this is true the SDK must never attempt to set `User-Agent`: the fetch spec makes it a
 * forbidden header name and silently drops it, and adding custom headers can promote a simple
 * request into a CORS preflight that then fails (`docs/decisions.md` D5).
 */
export function isBrowserLike(): boolean {
  return (
    globalProperty<unknown>("document") !== undefined && globalProperty<unknown>("window") !== undefined
  );
}

/** Reject a value that is not a finite integer within `[min, ∞)`. Timeouts and counts, never money. */
function requireIntAtLeast(value: number, min: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new LighterConfigError(
      `${field} must be an integer >= ${min}, received ${String(value)}`,
    );
  }
  return value;
}

function resolveProfile(endpoint: LighterConfig["endpoint"]): EndpointProfile {
  if (endpoint === undefined) return profiles.mainnet;
  if (typeof endpoint === "string") return getProfile(endpoint);
  return defineProfile(endpoint);
}

function resolveFetch(injected: LighterConfig["fetch"]): typeof globalThis.fetch {
  if (injected !== undefined) {
    if (typeof injected !== "function") {
      throw new LighterConfigError("config.fetch must be a function");
    }
    return injected;
  }
  const global: typeof globalThis.fetch | undefined = globalProperty<typeof globalThis.fetch>("fetch");
  if (typeof global !== "function") {
    throw new LighterConfigError(
      "no fetch implementation is available. Node 18+, Bun, Deno, Cloudflare Workers and browsers " +
        "all provide a global fetch; on older Node, or in a sandbox that removes it, pass one: " +
        "`new LighterClient({ fetch })`",
    );
  }
  // Bound, not captured bare: `const { fetch } = globalThis; fetch(url)` is
  // `TypeError: Illegal invocation` in browsers, because the global function needs `window` as its
  // receiver. Binding once here means every call site can treat it as an ordinary function.
  return global.bind(globalThis) as typeof globalThis.fetch;
}

function resolveWebSocket(injected: LighterConfig["WebSocket"]): WebSocketConstructor | null {
  if (injected !== undefined) {
    if (typeof injected !== "function") {
      throw new LighterConfigError("config.WebSocket must be a constructor");
    }
    return injected;
  }
  // Absence is not an error here. A REST-only consumer must be able to construct a config on Node
  // 20, which has no global WebSocket. The WS client throws when it actually needs one, and names
  // `undici`'s WebSocket as the Node 20 answer.
  const global: WebSocketConstructor | undefined = globalProperty<WebSocketConstructor>("WebSocket");
  return typeof global === "function" ? global : null;
}

function resolveTimeouts(
  timeoutMs: LighterConfig["timeoutMs"],
): { readonly readMs: number; readonly writeMs: number } {
  let readMs: number = 10_000;
  let writeMs: number = 30_000;
  if (typeof timeoutMs === "number") {
    // A scalar means "this budget, both directions".
    readMs = requireIntAtLeast(timeoutMs, 1, "config.timeoutMs");
    writeMs = readMs;
  } else if (timeoutMs !== undefined) {
    if (timeoutMs.readMs !== undefined) readMs = requireIntAtLeast(timeoutMs.readMs, 1, "config.timeoutMs.readMs");
    if (timeoutMs.writeMs !== undefined) writeMs = requireIntAtLeast(timeoutMs.writeMs, 1, "config.timeoutMs.writeMs");
  }
  return Object.freeze({ readMs, writeMs });
}

function resolveRetry(
  retry: LighterConfig["retry"],
): { readonly attempts: number; readonly baseMs: number; readonly capMs: number } {
  // Full-jittered exponential backoff, factor 2. Resolution only — the policy that consumes these
  // (GET-only, which errors are retryable) belongs to the transport unit.
  const attempts: number = retry?.attempts === undefined ? 2 : requireIntAtLeast(retry.attempts, 0, "config.retry.attempts");
  const baseMs: number = retry?.baseMs === undefined ? 200 : requireIntAtLeast(retry.baseMs, 0, "config.retry.baseMs");
  const capMs: number = retry?.capMs === undefined ? 5_000 : requireIntAtLeast(retry.capMs, 0, "config.retry.capMs");
  return Object.freeze({ attempts, baseMs, capMs });
}

function resolveAuth(auth: LighterConfig["auth"]): AuthProvider | null {
  if (auth === undefined) return null;
  if (typeof auth === "string") {
    if (auth.length === 0) throw new LighterConfigError("config.auth must not be an empty string");
    return (): string => auth;
  }
  if (typeof auth !== "function") {
    throw new LighterConfigError("config.auth must be a token string or an AuthProvider function");
  }
  return auth;
}

function resolveUserAgent(userAgent: LighterConfig["userAgent"]): string | null {
  // Browser wins over an explicit setting: the header is forbidden there, so honouring the caller
  // would mean either a silently dropped header or a CORS preflight that fails. `null` says
  // "do not try", and the transport must not.
  if (isBrowserLike()) return null;
  if (userAgent === undefined) return DEFAULT_USER_AGENT;
  if (typeof userAgent !== "string" || userAgent.length === 0) {
    throw new LighterConfigError("config.userAgent must be a non-empty string");
  }
  return userAgent;
}

/** Shared no-op sink, so `resolveConfig()` does not allocate a closure per call for the common case. */
function ignoreDiagnostic(): void {
  /* no-op */
}

/**
 * Resolve caller options into the frozen object the rest of the SDK reads.
 *
 * Every default and every global lookup happens here, never at module scope. Fields are resolved one
 * by one rather than spread over a partial: `exactOptionalPropertyTypes` is on, so an object built
 * from optional values (`{ timeoutMs: maybeUndefined }`) is not assignable to a spread-based
 * resolution, and callers would fail to typecheck for no reason.
 *
 * @throws {LighterConfigError} for an unknown profile name, a custom profile without a chain id, a
 * missing `fetch`, or an out-of-range timeout/retry value.
 */
export function resolveConfig(c?: LighterConfig): ResolvedConfig {
  const profile: EndpointProfile = resolveProfile(c?.endpoint);
  return Object.freeze({
    profile,
    // Read off the profile, never from the caller and never sniffed from a URL.
    chainId: profile.chainId,
    fetch: resolveFetch(c?.fetch),
    WebSocket: resolveWebSocket(c?.WebSocket),
    now: c?.now ?? ((): number => Date.now()),
    defaultTxExpiryMs:
      c?.defaultTxExpiryMs === undefined
        ? DEFAULT_TX_EXPIRY_MS
        : requireIntAtLeast(c.defaultTxExpiryMs, 1, "config.defaultTxExpiryMs"),
    timeouts: resolveTimeouts(c?.timeoutMs),
    retry: resolveRetry(c?.retry),
    auth: resolveAuth(c?.auth),
    userAgent: resolveUserAgent(c?.userAgent),
    onDiagnostic: c?.onDiagnostic ?? ignoreDiagnostic,
  });
}
