/**
 * The harness's own self-test.
 *
 * A test double is load-bearing infrastructure: every other WebSocket unit's verdict is only as
 * trustworthy as this file. The properties asserted here are the ones whose absence would let a
 * real defect pass — asynchronous delivery, a genuine `readyState` machine, a virtual clock that
 * creates no real timer, and a replay that corrupts a stream without silently repairing it.
 *
 * The fixtures under `test/fixtures/ws/` are read but never written, and the capture's emptiness is
 * asserted rather than glossed over (see the note in `ws-harness.ts`).
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { WebSocketConstructor, WebSocketLike } from "../../src/ws/protocol.js";
import { decodeFrame } from "../../src/ws/protocol.js";
import {
  BUILTIN_FIXTURES,
  MockWsServer,
  READY_STATE,
} from "../ws-harness.js";
import type {
  FrameObject,
  MockSocket,
  MockWsOptions,
  ReplayOptions,
  ResponderFlags,
} from "../ws-harness.js";

const URL_UNDER_TEST = "wss://mainnet.zklighter.elliot.ai/stream";

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** A connected socket plus the events it received, which is what almost every test below needs. */
function connect(server: MockWsServer): {
  socket: MockSocket;
  messages: unknown[];
  closes: { code: number; reason: string }[];
  errors: unknown[];
  opens: number[];
} {
  const messages: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  const errors: unknown[] = [];
  const opens: number[] = [];
  const socket: WebSocketLike = new server.WebSocket(URL_UNDER_TEST);
  socket.addEventListener("open", (): void => {
    opens.push(server.clockMs);
  });
  socket.addEventListener("message", (e: { data: unknown }): void => {
    messages.push(e.data);
  });
  socket.addEventListener("error", (e: unknown): void => {
    errors.push(e);
  });
  socket.addEventListener("close", (e: { code: number; reason: string }): void => {
    closes.push(e);
  });
  return { socket: socket as MockSocket, messages, closes, errors, opens };
}

/** Every message that arrived as text, decoded. Binary frames are excluded. */
function textFrames(messages: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (typeof m !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(m);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* malformed on purpose in some tests */
    }
  }
  return out;
}

/** The `(begin_nonce, nonce)` chain of every order-book frame delivered, in order. */
function nonceChain(messages: readonly unknown[]): { begin: number; end: number }[] {
  const chain: { begin: number; end: number }[] = [];
  for (const frame of textFrames(messages)) {
    const book: unknown = frame["order_book"];
    if (typeof book !== "object" || book === null) continue;
    const b: unknown = (book as Record<string, unknown>)["begin_nonce"];
    const n: unknown = (book as Record<string, unknown>)["nonce"];
    if (typeof b === "number" && typeof n === "number") chain.push({ begin: b, end: n });
  }
  return chain;
}

/** Positions in a chain where `begin_nonce` does not match the previous frame's `nonce`. */
function discontinuities(chain: readonly { begin: number; end: number }[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const prev = chain[i - 1] as { begin: number; end: number };
    const cur = chain[i] as { begin: number; end: number };
    if (cur.begin !== prev.end) gaps.push(i);
  }
  return gaps;
}

/* -------------------------------------------------------------------------------------------- */
/* Contract and exports                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe("contract", () => {
  test("MockWsServer.WebSocket is assignable to WebSocketConstructor", () => {
    const server = new MockWsServer();
    // Type-level assertion — the whole point of the harness is that this holds.
    const ctor: WebSocketConstructor = server.WebSocket;
    const socket: WebSocketLike = new ctor(URL_UNDER_TEST);
    expect(socket.readyState).toBe(READY_STATE.CONNECTING);
    expect(server.sockets).toHaveLength(1);
  });

  test("the declared option, replay and socket types are exported and usable", () => {
    const opts: MockWsOptions = { autoConnected: false, latencyMs: 5, autoRespond: false };
    const replay: ReplayOptions = { dropAt: [0], duplicateAt: [0], swap: [[0, 1]], intervalMs: 1 };
    const server = new MockWsServer(opts);
    const flags: ResponderFlags = server.responder;
    expect(flags.enabled).toBe(false);
    expect(replay.dropAt).toEqual([0]);
    expect(() => server.socket).toThrow(/no socket/);
  });

  test("socket exposes url, sent, received and closedWith", () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    expect(socket.url).toBe(URL_UNDER_TEST);
    expect(socket.sent).toEqual([]);
    expect(socket.received).toEqual([]);
    expect(socket.closedWith).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* readyState                                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe("readyState", () => {
  test("transitions 0 -> 1 -> 2 -> 3", async () => {
    const server = new MockWsServer();
    const { socket, closes } = connect(server);

    expect(socket.readyState).toBe(READY_STATE.CONNECTING);
    await server.advance(0);
    expect(socket.readyState).toBe(READY_STATE.OPEN);

    socket.close(1000, "bye");
    expect(socket.readyState).toBe(READY_STATE.CLOSING);
    expect(closes).toHaveLength(0);

    await server.advance(0);
    expect(socket.readyState).toBe(READY_STATE.CLOSED);
    expect(closes).toEqual([{ code: 1000, reason: "bye" }]);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "bye" });
  });

  test("close() records the requested code synchronously, before the event", () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    socket.close(4001, "binary frame");
    expect(socket.closeRequest).toEqual({ code: 4001, reason: "binary frame" });
    expect(socket.closedWith).toBeUndefined();
  });

  test("send() throws while CONNECTING rather than buffering", () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    expect(socket.readyState).toBe(READY_STATE.CONNECTING);
    expect(() => socket.send('{"type":"pong"}')).toThrow(/not OPEN/);
    expect(server.sent).toEqual([]);
  });

  test("send() throws while CLOSING and while CLOSED", async () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    await server.advance(0);
    socket.send('{"type":"pong"}');
    expect(server.sent).toEqual(['{"type":"pong"}']);

    socket.close();
    expect(() => socket.send('{"type":"pong"}')).toThrow(/not OPEN/);
    await server.advance(0);
    expect(socket.readyState).toBe(READY_STATE.CLOSED);
    expect(() => socket.send('{"type":"pong"}')).toThrow(/not OPEN/);
    expect(server.sent).toHaveLength(1);
  });

  test("the throw carries the platform's error name", async () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    try {
      socket.send("x");
      throw new Error("unreachable");
    } catch (err: unknown) {
      expect((err as Error).name).toBe("InvalidStateError");
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Asynchronous delivery                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe("nothing is delivered synchronously", () => {
  test("open is not fired inside the constructor", () => {
    const server = new MockWsServer();
    let opened = false;
    const socket: WebSocketLike = new server.WebSocket(URL_UNDER_TEST);
    socket.addEventListener("open", (): void => {
      opened = true;
    });
    expect(opened).toBe(false);
  });

  test("no message arrives inside the send() that provoked it", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;

    let deliveredDuringSend = false;
    socket.addEventListener("message", (): void => {
      if (inSend) deliveredDuringSend = true;
    });
    let inSend = true;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    inSend = false;

    expect(deliveredDuringSend).toBe(false);
    expect(messages).toHaveLength(0);
    await server.advance(0);
    expect(messages.length).toBeGreaterThan(0);
  });

  test("emit, errorEvent and closeWith all land on a later turn", async () => {
    const server = new MockWsServer();
    const { socket, messages, errors, closes } = connect(server);
    await server.advance(0);
    messages.length = 0;

    server.emit({ type: "ping" });
    server.errorEvent();
    server.closeWith(1006, "abnormal");
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
    expect(closes).toEqual([]);

    await server.advance(0);
    expect(messages).toEqual(['{"type":"ping"}']);
    expect(errors).toHaveLength(1);
    expect(closes).toEqual([{ code: 1006, reason: "abnormal" }]);
    expect(socket.readyState).toBe(READY_STATE.CLOSED);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The handshake                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe("handshake", () => {
  test("autoConnected: true delivers the connected greeting after open", async () => {
    const server = new MockWsServer();
    const { messages, opens } = connect(server);
    await server.advance(0);
    expect(opens).toHaveLength(1);
    expect(messages).toEqual(['{"type":"connected"}']);
    expect(decodeFrame(messages[0]).kind).toBe("connected");
  });

  test("autoConnected: false opens and then says nothing, so a handshake timeout is testable", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { socket, messages, opens } = connect(server);
    await server.advance(0);
    expect(opens).toHaveLength(1);
    expect(socket.readyState).toBe(READY_STATE.OPEN);
    expect(messages).toEqual([]);

    let timedOut = false;
    server.timers.setTimeout((): void => {
      timedOut = true;
    }, 10_000);
    await server.advance(9_999);
    expect(timedOut).toBe(false);
    await server.advance(1);
    expect(timedOut).toBe(true);
    expect(messages).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Injection surface                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("injection surface", () => {
  test("ping() sends the application-level keepalive frame", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    server.ping();
    await server.advance(0);
    expect(messages).toEqual(['{"type":"ping"}']);
  });

  test("emitRaw delivers malformed text verbatim", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    server.emitRaw('{"type":"update/order_book","order_bo');
    server.emitRaw("");
    await server.advance(0);
    expect(messages).toEqual(['{"type":"update/order_book","order_bo', ""]);
    expect(decodeFrame(messages[0]).kind).toBe("malformed");
  });

  test("emitBinary delivers data that is not a string", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    const bytes = new Uint8Array([0x82, 0x01, 0x02]);
    server.emitBinary(bytes);
    server.emitBinary(new ArrayBuffer(4));
    await server.advance(0);
    expect(messages).toHaveLength(2);
    expect(typeof messages[0]).not.toBe("string");
    expect(typeof messages[1]).not.toBe("string");
    expect(messages[0]).toBe(bytes);
    const decoded = decodeFrame(messages[0]);
    expect(decoded.kind).toBe("malformed");
    expect(decoded.kind === "malformed" ? decoded.reason : "").toBe("binary");
  });

  test("emit encodes bigint as a bare integer literal", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    server.emit({ type: "update/height", height: 9_007_199_254_740_997n });
    await server.advance(0);
    expect(messages[0]).toBe('{"type":"update/height","height":9007199254740997}');
  });

  test("closeWith carries an arbitrary code and reason", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { socket, closes } = connect(server);
    server.closeWith(1008, "rate limited");
    await server.advance(0);
    expect(closes).toEqual([{ code: 1008, reason: "rate limited" }]);
    expect(socket.closedWith).toEqual({ code: 1008, reason: "rate limited" });
  });

  test("stall() withholds everything, including the close; resume() releases it in order", async () => {
    const server = new MockWsServer();
    const { socket, messages, closes } = connect(server);
    await server.advance(0);
    messages.length = 0;

    server.stall();
    server.emit({ type: "ping" });
    server.emit({ type: "update/height", height: 1 });
    server.closeWith(1006);
    await server.advance(90_000);

    expect(messages).toEqual([]);
    expect(closes).toEqual([]);
    expect(socket.readyState).toBe(READY_STATE.OPEN);

    server.resume();
    await server.advance(0);
    expect(messages).toEqual(['{"type":"ping"}', '{"type":"update/height","height":1}']);
    expect(closes).toEqual([{ code: 1006, reason: "" }]);
  });

  test("a stalled socket still accepts sends — only the inbound direction is dead", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const { socket } = connect(server);
    await server.advance(0);
    server.stall();
    socket.send('{"type":"pong"}');
    expect(server.sent).toEqual(['{"type":"pong"}']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Latency                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("latency", () => {
  test("latencyMs holds every event until the clock reaches it", async () => {
    const server = new MockWsServer({ latencyMs: 25 });
    const { messages, opens } = connect(server);
    await server.advance(24);
    expect(opens).toEqual([]);
    expect(messages).toEqual([]);
    await server.advance(1);
    expect(opens).toEqual([25]);
    expect(messages).toEqual(['{"type":"connected"}']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Outbound observation                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe("outbound frames", () => {
  test("sent records raw text, so exact wire spelling survives", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const { socket } = connect(server);
    await server.advance(0);
    const frame = '{"type":"subscribe","channel":"order_book/1"}';
    socket.send(frame);
    expect(server.sent).toEqual([frame]);
    expect(socket.sent).toEqual([frame]);
    // The evidence that would be destroyed by parsing: slashes, and no `auth` key at all.
    expect(server.sent[0]).toContain("order_book/1");
    expect(server.sent[0]).not.toContain("auth");
  });

  test("waitForSent resolves on an already-sent frame", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const { socket } = connect(server);
    await server.advance(0);
    socket.send('{"type":"pong"}');
    await expect(server.waitForSent((f: string): boolean => f.includes("pong"))).resolves.toBe(
      '{"type":"pong"}',
    );
  });

  test("waitForSent resolves on a later frame and rejects on the virtual deadline", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const { socket } = connect(server);
    await server.advance(0);

    const pending = server.waitForSent((f: string): boolean => f.includes("subscribe"));
    socket.send('{"type":"subscribe","channel":"trade/1"}');
    await expect(pending).resolves.toContain("trade/1");

    const doomed = server
      .waitForSent((): boolean => false, { timeoutMs: 100 })
      .then((): string => "resolved", (): string => "rejected");
    await server.advance(101);
    expect(await doomed).toBe("rejected");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Default responder                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("default responder", () => {
  test("a fresh subscribe gets the fixture snapshot for that channel", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;

    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);

    const frames = textFrames(messages);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.["type"]).toBe("subscribed/order_book");
    expect(frames[0]?.["channel"]).toBe("order_book:1");
    expect(socket.activeChannels.has("order_book/1")).toBe(true);
  });

  test("a channel with no fixture gets a synthesised minimal snapshot", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;

    socket.send('{"type":"subscribe","channel":"candle/7/1m"}');
    await server.advance(0);
    const frames = textFrames(messages);
    expect(frames[0]).toEqual({ type: "subscribed/candle", channel: "candle:7:1m" });
  });

  test("a duplicate subscribe answers 30003", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    socket.send('{"type":"subscribe","channel":"trade/1"}');
    await server.advance(0);
    messages.length = 0;

    socket.send('{"type":"subscribe","channel":"trade/1"}');
    await server.advance(0);
    const frames = textFrames(messages);
    expect(frames[0]?.["code"]).toBe(30003);
    const decoded = decodeFrame(messages[0]);
    expect(decoded.kind).toBe("error");
  });

  test("an unsubscribe of an unknown channel answers 30002", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;

    socket.send('{"type":"unsubscribe","channel":"trade/9"}');
    await server.advance(0);
    expect(textFrames(messages)[0]?.["code"]).toBe(30002);
  });

  test("an unsubscribe of an active channel is acked and clears the channel", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    socket.send('{"type":"subscribe","channel":"trade/1"}');
    await server.advance(0);
    messages.length = 0;

    socket.send('{"type":"unsubscribe","channel":"trade/1"}');
    await server.advance(0);
    expect(textFrames(messages)[0]).toEqual({ type: "unsubscribed/trade", channel: "trade:1" });
    expect(socket.activeChannels.has("trade/1")).toBe(false);
  });

  test("a colon-spelled subscribe key is normalised before matching", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    socket.send('{"type":"subscribe","channel":"order_book:1"}');
    await server.advance(0);
    expect(socket.activeChannels.has("order_book/1")).toBe(true);
    messages.length = 0;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(textFrames(messages)[0]?.["code"]).toBe(30003);
  });

  test("pong is accepted silently", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;
    socket.send('{"type":"pong"}');
    await server.advance(0);
    expect(messages).toEqual([]);
  });

  test("autoRespond: false leaves every frame unanswered", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const { socket, messages } = connect(server);
    await server.advance(0);
    messages.length = 0;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    socket.send('{"type":"unsubscribe","channel":"order_book/9"}');
    await server.advance(0);
    expect(messages).toEqual([]);
  });

  test("each responder behaviour is individually switchable", async () => {
    const server = new MockWsServer();
    const { socket, messages } = connect(server);
    await server.advance(0);

    server.responder.subscribe = false;
    messages.length = 0;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(messages).toEqual([]);
    expect(socket.activeChannels.size).toBe(0);

    server.responder.subscribe = true;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    server.responder.duplicateSubscribeError = false;
    messages.length = 0;
    socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(messages).toEqual([]);

    server.responder.unknownUnsubscribeError = false;
    socket.send('{"type":"unsubscribe","channel":"order_book/5"}');
    await server.advance(0);
    expect(messages).toEqual([]);

    server.responder.unsubscribe = false;
    socket.send('{"type":"unsubscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(messages).toEqual([]);
    expect(socket.activeChannels.has("order_book/1")).toBe(true);
  });

  test("active channels are per connection, so a reconnect starts empty", async () => {
    const server = new MockWsServer();
    const first = connect(server);
    await server.advance(0);
    first.socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(first.socket.activeChannels.has("order_book/1")).toBe(true);

    server.closeWith(1006);
    await server.advance(0);

    const second = connect(server);
    await server.advance(0);
    expect(second.socket.activeChannels.size).toBe(0);
    second.messages.length = 0;
    second.socket.send('{"type":"subscribe","channel":"order_book/1"}');
    await server.advance(0);
    expect(textFrames(second.messages)[0]?.["type"]).toBe("subscribed/order_book");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Multiple sockets                                                                               */
/* -------------------------------------------------------------------------------------------- */

describe("multiple sockets", () => {
  test("a reconnect appends to sockets and sent spans both", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const first = connect(server);
    await server.advance(0);
    first.socket.send('{"type":"subscribe","channel":"order_book/1"}');

    server.closeWith(1006, "abnormal");
    await server.advance(0);
    expect(first.socket.readyState).toBe(READY_STATE.CLOSED);
    expect(first.socket.closedWith?.code).toBe(1006);

    const second = connect(server);
    await server.advance(0);
    second.socket.send('{"type":"subscribe","channel":"order_book/1"}');

    expect(server.sockets).toHaveLength(2);
    expect(server.socket).toBe(second.socket);
    expect(server.sent).toHaveLength(2);
    expect(first.socket.sent).toHaveLength(1);
    expect(second.socket.sent).toHaveLength(1);
  });

  test("injection targets the newest socket", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const first = connect(server);
    await server.advance(0);
    server.closeWith(1001, "draining");
    await server.advance(0);

    const second = connect(server);
    await server.advance(0);
    first.messages.length = 0;
    second.messages.length = 0;

    server.emit({ type: "ping" });
    await server.advance(0);
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual(['{"type":"ping"}']);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Virtual time                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe("virtual time", () => {
  test("no timer fires without advance, and none is a real timer", async () => {
    const server = new MockWsServer();
    let fired = false;
    server.timers.setTimeout((): void => {
      fired = true;
    }, 1);
    // A real 1 ms timer would have fired well within these microtask turns.
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(fired).toBe(false);
    await server.advance(1);
    expect(fired).toBe(true);
  });

  test("due timers fire in due order, ties in scheduling order", async () => {
    const server = new MockWsServer();
    const order: string[] = [];
    server.timers.setTimeout((): void => void order.push("c"), 30);
    server.timers.setTimeout((): void => void order.push("a1"), 10);
    server.timers.setTimeout((): void => void order.push("a2"), 10);
    server.timers.setTimeout((): void => void order.push("b"), 20);
    await server.advance(25);
    expect(order).toEqual(["a1", "a2", "b"]);
    await server.advance(5);
    expect(order).toEqual(["a1", "a2", "b", "c"]);
  });

  test("a timer scheduled at the boundary fires; one past it does not", async () => {
    const server = new MockWsServer();
    const fired: string[] = [];
    server.timers.setTimeout((): void => void fired.push("at"), 30_000);
    server.timers.setTimeout((): void => void fired.push("past"), 30_001);
    await server.advance(30_000);
    expect(fired).toEqual(["at"]);
    expect(server.clockMs).toBe(30_000);
  });

  test("a timer scheduled from inside a timer fires in the same window", async () => {
    const server = new MockWsServer();
    const fired: string[] = [];
    server.timers.setTimeout((): void => {
      fired.push("outer");
      server.timers.setTimeout((): void => void fired.push("inner"), 10);
    }, 10);
    await server.advance(25);
    expect(fired).toEqual(["outer", "inner"]);
  });

  test("clearTimeout cancels", async () => {
    const server = new MockWsServer();
    let fired = false;
    const handle = server.timers.setTimeout((): void => {
      fired = true;
    }, 45_000);
    server.timers.clearTimeout(handle);
    await server.advance(90_000);
    expect(fired).toBe(false);
  });

  test("now() reads the virtual clock, and an injected clock overrides it", async () => {
    const server = new MockWsServer();
    expect(server.now()).toBe(0);
    await server.advance(1_234);
    expect(server.now()).toBe(1_234);

    const fixed = new MockWsServer({ now: (): number => 42 });
    expect(fixed.now()).toBe(42);
    await fixed.advance(10);
    expect(fixed.now()).toBe(42);
    expect(fixed.clockMs).toBe(10);
  });

  test("a self-rescheduling timer is reported rather than hanging", async () => {
    const server = new MockWsServer();
    const tick = (): void => {
      server.timers.setTimeout(tick, 0);
    };
    tick();
    await expect(server.advance(1)).rejects.toThrow(/rescheduling itself/);
  });

  test("advance rejects a negative or non-finite step", async () => {
    const server = new MockWsServer();
    await expect(server.advance(-1)).rejects.toThrow(/non-negative/);
    await expect(server.advance(Number.NaN)).rejects.toThrow(/non-negative/);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Replay                                                                                         */
/* -------------------------------------------------------------------------------------------- */

describe("replay", () => {
  test("replays a named fixture in order", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1");
    const fixture = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    expect(messages).toHaveLength(fixture.length);
    expect(textFrames(messages)[0]?.["type"]).toBe("subscribed/order_book");
    expect(nonceChain(messages)).toEqual([
      { begin: 10_000, end: 10_000 },
      { begin: 10_000, end: 10_001 },
      { begin: 10_001, end: 10_002 },
      { begin: 10_002, end: 10_003 },
      { begin: 10_003, end: 10_004 },
    ]);
    expect(discontinuities(nonceChain(messages))).toEqual([]);
  });

  test("two fresh harnesses produce byte-identical sequences", async () => {
    const run = async (): Promise<unknown[]> => {
      const server = new MockWsServer({ autoConnected: false });
      const { socket, messages } = connect(server);
      await server.advance(0);
      socket.send('{"type":"subscribe","channel":"order_book/1"}');
      await server.replay("order_book/1", { intervalMs: 7 });
      expect(server.sent).toEqual(['{"type":"subscribe","channel":"order_book/1"}']);
      return messages;
    };
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });

  test("an inline frame array replays without any fixture", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay([
      { type: "update/height", height: 1 },
      { type: "some/type/we/do/not/know", extra: true },
    ]);
    expect(messages).toEqual([
      '{"type":"update/height","height":1}',
      '{"type":"some/type/we/do/not/know","extra":true}',
    ]);
  });

  test("an unknown fixture name fails loudly and lists what exists", async () => {
    const server = new MockWsServer();
    await expect(server.replay("nope")).rejects.toThrow(/no fixture named/);
  });

  test("a fixture supplied through options replaces the compiled-in one", async () => {
    const custom: FrameObject[] = [{ type: "subscribed/height", channel: "height", height: 7 }];
    const server = new MockWsServer({ autoConnected: false, fixtures: { custom } });
    const { messages } = connect(server);
    await server.replay("custom");
    expect(messages).toEqual(['{"type":"subscribed/height","channel":"height","height":7}']);
  });

  test("dropAt yields exactly one discontinuity, at that position, with nothing else touched", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1", { dropAt: [1] });

    const fixture = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    expect(messages).toHaveLength(fixture.length - 1);

    const gaps = discontinuities(nonceChain(messages));
    expect(gaps).toEqual([2]);

    // The surviving frames are byte-identical to the fixture — nothing renumbered, nothing repaired.
    const expected = [0, 1, 3, 4].map((i: number): string => JSON.stringify(fixture[i]));
    expect(messages).toEqual(expected);
  });

  test("dropAt indexes deltas only, so the snapshot is never the dropped frame", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1", { dropAt: [0] });
    expect(textFrames(messages)[0]?.["type"]).toBe("subscribed/order_book");
    expect(discontinuities(nonceChain(messages))).toEqual([1]);
  });

  test("dropAt out of range fails rather than silently doing nothing", async () => {
    const server = new MockWsServer({ autoConnected: false });
    connect(server);
    await expect(server.replay("order_book/1", { dropAt: [99] })).rejects.toThrow(/out of range/);
  });

  test("duplicateAt delivers that frame twice, back to back", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1", { duplicateAt: [2] });
    const fixture = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    const expected = [0, 1, 2, 2, 3, 4].map((i: number): string => JSON.stringify(fixture[i]));
    expect(messages).toEqual(expected);
  });

  test("swap exchanges two positions and leaves the rest alone", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1", { swap: [[1, 3]] });
    const fixture = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    const expected = [0, 3, 2, 1, 4].map((i: number): string => JSON.stringify(fixture[i]));
    expect(messages).toEqual(expected);
    // Reordering breaks the chain in two places; the frames themselves are untouched.
    expect(discontinuities(nonceChain(messages)).length).toBeGreaterThan(0);
  });

  test("swap, drop and duplicate compose in a documented order", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const { messages } = connect(server);
    await server.replay("order_book/1", { swap: [[1, 2]], dropAt: [0], duplicateAt: [4] });
    const fixture = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    // swap → [0,2,1,3,4]; drop delta 0 (original index 1) → [0,2,3,4]; duplicate index 4 → [0,2,3,4,4]
    const expected = [0, 2, 3, 4, 4].map((i: number): string => JSON.stringify(fixture[i]));
    expect(messages).toEqual(expected);
  });

  test("intervalMs spaces frames on the virtual clock", async () => {
    const server = new MockWsServer({ autoConnected: false });
    const arrivals: number[] = [];
    const socket: WebSocketLike = new server.WebSocket(URL_UNDER_TEST);
    socket.addEventListener("message", (): void => {
      arrivals.push(server.clockMs);
    });
    await server.replay("market_stats/1", { intervalMs: 100 });
    expect(arrivals).toEqual([0, 100]);
    expect(server.clockMs).toBe(200);
  });

  test("replay works under latency", async () => {
    const server = new MockWsServer({ autoConnected: false, latencyMs: 5 });
    const { messages } = connect(server);
    await server.replay("market_stats/1");
    expect(messages).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* reset                                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe("reset", () => {
  test("drops sockets, frames, timers and the clock", async () => {
    const server = new MockWsServer();
    const { socket } = connect(server);
    await server.advance(0);
    socket.send('{"type":"pong"}');
    let fired = false;
    server.timers.setTimeout((): void => {
      fired = true;
    }, 10);
    await server.advance(5);

    server.reset();
    expect(server.sockets).toEqual([]);
    expect(server.sent).toEqual([]);
    expect(server.clockMs).toBe(0);
    await server.advance(1_000);
    expect(fired).toBe(false);
  });

  test("reset rejects any pending waitForSent", async () => {
    const server = new MockWsServer();
    connect(server);
    const doomed = server
      .waitForSent((): boolean => false)
      .then((): string => "resolved", (): string => "rejected");
    server.reset();
    expect(await doomed).toBe("rejected");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Portability and fixture hygiene                                                                */
/* -------------------------------------------------------------------------------------------- */

describe("portability", () => {
  const HARNESS_URL = new URL("../ws-harness.ts", import.meta.url);
  const source: string = readFileSync(HARNESS_URL, "utf8");

  test("the harness uses no host-specific API", () => {
    const banned: readonly [string, RegExp][] = [
      ["a node builtin import", /\bnode:/],
      ["require()", /require\(/],
      ["a Bun global", /\bBun\./],
      ["a Deno global", /\bDeno\./],
      ["a real WebSocket construction", /new WebSocket\(/],
      ["setInterval", /setInterval/],
      ["Math.random", /Math\.random/],
      ["a wall-clock read", /Date\.now/],
      ["a filesystem read", /readFileSync|readFile\(/],
    ];
    for (const [what, pattern] of banned) {
      expect({ what, found: pattern.test(source) }).toEqual({ what, found: false });
    }
  });

  test("the harness only imports from src/ws/protocol.ts", () => {
    const imports: string[] = [...source.matchAll(/from "([^"]+)"/g)].map(
      (m: RegExpMatchArray): string => m[1] as string,
    );
    expect([...new Set(imports)]).toEqual(["../src/ws/protocol.js"]);
  });
});

describe("fixture hygiene", () => {
  test("the wave-0 capture is read, never written, and is still empty", () => {
    const captureUrl = new URL("../fixtures/ws/capture.json", import.meta.url);
    const capture = JSON.parse(readFileSync(captureUrl, "utf8")) as {
      frames?: unknown[];
      captureFailed?: { reason: string; apiCode: number };
    };
    // If this assertion ever fails, a real capture landed: wire it in through
    // `MockWsOptions.fixtures` and the suites above start replaying real frames.
    expect(capture.frames ?? []).toEqual([]);
    expect(capture.captureFailed?.apiCode).toBe(20558);
  });

  test("the compiled-in fixtures are frozen, so one test cannot poison another", () => {
    expect(Object.isFrozen(BUILTIN_FIXTURES)).toBe(true);
    for (const frames of Object.values(BUILTIN_FIXTURES)) {
      expect(Object.isFrozen(frames)).toBe(true);
    }
  });

  test("prices and sizes in the fixtures are decimal strings, never numbers", () => {
    const book = BUILTIN_FIXTURES["order_book/1"] as readonly FrameObject[];
    for (const frame of book) {
      const payload = frame["order_book"] as Record<string, unknown>;
      for (const side of ["asks", "bids"] as const) {
        for (const level of payload[side] as { price: unknown; size: unknown }[]) {
          expect(typeof level.price).toBe("string");
          expect(typeof level.size).toBe("string");
        }
      }
    }
  });
});
