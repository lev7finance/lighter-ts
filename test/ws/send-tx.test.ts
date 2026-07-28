/**
 * `src/ws/send-tx.ts` — correlated transaction submission over the WebSocket.
 *
 * Two rigs, because two different things need proving and neither rig proves both.
 *
 * 1. **{@link rig} — the real {@link LighterWsClient} over `test/ws-harness.ts`.** This is where the
 *    wire spelling, the correlation, the timeout and the reconnect sweep are asserted, because those
 *    only mean anything end to end: the frame has to survive the client's own encoder, the ack has to
 *    survive `decodeFrame`, and the reconnect has to be a real socket close.
 * 2. **{@link fakeChannel} — a recording {@link WsFrameChannel}.** Two acceptance criteria are not
 *    observable through a socket at all: the `lane` passed to `sendFrame` (the harness records text,
 *    not lanes) and the tap's **return value** for a frame it must not consume. A `ping` frame never
 *    even reaches a tap through the client — `decodeFrame` turns it into `{kind:'ping'}`, which
 *    carries no body — so the only way to assert "the tap returns false for a ping" is to hold the
 *    tap and call it.
 *
 * The assertions that matter most, and why:
 *
 * - **Exact string comparison of the outbound frames.** `{"tx_types":[14,15]}` is structurally
 *   indistinguishable from `{"tx_types":"[14,15]"}` under `toEqual` on a parsed object, and the
 *   protocol demands the second (`docs/spec/06-websocket.md` §8.2). A structural assertion here would
 *   pass against a client that is wrong on the wire.
 * - **The tap returns `false` for channel updates, error frames and pings.** `onFrame` returning
 *   `true` marks a frame consumed; a greedy predicate blackholes an order-book update and the
 *   failure is invisible — the subscription simply goes quiet.
 * - **The pending map is empty after a timeout and after a reconnect.** It is private, so it is
 *   probed the only honest way: a late ack for a swept id reports `ack-unmatched` rather than
 *   resolving anything.
 *
 * Evidence status: no live capture exists (`docs/protocol-notes.md` §8.3 — the upgrade was refused
 * from a restricted jurisdiction, API code 20558), so every ack shape below is synthesised from
 * §8.3, which marks the envelope `[INFER]`. What is tested is the dispatcher's behaviour given those
 * shapes **and its tolerance when a shape turns out to be wrong** — the nested-under-`data` case, the
 * missing-`code` case and the singular-key-carrying-an-array case exist for exactly that.
 */

import { describe, expect, test } from "bun:test";

import type { WsFrameChannel } from "../../src/ws/client.js";
import { LighterWsClient } from "../../src/ws/client.js";
import {
  LighterWsError,
  LighterWsReadOnlyError,
  isLighterWsError,
} from "../../src/ws/errors.js";
import type { SendTxAck, SendTxBatchAck, TxDispatcher } from "../../src/ws/send-tx.js";
import {
  MAX_TX_BATCH_SIZE,
  WS_ACK_CODE_MISSING,
  WS_ACK_CODE_OK,
  createTxDispatcher,
} from "../../src/ws/send-tx.js";
import { MockWsServer } from "../ws-harness.js";

/* ---------------------------------------------------------------------------------------------- */
/* Rigs                                                                                             */
/* ---------------------------------------------------------------------------------------------- */

const BASE_URL = "wss://mainnet.zklighter.elliot.ai/stream";

interface Diagnostic {
  readonly kind: string;
  readonly [k: string]: unknown;
}

interface Rig {
  readonly server: MockWsServer;
  readonly client: LighterWsClient;
  readonly dispatcher: TxDispatcher;
  readonly diagnostics: Diagnostic[];
  kinds(): string[];
}

/** Drain microtasks without moving the virtual clock. The send path is a chained lane queue. */
async function settle(server: MockWsServer, rounds: number = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await server.advance(0);
}

async function rig(overrides: { readOnly?: boolean; sendTxTimeoutMs?: number } = {}): Promise<Rig> {
  const server = new MockWsServer();
  const client = new LighterWsClient({
    url: BASE_URL,
    WebSocket: server.WebSocket,
    timers: server.timers,
    clock: server.now,
    ...(overrides.readOnly === true ? { readOnly: true } : {}),
  });
  const diagnostics: Diagnostic[] = [];
  const dispatcher = createTxDispatcher(client, {
    timers: server.timers,
    now: server.now,
    onDiagnostic: (d: { kind: string; [k: string]: unknown }): void => {
      diagnostics.push(d as Diagnostic);
    },
    ...(overrides.sendTxTimeoutMs === undefined ? {} : { sendTxTimeoutMs: overrides.sendTxTimeoutMs }),
  });
  await client.connect();
  await settle(server);
  return {
    server,
    client,
    dispatcher,
    diagnostics,
    kinds: (): string[] => diagnostics.map((d: Diagnostic): string => d.kind),
  };
}

/** One recorded outbound write, with the lane the dispatcher asked for. */
interface Recorded {
  readonly frame: object;
  readonly lane: string | undefined;
}

/**
 * A {@link WsFrameChannel} with no socket behind it.
 *
 * Exists for the two properties a socket cannot show: the lane on `sendFrame`, and what the inbound
 * tap *returns*.
 */
interface FakeChannel extends WsFrameChannel {
  readonly writes: Recorded[];
  /** Feed one frame to every registered tap; the result is what the client would see. */
  tap(frame: Record<string, unknown>): boolean;
  fireReconnect(code: number, reason: string): void;
  /** Handlers still registered — proves {@link TxDispatcher.close} unregistered them. */
  handlerCount(): { frame: number; reconnect: number };
  failNextSend?: Error;
}

function fakeChannel(opts: { readOnly?: boolean } = {}): FakeChannel {
  const writes: Recorded[] = [];
  const taps = new Set<(f: Record<string, unknown>) => boolean>();
  const reconnects = new Set<(i: { code: number; reason: string }) => void>();
  const channel: FakeChannel = {
    readOnly: opts.readOnly === true,
    writes,
    sendFrame(frame: object, o?: { lane?: "default" | "tx" }): void {
      const failure: Error | undefined = channel.failNextSend;
      if (failure !== undefined) {
        channel.failNextSend = undefined as unknown as Error;
        throw failure;
      }
      writes.push({ frame, lane: o?.lane });
    },
    onFrame(handler: (f: Record<string, unknown>) => boolean): () => void {
      taps.add(handler);
      return (): void => {
        taps.delete(handler);
      };
    },
    onReconnect(handler: (i: { code: number; reason: string }) => void): () => void {
      reconnects.add(handler);
      return (): void => {
        reconnects.delete(handler);
      };
    },
    tap(frame: Record<string, unknown>): boolean {
      for (const handler of [...taps]) {
        if (handler(frame)) return true;
      }
      return false;
    },
    fireReconnect(code: number, reason: string): void {
      for (const handler of [...reconnects]) handler({ code, reason });
    },
    handlerCount: (): { frame: number; reconnect: number } => ({
      frame: taps.size,
      reconnect: reconnects.size,
    }),
  };
  return channel;
}

/** Await a promise that must reject, and hand back the reason. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e: unknown) {
    return e;
  }
  throw new Error("expected a rejection, got a resolution");
}

/* ---------------------------------------------------------------------------------------------- */
/* Wire format                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("outbound wire format", () => {
  test("the single envelope carries tx_info as an object, byte for byte", async () => {
    const { server, dispatcher } = await rig();
    await dispatcher.sendTx(14, { account_index: 3, nonce: 7 }, { id: "tx-1-aaaa" });
    await settle(server);

    expect(server.sent).toEqual([
      '{"type":"jsonapi/sendtx","data":{"id":"tx-1-aaaa","tx_type":14,' +
        '"tx_info":{"account_index":3,"nonce":7}}}',
    ]);
  });

  test("the batch envelope carries tx_types and tx_infos as JSON-encoded STRINGS", async () => {
    const { server, dispatcher } = await rig();
    await dispatcher.sendTxBatch([14, 15], [{ a: 1 }, { b: "2" }], { id: "tx-2-bbbb" });
    await settle(server);

    // The escaped quotes are the whole point: `[{"a":1},{"b":"2"}]` is a *string* value here.
    expect(server.sent).toEqual([
      '{"type":"jsonapi/sendtxbatch","data":{"id":"tx-2-bbbb","tx_types":"[14,15]",' +
        '"tx_infos":"[{\\"a\\":1},{\\"b\\":\\"2\\"}]"}}',
    ]);

    const parsed = JSON.parse(server.sent[0] as string) as {
      data: { tx_types: unknown; tx_infos: unknown };
    };
    expect(typeof parsed.data.tx_types).toBe("string");
    expect(typeof parsed.data.tx_infos).toBe("string");
    expect(JSON.parse(parsed.data.tx_types as string)).toEqual([14, 15]);
    expect(JSON.parse(parsed.data.tx_infos as string)).toEqual([{ a: 1 }, { b: "2" }]);
  });

  test("a bigint field is a bare integer in both envelopes, never a quoted string", async () => {
    const { server, dispatcher } = await rig();
    await dispatcher.sendTx(14, { nonce: 18446744073709551615n }, { id: "s" });
    await dispatcher.sendTxBatch([14], [{ nonce: 18446744073709551615n }], { id: "b" });
    await settle(server);

    expect(server.sent[0]).toBe(
      '{"type":"jsonapi/sendtx","data":{"id":"s","tx_type":14,' +
        '"tx_info":{"nonce":18446744073709551615}}}',
    );
    expect(server.sent[1]).toBe(
      '{"type":"jsonapi/sendtxbatch","data":{"id":"b","tx_types":"[14]",' +
        '"tx_infos":"[{\\"nonce\\":18446744073709551615}]"}}',
    );
  });

  test("a generated id is prefixed, counted and randomised — and never drawn at import", async () => {
    const { server, dispatcher } = await rig();
    const first = await dispatcher.sendTx(14, {});
    const second = await dispatcher.sendTx(14, {});
    await settle(server);

    expect(first.id).toMatch(/^tx-1-[0-9a-f]{8}$/);
    expect(second.id).toMatch(/^tx-2-[0-9a-f]{8}$/);
    expect(first.id).not.toBe(second.id);
  });

  test("idPrefix is honoured, and the counter is per dispatcher", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel, { idPrefix: "order" });
    const first = await dispatcher.sendTx(14, {});
    const second = await dispatcher.sendTxBatch([14], [{}]);
    expect(first.id).toMatch(/^order-1-[0-9a-f]{8}$/);
    expect(second.id).toMatch(/^order-2-[0-9a-f]{8}$/);

    // The id on the wire is the id handed back — a mismatch would make every ack unmatchable.
    const wire = channel.writes.map(
      (w: Recorded): unknown => (w.frame as { data: { id: unknown } }).data.id,
    );
    expect(wire).toEqual([first.id, second.id]);
    dispatcher.close();
  });

  test("every frame is written on the tx lane", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    await dispatcher.sendTx(14, {});
    await dispatcher.sendTxBatch([14], [{}]);
    expect(channel.writes.map((w: Recorded): string | undefined => w.lane)).toEqual(["tx", "tx"]);
    dispatcher.close();
  });

  test("txHash is echoed back verbatim and is absent when the caller supplied none", async () => {
    const { server, dispatcher } = await rig();
    const withHash = await dispatcher.sendTx(14, {}, { txHash: "0xdead" });
    const without = await dispatcher.sendTx(14, {});
    await settle(server);

    expect(withHash.txHash).toBe("0xdead");
    expect(Object.hasOwn(without, "txHash")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Client-side rejections                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("client-side validation", () => {
  test(`a batch of ${String(MAX_TX_BATCH_SIZE + 1)} is refused and emits no frame`, async () => {
    const { server, dispatcher } = await rig();
    const types: number[] = Array.from({ length: 16 }, (): number => 14);
    const infos: object[] = Array.from({ length: 16 }, (): object => ({}));

    const err = await rejection(dispatcher.sendTxBatch(types, infos));
    expect(isLighterWsError(err)).toBe(true);
    expect((err as LighterWsError).message).toContain("15");
    await settle(server);
    expect(server.sent).toEqual([]);
  });

  test(`a batch of exactly ${String(MAX_TX_BATCH_SIZE)} is accepted`, async () => {
    const { server, dispatcher } = await rig();
    const types: number[] = Array.from({ length: MAX_TX_BATCH_SIZE }, (): number => 14);
    const infos: object[] = Array.from({ length: MAX_TX_BATCH_SIZE }, (): object => ({}));
    await dispatcher.sendTxBatch(types, infos);
    await settle(server);
    expect(server.sent.length).toBe(1);
  });

  test("mismatched txTypes/txInfos lengths are refused and emit no frame", async () => {
    const { server, dispatcher } = await rig();
    const err = await rejection(dispatcher.sendTxBatch([14, 15], [{}]));
    expect(isLighterWsError(err)).toBe(true);
    await settle(server);
    expect(server.sent).toEqual([]);
  });

  test("an empty batch is refused", async () => {
    const { dispatcher } = await rig();
    expect(isLighterWsError(await rejection(dispatcher.sendTxBatch([], [])))).toBe(true);
  });

  test("a non-object txInfo and a non-integer txType are refused", async () => {
    const { dispatcher } = await rig();
    expect(
      isLighterWsError(await rejection(dispatcher.sendTx(14, [1, 2] as unknown as object))),
    ).toBe(true);
    expect(isLighterWsError(await rejection(dispatcher.sendTx(1.5, {})))).toBe(true);
  });

  test("a read-only socket refuses both entry points with zero frames written", async () => {
    const { server, client, dispatcher } = await rig({ readOnly: true });
    expect(client.readOnly).toBe(true);

    const single = await rejection(dispatcher.sendTx(14, {}));
    const batch = await rejection(dispatcher.sendTxBatch([14], [{}]));
    await settle(server);

    expect(single).toBeInstanceOf(LighterWsReadOnlyError);
    expect(batch).toBeInstanceOf(LighterWsReadOnlyError);
    expect((single as LighterWsReadOnlyError).wsKind).toBe("read-only");
    expect(server.sent).toEqual([]);
  });

  test("a duplicate in-flight correlation id is refused", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    await dispatcher.sendTx(14, {}, { id: "same" });
    expect(isLighterWsError(await rejection(dispatcher.sendTx(14, {}, { id: "same" })))).toBe(true);
    dispatcher.close();
  });

  test("a failed write removes the pending entry and rejects both promises", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    channel.failNextSend = new LighterWsError("socket is not open");

    const err = await rejection(dispatcher.sendTx(14, {}, { id: "doomed" }));
    expect(isLighterWsError(err)).toBe(true);
    expect(channel.writes).toEqual([]);

    // The entry is gone: the id is free again.
    await dispatcher.sendTx(14, {}, { id: "doomed" });
    expect(channel.writes.length).toBe(1);
    dispatcher.close();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Correlation                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("ack correlation", () => {
  test("two interleaved submissions whose acks arrive out of order resolve correctly", async () => {
    const { server, dispatcher, diagnostics } = await rig();
    const a = await dispatcher.sendTx(14, { n: 1 }, { id: "A" });
    const b = await dispatcher.sendTx(15, { n: 2 }, { id: "B" });
    await settle(server);

    server.emit({ type: "jsonapi/sendtx", id: "B", code: 200, tx_hash: "0xbbb" });
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xaaa" });
    await settle(server);

    expect((await a.ack).txHash).toBe("0xaaa");
    expect((await b.ack).txHash).toBe("0xbbb");
    expect((await a.ack).code).toBe(WS_ACK_CODE_OK);
    expect(
      diagnostics.filter((d: Diagnostic): boolean => d.kind === "match-mode").map(
        (d: Diagnostic): unknown => d["mode"],
      ),
    ).toEqual(["id"]);
  });

  test("the first ack without an id switches the connection to FIFO for good", async () => {
    const { server, dispatcher, diagnostics } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    const b = await dispatcher.sendTx(15, {}, { id: "B" });
    await settle(server);

    // No `id` anywhere in either ack: submission order is the only signal left.
    server.emit({ type: "jsonapi/sendtx", code: 200, tx_hash: "0xfirst" });
    server.emit({ type: "jsonapi/sendtx", code: 200, tx_hash: "0xsecond" });
    await settle(server);

    expect((await a.ack).txHash).toBe("0xfirst");
    expect((await b.ack).txHash).toBe("0xsecond");
    expect(
      diagnostics.filter((d: Diagnostic): boolean => d.kind === "match-mode").map(
        (d: Diagnostic): unknown => d["mode"],
      ),
    ).toEqual(["fifo"]);
  });

  test("once FIFO, a later ack that does carry an id still resolves in submission order", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    const b = await dispatcher.sendTx(15, {}, { id: "B" });
    await settle(server);

    server.emit({ type: "jsonapi/sendtx", code: 200, tx_hash: "0xfirst" });
    await settle(server);
    // An id appearing after the mode was fixed does not un-fix it: the mode is a property of the
    // connection, and mixing strategies mid-connection is how frames get correlated to the wrong tx.
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xsecond" });
    await settle(server);

    expect((await a.ack).txHash).toBe("0xfirst");
    expect((await b.ack).txHash).toBe("0xsecond");
  });

  test("in id mode, an ack that arrives without one falls back rather than being dropped", async () => {
    const { server, dispatcher, kinds } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    const b = await dispatcher.sendTx(15, {}, { id: "B" });
    await settle(server);

    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xaaa" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", code: 200, tx_hash: "0xbbb" });
    await settle(server);

    expect((await a.ack).txHash).toBe("0xaaa");
    expect((await b.ack).txHash).toBe("0xbbb");
    expect(kinds()).toContain("ack-missing-id");
  });

  test("an ack for an id nobody is waiting on is a diagnostic, never a throw", async () => {
    const { server, dispatcher, diagnostics } = await rig();
    await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xaaa" });
    await settle(server);

    server.emit({ type: "jsonapi/sendtx", id: "ghost", code: 200, tx_hash: "0xzzz" });
    await settle(server);

    expect(diagnostics.some((d: Diagnostic): boolean => d.kind === "ack-unmatched")).toBe(true);
  });

  test("a numeric echoed id is matched as its decimal string", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "7" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: 7, code: 200, tx_hash: "0x7" });
    await settle(server);
    expect((await a.ack).txHash).toBe("0x7");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Ack parsing                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("ack parsing", () => {
  test("fields are read at the top level, and raw is the frame untouched", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({
      type: "jsonapi/sendtx",
      id: "A",
      code: 200,
      message: "ok",
      tx_hash: "0xaaa",
      predicted_execution_time_ms: 12,
      volume_quota_remaining: 34,
    });
    await settle(server);

    const ack: SendTxAck = await a.ack;
    expect(ack.code).toBe(200);
    expect(ack.message).toBe("ok");
    expect(ack.txHash).toBe("0xaaa");
    expect(ack.predictedExecutionTimeMs).toBe(12);
    expect(ack.volumeQuotaRemaining).toBe(34);
    expect(ack.raw).toEqual({
      type: "jsonapi/sendtx",
      id: "A",
      code: 200,
      message: "ok",
      tx_hash: "0xaaa",
      predicted_execution_time_ms: 12,
      volume_quota_remaining: 34,
    });
  });

  test("the same fields are read when they sit under `data`", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({
      type: "jsonapi/sendtx",
      data: {
        id: "A",
        code: 200,
        message: "ok",
        tx_hash: "0xaaa",
        predicted_execution_time_ms: 12,
        volume_quota_remaining: 34,
      },
    });
    await settle(server);

    const ack: SendTxAck = await a.ack;
    expect(ack.code).toBe(200);
    expect(ack.message).toBe("ok");
    expect(ack.txHash).toBe("0xaaa");
    expect(ack.predictedExecutionTimeMs).toBe(12);
    expect(ack.volumeQuotaRemaining).toBe(34);
  });

  test("a non-200 code resolves rather than rejects — the caller decides what it means", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 21120, message: "invalid signature" });
    await settle(server);

    const ack: SendTxAck = await a.ack;
    expect(ack.code).toBe(21120);
    expect(ack.message).toBe("invalid signature");
    expect(ack.txHash).toBeUndefined();
  });

  test("an ack with no numeric code resolves best-effort and reports it", async () => {
    const { server, dispatcher, kinds } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: "A", status: "queued" });
    await settle(server);

    const ack: SendTxAck = await a.ack;
    expect(ack.code).toBe(WS_ACK_CODE_MISSING);
    expect(ack.code).not.toBe(WS_ACK_CODE_OK);
    expect(ack.raw).toEqual({ type: "jsonapi/sendtx", id: "A", status: "queued" });
    expect(kinds()).toContain("ack-unrecognised");
  });

  test("a batch ack whose singular tx_hash is an array populates txHashes", async () => {
    const { server, dispatcher } = await rig();
    const b = await dispatcher.sendTxBatch([14, 15], [{}, {}], { id: "B" });
    await settle(server);
    server.emit({
      type: "jsonapi/sendtxbatch",
      id: "B",
      code: 200,
      tx_hash: ["0x1", "0x2"],
      volume_quota_remaining: 9,
    });
    await settle(server);

    const ack: SendTxBatchAck = await b.ack;
    expect(ack.txHashes).toEqual(["0x1", "0x2"]);
    expect(ack.volumeQuotaRemaining).toBe(9);
    expect(Object.hasOwn(ack, "txHash")).toBe(false);
  });

  test("a batch ack spelled tx_hashes, and a single-string batch ack, both land in txHashes", async () => {
    const { server, dispatcher } = await rig();
    const first = await dispatcher.sendTxBatch([14], [{}], { id: "B1" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtxbatch", id: "B1", code: 200, tx_hashes: ["0x1"] });
    await settle(server);
    expect((await first.ack).txHashes).toEqual(["0x1"]);

    const second = await dispatcher.sendTxBatch([14], [{}], { id: "B2" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtxbatch", id: "B2", code: 200, tx_hash: "0x9" });
    await settle(server);
    expect((await second.ack).txHashes).toEqual(["0x9"]);
  });

  test("a count that did not arrive as a JSON number is left absent rather than coerced", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({
      type: "jsonapi/sendtx",
      id: "A",
      code: 200,
      tx_hash: "0xaaa",
      predicted_execution_time_ms: "12",
      volume_quota_remaining: null,
    });
    await settle(server);

    const ack: SendTxAck = await a.ack;
    expect(ack.predictedExecutionTimeMs).toBeUndefined();
    expect(ack.volumeQuotaRemaining).toBeUndefined();
    // Nothing was lost: the frame is intact on `raw`.
    expect((ack.raw as Record<string, unknown>)["predicted_execution_time_ms"]).toBe("12");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The tap                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("the inbound tap consumes only acks", () => {
  test("a channel update, an error frame and a ping all fall through", () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);

    expect(
      channel.tap({
        type: "update/order_book",
        channel: "order_book:0",
        order_book: { code: 0, asks: [], bids: [], offset: 1, nonce: 2, begin_nonce: 1 },
      }),
    ).toBe(false);
    expect(channel.tap({ type: "error", code: 30003, message: "Already Subscribed" })).toBe(false);
    expect(channel.tap({ type: "ping" })).toBe(false);
    expect(channel.tap({ type: "connected" })).toBe(false);
    expect(channel.tap({ type: "subscribed/account_all_txs", channel: "account_all_txs:1" })).toBe(
      false,
    );
    dispatcher.close();
  });

  test("a jsonapi/sendtx frame, and a code+tx_hash frame, are both consumed", () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);

    expect(channel.tap({ type: "jsonapi/sendtx", id: "x", code: 200 })).toBe(true);
    expect(channel.tap({ type: "jsonapi/sendtxbatch", id: "x", code: 200 })).toBe(true);
    expect(channel.tap({ code: 200, tx_hash: "0xaaa" })).toBe(true);
    expect(channel.tap({ data: { code: 200, tx_hash: "0xaaa" } })).toBe(true);
    dispatcher.close();
  });

  test("an error frame echoing a live correlation id is claimed; an unknown one is not", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    const a = await dispatcher.sendTx(14, {}, { id: "live" });

    expect(channel.tap({ type: "error", code: 21120, id: "not-ours" })).toBe(false);
    expect(channel.tap({ type: "error", code: 21120, id: "live", message: "bad sig" })).toBe(true);

    const ack: SendTxAck = await a.ack;
    expect(ack.code).toBe(21120);
    dispatcher.close();
  });

  test("a throwing diagnostic sink cannot break the tap or the submission", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel, {
      onDiagnostic: (): never => {
        throw new Error("sink exploded");
      },
    });
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    expect(channel.tap({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0x1" })).toBe(true);
    expect((await a.ack).txHash).toBe("0x1");
    dispatcher.close();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Timeouts, reconnects, shutdown                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("timeouts", () => {
  test("with no ack the promise rejects after sendTxTimeoutMs, carrying the txHash", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A", txHash: "0xfeed" });
    await settle(server);

    await server.advance(9_999);
    let settledEarly = false;
    void a.ack.then(
      (): void => {
        settledEarly = true;
      },
      (): void => {
        settledEarly = true;
      },
    );
    await settle(server);
    expect(settledEarly).toBe(false);

    await server.advance(1);
    const err = await rejection(a.ack);
    expect(isLighterWsError(err)).toBe(true);
    const timeout = err as { wsKind: string; txHash?: string; message: string };
    expect(timeout.wsKind).toBe("timeout");
    expect(timeout.txHash).toBe("0xfeed");
    // The two recovery routes are named, because a timeout is not a failure (§8.4).
    expect(timeout.message).toContain("GET /api/v1/tx?by=hash");
    expect(timeout.message).toContain("account_tx");
  });

  test("a per-call timeoutMs overrides the dispatcher default", async () => {
    const { server, dispatcher } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A", timeoutMs: 25 });
    await settle(server);
    await server.advance(25);
    expect(isLighterWsError(await rejection(a.ack))).toBe(true);
  });

  test("sendTxTimeoutMs is configurable, and the pending entry is gone afterwards", async () => {
    const { server, dispatcher, diagnostics } = await rig({ sendTxTimeoutMs: 500 });
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    await server.advance(500);
    expect(isLighterWsError(await rejection(a.ack))).toBe(true);

    // The map is private, so probe it: a late ack has nothing left to match.
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xlate" });
    await settle(server);
    expect(diagnostics.some((d: Diagnostic): boolean => d.kind === "ack-unmatched")).toBe(true);
    expect(diagnostics.some((d: Diagnostic): boolean => d.kind === "ack")).toBe(false);
  });

  test("a batch timeout lists every hash even though the error carries at most one", async () => {
    const { server, dispatcher } = await rig({ sendTxTimeoutMs: 100 });
    const b = await dispatcher.sendTxBatch([14, 15], [{}, {}], {
      id: "B",
      txHashes: ["0x1", "0x2"],
    });
    await settle(server);
    await server.advance(100);

    const err = (await rejection(b.ack)) as { txHash?: string; message: string };
    expect(err.txHash).toBeUndefined();
    expect(err.message).toContain("0x1");
    expect(err.message).toContain("0x2");
  });

  test("an ack that arrives in time cancels the timeout", async () => {
    const { server, dispatcher } = await rig({ sendTxTimeoutMs: 100 });
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: "A", code: 200, tx_hash: "0xok" });
    await settle(server);
    await server.advance(10_000);
    expect((await a.ack).txHash).toBe("0xok");
  });

  test("a non-positive timeout is refused at configuration time", () => {
    const channel = fakeChannel();
    expect((): unknown => createTxDispatcher(channel, { sendTxTimeoutMs: 0 })).toThrow(
      LighterWsError,
    );
  });
});

describe("reconnect and shutdown", () => {
  test("a reconnect rejects every pending correlation and empties the map", async () => {
    const { server, dispatcher, diagnostics } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    const b = await dispatcher.sendTx(15, {}, { id: "B", txHash: "0xbbb" });
    await settle(server);

    server.closeWith(1006, "gone");
    await settle(server);

    const first = (await rejection(a.ack)) as { wsKind: string; wsCode?: number };
    const second = (await rejection(b.ack)) as { wsKind: string; txHash?: string };
    // No hash to carry: the close error itself, verbatim.
    expect(first.wsKind).toBe("closed");
    expect(first.wsCode).toBe(1006);
    // One hash: wrapped so the recovery route survives.
    expect(second.wsKind).toBe("timeout");
    expect(second.txHash).toBe("0xbbb");

    expect(diagnostics.some((d: Diagnostic): boolean => d.kind === "reconnect")).toBe(true);
    const abort = diagnostics.find((d: Diagnostic): boolean => d.kind === "abort");
    expect(abort?.["count"]).toBe(2);
  });

  test("the matching mode is reset by a reconnect: a fresh connection re-evaluates it", async () => {
    const { server, dispatcher, diagnostics } = await rig();
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    await settle(server);
    // Connection 1 sees an ack with no id → FIFO.
    server.emit({ type: "jsonapi/sendtx", code: 200, tx_hash: "0xfirst" });
    await settle(server);
    expect((await a.ack).txHash).toBe("0xfirst");

    server.closeWith(1006);
    await server.advance(60_000);
    expect(server.sockets.length).toBeGreaterThan(1);

    // Connection 2 sees an ack that does carry one → id matching, freshly decided.
    const b = await dispatcher.sendTx(14, {}, { id: "B" });
    const c = await dispatcher.sendTx(15, {}, { id: "C" });
    await settle(server);
    server.emit({ type: "jsonapi/sendtx", id: "C", code: 200, tx_hash: "0xccc" });
    server.emit({ type: "jsonapi/sendtx", id: "B", code: 200, tx_hash: "0xbbb" });
    await settle(server);

    expect((await b.ack).txHash).toBe("0xbbb");
    expect((await c.ack).txHash).toBe("0xccc");
    expect(
      diagnostics
        .filter((d: Diagnostic): boolean => d.kind === "match-mode")
        .map((d: Diagnostic): unknown => d["mode"]),
    ).toEqual(["fifo", "id"]);
  });

  test("abortPending rejects everything with the caller's reason", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    const b = await dispatcher.sendTx(15, {}, { id: "B", txHash: "0xbbb" });

    const reason = new Error("shutting down");
    dispatcher.abortPending(reason);

    expect(await rejection(a.ack)).toBe(reason);
    const wrapped = (await rejection(b.ack)) as { txHash?: string; cause?: unknown };
    expect(wrapped.txHash).toBe("0xbbb");
    expect(wrapped.cause).toBe(reason);
    dispatcher.close();
  });

  test("close() unregisters both handlers, aborts pending, and refuses further submissions", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    expect(channel.handlerCount()).toEqual({ frame: 1, reconnect: 1 });

    const a = await dispatcher.sendTx(14, {}, { id: "A" });
    dispatcher.close();
    dispatcher.close(); // idempotent

    expect(channel.handlerCount()).toEqual({ frame: 0, reconnect: 0 });
    expect((await rejection(a.ack) as { wsKind: string }).wsKind).toBe("closed");
    expect(isLighterWsError(await rejection(dispatcher.sendTx(14, {})))).toBe(true);
    expect(channel.writes.length).toBe(1);
  });

  test("a caller that ignores `ack` entirely does not produce an unhandled rejection", async () => {
    const channel = fakeChannel();
    const dispatcher = createTxDispatcher(channel);
    await dispatcher.sendTx(14, {}, { id: "A", txHash: "0xaaa" });
    channel.fireReconnect(1006, "");
    // Nothing awaits the ack. If the dispatcher did not pre-handle its own rejection this would
    // surface as an unhandled rejection and take a Node process down.
    await Promise.resolve();
    dispatcher.close();
    expect(channel.writes.length).toBe(1);
  });
});
