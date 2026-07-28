/**
 * `LighterWsClient` — the desired-subscription table, inbound routing, and resubscribe-on-reconnect.
 *
 * Everything underneath already exists and is imported, never reimplemented: `./transport.js` owns
 * the socket, the keepalive, the staleness watchdog, backoff and the outbound token bucket;
 * `./protocol.js` owns frame decoding, the channel-key codec and the error action table;
 * `./channels.js` owns the typed registry; `./subscription.js` owns the bounded per-channel queue.
 * What is left — and what this file is — is the part that makes a socket into a *client*: which
 * channels the caller wants, where an inbound frame belongs, and what has to happen the instant the
 * connection comes back.
 *
 * ## The one thing that is easy to get silently wrong
 *
 * A client that reconnects but does not re-subscribe looks perfectly healthy: the socket is open,
 * the state machine says `open`, no error is raised anywhere — and not one frame is ever delivered
 * again. A client that resubscribes with the token it captured at first subscribe looks healthy too,
 * and loses only the private channels, twenty minutes later, when the deadline in that token has
 * passed. Both failures are invisible from the outside, so both are pinned by tests rather than by
 * care (`test/ws/client.test.ts`).
 *
 * The rules that prevent them, from `docs/spec/06-websocket.md` §10.2:
 *
 * 1. `{kind:'reset', reason:'reconnect'}` goes out on **every** subscription the instant the socket
 *    leaves `open` — before any post-reconnect snapshot can arrive. `reset` is how a consumer knows
 *    its delta-derived state is void; delivered *after* a fresh snapshot it would make the consumer
 *    discard the good snapshot and keep quoting off nothing.
 * 2. Every resubscribe calls {@link AuthTokenProvider} **again**. Tokens carry an absolute deadline
 *    (§7.3) and an outage can outlive one.
 * 3. Subscribe frames go through the transport's `control` lane, which is bucketed at 200 frames per
 *    60 s (§10.3), so restoring 500 channels does not immediately trip 30009.
 *
 * ## Evidence status
 *
 * The wave-0 live capture was refused at the upgrade (API code 20558, restricted jurisdiction —
 * `docs/protocol-notes.md` §8.3), so this whole layer is written against `[REF]`/`[DOC]`/`[DESIGN]`
 * claims rather than observed frames. The posture that follows from that is uniform and deliberate:
 *
 * - **Nothing inbound is ever fatal.** An unknown `type`, an `unsubscribed/*` ack, an unroutable
 *   channel, a frame that decodes to garbage — each is a diagnostic and the client keeps running.
 *   The reference client raises on any unrecognised message, which kills its read loop and takes
 *   every subscription down with it (`docs/protocol-notes.md` §10.2).
 * - Every dependency on an unverified shape names its spec section at the point of use.
 *
 * ## Mutable state owned here (D8), all instance-scoped
 *
 * The desired-subscription table and its per-entry controllers, timers and attempt counters; the
 * connection generation counter; the last observed close; the fatal-limit latch; the event, frame-tap
 * and reconnect listener sets. Nothing at module scope — in particular nothing that reads a clock or
 * `crypto.getRandomValues` at import, which Cloudflare Workers forbids (`docs/decisions.md` D2).
 *
 * ## Not here on purpose
 *
 * - `sendTx` / `sendTxBatch`. `docs/ARCHITECTURE.md` §6.7 puts them on this class; they live in
 *   `./send-tx.js` and attach through {@link WsFrameChannel}, so a market-data-only bundle never
 *   pulls in the transaction path. Callers write `createTxDispatcher(ws)`.
 * - The connection-pool class named in `docs/spec/06-websocket.md` §10.3. Cut from v1
 *   (`docs/decisions.md` D10). The over-subscription error therefore points the caller at a second
 *   {@link LighterWsClient} rather than at a type that does not exist; §10.3 is superseded.
 * - A callback fast-path that bypasses the queue (ADR-7's dual API, also cut by D10). One buffer,
 *   one delivery path; see `./subscription.js`.
 */

import { getProfile, type ProfileName } from "../config/endpoints.js";
import type { BackoffOptions } from "./backoff.js";
import type { ChannelSpec } from "./channels.js";
import {
  LighterWsAuthError,
  LighterWsClosedError,
  LighterWsError,
  LighterWsRateLimitError,
  LighterWsReadOnlyError,
  WS_ERR_NOT_SUBSCRIBED,
  wsLimitName,
} from "./errors.js";
import type { InboundFrame, RouteResult, WebSocketConstructor, WebSocketLike } from "./protocol.js";
import { buildSubscribe, buildUnsubscribe, classifyWsError, resolveRouteKey } from "./protocol.js";
import type {
  ChannelEvent,
  OverflowPolicy,
  Subscription,
  SubscriptionController,
  SubscriptionDiagnostic,
  SubscriptionHost,
} from "./subscription.js";
import { createSubscription } from "./subscription.js";
import type { WsDiagnostic, WsState, WsTransportOptions } from "./transport.js";
import { WsTransport } from "./transport.js";

/* ---------------------------------------------------------------------------------------------- */
/* Public types                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Mints a per-subscription auth token (`docs/spec/06-websocket.md` §7).
 *
 * Called fresh for **every** subscribe and **every** resubscribe-after-reconnect — never cached by
 * this client. The token embeds an absolute deadline, so a cached one is a time bomb that only goes
 * off after an outage long enough to matter.
 *
 * `accountIndex` is present whenever the channel is account-scoped; `channel` is always the outbound
 * slash-form key.
 */
export type AuthTokenProvider = (ctx: {
  accountIndex?: number;
  channel: string;
}) => string | Promise<string>;

/** Where the client is. Mirrors the transport's own machine (`docs/spec/06-websocket.md` §4). */
export type WsClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "open"
  | "reconnecting"
  | "closed";

/**
 * One structured lifecycle event. `event` is a stable slug, not prose.
 *
 * Slugs raised here: `"unroutable"`, `"unknown-type"`, `"unsubscribed"`, `"unhandled-ack"`,
 * `"malformed-frame"`, `"subscribe-timeout"`, `"subscribe-retry"`, `"subscribe-failed"`,
 * `"auth-provider-failed"`, `"auth-refresh"`, `"server-error"`, `"codec-bug"`, `"throttled"`,
 * `"inflight-reduced"`, `"socket-limit"`, `"resubscribe"`, `"reset"`, `"subscription"`,
 * `"listener-error"`, `"routing-error"`. Everything the transport raises is forwarded verbatim.
 */
export interface WsClientDiagnostic {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly detail?: Record<string, unknown>;
}

/** Per-subscription knobs. Both bounds default from the channel family (§13.6). */
export interface SubscribeOptions {
  /** Overrides the per-family default computed by {@link LighterWsClient.subscribe}. */
  overflow?: OverflowPolicy;
  /** Ring capacity for this subscription. Default `queueLimit` (1 024). */
  queueLimit?: number;
  /** Closes the subscription when aborted. */
  signal?: AbortSignal;
}

/** Construction options. Every one has a default; nothing is read until {@link LighterWsClient.connect}. */
export interface LighterWsOptions {
  /** Built-in endpoint profile. Resolved through `src/config/endpoints.ts`; default `mainnet`. */
  network?: ProfileName;
  /** Full stream URL. Overrides {@link network} entirely. */
  url?: string;
  /** Append `readonly=true` and refuse `tx`-lane frames client-side. */
  readOnly?: boolean;
  /** Token source for authenticated channels. Called fresh on every (re)subscribe. */
  auth?: AuthTokenProvider;
  /** Injected constructor. Defaults to `globalThis.WebSocket`, read lazily inside `connect()`. */
  WebSocket?: WebSocketConstructor;
  /** Connect on the first {@link LighterWsClient.subscribe}. Default `true`. */
  autoConnect?: boolean;
  /** Budget for the `{"type":"connected"}` greeting before subscribing anyway. Default `3_000`. */
  handshakeTimeoutMs?: number;
  /** Budget for a `subscribed/*` ack before one retry. Default `15_000`. */
  subscribeTimeoutMs?: number;
  /** Idle-outbound keepalive interval, passed to the transport. Default `45_000`. */
  keepAliveMs?: number;
  /** Idle-inbound watchdog, passed to the transport. Default `90_000`. */
  stalenessTimeoutMs?: number;
  /** `false` disables reconnection; otherwise backoff tuning. */
  reconnect?: false | BackoffOptions;
  /** Refuse to exceed this many subscriptions on one socket. Default `500` (§10.3). */
  maxSubscriptions?: number;
  /** Ceiling on frames awaiting a reply. Default `40`. */
  maxInflight?: number;
  /** Non-tx outbound budget per 60 s. Default `200`. */
  outboundPerMinute?: number;
  /** Fallback overflow policy where the per-family default does not apply. Default `drop-oldest`. */
  defaultOverflow?: OverflowPolicy;
  /** Default ring capacity per subscription. Default `1_024`. */
  queueLimit?: number;
  /** Clock in ms. Only differences are used. Defaults to `Date.now`, read lazily. */
  clock?: () => number;
  /**
   * Timer pair, forwarded to the transport and used for this client's own timers.
   *
   * A test seam, and the reason the whole reconnect/resubscribe path can be exercised in
   * microseconds against `test/ws-harness.ts` instead of against a ninety-second wall clock. Never a
   * repeating-interval timer: a Durable Object cannot hibernate while one is live (§13.2).
   */
  timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(h: number): void;
  };
  /** Structured lifecycle events, this client's and the transport's. A throwing sink is ignored. */
  onDiagnostic?: (d: WsClientDiagnostic) => void;
}

/**
 * The subscription half of the client, as the downstream units see it.
 *
 * `ws-orderbook` attaches through this rather than through the concrete class, so an order-book
 * maintainer can be driven by a test double with no socket behind it.
 */
export interface WsSubscriber {
  subscribe<S, U>(spec: ChannelSpec<S, U>, opts?: SubscribeOptions): Subscription<S, U>;
  reconnect(reason: string): void;
  readonly state: WsClientState;
}

/**
 * The raw-frame half of the client.
 *
 * `ws-send-tx` attaches through this: it writes `jsonapi/sendtx*` frames on the `tx` lane, taps
 * inbound acks before channel routing, and fails its pending acks when the socket goes away.
 */
export interface WsFrameChannel {
  /**
   * Serialise and write one frame. lane `'tx'` bypasses the 200-msg/min bucket (tx frames are
   * governed by the REST limits) but is still serialised on the wire.
   */
  sendFrame(frame: object, opts?: { lane?: "default" | "tx" }): void;
  /** Raw inbound frame tap, evaluated BEFORE channel routing. Return true to mark the frame consumed. */
  onFrame(handler: (frame: Record<string, unknown>) => boolean): () => void;
  /** Fires on every socket close, before resubscription begins. */
  onReconnect(handler: (info: { code: number; reason: string }) => void): () => void;
  readonly readOnly: boolean;
}

/* ---------------------------------------------------------------------------------------------- */
/* Defaults and tables                                                                              */
/* ---------------------------------------------------------------------------------------------- */

const DEFAULT_HANDSHAKE_TIMEOUT_MS: 3_000 = 3_000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS: 15_000 = 15_000;
const DEFAULT_KEEPALIVE_MS: 45_000 = 45_000;
const DEFAULT_STALENESS_TIMEOUT_MS: 90_000 = 90_000;
const DEFAULT_MAX_SUBSCRIPTIONS: 500 = 500;
const DEFAULT_MAX_INFLIGHT: 40 = 40;
const DEFAULT_OUTBOUND_PER_MINUTE: 200 = 200;
const DEFAULT_QUEUE_LIMIT: 1_024 = 1_024;

/** How long the outbound refill stays halved after 30009 / 23000 (§11). */
const THROTTLE_WINDOW_MS: 60_000 = 60_000;
/** Fraction of the refill rate retained while throttled. */
const THROTTLE_FACTOR: 0.5 = 0.5;
/** Fraction taken off `maxInflight` on 30010 (§11). */
const INFLIGHT_REDUCTION: 0.25 = 0.25;
/** Delay before retrying the frame that drew a 30010 (§11). */
const INFLIGHT_RETRY_MS: 1_000 = 1_000;

/** Close code used by {@link LighterWsClient.reconnect} to force a socket cycle. */
const FORCED_CYCLE_CODE: 1000 = 1000;

/** Fallback close code when a socket vanished without ever delivering a `close` event. */
const UNKNOWN_CLOSE_CODE: 1006 = 1006;

/**
 * Families whose every message is a complete state, so only the newest one matters
 * (`docs/spec/06-websocket.md` §13.6).
 */
const COALESCE_FAMILIES: ReadonlySet<string> = new Set<string>([
  "candle",
  "mark_price_candle",
  "ticker",
  "market_stats",
  "spot_market_stats",
  "user_stats",
  "account_all_assets",
  "account_all_positions",
]);

/** Append-only histories: losing the oldest entry is recoverable over REST (§13.6). */
const DROP_OLDEST_FAMILIES: ReadonlySet<string> = new Set<string>([
  "trade",
  "account_tx",
  "notification",
  "account_all_trades",
]);

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One row of the desired-subscription table.
 *
 * The table is the client's memory of intent, and it outlives every socket: `active`, `sawFirst` and
 * the counters are per-connection and reset on each reconnect, while `spec`, `key` and `controller`
 * persist until the caller closes the subscription.
 */
interface DesiredEntry {
  readonly key: string;
  readonly spec: ChannelSpec<unknown, unknown>;
  readonly controller: SubscriptionController<unknown, unknown>;
  /** The server has acknowledged this channel on the current connection. */
  active: boolean;
  /** A data frame has arrived on the current connection — half of the `order_book` snapshot wart. */
  sawFirst: boolean;
  /** Subscribe attempts on the current connection. One retry is allowed (§10.2 step 4). */
  attempts: number;
  /** Auth refreshes on the current connection. One retry is allowed (§11). */
  authAttempts: number;
  /** Pending `subscribed/*` deadline. */
  timer: number | undefined;
  /** The token that actually reached the wire last, for diagnostics and error classification. */
  lastAuth: string | undefined;
  closed: boolean;
}

/** An inbound frame that carries a channel payload. */
type DataFrame = Extract<InboundFrame, { kind: "snapshot" } | { kind: "update" }>;

/** An inbound failure frame. */
type ErrorFrame = Extract<InboundFrame, { kind: "error" }>;

/**
 * Serialise an outbound frame, emitting `bigint` as a bare integer literal.
 *
 * `JSON.stringify` throws on a `bigint`, and quoting one would change the wire type of a field that
 * is unquoted on the protocol — `nonce`, `offset` and the transaction ids have no string twin
 * (`docs/spec/06-websocket.md` §3.3). Kept local rather than exported from `./protocol.js` because
 * the frame builders there already cover every frame this SDK constructs; this path exists for the
 * frames a downstream unit builds itself.
 */
function encodeFrameJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    const encoded: string | undefined = JSON.stringify(value);
    return encoded ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map(encodeFrameJson).join(",")}]`;
  }
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${encodeFrameJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** The parsed frame object, when the decoded frame carries one. */
function bodyOf(frame: InboundFrame): Record<string, unknown> | undefined {
  if (!("body" in frame)) return undefined;
  const body: unknown = frame.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

function requireFinitePositive(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LighterWsError(`${name} must be a finite number > 0`);
  }
  return value;
}

/* ---------------------------------------------------------------------------------------------- */
/* The client                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One socket's worth of subscriptions, kept alive across reconnects.
 *
 * Construction is inert: no socket is opened, no timer scheduled and no global read. The first
 * {@link connect} — or the first {@link subscribe} with `autoConnect` — starts the machine.
 */
export class LighterWsClient implements WsSubscriber, WsFrameChannel {
  // ---- configuration ---------------------------------------------------------------------------

  readonly #transport: WsTransport;
  readonly #auth: AuthTokenProvider | undefined;
  readonly #wsOption: WebSocketConstructor | undefined;
  readonly #autoConnect: boolean;
  readonly #subscribeTimeoutMs: number;
  readonly #maxSubscriptions: number;
  readonly #defaultOverflow: OverflowPolicy;
  readonly #queueLimit: number;
  readonly #clock: (() => number) | undefined;
  readonly #timers: LighterWsOptions["timers"];
  readonly #onDiagnostic: ((d: WsClientDiagnostic) => void) | undefined;

  // ---- mutable state ---------------------------------------------------------------------------

  readonly #desired: Map<string, DesiredEntry> = new Map<string, DesiredEntry>();

  /**
   * Bumped on every `ready`.
   *
   * Every asynchronous step of a subscribe — the auth provider call, the paced write, the ack
   * deadline — captures the generation it started under and abandons itself if the connection has
   * turned over since. Without it a token minted for the previous socket lands on the next one, and
   * a timeout fires against a subscribe that was already re-sent.
   */
  #connGen = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #socket: WebSocketLike | undefined;
  #lastClose: { code: number; reason: string } | undefined;
  /** Latched by 23001/23002/23003: this socket will accept no further subscriptions (§11). */
  #fatalLimit: { code: number; limit: string } | undefined;

  readonly #frameTaps: Set<(frame: Record<string, unknown>) => boolean> = new Set();
  readonly #reconnectTaps: Set<(info: { code: number; reason: string }) => void> = new Set();
  readonly #listeners: Map<string, Set<(e: unknown) => void>> = new Map();

  constructor(options: LighterWsOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new LighterWsError("LighterWsClient options must be an object");
    }

    this.#auth = options.auth;
    this.#wsOption = options.WebSocket;
    this.#autoConnect = options.autoConnect !== false;
    this.#subscribeTimeoutMs = requireFinitePositive(
      "subscribeTimeoutMs",
      options.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS,
    );
    this.#maxSubscriptions = requireFinitePositive(
      "maxSubscriptions",
      options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
    );
    this.#defaultOverflow = options.defaultOverflow ?? "drop-oldest";
    this.#queueLimit = requireFinitePositive("queueLimit", options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
    this.#clock = options.clock;
    this.#timers = options.timers;
    this.#onDiagnostic = options.onDiagnostic;

    // The URL comes from the profile table, never from a literal in this file: a host typed twice is
    // a host that will eventually disagree with itself (`docs/spec/06-websocket.md` §1.1).
    const url: string = options.url ?? getProfile(options.network ?? "mainnet").wsBase;

    const transportOptions: {
      url: string;
      readOnly: boolean;
      WebSocket: WebSocketConstructor;
      handshakeTimeoutMs: number;
      keepAliveMs: number;
      stalenessTimeoutMs: number;
      outboundPerMinute: number;
      maxInflight: number;
      clock: () => number;
      onDiagnostic: (d: WsDiagnostic) => void;
      reconnect?: false | BackoffOptions;
      timers?: NonNullable<WsTransportOptions["timers"]>;
    } = {
      url,
      readOnly: options.readOnly === true,
      WebSocket: this.#observedConstructor(),
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      keepAliveMs: options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS,
      stalenessTimeoutMs: options.stalenessTimeoutMs ?? DEFAULT_STALENESS_TIMEOUT_MS,
      outboundPerMinute: options.outboundPerMinute ?? DEFAULT_OUTBOUND_PER_MINUTE,
      maxInflight: options.maxInflight ?? DEFAULT_MAX_INFLIGHT,
      clock: (): number => this.#now(),
      onDiagnostic: (d: WsDiagnostic): void => this.#onTransportDiagnostic(d),
    };
    if (options.reconnect !== undefined) transportOptions.reconnect = options.reconnect;
    if (options.timers !== undefined) transportOptions.timers = options.timers;

    this.#transport = new WsTransport(transportOptions);
    this.#transport.onState((next: WsState, prev: WsState): void => this.#onState(next, prev));
    this.#transport.onReady((): Promise<void> => this.#onReady());
    this.#transport.onFrame((f: InboundFrame, _raw: string, receivedAt: number): void => {
      this.#onFrame(f, receivedAt);
    });
  }

  /* ---- introspection --------------------------------------------------------------------------- */

  /** Where the connection is. `closed` is terminal. */
  get state(): WsClientState {
    return this.#transport.state;
  }

  /** The fully resolved stream URL, query included. */
  get url(): string {
    return this.#transport.url;
  }

  /** Whether this socket was opened with `?readonly=true`. */
  get readOnly(): boolean {
    return this.#transport.readOnly;
  }

  /* ---- lifecycle ------------------------------------------------------------------------------- */

  /**
   * Open the socket, resolving the first time it is ready.
   *
   * Throws synchronously on a closed client and in a runtime with no `WebSocket` and no injected
   * constructor — both are programmer errors rather than connection outcomes. Ordinary connection
   * failures reject only when reconnection is disabled or exhausted; otherwise the promise stays
   * pending across retries, because the intent ("be connected") is still in force.
   */
  connect(): Promise<void> {
    if (this.state === "closed") {
      throw new LighterWsError("this client was closed; construct a new LighterWsClient to reconnect");
    }
    // Resolved here rather than inside the socket factory so a missing implementation surfaces as a
    // synchronous throw instead of an endless reconnect loop against a constructor that always fails.
    this.#resolveWebSocket();
    return this.#transport.connect();
  }

  /**
   * Terminal shutdown. Idempotent, and never rejects.
   *
   * Every subscription is finished, every timer cleared and the desired table emptied before the
   * socket is closed, so nothing tries to resubscribe on the way down and no `reset` is emitted —
   * a caller who closed the client is not resyncing anything.
   */
  close(code: number = 1000, reason: string = ""): Promise<void> {
    const running: Promise<void> | undefined = this.#closePromise;
    if (running !== undefined) return running;

    this.#closing = true;
    // The transport does not wait for the socket's own `close` event — a half-open socket never
    // delivers one — so the code we asked for is the only truthful thing to report on `close`.
    this.#lastClose = { code, reason };
    for (const entry of [...this.#desired.values()]) {
      this.#clearSubscribeTimer(entry);
      entry.closed = true;
      try {
        entry.controller.finish();
      } catch (e: unknown) {
        this.#diag("warn", "listener-error", { hook: "finish", error: String(e) });
      }
    }
    this.#desired.clear();

    const done: Promise<void> = this.#transport.close(code, reason).then(
      (): void => undefined,
      (e: unknown): void => {
        this.#diag("warn", "close-failed", { error: String(e) });
      },
    );
    this.#closePromise = done;
    return done;
  }

  /**
   * Force a socket cycle.
   *
   * Closes the live socket from underneath the transport, which classifies the close and reconnects
   * on its normal schedule; the desired table is untouched, so every channel comes back with a fresh
   * token. `1000` from the server's side is classified as a drain — reconnect, no backoff floor
   * (`./backoff.js`) — which is exactly the intent here. A no-op when no socket is live: the
   * reconnect that is already scheduled will do the same job.
   */
  reconnect(reason: string): void {
    const socket: WebSocketLike | undefined = this.#socket;
    if (socket === undefined || this.state === "closed") return;
    this.#diag("info", "forced-reconnect", { reason });
    try {
      socket.close(FORCED_CYCLE_CODE, reason);
    } catch (e: unknown) {
      this.#diag("debug", "close-throw", { error: String(e) });
    }
  }

  /* ---- subscribing ----------------------------------------------------------------------------- */

  /**
   * Register a channel and return its stream.
   *
   * Legal in every state except `closed` (§4): the entry goes into the desired table immediately and
   * the wire frame is emitted the next time the socket is ready, so a caller does not have to
   * sequence `connect()` before `subscribe()`.
   *
   * The overflow policy is resolved here and passed to the subscription explicitly, because this is
   * the only layer that knows a dropped `order_book` delta breaks a nonce chain while a dropped
   * `ticker` is simply a stale quote (§13.6).
   *
   * @throws {LighterWsClosedError} on a closed client.
   * @throws {LighterWsRateLimitError} at `maxSubscriptions`, or once the server has latched a
   *   23001/23002/23003 on this socket.
   * @throws {LighterWsError} if this client already holds that channel key.
   */
  subscribe<S, U>(spec: ChannelSpec<S, U>, opts?: SubscribeOptions): Subscription<S, U> {
    if (spec === null || typeof spec !== "object" || typeof spec.key !== "string") {
      throw new LighterWsError("subscribe() needs a ChannelSpec from `channels` in ./channels.js");
    }
    if (this.state === "closed") {
      throw new LighterWsClosedError("this client is closed; construct a new LighterWsClient", {
        wsCode: 1000,
        channel: spec.key,
      });
    }
    const latched: { code: number; limit: string } | undefined = this.#fatalLimit;
    if (latched !== undefined) {
      throw new LighterWsRateLimitError(
        `the server refused a subscription on this socket with code ${String(latched.code)}: ` +
          `the "${latched.limit}" limit is exhausted for this connection. Open a second ` +
          `LighterWsClient and spread the channels across both sockets.`,
        { limit: latched.limit, code: latched.code, channel: spec.key },
      );
    }
    if (this.#desired.has(spec.key)) {
      throw new LighterWsError(
        `already subscribed to ${spec.key} on this client; one channel key has one subscription. ` +
          `Close the existing one first, or fan the events out yourself.`,
        { channel: spec.key },
      );
    }
    if (this.#desired.size >= this.#maxSubscriptions) {
      // §10.3 says to point the caller at a connection-pool class. That was cut from v1
      // (`docs/decisions.md` D10), so the message names the thing that actually exists.
      throw new LighterWsRateLimitError(
        `this client already holds ${String(this.#maxSubscriptions)} subscriptions, the documented ` +
          `per-connection ceiling. Open a second LighterWsClient and spread the channels across ` +
          `both sockets.`,
        { limit: "subscriptions", channel: spec.key },
      );
    }

    const overflow: OverflowPolicy = opts?.overflow ?? this.#overflowFor(spec.family);
    const init: {
      key: string;
      host: SubscriptionHost;
      overflow: OverflowPolicy;
      queueLimit: number;
      signal?: AbortSignal;
    } = {
      key: spec.key,
      host: this.#host(),
      overflow,
      queueLimit: opts?.queueLimit ?? this.#queueLimit,
    };
    if (opts?.signal !== undefined) init.signal = opts.signal;

    const controller: SubscriptionController<S, U> = createSubscription<S, U>(init);
    const entry: DesiredEntry = {
      key: spec.key,
      spec: spec as ChannelSpec<unknown, unknown>,
      controller: controller as unknown as SubscriptionController<unknown, unknown>,
      active: false,
      sawFirst: false,
      attempts: 0,
      authAttempts: 0,
      timer: undefined,
      lastAuth: undefined,
      closed: false,
    };
    this.#desired.set(spec.key, entry);

    if (this.state === "open") {
      void this.#sendSubscribe(entry, this.#connGen);
    } else if (this.#autoConnect && this.state === "idle") {
      try {
        void this.#transport.connect().catch((e: unknown): void => {
          this.#diag("warn", "connect-failed", { error: String(e) });
          this.#emit("error", e);
        });
        // Resolving the constructor after `connect()` keeps the ordering identical to the explicit
        // path; a missing implementation is reported, not thrown, so `subscribe()` stays total.
        this.#resolveWebSocket();
      } catch (e: unknown) {
        this.#diag("error", "connect-failed", { error: String(e) });
        this.#emit("error", e);
      }
    }

    return controller.subscription;
  }

  /* ---- raw frames ------------------------------------------------------------------------------ */

  /**
   * Write one frame now.
   *
   * Nothing is queued across a disconnect: a frame written to a socket that then dies is not a
   * delivered frame, and the layer that wants redelivery (the desired table, for subscribes) does it
   * from the `ready` hook. A caller on the `tx` lane gets a synchronous throw on a read-only socket,
   * before anything reaches the wire (§8.5).
   *
   * @throws {LighterWsReadOnlyError} `lane: 'tx'` on a `?readonly=true` socket.
   * @throws {LighterWsClosedError} when the socket is not open.
   */
  sendFrame(frame: object, opts?: { lane?: "default" | "tx" }): void {
    if (frame === null || typeof frame !== "object") {
      throw new LighterWsError("sendFrame() needs a plain object");
    }
    const tx: boolean = opts?.lane === "tx";
    if (tx && this.readOnly) throw new LighterWsReadOnlyError();
    if (this.state !== "open") {
      throw new LighterWsClosedError(`cannot send while the client is ${this.state}`, {
        wsCode: UNKNOWN_CLOSE_CODE,
      });
    }
    const text: string = encodeFrameJson(frame);
    void this.#transport.send(text, { lane: tx ? "tx" : "control" }).then(
      (): void => undefined,
      (e: unknown): void => {
        this.#diag("warn", "send-failed", { lane: tx ? "tx" : "default", error: String(e) });
        this.#emit("error", e);
      },
    );
  }

  /**
   * Tap every decoded inbound frame **before** channel routing. Return `true` to consume it.
   *
   * This is how `ws-send-tx` claims its acks without the client having to know what a transaction
   * is. A tap that throws is reported and ignored — it can never take the read loop down.
   */
  onFrame(handler: (frame: Record<string, unknown>) => boolean): () => void {
    this.#frameTaps.add(handler);
    return (): void => {
      this.#frameTaps.delete(handler);
    };
  }

  /**
   * Fires on every socket close, after the `reset` events and before resubscription begins.
   *
   * `code` is the close code where one was observed. A socket that vanishes without ever delivering
   * a `close` event — a half-open connection killed by the staleness watchdog — reports `1006`,
   * which is the same thing a real abnormal closure reports and is the honest answer.
   */
  onReconnect(handler: (info: { code: number; reason: string }) => void): () => void {
    this.#reconnectTaps.add(handler);
    return (): void => {
      this.#reconnectTaps.delete(handler);
    };
  }

  /**
   * Client-level events: `open`, `close`, `reconnect`, `error`, `diagnostic`.
   *
   * Per-subscription failures are delivered on their own subscription as `{kind:'error'}`; what
   * arrives here is what belongs to the connection — plus a copy of any subscription error that
   * carried a typed exception, so a caller with no per-channel handler still sees it.
   */
  on(
    event: "open" | "close" | "reconnect" | "error" | "diagnostic",
    cb: (e: never) => void,
  ): () => void {
    if (typeof cb !== "function") throw new LighterWsError("on() expects a function");
    let set: Set<(e: unknown) => void> | undefined = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set<(e: unknown) => void>();
      this.#listeners.set(event, set);
    }
    const handler: (e: unknown) => void = cb as unknown as (e: unknown) => void;
    set.add(handler);
    return (): void => {
      set?.delete(handler);
    };
  }

  /* ============================================================================================== */
  /* Connection hooks                                                                                */
  /* ============================================================================================== */

  /**
   * Every desired channel, re-subscribed with a fresh token.
   *
   * Runs after **every** successful handshake, the first one included — which is what makes a
   * reconnect indistinguishable from a first connect as far as the table is concerned, and what
   * makes "connected but silent" unreachable.
   *
   * Sequential on purpose. The frames are paced by the transport's 200/60 s bucket either way, but
   * awaiting each one keeps them in table order and keeps the provider from being called 500 times
   * in one tick.
   */
  async #onReady(): Promise<void> {
    this.#connGen += 1;
    const gen: number = this.#connGen;

    for (const entry of [...this.#desired.values()]) {
      if (gen !== this.#connGen || this.#closing) return;
      entry.active = false;
      entry.sawFirst = false;
      entry.attempts = 0;
      entry.authAttempts = 0;
      await this.#sendSubscribe(entry, gen);
    }
  }

  /**
   * State transitions, and the one invariant that matters: leaving `open` voids every subscription's
   * derived state *before* anything can arrive to replace it.
   *
   * Both halves of the test are load-bearing. `prev` alone is not a loss — `handshaking → open` is
   * the *successful* handshake, and treating it as a loss would fire `reset` and every `onReconnect`
   * tap on the first connect of a client that has lost nothing. `next` alone is not a loss either:
   * `idle → connecting` is a first connect. A socket was lost only when a live connection moved to a
   * state that has no socket under it.
   */
  #onState(next: WsState, prev: WsState): void {
    const wasLive: boolean = prev === "open" || prev === "handshaking";
    const wentDown: boolean =
      next === "connecting" || next === "reconnecting" || next === "closed";

    // The observed close code belongs to exactly one transition. Consumed here so a later loss that
    // never produced a `close` event reports `1006` rather than inheriting the previous socket's code.
    let info: { code: number; reason: string } | undefined;
    if (wentDown) {
      info = this.#lastClose ?? { code: UNKNOWN_CLOSE_CODE, reason: "" };
      this.#lastClose = undefined;
    }

    if (wasLive && wentDown && !this.#closing && info !== undefined) this.#onSocketLost(info);
    if (next === "open") this.#emit("open", undefined);
    if (next === "closed") this.#emit("close", info ?? { code: 1000, reason: "" });
  }

  /**
   * The socket went away.
   *
   * Order is load-bearing: reset first, then the reconnect taps, then — much later, on `ready` — the
   * resubscribes. A consumer that sees `reset` knows every delta it has applied is void; a consumer
   * that sees a snapshot first and `reset` after would throw the good snapshot away.
   */
  #onSocketLost(info: { code: number; reason: string }): void {
    // Retire the generation immediately, so a subscribe still awaiting its token or its turn at the
    // bucket cannot write to the socket that replaces this one.
    this.#connGen += 1;

    for (const entry of [...this.#desired.values()]) {
      this.#clearSubscribeTimer(entry);
      entry.active = false;
      entry.sawFirst = false;
      entry.attempts = 0;
      entry.authAttempts = 0;
      try {
        entry.controller.setState("pending");
        entry.controller.deliver({ kind: "reset", reason: "reconnect" });
      } catch (e: unknown) {
        this.#diag("warn", "listener-error", { hook: "reset", key: entry.key, error: String(e) });
      }
    }
    this.#diag("info", "reset", { channels: this.#desired.size, code: info.code });

    for (const tap of [...this.#reconnectTaps]) {
      try {
        tap(info);
      } catch (e: unknown) {
        this.#diag("warn", "listener-error", { hook: "reconnect", error: String(e) });
      }
    }
    this.#emit("reconnect", info);
  }

  /* ============================================================================================== */
  /* Outbound                                                                                        */
  /* ============================================================================================== */

  /**
   * Emit one subscribe frame and arm its ack deadline.
   *
   * The token is minted here, at send time, and never reused from a previous connection: a
   * twenty-minute outage outlives the reference client's ten-minute deadline (§7.3), and a replayed
   * token fails only the private channels — the healthiest-looking failure in the protocol.
   *
   * A write that fails because the socket died is not an error: the entry stays in the table and the
   * next `ready` sends it again.
   */
  async #sendSubscribe(entry: DesiredEntry, gen: number): Promise<void> {
    if (entry.closed || this.#closing || gen !== this.#connGen) return;

    let token: string | undefined;
    if (this.#auth !== undefined && (entry.spec.acceptsAuth || entry.spec.requiresAuth)) {
      const ctx: { accountIndex?: number; channel: string } =
        entry.spec.accountIndex === undefined
          ? { channel: entry.key }
          : { accountIndex: entry.spec.accountIndex, channel: entry.key };
      try {
        token = await this.#auth(ctx);
      } catch (e: unknown) {
        this.#diag("error", "auth-provider-failed", { key: entry.key, error: String(e) });
        this.#deliverError(entry, 0, `auth token provider failed for ${entry.key}: ${String(e)}`, false);
        return;
      }
      if (typeof token !== "string" || token.length === 0) token = undefined;
    }
    if (entry.closed || this.#closing || gen !== this.#connGen) return;
    entry.lastAuth = token;

    try {
      await this.#transport.send(buildSubscribe(entry.key, token), { lane: "control" });
    } catch (e: unknown) {
      // The socket died while this frame waited for a token or a turn. Nothing is queued across a
      // disconnect by design; the desired table is the queue.
      this.#diag("debug", "subscribe-failed", { key: entry.key, error: String(e) });
      return;
    }
    if (gen !== this.#connGen) return;
    this.#armSubscribeTimeout(entry, gen);
  }

  /**
   * `subscribed/*` deadline: retry once, then report and stay `pending` (§10.2 step 4).
   *
   * Left `pending` rather than closed on purpose — the channel may still start streaming, and the
   * next reconnect will try it again. A closed subscription would need the caller to notice and
   * rebuild it.
   */
  #armSubscribeTimeout(entry: DesiredEntry, gen: number): void {
    this.#clearSubscribeTimer(entry);
    entry.timer = this.#setTimeout((): void => {
      entry.timer = undefined;
      if (entry.active || entry.closed || gen !== this.#connGen) return;
      if (entry.attempts < 1) {
        entry.attempts += 1;
        this.#diag("warn", "subscribe-retry", { key: entry.key, afterMs: this.#subscribeTimeoutMs });
        void this.#sendSubscribe(entry, gen);
        return;
      }
      this.#diag("error", "subscribe-timeout", { key: entry.key, afterMs: this.#subscribeTimeoutMs });
      this.#deliverError(
        entry,
        0,
        `no subscribed/${entry.spec.family} for ${entry.key} within ` +
          `${String(this.#subscribeTimeoutMs)} ms, after one retry`,
        false,
      );
    }, this.#subscribeTimeoutMs);
  }

  #clearSubscribeTimer(entry: DesiredEntry): void {
    if (entry.timer === undefined) return;
    this.#clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /* ============================================================================================== */
  /* Inbound                                                                                         */
  /* ============================================================================================== */

  /**
   * The read loop's client half. **Never throws** — the whole body is guarded.
   *
   * The reference client raises on any unrecognised message, which kills its read loop and every
   * subscription with it (`docs/protocol-notes.md` §10.2). An unknown `type`, an `unsubscribed/*`
   * ack and a frame that decodes to something structurally surprising are all diagnostics here.
   */
  #onFrame(frame: InboundFrame, receivedAt: number): void {
    try {
      const body: Record<string, unknown> | undefined = bodyOf(frame);
      if (body !== undefined) {
        for (const tap of [...this.#frameTaps]) {
          let consumed: boolean = false;
          try {
            consumed = tap(body) === true;
          } catch (e: unknown) {
            this.#diag("warn", "listener-error", { hook: "frame", error: String(e) });
          }
          if (consumed) return;
        }
      }

      switch (frame.kind) {
        case "snapshot":
        case "update":
          this.#routeData(frame, receivedAt);
          return;
        case "error":
          this.#handleErrorFrame(frame);
          return;
        case "unsubscribed":
          this.#diag("debug", "unsubscribed", { channel: frame.channelRaw ?? frame.family });
          return;
        case "ack":
          // No dispatcher is attached unless `ws-send-tx` taps `onFrame`. An unclaimed ack is
          // information, never a failure.
          this.#diag("debug", "unhandled-ack", { id: frame.id });
          return;
        case "unknown":
          this.#diag("info", "unknown-type", { type: frame.type });
          return;
        case "malformed":
          this.#diag("warn", "malformed-frame", { reason: frame.reason });
          return;
        default:
          // `connected` and `ping` are the transport's business.
          return;
      }
    } catch (e: unknown) {
      this.#diag("error", "routing-error", { error: String(e) });
    }
  }

  /**
   * The five-step routing ladder (§2.3), delegated to `resolveRouteKey` and finished here.
   *
   * The ladder exists because the inbound `channel` is not the outbound key for at least three
   * channels: `account_market` echoes slashes where everything else echoes colons, `account_orders`
   * omits the account index entirely, and `market_stats/all` echoes a per-market channel it was
   * never subscribed under. Exact string equality silently drops all three.
   */
  #routeData(frame: DataFrame, receivedAt: number): void {
    const result: RouteResult = resolveRouteKey(frame, this.#desired.keys());
    if (!result.routed) {
      this.#diag("warn", "unroutable", {
        reason: result.reason,
        channel: frame.channelRaw,
        family: frame.family,
        kind: frame.kind,
      });
      return;
    }
    const entry: DesiredEntry | undefined = this.#desired.get(result.key);
    if (entry === undefined || entry.closed) {
      this.#diag("debug", "unroutable", { reason: "closed", channel: frame.channelRaw });
      return;
    }

    this.#clearSubscribeTimer(entry);
    if (!entry.active) {
      entry.active = true;
      entry.attempts = 0;
      entry.authAttempts = 0;
      entry.controller.setState("active");
    }

    // The client half of the documented `order_book` snapshot wart (§5.3): `decodeFrame` already
    // reclassifies an `update/order_book` that carries no `begin_nonce`, which is the stateless half.
    // The other half needs subscription state — the *first* frame on a fresh subscription is the
    // snapshot however it is labelled — and only exists here.
    const asSnapshot: boolean =
      frame.kind === "snapshot" || (!entry.sawFirst && entry.spec.family === "order_book");
    entry.sawFirst = true;

    const body: unknown = frame.body;
    const event: ChannelEvent<unknown, unknown> = asSnapshot
      ? { kind: "snapshot", data: entry.spec.parseSnapshot(body), raw: body, receivedAt }
      : { kind: "update", data: entry.spec.parseUpdate(body), raw: body, receivedAt };
    entry.controller.deliver(event);
  }

  /**
   * The §11 action table, as behaviour.
   *
   * Two entries look wrong and are not: 30003 (`Already Subscribed`) resolves a pending subscribe as
   * a **success**, because it is the normal outcome of a resubscribe race after a reconnect, and
   * 30009 / 23000 tighten the outbound bucket without disconnecting — the socket is fine, only our
   * send rate is not.
   */
  #handleErrorFrame(frame: ErrorFrame): void {
    const entry: DesiredEntry | undefined = this.#entryForError(frame);
    const action = classifyWsError(frame.code, {
      onUnsubscribe: frame.code === WS_ERR_NOT_SUBSCRIBED && entry === undefined,
      authed: entry?.lastAuth !== undefined,
    });
    const detail: Record<string, unknown> = {
      code: frame.code,
      message: frame.message,
      action,
      key: entry?.key ?? frame.normKey,
    };

    switch (action) {
      case "treat-as-success": {
        // 30003 means the server already holds this subscription; no snapshot will follow, so the
        // pending subscribe is resolved here or it is never resolved at all.
        this.#diag("info", "server-error", detail);
        if (entry === undefined) return;
        this.#clearSubscribeTimer(entry);
        if (!entry.active) {
          entry.active = true;
          entry.attempts = 0;
          entry.authAttempts = 0;
          entry.controller.setState("active");
        }
        return;
      }

      case "throttle": {
        this.#transport.throttleOutbound(THROTTLE_FACTOR, THROTTLE_WINDOW_MS);
        this.#diag("warn", "throttled", { ...detail, forMs: THROTTLE_WINDOW_MS });
        return;
      }

      case "reduce-inflight": {
        this.#transport.reduceInflight(INFLIGHT_REDUCTION);
        this.#diag("warn", "inflight-reduced", { ...detail, retryInMs: INFLIGHT_RETRY_MS });
        if (entry === undefined || entry.active) return;
        const gen: number = this.#connGen;
        this.#clearSubscribeTimer(entry);
        entry.timer = this.#setTimeout((): void => {
          entry.timer = undefined;
          void this.#sendSubscribe(entry, gen);
        }, INFLIGHT_RETRY_MS);
        return;
      }

      case "fatal-socket": {
        const limit: string = wsLimitName(frame.code) ?? "subscriptions";
        this.#fatalLimit = { code: frame.code, limit };
        const err: LighterWsRateLimitError = new LighterWsRateLimitError(
          `the server refused a subscription with code ${String(frame.code)} (${frame.message}): ` +
            `the "${limit}" limit is exhausted for this connection. Open a second LighterWsClient ` +
            `and spread the channels across both sockets.`,
          entry === undefined
            ? { limit, code: frame.code }
            : { limit, code: frame.code, channel: entry.key },
        );
        this.#diag("error", "socket-limit", detail);
        if (entry !== undefined) this.#deliverError(entry, frame.code, err.message, true);
        this.#emit("error", err);
        return;
      }

      case "refresh-auth": {
        if (entry === undefined) {
          this.#diag("error", "server-error", detail);
          this.#emit(
            "error",
            new LighterWsAuthError(`auth failure ${String(frame.code)}: ${frame.message}`, {
              code: frame.code,
            }),
          );
          return;
        }
        if (entry.authAttempts < 1) {
          entry.authAttempts += 1;
          this.#diag("warn", "auth-refresh", detail);
          this.#clearSubscribeTimer(entry);
          // The provider is asked again — this client never caches a token, so "invalidate the
          // cached token" is satisfied by construction (§11, §7.4).
          void this.#sendSubscribe(entry, this.#connGen);
          return;
        }
        const err: LighterWsAuthError = new LighterWsAuthError(
          `auth was refused twice for ${entry.key}: code ${String(frame.code)} (${frame.message}); ` +
            `the token from the provider is not being accepted`,
          { code: frame.code, channel: entry.key },
        );
        this.#diag("error", "server-error", detail);
        this.#deliverError(entry, frame.code, err.message, true);
        this.#emit("error", err);
        return;
      }

      case "codec-bug": {
        // Loudly, with the offending frame, and no retry: retrying a frame the server could not
        // parse just burns the outbound budget (§11).
        this.#diag("error", "codec-bug", { ...detail, frame: frame.body });
        if (entry !== undefined) this.#deliverError(entry, frame.code, frame.message, true);
        this.#emit(
          "error",
          new LighterWsError(
            `the server rejected a frame we built: code ${String(frame.code)} (${frame.message}). ` +
              `This is a bug in this SDK's codec, not in your call.`,
            entry === undefined
              ? { code: frame.code }
              : { code: frame.code, channel: entry.key },
          ),
        );
        return;
      }

      default: {
        this.#diag("warn", "server-error", detail);
        if (entry !== undefined) {
          this.#deliverError(entry, frame.code, frame.message, false);
          return;
        }
        this.#emit(
          "error",
          new LighterWsError(
            `websocket error ${String(frame.code)}: ${frame.message}`,
            frame.normKey === undefined
              ? { code: frame.code }
              : { code: frame.code, channel: frame.normKey },
          ),
        );
        return;
      }
    }
  }

  /**
   * Which subscription an error frame belongs to, if any.
   *
   * The exact key first, then the same reconstruction ladder the data frames use — an error about
   * `account_orders:0` names a channel we never subscribed to under that spelling.
   */
  #entryForError(frame: ErrorFrame): DesiredEntry | undefined {
    const normKey: string | undefined = frame.normKey;
    if (normKey !== undefined) {
      const direct: DesiredEntry | undefined = this.#desired.get(normKey);
      if (direct !== undefined) return direct;
    }
    const result: RouteResult = resolveRouteKey(frame, this.#desired.keys());
    return result.routed ? this.#desired.get(result.key) : undefined;
  }

  #deliverError(entry: DesiredEntry, code: number, message: string, fatal: boolean): void {
    try {
      entry.controller.deliver({ kind: "error", code, message, fatal });
    } catch (e: unknown) {
      this.#diag("warn", "listener-error", { hook: "deliver", key: entry.key, error: String(e) });
    }
  }

  /* ============================================================================================== */
  /* Subscription host                                                                               */
  /* ============================================================================================== */

  #host(): SubscriptionHost {
    return {
      requestResubscribe: (key: string): void => this.#requestResubscribe(key),
      requestClose: (key: string): void => this.#requestClose(key),
      diagnostic: (d: SubscriptionDiagnostic): void => {
        this.#diag(d.kind === "consumer-error" ? "warn" : "info", "subscription", {
          ...(d as unknown as Record<string, unknown>),
        });
      },
      now: (): number => this.#now(),
    };
  }

  /**
   * Overflow policy `resubscribe`: force a resync of one channel.
   *
   * Re-subscribing an already-active channel answers 30003 rather than a fresh snapshot (§5.4), so
   * the resync is `unsubscribe` then `subscribe`. Idempotent, as the host contract requires.
   */
  #requestResubscribe(key: string): void {
    const entry: DesiredEntry | undefined = this.#desired.get(key);
    if (entry === undefined || entry.closed || this.#closing) return;
    if (this.state !== "open") return; // the `ready` hook will do it anyway

    const gen: number = this.#connGen;
    this.#clearSubscribeTimer(entry);
    entry.active = false;
    entry.sawFirst = false;
    entry.attempts = 0;
    entry.controller.setState("pending");
    entry.controller.deliver({ kind: "reset", reason: "resubscribe" });
    this.#diag("info", "resubscribe", { key });

    void (async (): Promise<void> => {
      try {
        await this.#transport.send(buildUnsubscribe(key), { lane: "control" });
      } catch (e: unknown) {
        this.#diag("debug", "subscribe-failed", { key, phase: "unsubscribe", error: String(e) });
        return;
      }
      await this.#sendSubscribe(entry, gen);
    })();
  }

  /**
   * `subscription.close()`: drop the desired entry, and unsubscribe on the wire if we are connected.
   *
   * "An unsubscribe issued while disconnected removes the desired entry and sends no frame" (§10.2)
   * — there is nothing to unsubscribe from, and the entry is gone before the next `ready`, so it is
   * never resubscribed either.
   */
  #requestClose(key: string): void {
    const entry: DesiredEntry | undefined = this.#desired.get(key);
    if (entry === undefined) return;
    this.#clearSubscribeTimer(entry);
    entry.closed = true;
    this.#desired.delete(key);
    if (this.#closing || this.state !== "open") return;
    void this.#transport.send(buildUnsubscribe(key), { lane: "control" }).then(
      (): void => undefined,
      (e: unknown): void => {
        this.#diag("debug", "unsubscribe-failed", { key, error: String(e) });
      },
    );
  }

  /* ============================================================================================== */
  /* Small helpers                                                                                   */
  /* ============================================================================================== */

  /** The per-family default overflow policy (`docs/spec/06-websocket.md` §13.6). */
  #overflowFor(family: string): OverflowPolicy {
    // A dropped delta breaks the nonce chain, so overflow must force a resync rather than a hole.
    if (family === "order_book") return "resubscribe";
    // Each message is a complete state; only the newest matters.
    if (COALESCE_FAMILIES.has(family)) return "coalesce";
    // Append-only histories; the loss is recoverable over REST.
    if (DROP_OLDEST_FAMILIES.has(family)) return "drop-oldest";
    return this.#defaultOverflow;
  }

  /**
   * The socket factory handed to the transport.
   *
   * It wraps the real constructor for two reasons the transport cannot serve on its own: it records
   * the close code as the event arrives, so {@link onReconnect} reports what actually happened rather
   * than a guess, and it keeps a handle on the live socket so {@link reconnect} can force a cycle.
   * The inner constructor is resolved per instantiation, which keeps `globalThis.WebSocket` unread
   * until a socket is genuinely being opened.
   */
  #observedConstructor(): WebSocketConstructor {
    const resolve = (): WebSocketConstructor => this.#resolveWebSocket();
    const observe = (socket: WebSocketLike): void => {
      this.#socket = socket;
      socket.addEventListener("close", (e: { code: number; reason: string }): void => {
        // A socket we have already moved on from cannot describe the current connection: the
        // transport abandons a half-open socket without waiting, and its `close` event may land long
        // after the replacement is live.
        if (this.#socket !== socket) return;
        this.#lastClose = { code: e.code, reason: e.reason };
        this.#socket = undefined;
      });
    };
    return class ObservedSocket {
      constructor(url: string) {
        const socket: WebSocketLike = new (resolve())(url);
        observe(socket);
        return socket as unknown as ObservedSocket;
      }
    } as unknown as WebSocketConstructor;
  }

  /** The injected constructor, or the global one — read lazily, never at module scope. */
  #resolveWebSocket(): WebSocketConstructor {
    const injected: WebSocketConstructor | undefined = this.#wsOption;
    const ctor: WebSocketConstructor | undefined =
      injected ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (ctor === undefined) {
      throw new LighterWsError(
        "no WebSocket implementation: pass { WebSocket } explicitly — on Node 20 use " +
          "`{ WebSocket: (await import('undici')).WebSocket }`; Node 22+, Bun, Deno, Cloudflare " +
          "Workers and browsers provide `globalThis.WebSocket`",
      );
    }
    return ctor;
  }

  #onTransportDiagnostic(d: WsDiagnostic): void {
    // Our own closes never reach the socket's `close` event in time to be observed by the wrapper —
    // `WsTransport` abandons the connection and reports synchronously — so the code is picked up
    // from the diagnostic that immediately precedes the teardown.
    if (d.event === "stale") this.#lastClose = { code: 4000, reason: "inbound staleness watchdog" };
    else if (d.event === "binary-frame") this.#lastClose = { code: 4001, reason: "binary frame" };
    else if (d.event === "connect-failed") {
      this.#lastClose = { code: UNKNOWN_CLOSE_CODE, reason: "connect failed" };
    }
    this.#forward(d);
  }

  #diag(level: WsClientDiagnostic["level"], event: string, detail?: Record<string, unknown>): void {
    this.#forward(detail === undefined ? { level, event } : { level, event, detail });
  }

  #forward(d: WsClientDiagnostic): void {
    this.#emit("diagnostic", d);
    const sink: ((d: WsClientDiagnostic) => void) | undefined = this.#onDiagnostic;
    if (sink === undefined) return;
    try {
      sink(d);
    } catch {
      /* a diagnostic sink that throws is the sink's problem, never the socket's */
    }
  }

  #emit(event: string, payload: unknown): void {
    const set: Set<(e: unknown) => void> | undefined = this.#listeners.get(event);
    if (set === undefined || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (e: unknown) {
        if (event === "diagnostic") continue; // reporting a diagnostic failure as one would recurse
        this.#diag("warn", "listener-error", { event, error: String(e) });
      }
    }
  }

  #now(): number {
    const clock: (() => number) | undefined = this.#clock;
    return clock === undefined ? Date.now() : clock();
  }

  #setTimeout(fn: () => void, ms: number): number {
    const timers: LighterWsOptions["timers"] = this.#timers;
    if (timers !== undefined) return timers.setTimeout(fn, ms);
    // `setTimeout`/`clearTimeout` only — never a repeating-interval timer, so the client behaves
    // correctly inside a Durable Object across hibernation (§13.2).
    return setTimeout(fn, ms) as unknown as number;
  }

  #clearTimeout(handle: number): void {
    const timers: LighterWsOptions["timers"] = this.#timers;
    if (timers !== undefined) {
      timers.clearTimeout(handle);
      return;
    }
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }
}
