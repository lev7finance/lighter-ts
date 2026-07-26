/**
 * The socket lifecycle: connect, greet, keep alive, detect death, classify, back off, reconnect.
 *
 * This is the only file in the package that touches a WebSocket. Everything above it — the
 * subscription table, the channel registry, the order-book maintainers — is driven by three hooks
 * exposed here ({@link WsTransport.onFrame}, {@link WsTransport.onReady}, {@link WsTransport.onState})
 * and nothing else. Everything below it is injected: the constructor, the clock and the timer pair
 * all arrive as options, so the whole lifecycle is exercised in-process against
 * `test/ws-harness.ts` with a virtual clock and no network.
 *
 * ## The boundary, stated once
 *
 * The transport does **not** know what a subscription is. It never re-sends a frame, never buffers
 * one across a disconnect, and never mints an auth token. What it guarantees is the mechanism that
 * makes automatic resubscribe possible: {@link WsTransport.onReady} fires exactly once after
 * **every** successful connection, the first one included. `src/ws/client.ts` keeps the desired-state
 * table and re-emits subscribe frames from that hook.
 *
 * Getting the boundary wrong in either direction breaks the layer above. A transport that buffers
 * frames across a reconnect fights the desired-state table and produces duplicate subscriptions
 * (answered with 30003). A transport whose `ready` hook fires only on *re*connection yields a client
 * that never subscribes at all.
 *
 * ## Two timers, not one
 *
 * They measure different directions and it is easy to collapse them:
 *
 * - **Keepalive** (`keepAliveMs`, default 45 000) measures time since the last **outbound** frame.
 *   The server closes a connection that has sent *it* nothing for two minutes
 *   (`docs/spec/06-websocket.md` §9.2, `[DOC]`). A busy order book keeps inbound frames flowing
 *   while the client sends nothing, so keying this off inbound traffic looks perfectly healthy right
 *   up to the moment the server hangs up at 120 s.
 * - **Staleness** (`stalenessTimeoutMs`, default 90 000) measures time since the last **inbound**
 *   frame. Half-open TCP — routine on mobile and behind NAT — delivers no `close` event at all, so
 *   this watchdog is the only thing that notices. It force-closes with code 4000 and reconnects.
 *
 * The keepalive frame is application-level JSON (`{"type":"pong"}`), not an RFC 6455 control frame:
 * the WHATWG `WebSocket` API exposes no way to send a control ping in browsers, Workers, Deno or
 * Bun, and the one type the server provably accepts from a stateless client is `pong`
 * (`docs/protocol-notes.md` §10.1, `docs/spec/06-websocket.md` §9.2). That is precisely why no `ws`
 * package is needed here.
 *
 * ## Runtime constraints that shaped the code
 *
 * - `setTimeout`/`clearTimeout` only — never a repeating-interval timer and never a handle
 *   de-reference call: a Cloudflare Durable Object cannot hibernate while a repeating callback is
 *   live, and this class must be constructible inside a DO constructor
 *   (`docs/spec/06-websocket.md` §13.2).
 * - **The constructor is inert.** It opens no socket, schedules no timer and reads no global — not
 *   even `globalThis.WebSocket`, which is resolved lazily inside {@link WsTransport.connect} because
 *   some runtimes populate globals after module evaluation.
 * - Frames are opaque strings on the way out and decoded values on the way in. No price is ever
 *   parsed here (`docs/decisions.md` D7).
 *
 * ## Evidence status
 *
 * The live capture is blocked (API code 20558, restricted jurisdiction — `docs/protocol-notes.md`
 * §8.3), so several behaviours below are `[DOC]` or `[DESIGN]` rather than observed: the two-minute
 * client-frame obligation, the 200 messages/minute and 50-inflight budgets, and the entire close-code
 * table. Each such dependency names its spec section at the point of use, so it can be re-checked the
 * moment a capture lands. The defensive posture is uniform: an unrecognised frame is never fatal, an
 * unrecognised close code reconnects rather than stalling, and every budget sits under the documented
 * ceiling.
 */

import { LighterConfigError, LighterValidationError } from "../errors.js";
import type { BackoffOptions, CloseClassification } from "./backoff.js";
import { BackoffController, classifyCloseCode } from "./backoff.js";
import { LighterWsClosedError, LighterWsError, LighterWsReadOnlyError } from "./errors.js";
import type { InboundFrame, WebSocketConstructor, WebSocketLike } from "./protocol.js";
import { buildPong, decodeFrame } from "./protocol.js";
import { InflightSemaphore, TokenBucket } from "./ratelimit.js";

/* ---------------------------------------------------------------------------------------------- */
/* Public types                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Where the socket is.
 *
 * `handshaking` is distinct from `open` on purpose: the socket is upgraded but the server's
 * `{"type":"connected"}` greeting has not arrived, and frames sent in that window may be dropped
 * (`docs/spec/06-websocket.md` §1.3). {@link WsTransport.send} refuses until `open`.
 *
 * `closed` is terminal. There is no path out of it.
 */
export type WsState = "idle" | "connecting" | "handshaking" | "open" | "reconnecting" | "closed";

/** Construction options. Every one has a default; none is read until {@link WsTransport.connect}. */
export interface WsTransportOptions {
  /**
   * Base URL. `wss://host` or `wss://host/stream`, with or without a trailing slash; the query is
   * built here (`docs/spec/06-websocket.md` §1.1–1.2). An `http(s)` scheme is rewritten to `ws(s)`,
   * since the WS endpoint is the REST host with the scheme swapped.
   */
  readonly url: string;
  /** Append `readonly=true`: the socket will refuse `jsonapi/sendtx*` frames server-side (§1.2). */
  readonly readOnly?: boolean;
  /** Wire encoding. Only `json` exists; the parameter is always sent (§1.2 `[INFER]`). */
  readonly encoding?: "json";
  /** Injected constructor. Defaults to `globalThis.WebSocket`, resolved inside `connect()`. */
  readonly WebSocket?: WebSocketConstructor;
  /** Budget for the `{"type":"connected"}` greeting before proceeding anyway. Default `3_000`. */
  readonly handshakeTimeoutMs?: number;
  /** Idle-outbound interval after which a keepalive frame is sent. Default `45_000`. */
  readonly keepAliveMs?: number;
  /** Idle-inbound interval after which the socket is presumed dead. Default `90_000`. */
  readonly stalenessTimeoutMs?: number;
  /** `false` disables reconnection entirely; otherwise tuning for the backoff controller. */
  readonly reconnect?: false | BackoffOptions;
  /** Non-tx outbound budget, per 60 s. Default `200` (§10.3 `[DOC]`). */
  readonly outboundPerMinute?: number;
  /** Ceiling on frames awaiting a reply. Default `40`, headroom under the documented 50 (§10.3). */
  readonly maxInflight?: number;
  /** Clock in ms. Only differences are used. Defaults to `Date.now`, read lazily. */
  readonly clock?: () => number;
  /** Timer pair. Defaults to the global `setTimeout`/`clearTimeout`, read lazily. */
  readonly timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(h: number): void;
  };
  /**
   * The keepalive filler. Default `() => buildPong()`. Returning `null` skips this round without
   * disarming the timer — the seam for an integrator whose server later rejects unsolicited pongs.
   */
  readonly keepAliveFrame?: () => string | null;
  /** Structured lifecycle events. Never throws into the transport; a throwing sink is ignored. */
  readonly onDiagnostic?: (d: WsDiagnostic) => void;
}

/**
 * One lifecycle event.
 *
 * `event` is a stable slug, not prose: `"handshake-timeout"`, `"stale"`, `"reconnecting"`,
 * `"auth-suspect"`, `"drain"`, `"binary-frame"`, `"malformed-frame"`, `"socket-error"`,
 * `"connect-failed"`, `"give-up"`, `"callback-error"`, `"keepalive"`.
 */
export interface WsDiagnostic {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * A held inflight slot.
 *
 * Handed back by `send(frame, { awaitsReply: true })`. Settling it releases the slot for the next
 * frame; every outstanding ticket is settled automatically when the connection closes, because no
 * reply can arrive on a socket that no longer exists. `settle()` is idempotent.
 */
export interface InflightTicket {
  settle(): void;
}

/** Which pacing lane a frame belongs to. */
export type WsSendLane = "control" | "tx";

/** Per-frame options for {@link WsTransport.send}. */
export interface WsSendOptions {
  /**
   * `"control"` (default) draws a token from the outbound bucket. `"tx"` bypasses it entirely —
   * `sendTx`/`sendTxBatch` are excluded from the 200/min WS budget and count against the REST
   * limits instead (`docs/spec/06-websocket.md` §8.6, §10.3) — but stays in submission order.
   */
  readonly lane?: WsSendLane;
  /** Take an inflight slot, released when the returned ticket settles. */
  readonly awaitsReply?: boolean;
}

/* ---------------------------------------------------------------------------------------------- */
/* Defaults                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const DEFAULT_HANDSHAKE_TIMEOUT_MS: 3_000 = 3_000;
const DEFAULT_KEEPALIVE_MS: 45_000 = 45_000;
const DEFAULT_STALENESS_TIMEOUT_MS: 90_000 = 90_000;
const DEFAULT_OUTBOUND_PER_MINUTE: 200 = 200;
const DEFAULT_MAX_INFLIGHT: 40 = 40;

/** The refill window the outbound budget is expressed over. */
const OUTBOUND_WINDOW_MS: 60_000 = 60_000;

/** WHATWG `readyState` for an open socket. Declared rather than read off a global. */
const READY_STATE_OPEN: 1 = 1;

/** Our close code for "the inbound watchdog fired" (`docs/spec/06-websocket.md` §9.4). */
const CLOSE_STALE: 4000 = 4000;

/** Our close code for "fatal protocol error" — a binary frame (§1.2, §9.4). */
const CLOSE_PROTOCOL: 4001 = 4001;

/**
 * Safety net on the token-acquisition loop.
 *
 * The lane chain serialises sends, so in practice at most a couple of turns are ever needed; the
 * bound exists so that a misbehaving injected clock cannot spin forever.
 */
const MAX_TOKEN_ROUNDS = 10_000;

/* ---------------------------------------------------------------------------------------------- */
/* URL                                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Build the fully-resolved stream URL.
 *
 * `wss://mainnet.zklighter.elliot.ai/` → `wss://mainnet.zklighter.elliot.ai/stream?encoding=json`.
 *
 * Deliberately string surgery rather than `new URL()`: the WHATWG parser normalises percent-encoding
 * and reorders nothing but is happy to mangle an unusual host, and the derivation rule in
 * `docs/spec/06-websocket.md` §1.1 is literally "strip any trailing slash, then join `/stream`".
 * A caller's own query parameters are preserved; `encoding` and `readonly` are ours and are replaced
 * rather than duplicated.
 */
function resolveStreamUrl(rawUrl: string, readOnly: boolean, encoding: "json"): string {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new LighterConfigError("WebSocket url must be a non-empty string", { code: "WS_URL" });
  }

  let text: string = rawUrl.trim();
  const hash: number = text.indexOf("#");
  if (hash >= 0) text = text.slice(0, hash);

  if (text.startsWith("https://")) text = `wss://${text.slice("https://".length)}`;
  else if (text.startsWith("http://")) text = `ws://${text.slice("http://".length)}`;

  if (!text.startsWith("wss://") && !text.startsWith("ws://")) {
    throw new LighterConfigError(
      `WebSocket url must use ws:// or wss:// (got ${JSON.stringify(rawUrl)})`,
      { code: "WS_URL" },
    );
  }

  const q: number = text.indexOf("?");
  const query: string = q >= 0 ? text.slice(q + 1) : "";
  let path: string = q >= 0 ? text.slice(0, q) : text;

  while (path.endsWith("/")) path = path.slice(0, -1);
  if (!path.endsWith("/stream")) path = `${path}/stream`;

  const params: string[] = [];
  for (const part of query.split("&")) {
    if (part.length === 0) continue;
    if (part === "encoding" || part.startsWith("encoding=")) continue;
    if (part === "readonly" || part.startsWith("readonly=")) continue;
    params.push(part);
  }
  params.push(`encoding=${encoding}`);
  if (readOnly) params.push("readonly=true");

  return `${path}?${params.join("&")}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** A pending `setTimeout` that must be rejected and cleared when the connection goes away. */
interface Sleeper {
  readonly reject: (e: unknown) => void;
  handle: number | undefined;
}

/** A `send` waiting for an inflight slot. */
interface InflightWaiter {
  readonly resolve: () => void;
  readonly reject: (e: unknown) => void;
}

/** A held slot. `settle()` is idempotent, and teardown settles without double-releasing. */
class Ticket implements InflightTicket {
  #settled = false;
  readonly #onSettle: () => void;

  constructor(onSettle: () => void) {
    this.#onSettle = onSettle;
  }

  get settled(): boolean {
    return this.#settled;
  }

  settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#onSettle();
  }

  /** @internal Teardown path: mark settled without releasing, since the semaphore is zeroed wholesale. */
  markSettled(): void {
    this.#settled = true;
  }
}

function requireFinitePositive(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LighterConfigError(`${name} must be a finite number > 0`, { code: "WS_TRANSPORT_OPTION" });
  }
  return value;
}

/* ---------------------------------------------------------------------------------------------- */
/* The transport                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One socket, for its whole life.
 *
 * **Mutable state owned here** (`docs/decisions.md` D8), for the lifetime of the instance: the state
 * machine, the current socket and its generation counter, four timer handles, the last-inbound and
 * last-outbound timestamps, the outbound token bucket, the inflight semaphore and its outstanding
 * tickets, the backoff controller, the two lane queues, and the subscriber lists. No subscription
 * state, no channel state, no order-book state — those belong to the layer above.
 */
export class WsTransport {
  // ---- configuration, all resolved in the constructor and never re-read -----------------------

  readonly #rawUrl: string;
  readonly #url: string;
  readonly #readOnly: boolean;
  readonly #ctorOption: WebSocketConstructor | undefined;
  readonly #handshakeTimeoutMs: number;
  readonly #keepAliveMs: number;
  readonly #stalenessTimeoutMs: number;
  readonly #outboundPerMinute: number;
  readonly #clockOption: (() => number) | undefined;
  readonly #timersOption: WsTransportOptions["timers"];
  readonly #keepAliveFrame: () => string | null;
  readonly #onDiagnostic: ((d: WsDiagnostic) => void) | undefined;
  readonly #backoff: BackoffController | null;
  readonly #inflight: InflightSemaphore;

  // ---- mutable state ---------------------------------------------------------------------------

  #state: WsState = "idle";
  #socket: WebSocketLike | undefined;
  /**
   * Bumped for every new socket and every teardown.
   *
   * Every listener and every queued send captures the value it was created under, so a late `close`
   * from a socket we already abandoned — and a `subscribe` that was waiting on a token when the
   * connection died — are both dropped instead of acting on the wrong generation.
   */
  #gen = 0;
  #ctor: WebSocketConstructor | undefined;
  #started = false;
  #clientInitiated = false;
  #consecutivePolicyCloses = 0;

  #handshakeTimer: number | undefined;
  #keepAliveTimer: number | undefined;
  #stalenessTimer: number | undefined;
  #reconnectTimer: number | undefined;

  #lastInboundAt = 0;
  #lastOutboundAt = 0;

  #bucketInstance: TokenBucket | undefined;
  readonly #tickets: Set<Ticket> = new Set<Ticket>();
  readonly #inflightWaiters: InflightWaiter[] = [];
  readonly #sleepers: Set<Sleeper> = new Set<Sleeper>();

  #controlTail: Promise<void> = Promise.resolve();
  #txTail: Promise<void> = Promise.resolve();

  readonly #frameCbs: Set<(f: InboundFrame, raw: string, receivedAt: number) => void> = new Set();
  readonly #readyCbs: Set<() => void | Promise<void>> = new Set();
  readonly #stateCbs: Set<(s: WsState, prev: WsState) => void> = new Set();
  #connectWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  /**
   * Pure. No socket, no timer, no global read — safe at module scope and inside a Durable Object
   * constructor. The only work done here is option validation and URL derivation.
   */
  constructor(opts: WsTransportOptions) {
    if (opts === null || typeof opts !== "object") {
      throw new LighterConfigError("WsTransport requires an options object with a url", {
        code: "WS_TRANSPORT_OPTION",
      });
    }
    this.#rawUrl = opts.url;
    this.#readOnly = opts.readOnly === true;
    this.#url = resolveStreamUrl(opts.url, this.#readOnly, opts.encoding ?? "json");
    this.#ctorOption = opts.WebSocket;
    this.#handshakeTimeoutMs = requireFinitePositive(
      "handshakeTimeoutMs",
      opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    this.#keepAliveMs = requireFinitePositive("keepAliveMs", opts.keepAliveMs ?? DEFAULT_KEEPALIVE_MS);
    this.#stalenessTimeoutMs = requireFinitePositive(
      "stalenessTimeoutMs",
      opts.stalenessTimeoutMs ?? DEFAULT_STALENESS_TIMEOUT_MS,
    );
    this.#outboundPerMinute = requireFinitePositive(
      "outboundPerMinute",
      opts.outboundPerMinute ?? DEFAULT_OUTBOUND_PER_MINUTE,
    );
    this.#clockOption = opts.clock;
    this.#timersOption = opts.timers;
    this.#keepAliveFrame = opts.keepAliveFrame ?? ((): string | null => buildPong());
    this.#onDiagnostic = opts.onDiagnostic;
    this.#backoff = opts.reconnect === false ? null : new BackoffController(opts.reconnect);
    this.#inflight = new InflightSemaphore(opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
  }

  /* ---- introspection ------------------------------------------------------------------------- */

  get state(): WsState {
    return this.#state;
  }

  /** The fully resolved URL, query included. What the socket was, or will be, constructed with. */
  get url(): string {
    return this.#url;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  /**
   * Inflight slots currently held. Diagnostic only — the budget is enforced inside {@link send}.
   *
   * Drops to zero on every close, because a reply to a frame sent on a dead socket can never arrive.
   */
  get inflight(): number {
    return this.#inflight.inflight;
  }

  /* ---- lifecycle ----------------------------------------------------------------------------- */

  /**
   * Open the socket, resolving the first time the state reaches `open`.
   *
   * Calling it again while connecting joins the same attempt; calling it once open resolves at once.
   * Two failures are raised **synchronously**, because both are programmer errors rather than
   * connection outcomes: calling it after {@link close}, and running in a runtime with no WebSocket
   * and no injected constructor. Ordinary connection failures reject the returned promise only when
   * reconnection is disabled or exhausted — otherwise the promise stays pending across retries,
   * since the intent ("be connected") is still in force.
   */
  connect(): Promise<void> {
    if (this.#state === "closed") {
      throw new LighterWsError("this transport was closed; construct a new one to reconnect");
    }
    if (this.#state === "open") return Promise.resolve();

    if (!this.#started) {
      // The one place `globalThis.WebSocket` may be read: lazily, and only when no constructor was
      // injected. Reading it at module scope breaks runtimes that populate globals late and would
      // make this file impure at import (`docs/spec/06-websocket.md` §13.2).
      const injected: WebSocketConstructor | undefined = this.#ctorOption;
      const ctor: WebSocketConstructor | undefined =
        injected ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
      if (ctor === undefined) {
        throw new LighterWsError(
          "no WebSocket implementation: pass { WebSocket } explicitly — on Node 20 use " +
            "`{ WebSocket: (await import('undici')).WebSocket }`; Node 22+, Bun, Deno, Cloudflare " +
            "Workers and browsers provide `globalThis.WebSocket`",
        );
      }
      this.#ctor = ctor;
      this.#started = true;
      this.#openSocket();
    }

    return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
      this.#connectWaiters.push({ resolve, reject });
    });
  }

  /**
   * Terminal shutdown. Idempotent.
   *
   * Everything is torn down synchronously — timers cleared, tickets settled, queued sends rejected,
   * reconnection suppressed — and the socket's own `close` event is *not* waited for, because a
   * half-open socket never delivers one. A later {@link connect} throws.
   */
  async close(code: number = 1000, reason: string = ""): Promise<void> {
    if (this.#state === "closed") return;

    this.#clientInitiated = true;
    this.#clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = undefined;

    const socket: WebSocketLike | undefined = this.#socket;
    // Retire the current generation so the socket's own `close` event — which may never arrive at
    // all on a half-open connection — cannot re-enter the pipeline behind us.
    this.#gen += 1;
    this.#teardownConnection();
    if (socket !== undefined) {
      try {
        socket.close(code, reason);
      } catch (e: unknown) {
        this.#diag("debug", "close-throw", { error: String(e) });
      }
    }

    this.#setState("closed");
    this.#rejectConnectWaiters(
      new LighterWsClosedError("transport closed before it opened", {
        wsCode: code,
        wsReason: reason,
      }),
    );
    // Give listeners a turn, so `await close()` reads as "the shutdown has been observed".
    await Promise.resolve();
  }

  /* ---- sending ------------------------------------------------------------------------------- */

  /**
   * Write one frame, paced.
   *
   * Rejects with {@link LighterWsClosedError} whenever the transport is not `open` — at call time,
   * or at any point while the frame waits for a token or an inflight slot. **Nothing is ever queued
   * across a disconnect**: a frame that was waiting when the socket died is rejected, not re-sent,
   * because a subscribe written to a socket that then dies is not a subscription and the
   * desired-state table in `ws/client.ts` re-emits it from the `ready` hook.
   *
   * Frames are serialised per lane and written in submission order within it. The `control` lane
   * draws one token from the 200/60 s bucket; the `tx` lane bypasses the bucket entirely (§8.6) but
   * is still ordered.
   */
  async send(frame: string, opts?: WsSendOptions): Promise<InflightTicket | null> {
    if (typeof frame !== "string") {
      throw new LighterValidationError("WS_FRAME_INVALID", "frame must be a string", {
        field: "frame",
      });
    }
    const lane: WsSendLane = opts?.lane ?? "control";
    const awaitsReply: boolean = opts?.awaitsReply === true;

    if (lane === "tx" && this.#readOnly) {
      throw new LighterWsReadOnlyError();
    }
    this.#assertOpen();

    const epoch: number = this.#gen;
    const run = (): Promise<InflightTicket | null> => this.#runSend(frame, lane, awaitsReply, epoch);

    const tail: Promise<void> = lane === "tx" ? this.#txTail : this.#controlTail;
    const result: Promise<InflightTicket | null> = tail.then(run, run);
    const next: Promise<void> = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    if (lane === "tx") this.#txTail = next;
    else this.#controlTail = next;
    return result;
  }

  /* ---- subscriptions ------------------------------------------------------------------------- */

  /** Every decoded inbound frame, in arrival order. Binary frames are never delivered. */
  onFrame(cb: (f: InboundFrame, raw: string, receivedAt: number) => void): () => void {
    this.#frameCbs.add(cb);
    return (): void => {
      this.#frameCbs.delete(cb);
    };
  }

  /**
   * Fires after **every** successful handshake, the first one included, exactly once per connection.
   *
   * This is the resubscribe hook. It fires once the transport reaches `open`, which happens either on
   * the `{"type":"connected"}` greeting or when the handshake budget expires — never twice for one
   * socket, and never zero times for a socket that opened.
   */
  onReady(cb: () => void | Promise<void>): () => void {
    this.#readyCbs.add(cb);
    return (): void => {
      this.#readyCbs.delete(cb);
    };
  }

  /** Every state transition, with the state it came from. */
  onState(cb: (s: WsState, prev: WsState) => void): () => void {
    this.#stateCbs.add(cb);
    return (): void => {
      this.#stateCbs.delete(cb);
    };
  }

  /* ---- rate-limit responses ------------------------------------------------------------------ */

  /**
   * Multiply the outbound refill rate by `factor` for `forMs`, then restore.
   *
   * The documented response to 30009 / 23000 is to halve the rate for 60 s and **not** disconnect
   * (`docs/spec/06-websocket.md` §11): `throttleOutbound(0.5, 60_000)`. Driven from the layer above,
   * which is where inbound error codes are classified.
   */
  throttleOutbound(factor: number, forMs: number): void {
    this.#bucket().throttle(factor, forMs);
    this.#diag("info", "throttled", { factor, forMs });
  }

  /**
   * Shrink the inflight ceiling by `fraction` of its current value — the documented response to
   * 30010 is a 25 % reduction, i.e. `reduceInflight(0.25)` (§11).
   *
   * Slots already held are not revoked; their replies are still coming.
   */
  reduceInflight(fraction: number): void {
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new LighterValidationError(
        "WS_INFLIGHT_FRACTION",
        "reduceInflight fraction must be a number in [0, 1]",
        { field: "fraction" },
      );
    }
    const current: number = this.#inflight.max;
    const next: number = Number.isFinite(current) ? Math.floor(current * (1 - fraction)) : current;
    this.#inflight.resize(next);
    this.#diag("info", "inflight-reduced", { fraction, max: this.#inflight.max });
  }

  /* ============================================================================================ */
  /* Connection                                                                                    */
  /* ============================================================================================ */

  #openSocket(): void {
    const ctor: WebSocketConstructor | undefined = this.#ctor;
    if (ctor === undefined) return;

    this.#gen += 1;
    const gen: number = this.#gen;
    this.#setState("connecting");

    let socket: WebSocketLike;
    try {
      socket = new ctor(this.#url);
    } catch (e: unknown) {
      // A constructor that throws is indistinguishable from a connection that never opened: an
      // abnormal close, code 1006. Classifying it any other way would strand the client.
      this.#diag("error", "connect-failed", { error: String(e), url: this.#rawUrl });
      this.#afterClose(1006, "constructor threw");
      return;
    }
    this.#socket = socket;

    socket.addEventListener("open", (): void => {
      if (gen !== this.#gen) return;
      this.#onOpen();
    });
    socket.addEventListener("message", (e: { data: unknown }): void => {
      if (gen !== this.#gen) return;
      this.#onMessage(e.data);
    });
    socket.addEventListener("error", (e: unknown): void => {
      if (gen !== this.#gen) return;
      // The platform's error event carries no useful payload and is always followed by a close for a
      // socket that really failed; a socket that errors and then goes silent is the watchdog's.
      this.#diag("warn", "socket-error", { error: String(e) });
    });
    socket.addEventListener("close", (e: { code: number; reason: string }): void => {
      if (gen !== this.#gen) return;
      this.#gen += 1;
      this.#teardownConnection();
      this.#afterClose(e.code, e.reason);
    });
  }

  #onOpen(): void {
    const now: number = this.#now();
    this.#lastInboundAt = now;
    this.#lastOutboundAt = now;
    this.#setState("handshaking");
    this.#armKeepAlive(this.#keepAliveMs);
    this.#armStaleness(this.#stalenessTimeoutMs);

    // Never deadlock on the greeting: the public documentation never mentions it, and `wscat` usage
    // in the docs implies subscribing immediately is legal (`docs/spec/06-websocket.md` §1.3
    // `[INFER]`). If it does not arrive in budget we proceed and say so.
    this.#handshakeTimer = this.#setTimeout((): void => {
      this.#handshakeTimer = undefined;
      if (this.#state !== "handshaking") return;
      this.#diag("warn", "handshake-timeout", { afterMs: this.#handshakeTimeoutMs });
      this.#promoteToOpen();
    }, this.#handshakeTimeoutMs);
  }

  #promoteToOpen(): void {
    this.#clearTimer(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    if (this.#state !== "handshaking") return;

    this.#backoff?.noteOpen(this.#now());
    this.#setState("open");

    // Ready first, then the `connect()` waiters: the resubscribe frames are queued before an awaiting
    // caller gets control, which is the order that keeps a reconnect indistinguishable from a fresh
    // connect from above.
    for (const cb of [...this.#readyCbs]) {
      try {
        const r: void | Promise<void> = cb();
        if (r !== undefined && typeof (r as Promise<void>).then === "function") {
          void (r as Promise<void>).catch((e: unknown): void => {
            this.#diag("warn", "callback-error", { hook: "ready", error: String(e) });
          });
        }
      } catch (e: unknown) {
        this.#diag("warn", "callback-error", { hook: "ready", error: String(e) });
      }
    }

    const waiters = this.#connectWaiters;
    this.#connectWaiters = [];
    for (const w of waiters) w.resolve();
  }

  #onMessage(data: unknown): void {
    const receivedAt: number = this.#now();
    this.#lastInboundAt = receivedAt;

    const frame: InboundFrame = decodeFrame(data);

    if (frame.kind === "malformed" && frame.reason === "binary") {
      // Binary is not part of this protocol (§1.2). Never surfaced as data: interpreting it would be
      // guessing at an encoding we did not ask for.
      this.#diag("error", "binary-frame", { close: CLOSE_PROTOCOL });
      this.#failConnection(CLOSE_PROTOCOL, "binary frame");
      return;
    }

    if (frame.kind === "connected") {
      this.#promoteToOpen();
    } else if (frame.kind === "ping") {
      // Ahead of anything queued, and without waiting on the bucket: the two-minute obligation is not
      // worth a pacing delay (§9.1, §9.2). A token is taken opportunistically when one is there.
      this.#bucketTryTake();
      this.#writeImmediate(buildPong(), "pong");
    } else if (frame.kind === "malformed") {
      this.#diag("warn", "malformed-frame", { reason: frame.reason });
    }

    const raw: string = typeof data === "string" ? data : "";
    for (const cb of [...this.#frameCbs]) {
      try {
        cb(frame, raw, receivedAt);
      } catch (e: unknown) {
        // A subscriber that throws must not take down the read loop — that is exactly the reference
        // client's defect (`docs/protocol-notes.md` §10.2).
        this.#diag("warn", "callback-error", { hook: "frame", error: String(e) });
      }
    }
  }

  /**
   * Abandon the current socket on our own initiative, without waiting for a `close` event that may
   * never come. Used by the staleness watchdog (4000) and the binary-frame guard (4001).
   */
  #failConnection(code: number, reason: string): void {
    const socket: WebSocketLike | undefined = this.#socket;
    this.#gen += 1;
    this.#teardownConnection();
    if (socket !== undefined) {
      try {
        socket.close(code, reason);
      } catch (e: unknown) {
        this.#diag("debug", "close-throw", { error: String(e) });
      }
    }
    this.#afterClose(code, reason);
  }

  /**
   * The close pipeline: classify, decide, schedule.
   *
   * `#teardownConnection` has already run by the time this is called, so no timer from the dead
   * connection is live and no queued send can still fire.
   */
  #afterClose(code: number, reason: string): void {
    if (this.#state === "closed") return;

    this.#backoff?.noteClose(this.#now());

    if (code === 1008) this.#consecutivePolicyCloses += 1;
    else this.#consecutivePolicyCloses = 0;

    const cls: CloseClassification = classifyCloseCode(code, {
      clientInitiated: this.#clientInitiated,
      consecutivePolicyCloses: this.#consecutivePolicyCloses,
    });

    if (cls.diagnostic === "auth-suspect") {
      this.#diag("warn", "auth-suspect", {
        code,
        consecutivePolicyCloses: this.#consecutivePolicyCloses,
      });
    } else if (cls.diagnostic === "drain") {
      // A deploy drain is a normal, frequent, non-error event (§9.4 `[DOC]`).
      this.#diag("info", "drain", { code, reason });
    }

    const backoff: BackoffController | null = this.#backoff;
    const attempt: number = backoff === null ? 0 : backoff.attempt;
    const delayMs: number | null = backoff === null ? null : backoff.nextDelayMs(cls);

    if (delayMs === null) {
      if (cls.reconnect && backoff !== null) {
        this.#diag("error", "give-up", { code, cls: cls.cls, attempt });
      }
      this.#setState("closed");
      this.#rejectConnectWaiters(
        new LighterWsClosedError(
          cls.reconnect
            ? `reconnection exhausted after close ${String(code)}`
            : `socket closed with code ${String(code)}`,
          { wsCode: code, wsReason: reason },
        ),
      );
      return;
    }

    this.#setState("reconnecting");
    this.#diag("info", "reconnecting", { code, cls: cls.cls, attempt, delayMs, minDelayMs: cls.minDelayMs });
    this.#reconnectTimer = this.#setTimeout((): void => {
      this.#reconnectTimer = undefined;
      if (this.#state !== "reconnecting") return;
      this.#openSocket();
    }, delayMs);
  }

  /**
   * Drop everything that belongs to one connection.
   *
   * Timers first (so nothing fires mid-teardown), then the waiters, then the tickets. Called before
   * every reconnect and by {@link close}; leaving any of it behind is what keeps a Worker awake.
   */
  #teardownConnection(): void {
    this.#clearTimer(this.#handshakeTimer);
    this.#clearTimer(this.#keepAliveTimer);
    this.#clearTimer(this.#stalenessTimer);
    this.#handshakeTimer = undefined;
    this.#keepAliveTimer = undefined;
    this.#stalenessTimer = undefined;
    this.#socket = undefined;

    const closed: LighterWsClosedError = new LighterWsClosedError(
      "the socket closed before this frame could be written",
      { wsCode: 1006 },
    );

    for (const sleeper of [...this.#sleepers]) {
      this.#sleepers.delete(sleeper);
      this.#clearTimer(sleeper.handle);
      sleeper.handle = undefined;
      sleeper.reject(closed);
    }

    while (this.#inflightWaiters.length > 0) {
      const waiter: InflightWaiter | undefined = this.#inflightWaiters.shift();
      waiter?.reject(closed);
    }

    for (const ticket of [...this.#tickets]) ticket.markSettled();
    this.#tickets.clear();
    this.#inflight.releaseAll();
  }

  /* ============================================================================================ */
  /* Timers                                                                                        */
  /* ============================================================================================ */

  /**
   * Keepalive, measured on the last **outbound** frame.
   *
   * Re-arms itself for the remaining interval rather than being cleared and rebuilt on every write:
   * a busy client would otherwise churn a timer per frame, and Durable Object alarm scheduling is not
   * free.
   */
  #armKeepAlive(ms: number): void {
    this.#clearTimer(this.#keepAliveTimer);
    this.#keepAliveTimer = this.#setTimeout((): void => {
      this.#keepAliveTimer = undefined;
      if (this.#state !== "open" && this.#state !== "handshaking") return;
      const idle: number = this.#now() - this.#lastOutboundAt;
      if (idle < this.#keepAliveMs) {
        this.#armKeepAlive(this.#keepAliveMs - idle);
        return;
      }
      const frame: string | null = this.#keepAliveFrame();
      if (frame !== null) {
        this.#bucketTryTake();
        this.#writeImmediate(frame, "keepalive");
      }
      this.#armKeepAlive(this.#keepAliveMs);
    }, ms);
  }

  /** Staleness, measured on the last **inbound** frame. Same self-rearming shape. */
  #armStaleness(ms: number): void {
    this.#clearTimer(this.#stalenessTimer);
    this.#stalenessTimer = this.#setTimeout((): void => {
      this.#stalenessTimer = undefined;
      if (this.#state !== "open" && this.#state !== "handshaking") return;
      const idle: number = this.#now() - this.#lastInboundAt;
      if (idle < this.#stalenessTimeoutMs) {
        this.#armStaleness(this.#stalenessTimeoutMs - idle);
        return;
      }
      this.#diag("warn", "stale", { idleMs: idle, close: CLOSE_STALE });
      this.#failConnection(CLOSE_STALE, "inbound staleness watchdog");
    }, ms);
  }

  /* ============================================================================================ */
  /* Outbound                                                                                      */
  /* ============================================================================================ */

  async #runSend(
    frame: string,
    lane: WsSendLane,
    awaitsReply: boolean,
    epoch: number,
  ): Promise<InflightTicket | null> {
    this.#assertLive(epoch);

    if (lane !== "tx") await this.#awaitToken(epoch);

    let ticket: Ticket | null = null;
    if (awaitsReply) {
      await this.#acquireInflight(epoch);
      // Registered the instant the slot is taken, so a close arriving between here and the write
      // still settles it rather than leaking the slot for the rest of the connection.
      const held: Ticket = new Ticket((): void => {
        this.#tickets.delete(held);
        this.#inflight.release();
        this.#pumpInflight();
      });
      this.#tickets.add(held);
      ticket = held;
      if (!this.#isLive(epoch)) {
        held.settle();
        this.#assertLive(epoch);
      }
    }

    try {
      this.#write(frame);
    } catch (e: unknown) {
      ticket?.settle();
      throw e instanceof LighterWsClosedError
        ? e
        : new LighterWsClosedError("the socket rejected the frame", {
            wsCode: 1006,
            cause: e,
          });
    }
    return ticket;
  }

  /** Draw one token, waiting for it if necessary. Rejects if the connection dies while waiting. */
  async #awaitToken(epoch: number): Promise<void> {
    const bucket: TokenBucket = this.#bucket();
    for (let round = 0; round < MAX_TOKEN_ROUNDS; round += 1) {
      if (bucket.tryTake(1)) return;
      const wait: number = bucket.msUntilAvailable(1);
      if (!Number.isFinite(wait)) {
        throw new LighterWsError("the outbound budget can never admit this frame");
      }
      // Rounded up to whole milliseconds: sleeping for the exact fractional deficit can land a hair
      // short of the token under floating-point, and a scheduler with sub-ms resolution is a fiction
      // in every runtime we target.
      await this.#sleep(Math.max(1, Math.ceil(wait)), epoch);
      this.#assertLive(epoch);
    }
    throw new LighterWsError("outbound pacing made no progress");
  }

  #acquireInflight(epoch: number): Promise<void> {
    this.#assertLive(epoch);
    if (this.#inflight.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
      this.#inflightWaiters.push({ resolve, reject });
    });
  }

  /** Hand freed slots to whoever is waiting, oldest first. */
  #pumpInflight(): void {
    while (this.#inflightWaiters.length > 0) {
      if (!this.#inflight.tryAcquire()) return;
      const waiter: InflightWaiter | undefined = this.#inflightWaiters.shift();
      if (waiter === undefined) {
        this.#inflight.release();
        return;
      }
      waiter.resolve();
    }
  }

  /** A cancellable wait. Every sleeper is rejected and its timer cleared when the connection dies. */
  #sleep(ms: number, epoch: number): Promise<void> {
    this.#assertLive(epoch);
    return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
      const sleeper: Sleeper = { reject, handle: undefined };
      this.#sleepers.add(sleeper);
      sleeper.handle = this.#setTimeout((): void => {
        if (!this.#sleepers.delete(sleeper)) return;
        sleeper.handle = undefined;
        resolve();
      }, ms);
    });
  }

  /** The write itself, plus the keepalive bookkeeping that must follow every successful one. */
  #write(frame: string): void {
    const socket: WebSocketLike | undefined = this.#socket;
    if (socket === undefined || socket.readyState !== READY_STATE_OPEN) {
      throw new LighterWsClosedError("the socket is not open", { wsCode: 1006 });
    }
    socket.send(frame);
    // The keepalive timer is not rebuilt here. It re-arms itself when it fires and finds the last
    // outbound frame too recent, which costs one timer per idle interval instead of one per frame.
    this.#lastOutboundAt = this.#now();
  }

  /** Out-of-band write for `pong` and the keepalive filler: no queue, no pacing delay, never throws. */
  #writeImmediate(frame: string, what: string): void {
    try {
      this.#write(frame);
    } catch (e: unknown) {
      this.#diag("debug", "write-failed", { what, error: String(e) });
    }
  }

  #bucket(): TokenBucket {
    let bucket: TokenBucket | undefined = this.#bucketInstance;
    if (bucket === undefined) {
      // Lazy: `TokenBucket` samples the clock in its constructor, and this class promises to read
      // nothing at construction time.
      bucket = new TokenBucket({
        capacity: this.#outboundPerMinute,
        refillIntervalMs: OUTBOUND_WINDOW_MS,
        now: (): number => this.#now(),
      });
      this.#bucketInstance = bucket;
    }
    return bucket;
  }

  /** Opportunistic draw for a frame that will be written whether or not a token is available. */
  #bucketTryTake(): void {
    try {
      this.#bucket().tryTake(1);
    } catch {
      /* a bucket that refuses to account for one frame must not stop the keepalive */
    }
  }

  /* ============================================================================================ */
  /* Small helpers                                                                                 */
  /* ============================================================================================ */

  #isLive(epoch: number): boolean {
    return this.#state === "open" && this.#gen === epoch;
  }

  #assertLive(epoch: number): void {
    if (!this.#isLive(epoch)) {
      throw new LighterWsClosedError(
        "the connection ended before this frame could be written; it was not queued",
        { wsCode: 1006 },
      );
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new LighterWsClosedError(`cannot send while the transport is ${this.#state}`, {
        wsCode: 1006,
      });
    }
  }

  #setState(next: WsState): void {
    const prev: WsState = this.#state;
    if (prev === next) return;
    this.#state = next;
    for (const cb of [...this.#stateCbs]) {
      try {
        cb(next, prev);
      } catch (e: unknown) {
        this.#diag("warn", "callback-error", { hook: "state", error: String(e) });
      }
    }
  }

  #rejectConnectWaiters(err: unknown): void {
    const waiters = this.#connectWaiters;
    this.#connectWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  #diag(level: WsDiagnostic["level"], event: string, detail?: Record<string, unknown>): void {
    const sink: ((d: WsDiagnostic) => void) | undefined = this.#onDiagnostic;
    if (sink === undefined) return;
    try {
      sink(detail === undefined ? { level, event } : { level, event, detail });
    } catch {
      /* a diagnostic sink that throws is the sink's problem, never the socket's */
    }
  }

  #now(): number {
    const clock: (() => number) | undefined = this.#clockOption;
    return clock === undefined ? Date.now() : clock();
  }

  #setTimeout(fn: () => void, ms: number): number {
    const timers: WsTransportOptions["timers"] = this.#timersOption;
    if (timers !== undefined) return timers.setTimeout(fn, ms);
    // The global `setTimeout` only: no repeating-interval timer, and no handle de-reference call
    // (which a Durable Object would be broken by and which does not exist outside Node anyway).
    return setTimeout(fn, ms) as unknown as number;
  }

  #clearTimer(handle: number | undefined): void {
    if (handle === undefined) return;
    const timers: WsTransportOptions["timers"] = this.#timersOption;
    if (timers !== undefined) {
      timers.clearTimeout(handle);
      return;
    }
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }
}
