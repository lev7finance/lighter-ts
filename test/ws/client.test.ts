/**
 * `src/ws/client.ts` — the desired-subscription table, inbound routing, and resubscribe-on-reconnect.
 *
 * Driven entirely by `test/ws-harness.ts`: no socket, no server, no wall clock. Every timer the
 * client and the transport under it schedule goes through {@link MockWsServer.timers}, so a 15 s ack
 * deadline and a 90 s resubscribe pacing run costs microseconds and is exact instead of flaky.
 *
 * The properties worth the most here are the two whose absence is invisible from outside:
 *
 * 1. **A reconnect that does not resubscribe looks perfectly healthy.** The socket is open, the state
 *    machine says `open`, nothing throws — and not one frame is ever delivered again. Pinned by
 *    `resubscribes every desired channel` across all five close codes.
 * 2. **A resubscribe that replays the token captured at first subscribe also looks healthy**, and
 *    loses only the private channels, twenty minutes later, once the deadline in that token passes.
 *    Pinned by asserting the provider is called *again* and that the *second* token reaches the wire.
 *
 * Ordering is asserted, not just membership: `{kind:'reset'}` must precede every post-reconnect
 * snapshot. Delivered the other way round, a consumer discards the good snapshot and quotes off
 * nothing — which is why the reset assertions are all index comparisons.
 *
 * Evidence status: no WS live capture exists (`docs/protocol-notes.md` §8.3 — the upgrade was refused
 * from a restricted jurisdiction, API code 20558). Every frame shape below is synthesised from
 * `docs/spec/06-websocket.md`, which marks them `[REF]`/`[DOC]`. What is tested is this client's
 * behaviour given those shapes, and the tolerance it must show when a shape turns out to be wrong.
 */

import { describe, expect, test } from "bun:test";

import type {
  LighterWsOptions,
  WsClientDiagnostic,
  WsFrameChannel,
  WsSubscriber,
} from "../../src/ws/client.js";
import { LighterWsClient } from "../../src/ws/client.js";
import { channels } from "../../src/ws/channels.js";
import type { ChannelSpec } from "../../src/ws/channels.js";
import {
  LighterWsAuthError,
  LighterWsError,
  LighterWsRateLimitError,
  LighterWsReadOnlyError,
} from "../../src/ws/errors.js";
import type { ChannelEvent, Subscription } from "../../src/ws/subscription.js";
import type { MockWsOptions } from "../ws-harness.js";
import { MockWsServer } from "../ws-harness.js";

/* ---------------------------------------------------------------------------------------------- */
/* Rig                                                                                              */
/* ---------------------------------------------------------------------------------------------- */

const BASE_URL = "wss://mainnet.zklighter.elliot.ai/stream";

interface Rig {
  readonly server: MockWsServer;
  readonly client: LighterWsClient;
  readonly diagnostics: WsClientDiagnostic[];
  /** Every outbound frame, parsed. The raw text stays in `server.sent` for wire-spelling assertions. */
  outbound(): Record<string, unknown>[];
  /** Outbound frames of one `type`, parsed. */
  outboundOf(type: string): Record<string, unknown>[];
}

function rig(overrides: Partial<LighterWsOptions> = {}, serverOpts: MockWsOptions = {}): Rig {
  const server = new MockWsServer(serverOpts);
  const diagnostics: WsClientDiagnostic[] = [];
  const options: LighterWsOptions = {
    url: BASE_URL,
    WebSocket: server.WebSocket,
    timers: server.timers,
    clock: server.now,
    onDiagnostic: (d: WsClientDiagnostic): void => {
      diagnostics.push(d);
    },
    ...overrides,
  };
  const client = new LighterWsClient(options);
  const parse = (text: string): Record<string, unknown> =>
    JSON.parse(text) as Record<string, unknown>;
  return {
    server,
    client,
    diagnostics,
    outbound: (): Record<string, unknown>[] => server.sent.map(parse),
    outboundOf: (type: string): Record<string, unknown>[] =>
      server.sent.map(parse).filter((f: Record<string, unknown>): boolean => f["type"] === type),
  };
}

/** Record every event a subscription delivers, in order. */
function record<S, U>(sub: Subscription<S, U>): ChannelEvent<S, U>[] {
  const events: ChannelEvent<S, U>[] = [];
  sub.on((e: ChannelEvent<S, U>): void => {
    events.push(e);
  });
  return events;
}

function kinds<S, U>(events: readonly ChannelEvent<S, U>[]): string[] {
  return events.map((e: ChannelEvent<S, U>): string => e.kind);
}

/**
 * Drain microtasks without moving the virtual clock.
 *
 * Repeated, because the resubscribe loop is sequential: each channel awaits its token, then its turn
 * on the transport's control lane, so restoring N channels costs O(N) microtask turns and the
 * harness drains a bounded number per `advance` (`MICROTASK_ROUNDS`). One round is not enough for a
 * handful of channels, which is precisely the sort of thing that makes a test pass at 4 channels and
 * fail at 5.
 */
async function settle(server: MockWsServer, rounds: number = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await server.advance(0);
}

/**
 * The harness's constructor, wrapped so every outbound write is stamped with the virtual clock.
 *
 * `MockWsServer.sent` records the text but not the time, and pacing is a claim about time.
 */
function stampingWebSocket(
  server: MockWsServer,
  stamps: number[],
): NonNullable<LighterWsOptions["WebSocket"]> {
  const Inner: NonNullable<LighterWsOptions["WebSocket"]> = server.WebSocket;
  class Stamping {
    constructor(url: string) {
      const socket = new Inner(url);
      const write: (data: string) => void = socket.send.bind(socket);
      socket.send = (data: string): void => {
        stamps.push(server.clockMs);
        write(data);
      };
      return socket as unknown as Stamping;
    }
  }
  return Stamping as unknown as NonNullable<LighterWsOptions["WebSocket"]>;
}

/** A provider that hands out a distinct token per call and remembers what it was asked. */
function tokenProvider(): {
  calls: { accountIndex?: number; channel: string }[];
  provider: (ctx: { accountIndex?: number; channel: string }) => string;
} {
  const calls: { accountIndex?: number; channel: string }[] = [];
  return {
    calls,
    provider: (ctx: { accountIndex?: number; channel: string }): string => {
      calls.push(ctx);
      return `token-${String(calls.length)}`;
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* URL                                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe("url", () => {
  test("mainnet resolves to the documented stream url", () => {
    const client = new LighterWsClient();
    expect(client.url).toBe("wss://mainnet.zklighter.elliot.ai/stream?encoding=json");
    expect(client.readOnly).toBe(false);
  });

  test("readOnly appends readonly=true", () => {
    const client = new LighterWsClient({ readOnly: true });
    expect(client.url).toBe("wss://mainnet.zklighter.elliot.ai/stream?encoding=json&readonly=true");
    expect(client.readOnly).toBe(true);
  });

  test("every profile resolves from src/config/endpoints.ts, not from a literal here", () => {
    expect(new LighterWsClient({ network: "testnet" }).url).toBe(
      "wss://testnet.zklighter.elliot.ai/stream?encoding=json",
    );
    expect(new LighterWsClient({ network: "robinhood" }).url).toBe(
      "wss://api.rh.lighter.xyz/stream?encoding=json",
    );
    expect(new LighterWsClient({ network: "robinhood_testnet" }).url).toBe(
      "wss://api.rh-testnet.lighter.xyz/stream?encoding=json",
    );
  });

  test("an explicit url overrides the profile, and a trailing slash is stripped", () => {
    expect(new LighterWsClient({ network: "mainnet", url: "wss://example.test/" }).url).toBe(
      "wss://example.test/stream?encoding=json",
    );
    expect(new LighterWsClient({ url: "wss://example.test" }).url).toBe(
      "wss://example.test/stream?encoding=json",
    );
  });

  test("construction opens no socket and schedules no timer", () => {
    const server = new MockWsServer();
    const client = new LighterWsClient({
      url: BASE_URL,
      WebSocket: server.WebSocket,
      timers: server.timers,
      clock: server.now,
    });
    expect(server.sockets.length).toBe(0);
    expect(client.state).toBe("idle");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Handshake and lifecycle                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("handshake", () => {
  test("subscribe frames are withheld until the connected greeting", async () => {
    const { server, client } = rig({}, { autoConnected: false });
    client.subscribe(channels.orderBook(0));
    await settle(server);

    expect(client.state).toBe("handshaking");
    expect(server.sent).toEqual([]);

    server.emit({ type: "connected" });
    await settle(server);

    expect(client.state).toBe("open");
    expect(server.sent).toEqual(['{"type":"subscribe","channel":"order_book/0"}']);
  });

  test("a silent server does not deadlock: subscribes go out after handshakeTimeoutMs, with a warning", async () => {
    const { server, client, diagnostics } = rig({}, { autoConnected: false });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(server.sent).toEqual([]);

    await server.advance(3_000);

    expect(client.state).toBe("open");
    expect(server.sent).toEqual(['{"type":"subscribe","channel":"order_book/0"}']);
    expect(
      diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "handshake-timeout"),
    ).toBe(true);
  });

  test("the handshake budget is configurable", async () => {
    const { server, client } = rig({ handshakeTimeoutMs: 250 }, { autoConnected: false });
    client.subscribe(channels.orderBook(0));
    await server.advance(249);
    expect(server.sent).toEqual([]);
    await server.advance(1);
    expect(server.sent.length).toBe(1);
    expect(client.state).toBe("open");
  });
});

describe("lifecycle", () => {
  test("subscribe() before connect() returns a live subscription and reaches the wire once ready", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    expect(sub.key).toBe("order_book/0");
    expect(sub.state).toBe("pending");
    expect(client.state).toBe("connecting");

    await settle(server);

    expect(server.sent).toEqual(['{"type":"subscribe","channel":"order_book/0"}']);
    expect(sub.state).toBe("active");
  });

  test("autoConnect:false leaves the client idle until connect() is called", async () => {
    const { server, client } = rig({ autoConnect: false });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(client.state).toBe("idle");
    expect(server.sockets.length).toBe(0);

    await client.connect();
    await settle(server);
    expect(server.sent).toEqual(['{"type":"subscribe","channel":"order_book/0"}']);
  });

  test("close() is terminal: connect() throws and subscribe() throws afterwards", async () => {
    const { server, client } = rig();
    client.subscribe(channels.orderBook(0));
    await settle(server);

    await client.close();
    expect(client.state).toBe("closed");

    expect((): unknown => client.connect()).toThrow(LighterWsError);
    expect((): unknown => client.subscribe(channels.trades(0))).toThrow(LighterWsError);
  });

  test("close() finishes every subscription and emits no reset on the way down", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    await client.close();
    await settle(server);

    expect(sub.state).toBe("closed");
    expect(kinds(events)).not.toContain("reset");
  });

  test("close() is idempotent and reports the code it was given", async () => {
    const { server, client } = rig();
    const closes: { code: number; reason: string }[] = [];
    client.on("close", ((e: { code: number; reason: string }): void => {
      closes.push(e);
    }) as (e: never) => void);
    client.subscribe(channels.orderBook(0));
    await settle(server);

    const first: Promise<void> = client.close(4321, "bye");
    expect(client.close()).toBe(first);
    await first;
    await settle(server);

    expect(closes).toEqual([{ code: 4321, reason: "bye" }]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Subscribe frames                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

describe("subscribe frames", () => {
  test("auth is omitted entirely when no provider is configured — never null, never empty", async () => {
    const { server, client } = rig();
    client.subscribe(channels.accountAll(1234));
    await settle(server);

    expect(server.sent).toEqual(['{"type":"subscribe","channel":"account_all/1234"}']);
    expect(server.sent[0]).not.toContain("auth");
  });

  test("a token is attached to every account_*/user_stats/pool_*/notification/rfq channel", async () => {
    const { calls, provider } = tokenProvider();
    const { server, client } = rig({ auth: provider });
    const specs: ChannelSpec<unknown, unknown>[] = [
      channels.accountAll(7) as ChannelSpec<unknown, unknown>,
      channels.accountStats(7) as ChannelSpec<unknown, unknown>,
      channels.poolData(7) as ChannelSpec<unknown, unknown>,
      channels.notifications(7) as ChannelSpec<unknown, unknown>,
      channels.rfq() as ChannelSpec<unknown, unknown>,
    ];
    for (const spec of specs) client.subscribe(spec);
    await settle(server);

    const frames: Record<string, unknown>[] = server.sent.map(
      (t: string): Record<string, unknown> => JSON.parse(t) as Record<string, unknown>,
    );
    expect(frames.length).toBe(specs.length);
    for (const frame of frames) expect(typeof frame["auth"]).toBe("string");
    // `rfq` carries no account index; the rest do, and it must reach the provider.
    expect(calls.map((c): number | undefined => c.accountIndex)).toEqual([7, 7, 7, 7, undefined]);
  });

  test("public channels never draw a token, even with a provider configured", async () => {
    const { calls, provider } = tokenProvider();
    const { server, client } = rig({ auth: provider });
    client.subscribe(channels.orderBook(0));
    client.subscribe(channels.trades(0));
    await settle(server);

    expect(calls).toEqual([]);
    expect(server.sent).toEqual([
      '{"type":"subscribe","channel":"order_book/0"}',
      '{"type":"subscribe","channel":"trade/0"}',
    ]);
  });

  test("an empty-string token is treated as absent rather than sent as an empty credential", async () => {
    const { server, client } = rig({ auth: (): string => "" });
    client.subscribe(channels.accountAll(1));
    await settle(server);
    expect(server.sent).toEqual(['{"type":"subscribe","channel":"account_all/1"}']);
  });

  test("a provider that throws fails only its own subscription", async () => {
    const { server, client } = rig({
      auth: (ctx: { channel: string }): string => {
        if (ctx.channel.startsWith("account_all/")) throw new Error("no token today");
        return "ok";
      },
    });
    const bad = client.subscribe(channels.accountAll(1));
    const badEvents = record(bad);
    const good = client.subscribe(channels.accountStats(1));
    await settle(server);

    expect(kinds(badEvents)).toEqual(["error"]);
    expect(good.state).toBe("active");
    expect(client.state).toBe("open");
  });

  test("one channel key has one subscription", async () => {
    const { server, client } = rig();
    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect((): unknown => client.subscribe(channels.orderBook(0))).toThrow(LighterWsError);
  });

  test("subscription.close() unsubscribes on the wire and drops the desired entry", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    await settle(server);

    await sub.close();
    await settle(server);

    expect(server.sent).toEqual([
      '{"type":"subscribe","channel":"order_book/0"}',
      '{"type":"unsubscribe","channel":"order_book/0"}',
    ]);

    // Gone from the desired table: a reconnect must not bring it back.
    server.closeWith(1006);
    await server.advance(60_000);
    expect(
      server.sent.filter((t: string): boolean => t.includes('"subscribe"')).length,
    ).toBe(1);
  });

  test("an unsubscribe issued while disconnected removes the entry and sends no frame", async () => {
    const { server, client } = rig({ reconnect: false });
    const sub = client.subscribe(channels.orderBook(0));
    await settle(server);
    const before: number = server.sent.length;

    server.closeWith(1000);
    await settle(server);
    expect(client.state).not.toBe("open");

    await sub.close();
    await settle(server);
    expect(server.sent.length).toBe(before);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Overflow policy defaults                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("per-family overflow defaults", () => {
  /**
   * The policy is not exposed on `Subscription` — deliberately, it is the client's decision — so it
   * is read back from the `overflow` diagnostic the subscription raises the first time its queue
   * fills. That also proves the policy actually reached the subscription rather than being computed
   * and dropped.
   */
  async function policyFor<S, U>(
    spec: ChannelSpec<S, U>,
    frames: readonly Record<string, unknown>[],
  ): Promise<string | undefined> {
    const { server, client, diagnostics } = rig({ queueLimit: 1 });
    client.subscribe(spec);
    await settle(server);
    for (const frame of frames) server.emit(frame);
    await settle(server);

    for (const d of diagnostics) {
      if (d.event !== "subscription") continue;
      const detail: Record<string, unknown> = d.detail ?? {};
      if (detail["kind"] !== "overflow") continue;
      return detail["policy"] as string;
    }
    return undefined;
  }

  test("order_book defaults to resubscribe — a dropped delta breaks the nonce chain", async () => {
    const policy: string | undefined = await policyFor(channels.orderBook(0), [
      { type: "update/order_book", channel: "order_book:0", order_book: { begin_nonce: 1, nonce: 2 } },
      { type: "update/order_book", channel: "order_book:0", order_book: { begin_nonce: 2, nonce: 3 } },
      { type: "update/order_book", channel: "order_book:0", order_book: { begin_nonce: 3, nonce: 4 } },
    ]);
    expect(policy).toBe("resubscribe");
  });

  test("candles default to coalesce — each message is a complete state", async () => {
    const policy: string | undefined = await policyFor(channels.candles(0, "1m"), [
      { type: "update/candle", channel: "candle:0:1m", candles: [] },
      { type: "update/candle", channel: "candle:0:1m", candles: [] },
      { type: "update/candle", channel: "candle:0:1m", candles: [] },
    ]);
    expect(policy).toBe("coalesce");
  });

  test("trades default to drop-oldest — an append-only history recoverable over REST", async () => {
    const policy: string | undefined = await policyFor(channels.trades(0), [
      { type: "update/trade", channel: "trade:0", trades: [] },
      { type: "update/trade", channel: "trade:0", trades: [] },
      { type: "update/trade", channel: "trade:0", trades: [] },
    ]);
    expect(policy).toBe("drop-oldest");
  });

  test("an unlisted family falls back to defaultOverflow", async () => {
    const { server, client, diagnostics } = rig({ queueLimit: 1, defaultOverflow: "drop-newest" });
    client.subscribe(channels.height());
    await settle(server);
    for (let i = 0; i < 3; i += 1) server.emit({ type: "update/height", channel: "height", height: i });
    await settle(server);

    const policies: unknown[] = diagnostics
      .filter((d: WsClientDiagnostic): boolean => (d.detail ?? {})["kind"] === "overflow")
      .map((d: WsClientDiagnostic): unknown => (d.detail ?? {})["policy"]);
    expect(policies).toContain("drop-newest");
  });

  test("an explicit per-subscription policy overrides the family default", async () => {
    const { server, client, diagnostics } = rig({ queueLimit: 1 });
    client.subscribe(channels.orderBook(0), { overflow: "drop-newest" });
    await settle(server);
    for (let i = 0; i < 3; i += 1) {
      server.emit({
        type: "update/order_book",
        channel: "order_book:0",
        order_book: { begin_nonce: i + 1, nonce: i + 2 },
      });
    }
    await settle(server);

    const policies: unknown[] = diagnostics
      .filter((d: WsClientDiagnostic): boolean => (d.detail ?? {})["kind"] === "overflow")
      .map((d: WsClientDiagnostic): unknown => (d.detail ?? {})["policy"]);
    expect(policies).toContain("drop-newest");
    expect(policies).not.toContain("resubscribe");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Inbound routing                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("routing", () => {
  test("the colon echo routes: order_book:0 reaches order_book/0", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    server.emit({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 1, nonce: 2, asks: [], bids: [] },
    });
    await settle(server);

    expect(kinds(events)).toEqual(["update"]);
  });

  test("account_market echoes slashes, not colons, and still routes", async () => {
    const { server, client } = rig({ auth: (): string => "t" });
    const sub = client.subscribe(channels.accountMarket(3, 1234));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    server.emit({
      type: "update/account_market",
      channel: "account_market/3/1234",
      market_id: 3,
      account: 1234,
    });
    await settle(server);

    expect(kinds(events)).toEqual(["update"]);
  });

  test("account_orders omits the account index entirely; it is rebuilt from the sibling field", async () => {
    const { server, client } = rig({ auth: (): string => "t" });
    const sub = client.subscribe(channels.accountMarketOrders(0, 1234));
    expect(sub.key).toBe("account_orders/0/1234");
    const events = record(sub);
    await settle(server);
    events.length = 0;

    // The inbound channel is `account_orders:0` — the market only. Exact string equality drops this.
    server.emit({
      type: "update/account_orders",
      channel: "account_orders:0",
      account: 1234,
      orders: [],
    });
    await settle(server);

    expect(kinds(events)).toEqual(["update"]);
  });

  test("a lone subscription of a family catches a frame naming a channel it never subscribed under", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.marketStats("all"));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    server.emit({ type: "update/market_stats", channel: "market_stats:7", market_stats: {} });
    await settle(server);

    expect(kinds(events)).toEqual(["update"]);
  });

  test("an unroutable frame is a diagnostic and a drop, never a throw", async () => {
    const { server, client, diagnostics } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    server.emit({ type: "update/trade", channel: "trade:9", trades: [] });
    await settle(server);

    expect(events).toEqual([]);
    expect(diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "unroutable")).toBe(true);
    expect(client.state).toBe("open");
  });

  test("two subscriptions of one family are never guessed between", async () => {
    const { server, client, diagnostics } = rig();
    const a = client.subscribe(channels.trades(0));
    const b = client.subscribe(channels.trades(1));
    const ea = record(a);
    const eb = record(b);
    await settle(server);
    ea.length = 0;
    eb.length = 0;

    // No channel, no market field: nothing distinguishes them.
    server.emit({ type: "update/trade", trades: [] });
    await settle(server);

    expect(ea).toEqual([]);
    expect(eb).toEqual([]);
    expect(diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "unroutable")).toBe(true);
  });

  test("subscribed/* marks the subscription active and arrives as a snapshot", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.trades(1));
    const events = record(sub);
    await settle(server);

    expect(sub.state).toBe("active");
    expect(kinds(events)).toEqual(["snapshot"]);
    server.emit({ type: "update/trade", channel: "trade:1", trades: [] });
    await settle(server);
    expect(kinds(events)).toEqual(["snapshot", "update"]);
  });

  test("the first order_book frame is a snapshot however the server labels it", async () => {
    const { server, client } = rig({}, { autoRespond: false });
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    // Labelled `update`, carries a `begin_nonce` so the stateless half of the rule cannot fire, and
    // is the first frame on a fresh subscription (`docs/spec/06-websocket.md` §5.3).
    server.emit({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 10, nonce: 11, asks: [], bids: [] },
    });
    server.emit({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 11, nonce: 12, asks: [], bids: [] },
    });
    await settle(server);

    expect(kinds(events)).toEqual(["snapshot", "update"]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Nothing inbound is fatal                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("tolerance", () => {
  test("an unknown message type, an unsubscribed ack and a malformed frame all leave the client running", async () => {
    const { server, client, diagnostics } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    server.emit({ type: "quantum_flux", payload: { anything: true } });
    server.emit({ type: "unsubscribed/order_book", channel: "order_book:0" });
    server.emitRaw("{not json at all");
    server.emitRaw("[1,2,3]");
    server.emitRaw("");
    await settle(server);

    expect(client.state).toBe("open");
    expect(sub.state).toBe("active");
    expect(events).toEqual([]);

    const slugs: string[] = diagnostics.map((d: WsClientDiagnostic): string => d.event);
    expect(slugs).toContain("unknown-type");
    expect(slugs).toContain("unsubscribed");
    expect(slugs).toContain("malformed-frame");

    // And the subscription is still live afterwards.
    server.emit({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 1, nonce: 2 },
    });
    await settle(server);
    expect(kinds(events)).toEqual(["update"]);
  });

  test("a new server-side message type cannot take the client down", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.trades(0));
    await settle(server);
    for (let i = 0; i < 50; i += 1) server.emit({ type: `future/type_${String(i)}`, i });
    await settle(server);
    expect(client.state).toBe("open");
    expect(sub.state).toBe("active");
  });

  test("a throwing consumer never reaches the read loop", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.trades(0));
    sub.on((): void => {
      throw new Error("consumer exploded");
    });
    await settle(server);
    server.emit({ type: "update/trade", channel: "trade:0", trades: [] });
    await settle(server);
    expect(client.state).toBe("open");
  });

  test("a throwing diagnostic sink is the sink's problem, never the socket's", async () => {
    const { server, client } = rig({
      onDiagnostic: (): void => {
        throw new Error("sink exploded");
      },
    });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    server.emit({ type: "nonsense" });
    await settle(server);
    expect(client.state).toBe("open");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Reconnect and resubscribe — the core of this unit                                                */
/* ---------------------------------------------------------------------------------------------- */

describe("resubscribe on reconnect", () => {
  const CLOSE_CODES: readonly number[] = [1000, 1001, 1006, 1008, 1011];

  for (const code of CLOSE_CODES) {
    test(`close ${String(code)}: reset precedes every post-reconnect frame, and every channel comes back`, async () => {
      const { calls, provider } = tokenProvider();
      const { server, client } = rig({ auth: provider });

      const book = client.subscribe(channels.orderBook(0));
      const account = client.subscribe(channels.accountAll(1234));
      const bookEvents = record(book);
      const accountEvents = record(account);
      await settle(server);

      expect(kinds(bookEvents)).toEqual(["snapshot"]);
      expect(kinds(accountEvents)).toEqual(["snapshot"]);
      expect(calls.length).toBe(1);
      const firstSubscribes: string[] = [...server.sent];

      server.closeWith(code, "bye");
      await settle(server);

      // (1) `reset` is delivered on the way *down*, before anything can arrive to replace it.
      expect(kinds(bookEvents)).toEqual(["snapshot", "reset"]);
      expect(kinds(accountEvents)).toEqual(["snapshot", "reset"]);
      expect(book.state).toBe("pending");
      expect(account.state).toBe("pending");

      // (2) The socket comes back and every desired channel is re-subscribed.
      await server.advance(60_000);

      expect(server.sockets.length).toBe(2);
      expect(client.state).toBe("open");
      const resubscribes: string[] = server.sent.slice(firstSubscribes.length);
      expect(resubscribes).toContain('{"type":"subscribe","channel":"order_book/0"}');

      // (3) A *fresh* token: the provider was called again, and the new token is on the wire.
      expect(calls.length).toBe(2);
      expect(resubscribes).toContain(
        '{"type":"subscribe","channel":"account_all/1234","auth":"token-2"}',
      );
      expect(resubscribes.join("|")).not.toContain("token-1");

      // (4) And the reset is strictly before the replacement snapshot.
      expect(kinds(bookEvents)).toEqual(["snapshot", "reset", "snapshot"]);
      expect(kinds(accountEvents)).toEqual(["snapshot", "reset", "snapshot"]);
      expect(book.state).toBe("active");
      expect(account.state).toBe("active");
    });
  }

  test("reset is emitted once per loss, not once per socket state change", async () => {
    const { server, client } = rig({ reconnect: { random: (): number => 0.5 } });
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    // A first connect loses nothing, so it must produce no reset at all.
    expect(kinds(events)).toEqual(["snapshot"]);

    server.closeWith(1006);
    await settle(server);
    expect(kinds(events)).toEqual(["snapshot", "reset"]);
    await server.advance(1_000);
    expect(kinds(events)).toEqual(["snapshot", "reset", "snapshot"]);

    server.closeWith(1006);
    await settle(server);
    expect(kinds(events)).toEqual(["snapshot", "reset", "snapshot", "reset"]);
    await server.advance(1_000);
    expect(kinds(events)).toEqual(["snapshot", "reset", "snapshot", "reset", "snapshot"]);
  });

  test("onReconnect fires on every close with the observed code, and before resubscription", async () => {
    const { server, client } = rig();
    const seen: { code: number; reason: string }[] = [];
    const sentAtTap: number[] = [];
    client.onReconnect((info: { code: number; reason: string }): void => {
      seen.push(info);
      sentAtTap.push(server.sent.length);
    });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    const before: number = server.sent.length;

    server.closeWith(1011, "internal");
    await server.advance(60_000);

    expect(seen).toEqual([{ code: 1011, reason: "internal" }]);
    // No resubscribe frame had been written when the tap ran.
    expect(sentAtTap).toEqual([before]);
    expect(server.sent.length).toBeGreaterThan(before);
  });

  test("onReconnect does not fire on the first successful connect", async () => {
    const { server, client } = rig();
    const seen: unknown[] = [];
    client.onReconnect((info: unknown): void => {
      seen.push(info);
    });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(seen).toEqual([]);
  });

  test("reconnect(reason) forces a socket cycle and every channel comes back", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    client.reconnect("test");
    await server.advance(60_000);

    expect(server.sockets.length).toBe(2);
    expect(kinds(events)).toEqual(["snapshot", "reset", "snapshot"]);
    expect(sub.state).toBe("active");
  });

  test("a channel closed while disconnected is not resubscribed when the socket returns", async () => {
    const { server, client } = rig();
    const keep = client.subscribe(channels.orderBook(0));
    const drop = client.subscribe(channels.trades(1));
    await settle(server);
    const before: number = server.sent.length;

    server.closeWith(1006);
    await settle(server);
    await drop.close();

    await server.advance(60_000);

    const after: string[] = server.sent.slice(before);
    expect(after).toContain('{"type":"subscribe","channel":"order_book/0"}');
    expect(after).not.toContain('{"type":"subscribe","channel":"trade/1"}');
    expect(keep.state).toBe("active");
  });

  test("a subscribe registered while disconnected goes out on the next ready", async () => {
    const { server, client } = rig();
    client.subscribe(channels.orderBook(0));
    await settle(server);

    server.closeWith(1006);
    await settle(server);
    expect(client.state).toBe("reconnecting");

    const late = client.subscribe(channels.trades(1));
    await server.advance(60_000);

    expect(server.sent).toContain('{"type":"subscribe","channel":"trade/1"}');
    expect(late.state).toBe("active");
  });

  test("reconnect: false surfaces the close and stops", async () => {
    const { server, client } = rig({ reconnect: false });
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    server.closeWith(1011);
    await server.advance(60_000);

    expect(client.state).toBe("closed");
    expect(server.sockets.length).toBe(1);
    expect(kinds(events)).toEqual(["snapshot", "reset"]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Subscribe acknowledgement deadline                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("subscribe timeout", () => {
  test("a channel that never acknowledges is retried once, then errors and stays pending", async () => {
    const { server, client, diagnostics } = rig({}, { autoRespond: false });
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    expect(server.sent.length).toBe(1);

    await server.advance(15_000);
    expect(server.sent.length).toBe(2);
    expect(kinds(events)).toEqual([]);
    expect(diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "subscribe-retry")).toBe(
      true,
    );

    await server.advance(15_000);
    expect(server.sent.length).toBe(2);
    expect(kinds(events)).toEqual(["error"]);
    expect(sub.state).toBe("pending");
    expect(
      diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "subscribe-timeout"),
    ).toBe(true);
  });

  test("an acknowledgement inside the budget disarms the deadline", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);
    expect(sub.state).toBe("active");

    // Well past four ack budgets, and short of the 90 s inbound staleness watchdog — which would
    // legitimately cycle the socket and resubscribe.
    await server.advance(80_000);
    expect(kinds(events)).not.toContain("error");
    expect(server.sent.filter((t: string): boolean => t.includes('"subscribe"')).length).toBe(1);
  });

  test("the budget is configurable", async () => {
    const { server, client } = rig({ subscribeTimeoutMs: 500 }, { autoRespond: false });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    await server.advance(499);
    expect(server.sent.length).toBe(1);
    await server.advance(1);
    expect(server.sent.length).toBe(2);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The §11 error action table                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("server error codes", () => {
  test("30003 Already Subscribed resolves the pending subscribe as a success", async () => {
    const { server, client } = rig({}, { autoRespond: false });
    const sub = client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(sub.state).toBe("pending");

    server.emit({ type: "error", code: 30003, message: "Already Subscribed", channel: "order_book:0" });
    await settle(server);

    expect(sub.state).toBe("active");
    // And the ack deadline is disarmed: no retry. (The keepalive pong is not a subscribe.)
    await server.advance(60_000);
    expect(server.sent.filter((t: string): boolean => t.includes('"subscribe"')).length).toBe(1);
  });

  test("30003 arrives naturally from the harness on a duplicate resubscribe and is not an error", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    // Same connection, resubscribed by hand: the harness answers 30003 exactly as the server does.
    client.sendFrame({ type: "subscribe", channel: "order_book/0" });
    await settle(server);

    expect(kinds(events)).not.toContain("error");
    expect(sub.state).toBe("active");
  });

  test("30009 halves the outbound refill without disconnecting", async () => {
    const { server, client, diagnostics } = rig();
    client.subscribe(channels.orderBook(0));
    await settle(server);

    server.emit({ type: "error", code: 30009, message: "Too Many Websocket Messages!" });
    await settle(server);

    expect(client.state).toBe("open");
    expect(server.sockets.length).toBe(1);
    const throttled: WsClientDiagnostic | undefined = diagnostics.find(
      (d: WsClientDiagnostic): boolean => d.event === "throttled",
    );
    expect(throttled).toBeDefined();
    expect((throttled?.detail ?? {})["forMs"]).toBe(60_000);
  });

  test("23000 is throttled the same way", async () => {
    const { server, client, diagnostics } = rig();
    client.subscribe(channels.orderBook(0));
    await settle(server);
    server.emit({ type: "error", code: 23000, message: "Too Many Requests" });
    await settle(server);
    expect(client.state).toBe("open");
    expect(diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "throttled")).toBe(true);
  });

  test("30010 reduces the inflight ceiling and retries the subscribe after 1 s", async () => {
    const { server, client, diagnostics } = rig({}, { autoRespond: false });
    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(server.sent.length).toBe(1);

    server.emit({ type: "error", code: 30010, message: "Too Many Inflight", channel: "order_book:0" });
    await settle(server);
    expect(server.sent.length).toBe(1);

    await server.advance(1_000);
    expect(server.sent.length).toBe(2);
    expect(
      diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "inflight-reduced"),
    ).toBe(true);
  });

  for (const [code, limit] of [
    [23001, "subscriptions"],
    [23002, "accounts"],
    [23003, "connections"],
  ] as const) {
    test(`${String(code)} latches the socket: further subscribes throw a typed error naming the limit`, async () => {
      const { server, client } = rig();
      client.subscribe(channels.orderBook(0));
      await settle(server);

      server.emit({ type: "error", code, message: "limit reached" });
      await settle(server);

      let thrown: unknown;
      try {
        client.subscribe(channels.trades(3));
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(LighterWsRateLimitError);
      expect(String((thrown as Error).message)).toContain(limit);
      expect(String((thrown as Error).message)).toContain("LighterWsClient");
      expect(String((thrown as Error).message)).not.toContain("LighterWsPool");
    });
  }

  test("21120 on an authed channel refreshes the token exactly once, then surfaces LighterWsAuthError", async () => {
    const { calls, provider } = tokenProvider();
    const { server, client } = rig({ auth: provider }, { autoRespond: false });
    const errors: unknown[] = [];
    client.on("error", ((e: unknown): void => {
      errors.push(e);
    }) as (e: never) => void);

    const sub = client.subscribe(channels.accountAll(1234));
    const events = record(sub);
    await settle(server);
    expect(calls.length).toBe(1);
    expect(server.sent).toEqual([
      '{"type":"subscribe","channel":"account_all/1234","auth":"token-1"}',
    ]);

    const reject = (): void => {
      server.emit({
        type: "error",
        code: 21120,
        message: "invalid signature",
        channel: "account_all:1234",
      });
    };

    reject();
    await settle(server);

    // One refresh: the provider was asked again and the new token is on the wire.
    expect(calls.length).toBe(2);
    expect(server.sent[1]).toBe(
      '{"type":"subscribe","channel":"account_all/1234","auth":"token-2"}',
    );
    expect(kinds(events)).toEqual([]);

    reject();
    await settle(server);

    // And no second refresh: two attempts is the whole budget.
    expect(calls.length).toBe(2);
    expect(server.sent.length).toBe(2);
    expect(kinds(events)).toEqual(["error"]);
    expect(errors.some((e: unknown): boolean => e instanceof LighterWsAuthError)).toBe(true);
  });

  test("the auth budget is per connection: a reconnect gets its refresh back", async () => {
    const { calls, provider } = tokenProvider();
    // The ack deadline is parked out of the way: its own retry would also call the provider, and
    // this test is about the auth-refresh budget alone.
    const { server, client } = rig(
      { auth: provider, subscribeTimeoutMs: 3_600_000 },
      { autoRespond: false },
    );
    client.subscribe(channels.accountAll(1234));
    await settle(server);

    server.emit({ type: "error", code: 21120, message: "nope", channel: "account_all:1234" });
    await settle(server);
    server.emit({ type: "error", code: 21120, message: "nope", channel: "account_all:1234" });
    await settle(server);
    expect(calls.length).toBe(2);

    server.closeWith(1006);
    await server.advance(10_000);
    await settle(server);

    // Fresh connection, fresh token, and the refresh budget is available again.
    expect(calls.length).toBe(3);
    server.emit({ type: "error", code: 21120, message: "nope", channel: "account_all:1234" });
    await settle(server);
    expect(calls.length).toBe(4);
  });

  test("30012 is only an auth signal on a channel that carried a token", async () => {
    const { calls, provider } = tokenProvider();
    const { server, client } = rig({ auth: provider }, { autoRespond: false });
    const pub = client.subscribe(channels.orderBook(0));
    const pubEvents = record(pub);
    await settle(server);
    expect(calls.length).toBe(0);

    server.emit({ type: "error", code: 30012, message: "failed to subscribe", channel: "order_book:0" });
    await settle(server);

    // No token was attached, so there is nothing to refresh: the failure reaches the caller.
    expect(calls.length).toBe(0);
    expect(kinds(pubEvents)).toEqual(["error"]);
  });

  test("a codec-level rejection is loud, carries the offending frame, and is never retried", async () => {
    const { server, client, diagnostics } = rig({}, { autoRespond: false });
    const errors: unknown[] = [];
    client.on("error", ((e: unknown): void => {
      errors.push(e);
    }) as (e: never) => void);
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    server.emit({ type: "error", code: 30005, message: "Invalid Channel", channel: "order_book:0" });
    await settle(server);

    expect(server.sent.length).toBe(1);
    expect(kinds(events)).toEqual(["error"]);
    const bug: WsClientDiagnostic | undefined = diagnostics.find(
      (d: WsClientDiagnostic): boolean => d.event === "codec-bug",
    );
    expect(bug).toBeDefined();
    expect((bug?.detail ?? {})["frame"]).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("an unrecognised code is surfaced with its number intact and nothing is reinterpreted", async () => {
    const { server, client } = rig({}, { autoRespond: false });
    const sub = client.subscribe(channels.orderBook(0));
    const events = record(sub);
    await settle(server);

    server.emit({ type: "error", code: 61006, message: "api token revoked", channel: "order_book:0" });
    await settle(server);

    const first: ChannelEvent<unknown, unknown> | undefined = events[0];
    expect(first?.kind).toBe("error");
    expect(first?.kind === "error" ? first.code : 0).toBe(61006);
    expect(client.state).toBe("open");
  });

  test("an error naming no channel reaches the client-level error listener", async () => {
    const { server, client } = rig();
    const errors: unknown[] = [];
    client.on("error", ((e: unknown): void => {
      errors.push(e);
    }) as (e: never) => void);
    client.subscribe(channels.orderBook(0));
    await settle(server);

    server.emit({ type: "error", code: 40404, message: "who knows" });
    await settle(server);

    expect(errors.some((e: unknown): boolean => e instanceof LighterWsError)).toBe(true);
    expect(client.state).toBe("open");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Limits                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("limits", () => {
  test("beyond maxSubscriptions the error names a second client, never a pool", async () => {
    const { server, client } = rig({ maxSubscriptions: 3 }, { autoRespond: false });
    for (let i = 0; i < 3; i += 1) client.subscribe(channels.orderBook(i));
    await settle(server);

    let thrown: unknown;
    try {
      client.subscribe(channels.orderBook(3));
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LighterWsRateLimitError);
    const message: string = String((thrown as Error).message);
    expect(message).toContain("LighterWsClient");
    // `docs/spec/06-websocket.md` §10.3 says to point at `LighterWsPool`; D10 cut it from v1.
    expect(message).not.toContain("LighterWsPool");
  });

  /**
   * Restoring 500 channels must not trip 30009, so the resubscribe burst is paced by the transport's
   * 200-per-60 s outbound bucket.
   *
   * Measured from the virtual timestamp of each write rather than by sampling a counter: a sampled
   * count lags the bucket by however many microtask turns the harness happened to drain, and
   * differencing a lagging counter manufactures windows that never occurred.
   *
   * **The bucket starts full**, by design — a fresh connection is allowed its documented burst
   * (`src/ws/ratelimit.ts`). So the literal reading of "at most 200 frames in any rolling 60 s
   * window" is not what the transport implements and is not what is asserted here. What is asserted
   * is the exact guarantee a token bucket gives, which is the one that keeps the server happy: the
   * k-th frame cannot leave before the bucket could have held a token for it, and once the opening
   * burst is spent no 60 s window exceeds the 200-frame budget.
   */
  test("resubscribing 500 channels is paced by the 200/60 s budget", async () => {
    const server = new MockWsServer({ autoRespond: false });
    const stamps: number[] = [];
    const client = new LighterWsClient({
      url: BASE_URL,
      WebSocket: stampingWebSocket(server, stamps),
      timers: server.timers,
      clock: server.now,
      maxSubscriptions: 500,
      // Keepalive, staleness and the ack deadline would each inject frames of their own.
      keepAliveMs: 3_600_000,
      stalenessTimeoutMs: 3_600_000,
      subscribeTimeoutMs: 3_600_000,
    });
    for (let i = 0; i < 500; i += 1) client.subscribe(channels.orderBook(i));

    // Advanced in 1 s steps: the resubscribe loop is sequential, so each frame costs a few microtask
    // turns and the harness drains a bounded number per `advance`.
    for (let step = 0; step < 240; step += 1) {
      await server.advance(1_000);
      await settle(server, 4);
    }

    expect(stamps.length).toBe(500);
    expect(server.sent.length).toBe(500);

    const CAPACITY = 200;
    const MS_PER_TOKEN = 60_000 / 200;

    // (1) The token-bucket guarantee, exactly: frame k (0-based) beyond the initial burst cannot
    //     have been written before its token had accrued.
    for (let k = CAPACITY; k < stamps.length; k += 1) {
      const earliest: number = (k - CAPACITY + 1) * MS_PER_TOKEN;
      expect(stamps[k] as number).toBeGreaterThanOrEqual(earliest);
    }

    // (2) And therefore no rolling 60 s window can carry more than one burst plus one budget. It is
    //     `capacity + budget` rather than `budget`: a producer that stalls lets the bucket refill to
    //     capacity, and the catch-up burst that follows is exactly what the capacity is for. A tighter
    //     bound would be asserting something the transport does not implement.
    for (let i = 0; i < stamps.length; i += 1) {
      let j: number = i;
      while (j < stamps.length && (stamps[j] as number) - (stamps[i] as number) < 60_000) j += 1;
      expect(j - i).toBeLessThanOrEqual(CAPACITY + 200);
    }

    // (3) And the pacing is real rather than an artefact of the loop: 500 frames took over a minute.
    expect(stamps[stamps.length - 1] as number).toBeGreaterThan(60_000);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Raw frame seam                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("frame channel seam", () => {
  test("sendFrame writes the frame verbatim, with bigint as a bare integer", async () => {
    const { server, client } = rig();
    await client.connect();
    client.sendFrame({ type: "jsonapi/sendtx", nonce: 9007199254740993n }, { lane: "tx" });
    await settle(server);
    expect(server.sent).toContain('{"type":"jsonapi/sendtx","nonce":9007199254740993}');
  });

  test("the tx lane is refused on a read-only socket, before anything reaches the wire", async () => {
    const { server, client } = rig({ readOnly: true });
    await client.connect();
    expect((): void => {
      client.sendFrame({ type: "jsonapi/sendtx" }, { lane: "tx" });
    }).toThrow(LighterWsReadOnlyError);
    await settle(server);
    expect(server.sent).toEqual([]);
  });

  test("sendFrame on a socket that is not open throws rather than queueing", () => {
    const { client } = rig({ autoConnect: false });
    expect((): void => {
      client.sendFrame({ type: "ping" });
    }).toThrow(LighterWsError);
  });

  test("onFrame taps run before routing and can consume a frame", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.trades(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    const seen: Record<string, unknown>[] = [];
    const off = client.onFrame((frame: Record<string, unknown>): boolean => {
      seen.push(frame);
      return frame["type"] === "update/trade";
    });

    server.emit({ type: "update/trade", channel: "trade:0", trades: [] });
    await settle(server);

    expect(seen.length).toBe(1);
    expect(events).toEqual([]); // consumed by the tap, never routed

    off();
    server.emit({ type: "update/trade", channel: "trade:0", trades: [] });
    await settle(server);
    expect(seen.length).toBe(1);
    expect(kinds(events)).toEqual(["update"]);
  });

  test("a throwing frame tap cannot take the read loop down", async () => {
    const { server, client } = rig();
    const sub = client.subscribe(channels.trades(0));
    const events = record(sub);
    await settle(server);
    events.length = 0;

    client.onFrame((): boolean => {
      throw new Error("tap exploded");
    });
    server.emit({ type: "update/trade", channel: "trade:0", trades: [] });
    await settle(server);

    expect(client.state).toBe("open");
    expect(kinds(events)).toEqual(["update"]);
  });

  test("the client satisfies both downstream seams structurally", async () => {
    const { server, client } = rig();
    const subscriber: WsSubscriber = client;
    const frames: WsFrameChannel = client;
    expect(typeof subscriber.subscribe).toBe("function");
    expect(typeof subscriber.reconnect).toBe("function");
    expect(subscriber.state).toBe("idle");
    expect(frames.readOnly).toBe(false);
    expect(typeof frames.sendFrame).toBe("function");
    expect(typeof frames.onFrame).toBe("function");
    expect(typeof frames.onReconnect).toBe("function");
    await settle(server);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Events                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("events", () => {
  test("open, reconnect and close fire in order, and unsubscribing stops delivery", async () => {
    const { server, client } = rig();
    const log: string[] = [];
    const offOpen = client.on("open", ((): void => {
      log.push("open");
    }) as (e: never) => void);
    client.on("reconnect", ((): void => {
      log.push("reconnect");
    }) as (e: never) => void);
    client.on("close", ((): void => {
      log.push("close");
    }) as (e: never) => void);

    client.subscribe(channels.orderBook(0));
    await settle(server);
    expect(log).toEqual(["open"]);

    offOpen();
    server.closeWith(1006);
    await server.advance(60_000);
    expect(log).toEqual(["open", "reconnect"]);

    await client.close();
    await settle(server);
    expect(log).toEqual(["open", "reconnect", "close"]);
  });

  test("on() rejects a non-function listener", () => {
    const { client } = rig();
    expect((): unknown => client.on("open", undefined as unknown as (e: never) => void)).toThrow(
      LighterWsError,
    );
  });

  test("transport diagnostics are forwarded verbatim", async () => {
    const { server, client, diagnostics } = rig({}, { autoConnected: false });
    client.subscribe(channels.orderBook(0));
    await server.advance(3_000);
    // `handshake-timeout` is raised by the transport, not by the client.
    expect(diagnostics.some((d: WsClientDiagnostic): boolean => d.event === "handshake-timeout")).toBe(
      true,
    );
  });
});
