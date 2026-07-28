/**
 * Tests for the WebSocket wire codec.
 *
 * **Evidence note.** `test/fixtures/ws/capture.json` carries no frames: the wave-0 capture was
 * refused at the upgrade from a restricted jurisdiction (API code 20558), so there is nothing to
 * replay. That is asserted below rather than glossed over — if a future capture lands, the
 * fixture-driven test stops being vacuous automatically and starts exercising real frames. Until
 * then every inbound frame here is constructed inline from the shapes in
 * `docs/spec/06-websocket.md`, which is what the issue instructs when a frame is genuinely absent
 * from the capture.
 */

import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import {
  buildPong,
  buildSendTx,
  buildSendTxBatch,
  buildSubscribe,
  buildUnsubscribe,
  classifyWsError,
  decodeFrame,
  diagnoseUpgradeFailure,
  familyFromType,
  normaliseChannelKey,
  resolveRouteKey,
  upgradeProbeUrl,
} from "../../src/ws/protocol.js";
import type { InboundFrame, WsErrorAction } from "../../src/ws/protocol.js";

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Decode a value that is already an object, by serialising it the way the wire would. */
function decodeObject(frame: Record<string, unknown>): InboundFrame {
  return decodeFrame(JSON.stringify(frame));
}

/** Parse a built outbound frame back into a plain object, for structural assertions. */
function reparse(built: string): Record<string, unknown> {
  return JSON.parse(built) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------------------------- */
/* The capture fixture                                                                            */
/* -------------------------------------------------------------------------------------------- */

const FIXTURE_DIR = new URL("../fixtures/ws/", import.meta.url);

interface CaptureFile {
  frames?: unknown[];
  captureFailed?: { reason: string; apiCode: number };
}

describe("test/fixtures/ws capture", () => {
  const files: string[] = readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  test("at least one capture file exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("the live capture is blocked, so replay coverage is honestly zero", () => {
    const capture: CaptureFile = JSON.parse(
      readFileSync(new URL("capture.json", FIXTURE_DIR), "utf8"),
    ) as CaptureFile;
    // If this ever fails because frames arrived, delete the assertion — the replay below becomes
    // the real test and this file should stop apologising for synthetic frames.
    expect(capture.captureFailed?.apiCode).toBe(20558);
    expect(capture.frames ?? []).toHaveLength(0);
  });

  for (const name of files) {
    test(`every frame in ${name} decodes, and no captured type decodes as unknown`, () => {
      const parsed: CaptureFile = JSON.parse(
        readFileSync(new URL(name, FIXTURE_DIR), "utf8"),
      ) as CaptureFile;
      for (const entry of parsed.frames ?? []) {
        // Frames may be recorded as raw text or as the already-parsed object.
        const raw: string = typeof entry === "string" ? entry : JSON.stringify(entry);
        const decoded: InboundFrame = decodeFrame(raw);
        expect(decoded.kind).not.toBe("malformed");
        expect(decoded.kind).not.toBe("unknown");
      }
    });
  }
});

/* -------------------------------------------------------------------------------------------- */
/* Channel-key codec                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("normaliseChannelKey", () => {
  test("colon spelling becomes slash spelling", () => {
    expect(normaliseChannelKey("order_book:0")).toBe("order_book/0");
    expect(normaliseChannelKey("candle:0:1m")).toBe("candle/0/1m");
    expect(normaliseChannelKey("account_all_assets:1234")).toBe("account_all_assets/1234");
  });

  test("channels that already use slashes are unchanged", () => {
    // account_market echoes SLASHES, not colons — spec §2.3.
    expect(normaliseChannelKey("account_market/3/1234")).toBe("account_market/3/1234");
  });

  test("index-free channels are unchanged", () => {
    expect(normaliseChannelKey("height")).toBe("height");
    expect(normaliseChannelKey("rfq")).toBe("rfq");
    expect(normaliseChannelKey("")).toBe("");
  });

  test("idempotent", () => {
    const once: string = normaliseChannelKey("candle:0:1m");
    expect(normaliseChannelKey(once)).toBe(once);
  });

  test("nothing but the separator is touched", () => {
    // No trimming, no case folding: `v` and `V` differ only by case elsewhere in this protocol.
    expect(normaliseChannelKey(" Order_Book:0 ")).toBe(" Order_Book/0 ");
  });
});

describe("familyFromType", () => {
  test("strips the three inbound prefixes", () => {
    expect(familyFromType("subscribed/order_book")).toBe("order_book");
    expect(familyFromType("update/order_book")).toBe("order_book");
    expect(familyFromType("unsubscribed/order_book")).toBe("order_book");
    expect(familyFromType("update/mark_price_candle")).toBe("mark_price_candle");
  });

  test("returns null for types that carry no family", () => {
    expect(familyFromType("connected")).toBeNull();
    expect(familyFromType("ping")).toBeNull();
    expect(familyFromType("jsonapi/sendtx")).toBeNull();
    expect(familyFromType("")).toBeNull();
  });

  test("returns null for an empty remainder", () => {
    expect(familyFromType("update/")).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Outbound builders                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("buildPong", () => {
  test("is exactly the documented frame", () => {
    expect(buildPong()).toBe('{"type":"pong"}');
  });
});

describe("buildSubscribe", () => {
  test("omits auth entirely when there is no token", () => {
    const built: string = buildSubscribe("order_book/0");
    expect(built).toBe('{"type":"subscribe","channel":"order_book/0"}');
    expect(Object.hasOwn(reparse(built), "auth")).toBe(false);
  });

  test("includes auth when a token is supplied", () => {
    const built: string = buildSubscribe("account_all_assets/1234", "tok");
    expect(built).toBe(
      '{"type":"subscribe","channel":"account_all_assets/1234","auth":"tok"}',
    );
    expect(reparse(built)["auth"]).toBe("tok");
  });

  test("an empty token is treated as no token, never as an empty credential", () => {
    expect(Object.hasOwn(reparse(buildSubscribe("order_book/0", "")), "auth")).toBe(false);
  });

  test("a colon-spelled key is normalised on the way out", () => {
    expect(buildSubscribe("order_book:0")).toBe('{"type":"subscribe","channel":"order_book/0"}');
  });

  test("the channel string is JSON-escaped, not concatenated", () => {
    expect(reparse(buildSubscribe('weird"key'))["channel"]).toBe('weird"key');
  });
});

describe("buildUnsubscribe", () => {
  test("carries only the channel", () => {
    expect(buildUnsubscribe("candle/0/1m")).toBe(
      '{"type":"unsubscribe","channel":"candle/0/1m"}',
    );
    expect(Object.keys(reparse(buildUnsubscribe("height")))).toEqual(["type", "channel"]);
  });
});

describe("buildSendTx", () => {
  test("tx_info is an embedded OBJECT", () => {
    const built: string = buildSendTx({ txType: 14, txInfo: { Nonce: 7 } });
    const data = reparse(built)["data"] as Record<string, unknown>;
    expect(reparse(built)["type"]).toBe("jsonapi/sendtx");
    expect(typeof data["tx_info"]).toBe("object");
    expect(typeof data["tx_type"]).toBe("number");
    expect(data["tx_type"]).toBe(14);
    expect((data["tx_info"] as Record<string, unknown>)["Nonce"]).toBe(7);
  });

  test("id is included when given and omitted when not", () => {
    const withId = reparse(buildSendTx({ id: "tx-1", txType: 14, txInfo: {} }))["data"] as Record<
      string,
      unknown
    >;
    expect(withId["id"]).toBe("tx-1");
    const withoutId = reparse(buildSendTx({ txType: 14, txInfo: {} }))["data"] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(withoutId, "id")).toBe(false);
    expect(
      Object.hasOwn(
        reparse(buildSendTx({ id: "", txType: 14, txInfo: {} }))["data"] as Record<string, unknown>,
        "id",
      ),
    ).toBe(false);
  });

  test("a pre-serialised tx_info is spliced verbatim, so wide integers survive", () => {
    // This is the form `toTxInfo` produces. Re-parsing it to embed would round the nonce.
    const doc = '{"Nonce":9007199254740993,"Price":"2064.54"}';
    const built: string = buildSendTx({ txType: 14, txInfo: doc });
    expect(built).toContain('"tx_info":' + doc);
    expect(built).toContain("9007199254740993");
  });

  test("bigint fields in an object tx_info become bare integer literals", () => {
    const built: string = buildSendTx({ txType: 14, txInfo: { Nonce: 9007199254740993n } });
    expect(built).toContain('"Nonce":9007199254740993');
    expect(built).not.toContain('"9007199254740993"');
  });

  test("decimal strings pass through untouched", () => {
    const built: string = buildSendTx({ txType: 14, txInfo: { Price: "2064.5400" } });
    expect(built).toContain('"Price":"2064.5400"');
  });

  test("a string tx_info that is not an object document is refused", () => {
    expect(() => buildSendTx({ txType: 14, txInfo: "not-a-document" })).toThrow(
      LighterValidationError,
    );
  });

  test("a non-integer tx type is refused", () => {
    expect(() => buildSendTx({ txType: 1.5, txInfo: {} })).toThrow(LighterValidationError);
  });
});

describe("buildSendTxBatch", () => {
  test("tx_types and tx_infos are JSON-encoded STRINGS", () => {
    const built: string = buildSendTxBatch({
      txTypes: [14, 15],
      txInfos: [{ a: 1 }, { b: 2 }],
    });
    const data = reparse(built)["data"] as Record<string, unknown>;
    expect(reparse(built)["type"]).toBe("jsonapi/sendtxbatch");
    expect(typeof data["tx_types"]).toBe("string");
    expect(typeof data["tx_infos"]).toBe("string");
    expect(data["tx_types"]).toBe("[14,15]");
    expect(data["tx_infos"]).toBe('[{"a":1},{"b":2}]');
    // The strings contain valid JSON arrays.
    expect(JSON.parse(data["tx_types"] as string)).toEqual([14, 15]);
    expect(JSON.parse(data["tx_infos"] as string)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("the single and batch envelopes disagree about typing, on purpose", () => {
    const single = reparse(buildSendTx({ txType: 14, txInfo: { a: 1 } }))["data"] as Record<
      string,
      unknown
    >;
    const batch = reparse(buildSendTxBatch({ txTypes: [14], txInfos: [{ a: 1 }] }))[
      "data"
    ] as Record<string, unknown>;
    expect(typeof single["tx_info"]).toBe("object");
    expect(typeof batch["tx_infos"]).toBe("string");
  });

  test("pre-serialised documents are spliced verbatim inside the encoded array", () => {
    const built: string = buildSendTxBatch({
      txTypes: [14],
      txInfos: ['{"Nonce":9007199254740993}'],
    });
    const data = reparse(built)["data"] as Record<string, unknown>;
    expect(data["tx_infos"]).toBe('[{"Nonce":9007199254740993}]');
  });

  test("id is included when given and omitted when not", () => {
    const withId = reparse(buildSendTxBatch({ id: "b-1", txTypes: [], txInfos: [] }))[
      "data"
    ] as Record<string, unknown>;
    expect(withId["id"]).toBe("b-1");
    const withoutId = reparse(buildSendTxBatch({ txTypes: [], txInfos: [] }))["data"] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(withoutId, "id")).toBe(false);
    expect(withoutId["tx_types"]).toBe("[]");
  });

  test("misaligned types and infos are refused", () => {
    expect(() => buildSendTxBatch({ txTypes: [14, 15], txInfos: [{}] })).toThrow(
      LighterValidationError,
    );
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Inbound decoding                                                                               */
/* -------------------------------------------------------------------------------------------- */

describe("decodeFrame — lifecycle frames", () => {
  test("connected", () => {
    expect(decodeFrame('{"type":"connected"}')).toEqual({ kind: "connected" });
  });

  test("ping (and the reply is pong, never ping)", () => {
    expect(decodeFrame('{"type":"ping"}')).toEqual({ kind: "ping" });
    expect(buildPong()).toBe('{"type":"pong"}');
  });
});

describe("decodeFrame — malformed input", () => {
  test("a non-string frame is binary and never interpreted", () => {
    const decoded: InboundFrame = decodeFrame(new Uint8Array([1, 2, 3]));
    expect(decoded).toMatchObject({ kind: "malformed", reason: "binary" });
    expect(decodeFrame(undefined)).toMatchObject({ kind: "malformed", reason: "binary" });
    expect(decodeFrame(new ArrayBuffer(4))).toMatchObject({ kind: "malformed", reason: "binary" });
  });

  test("a non-JSON string", () => {
    expect(decodeFrame("<html>403</html>")).toMatchObject({
      kind: "malformed",
      reason: "not-json",
    });
    expect(decodeFrame("")).toMatchObject({ kind: "malformed", reason: "not-json" });
  });

  test("valid JSON that is not an object", () => {
    expect(decodeFrame("42")).toMatchObject({ kind: "malformed", reason: "not-object" });
    expect(decodeFrame('"a string"')).toMatchObject({ kind: "malformed", reason: "not-object" });
    expect(decodeFrame("null")).toMatchObject({ kind: "malformed", reason: "not-object" });
    expect(decodeFrame("[1,2]")).toMatchObject({ kind: "malformed", reason: "not-object" });
  });

  test("decoding is total — nothing throws, whatever arrives", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      Symbol("x"),
      { not: "a string" },
      "{",
      '{"type":',
      '{"type":null}',
      '{"type":42}',
      "{}",
    ];
    for (const input of inputs) {
      expect(() => decodeFrame(input)).not.toThrow();
    }
  });
});

describe("decodeFrame — subscription frames", () => {
  const snapshot = {
    type: "subscribed/order_book",
    channel: "order_book:0",
    order_book: { code: 0, asks: [{ price: "2064.54", size: "0.3285" }], bids: [], nonce: 5 },
  };

  test("subscribed/* is a snapshot, with both channel spellings retained", () => {
    const decoded: InboundFrame = decodeObject(snapshot);
    expect(decoded.kind).toBe("snapshot");
    if (decoded.kind !== "snapshot") throw new Error("unreachable");
    expect(decoded.family).toBe("order_book");
    expect(decoded.channelRaw).toBe("order_book:0");
    expect(decoded.normKey).toBe("order_book/0");
    // The whole frame is the body, envelope included.
    expect(decoded.body["type"]).toBe("subscribed/order_book");
  });

  test("prices and sizes are passed through as the strings they arrived as", () => {
    const decoded: InboundFrame = decodeObject(snapshot);
    if (decoded.kind !== "snapshot") throw new Error("unreachable");
    const book = decoded.body["order_book"] as Record<string, unknown>;
    const asks = book["asks"] as Array<Record<string, unknown>>;
    expect(asks[0]?.["price"]).toBe("2064.54");
    expect(asks[0]?.["size"]).toBe("0.3285");
  });

  test("update/* is an update", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 5, nonce: 6, asks: [], bids: [] },
    });
    expect(decoded.kind).toBe("update");
  });

  test("an update/order_book with no begin_nonce is the mislabelled snapshot (spec §5.3)", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { code: 0, asks: [], bids: [], nonce: 5 },
    });
    expect(decoded.kind).toBe("snapshot");
  });

  test("a top-level begin_nonce also marks a delta", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:0",
      begin_nonce: 5,
      order_book: { asks: [], bids: [] },
    });
    expect(decoded.kind).toBe("update");
  });

  test("the begin_nonce fallback is scoped to order_book only", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/ticker",
      channel: "ticker:0",
      ticker: { s: "ETH" },
    });
    expect(decoded.kind).toBe("update");
  });

  test("unsubscribed/* is an ack, not a fatal unknown", () => {
    const decoded: InboundFrame = decodeObject({
      type: "unsubscribed/order_book",
      channel: "order_book:0",
    });
    expect(decoded.kind).toBe("unsubscribed");
    if (decoded.kind !== "unsubscribed") throw new Error("unreachable");
    expect(decoded.normKey).toBe("order_book/0");
  });

  test("a channel-less subscription frame omits channelRaw and normKey", () => {
    const decoded: InboundFrame = decodeObject({ type: "subscribed/height", height: 12 });
    expect(decoded.kind).toBe("snapshot");
    if (decoded.kind !== "snapshot") throw new Error("unreachable");
    expect(decoded.channelRaw).toBeUndefined();
    expect(decoded.normKey).toBeUndefined();
    expect(Object.hasOwn(decoded, "channelRaw")).toBe(false);
  });

  test("account_market keeps its slash spelling", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/account_market",
      channel: "account_market/3/1234",
    });
    if (decoded.kind !== "update") throw new Error("unreachable");
    expect(decoded.normKey).toBe("account_market/3/1234");
  });
});

describe("decodeFrame — 64-bit integers", () => {
  test("transaction_time survives as an exact string, not a rounded double", () => {
    const raw = '{"type":"update/trade","channel":"trade:0","transaction_time":9007199254740993}';
    const decoded: InboundFrame = decodeFrame(raw);
    if (decoded.kind !== "update") throw new Error("unreachable");
    expect(decoded.body["transaction_time"]).toBe("9007199254740993");
  });

  test("a JSON key that differs only by case is never folded", () => {
    const decoded: InboundFrame = decodeObject({
      type: "update/candle",
      channel: "candle:0:1m",
      candle: { v: "1.5", V: "3000.25" },
    });
    if (decoded.kind !== "update") throw new Error("unreachable");
    const candle = decoded.body["candle"] as Record<string, unknown>;
    expect(candle["v"]).toBe("1.5");
    expect(candle["V"]).toBe("3000.25");
  });
});

describe("decodeFrame — acks", () => {
  test("a jsonapi/sendtx reply is an ack with the echoed id", () => {
    const decoded: InboundFrame = decodeObject({
      type: "jsonapi/sendtx",
      id: "tx-1",
      code: 200,
      tx_hash: "abc",
    });
    expect(decoded.kind).toBe("ack");
    if (decoded.kind !== "ack") throw new Error("unreachable");
    expect(decoded.id).toBe("tx-1");
    expect(decoded.body["tx_hash"]).toBe("abc");
  });

  test("code 200 on an ack is success, not an error", () => {
    expect(decodeObject({ type: "jsonapi/sendtxbatch", code: 200 }).kind).toBe("ack");
    expect(decodeObject({ type: "jsonapi/sendtx", code: 0 }).kind).toBe("ack");
  });

  test("an id nested under data is found", () => {
    const decoded: InboundFrame = decodeObject({
      type: "jsonapi/sendtx",
      data: { id: "tx-2", tx_hash: "def" },
    });
    if (decoded.kind !== "ack") throw new Error("unreachable");
    expect(decoded.id).toBe("tx-2");
  });

  test("an ack with no id omits the field, so the dispatcher can fall back to FIFO", () => {
    const decoded: InboundFrame = decodeObject({ type: "jsonapi/sendtx", tx_hash: "abc" });
    if (decoded.kind !== "ack") throw new Error("unreachable");
    expect(decoded.id).toBeUndefined();
    expect(Object.hasOwn(decoded, "id")).toBe(false);
  });

  test("an unexpected envelope carrying tx_hash is still recognised as an ack", () => {
    // The ack envelope is [INFER] (spec §8.3). This is the hedge.
    expect(decodeObject({ type: "tx_ack", tx_hash: "abc", id: "tx-3" }).kind).toBe("ack");
  });
});

describe("decodeFrame — errors", () => {
  test("an explicit error envelope", () => {
    const decoded: InboundFrame = decodeObject({
      type: "error",
      code: 30005,
      message: "Invalid Channel",
      channel: "order_book:999",
    });
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") throw new Error("unreachable");
    expect(decoded.code).toBe(30005);
    expect(decoded.message).toBe("Invalid Channel");
    expect(decoded.normKey).toBe("order_book/999");
  });

  test("a failure code is an error whatever the type says", () => {
    // The envelope is undocumented: error frames may not carry `type:"error"` at all.
    const decoded: InboundFrame = decodeObject({
      type: "subscribed/order_book",
      channel: "order_book:0",
      code: 30003,
      message: "Already Subscribed to ",
    });
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") throw new Error("unreachable");
    expect(decoded.code).toBe(30003);
    expect(decoded.message).toBe("Already Subscribed to ");
  });

  test("a nested order_book.code is a payload status, not an envelope failure", () => {
    const decoded: InboundFrame = decodeObject({
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { code: 0, asks: [], bids: [] },
    });
    expect(decoded.kind).toBe("snapshot");
  });

  test("type error with no code still decodes as an error", () => {
    const decoded: InboundFrame = decodeObject({ type: "error", message: "boom" });
    if (decoded.kind !== "error") throw new Error("unreachable");
    expect(decoded.code).toBe(0);
    expect(decoded.message).toBe("boom");
  });

  test("a message-less error yields an empty message rather than undefined", () => {
    const decoded: InboundFrame = decodeObject({ code: 23001 });
    if (decoded.kind !== "error") throw new Error("unreachable");
    expect(decoded.message).toBe("");
    expect(decoded.code).toBe(23001);
  });

  test("an unlisted code survives intact", () => {
    const decoded: InboundFrame = decodeObject({ code: 987654, message: "who knows" });
    if (decoded.kind !== "error") throw new Error("unreachable");
    expect(decoded.code).toBe(987654);
  });
});

describe("decodeFrame — unknown types", () => {
  test("an invented type is unknown, never a throw", () => {
    const decoded: InboundFrame = decodeFrame('{"type":"brand_new_thing","x":1}');
    expect(decoded.kind).toBe("unknown");
    if (decoded.kind !== "unknown") throw new Error("unreachable");
    expect(decoded.type).toBe("brand_new_thing");
    expect((decoded.body as Record<string, unknown>)["x"]).toBe(1);
  });

  test("an object with no type at all is unknown with an empty type", () => {
    const decoded: InboundFrame = decodeFrame("{}");
    if (decoded.kind !== "unknown") throw new Error("unreachable");
    expect(decoded.type).toBe("");
  });

  test("a non-string type does not become a family", () => {
    expect(decodeFrame('{"type":42}').kind).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Routing                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("resolveRouteKey", () => {
  test("step 1 — the normalised inbound channel hits directly", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 1 },
    });
    expect(resolveRouteKey(frame, ["order_book/0", "order_book/1"])).toEqual({
      routed: true,
      key: "order_book/0",
    });
  });

  test("account_orders routes via the sibling account field", () => {
    // The inbound channel omits the account entirely — spec §2.3.
    const frame: InboundFrame = decodeObject({
      type: "update/account_orders",
      channel: "account_orders:3",
      account: 1234,
      orders: [],
    });
    expect(resolveRouteKey(frame, ["account_orders/3/1234", "account_orders/4/1234"])).toEqual({
      routed: true,
      key: "account_orders/3/1234",
    });
  });

  test("account_orders with two same-market subscriptions for different accounts stays exact", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/account_orders",
      channel: "account_orders:3",
      account: 1234,
    });
    expect(resolveRouteKey(frame, ["account_orders/3/1234", "account_orders/3/9999"])).toEqual({
      routed: true,
      key: "account_orders/3/1234",
    });
  });

  test("a candle frame reconstructs family/market/resolution", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/candle",
      channel: "candle:0:1m",
      market_id: 0,
      resolution: "1m",
    });
    expect(resolveRouteKey(frame, ["candle/0/1m"])).toEqual({ routed: true, key: "candle/0/1m" });
  });

  test("a discriminator nested in the family payload is found", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/market_stats",
      channel: "market_stats:7",
      market_stats: { market_id: 7, symbol: "ETH" },
    });
    // The colon key already hits; drop it to force the reconstruction path.
    const noChannel: InboundFrame = decodeObject({
      type: "update/market_stats",
      market_stats: { market_id: 7, symbol: "ETH" },
    });
    expect(resolveRouteKey(frame, ["market_stats/7"])).toEqual({
      routed: true,
      key: "market_stats/7",
    });
    expect(resolveRouteKey(noChannel, ["market_stats/7", "market_stats/8"])).toEqual({
      routed: true,
      key: "market_stats/7",
    });
  });

  test("step 3 — a sole subscription of the family takes the frame (market_stats/all)", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/market_stats",
      channel: "market_stats:12",
      market_stats: { market_id: 12 },
    });
    expect(resolveRouteKey(frame, ["market_stats/all"])).toEqual({
      routed: true,
      key: "market_stats/all",
    });
  });

  test("step 3 — a frame naming a channel we do not hold is dropped, not merged", () => {
    // A literal reading of spec §2.3 step 4 would merge market 5's deltas into market 0's book.
    const frame: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:5",
      order_book: { begin_nonce: 1, asks: [], bids: [] },
    });
    expect(resolveRouteKey(frame, ["order_book/0"])).toEqual({
      routed: false,
      reason: "no-match",
    });
  });

  test("step 3 — a prefix of our key still routes (the account_orders wart)", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/account_orders",
      channel: "account_orders:3",
      orders: [],
    });
    expect(resolveRouteKey(frame, ["account_orders/3/1234"])).toEqual({
      routed: true,
      key: "account_orders/3/1234",
    });
  });

  test("step 3 — a channel-less frame still routes to the sole subscription", () => {
    const frame: InboundFrame = decodeObject({ type: "update/user_stats", stats: {} });
    expect(resolveRouteKey(frame, ["user_stats/1234"])).toEqual({
      routed: true,
      key: "user_stats/1234",
    });
  });

  test("two candidates of the same family are ambiguous, never a guess", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:9",
      order_book: { begin_nonce: 1 },
    });
    expect(resolveRouteKey(frame, ["order_book/0", "order_book/1"])).toEqual({
      routed: false,
      reason: "ambiguous",
    });
  });

  test("two reconstructed candidates matching distinct keys are ambiguous", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/account_all",
      market_id: 1,
      account: 2,
    });
    expect(resolveRouteKey(frame, ["account_all/1", "account_all/2"])).toEqual({
      routed: false,
      reason: "ambiguous",
    });
  });

  test("no subscription of the family is no-match", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/trade",
      channel: "trade:5",
      trades: [],
    });
    expect(resolveRouteKey(frame, ["order_book/0"])).toEqual({ routed: false, reason: "no-match" });
    expect(resolveRouteKey(frame, [])).toEqual({ routed: false, reason: "no-match" });
  });

  test("frames with no channel dimension report no-channel", () => {
    expect(resolveRouteKey({ kind: "ping" }, ["order_book/0"])).toEqual({
      routed: false,
      reason: "no-channel",
    });
    expect(resolveRouteKey({ kind: "connected" }, [])).toEqual({
      routed: false,
      reason: "no-channel",
    });
    expect(
      resolveRouteKey(decodeObject({ type: "jsonapi/sendtx", tx_hash: "a" }), ["order_book/0"]),
    ).toEqual({ routed: false, reason: "no-channel" });
    expect(resolveRouteKey(decodeFrame("nope"), ["order_book/0"])).toEqual({
      routed: false,
      reason: "no-channel",
    });
  });

  test("an error frame routes to the subscription named by its channel", () => {
    const frame: InboundFrame = decodeObject({
      type: "error",
      code: 30012,
      message: "Failed to subscribe",
      channel: "account_all_assets:1234",
    });
    expect(resolveRouteKey(frame, ["account_all_assets/1234"])).toEqual({
      routed: true,
      key: "account_all_assets/1234",
    });
  });

  test("an error frame with no channel has nowhere to go", () => {
    expect(resolveRouteKey(decodeObject({ code: 23003 }), ["order_book/0"])).toEqual({
      routed: false,
      reason: "no-channel",
    });
  });

  test("index-free channels route by family", () => {
    const frame: InboundFrame = decodeObject({ type: "update/height", channel: "height" });
    expect(resolveRouteKey(frame, ["height"])).toEqual({ routed: true, key: "height" });
    expect(resolveRouteKey(decodeObject({ type: "update/rfq" }), ["rfq"])).toEqual({
      routed: true,
      key: "rfq",
    });
  });

  test("a Set of active keys works as well as any iterable", () => {
    const frame: InboundFrame = decodeObject({
      type: "update/order_book",
      channel: "order_book:0",
      order_book: { begin_nonce: 1 },
    });
    expect(resolveRouteKey(frame, new Set(["order_book/0"]))).toEqual({
      routed: true,
      key: "order_book/0",
    });
  });

  test("a wide account id from the big-int-safe parser still routes", () => {
    const raw =
      '{"type":"update/account_orders","channel":"account_orders:3","account":1234,"nonce":9007199254740993}';
    expect(resolveRouteKey(decodeFrame(raw), ["account_orders/3/1234"])).toEqual({
      routed: true,
      key: "account_orders/3/1234",
    });
  });

  test("never throws, whatever the frame", () => {
    const frames: InboundFrame[] = [
      decodeFrame("{}"),
      decodeFrame("42"),
      decodeObject({ type: "update/x", channel: "x:1", market_id: 1.5 }),
    ];
    for (const frame of frames) {
      expect(() => resolveRouteKey(frame, ["x/1"])).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Error classification                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe("classifyWsError", () => {
  test("the §11 table, code by code", () => {
    const table: ReadonlyArray<readonly [number, WsErrorAction]> = [
      [30003, "treat-as-success"],
      [30009, "throttle"],
      [23000, "throttle"],
      [30010, "reduce-inflight"],
      [23001, "fatal-socket"],
      [23002, "fatal-socket"],
      [23003, "fatal-socket"],
      [21109, "refresh-auth"],
      [21110, "refresh-auth"],
      [21120, "refresh-auth"],
      [30000, "codec-bug"],
      [30001, "codec-bug"],
      [30005, "codec-bug"],
      [30007, "codec-bug"],
    ];
    for (const [code, action] of table) {
      expect(classifyWsError(code)).toBe(action);
    }
  });

  test("30002 is success on an unsubscribe and surfaced anywhere else", () => {
    expect(classifyWsError(30002, { onUnsubscribe: true })).toBe("treat-as-success");
    expect(classifyWsError(30002)).toBe("surface");
    expect(classifyWsError(30002, { onUnsubscribe: false })).toBe("surface");
  });

  test("30012 is an auth signal only on an authed channel", () => {
    expect(classifyWsError(30012, { authed: true })).toBe("refresh-auth");
    expect(classifyWsError(30012)).toBe("surface");
    expect(classifyWsError(30012, { authed: false })).toBe("surface");
  });

  test("30003 stays success regardless of context", () => {
    expect(classifyWsError(30003, { onUnsubscribe: true, authed: true })).toBe("treat-as-success");
  });

  test("unlisted codes surface", () => {
    for (const code of [0, 200, 30004, 30006, 30008, 30011, 23004, 61005, 61006, 20558, 999999]) {
      expect(classifyWsError(code)).toBe("surface");
    }
  });

  test("the two success codes are exactly the ones that make reconnect work", () => {
    // A resubscribe race after a reconnect produces 30003; the teardown race produces 30002.
    expect(classifyWsError(30003)).toBe("treat-as-success");
    expect(classifyWsError(30002, { onUnsubscribe: true })).toBe("treat-as-success");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Upgrade-failure seam                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe("upgrade failure diagnosis", () => {
  test("the probe URL is the same URL over HTTPS", () => {
    expect(upgradeProbeUrl("wss://mainnet.zklighter.elliot.ai/stream")).toBe(
      "https://mainnet.zklighter.elliot.ai/stream",
    );
    expect(upgradeProbeUrl("ws://localhost:8080/stream")).toBe("http://localhost:8080/stream");
    expect(upgradeProbeUrl("https://example.test/stream")).toBe("https://example.test/stream");
  });

  test("the geo-block is recognised and the message surfaced verbatim", () => {
    const body =
      '{"code":20558,"message":"You are accessing Lighter from a restricted jurisdiction. For more information, see the https://lighter.xyz/terms"}';
    const diagnosis = diagnoseUpgradeFailure(400, body);
    expect(diagnosis.code).toBe(20558);
    expect(diagnosis.restricted).toBe(true);
    expect(diagnosis.status).toBe(400);
    expect(diagnosis.message).toContain("restricted jurisdiction");
  });

  test("an HTML interstitial does not throw", () => {
    const diagnosis = diagnoseUpgradeFailure(403, "<html><body>403 Forbidden</body></html>");
    expect(diagnosis.restricted).toBe(false);
    expect(diagnosis.message).toBe("");
    expect(diagnosis.code).toBeUndefined();
  });

  test("a non-20558 error body keeps its code", () => {
    const diagnosis = diagnoseUpgradeFailure(400, '{"code":20001,"message":"invalid param "}');
    expect(diagnosis.code).toBe(20001);
    expect(diagnosis.restricted).toBe(false);
    expect(diagnosis.message).toBe("invalid param ");
  });
});
