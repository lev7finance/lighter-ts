/**
 * `src/ws/transport.ts` — the socket lifecycle, against the in-process harness only.
 *
 * Nothing here touches the network, and nothing here waits on a real clock: every timer the
 * transport schedules goes through {@link MockWsServer.timers} and is fired by
 * {@link MockWsServer.advance}, so a ninety-second staleness timeout costs microseconds and is
 * exact rather than flaky.
 *
 * The properties worth the most are the ones whose absence only shows up in production:
 *
 * - the keepalive timer keys off **outbound** traffic and the staleness timer off **inbound**
 *   traffic — collapsing them looks fine on a busy stream and gets the connection closed at 120 s;
 * - a half-open socket that never delivers a `close` event is still detected (`stall()`);
 * - a client-initiated 1000 does not reconnect while a server-initiated 1000 does;
 * - `ready` fires on the **first** connection as well as every reconnection, exactly once each;
 * - nothing is queued across a disconnect.
 */

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test } from "bun:test";

import { LighterConfigError } from "../../src/errors.js";
import { LighterWsClosedError, LighterWsError } from "../../src/ws/errors.js";
import type { InboundFrame, WebSocketConstructor } from "../../src/ws/protocol.js";
import type { InflightTicket, WsDiagnostic, WsState, WsTransportOptions } from "../../src/ws/transport.js";
import { WsTransport } from "../../src/ws/transport.js";
import { MockWsServer } from "../ws-harness.js";

const BASE_URL = "wss://mainnet.zklighter.elliot.ai";

/* ---------------------------------------------------------------------------------------------- */
/* Rig                                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** A `setTimeout`/`clearTimeout` pair that also tracks which handles are still live. */
function countingTimers(server: MockWsServer): {
  live: Set<number>;
  timers: NonNullable<WsTransportOptions["timers"]>;
} {
  const live: Set<number> = new Set<number>();
  const timers: NonNullable<WsTransportOptions["timers"]> = {
    setTimeout(fn: () => void, ms: number): number {
      let handle = -1;
      handle = server.timers.setTimeout((): void => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(h: number): void {
      live.delete(h);
      server.timers.clearTimeout(h);
    },
  };
  return { live, timers };
}

interface Rig {
  readonly server: MockWsServer;
  readonly transport: WsTransport;
  readonly diagnostics: WsDiagnostic[];
  readonly states: { state: WsState; prev: WsState }[];
  readonly frames: { frame: InboundFrame; raw: string; at: number }[];
  readonly readyAt: number[];
  readonly live: Set<number>;
}

function rig(
  overrides: Partial<WsTransportOptions> = {},
  serverOpts: ConstructorParameters<typeof MockWsServer>[0] = {},
): Rig {
  const server = new MockWsServer(serverOpts);
  const { live, timers } = countingTimers(server);
  const diagnostics: WsDiagnostic[] = [];
  const states: { state: WsState; prev: WsState }[] = [];
  const frames: { frame: InboundFrame; raw: string; at: number }[] = [];
  const readyAt: number[] = [];

  const transport = new WsTransport({
    url: BASE_URL,
    WebSocket: server.WebSocket,
    clock: server.now,
    timers,
    // Deterministic backoff: full jitter with `random() === 0` collapses to the class floor, which is
    // 0 for most codes, so a reconnect fires on the next `advance`.
    reconnect: { random: (): number => 0 },
    onDiagnostic: (d: WsDiagnostic): void => {
      diagnostics.push(d);
    },
    ...overrides,
  });

  transport.onState((state: WsState, prev: WsState): void => {
    states.push({ state, prev });
  });
  transport.onFrame((frame: InboundFrame, raw: string, at: number): void => {
    frames.push({ frame, raw, at });
  });
  transport.onReady((): void => {
    readyAt.push(server.clockMs);
  });

  return { server, transport, diagnostics, states, frames, readyAt, live };
}

/**
 * Drain the microtask queue.
 *
 * `MockWsServer.advance` flushes a bounded number of microtask rounds between timer firings — enough
 * for a few chained `await`s, but not for hundreds of queued sends handing the lane on to each other.
 * Draining explicitly keeps the measurement about the token bucket rather than about the harness.
 */
async function settle(rounds: number = 2_000): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Every frame the client wrote, parsed just far enough to read its `type`. */
function sentTypes(server: MockWsServer): string[] {
  return server.sent.map((text: string): string => {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? String((parsed as Record<string, unknown>)["type"])
      : "";
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* URL                                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe("resolved URL", () => {
  test("a trailing slash is stripped and /stream + encoding are appended", () => {
    const t = new WsTransport({ url: "wss://mainnet.zklighter.elliot.ai/" });
    expect(t.url).toBe("wss://mainnet.zklighter.elliot.ai/stream?encoding=json");
    expect(t.readOnly).toBe(false);
  });

  test("readOnly adds readonly=true", () => {
    const t = new WsTransport({ url: BASE_URL, readOnly: true });
    expect(t.url).toBe("wss://mainnet.zklighter.elliot.ai/stream?encoding=json&readonly=true");
    expect(t.readOnly).toBe(true);
  });

  test("an explicit /stream path is not doubled", () => {
    const t = new WsTransport({ url: "wss://testnet.zklighter.elliot.ai/stream" });
    expect(t.url).toBe("wss://testnet.zklighter.elliot.ai/stream?encoding=json");
  });

  test("an https base is rewritten to wss, since the WS endpoint is the REST host", () => {
    const t = new WsTransport({ url: "https://api.rh.lighter.xyz" });
    expect(t.url).toBe("wss://api.rh.lighter.xyz/stream?encoding=json");
  });

  test("a caller's own query survives, and ours replace rather than duplicate", () => {
    const t = new WsTransport({ url: "wss://host/stream?foo=1&encoding=proto", readOnly: true });
    expect(t.url).toBe("wss://host/stream?foo=1&encoding=json&readonly=true");
  });

  test("a non-websocket scheme and an empty url are refused at construction", () => {
    expect(() => new WsTransport({ url: "ftp://host" })).toThrow(LighterConfigError);
    expect(() => new WsTransport({ url: "   " })).toThrow(LighterConfigError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Inertness                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("the constructor is inert", () => {
  test("no socket, no timer, and no globalThis.WebSocket read", async () => {
    const server = new MockWsServer();
    const { live, timers } = countingTimers(server);
    let globalReads = 0;

    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
      globalThis,
      "WebSocket",
    );
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get(): unknown {
        globalReads += 1;
        return undefined;
      },
    });
    try {
      const t = new WsTransport({ url: BASE_URL, timers, clock: server.now });
      expect(t.state).toBe("idle");
      expect(server.sockets.length).toBe(0);
      expect(live.size).toBe(0);
      expect(globalReads).toBe(0);
      // Nothing wakes up on its own, either.
      await server.advance(600_000);
      expect(server.sockets.length).toBe(0);
      expect(live.size).toBe(0);
      expect(globalReads).toBe(0);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "WebSocket");
      } else {
        Object.defineProperty(globalThis, "WebSocket", descriptor);
      }
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Handshake                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("handshake", () => {
  test("the connected greeting promotes to open and fires ready exactly once", async () => {
    const r = rig();
    await r.transport.connect();

    expect(r.transport.state).toBe("open");
    expect(r.readyAt).toEqual([0]);
    expect(r.states.map((s): WsState => s.state)).toEqual(["connecting", "handshaking", "open"]);
    expect(r.frames.map((f): string => f.frame.kind)).toEqual(["connected"]);

    // A second greeting on the same socket must not fire ready again.
    r.server.emit({ type: "connected" });
    await r.server.advance(0);
    expect(r.readyAt).toEqual([0]);
  });

  test("no greeting: ready still fires after the default 3 000 ms, with a warn diagnostic", async () => {
    const r = rig({}, { autoConnected: false });
    const opened: Promise<void> = r.transport.connect();
    await r.server.advance(2_999);
    expect(r.transport.state).toBe("handshaking");
    expect(r.readyAt).toEqual([]);

    await r.server.advance(1);
    await opened;
    expect(r.transport.state).toBe("open");
    expect(r.readyAt).toEqual([3_000]);

    const warned: WsDiagnostic | undefined = r.diagnostics.find(
      (d: WsDiagnostic): boolean => d.event === "handshake-timeout",
    );
    expect(warned?.level).toBe("warn");
  });

  test("send is refused until the handshake resolves", async () => {
    const r = rig({}, { autoConnected: false });
    void r.transport.connect();
    await r.server.advance(0);
    expect(r.transport.state).toBe("handshaking");
    await expect(r.transport.send('{"type":"pong"}')).rejects.toBeInstanceOf(LighterWsClosedError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Ping / keepalive / staleness                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("ping and keepalive", () => {
  test("a server ping is answered with exactly one pong, promptly", async () => {
    const r = rig();
    await r.transport.connect();
    r.server.ping();
    await r.server.advance(0);

    expect(r.server.sent).toEqual(['{"type":"pong"}']);
    expect(r.server.clockMs).toBe(0);
    expect(r.frames.map((f): string => f.frame.kind)).toEqual(["connected", "ping"]);
  });

  test("under total silence exactly one frame goes out per keepAliveMs", async () => {
    // The staleness watchdog is disarmed for the duration so the two timers can be observed apart.
    const r = rig({ stalenessTimeoutMs: 10_000_000 });
    await r.transport.connect();

    await r.server.advance(44_999);
    expect(r.server.sent.length).toBe(0);
    await r.server.advance(1);
    expect(r.server.sent).toEqual(['{"type":"pong"}']);

    await r.server.advance(45_000);
    expect(r.server.sent.length).toBe(2);
    await r.server.advance(45_000);
    expect(r.server.sent.length).toBe(3);
  });

  test("sending any frame resets the keepalive timer", async () => {
    const r = rig({ stalenessTimeoutMs: 10_000_000 });
    await r.transport.connect();

    await r.server.advance(30_000);
    await r.transport.send('{"type":"pong"}');
    expect(r.server.sent.length).toBe(1);

    // 45 000 ms after the connection opened, but only 15 000 ms after the last outbound frame.
    await r.server.advance(15_000);
    expect(r.server.sent.length).toBe(1);

    await r.server.advance(30_000);
    expect(r.server.sent.length).toBe(2);
  });

  test("a keepAliveFrame returning null skips the round without disarming the timer", async () => {
    const r = rig({
      stalenessTimeoutMs: 10_000_000,
      keepAliveFrame: (): string | null => null,
    });
    await r.transport.connect();
    await r.server.advance(200_000);
    expect(r.server.sent.length).toBe(0);
    expect(r.transport.state).toBe("open");
  });
});

describe("staleness watchdog", () => {
  test("a half-open socket that never closes is force-closed with 4000 and reconnects", async () => {
    const r = rig({ reconnect: { random: (): number => 1, baseDelayMs: 1_000 } });
    await r.transport.connect();
    const first = r.server.socket;

    // Nothing is delivered from here on — not even a close event. Only the watchdog can notice.
    r.server.stall();
    await r.server.advance(90_000);

    expect(first.closeRequest?.code).toBe(4000);
    expect(r.diagnostics.some((d: WsDiagnostic): boolean => d.event === "stale")).toBe(true);
    expect(r.transport.state).toBe("reconnecting");

    await r.server.advance(1_000);
    expect(r.server.sockets.length).toBe(2);
  });

  test("inbound traffic keeps the watchdog quiet indefinitely", async () => {
    const r = rig({ keepAliveMs: 10_000_000 });
    await r.transport.connect();
    for (let i = 0; i < 10; i += 1) {
      r.server.ping();
      await r.server.advance(60_000);
    }
    expect(r.transport.state).toBe("open");
    expect(r.server.sockets.length).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Close classification and reconnect                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("close classification", () => {
  test("a client-initiated 1000 is terminal", async () => {
    const r = rig();
    await r.transport.connect();
    await r.transport.close();

    expect(r.transport.state).toBe("closed");
    await r.server.advance(120_000);
    expect(r.server.sockets.length).toBe(1);
    expect(() => r.transport.connect()).toThrow(LighterWsError);
  });

  for (const code of [1000, 1001, 1006, 1008, 1011, 4000, 4001]) {
    test(`a server-initiated ${String(code)} reconnects`, async () => {
      const r = rig();
      await r.transport.connect();
      r.server.closeWith(code, "");
      // 1001 carries a 1 000 ms floor, and repeated 1008 a 5 000 ms one; one advance covers both.
      await r.server.advance(5_000);
      expect(r.server.sockets.length).toBe(2);
      expect(r.transport.state).toBe("open");
    });
  }

  test("the scheduled delay stays inside [minDelayMs, min(30 000, 250 · 2^attempt)]", async () => {
    const r = rig({ reconnect: { random: (): number => 0.5 } });
    await r.transport.connect();

    for (let i = 0; i < 8; i += 1) {
      r.server.closeWith(1006, "");
      await r.server.advance(30_000);
    }

    const scheduled = r.diagnostics.filter((d: WsDiagnostic): boolean => d.event === "reconnecting");
    expect(scheduled.length).toBe(8);
    scheduled.forEach((d: WsDiagnostic, i: number): void => {
      const detail = d.detail as { attempt: number; delayMs: number; minDelayMs: number };
      // Uptime between closes is far under `stableAfterMs`, so the counter never resets.
      expect(detail.attempt).toBe(i);
      const cap: number = Math.min(30_000, 250 * 2 ** detail.attempt);
      expect(detail.delayMs).toBeGreaterThanOrEqual(detail.minDelayMs);
      expect(detail.delayMs).toBeLessThanOrEqual(cap);
    });
  });

  test("two consecutive 1008 closes raise the floor and emit auth-suspect", async () => {
    const r = rig({ reconnect: { random: (): number => 0 } });
    await r.transport.connect();

    r.server.closeWith(1008, "policy");
    await r.server.advance(10_000);
    expect(r.diagnostics.some((d: WsDiagnostic): boolean => d.event === "auth-suspect")).toBe(false);

    r.server.closeWith(1008, "policy");
    await r.server.advance(10_000);
    const suspect = r.diagnostics.find((d: WsDiagnostic): boolean => d.event === "auth-suspect");
    expect(suspect?.level).toBe("warn");

    const scheduled = r.diagnostics.filter((d: WsDiagnostic): boolean => d.event === "reconnecting");
    expect((scheduled[0]?.detail as { minDelayMs: number }).minDelayMs).toBe(0);
    expect((scheduled[1]?.detail as { minDelayMs: number }).minDelayMs).toBe(5_000);
    expect((scheduled[1]?.detail as { delayMs: number }).delayMs).toBe(5_000);
  });

  test("reconnect: false makes any close terminal", async () => {
    const r = rig({ reconnect: false });
    await r.transport.connect();
    r.server.closeWith(1006, "");
    await r.server.advance(60_000);

    expect(r.transport.state).toBe("closed");
    expect(r.server.sockets.length).toBe(1);
  });

  test("ready fires exactly once per successful connection, first one included", async () => {
    const r = rig();
    await r.transport.connect();
    expect(r.readyAt.length).toBe(1);

    r.server.closeWith(1006, "");
    await r.server.advance(1_000);
    expect(r.server.sockets.length).toBe(2);
    expect(r.readyAt.length).toBe(2);

    r.server.closeWith(1006, "");
    await r.server.advance(1_000);
    expect(r.readyAt.length).toBe(3);
    expect(r.transport.state).toBe("open");
  });

  test("a connect() that has not yet opened rejects when reconnection is exhausted", async () => {
    const r = rig({ reconnect: { random: (): number => 0, maxAttempts: 0 } }, { autoConnected: false });
    const opening: Promise<void> = r.transport.connect();
    await r.server.advance(0);
    r.server.closeWith(1006, "");
    await r.server.advance(0);
    await expect(opening).rejects.toBeInstanceOf(LighterWsClosedError);
    expect(r.transport.state).toBe("closed");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Outbound pacing                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("outbound pacing", () => {
  test("500 frames drain at the bucket rate and all of them go out", async () => {
    // Both timers are pushed out of the way: this test is about the bucket and nothing else.
    const r = rig(
      { keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 500; i += 1) {
      sends.push(r.transport.send(`{"type":"subscribe","channel":"order_book/${String(i)}"}`));
    }

    // The bucket starts full, which is deliberate: `src/ws/ratelimit.ts` grants a fresh connection
    // its whole burst so that a 400-channel resubscribe after a reconnect is not starved for a full
    // minute. So the first instant carries `capacity` frames and the pacing begins after it.
    await settle();
    expect(r.server.sent.length).toBe(200);
    expect(r.server.clockMs).toBe(0);

    // Sample the cumulative count every 300 ms — exactly one token's worth at 200 / 60 s.
    const timeline: { at: number; sent: number }[] = [];
    for (let step = 0; step < 340; step += 1) {
      await r.server.advance(300);
      await settle(50);
      timeline.push({ at: r.server.clockMs, sent: r.server.sent.length });
    }
    await Promise.all(sends);

    expect(r.server.sent.length).toBe(500);

    // The bucket's contract, which holds at every instant including the burst: cumulative writes
    // never exceed `capacity + rate · elapsed`. The `+1` absorbs the whole-millisecond rounding of
    // each pacing wait.
    for (const point of timeline) {
      expect(point.sent).toBeLessThanOrEqual(200 + point.at / 300 + 1);
    }

    // Sustained rate: once the starting credit is spent, no rolling 60 s window contains more than
    // the documented 200 client messages (`docs/spec/06-websocket.md` §10.3).
    for (let i = 0; i + 200 < timeline.length; i += 1) {
      const start = timeline[i] as { at: number; sent: number };
      const end = timeline[i + 200] as { at: number; sent: number };
      expect(end.at - start.at).toBe(60_000);
      expect(end.sent - start.sent).toBeLessThanOrEqual(200);
    }
  }, 30_000);

  test("tx frames bypass the bucket even when it is empty, and keep submission order", async () => {
    const r = rig(
      { outboundPerMinute: 1, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    // Drain the single-token bucket.
    await r.transport.send('{"type":"subscribe","channel":"height"}');
    expect(r.server.sent.length).toBe(1);

    const txs: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      txs.push(r.transport.send(`{"type":"jsonapi/sendtx","data":{"id":"${String(i)}"}}`, { lane: "tx" }));
    }
    await Promise.all(txs);

    expect(r.server.sent.length).toBe(6);
    expect(r.server.sent.slice(1)).toEqual([
      '{"type":"jsonapi/sendtx","data":{"id":"0"}}',
      '{"type":"jsonapi/sendtx","data":{"id":"1"}}',
      '{"type":"jsonapi/sendtx","data":{"id":"2"}}',
      '{"type":"jsonapi/sendtx","data":{"id":"3"}}',
      '{"type":"jsonapi/sendtx","data":{"id":"4"}}',
    ]);
    // The clock never moved: no tx frame waited on a token.
    expect(r.server.clockMs).toBe(0);
  });

  test("control frames keep submission order behind a pacing wait", async () => {
    const r = rig(
      { outboundPerMinute: 2, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      sends.push(r.transport.send(`{"type":"subscribe","channel":"order_book/${String(i)}"}`));
    }
    await r.server.advance(120_000);
    await Promise.all(sends);

    expect(sentTypes(r.server)).toEqual(["subscribe", "subscribe", "subscribe", "subscribe", "subscribe"]);
    expect(r.server.sent.map((s: string): string => String(JSON.parse(s).channel))).toEqual([
      "order_book/0",
      "order_book/1",
      "order_book/2",
      "order_book/3",
      "order_book/4",
    ]);
  });

  test("throttleOutbound slows the refill, reduceInflight shrinks the ceiling", async () => {
    const r = rig(
      { outboundPerMinute: 1, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000, maxInflight: 8 },
      { autoRespond: false },
    );
    await r.transport.connect();

    await r.transport.send('{"type":"subscribe","channel":"height"}');
    r.transport.throttleOutbound(0, 120_000); // refill stopped for two minutes

    const pending: Promise<unknown> = r.transport.send('{"type":"subscribe","channel":"rfq"}');
    await r.server.advance(90_000);
    expect(r.server.sent.length).toBe(1);
    await r.server.advance(90_000);
    await pending;
    expect(r.server.sent.length).toBe(2);

    r.transport.reduceInflight(0.25);
    const tickets: InflightTicket[] = [];
    for (let i = 0; i < 6; i += 1) {
      const ticket = await r.transport.send('{"type":"pong"}', { awaitsReply: true, lane: "tx" });
      if (ticket !== null) tickets.push(ticket);
    }
    // 8 → 6 after a 25 % reduction, so the sixth acquisition is the last that can complete.
    expect(r.transport.inflight).toBe(6);
    for (const ticket of tickets) ticket.settle();
    expect(r.transport.inflight).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Inflight                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("inflight tickets", () => {
  test("a ticket is returned, blocks past maxInflight, and frees the slot when settled", async () => {
    const r = rig(
      { maxInflight: 3, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    const tickets: InflightTicket[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ticket = await r.transport.send('{"type":"subscribe","channel":"height"}', {
        awaitsReply: true,
      });
      expect(ticket).not.toBeNull();
      if (ticket !== null) tickets.push(ticket);
    }
    expect(r.transport.inflight).toBe(3);
    expect(r.server.sent.length).toBe(3);

    let fourthSettled = false;
    const fourth: Promise<InflightTicket | null> = r.transport
      .send('{"type":"subscribe","channel":"rfq"}', { awaitsReply: true })
      .then((t: InflightTicket | null): InflightTicket | null => {
        fourthSettled = true;
        return t;
      });

    await r.server.advance(1_000);
    expect(fourthSettled).toBe(false);
    expect(r.server.sent.length).toBe(3);

    (tickets[0] as InflightTicket).settle();
    await r.server.advance(0);
    expect(fourthSettled).toBe(true);
    expect(r.server.sent.length).toBe(4);
    await fourth;

    // Settling twice is a no-op rather than a double release.
    (tickets[0] as InflightTicket).settle();
    expect(r.transport.inflight).toBe(3);
  });

  test("the default ceiling is 40 — headroom under the documented 50", async () => {
    const r = rig({ keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 }, { autoRespond: false });
    await r.transport.connect();

    // The tx lane keeps the outbound bucket out of the picture; only the semaphore gates here.
    for (let i = 0; i < 40; i += 1) {
      await r.transport.send('{"type":"jsonapi/sendtx","data":{}}', { lane: "tx", awaitsReply: true });
    }
    expect(r.transport.inflight).toBe(40);

    let settled = false;
    void r.transport
      .send('{"type":"jsonapi/sendtx","data":{}}', { lane: "tx", awaitsReply: true })
      .then((): void => {
        settled = true;
      })
      .catch((): void => {
        settled = true;
      });
    await r.server.advance(5_000);
    expect(settled).toBe(false);
    expect(r.server.sent.length).toBe(40);

    await r.transport.close();
    await settle(50);
    expect(settled).toBe(true);
    expect(r.transport.inflight).toBe(0);
  });

  test("every outstanding ticket settles on close, and a queued send is not carried over", async () => {
    const r = rig(
      { maxInflight: 2, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    await r.transport.send('{"type":"subscribe","channel":"height"}', { awaitsReply: true });
    await r.transport.send('{"type":"subscribe","channel":"rfq"}', { awaitsReply: true });
    expect(r.transport.inflight).toBe(2);

    const blocked: Promise<InflightTicket | null> = r.transport.send(
      '{"type":"subscribe","channel":"order_book/0"}',
      { awaitsReply: true },
    );
    await r.server.advance(0);

    r.server.closeWith(1006, "");
    await r.server.advance(0);

    await expect(blocked).rejects.toBeInstanceOf(LighterWsClosedError);
    expect(r.transport.inflight).toBe(0);

    // The blocked frame was never written — before the close or after the reconnect.
    await r.server.advance(1_000);
    expect(r.server.sockets.length).toBe(2);
    expect(r.server.sent.length).toBe(2);
  });

  test("a frame waiting on a token is rejected rather than queued across a disconnect", async () => {
    const r = rig(
      { outboundPerMinute: 1, keepAliveMs: 10_000_000, stalenessTimeoutMs: 10_000_000 },
      { autoRespond: false },
    );
    await r.transport.connect();

    await r.transport.send('{"type":"subscribe","channel":"height"}');
    const waiting: Promise<unknown> = r.transport.send('{"type":"subscribe","channel":"rfq"}');
    await r.server.advance(1_000);

    r.server.closeWith(1001, "deploy");
    await r.server.advance(1_000);

    await expect(waiting).rejects.toBeInstanceOf(LighterWsClosedError);
    expect(r.server.sockets.length).toBe(2);
    expect(r.server.sent.length).toBe(1);
    expect(r.transport.state).toBe("open");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Protocol guards                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("protocol guards", () => {
  test("a binary frame closes with 4001 and is never delivered as data", async () => {
    const r = rig();
    await r.transport.connect();
    const first = r.server.socket;

    r.server.emitBinary(new Uint8Array([0x00, 0x01, 0x02]));
    await r.server.advance(0);

    expect(first.closeRequest?.code).toBe(4001);
    const diag = r.diagnostics.find((d: WsDiagnostic): boolean => d.event === "binary-frame");
    expect(diag?.level).toBe("error");

    await r.server.advance(1_000);
    expect(r.server.sockets.length).toBe(2);
    // Delivered frames are the two `connected` greetings and nothing else: the binary payload was
    // never surfaced as data, in any shape.
    expect(r.frames.map((f): string => f.frame.kind)).toEqual(["connected", "connected"]);
    expect(r.frames.every((f): boolean => f.frame.kind !== "malformed")).toBe(true);
  });

  test("an unknown message type and unparseable text are not fatal", async () => {
    const r = rig();
    await r.transport.connect();

    r.server.emit({ type: "some_future_type", data: { x: 1 } });
    r.server.emitRaw("not json at all");
    await r.server.advance(0);

    expect(r.transport.state).toBe("open");
    expect(r.frames.map((f): string => f.frame.kind)).toEqual(["connected", "unknown", "malformed"]);
    expect(r.server.sockets.length).toBe(1);
  });

  test("a throwing frame subscriber does not take down the read loop", async () => {
    const r = rig();
    r.transport.onFrame((): void => {
      throw new Error("subscriber is broken");
    });
    await r.transport.connect();
    r.server.ping();
    await r.server.advance(0);

    expect(r.server.sent).toEqual(['{"type":"pong"}']);
    expect(r.transport.state).toBe("open");
  });

  test("a read-only socket refuses the tx lane before anything reaches the wire", async () => {
    const r = rig({ readOnly: true });
    await r.transport.connect();
    await expect(r.transport.send('{"type":"jsonapi/sendtx"}', { lane: "tx" })).rejects.toThrow();
    expect(r.server.sent.length).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Constructor resolution                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("WebSocket resolution", () => {
  let descriptor: PropertyDescriptor | undefined;

  beforeEach((): void => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  });

  function restore(): void {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, "WebSocket");
    else Object.defineProperty(globalThis, "WebSocket", descriptor);
  }

  test("an injected constructor means globalThis.WebSocket is never read", async () => {
    const server = new MockWsServer();
    let reads = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      get(): unknown {
        reads += 1;
        return undefined;
      },
    });
    try {
      const t = new WsTransport({
        url: BASE_URL,
        WebSocket: server.WebSocket,
        clock: server.now,
        timers: server.timers,
      });
      await t.connect();
      expect(t.state).toBe("open");
      expect(reads).toBe(0);
      await t.close();
    } finally {
      restore();
    }
  });

  test("with neither available, connect() names the undici workaround", () => {
    Reflect.deleteProperty(globalThis, "WebSocket");
    try {
      const t = new WsTransport({ url: BASE_URL });
      let caught: unknown;
      try {
        void t.connect();
      } catch (e: unknown) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LighterWsError);
      expect(String((caught as Error).message)).toContain("undici");
      expect(String((caught as Error).message)).toContain("WebSocket");
    } finally {
      restore();
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Shutdown                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("close() is terminal", () => {
  test("no timer survives, and connect() throws afterwards", async () => {
    const r = rig({ stalenessTimeoutMs: 10_000_000 });
    await r.transport.connect();
    expect(r.live.size).toBeGreaterThan(0);

    await r.transport.close(1000, "bye");

    expect(r.transport.state).toBe("closed");
    expect(r.live.size).toBe(0);
    expect(r.server.socket.closeRequest).toEqual({ code: 1000, reason: "bye" });
    expect(() => r.transport.connect()).toThrow(LighterWsError);

    await r.server.advance(600_000);
    expect(r.server.sockets.length).toBe(1);
    expect(r.server.sent.length).toBe(0);
  });

  test("closing while reconnecting cancels the pending retry", async () => {
    const r = rig({ reconnect: { random: (): number => 1, baseDelayMs: 5_000 } });
    await r.transport.connect();
    r.server.closeWith(1006, "");
    await r.server.advance(0);
    expect(r.transport.state).toBe("reconnecting");
    expect(r.live.size).toBe(1);

    await r.transport.close();
    expect(r.transport.state).toBe("closed");
    expect(r.live.size).toBe(0);
    await r.server.advance(600_000);
    expect(r.server.sockets.length).toBe(1);
  });

  test("close() is idempotent and send() is refused afterwards", async () => {
    const r = rig();
    await r.transport.connect();
    await r.transport.close();
    await r.transport.close();
    await expect(r.transport.send('{"type":"pong"}')).rejects.toBeInstanceOf(LighterWsClosedError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Portability gate                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

describe("portability", () => {
  test("the source uses no banned runtime facility", () => {
    const source: string = readFileSync(
      new URL("../../src/ws/transport.ts", import.meta.url),
      "utf8",
    );
    const banned =
      /node:|require\(|\bBuffer\b|process\.|setInterval|unref|from ['"]ws['"]|WebAssembly/;
    expect(source).not.toMatch(banned);

    // The single lazy global read lives inside `connect()` and nowhere else — reading it at module
    // scope would break runtimes that populate globals late.
    const reads: string[] = source.match(/globalThis as \{ WebSocket/g) ?? [];
    expect(reads).toHaveLength(1);
    const readAt: number = source.indexOf("globalThis as { WebSocket");
    const connectAt: number = source.indexOf("  connect(): Promise<void> {");
    const afterConnectAt: number = source.indexOf("  async close(");
    expect(connectAt).toBeGreaterThan(0);
    expect(readAt).toBeGreaterThan(connectAt);
    expect(readAt).toBeLessThan(afterConnectAt);
  });
});
