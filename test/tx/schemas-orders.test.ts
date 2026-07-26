/**
 * `src/tx/schemas/orders.ts` — the five order-family tables.
 *
 * The spine is `conformance/vectors/tx.json` -> `txHashes`, generated from the Go reference: the
 * fifteen non-grouped order rows and the three grouped ones. Every row is driven through the real
 * `hashTxHex`, so a wrong element order, a missing field, or a mis-declared encoding fails here.
 *
 * The row -> transaction translation **consumes** vector keys and asserts the set is drained, so a
 * row that grows a field this unit does not know about fails rather than silently hashing the old
 * shape. `txInfoJson` is `""` in every row (the oracle does not emit JSON), so the serialisation
 * assertions below are hand-authored goldens from `spec/04-tx-types.md` §7 and §9.2 — review them
 * as protocol, not as fixtures.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { Fp } from "../../src/crypto/field/fp.js";
import { LighterValidationError } from "../../src/errors.js";
import type { TxAttributes } from "../../src/tx/attributes.js";
import { i16, i64, u8, u32 } from "../../src/tx/brands.js";
import { TxType, type TxTypeCode } from "../../src/tx/enums.js";
import { hashTxHex, txHashElements } from "../../src/tx/hash.js";
import {
  CANCEL_ALL_ORDERS_SCHEMA,
  CANCEL_ORDER_SCHEMA,
  CREATE_GROUPED_ORDERS_SCHEMA,
  CREATE_ORDER_SCHEMA,
  MODIFY_ORDER_SCHEMA,
  ORDER_SCHEMAS,
  ORDER_SCHEMA_REGISTRY,
} from "../../src/tx/schemas/orders.js";
import {
  ATTRIBUTES_JSON_KEY,
  type TxLike,
  type TxSchema,
  requireTxSchema,
} from "../../src/tx/schema.js";
import { serializeTx } from "../../src/tx/serialize.js";
import type {
  CancelAllOrdersTx,
  CancelOrderTx,
  CreateGroupedOrdersTx,
  CreateOrderTx,
  ModifyOrderTx,
  OrderInfo,
  OrderTx,
} from "../../src/tx/types/orders.js";

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
  readonly messageHashLeHex: string;
}

const vectorsUrl = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly txHashes: readonly TxHashRow[];
};

const CHAIN_ID: number = vectors.chainId;

/** The vector name prefixes this unit is responsible for. */
const ORDER_PREFIXES: readonly string[] = [
  "create_order/",
  "cancel_order/",
  "cancel_all_orders/",
  "modify_order/",
  "create_grouped_orders/",
];

/**
 * A one-shot reader over a row's `fields` map that tracks what was consumed.
 *
 * The point is {@link Consumer.drained}: if the oracle starts emitting a key this unit does not
 * read, the row is not fully handled and the test says so, instead of hashing a transaction built
 * from the subset that happens to be understood.
 */
interface Consumer {
  raw(key: string): string;
  big(key: string): bigint;
  num(key: string): number;
  drained(rowName: string): void;
}

function consumer(fields: Readonly<Record<string, string>>): Consumer {
  const remaining: Set<string> = new Set<string>(Object.keys(fields));
  const raw = (key: string): string => {
    const value: string | undefined = fields[key];
    if (value === undefined) throw new Error(`vector row is missing field ${key}`);
    remaining.delete(key);
    return value;
  };
  return {
    raw,
    big: (key: string): bigint => BigInt(raw(key)),
    num: (key: string): number => Number(raw(key)),
    drained: (rowName: string): void => {
      if (remaining.size > 0) {
        throw new Error(
          `vector row ${rowName} has fields this unit does not handle: ${[...remaining].sort().join(", ")}`,
        );
      }
    },
  };
}

/**
 * The row's `txType` as a `TxTypeCode`.
 *
 * The vector file is JSON, so the field is a plain `number`. `requireTxSchema` is the check that
 * matters — an unregistered code throws `SCHEMA_TX_TYPE_UNKNOWN` — so widening here loses nothing.
 */
function txTypeOf(row: TxHashRow): TxTypeCode {
  return row.txType as TxTypeCode;
}

/** Vector attribute maps are `{"1": 4242}`; `TxAttributes` is keyed by the same numbers. */
function attributesOf(row: TxHashRow): TxAttributes {
  return row.attributes as unknown as TxAttributes;
}

/** One `OrderInfo` leg, read from the flattened `Order<i>.<Field>` keys of a code-28 row. */
function legOf(f: Consumer, i: number): OrderInfo {
  const p = (key: string): string => `Order${String(i)}.${key}`;
  return {
    marketIndex: i16(f.num(p("MarketIndex"))),
    clientOrderIndex: i64(f.big(p("ClientOrderIndex"))),
    baseAmount: i64(f.big(p("BaseAmount"))),
    price: u32(f.num(p("Price"))),
    isAsk: u8(f.num(p("IsAsk"))),
    type: u8(f.num(p("Type"))),
    timeInForce: u8(f.num(p("TimeInForce"))),
    reduceOnly: u8(f.num(p("ReduceOnly"))),
    triggerPrice: u32(f.num(p("TriggerPrice"))),
    orderExpiry: i64(f.big(p("OrderExpiry"))),
  };
}

/**
 * Build the transaction a row describes, then assert the row carried nothing else.
 *
 * Deliberately mints every value through the branded constructors: the vectors then double as a
 * width check on `brands.ts` — `ApiKeyIndex = 254` and `AccountIndex = -1` both go through `u8` and
 * `i64` rather than being cast past them.
 */
function txOf(row: TxHashRow): OrderTx {
  const f: Consumer = consumer(row.fields);
  const attributes: TxAttributes = attributesOf(row);
  let tx: OrderTx;
  switch (row.txType) {
    case TxType.L2CreateOrder: {
      const created: CreateOrderTx = {
        type: TxType.L2CreateOrder,
        accountIndex: i64(f.big("AccountIndex")),
        apiKeyIndex: u8(f.num("ApiKeyIndex")),
        marketIndex: i16(f.num("MarketIndex")),
        clientOrderIndex: i64(f.big("ClientOrderIndex")),
        baseAmount: i64(f.big("BaseAmount")),
        price: u32(f.num("Price")),
        isAsk: u8(f.num("IsAsk")),
        orderType: u8(f.num("Type")),
        timeInForce: u8(f.num("TimeInForce")),
        reduceOnly: u8(f.num("ReduceOnly")),
        triggerPrice: u32(f.num("TriggerPrice")),
        orderExpiry: i64(f.big("OrderExpiry")),
        expiredAt: i64(f.big("ExpiredAt")),
        nonce: i64(f.big("Nonce")),
        attributes,
      };
      tx = created;
      break;
    }
    case TxType.L2CancelOrder: {
      const cancelled: CancelOrderTx = {
        type: TxType.L2CancelOrder,
        accountIndex: i64(f.big("AccountIndex")),
        apiKeyIndex: u8(f.num("ApiKeyIndex")),
        marketIndex: i16(f.num("MarketIndex")),
        index: i64(f.big("Index")),
        expiredAt: i64(f.big("ExpiredAt")),
        nonce: i64(f.big("Nonce")),
        attributes,
      };
      tx = cancelled;
      break;
    }
    case TxType.L2CancelAllOrders: {
      const cancelAll: CancelAllOrdersTx = {
        type: TxType.L2CancelAllOrders,
        accountIndex: i64(f.big("AccountIndex")),
        apiKeyIndex: u8(f.num("ApiKeyIndex")),
        timeInForce: u8(f.num("TimeInForce")),
        time: i64(f.big("Time")),
        expiredAt: i64(f.big("ExpiredAt")),
        nonce: i64(f.big("Nonce")),
        attributes,
      };
      tx = cancelAll;
      break;
    }
    case TxType.L2ModifyOrder: {
      const modified: ModifyOrderTx = {
        type: TxType.L2ModifyOrder,
        accountIndex: i64(f.big("AccountIndex")),
        apiKeyIndex: u8(f.num("ApiKeyIndex")),
        marketIndex: i16(f.num("MarketIndex")),
        index: i64(f.big("Index")),
        baseAmount: i64(f.big("BaseAmount")),
        price: u32(f.num("Price")),
        triggerPrice: u32(f.num("TriggerPrice")),
        expiredAt: i64(f.big("ExpiredAt")),
        nonce: i64(f.big("Nonce")),
        attributes,
      };
      tx = modified;
      break;
    }
    case TxType.L2CreateGroupedOrders: {
      const count: number = f.num("OrderCount");
      const legs: OrderInfo[] = [];
      for (let i = 0; i < count; i += 1) legs.push(legOf(f, i));
      const grouped: CreateGroupedOrdersTx = {
        type: TxType.L2CreateGroupedOrders,
        accountIndex: i64(f.big("AccountIndex")),
        apiKeyIndex: u8(f.num("ApiKeyIndex")),
        groupingType: u8(f.num("GroupingType")),
        orders: legs,
        expiredAt: i64(f.big("ExpiredAt")),
        nonce: i64(f.big("Nonce")),
        attributes,
      };
      tx = grouped;
      break;
    }
    default:
      throw new Error(`row ${row.name} has tx type ${String(row.txType)}, which this unit does not own`);
  }
  f.drained(row.name);
  return tx;
}

/** Every row whose *name* says it is an order transaction — not every row whose type is known. */
const orderRows: readonly TxHashRow[] = vectors.txHashes.filter((r) =>
  ORDER_PREFIXES.some((p) => r.name.startsWith(p)),
);

function rowNamed(name: string): TxHashRow {
  const row: TxHashRow | undefined = orderRows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`vector row ${name} is missing`);
  return row;
}

function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but nothing was thrown");
}

describe("the registry", () => {
  test("covers exactly the five order codes", () => {
    expect([...ORDER_SCHEMA_REGISTRY.keys()].sort((a, b) => a - b)).toEqual([14, 15, 16, 17, 28]);
  });

  test("the list and the registry agree", () => {
    expect(ORDER_SCHEMAS).toHaveLength(5);
    for (const schema of ORDER_SCHEMAS) {
      expect(requireTxSchema(ORDER_SCHEMA_REGISTRY, schema.txType)).toBe(schema);
    }
  });

  test("no schema declares L2TxAttributes as a field — the serialiser appends it", () => {
    for (const schema of ORDER_SCHEMAS) {
      expect(schema.fields.some((f) => f.json === ATTRIBUTES_JSON_KEY)).toBe(false);
    }
  });

  test("Sig is a JSON field and is never hashed", () => {
    for (const schema of ORDER_SCHEMAS) {
      expect(schema.fields.some((f) => f.json === "Sig")).toBe(true);
      expect(schema.hashOrder).not.toContain("sig");
    }
  });

  test("Nonce and ExpiredAt are JSON fields but not in hashOrder — the hasher emits them", () => {
    for (const schema of ORDER_SCHEMAS) {
      expect(schema.fields.map((f) => f.json)).toContain("Nonce");
      expect(schema.fields.map((f) => f.json)).toContain("ExpiredAt");
      expect(schema.hashOrder).not.toContain("nonce");
      expect(schema.hashOrder).not.toContain("expiredAt");
    }
  });
});

describe("hashTxHex against conformance vectors", () => {
  test("all eighteen order rows are present and none is unaccounted for", () => {
    expect(orderRows.map((r) => r.name)).toEqual([
      "create_order/limit_gtt_buy",
      "create_order/market_ioc_sell",
      "create_order/stop_loss_limit_reduce_only",
      "create_order/spot_post_only",
      "create_order/with_integrator_attributes",
      "create_order/with_skip_nonce",
      "cancel_order/0",
      "cancel_order/1",
      "cancel_order/2",
      "cancel_all_orders/immediate",
      "cancel_all_orders/immediate_single_market",
      "cancel_all_orders/scheduled",
      "cancel_all_orders/negative_account_index",
      "cancel_all_orders/max_indices",
      "modify_order/basic",
      "create_grouped_orders/oto",
      "create_grouped_orders/oco",
      "create_grouped_orders/otoco",
    ]);
  });

  for (const row of orderRows) {
    test(row.name, () => {
      // Fails loudly if a row of an order family carries a type with no schema here.
      const schema: TxSchema = requireTxSchema(ORDER_SCHEMA_REGISTRY, txTypeOf(row));
      const tx: OrderTx = txOf(row);
      expect(tx.type as number).toBe(row.txType);
      expect(hashTxHex(schema, tx as TxLike, CHAIN_ID)).toBe(row.messageHashLeHex);
    });
  }

  test("a row carrying a field this unit does not read fails the suite", () => {
    // Proves the guard above is live rather than vacuous: if `tx.json` grows a key for an order
    // type — a new order field, a fourth grouped leg — the row is not silently hashed in its old
    // shape. Simulated here by adding the key, since the vector file must never be edited.
    const row: TxHashRow = rowNamed("cancel_order/0");
    const grown: TxHashRow = { ...row, fields: { ...row.fields, SelfTradeBehavior: "1" } };
    expect(() => txOf(grown)).toThrow(/does not handle: SelfTradeBehavior/);
  });

  test("the attribute-carrying rows really do exercise the non-empty aggregate", () => {
    // Otherwise every row would pass with an aggregation that ignored attributes entirely.
    for (const name of ["create_order/with_integrator_attributes", "create_order/with_skip_nonce"]) {
      const row: TxHashRow = rowNamed(name);
      expect(Object.keys(row.attributes).length).toBeGreaterThan(0);
      const bare: TxLike = { ...(txOf(row) as TxLike), attributes: undefined };
      expect(hashTxHex(CREATE_ORDER_SCHEMA, bare, CHAIN_ID)).not.toBe(row.messageHashLeHex);
    }
  });
});

describe("element counts and positions", () => {
  const elementsFor = (name: string): readonly bigint[] => {
    const row: TxHashRow = rowNamed(name);
    return txHashElements(
      requireTxSchema(ORDER_SCHEMA_REGISTRY, txTypeOf(row)),
      txOf(row) as TxLike,
      CHAIN_ID,
    );
  };

  test("L2CreateOrder is exactly 16 elements — two full sponge blocks", () => {
    expect(elementsFor("create_order/limit_gtt_buy")).toHaveLength(16);
  });

  test("L2CancelOrder and L2CancelAllOrders are 8", () => {
    expect(elementsFor("cancel_order/0")).toHaveLength(8);
    expect(elementsFor("cancel_all_orders/immediate")).toHaveLength(8);
  });

  test("L2ModifyOrder is 11 — no IsAsk, no TimeInForce, no OrderExpiry", () => {
    expect(elementsFor("modify_order/basic")).toHaveLength(11);
    expect(MODIFY_ORDER_SCHEMA.hashOrder).toEqual([
      "accountIndex",
      "apiKeyIndex",
      "marketIndex",
      "index",
      "baseAmount",
      "price",
      "triggerPrice",
    ]);
  });

  test("L2CreateGroupedOrders is 11 — the four folded elements, not the legs", () => {
    expect(elementsFor("create_grouped_orders/otoco")).toHaveLength(11);
  });

  test("positions 4 and 5 are the account index and the api-key index for every type", () => {
    for (const name of [
      "create_order/limit_gtt_buy",
      "cancel_order/0",
      "cancel_all_orders/max_indices",
      "modify_order/basic",
      "create_grouped_orders/oco",
    ]) {
      const row: TxHashRow = rowNamed(name);
      const elements: readonly bigint[] = elementsFor(name);
      expect(elements[4]).toBe(BigInt(row.fields["AccountIndex"] as string));
      expect(elements[5]).toBe(BigInt(row.fields["ApiKeyIndex"] as string));
    }
  });

  test("the ten order elements of code 14 sit at positions 6..15, in §7.8 order", () => {
    const row: TxHashRow = rowNamed("create_order/stop_loss_limit_reduce_only");
    const f: Readonly<Record<string, string>> = row.fields;
    expect(elementsFor(row.name).slice(6)).toEqual([
      BigInt(f["MarketIndex"] as string),
      BigInt(f["ClientOrderIndex"] as string),
      BigInt(f["BaseAmount"] as string),
      BigInt(f["Price"] as string),
      BigInt(f["IsAsk"] as string),
      BigInt(f["Type"] as string),
      BigInt(f["TimeInForce"] as string),
      BigInt(f["ReduceOnly"] as string),
      BigInt(f["TriggerPrice"] as string),
      BigInt(f["OrderExpiry"] as string),
    ]);
  });

  test("BaseAmount and OrderExpiry are single elements even past 2^32", () => {
    // `docs/protocol-notes.md` §3.2 — no order field is split, so a value above 2^32 must appear
    // once, whole. Splitting by magnitude would give 17 elements and two halves here.
    const row: TxHashRow = rowNamed("create_order/limit_gtt_buy");
    const tx: CreateOrderTx = {
      ...(txOf(row) as CreateOrderTx),
      baseAmount: i64(281474976710655n),
      orderExpiry: i64(1893456000000n),
    };
    const elements: readonly bigint[] = txHashElements(CREATE_ORDER_SCHEMA, tx as TxLike, CHAIN_ID);
    expect(elements).toHaveLength(16);
    expect(elements[8]).toBe(281474976710655n);
    expect(elements[15]).toBe(1893456000000n);
  });

  test("a negative market index sign-extends to 4294967294", () => {
    // `docs/protocol-notes.md` §3.1: int16 -1 and int64 -1 reach the same 64-bit word.
    const row: TxHashRow = rowNamed("cancel_order/0");
    const tx: CancelOrderTx = { ...(txOf(row) as CancelOrderTx), marketIndex: i16(-1) };
    expect(txHashElements(CANCEL_ORDER_SCHEMA, tx as TxLike, CHAIN_ID)[6]).toBe(4294967294n as Fp);
  });

  test("cancel-all accepts the 255 api-key sentinel as an ordinary element", () => {
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate");
    const tx: CancelAllOrdersTx = { ...(txOf(row) as CancelAllOrdersTx), apiKeyIndex: u8(255) };
    expect(txHashElements(CANCEL_ALL_ORDERS_SCHEMA, tx as TxLike, CHAIN_ID)[5]).toBe(255n as Fp);
  });
});

describe("serializeTx", () => {
  /** 80 zero bytes. Standard-alphabet base64 with `=` padding: 107 'A's and one '='. */
  const SIG_B64: string = `${"A".repeat(107)}=`;
  const sig: Uint8Array = new Uint8Array(80);

  test("L2CreateOrder flattens the OrderInfo fields into the parent, in §7.8 key order", () => {
    const tx: CreateOrderTx = {
      ...(txOf(rowNamed("create_order/limit_gtt_buy")) as CreateOrderTx),
      sig,
    };
    expect(serializeTx(CREATE_ORDER_SCHEMA, tx as TxLike)).toBe(
      `{"AccountIndex":1,"ApiKeyIndex":0,"MarketIndex":1,"ClientOrderIndex":100,` +
        `"BaseAmount":1000000,"Price":250000,"IsAsk":0,"Type":0,"TimeInForce":1,` +
        `"ReduceOnly":0,"TriggerPrice":0,"OrderExpiry":1893456000000,` +
        `"ExpiredAt":1893456000000,"Nonce":42,"Sig":"${SIG_B64}","L2TxAttributes":null}`,
    );
  });

  test("attributes are emitted last, with ascending decimal-string keys", () => {
    const tx: CreateOrderTx = {
      ...(txOf(rowNamed("create_order/with_integrator_attributes")) as CreateOrderTx),
      sig,
    };
    expect(serializeTx(CREATE_ORDER_SCHEMA, tx as TxLike)).toContain(
      `"L2TxAttributes":{"1":4242,"2":250,"3":100}}`,
    );
  });

  test("L2CreateGroupedOrders emits Orders as an array of objects in §7.7 key order", () => {
    const tx: CreateGroupedOrdersTx = {
      ...(txOf(rowNamed("create_grouped_orders/oco")) as CreateGroupedOrdersTx),
      sig,
    };
    expect(serializeTx(CREATE_GROUPED_ORDERS_SCHEMA, tx as TxLike)).toBe(
      `{"AccountIndex":1,"ApiKeyIndex":0,"GroupingType":2,"Orders":[` +
        `{"MarketIndex":1,"ClientOrderIndex":2003,"BaseAmount":0,"Price":4000,"IsAsk":1,` +
        `"Type":2,"TimeInForce":0,"ReduceOnly":1,"TriggerPrice":4100,"OrderExpiry":1893456000000},` +
        `{"MarketIndex":1,"ClientOrderIndex":2004,"BaseAmount":0,"Price":6000,"IsAsk":1,` +
        `"Type":4,"TimeInForce":0,"ReduceOnly":1,"TriggerPrice":5900,"OrderExpiry":1893456000000}` +
        `],"ExpiredAt":1893456000000,"Nonce":32,"Sig":"${SIG_B64}","L2TxAttributes":null}`,
    );
  });

  test("L2CancelOrder, L2CancelAllOrders and L2ModifyOrder emit their §7 key order", () => {
    const cancel: CancelOrderTx = { ...(txOf(rowNamed("cancel_order/1")) as CancelOrderTx), sig };
    expect(serializeTx(CANCEL_ORDER_SCHEMA, cancel as TxLike)).toBe(
      `{"AccountIndex":1,"ApiKeyIndex":0,"MarketIndex":1,"Index":281474976710655,` +
        `"ExpiredAt":1893456000000,"Nonce":8,"Sig":"${SIG_B64}","L2TxAttributes":null}`,
    );

    const cancelAll: CancelAllOrdersTx = {
      ...(txOf(rowNamed("cancel_all_orders/scheduled")) as CancelAllOrdersTx),
      sig,
    };
    expect(serializeTx(CANCEL_ALL_ORDERS_SCHEMA, cancelAll as TxLike)).toBe(
      `{"AccountIndex":1,"ApiKeyIndex":0,"TimeInForce":1,"Time":1893456000000,` +
        `"ExpiredAt":1893456000000,"Nonce":31,"Sig":"${SIG_B64}","L2TxAttributes":null}`,
    );

    const modify: ModifyOrderTx = { ...(txOf(rowNamed("modify_order/basic")) as ModifyOrderTx), sig };
    expect(serializeTx(MODIFY_ORDER_SCHEMA, modify as TxLike)).toBe(
      `{"AccountIndex":1,"ApiKeyIndex":0,"MarketIndex":1,"Index":12345,"BaseAmount":5000,` +
        `"Price":777777,"TriggerPrice":0,"ExpiredAt":1893456000000,"Nonce":13,` +
        `"Sig":"${SIG_B64}","L2TxAttributes":null}`,
    );
  });

  test("a large Index survives serialisation exactly — never through JSON.parse", () => {
    // 1152921504606846975 is MaxOrderIndex; a round trip through a JS number gives ...847000.
    const cancel: CancelOrderTx = {
      ...(txOf(rowNamed("cancel_order/2")) as CancelOrderTx),
      index: i64(1152921504606846975n),
      sig,
    };
    expect(serializeTx(CANCEL_ORDER_SCHEMA, cancel as TxLike)).toContain(
      `"Index":1152921504606846975,`,
    );
  });

  test("an unsigned transaction cannot be serialised — Sig is declared, so it is required", () => {
    const tx: OrderTx = txOf(rowNamed("cancel_order/0"));
    expect(thrown(() => serializeTx(CANCEL_ORDER_SCHEMA, tx as TxLike)).code).toBe("FIELD_MISSING");
  });

  test("a non-array Orders value is rejected by the custom encoding", () => {
    const broken: TxLike = {
      ...(txOf(rowNamed("create_grouped_orders/oto")) as TxLike),
      orders: "not an array",
      sig,
    } as unknown as TxLike;
    expect(thrown(() => serializeTx(CREATE_GROUPED_ORDERS_SCHEMA, broken)).code).toBe(
      "FIELD_TYPE_INVALID",
    );
  });
});
