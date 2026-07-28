/**
 * An in-process WebSocket double: no socket, no server, no listening port, no real clock.
 *
 * Every WebSocket unit in this package points its injected `WebSocketConstructor` at
 * {@link MockWsServer.WebSocket} and drives the connection from the server side by hand — a dropped
 * delta, a half-open TCP connection that never delivers a close, a 1001 deploy drain, a 1008
 * rate-limit close, a binary frame, ninety seconds of silence. None of that is provokable against
 * `wss://mainnet.zklighter.elliot.ai/stream` reliably, and most of it is not provokable at all.
 *
 * ## Why this is purely in-memory
 *
 * The same suites are expected to run under workerd and in a browser, where there is no filesystem,
 * no listening socket and no server API at all. So the harness allocates nothing outside the heap:
 * delivery rides `queueMicrotask` or a virtual timer queue, and fixtures are either compiled in
 * ({@link BUILTIN_FIXTURES}) or handed to the constructor by a test that loaded them itself.
 *
 * ## The four properties that make it worth having
 *
 * 1. **Nothing is delivered synchronously.** A real `WebSocket` never re-enters your code from
 *    inside `send()`. If the double does, a reentrancy defect in the transport's reconnect and
 *    resubscribe paths passes here and fails in production. Every inbound event — `open`, the
 *    `connected` greeting, each frame, `error`, `close` — is queued and delivered on a later turn.
 * 2. **`readyState` is a real state machine** — `0 CONNECTING`, `1 OPEN`, `2 CLOSING`, `3 CLOSED` —
 *    and `send()` on a non-OPEN socket throws instead of buffering. Code that only works because
 *    the double accepted a send while CONNECTING loses frames against a real server.
 * 3. **Outbound frames are recorded as raw text.** Several assertions above this file are about
 *    exact wire spelling: that `auth` is absent rather than `null`, that `tx_infos` is a
 *    JSON-encoded string rather than an array, that a subscribe key uses slashes and not colons.
 *    Parsing before storing destroys exactly that evidence, so {@link MockWsServer.sent} is
 *    `string[]` and always will be.
 * 4. **Time is virtual.** The backoff cap is 30 s, the staleness watchdog 90 s and the keepalive
 *    45 s; real timers would make those tests either half a minute long or flaky. The harness hands
 *    the code under test a `setTimeout`/`clearTimeout` pair ({@link MockWsServer.timers}) and fires
 *    due timers from {@link MockWsServer.advance}. No wall clock is read anywhere in this file, and
 *    no real timer is ever created.
 *
 * ## Evidence status
 *
 * `test/fixtures/ws/capture.json` contains **no frames**: the wave-0 capture was refused at the
 * upgrade from a restricted jurisdiction (API code 20558, `docs/protocol-notes.md` §8.3). So the
 * compiled-in fixtures below are synthesised from the shapes in `docs/spec/06-websocket.md` §6.2.1
 * and §5.3, which are marked `[REF]` `[DOC]` there — the frame *shape* is unverified and every
 * consumer should treat it as such. What is verified, and what the fixtures are really for, is the
 * *sequencing*: snapshot then deltas, `begin_nonce` chaining to the previous `nonce`. A test that
 * needs a frame the synthesis does not contain passes an explicit array to {@link MockWsServer.replay}
 * instead, and a test running on a filesystem-bearing runtime can load the real capture itself and
 * pass it as {@link MockWsOptions.fixtures} — which is what makes these tests start exercising real
 * frames the moment a capture lands.
 */

import { normaliseChannelKey } from "../src/ws/protocol.js";
import type { WebSocketConstructor, WebSocketLike } from "../src/ws/protocol.js";

/* -------------------------------------------------------------------------------------------- */
/* Ready states                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** The WHATWG `readyState` values, as a named table so tests never assert on a bare integer. */
export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/* -------------------------------------------------------------------------------------------- */
/* Public types                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** A frame as a plain JSON-shaped value. `bigint` is permitted and emitted as a bare integer. */
export type FrameObject = Record<string, unknown>;

/** Construction-time knobs. Everything else is driven imperatively from the test. */
export interface MockWsOptions {
  /** Emit `{"type":"connected"}` on open. Default true; set false to test the handshake timeout. */
  autoConnected?: boolean;
  /**
   * The clock handed to the code under test as {@link MockWsServer.now}.
   *
   * Default: the harness's own virtual clock, which starts at 0 and moves **only** in
   * {@link MockWsServer.advance}. Timer scheduling always uses the internal clock regardless, so
   * supplying this does not desynchronise the timer queue — it only changes what the code under
   * test reads when it asks the time.
   */
  now?: () => number;
  /**
   * Delay applied to every delivered inbound event, in virtual ms. Default 0 (microtask delivery).
   *
   * With a non-zero latency nothing arrives until {@link MockWsServer.advance} moves past it, which
   * is the point: it makes "the frame was in flight when we closed" a reproducible state.
   */
  latencyMs?: number;
  /** Auto-answer subscribe/unsubscribe from fixtures. Default true. See {@link MockWsServer.responder}. */
  autoRespond?: boolean;
  /**
   * Named frame sequences for {@link MockWsServer.replay}, merged over {@link BUILTIN_FIXTURES}.
   *
   * This is the seam for the real capture: a test on a filesystem-bearing runtime reads
   * `test/fixtures/ws/` itself and passes the frames here. The harness never touches the
   * filesystem, because it must also run where there is not one.
   */
  fixtures?: Readonly<Record<string, readonly FrameObject[]>>;
}

/** How a replay is corrupted. All indices refer to positions in the **original** fixture array. */
export interface ReplayOptions {
  /**
   * Drop the Nth delta (0-based over the delta frames only) — produces exactly one nonce gap.
   *
   * A delta is a frame carrying `begin_nonce`, at the top level or inside its family payload.
   * Surviving frames are delivered **byte-identically**: nothing is renumbered and nothing is
   * repaired, so the consumer sees one discontinuity rather than a rewritten stream.
   */
  dropAt?: readonly number[];
  /** Deliver the Nth frame twice, back to back. */
  duplicateAt?: readonly number[];
  /** Swap frames i and j. Applied before {@link dropAt} and {@link duplicateAt}, in the order given. */
  swap?: readonly (readonly [number, number])[];
  /** Virtual ms between frames. Default 0. */
  intervalMs?: number;
}

/** One socket the code under test constructed. */
export interface MockSocket extends WebSocketLike {
  /** The URL it was constructed with, verbatim. */
  readonly url: string;
  /** Set when the `close` event was delivered — by either side. */
  readonly closedWith?: { code: number; reason: string } | undefined;
  /** Set synchronously when the code under test called `close()`, before any event fires. */
  readonly closeRequest?: { code: number; reason: string } | undefined;
  /** Outbound frame text from this socket, in order, unparsed. */
  readonly sent: readonly string[];
  /** Every `data` delivered to this socket, in order. Strings for text frames, otherwise not. */
  readonly received: readonly unknown[];
  /** Channels the server considers active **on this connection**. Reconnects start empty. */
  readonly activeChannels: ReadonlySet<string>;
}

/** Which parts of the default responder are live. Every one is independently switchable. */
export interface ResponderFlags {
  /** Master switch, set from {@link MockWsOptions.autoRespond}. */
  enabled: boolean;
  /** Answer a fresh `subscribe` with a `subscribed/<family>` frame. */
  subscribe: boolean;
  /** Answer a `subscribe` for an already-active channel with code 30003. */
  duplicateSubscribeError: boolean;
  /** Answer an `unsubscribe` of an active channel with `unsubscribed/<family>`. */
  unsubscribe: boolean;
  /** Answer an `unsubscribe` of an unknown channel with code 30002. */
  unknownUnsubscribeError: boolean;
  /** Accept `{"type":"pong"}` silently. Turning this off makes a pong an unanswered frame too. */
  pong: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Compiled-in fixtures                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * One `subscribed/order_book` snapshot followed by four `update/order_book` deltas.
 *
 * The chain is the load-bearing part: each delta's `begin_nonce` equals the previous frame's
 * `nonce` (`docs/spec/06-websocket.md` §6.3). Dropping delta k therefore leaves exactly one
 * discontinuity, which is what {@link ReplayOptions.dropAt} exists to produce.
 *
 * Prices and sizes are decimal **strings**, as they are on the wire and as `docs/decisions.md` D7
 * requires. Nothing in this file ever parses one.
 */
function orderBookFixture(marketId: number, base: number): FrameObject[] {
  const channel: string = `order_book:${marketId}`;
  const snapshot: FrameObject = {
    type: "subscribed/order_book",
    channel,
    offset: base,
    order_book: {
      code: 0,
      asks: [
        { price: "2500.10", size: "1.5000" },
        { price: "2500.20", size: "0.7500" },
      ],
      bids: [
        { price: "2499.90", size: "2.0000" },
        { price: "2499.80", size: "3.2500" },
      ],
      offset: base,
      nonce: base,
      begin_nonce: base,
    },
  };
  const deltas: FrameObject[] = [
    { asks: [{ price: "2500.30", size: "0.2500" }], bids: [] },
    { asks: [], bids: [{ price: "2499.90", size: "0" }] },
    { asks: [{ price: "2500.10", size: "1.2500" }], bids: [] },
    { asks: [], bids: [{ price: "2499.70", size: "4.0000" }] },
  ].map((levels: { asks: unknown[]; bids: unknown[] }, i: number): FrameObject => {
    const beginNonce: number = base + i;
    return {
      type: "update/order_book",
      channel,
      offset: beginNonce + 1,
      order_book: {
        code: 0,
        asks: levels.asks,
        bids: levels.bids,
        offset: beginNonce + 1,
        nonce: beginNonce + 1,
        begin_nonce: beginNonce,
      },
    };
  });
  return [snapshot, ...deltas];
}

/**
 * Named frame sequences available to {@link MockWsServer.replay} without any setup.
 *
 * Synthesised, not captured — see this file's header. Frozen, so a test that mutates a replayed
 * frame cannot poison another test file in the same process.
 */
export const BUILTIN_FIXTURES: Readonly<Record<string, readonly FrameObject[]>> = Object.freeze({
  "order_book/1": Object.freeze(orderBookFixture(1, 10_000)) as readonly FrameObject[],
  "order_book/0": Object.freeze(orderBookFixture(0, 500)) as readonly FrameObject[],
  "trade/1": Object.freeze([
    {
      type: "subscribed/trade",
      channel: "trade:1",
      trades: [{ trade_id: 1, price: "2500.00", size: "0.5000", is_maker_ask: true, timestamp: 1 }],
    },
    {
      type: "update/trade",
      channel: "trade:1",
      trades: [{ trade_id: 2, price: "2500.10", size: "0.2500", is_maker_ask: false, timestamp: 2 }],
    },
    {
      type: "update/trade",
      channel: "trade:1",
      trades: [{ trade_id: 3, price: "2499.90", size: "1.0000", is_maker_ask: true, timestamp: 3 }],
    },
  ]) as readonly FrameObject[],
  "market_stats/1": Object.freeze([
    {
      type: "subscribed/market_stats",
      channel: "market_stats:1",
      market_stats: { market_id: 1, index_price: "2500.00", mark_price: "2500.05" },
    },
    {
      type: "update/market_stats",
      channel: "market_stats:1",
      market_stats: { market_id: 1, index_price: "2501.00", mark_price: "2501.05" },
    },
  ]) as readonly FrameObject[],
});

/* -------------------------------------------------------------------------------------------- */
/* JSON encoding                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Serialise a frame to wire text, emitting `bigint` as a bare integer literal.
 *
 * `JSON.stringify` throws on a `bigint`, and stringifying one instead would quote a field that is
 * unquoted on the wire — `nonce`, `begin_nonce` and `offset` have no string twin
 * (`docs/spec/06-websocket.md` §3). A test needing a nonce above 2^53 writes it as a `bigint` and
 * gets the digits it asked for. Key order follows insertion order, so replay is byte-stable.
 */
function encodeFrame(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly unknown[]).map(encodeFrame).join(",")}]`;
  }
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${encodeFrame(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Slash spelling → the colon spelling the server echoes. `"order_book/1"` → `"order_book:1"`. */
function colonKey(slashKey: string): string {
  return slashKey.replaceAll("/", ":");
}

/** The family of a subscribe key: everything before the first `/`. `"candle/0/1m"` → `"candle"`. */
function familyOfKey(key: string): string {
  const slash: number = key.indexOf("/");
  return slash < 0 ? key : key.slice(0, slash);
}

/**
 * Whether a frame is a delta, for {@link ReplayOptions.dropAt}.
 *
 * A `begin_nonce` alone is not enough: snapshot and delta **share one shape**
 * (`docs/spec/06-websocket.md` §6.2.1), so the snapshot carries `begin_nonce` too. Counting it as a
 * delta would shift every `dropAt` index by one and drop the wrong frame. The `update/` prefix is
 * the discriminant, exactly as it is in `decodeFrame`; a frame with no `type` at all is judged on
 * `begin_nonce` alone, so a hand-written inline array still works.
 */
function isDeltaFrame(frame: FrameObject): boolean {
  const type: string | undefined = ownString(frame, "type");
  if (type !== undefined && !type.startsWith("update/")) return false;
  if (Object.hasOwn(frame, "begin_nonce")) return true;
  for (const value of Object.values(frame)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (Object.hasOwn(value as object, "begin_nonce")) return true;
    }
  }
  return false;
}

/** Read an own string property without tripping `noPropertyAccessFromIndexSignature`. */
function ownString(body: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value: unknown = body[key];
  return typeof value === "string" ? value : undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* Internal wiring                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** What a socket needs from its server. Keeps {@link MockSocketImpl} free of server internals. */
interface SocketHost {
  register(socket: MockSocketImpl): void;
  recordSent(socket: MockSocketImpl, frame: string): void;
  schedule(action: () => void): void;
}

type OpenListener = () => void;
type MessageListener = (e: { data: unknown }) => void;
type ErrorListener = (e: unknown) => void;
type CloseListener = (e: { code: number; reason: string }) => void;

/** The socket the code under test holds. Constructed only through {@link MockWsServer.WebSocket}. */
class MockSocketImpl implements MockSocket {
  readonly url: string;
  readonly sent: string[] = [];
  readonly received: unknown[] = [];
  readonly activeChannels: Set<string> = new Set<string>();

  #readyState: number = READY_STATE.CONNECTING;
  #closedWith: { code: number; reason: string } | undefined;
  #closeRequest: { code: number; reason: string } | undefined;
  readonly #host: SocketHost;
  readonly #open: OpenListener[] = [];
  readonly #message: MessageListener[] = [];
  readonly #error: ErrorListener[] = [];
  readonly #close: CloseListener[] = [];

  constructor(url: string, host: SocketHost) {
    this.url = url;
    this.#host = host;
    host.register(this);
  }

  get readyState(): number {
    return this.#readyState;
  }

  get closedWith(): { code: number; reason: string } | undefined {
    return this.#closedWith;
  }

  get closeRequest(): { code: number; reason: string } | undefined {
    return this.#closeRequest;
  }

  /**
   * Outbound text.
   *
   * Throws unless OPEN. The platform throws an `InvalidStateError` while CONNECTING and quietly
   * discards while CLOSING/CLOSED; the harness throws in every non-OPEN state on purpose, because
   * a discarded send is a lost order and the point of the double is to make that loud.
   */
  send(data: string): void {
    if (this.#readyState !== READY_STATE.OPEN) {
      const err: Error = new Error(
        `MockSocket.send: readyState is ${this.#readyState}, not OPEN — a real socket would not deliver this frame`,
      );
      err.name = "InvalidStateError";
      throw err;
    }
    this.sent.push(data);
    this.#host.recordSent(this, data);
  }

  /** Client-initiated close: CLOSING now, the `close` event on a later turn. */
  close(code?: number, reason?: string): void {
    if (this.#readyState === READY_STATE.CLOSING || this.#readyState === READY_STATE.CLOSED) return;
    const resolved: { code: number; reason: string } = {
      code: code ?? 1000,
      reason: reason ?? "",
    };
    this.#closeRequest = resolved;
    this.#readyState = READY_STATE.CLOSING;
    this.#host.schedule((): void => {
      this.fireClose(resolved.code, resolved.reason);
    });
  }

  addEventListener(t: "open", cb: () => void): void;
  addEventListener(t: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(t: "error", cb: (e: unknown) => void): void;
  addEventListener(t: "close", cb: (e: { code: number; reason: string }) => void): void;
  addEventListener(t: string, cb: unknown): void {
    if (t === "open") this.#open.push(cb as OpenListener);
    else if (t === "message") this.#message.push(cb as MessageListener);
    else if (t === "error") this.#error.push(cb as ErrorListener);
    else if (t === "close") this.#close.push(cb as CloseListener);
  }

  // ---- server-side drivers. Always called from a scheduled turn, never inline. ----------------

  /** @internal */
  fireOpen(): void {
    if (this.#readyState !== READY_STATE.CONNECTING) return;
    this.#readyState = READY_STATE.OPEN;
    for (const cb of [...this.#open]) cb();
  }

  /** @internal */
  fireMessage(data: unknown): void {
    if (this.#readyState === READY_STATE.CLOSED) return;
    this.received.push(data);
    for (const cb of [...this.#message]) cb({ data });
  }

  /** @internal */
  fireError(err: unknown): void {
    if (this.#readyState === READY_STATE.CLOSED) return;
    for (const cb of [...this.#error]) cb(err);
  }

  /** @internal */
  fireClose(code: number, reason: string): void {
    if (this.#readyState === READY_STATE.CLOSED) return;
    this.#readyState = READY_STATE.CLOSED;
    this.#closedWith = { code, reason };
    for (const cb of [...this.#close]) cb({ code, reason });
  }
}

/** A pending virtual timer. `seq` breaks due-time ties in scheduling order. */
interface VirtualTimer {
  readonly handle: number;
  readonly dueAt: number;
  readonly seq: number;
  readonly fn: () => void;
}

/** How many microtask turns a flush drains. Enough for a few chained `await`s, still bounded. */
const MICROTASK_ROUNDS = 12;

/** Ceiling on timers fired by one {@link MockWsServer.advance}, so a self-rescheduling timer errors. */
const MAX_TIMERS_PER_ADVANCE = 10_000;

/* -------------------------------------------------------------------------------------------- */
/* The server                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The in-process server. One per test; nothing is shared between instances.
 *
 * There is no module-level mutable state in this file, deliberately: the suite runs every test file
 * in one process, so a shared singleton would pass alone and fail in the suite.
 */
export class MockWsServer {
  /** Pass this to the code under test as its injected WebSocket constructor. */
  readonly WebSocket: WebSocketConstructor;

  /** Every socket the code under test has constructed, oldest first — reconnects append. */
  readonly sockets: MockSocketImpl[] = [];

  /** Every outbound frame text, in order, across all sockets. Raw, never parsed. */
  readonly sent: string[] = [];

  /** Which parts of the default responder are live. Mutable, so a test can switch one off mid-run. */
  readonly responder: ResponderFlags;

  /** The `setTimeout`/`clearTimeout` pair to inject into the code under test. */
  readonly timers: {
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (h: number) => void;
  };

  /** The clock to inject into the code under test. Moves only in {@link advance}, unless overridden. */
  readonly now: () => number;

  readonly #autoConnected: boolean;
  readonly #latencyMs: number;
  readonly #fixtures: Record<string, readonly FrameObject[]>;

  #clock: number = 0;
  #nextHandle: number = 1;
  #seq: number = 0;
  #pending: Map<number, VirtualTimer> = new Map<number, VirtualTimer>();
  #outbox: (() => void)[] = [];
  #stalled: boolean = false;
  #draining: boolean = false;
  #waiters: {
    pred: (frame: string) => boolean;
    resolve: (frame: string) => void;
    reject: (err: Error) => void;
    timer: number | undefined;
  }[] = [];

  constructor(opts: MockWsOptions = {}) {
    this.#autoConnected = opts.autoConnected ?? true;
    this.#latencyMs = opts.latencyMs ?? 0;
    this.#fixtures = { ...BUILTIN_FIXTURES, ...(opts.fixtures ?? {}) };
    const autoRespond: boolean = opts.autoRespond ?? true;
    this.responder = {
      enabled: autoRespond,
      subscribe: true,
      duplicateSubscribeError: true,
      unsubscribe: true,
      unknownUnsubscribeError: true,
      pong: true,
    };
    this.now = opts.now ?? ((): number => this.#clock);
    this.timers = {
      setTimeout: (fn: () => void, ms: number): number => this.#scheduleTimer(fn, ms),
      clearTimeout: (h: number): void => {
        this.#pending.delete(h);
      },
    };

    const host: SocketHost = {
      register: (socket: MockSocketImpl): void => this.#register(socket),
      recordSent: (socket: MockSocketImpl, frame: string): void => this.#onSent(socket, frame),
      schedule: (action: () => void): void => this.#deliver(action),
    };
    this.WebSocket = class MockWebSocket extends MockSocketImpl {
      constructor(url: string) {
        super(url, host);
      }
    };
  }

  /** The newest socket. Throws when the code under test has not constructed one yet. */
  get socket(): MockSocket {
    const last: MockSocketImpl | undefined = this.sockets[this.sockets.length - 1];
    if (last === undefined) {
      throw new Error("MockWsServer.socket: no socket has been constructed yet");
    }
    return last;
  }

  /** The current virtual time, in ms. Independent of {@link MockWsOptions.now}. */
  get clockMs(): number {
    return this.#clock;
  }

  /* ---- injection surface ------------------------------------------------------------------- */

  /** Deliver `frame` as a text frame. `bigint` values become bare integer literals. */
  emit(frame: object): void {
    this.emitRaw(encodeFrame(frame));
  }

  /** Deliver text verbatim — malformed JSON, a truncated frame, a bare scalar, an empty string. */
  emitRaw(text: string): void {
    const socket: MockSocketImpl = this.#activeSocket();
    this.#deliver((): void => {
      socket.fireMessage(text);
    });
  }

  /**
   * Deliver a binary frame: `data` arrives as something that is **not** a string.
   *
   * The transport is required to close with 4001 on a binary frame and never treat it as data
   * (`docs/spec/06-websocket.md` §1.2). Stringifying here would make that path untestable, so the
   * value is passed through untouched.
   */
  emitBinary(data: ArrayBuffer | Uint8Array): void {
    const socket: MockSocketImpl = this.#activeSocket();
    this.#deliver((): void => {
      socket.fireMessage(data);
    });
  }

  /** `{"type":"ping"}` — the server half of the application-level keepalive (`protocol-notes` §10.1). */
  ping(): void {
    this.emitRaw('{"type":"ping"}');
  }

  /** Server-initiated close: 1001 for a deploy drain, 1008 for a rate limit, 1006 for an abort. */
  closeWith(code: number, reason: string = ""): void {
    const socket: MockSocketImpl = this.#activeSocket();
    this.#deliver((): void => {
      socket.fireClose(code, reason);
    });
  }

  /** Fire an `error` event. The platform's error event carries no useful payload; neither does this. */
  errorEvent(err: unknown = { type: "error" }): void {
    const socket: MockSocketImpl = this.#activeSocket();
    this.#deliver((): void => {
      socket.fireError(err);
    });
  }

  /**
   * Half-open TCP: deliver nothing further and never close.
   *
   * Everything already queued is held, including a pending `close`, which is exactly the failure the
   * staleness watchdog exists for — the socket looks OPEN forever and no event ever arrives.
   */
  stall(): void {
    this.#stalled = true;
  }

  /** Undo {@link stall}. Everything held is delivered, in the order it was queued. */
  resume(): void {
    if (!this.#stalled) return;
    this.#stalled = false;
    queueMicrotask((): void => {
      this.#drain();
    });
  }

  /* ---- outbound observation ----------------------------------------------------------------- */

  /**
   * Resolve with the first outbound frame matching `pred` — including one already sent.
   *
   * `timeoutMs` is measured on the **virtual** clock, so a test that wants the rejection must
   * {@link advance} past it. A test that never advances relies on the runner's own timeout, which
   * is the honest outcome: without a real clock nothing here can tell slow apart from hung.
   */
  waitForSent(pred: (frame: string) => boolean, opts: { timeoutMs?: number } = {}): Promise<string> {
    for (const frame of this.sent) {
      if (pred(frame)) return Promise.resolve(frame);
    }
    const timeoutMs: number = opts.timeoutMs ?? 5_000;
    return new Promise<string>(
      (resolve: (frame: string) => void, reject: (err: Error) => void): void => {
        const waiter = {
          pred,
          resolve,
          reject,
          timer: undefined as number | undefined,
        };
        waiter.timer = this.#scheduleTimer((): void => {
          const at: number = this.#waiters.indexOf(waiter);
          if (at >= 0) this.#waiters.splice(at, 1);
          reject(new Error(`waitForSent: no matching frame within ${timeoutMs} virtual ms`));
        }, timeoutMs);
        this.#waiters.push(waiter);
      },
    );
  }

  /* ---- fixture replay ------------------------------------------------------------------------ */

  /**
   * Replay a fixture, optionally corrupted.
   *
   * Transforms compose in one fixed order so the result is reproducible: **swap**, then **drop**,
   * then **duplicate**. Swap positions and duplicate indices address the original array; drop
   * indices address the delta frames only (see {@link ReplayOptions.dropAt}). Frames themselves are
   * never rewritten — a gap is a gap, not a renumbering.
   *
   * Resolves once every frame has been delivered, which for a non-zero
   * {@link MockWsOptions.latencyMs} means the clock has been advanced past the last one.
   */
  async replay(
    fixture: string | readonly FrameObject[],
    opts: ReplayOptions = {},
  ): Promise<void> {
    const frames: readonly FrameObject[] = this.#resolveFixture(fixture);
    const intervalMs: number = opts.intervalMs ?? 0;

    let order: number[] = frames.map((_frame: FrameObject, i: number): number => i);

    for (const [i, j] of opts.swap ?? []) {
      const a: number | undefined = order[i];
      const b: number | undefined = order[j];
      if (a === undefined || b === undefined) {
        throw new Error(`replay: swap [${i}, ${j}] is out of range for ${frames.length} frames`);
      }
      order[i] = b;
      order[j] = a;
    }

    if (opts.dropAt !== undefined && opts.dropAt.length > 0) {
      const deltaIndices: number[] = [];
      frames.forEach((frame: FrameObject, i: number): void => {
        if (isDeltaFrame(frame)) deltaIndices.push(i);
      });
      const dropped: Set<number> = new Set<number>();
      for (const k of opts.dropAt) {
        const idx: number | undefined = deltaIndices[k];
        if (idx === undefined) {
          throw new Error(
            `replay: dropAt ${k} is out of range — the fixture has ${deltaIndices.length} delta frames`,
          );
        }
        dropped.add(idx);
      }
      order = order.filter((idx: number): boolean => !dropped.has(idx));
    }

    if (opts.duplicateAt !== undefined && opts.duplicateAt.length > 0) {
      const duplicated: Set<number> = new Set<number>(opts.duplicateAt);
      for (const k of duplicated) {
        if (k < 0 || k >= frames.length) {
          throw new Error(`replay: duplicateAt ${k} is out of range for ${frames.length} frames`);
        }
      }
      order = order.flatMap((idx: number): number[] => (duplicated.has(idx) ? [idx, idx] : [idx]));
    }

    for (const idx of order) {
      this.emit(frames[idx] as FrameObject);
      if (intervalMs > 0) await this.advance(intervalMs);
    }
    await (this.#latencyMs > 0 ? this.advance(this.#latencyMs) : this.#flush());
  }

  /* ---- virtual time -------------------------------------------------------------------------- */

  /**
   * Move the virtual clock forward, firing every timer due at or before the new time.
   *
   * Timers fire in due order, ties in scheduling order, and a timer scheduled by a firing timer is
   * itself fired if it comes due inside the same window. Microtasks are drained between firings, so
   * a callback that awaits a promise has completed before the next timer runs.
   */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`advance: ms must be a finite non-negative number, got ${String(ms)}`);
    }
    const target: number = this.#clock + ms;
    await this.#flush();
    let fired: number = 0;
    for (;;) {
      const next: VirtualTimer | undefined = this.#nextDue(target);
      if (next === undefined) break;
      if (next.dueAt > this.#clock) this.#clock = next.dueAt;
      this.#pending.delete(next.handle);
      next.fn();
      await this.#flush();
      fired += 1;
      if (fired > MAX_TIMERS_PER_ADVANCE) {
        throw new Error(
          `advance: fired ${String(MAX_TIMERS_PER_ADVANCE)} timers without draining — a timer is rescheduling itself`,
        );
      }
    }
    if (target > this.#clock) this.#clock = target;
    await this.#flush();
  }

  /** Drop every socket, frame, timer and queued delivery, and rewind the clock to 0. */
  reset(): void {
    this.sockets.length = 0;
    this.sent.length = 0;
    this.#pending.clear();
    this.#outbox = [];
    this.#stalled = false;
    this.#clock = 0;
    this.#nextHandle = 1;
    this.#seq = 0;
    for (const waiter of this.#waiters) {
      waiter.reject(new Error("waitForSent: the harness was reset"));
    }
    this.#waiters = [];
  }

  /* ---- internals ----------------------------------------------------------------------------- */

  #resolveFixture(fixture: string | readonly FrameObject[]): readonly FrameObject[] {
    if (typeof fixture !== "string") return fixture;
    const found: readonly FrameObject[] | undefined = Object.hasOwn(this.#fixtures, fixture)
      ? this.#fixtures[fixture]
      : undefined;
    if (found === undefined) {
      throw new Error(
        `replay: no fixture named ${JSON.stringify(fixture)} — available: ${Object.keys(this.#fixtures).sort().join(", ")}`,
      );
    }
    return found;
  }

  #activeSocket(): MockSocketImpl {
    const last: MockSocketImpl | undefined = this.sockets[this.sockets.length - 1];
    if (last === undefined) {
      throw new Error("MockWsServer: no socket has been constructed yet");
    }
    return last;
  }

  #register(socket: MockSocketImpl): void {
    this.sockets.push(socket);
    this.#deliver((): void => {
      socket.fireOpen();
    });
    if (this.#autoConnected) {
      this.#deliver((): void => {
        socket.fireMessage('{"type":"connected"}');
      });
    }
  }

  #onSent(socket: MockSocketImpl, frame: string): void {
    this.sent.push(frame);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.pred(frame)) continue;
      const at: number = this.#waiters.indexOf(waiter);
      if (at >= 0) this.#waiters.splice(at, 1);
      if (waiter.timer !== undefined) this.#pending.delete(waiter.timer);
      waiter.resolve(frame);
    }
    if (this.responder.enabled) this.#respond(socket, frame);
  }

  /**
   * The default responder.
   *
   * Modelled on `docs/spec/06-websocket.md` §5.1–5.4 and §11: a fresh subscribe gets the channel's
   * `subscribed/<family>` snapshot, a repeat gets 30003 rather than a second snapshot, and an
   * unsubscribe of a channel that was never active gets 30002. Both of those codes are
   * `treat-as-success` for the client (`classifyWsError`), which is precisely why they need to be
   * easy to provoke. Everything else — acks, errors, unsolicited frames — is the test's to drive.
   */
  #respond(socket: MockSocketImpl, frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const body: Record<string, unknown> = parsed as Record<string, unknown>;
    const type: string = ownString(body, "type") ?? "";

    if (type === "pong") return;

    const raw: string | undefined = ownString(body, "channel");
    if (raw === undefined) return;
    const key: string = normaliseChannelKey(raw);
    const family: string = familyOfKey(key);

    if (type === "subscribe") {
      if (socket.activeChannels.has(key)) {
        if (this.responder.duplicateSubscribeError) {
          this.#deliverTo(socket, {
            type: "error",
            code: 30003,
            message: "Already Subscribed",
            channel: colonKey(key),
          });
        }
        return;
      }
      if (!this.responder.subscribe) return;
      socket.activeChannels.add(key);
      this.#deliverTo(socket, this.#snapshotFor(key, family));
      return;
    }

    if (type === "unsubscribe") {
      if (!socket.activeChannels.has(key)) {
        if (this.responder.unknownUnsubscribeError) {
          this.#deliverTo(socket, {
            type: "error",
            code: 30002,
            message: "Not Subscribed",
            channel: colonKey(key),
          });
        }
        return;
      }
      if (!this.responder.unsubscribe) return;
      socket.activeChannels.delete(key);
      this.#deliverTo(socket, {
        type: `unsubscribed/${family}`,
        channel: colonKey(key),
      });
    }
  }

  /**
   * The `subscribed/<family>` frame for `key`: the fixture's if one exists, else a minimal synthesis.
   *
   * The minimal `order_book` snapshot carries an empty but *well-formed* payload — `code`, both
   * sides, and a `nonce` that a subsequent delta can chain onto — because a snapshot without a
   * nonce cannot start a continuity chain, and the book unit needs one that can.
   */
  #snapshotFor(key: string, family: string): FrameObject {
    for (const frames of Object.values(this.#fixtures)) {
      for (const frame of frames) {
        if (ownString(frame, "type") !== `subscribed/${family}`) continue;
        const channel: string | undefined = ownString(frame, "channel");
        if (channel !== undefined && normaliseChannelKey(channel) === key) return frame;
      }
    }
    if (family === "order_book") {
      return {
        type: "subscribed/order_book",
        channel: colonKey(key),
        offset: 0,
        order_book: {
          code: 0,
          asks: [],
          bids: [],
          offset: 0,
          nonce: 0,
          begin_nonce: 0,
        },
      };
    }
    return { type: `subscribed/${family}`, channel: colonKey(key) };
  }

  #deliverTo(socket: MockSocketImpl, frame: FrameObject): void {
    const text: string = encodeFrame(frame);
    this.#deliver((): void => {
      socket.fireMessage(text);
    });
  }

  /**
   * Queue one inbound event.
   *
   * Never runs `action` in the caller's turn. With no latency it rides a microtask; with latency it
   * rides the virtual timer queue, which means it does not arrive until {@link advance} reaches it.
   */
  #deliver(action: () => void): void {
    const enqueue = (): void => {
      this.#outbox.push(action);
      this.#drain();
    };
    if (this.#latencyMs > 0) this.#scheduleTimer(enqueue, this.#latencyMs);
    else queueMicrotask(enqueue);
  }

  /** Run queued deliveries in order, unless stalled. Reentrancy-safe: a nested call returns at once. */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#stalled) {
        const action: (() => void) | undefined = this.#outbox.shift();
        if (action === undefined) break;
        action();
      }
    } finally {
      this.#draining = false;
    }
  }

  #scheduleTimer(fn: () => void, ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`setTimeout: ms must be a finite non-negative number, got ${String(ms)}`);
    }
    const handle: number = this.#nextHandle;
    this.#nextHandle += 1;
    this.#seq += 1;
    this.#pending.set(handle, { handle, dueAt: this.#clock + ms, seq: this.#seq, fn });
    return handle;
  }

  #nextDue(target: number): VirtualTimer | undefined {
    let best: VirtualTimer | undefined;
    for (const timer of this.#pending.values()) {
      if (timer.dueAt > target) continue;
      if (best === undefined || timer.dueAt < best.dueAt) best = timer;
      else if (timer.dueAt === best.dueAt && timer.seq < best.seq) best = timer;
    }
    return best;
  }

  async #flush(): Promise<void> {
    for (let i = 0; i < MICROTASK_ROUNDS; i += 1) await Promise.resolve();
  }
}
