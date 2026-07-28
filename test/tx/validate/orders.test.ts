/**
 * `src/tx/validate/orders.ts` — validation for the four non-grouped order transactions.
 *
 * Two things are under test and only one of them is "does a bad input throw":
 *
 * 1. **Identity.** Every rule in `spec/04-tx-types.md` §7.8–§7.11 has a case that trips it and
 *    asserts the exact §12 code, because callers branch on `code`.
 * 2. **Order.** Several cases break two rules at once and assert that the *earlier* rule wins. The
 *    reference returns on the first violated predicate, so check order is part of the interop
 *    surface; a validator with every rule present but in the wrong sequence reports the wrong error
 *    and passes a naive test suite.
 *
 * The clean-input spine is `conformance/vectors/tx.json` → `txHashes`. The oracle calls `Validate()`
 * on every row before emitting it, so **every** order-family row must validate without throwing. A
 * false rejection there is a silent regression that would only surface as a rejected transaction.
 *
 * Values in the vector `fields` map are decimal strings and are parsed with `BigInt`, never
 * `Number` — `Index: "281474976710656"` and `MaxOrderIndex` are past the safe-integer range.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import type { TxAttributes } from "../../../src/tx/attributes.js";
import type { I16, I64, U8, U32 } from "../../../src/tx/brands.js";
import { i16, i64, u8, u32 } from "../../../src/tx/brands.js";
import {
  MAX_ACCOUNT_INDEX,
  MAX_CLIENT_ORDER_INDEX,
  MAX_ORDER_BASE_AMOUNT,
  MAX_ORDER_EXPIRY,
  MAX_ORDER_INDEX,
  MAX_TIMESTAMP,
} from "../../../src/tx/constants.js";
import { TxType } from "../../../src/tx/enums.js";
import type {
  CancelAllOrdersTx,
  CancelOrderTx,
  CreateOrderTx,
  ModifyOrderTx,
  OrderInfo,
} from "../../../src/tx/types/orders.js";
import {
  marketKind,
  validateCancelAllOrders,
  validateCancelOrder,
  validateCreateOrder,
  validateModifyOrder,
  validateOrderCore,
  validateOrderTypeMatrix,
  validateTriggerPriceRange,
} from "../../../src/tx/validate/orders.js";

/* -------------------------------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------------------------------- */

interface TxRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
}

const vectorsUrl = new URL("../../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly txHashes: readonly TxRow[];
};

const rowsByName: ReadonlyMap<string, TxRow> = new Map(vectors.txHashes.map((r) => [r.name, r]));

function row(name: string): TxRow {
  const found: TxRow | undefined = rowsByName.get(name);
  if (found === undefined) throw new Error(`vector row not found: ${name}`);
  return found;
}

/** Read a decimal-string field. `BigInt` does the parsing; nothing goes through `Number` first. */
function big(r: TxRow, key: string): bigint {
  const raw: string | undefined = r.fields[key];
  if (raw === undefined) throw new Error(`${r.name}: missing field ${key}`);
  return BigInt(raw);
}

/**
 * Read a field that the protocol declares 32 bits or narrower.
 *
 * Still parsed with `BigInt`; the `Number` conversion only narrows a value already proven exact,
 * and asserts as much rather than trusting the vector.
 */
function small(r: TxRow, key: string): number {
  const wide: bigint = big(r, key);
  const narrow: number = Number(wide);
  if (BigInt(narrow) !== wide) throw new Error(`${r.name}: ${key} is not exact as a number`);
  return narrow;
}

/** The vector's attribute map, whose JSON keys are strings and whose runtime shape is `TxAttributes`. */
function attributesOf(r: TxRow): TxAttributes | undefined {
  return Object.keys(r.attributes).length === 0 ? undefined : (r.attributes as TxAttributes);
}

function createFromVector(name: string): CreateOrderTx {
  const r: TxRow = row(name);
  const attrs: TxAttributes | undefined = attributesOf(r);
  return {
    type: TxType.L2CreateOrder,
    accountIndex: i64(big(r, "AccountIndex")),
    apiKeyIndex: u8(small(r, "ApiKeyIndex")),
    marketIndex: i16(small(r, "MarketIndex")),
    clientOrderIndex: i64(big(r, "ClientOrderIndex")),
    baseAmount: i64(big(r, "BaseAmount")),
    price: u32(small(r, "Price")),
    isAsk: u8(small(r, "IsAsk")),
    orderType: u8(small(r, "Type")),
    timeInForce: u8(small(r, "TimeInForce")),
    reduceOnly: u8(small(r, "ReduceOnly")),
    triggerPrice: u32(small(r, "TriggerPrice")),
    orderExpiry: i64(big(r, "OrderExpiry")),
    nonce: i64(big(r, "Nonce")),
    expiredAt: i64(big(r, "ExpiredAt")),
    ...(attrs === undefined ? {} : { attributes: attrs }),
  };
}

function cancelFromVector(name: string): CancelOrderTx {
  const r: TxRow = row(name);
  const attrs: TxAttributes | undefined = attributesOf(r);
  return {
    type: TxType.L2CancelOrder,
    accountIndex: i64(big(r, "AccountIndex")),
    apiKeyIndex: u8(small(r, "ApiKeyIndex")),
    marketIndex: i16(small(r, "MarketIndex")),
    index: i64(big(r, "Index")),
    nonce: i64(big(r, "Nonce")),
    expiredAt: i64(big(r, "ExpiredAt")),
    ...(attrs === undefined ? {} : { attributes: attrs }),
  };
}

function cancelAllFromVector(name: string): CancelAllOrdersTx {
  const r: TxRow = row(name);
  const attrs: TxAttributes | undefined = attributesOf(r);
  return {
    type: TxType.L2CancelAllOrders,
    accountIndex: i64(big(r, "AccountIndex")),
    apiKeyIndex: u8(small(r, "ApiKeyIndex")),
    timeInForce: u8(small(r, "TimeInForce")),
    time: i64(big(r, "Time")),
    nonce: i64(big(r, "Nonce")),
    expiredAt: i64(big(r, "ExpiredAt")),
    ...(attrs === undefined ? {} : { attributes: attrs }),
  };
}

function modifyFromVector(name: string): ModifyOrderTx {
  const r: TxRow = row(name);
  const attrs: TxAttributes | undefined = attributesOf(r);
  return {
    type: TxType.L2ModifyOrder,
    accountIndex: i64(big(r, "AccountIndex")),
    apiKeyIndex: u8(small(r, "ApiKeyIndex")),
    marketIndex: i16(small(r, "MarketIndex")),
    index: i64(big(r, "Index")),
    baseAmount: i64(big(r, "BaseAmount")),
    price: u32(small(r, "Price")),
    triggerPrice: u32(small(r, "TriggerPrice")),
    nonce: i64(big(r, "Nonce")),
    expiredAt: i64(big(r, "ExpiredAt")),
    ...(attrs === undefined ? {} : { attributes: attrs }),
  };
}

/**
 * Run `fn` and assert it threw a {@link LighterValidationError} with exactly this code.
 *
 * Asserting the code rather than merely "it threw" is the whole point: several distinct rules share
 * a message and only the code distinguishes them.
 */
function expectCode(fn: () => void, code: string): LighterValidationError {
  let caught: unknown;
  try {
    fn();
  } catch (e: unknown) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(LighterValidationError);
  const err = caught as LighterValidationError;
  expect(err.code).toBe(code);
  return err;
}

/**
 * Mint a branded value that its smart constructor would refuse.
 *
 * Widths are enforced by `brands.ts`, so `u8(-1)` throws before a validator ever sees it. The
 * domain rules below still have to be exercised — a decoded response or a plain-JavaScript caller
 * can produce an out-of-width value — so the tests reach past the brand deliberately.
 */
function unchecked<T>(v: number | bigint): T {
  return v as unknown as T;
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures — each is a valid transaction that individual tests break in exactly one way.
 * ---------------------------------------------------------------------------------------------- */

/** Perps limit GTT buy. Mirrors vector `create_order/limit_gtt_buy`. */
const CREATE: CreateOrderTx = {
  type: TxType.L2CreateOrder,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  marketIndex: i16(1),
  clientOrderIndex: i64(100n),
  baseAmount: i64(1_000_000n),
  price: u32(250_000),
  isAsk: u8(0),
  orderType: u8(0),
  timeInForce: u8(1),
  reduceOnly: u8(0),
  triggerPrice: u32(0),
  orderExpiry: i64(1_893_456_000_000n),
  nonce: i64(42n),
  expiredAt: i64(1_893_456_000_000n),
};

const CANCEL: CancelOrderTx = {
  type: TxType.L2CancelOrder,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  marketIndex: i16(0),
  index: i64(1n),
  nonce: i64(7n),
  expiredAt: i64(1_893_456_000_000n),
};

const CANCEL_ALL: CancelAllOrdersTx = {
  type: TxType.L2CancelAllOrders,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  timeInForce: u8(0),
  time: i64(0n),
  nonce: i64(11n),
  expiredAt: i64(1_893_456_000_000n),
};

const MODIFY: ModifyOrderTx = {
  type: TxType.L2ModifyOrder,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  marketIndex: i16(1),
  index: i64(12_345n),
  baseAmount: i64(5_000n),
  price: u32(777_777),
  triggerPrice: u32(0),
  nonce: i64(13n),
  expiredAt: i64(1_893_456_000_000n),
};

/** The `OrderInfo` view of {@link CREATE}, for the three exported primitives. */
const ORDER: OrderInfo = {
  marketIndex: CREATE.marketIndex,
  clientOrderIndex: CREATE.clientOrderIndex,
  baseAmount: CREATE.baseAmount,
  price: CREATE.price,
  isAsk: CREATE.isAsk,
  type: CREATE.orderType,
  timeInForce: CREATE.timeInForce,
  reduceOnly: CREATE.reduceOnly,
  triggerPrice: CREATE.triggerPrice,
  orderExpiry: CREATE.orderExpiry,
};

function create(patch: Partial<CreateOrderTx>): CreateOrderTx {
  return { ...CREATE, ...patch };
}
function cancel(patch: Partial<CancelOrderTx>): CancelOrderTx {
  return { ...CANCEL, ...patch };
}
function cancelAll(patch: Partial<CancelAllOrdersTx>): CancelAllOrdersTx {
  return { ...CANCEL_ALL, ...patch };
}
function modify(patch: Partial<ModifyOrderTx>): ModifyOrderTx {
  return { ...MODIFY, ...patch };
}
function order(patch: Partial<OrderInfo>): OrderInfo {
  return { ...ORDER, ...patch };
}

/* -------------------------------------------------------------------------------------------------
 * marketKind
 * ---------------------------------------------------------------------------------------------- */

describe("marketKind", () => {
  test("classifies the perps window [0, 254]", () => {
    expect(marketKind(0)).toBe("perps");
    expect(marketKind(1)).toBe("perps");
    expect(marketKind(254)).toBe("perps");
  });

  test("classifies the spot window [2048, 4094]", () => {
    expect(marketKind(2048)).toBe("spot");
    expect(marketKind(4094)).toBe("spot");
  });

  test("rejects everything between and outside the two windows", () => {
    // 255 is NilMarketIndex — a cancel-all attribute sentinel, never a market.
    expect(marketKind(255)).toBeNull();
    expect(marketKind(-1)).toBeNull();
    expect(marketKind(2047)).toBeNull();
    expect(marketKind(4095)).toBeNull();
    expect(marketKind(256)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Conformance vectors — every order-family row must validate clean.
 * ---------------------------------------------------------------------------------------------- */

describe("conformance vectors validate without throwing", () => {
  const CREATE_ROWS: readonly string[] = [
    "create_order/limit_gtt_buy",
    "create_order/market_ioc_sell",
    "create_order/stop_loss_limit_reduce_only",
    "create_order/spot_post_only",
    "create_order/with_integrator_attributes",
    "create_order/with_skip_nonce",
  ];
  for (const name of CREATE_ROWS) {
    test(name, () => {
      expect(() => {
        validateCreateOrder(createFromVector(name));
      }).not.toThrow();
    });
  }

  for (const name of ["cancel_order/0", "cancel_order/1", "cancel_order/2"]) {
    test(name, () => {
      expect(() => {
        validateCancelOrder(cancelFromVector(name));
      }).not.toThrow();
    });
  }

  const CANCEL_ALL_ROWS: readonly string[] = [
    "cancel_all_orders/immediate",
    "cancel_all_orders/immediate_single_market",
    "cancel_all_orders/scheduled",
    "cancel_all_orders/negative_account_index",
    "cancel_all_orders/max_indices",
  ];
  for (const name of CANCEL_ALL_ROWS) {
    test(name, () => {
      expect(() => {
        validateCancelAllOrders(cancelAllFromVector(name));
      }).not.toThrow();
    });
  }

  test("modify_order/basic", () => {
    expect(() => {
      validateModifyOrder(modifyFromVector("modify_order/basic"));
    }).not.toThrow();
  });

  test("every order-family row in tx.json is covered by the lists above", () => {
    const covered: ReadonlySet<string> = new Set([
      ...CREATE_ROWS,
      "cancel_order/0",
      "cancel_order/1",
      "cancel_order/2",
      ...CANCEL_ALL_ROWS,
      "modify_order/basic",
    ]);
    const family: readonly string[] = vectors.txHashes
      .filter((r) => r.txType >= 14 && r.txType <= 17)
      .map((r) => r.name);
    expect(family.length).toBe(covered.size);
    for (const name of family) expect(covered.has(name)).toBe(true);
  });

  test("spot_post_only carries ReduceOnly 0 and passes; ReduceOnly 1 on spot is rejected", () => {
    const tx: CreateOrderTx = createFromVector("create_order/spot_post_only");
    expect(tx.marketIndex).toBe(2048 as I16);
    expect(tx.reduceOnly).toBe(0 as U8);
    expect(() => {
      validateCreateOrder(tx);
    }).not.toThrow();
    expectCode(() => {
      validateCreateOrder({ ...tx, reduceOnly: u8(1) });
    }, "ORDER_REDUCE_ONLY_INVALID");
  });

  test("stop_loss_limit_reduce_only is Type 3 with GoodTillTime and must pass", () => {
    const tx: CreateOrderTx = createFromVector("create_order/stop_loss_limit_reduce_only");
    expect(tx.orderType).toBe(3 as U8);
    expect(tx.timeInForce).toBe(1 as U8);
    expect(() => {
      validateCreateOrder(tx);
    }).not.toThrow();
  });

  test("market_ioc_sell sends a full-scale Price on a Type 1 order", () => {
    const tx: CreateOrderTx = createFromVector("create_order/market_ioc_sell");
    expect(tx.orderType).toBe(1 as U8);
    expect(tx.price).toBe(4_294_967_295 as U32);
    expect(() => {
      validateCreateOrder(tx);
    }).not.toThrow();
  });

  test("immediate_single_market passes with attribute 5; scheduling it is rejected", () => {
    const tx: CancelAllOrdersTx = cancelAllFromVector("cancel_all_orders/immediate_single_market");
    expect(tx.attributes).toEqual({ 5: 3 } as TxAttributes);
    expect(() => {
      validateCancelAllOrders(tx);
    }).not.toThrow();
    expectCode(() => {
      validateCancelAllOrders({ ...tx, timeInForce: u8(1), time: i64(1_893_456_000_000n) });
    }, "CANCEL_ALL_MARKET_CANT_BE_SCHEDULED");
  });

  test("negative_account_index uses AccountIndex = -1, which is MinAccountIndex", () => {
    const tx: CancelAllOrdersTx = cancelAllFromVector("cancel_all_orders/negative_account_index");
    expect(tx.accountIndex).toBe(-1n as I64);
    expect(() => {
      validateCancelAllOrders(tx);
    }).not.toThrow();
  });

  test("max_indices passes with ApiKeyIndex 254, and with 255 — cancel-all only", () => {
    const tx: CancelAllOrdersTx = cancelAllFromVector("cancel_all_orders/max_indices");
    expect(tx.apiKeyIndex).toBe(254 as U8);
    expect(tx.accountIndex).toBe(MAX_ACCOUNT_INDEX as I64);
    expect(() => {
      validateCancelAllOrders(tx);
    }).not.toThrow();
    expect(() => {
      validateCancelAllOrders({ ...tx, apiKeyIndex: u8(255) });
    }).not.toThrow();
    // The same value on any other order transaction is out of range.
    expectCode(() => {
      validateCancelOrder(cancel({ apiKeyIndex: u8(255) }));
    }, "API_KEY_INDEX_TOO_HIGH");
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.8 L2CreateOrder — steps 0 to 20
 * ---------------------------------------------------------------------------------------------- */

describe("validateCreateOrder — §7.8 steps 0-5", () => {
  test("step 0: attribute rules run first", () => {
    expectCode(() => {
      validateCreateOrder(
        create({ attributes: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 } as TxAttributes }),
      );
    }, "TOO_MANY_ATTRIBUTES");
  });

  test("step 1: AccountIndex < -1", () => {
    const err = expectCode(() => {
      validateCreateOrder(create({ accountIndex: i64(-2n) }));
    }, "ACCOUNT_INDEX_TOO_LOW");
    expect(err.field).toBe("AccountIndex");
    expect(err.txType).toBe(TxType.L2CreateOrder);
  });

  test("step 1: AccountIndex = -1 is legal", () => {
    expect(() => {
      validateCreateOrder(create({ accountIndex: i64(-1n) }));
    }).not.toThrow();
  });

  test("step 2: AccountIndex > 2^48 - 2", () => {
    expectCode(() => {
      validateCreateOrder(create({ accountIndex: i64(MAX_ACCOUNT_INDEX + 1n) }));
    }, "ACCOUNT_INDEX_TOO_HIGH");
    expect(() => {
      validateCreateOrder(create({ accountIndex: i64(MAX_ACCOUNT_INDEX) }));
    }).not.toThrow();
  });

  test("step 3: ApiKeyIndex < 0", () => {
    expectCode(() => {
      validateCreateOrder(create({ apiKeyIndex: unchecked<U8>(-1) }));
    }, "API_KEY_INDEX_TOO_LOW");
  });

  test("step 4: ApiKeyIndex > 254, including the cancel-all-only 255", () => {
    expectCode(() => {
      validateCreateOrder(create({ apiKeyIndex: u8(255) }));
    }, "API_KEY_INDEX_TOO_HIGH");
    expect(() => {
      validateCreateOrder(create({ apiKeyIndex: u8(254) }));
    }).not.toThrow();
  });

  test("step 5: the market gate is two disjoint windows", () => {
    for (const mi of [255, -1, 2047, 4095]) {
      expectCode(() => {
        validateCreateOrder(create({ marketIndex: i16(mi) }));
      }, "MARKET_INDEX_INVALID");
    }
    expect(() => {
      validateCreateOrder(create({ marketIndex: i16(254) }));
    }).not.toThrow();
    expect(() => {
      validateCreateOrder(create({ marketIndex: i16(4094) }));
    }).not.toThrow();
  });
});

describe("validateCreateOrder — §7.8 steps 6-16 (validateOrderCore)", () => {
  test("step 6: ClientOrderIndex below 1 when non-nil", () => {
    expectCode(() => {
      validateCreateOrder(create({ clientOrderIndex: i64(-1n) }));
    }, "CLIENT_ORDER_INDEX_TOO_LOW");
  });

  test("step 6/7: ClientOrderIndex 0 is nil and skips both bounds", () => {
    expect(() => {
      validateCreateOrder(create({ clientOrderIndex: i64(0n) }));
    }).not.toThrow();
  });

  test("step 7: ClientOrderIndex above 2^48 - 1", () => {
    expectCode(() => {
      validateCreateOrder(create({ clientOrderIndex: i64(MAX_CLIENT_ORDER_INDEX + 1n) }));
    }, "CLIENT_ORDER_INDEX_TOO_HIGH");
    expect(() => {
      validateCreateOrder(create({ clientOrderIndex: i64(MAX_CLIENT_ORDER_INDEX) }));
    }).not.toThrow();
  });

  test("step 8: BaseAmount 0 is rejected unless the order is reduce-only", () => {
    expectCode(() => {
      validateCreateOrder(create({ baseAmount: i64(0n) }));
    }, "BASE_AMOUNT_TOO_LOW");
  });

  test("step 8: BaseAmount 0 with ReduceOnly 1 is legal — the bracket-order case", () => {
    expect(() => {
      validateCreateOrder(create({ baseAmount: i64(0n), reduceOnly: u8(1) }));
    }).not.toThrow();
  });

  test("step 9: a negative BaseAmount is too low even when reduce-only", () => {
    expectCode(() => {
      validateCreateOrder(create({ baseAmount: i64(-5n), reduceOnly: u8(1) }));
    }, "BASE_AMOUNT_TOO_LOW");
  });

  test("step 10: BaseAmount above 2^48 - 1", () => {
    expectCode(() => {
      validateCreateOrder(create({ baseAmount: i64(MAX_ORDER_BASE_AMOUNT + 1n) }));
    }, "BASE_AMOUNT_TOO_HIGH");
    expect(() => {
      validateCreateOrder(create({ baseAmount: i64(MAX_ORDER_BASE_AMOUNT) }));
    }).not.toThrow();
  });

  test("step 11: Price has no nil sentinel — 0 is too low", () => {
    expectCode(() => {
      validateCreateOrder(create({ price: u32(0) }));
    }, "PRICE_TOO_LOW");
  });

  test("step 11: Price is bounded even on a market order", () => {
    expectCode(() => {
      validateCreateOrder(
        create({ orderType: u8(1), timeInForce: u8(0), orderExpiry: i64(0n), price: u32(0) }),
      );
    }, "PRICE_TOO_LOW");
  });

  test("step 12: Price above 2^32 - 1", () => {
    expectCode(() => {
      validateCreateOrder(create({ price: unchecked<U32>(4_294_967_296) }));
    }, "PRICE_TOO_HIGH");
  });

  test("step 13: IsAsk is a flag", () => {
    expectCode(() => {
      validateCreateOrder(create({ isAsk: u8(2) }));
    }, "IS_ASK_INVALID");
    expect(() => {
      validateCreateOrder(create({ isAsk: u8(1) }));
    }).not.toThrow();
  });

  test("step 14: TimeInForce outside {0, 1, 2}", () => {
    expectCode(() => {
      validateCreateOrder(create({ timeInForce: u8(3) }));
    }, "ORDER_TIF_INVALID");
  });

  test("step 15: ReduceOnly outside {0, 1}", () => {
    expectCode(() => {
      validateCreateOrder(create({ reduceOnly: u8(2) }));
    }, "ORDER_REDUCE_ONLY_INVALID");
  });

  test("step 15: ReduceOnly 1 is illegal on a spot market", () => {
    expectCode(() => {
      validateCreateOrder(create({ marketIndex: i16(2048), reduceOnly: u8(1) }));
    }, "ORDER_REDUCE_ONLY_INVALID");
    expect(() => {
      validateCreateOrder(create({ marketIndex: i16(2048), reduceOnly: u8(0) }));
    }).not.toThrow();
  });

  test("step 16: OrderExpiry non-nil and out of range", () => {
    expectCode(() => {
      validateCreateOrder(create({ orderExpiry: i64(-1n) }));
    }, "ORDER_EXPIRY_INVALID");
    expect(() => {
      validateCreateOrder(create({ orderExpiry: i64(MAX_ORDER_EXPIRY) }));
    }).not.toThrow();
  });

  test("validateOrderCore is callable on its own with an explicit market family", () => {
    expect(() => {
      validateOrderCore(ORDER, { isSpot: false });
    }).not.toThrow();
    expectCode(() => {
      validateOrderCore(order({ reduceOnly: u8(1) }), { isSpot: true });
    }, "ORDER_REDUCE_ONLY_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.8 step 17 — the per-Type matrix
 * ---------------------------------------------------------------------------------------------- */

describe("validateOrderTypeMatrix — §7.8 step 17", () => {
  const perps = { isPerps: true };
  const spot = { isPerps: false };

  test("Type 1 Market: IOC only, no expiry, no trigger", () => {
    const market: OrderInfo = order({
      type: u8(1),
      timeInForce: u8(0),
      orderExpiry: i64(0n),
      triggerPrice: u32(0),
    });
    expect(() => {
      validateOrderTypeMatrix(market, perps);
    }).not.toThrow();
    expectCode(() => {
      validateOrderTypeMatrix({ ...market, timeInForce: u8(1) }, perps);
    }, "ORDER_TIF_INVALID");
    expectCode(() => {
      validateOrderTypeMatrix({ ...market, orderExpiry: i64(1n) }, perps);
    }, "ORDER_EXPIRY_INVALID");
    expectCode(() => {
      validateOrderTypeMatrix({ ...market, triggerPrice: u32(1) }, perps);
    }, "ORDER_TRIGGER_PRICE_INVALID");
  });

  test("Type 0 Limit: no trigger, and TIF and expiry agree in both directions", () => {
    const gtt: OrderInfo = order({ type: u8(0), timeInForce: u8(1), orderExpiry: i64(1n) });
    expect(() => {
      validateOrderTypeMatrix(gtt, perps);
    }).not.toThrow();
    expectCode(() => {
      validateOrderTypeMatrix({ ...gtt, triggerPrice: u32(1) }, perps);
    }, "ORDER_TRIGGER_PRICE_INVALID");
    // IOC limit order may not carry an expiry ...
    expectCode(() => {
      validateOrderTypeMatrix({ ...gtt, timeInForce: u8(0) }, perps);
    }, "ORDER_EXPIRY_INVALID");
    // ... and a non-IOC one must.
    expectCode(() => {
      validateOrderTypeMatrix({ ...gtt, orderExpiry: i64(0n) }, perps);
    }, "ORDER_EXPIRY_INVALID");
    expect(() => {
      validateOrderTypeMatrix({ ...gtt, timeInForce: u8(0), orderExpiry: i64(0n) }, perps);
    }).not.toThrow();
    // PostOnly is not IOC, so it takes the "must have an expiry" branch.
    expect(() => {
      validateOrderTypeMatrix({ ...gtt, timeInForce: u8(2) }, perps);
    }).not.toThrow();
  });

  for (const type of [2, 4]) {
    test(`Type ${String(type)} (market-style trigger): perps, IOC, trigger and expiry set`, () => {
      const base: OrderInfo = order({
        type: u8(type),
        timeInForce: u8(0),
        triggerPrice: u32(123_456),
        orderExpiry: i64(1_893_456_000_000n),
      });
      expect(() => {
        validateOrderTypeMatrix(base, perps);
      }).not.toThrow();
      expectCode(() => {
        validateOrderTypeMatrix(base, spot);
      }, "ORDER_TYPE_INVALID");
      expectCode(() => {
        validateOrderTypeMatrix({ ...base, timeInForce: u8(1) }, perps);
      }, "ORDER_TIF_INVALID");
      expectCode(() => {
        validateOrderTypeMatrix({ ...base, triggerPrice: u32(0) }, perps);
      }, "ORDER_TRIGGER_PRICE_INVALID");
      expectCode(() => {
        validateOrderTypeMatrix({ ...base, orderExpiry: i64(0n) }, perps);
      }, "ORDER_EXPIRY_INVALID");
    });
  }

  for (const type of [3, 5]) {
    test(`Type ${String(type)} (limit-style trigger): perps, trigger and expiry set, ANY TIF`, () => {
      const base: OrderInfo = order({
        type: u8(type),
        timeInForce: u8(1),
        triggerPrice: u32(123_456),
        orderExpiry: i64(1_893_456_000_000n),
      });
      // The load-bearing case: GoodTillTime on a limit-style trigger order is legal.
      expect(() => {
        validateOrderTypeMatrix(base, perps);
      }).not.toThrow();
      for (const tif of [0, 2]) {
        expect(() => {
          validateOrderTypeMatrix({ ...base, timeInForce: u8(tif) }, perps);
        }).not.toThrow();
      }
      expectCode(() => {
        validateOrderTypeMatrix(base, spot);
      }, "ORDER_TYPE_INVALID");
      expectCode(() => {
        validateOrderTypeMatrix({ ...base, triggerPrice: u32(0) }, perps);
      }, "ORDER_TRIGGER_PRICE_INVALID");
      expectCode(() => {
        validateOrderTypeMatrix({ ...base, orderExpiry: i64(0n) }, perps);
      }, "ORDER_EXPIRY_INVALID");
    });
  }

  test("Type 6 TWAP: GoodTillTime only, expiry set, no trigger", () => {
    const twap: OrderInfo = order({
      type: u8(6),
      timeInForce: u8(1),
      orderExpiry: i64(1_893_456_000_000n),
      triggerPrice: u32(0),
    });
    expect(() => {
      validateOrderTypeMatrix(twap, perps);
    }).not.toThrow();
    for (const tif of [0, 2]) {
      expectCode(() => {
        validateOrderTypeMatrix({ ...twap, timeInForce: u8(tif) }, perps);
      }, "ORDER_TIF_INVALID");
    }
    expectCode(() => {
      validateOrderTypeMatrix({ ...twap, triggerPrice: u32(1) }, perps);
    }, "ORDER_TRIGGER_PRICE_INVALID");
    expectCode(() => {
      validateOrderTypeMatrix({ ...twap, orderExpiry: i64(0n) }, perps);
    }, "ORDER_EXPIRY_INVALID");
  });

  test("Types 7, 8 and above are engine-internal and always rejected", () => {
    for (const type of [7, 8, 9, 200]) {
      expectCode(() => {
        validateOrderTypeMatrix(order({ type: u8(type) }), perps);
      }, "ORDER_TYPE_INVALID");
    }
  });

  test("the matrix reaches L2CreateOrder through the market family, not a flag", () => {
    // Type 2 on a spot market: the transaction-level validator derives isPerps from the index.
    expectCode(() => {
      validateCreateOrder(
        create({
          marketIndex: i16(2048),
          orderType: u8(2),
          timeInForce: u8(0),
          triggerPrice: u32(1),
        }),
      );
    }, "ORDER_TYPE_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.8 step 18 — trigger price range
 * ---------------------------------------------------------------------------------------------- */

describe("validateTriggerPriceRange — §7.8 step 18", () => {
  test("nil trigger skips the range entirely", () => {
    expect(() => {
      validateTriggerPriceRange(order({ triggerPrice: u32(0) }));
    }).not.toThrow();
  });

  test("a non-nil trigger outside [1, 2^32 - 1] is invalid", () => {
    expectCode(() => {
      validateTriggerPriceRange(order({ triggerPrice: unchecked<U32>(-1) }));
    }, "ORDER_TRIGGER_PRICE_INVALID");
    expectCode(() => {
      validateTriggerPriceRange(order({ triggerPrice: unchecked<U32>(4_294_967_296) }));
    }, "ORDER_TRIGGER_PRICE_INVALID");
    expect(() => {
      validateTriggerPriceRange(order({ triggerPrice: u32(4_294_967_295) }));
    }).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.8 steps 19-20
 * ---------------------------------------------------------------------------------------------- */

describe("validateCreateOrder — §7.8 steps 19-20", () => {
  test("step 19: Nonce < 0", () => {
    expectCode(() => {
      validateCreateOrder(create({ nonce: i64(-1n) }));
    }, "NONCE_TOO_LOW");
    expect(() => {
      validateCreateOrder(create({ nonce: i64(0n) }));
    }).not.toThrow();
  });

  test("step 20: ExpiredAt outside [0, 2^48 - 1]", () => {
    expectCode(() => {
      validateCreateOrder(create({ expiredAt: i64(-1n) }));
    }, "EXPIRED_AT_INVALID");
    expectCode(() => {
      validateCreateOrder(create({ expiredAt: i64(MAX_TIMESTAMP + 1n) }));
    }, "EXPIRED_AT_INVALID");
    // MAX_TIMESTAMP is 2^48 - 1, one higher than MAX_ACCOUNT_INDEX. They are not the same bound.
    expect(() => {
      validateCreateOrder(create({ expiredAt: i64(MAX_TIMESTAMP) }));
    }).not.toThrow();
    expect(MAX_TIMESTAMP).toBe(MAX_ACCOUNT_INDEX + 1n);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Check order — the identity of the error, not merely its existence
 * ---------------------------------------------------------------------------------------------- */

describe("check order is normative", () => {
  test("trigger-price range runs AFTER the type matrix on a Type 1 order", () => {
    // Both rules are broken: the trigger is out of range (step 18) and a market order may not carry
    // a trigger at all, and its TIF must be IOC (step 17). If step 18 ran first the code would be
    // ORDER_TRIGGER_PRICE_INVALID; the matrix's TIF clause proves the ordering.
    expectCode(() => {
      validateCreateOrder(
        create({
          orderType: u8(1),
          timeInForce: u8(1),
          orderExpiry: i64(0n),
          triggerPrice: unchecked<U32>(4_294_967_296),
        }),
      );
    }, "ORDER_TIF_INVALID");

    // And with a legal TIF, the matrix's "no trigger on a market order" clause fires — same code as
    // step 18, different clause, which is why the two are separate exported functions.
    expectCode(() => {
      validateCreateOrder(
        create({
          orderType: u8(1),
          timeInForce: u8(0),
          orderExpiry: i64(0n),
          triggerPrice: unchecked<U32>(4_294_967_296),
        }),
      );
    }, "ORDER_TRIGGER_PRICE_INVALID");
  });

  test("attributes are checked before any struct field", () => {
    expectCode(() => {
      validateCreateOrder(
        create({
          accountIndex: i64(-2n),
          attributes: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 } as TxAttributes,
        }),
      );
    }, "TOO_MANY_ATTRIBUTES");
  });

  test("account bounds beat every order field", () => {
    expectCode(() => {
      validateCreateOrder(create({ accountIndex: i64(-2n), price: u32(0), isAsk: u8(9) }));
    }, "ACCOUNT_INDEX_TOO_LOW");
  });

  test("the market gate beats the order fields and the nonce", () => {
    expectCode(() => {
      validateCreateOrder(create({ marketIndex: i16(255), price: u32(0), nonce: i64(-1n) }));
    }, "MARKET_INDEX_INVALID");
  });

  test("BaseAmount (step 8) beats Price (step 11)", () => {
    expectCode(() => {
      validateCreateOrder(create({ baseAmount: i64(0n), price: u32(0) }));
    }, "BASE_AMOUNT_TOO_LOW");
  });

  test("the type matrix beats the nonce and expiredAt", () => {
    expectCode(() => {
      validateCreateOrder(create({ orderType: u8(7), nonce: i64(-1n), expiredAt: i64(-1n) }));
    }, "ORDER_TYPE_INVALID");
  });

  test("cancel-all checks Nonce and ExpiredAt BEFORE the TIF switch", () => {
    // Everywhere else the nonce is last; here a bad nonce beats an invalid time-in-force.
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ nonce: i64(-1n), timeInForce: u8(9) }));
    }, "NONCE_TOO_LOW");
    expectCode(() => {
      validateCancelAllOrders(
        cancelAll({ expiredAt: i64(MAX_TIMESTAMP + 1n), timeInForce: u8(9) }),
      );
    }, "EXPIRED_AT_INVALID");
    // ... and before the per-market attribute cross-check.
    expectCode(() => {
      validateCancelAllOrders(
        cancelAll({
          nonce: i64(-1n),
          timeInForce: u8(1),
          time: i64(1n),
          attributes: { 5: 3 } as TxAttributes,
        }),
      );
    }, "NONCE_TOO_LOW");
  });

  test("cancel-all attribute cross-check beats the TIF switch", () => {
    expectCode(() => {
      validateCancelAllOrders(
        cancelAll({ timeInForce: u8(1), time: i64(0n), attributes: { 5: 3 } as TxAttributes }),
      );
    }, "CANCEL_ALL_MARKET_CANT_BE_SCHEDULED");
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.9 L2CancelOrder
 * ---------------------------------------------------------------------------------------------- */

describe("validateCancelOrder — §7.9", () => {
  test("attributes, account and api-key bounds", () => {
    expectCode(() => {
      validateCancelOrder(cancel({ attributes: { 4: 0 } as TxAttributes }));
    }, "NONCE_SKIP_ATTRIBUTE_INVALID");
    expectCode(() => {
      validateCancelOrder(cancel({ accountIndex: i64(-2n) }));
    }, "ACCOUNT_INDEX_TOO_LOW");
    expectCode(() => {
      validateCancelOrder(cancel({ accountIndex: i64(MAX_ACCOUNT_INDEX + 1n) }));
    }, "ACCOUNT_INDEX_TOO_HIGH");
    expectCode(() => {
      validateCancelOrder(cancel({ apiKeyIndex: unchecked<U8>(-1) }));
    }, "API_KEY_INDEX_TOO_LOW");
  });

  test("market index gate", () => {
    expectCode(() => {
      validateCancelOrder(cancel({ marketIndex: i16(255) }));
    }, "MARKET_INDEX_INVALID");
  });

  test("Index is bounded by the collapsed union [1, 2^60 - 1]", () => {
    const low = expectCode(() => {
      validateCancelOrder(cancel({ index: i64(0n) }));
    }, "ORDER_INDEX_TOO_LOW");
    expect(low.field).toBe("Index");
    expect(low.txType).toBe(TxType.L2CancelOrder);
    expectCode(() => {
      validateCancelOrder(cancel({ index: i64(-1n) }));
    }, "ORDER_INDEX_TOO_LOW");
    expectCode(() => {
      validateCancelOrder(cancel({ index: i64(MAX_ORDER_INDEX + 1n) }));
    }, "ORDER_INDEX_TOO_HIGH");
    // A client order index and an order index are both accepted; magnitude disambiguates later.
    for (const idx of [1n, 281_474_976_710_655n, 281_474_976_710_656n, MAX_ORDER_INDEX]) {
      expect(() => {
        validateCancelOrder(cancel({ index: i64(idx) }));
      }).not.toThrow();
    }
  });

  test("nonce and expiredAt are checked last", () => {
    expectCode(() => {
      validateCancelOrder(cancel({ nonce: i64(-1n) }));
    }, "NONCE_TOO_LOW");
    expectCode(() => {
      validateCancelOrder(cancel({ expiredAt: i64(MAX_TIMESTAMP + 1n) }));
    }, "EXPIRED_AT_INVALID");
    // Index (earlier) wins over the nonce (later).
    expectCode(() => {
      validateCancelOrder(cancel({ index: i64(0n), nonce: i64(-1n) }));
    }, "ORDER_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.10 L2CancelAllOrders
 * ---------------------------------------------------------------------------------------------- */

describe("validateCancelAllOrders — §7.10", () => {
  test("ApiKeyIndex 255 is legal here and only here", () => {
    expect(() => {
      validateCancelAllOrders(cancelAll({ apiKeyIndex: u8(255) }));
    }).not.toThrow();
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ apiKeyIndex: unchecked<U8>(-1) }));
    }, "API_KEY_INDEX_TOO_LOW");
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ apiKeyIndex: unchecked<U8>(256) }));
    }, "API_KEY_INDEX_TOO_HIGH");
  });

  test("account bounds, nonce and expiredAt", () => {
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ accountIndex: i64(-2n) }));
    }, "ACCOUNT_INDEX_TOO_LOW");
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ accountIndex: i64(MAX_ACCOUNT_INDEX + 1n) }));
    }, "ACCOUNT_INDEX_TOO_HIGH");
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ nonce: i64(-1n) }));
    }, "NONCE_TOO_LOW");
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ expiredAt: i64(-1n) }));
    }, "EXPIRED_AT_INVALID");
  });

  test("TimeInForce 0 Immediate requires a nil Time", () => {
    expect(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(0), time: i64(0n) }));
    }).not.toThrow();
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(0), time: i64(1n) }));
    }, "CANCEL_ALL_TIME_NOT_NIL");
  });

  test("TimeInForce 2 AbortScheduled requires a nil Time", () => {
    expect(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(2), time: i64(0n) }));
    }).not.toThrow();
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(2), time: i64(1n) }));
    }, "CANCEL_ALL_TIME_NOT_NIL");
  });

  test("TimeInForce 1 Scheduled requires Time in [1, 2^63 - 1]", () => {
    for (const t of [1n, 1_893_456_000_000n, MAX_ORDER_EXPIRY]) {
      expect(() => {
        validateCancelAllOrders(cancelAll({ timeInForce: u8(1), time: i64(t) }));
      }).not.toThrow();
    }
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(1), time: i64(0n) }));
    }, "CANCEL_ALL_TIME_OUT_OF_RANGE");
    expectCode(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(1), time: i64(-1n) }));
    }, "CANCEL_ALL_TIME_OUT_OF_RANGE");
  });

  test("the advisory cancel-all period bounds are NOT enforced", () => {
    // MinOrderCancelAllPeriod is 300000 ms; a schedule well inside it must still validate here.
    expect(() => {
      validateCancelAllOrders(cancelAll({ timeInForce: u8(1), time: i64(1n) }));
    }).not.toThrow();
  });

  test("any other TimeInForce is invalid", () => {
    for (const tif of [3, 9, 255]) {
      expectCode(() => {
        validateCancelAllOrders(cancelAll({ timeInForce: u8(tif), time: i64(0n) }));
      }, "CANCEL_ALL_TIF_INVALID");
    }
  });

  test("per-market attribute 5 is only legal alongside ImmediateCancelAll", () => {
    // Immediate + a specific market: fine.
    expect(() => {
      validateCancelAllOrders(
        cancelAll({ timeInForce: u8(0), attributes: { 5: 3 } as TxAttributes }),
      );
    }).not.toThrow();
    // Market 0 is a real market, and attribute 5 nils at 255 rather than 0.
    expect(() => {
      validateCancelAllOrders(
        cancelAll({ timeInForce: u8(0), attributes: { 5: 0 } as TxAttributes }),
      );
    }).not.toThrow();
    // Scheduled or aborted with a specific market: rejected.
    for (const tif of [1, 2]) {
      expectCode(() => {
        validateCancelAllOrders(
          cancelAll({
            timeInForce: u8(tif),
            time: i64(tif === 1 ? 1_893_456_000_000n : 0n),
            attributes: { 5: 3 } as TxAttributes,
          }),
        );
      }, "CANCEL_ALL_MARKET_CANT_BE_SCHEDULED");
    }
    // 255 means "all markets" and is exempt from the rule.
    expect(() => {
      validateCancelAllOrders(
        cancelAll({
          timeInForce: u8(1),
          time: i64(1_893_456_000_000n),
          attributes: { 5: 255 } as TxAttributes,
        }),
      );
    }).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * §7.11 L2ModifyOrder
 * ---------------------------------------------------------------------------------------------- */

describe("validateModifyOrder — §7.11", () => {
  test("attributes, account, api key and market index", () => {
    expectCode(() => {
      validateModifyOrder(modify({ accountIndex: i64(-2n) }));
    }, "ACCOUNT_INDEX_TOO_LOW");
    expectCode(() => {
      validateModifyOrder(modify({ accountIndex: i64(MAX_ACCOUNT_INDEX + 1n) }));
    }, "ACCOUNT_INDEX_TOO_HIGH");
    expectCode(() => {
      validateModifyOrder(modify({ apiKeyIndex: unchecked<U8>(-1) }));
    }, "API_KEY_INDEX_TOO_LOW");
    expectCode(() => {
      validateModifyOrder(modify({ apiKeyIndex: u8(255) }));
    }, "API_KEY_INDEX_TOO_HIGH");
    expectCode(() => {
      validateModifyOrder(modify({ marketIndex: i16(4095) }));
    }, "MARKET_INDEX_INVALID");
  });

  test("Index reports the CLIENT_ORDER_INDEX_* pair — the same predicate as cancel, other codes", () => {
    const low = expectCode(() => {
      validateModifyOrder(modify({ index: i64(0n) }));
    }, "CLIENT_ORDER_INDEX_TOO_LOW");
    expect(low.field).toBe("Index");
    expect(low.txType).toBe(TxType.L2ModifyOrder);
    expectCode(() => {
      validateModifyOrder(modify({ index: i64(MAX_ORDER_INDEX + 1n) }));
    }, "CLIENT_ORDER_INDEX_TOO_HIGH");

    // The divergence, stated as a test so nobody "fixes" it: identical input, different identity.
    expectCode(() => {
      validateCancelOrder(cancel({ index: i64(0n) }));
    }, "ORDER_INDEX_TOO_LOW");
    expectCode(() => {
      validateCancelOrder(cancel({ index: i64(MAX_ORDER_INDEX + 1n) }));
    }, "ORDER_INDEX_TOO_HIGH");
  });

  test("BaseAmount 0 means 'leave unchanged' and is always legal here", () => {
    expect(() => {
      validateModifyOrder(modify({ baseAmount: i64(0n) }));
    }).not.toThrow();
    expectCode(() => {
      validateModifyOrder(modify({ baseAmount: i64(-1n) }));
    }, "BASE_AMOUNT_TOO_LOW");
    expectCode(() => {
      validateModifyOrder(modify({ baseAmount: i64(MAX_ORDER_BASE_AMOUNT + 1n) }));
    }, "BASE_AMOUNT_TOO_HIGH");
  });

  test("Price and TriggerPrice", () => {
    expectCode(() => {
      validateModifyOrder(modify({ price: u32(0) }));
    }, "PRICE_TOO_LOW");
    expectCode(() => {
      validateModifyOrder(modify({ price: unchecked<U32>(4_294_967_296) }));
    }, "PRICE_TOO_HIGH");
    expectCode(() => {
      validateModifyOrder(modify({ triggerPrice: unchecked<U32>(-1) }));
    }, "ORDER_TRIGGER_PRICE_INVALID");
    expect(() => {
      validateModifyOrder(modify({ triggerPrice: u32(4_294_967_295) }));
    }).not.toThrow();
  });

  test("nonce and expiredAt are checked last", () => {
    expectCode(() => {
      validateModifyOrder(modify({ nonce: i64(-1n) }));
    }, "NONCE_TOO_LOW");
    expectCode(() => {
      validateModifyOrder(modify({ expiredAt: i64(MAX_TIMESTAMP + 1n) }));
    }, "EXPIRED_AT_INVALID");
    expectCode(() => {
      validateModifyOrder(modify({ price: u32(0), nonce: i64(-1n) }));
    }, "PRICE_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * The `strict` option
 * ---------------------------------------------------------------------------------------------- */

describe("OrderValidateOptions", () => {
  test("strict is accepted and gates nothing for these four transactions", () => {
    for (const opts of [undefined, { strict: true }, { strict: false }]) {
      expect(() => {
        validateCreateOrder(CREATE, opts);
      }).not.toThrow();
      expect(() => {
        validateCancelOrder(CANCEL, opts);
      }).not.toThrow();
      expect(() => {
        validateCancelAllOrders(CANCEL_ALL, opts);
      }).not.toThrow();
      expect(() => {
        validateModifyOrder(MODIFY, opts);
      }).not.toThrow();
      // Every rule in this module is one the reference enforces, so relaxing strictness must not
      // turn a rejection into an acceptance.
      expectCode(() => {
        validateCreateOrder(create({ price: u32(0) }), opts);
      }, "PRICE_TOO_LOW");
    }
  });
});
