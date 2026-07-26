import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import {
  DEFAULT_BIGINT_FIELDS,
  parseFrameJson,
  stableStringify,
} from "../../src/util/json.js";

/** Minimal ambient for the fixture loader. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

/** The value `JSON.parse` cannot represent: 2^53 + 1 round-trips to 2^53. */
const WIDE: string = "9007199254740993";
/** A real-shaped order index, comfortably past the safe-integer range. */
const WIDER: string = "1234567890123456789";

describe("DEFAULT_BIGINT_FIELDS", () => {
  test("carries every field named in the issue, including the four with no _str twin", () => {
    for (const name of [
      "nonce",
      "begin_nonce",
      "offset",
      "transaction_time",
      "last_updated_at",
      "trade_id",
      "ask_id",
      "bid_id",
      "ask_client_id",
      "bid_client_id",
      "order_index",
      "client_order_index",
    ]) {
      expect(DEFAULT_BIGINT_FIELDS.has(name)).toBe(true);
    }
    expect(DEFAULT_BIGINT_FIELDS.size).toBe(12);
  });

  test("the hazard it exists for is real", () => {
    // Documents the loss this module prevents; if this ever fails, the engine changed.
    expect(String(JSON.parse(`{"n":${WIDE}}`).n)).toBe("9007199254740992");
  });
});

describe("parseFrameJson", () => {
  test("quotes a listed key's wide integer so no precision is lost", () => {
    const parsed = parseFrameJson(`{"order_index":${WIDE}}`) as { order_index: unknown };
    expect(parsed.order_index).toBe(WIDE);
    expect(BigInt(parsed.order_index as string)).toBe(BigInt(WIDE));
  });

  test("leaves an unlisted key's equally long value byte-identical", () => {
    const text: string = `{"order_index":${WIDER},"some_other_id":${WIDER}}`;
    const parsed = parseFrameJson(text) as { order_index: unknown; some_other_id: unknown };
    expect(parsed.order_index).toBe(WIDER);
    expect(typeof parsed.some_other_id).toBe("number");
    expect(parsed.some_other_id).toBe(JSON.parse(text).some_other_id);
  });

  test("leaves digit runs inside string values alone", () => {
    const text: string =
      `{"memo":"ref ${WIDER} paid","url":"https://x/y?id=${WIDER}",` +
      `"trade_id_str":"${WIDER}","trade_id":${WIDER}}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["memo"]).toBe(`ref ${WIDER} paid`);
    expect(parsed["url"]).toBe(`https://x/y?id=${WIDER}`);
    expect(parsed["trade_id_str"]).toBe(WIDER);
    expect(parsed["trade_id"]).toBe(WIDER);
  });

  test("a string value that happens to look like a key is not treated as one", () => {
    // "order_index" appears as a *value* here; the number after it must stay a number.
    const text: string = `{"field":"order_index","other":${WIDER}}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["field"]).toBe("order_index");
    expect(typeof parsed["other"]).toBe("number");
  });

  test("an array element is not a key, even when the array holds field names", () => {
    const text: string = `{"keys":["nonce","offset"],"nonce":${WIDER}}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["keys"]).toEqual(["nonce", "offset"]);
    expect(parsed["nonce"]).toBe(WIDER);
  });

  test("a frame with no wide integer parses identically to JSON.parse", () => {
    const text: string =
      '{"type":"update/order_book","channel":"order_book:1",' +
      '"order_book":{"offset":123456,"bids":[{"price":"2500.10","size":"1.5"}]}}';
    expect(parseFrameJson(text)).toEqual(JSON.parse(text));
  });

  test("does not rewrite short integers, fractions or exponents", () => {
    const text: string = `{"nonce":42,"offset":1.2345678901234567,"trade_id":1e17}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["nonce"]).toBe(42);
    expect(typeof parsed["offset"]).toBe("number");
    expect(typeof parsed["trade_id"]).toBe("number");
  });

  test("handles whitespace and negative values around the colon", () => {
    const text: string = `{\n  "nonce"  :  -${WIDER}\n}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["nonce"]).toBe(`-${WIDER}`);
  });

  test("rewrites every occurrence, at any depth, including inside arrays of objects", () => {
    const text: string =
      `{"trades":[{"trade_id":${WIDER},"ask_id":${WIDE}},{"trade_id":${WIDE}}],` +
      `"last_updated_at":${WIDER}}`;
    const parsed = parseFrameJson(text) as {
      trades: readonly Record<string, unknown>[];
      last_updated_at: unknown;
    };
    expect(parsed.trades[0]?.["trade_id"]).toBe(WIDER);
    expect(parsed.trades[0]?.["ask_id"]).toBe(WIDE);
    expect(parsed.trades[1]?.["trade_id"]).toBe(WIDE);
    expect(parsed.last_updated_at).toBe(WIDER);
  });

  test("honours a caller-supplied field set", () => {
    const text: string = `{"nonce":${WIDER},"mine":${WIDER}}`;
    const parsed = parseFrameJson(text, new Set(["mine"])) as Record<string, unknown>;
    expect(parsed["mine"]).toBe(WIDER);
    expect(typeof parsed["nonce"]).toBe("number");
  });

  test("survives escapes in string values and in key names", () => {
    const text: string = `{"note":"a \\" ${WIDER} \\\\","nonce":${WIDER}}`;
    const parsed = parseFrameJson(text) as Record<string, unknown>;
    expect(parsed["note"]).toBe(`a " ${WIDER} \\`);
    expect(parsed["nonce"]).toBe(WIDER);
  });

  test("a real /recentTrades body: the 50-digit tx_hash string is untouched", async () => {
    // Real captured response. `tx_hash` is a string holding a 50-digit run and `transaction_time`
    // is a listed 16-digit integer — the exact pair a global digit-run replacement corrupts.
    const path: string = new URL("../fixtures/rest/responses.json", import.meta.url).pathname;
    const fixture = JSON.parse(await Bun.file(path).text()) as {
      cases: Record<string, { body: unknown }>;
    };
    const text: string = JSON.stringify(fixture.cases["recentTrades"]?.body);
    const naive = JSON.parse(text) as { trades: readonly Record<string, unknown>[] };
    const parsed = parseFrameJson(text) as { trades: readonly Record<string, unknown>[] };

    const before = naive.trades[0] as Record<string, unknown>;
    const after = parsed.trades[0] as Record<string, unknown>;
    expect(after["tx_hash"]).toBe(before["tx_hash"]);
    expect(String(after["tx_hash"])).toMatch(/^[0-9a-f]{80}$/);
    expect(after["trade_id_str"]).toBe(before["trade_id_str"]);
    expect(after["price"]).toBe(before["price"]);
    expect(after["market_id"]).toBe(before["market_id"]);
    expect(after["transaction_time"]).toBe(String(before["transaction_time"]));
    expect(typeof after["transaction_time"]).toBe("string");
    // Listed ids that were already safe integers keep their numeric form only when short.
    expect(String(after["ask_id"])).toBe(String(before["ask_id"]));
  });

  test("propagates a syntax error rather than swallowing it", () => {
    expect(() => parseFrameJson(`{"nonce":${WIDER},}`)).toThrow();
    expect(() => parseFrameJson("not json")).toThrow();
  });

  test("parses non-object top levels", () => {
    expect(parseFrameJson("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseFrameJson('"plain"')).toBe("plain");
    expect(parseFrameJson("null")).toBe(null);
  });
});

describe("stableStringify", () => {
  test("sorts object keys at every depth", () => {
    expect(stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("emits bigint as an unquoted decimal literal", () => {
    expect(stableStringify({ nonce: 12345678901234567890n })).toBe('{"nonce":12345678901234567890}');
    expect(stableStringify(-1n)).toBe("-1");
  });

  test("handles primitives and escaping", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify("a\"b\n")).toBe('"a\\"b\\n"');
    expect(stableStringify(1.5)).toBe("1.5");
    expect(stableStringify({})).toBe("{}");
    expect(stableStringify([])).toBe("[]");
  });

  test("follows JSON.stringify for undefined inside a container", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
  });

  test("throws on a cycle", () => {
    const node: Record<string, unknown> = { name: "a" };
    node["self"] = node;
    expect(() => stableStringify(node)).toThrow(LighterValidationError);

    const parent: Record<string, unknown> = {};
    const child: Record<string, unknown> = { parent };
    parent["child"] = child;
    expect(() => stableStringify(parent)).toThrow(LighterValidationError);
  });

  test("allows a repeated (non-cyclic) reference", () => {
    const shared: Record<string, unknown> = { v: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  test("throws on functions, symbols, top-level undefined and non-finite numbers", () => {
    expect(() => stableStringify(() => 1)).toThrow(LighterValidationError);
    expect(() => stableStringify(Symbol("x"))).toThrow(LighterValidationError);
    expect(() => stableStringify(undefined)).toThrow(LighterValidationError);
    expect(() => stableStringify(Number.NaN)).toThrow(LighterValidationError);
    expect(() => stableStringify(Number.POSITIVE_INFINITY)).toThrow(LighterValidationError);
  });

  test("throws on a Uint8Array rather than emitting an index-keyed object", () => {
    expect(() => stableStringify(new Uint8Array([1, 2, 3]))).toThrow(LighterValidationError);
    expect(() => stableStringify({ sig: new Uint8Array([1]) })).toThrow(LighterValidationError);
    try {
      stableStringify(new Uint8Array(1));
      throw new Error("expected a throw");
    } catch (e: unknown) {
      expect((e as LighterValidationError).message).toContain("Uint8Array");
    }
  });

  test("throws on Map, Set and Date instead of silently emitting {}", () => {
    expect(() => stableStringify(new Map())).toThrow(LighterValidationError);
    expect(() => stableStringify(new Set())).toThrow(LighterValidationError);
    expect(() => stableStringify(new Date(0))).toThrow(LighterValidationError);
  });

  test("is not the tx_info serializer — it sorts, and the wire order is schema order", () => {
    // A guard against anyone wiring this onto the signing path: the sorted output is not the
    // schema-ordered byte string `src/tx/serialize.ts` must produce.
    expect(stableStringify({ Sig: "b", AccountIndex: 1 })).toBe('{"AccountIndex":1,"Sig":"b"}');
  });
});
