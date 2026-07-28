/**
 * `src/tx/validate/grouped.ts` — validation for `L2CreateGroupedOrders` (type 28).
 *
 * Three things are under test:
 *
 * 1. **The clean spine.** The three `create_grouped_orders/*` rows of `conformance/vectors/tx.json`
 *    are driven straight from the JSON `fields` map and must validate without throwing, under both
 *    default options and `{ strict: false }`. The oracle calls `Validate()` before emitting a row,
 *    so a false rejection here is a silent interop regression.
 * 2. **Identity.** Every cell of the §8.5 grouping table has a case that trips it and asserts the
 *    exact §12 code, because callers branch on `code`. The three groupings disagree on nearly every
 *    axis, so a validator with the right rules attached to the wrong grouping still passes a test
 *    suite that only checks "bad input throws".
 * 3. **What the vectors cannot see.** All three grouped vectors use `TimeInForce: 0` on their
 *    children and none has a reduce-only parent, so the "types `3`/`5` carry no TIF constraint"
 *    rule and the strict-mode `CHILD_REDUCE_ONLY_MISMATCH` rule are invisible to conformance and
 *    are pinned here by hand.
 *
 * Vector `fields` values are decimal strings and are parsed with `BigInt`, never `Number`.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import type { TxAttributes } from "../../../src/tx/attributes.js";
import type { I16, I64, U8, U32 } from "../../../src/tx/brands.js";
import { i16, i64, u8, u32 } from "../../../src/tx/brands.js";
import { GroupingType, TxType } from "../../../src/tx/enums.js";
import type { CreateGroupedOrdersTx, OrderInfo } from "../../../src/tx/types/orders.js";
import {
  validateChildOrder,
  validateCreateGroupedOrders,
  validateParentOrder,
  validateSiblingPair,
} from "../../../src/tx/validate/grouped.js";

/* -------------------------------------------------------------------------------------------------
 * Vector harness
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

/** A field the protocol declares 32 bits or narrower, narrowed only after proving exactness. */
function small(r: TxRow, key: string): number {
  const wide: bigint = big(r, key);
  const narrow: number = Number(wide);
  if (BigInt(narrow) !== wide) throw new Error(`${r.name}: ${key} is not exact as a number`);
  return narrow;
}

function attributesOf(r: TxRow): TxAttributes | undefined {
  return Object.keys(r.attributes).length === 0 ? undefined : (r.attributes as TxAttributes);
}

/** Build the `OrderInfo` for leg `index` out of the row's `Order<i>.*` keys. */
function legFromVector(r: TxRow, index: number): OrderInfo {
  const p = `Order${String(index)}.`;
  return {
    marketIndex: i16(small(r, `${p}MarketIndex`)),
    clientOrderIndex: i64(big(r, `${p}ClientOrderIndex`)),
    baseAmount: i64(big(r, `${p}BaseAmount`)),
    price: u32(small(r, `${p}Price`)),
    isAsk: u8(small(r, `${p}IsAsk`)),
    type: u8(small(r, `${p}Type`)),
    timeInForce: u8(small(r, `${p}TimeInForce`)),
    reduceOnly: u8(small(r, `${p}ReduceOnly`)),
    triggerPrice: u32(small(r, `${p}TriggerPrice`)),
    orderExpiry: i64(big(r, `${p}OrderExpiry`)),
  };
}

function groupedFromVector(name: string): CreateGroupedOrdersTx {
  const r: TxRow = row(name);
  const attrs: TxAttributes | undefined = attributesOf(r);
  const count: number = small(r, "OrderCount");
  const orders: OrderInfo[] = [];
  for (let i = 0; i < count; i += 1) orders.push(legFromVector(r, i));
  return {
    type: TxType.L2CreateGroupedOrders,
    accountIndex: i64(big(r, "AccountIndex")),
    apiKeyIndex: u8(small(r, "ApiKeyIndex")),
    groupingType: u8(small(r, "GroupingType")),
    orders,
    nonce: i64(big(r, "Nonce")),
    expiredAt: i64(big(r, "ExpiredAt")),
    ...(attrs === undefined ? {} : { attributes: attrs }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Hand-built fixtures
 *
 * Shaped after the vectors so that every negative case differs from a *known-good* transaction in
 * exactly one field — otherwise a test can pass for the wrong reason, tripping an earlier rule.
 * ---------------------------------------------------------------------------------------------- */

const EXPIRY: bigint = 1893456000000n;

interface LegSpec {
  readonly marketIndex?: number;
  readonly clientOrderIndex?: bigint;
  readonly baseAmount?: bigint;
  readonly price?: number;
  readonly isAsk?: number;
  readonly type?: number;
  readonly timeInForce?: number;
  readonly reduceOnly?: number;
  readonly triggerPrice?: number;
  readonly orderExpiry?: bigint;
}

function mkLeg(spec: LegSpec): OrderInfo {
  return {
    marketIndex: i16(spec.marketIndex ?? 1),
    clientOrderIndex: i64(spec.clientOrderIndex ?? 0n),
    baseAmount: i64(spec.baseAmount ?? 0n),
    price: u32(spec.price ?? 5000),
    isAsk: u8(spec.isAsk ?? 0),
    type: u8(spec.type ?? 0),
    timeInForce: u8(spec.timeInForce ?? 1),
    reduceOnly: u8(spec.reduceOnly ?? 0),
    triggerPrice: u32(spec.triggerPrice ?? 0),
    orderExpiry: i64(spec.orderExpiry ?? EXPIRY),
  };
}

/** A sized GoodTillTime limit buy — the canonical OTO / OTOCO parent. */
const PARENT: LegSpec = {
  type: 0,
  timeInForce: 1,
  baseAmount: 1000n,
  price: 5000,
  isAsk: 0,
  triggerPrice: 0,
  reduceOnly: 0,
  orderExpiry: EXPIRY,
};

/** A position-tied stop-loss sell: nil size, reduce-only, IOC, triggered. */
const CHILD_SL: LegSpec = {
  type: 2,
  timeInForce: 0,
  baseAmount: 0n,
  price: 4000,
  isAsk: 1,
  triggerPrice: 4100,
  reduceOnly: 1,
  orderExpiry: EXPIRY,
};

/** Its take-profit twin — same side, same size, opposite intent. */
const CHILD_TP: LegSpec = {
  type: 4,
  timeInForce: 0,
  baseAmount: 0n,
  price: 6000,
  isAsk: 1,
  triggerPrice: 5900,
  reduceOnly: 1,
  orderExpiry: EXPIRY,
};

function mkTx(groupingType: number, legs: readonly LegSpec[]): CreateGroupedOrdersTx {
  return {
    type: TxType.L2CreateGroupedOrders,
    accountIndex: i64(1n),
    apiKeyIndex: u8(0),
    groupingType: u8(groupingType),
    orders: legs.map(mkLeg),
    nonce: i64(31n),
    expiredAt: i64(EXPIRY),
  };
}

const OTO: readonly LegSpec[] = [PARENT, CHILD_SL];
const OCO: readonly LegSpec[] = [CHILD_SL, CHILD_TP];
const OTOCO: readonly LegSpec[] = [PARENT, CHILD_SL, CHILD_TP];

/** Assert the thrown error is a `LighterValidationError` carrying exactly `code`. */
function expectCode(run: () => void, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (e: unknown) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(LighterValidationError);
  expect((thrown as LighterValidationError).code).toBe(code as never);
}

/* -------------------------------------------------------------------------------------------------
 * The vectors
 * ---------------------------------------------------------------------------------------------- */

describe("conformance vectors validate clean", () => {
  const names: readonly string[] = [
    "create_grouped_orders/oto",
    "create_grouped_orders/oco",
    "create_grouped_orders/otoco",
  ];

  for (const name of names) {
    test(`${name} — default options`, () => {
      expect(() => validateCreateGroupedOrders(groupedFromVector(name))).not.toThrow();
    });
    test(`${name} — { strict: false }`, () => {
      expect(() =>
        validateCreateGroupedOrders(groupedFromVector(name), { strict: false }),
      ).not.toThrow();
    });
  }

  test("the vectors are the shapes the issue describes", () => {
    const oto: CreateGroupedOrdersTx = groupedFromVector("create_grouped_orders/oto");
    expect(oto.groupingType).toBe(1 as never);
    expect(oto.orders.length).toBe(2);
    expect(oto.orders[0]?.baseAmount).toBe(1000n as never);
    expect(oto.orders[1]?.baseAmount).toBe(0n as never);
    expect(oto.orders[0]?.isAsk).not.toBe(oto.orders[1]?.isAsk as never);

    const oco: CreateGroupedOrdersTx = groupedFromVector("create_grouped_orders/oco");
    expect(oco.groupingType).toBe(2 as never);
    expect(oco.orders[0]?.isAsk).toBe(oco.orders[1]?.isAsk as never);
    expect(oco.orders[0]?.reduceOnly).toBe(1 as never);
    expect(oco.orders[1]?.reduceOnly).toBe(1 as never);

    const otoco: CreateGroupedOrdersTx = groupedFromVector("create_grouped_orders/otoco");
    expect(otoco.groupingType).toBe(3 as never);
    expect(otoco.orders.length).toBe(3);
    expect(otoco.orders[0]?.baseAmount).toBe(2500n as never);
  });

  test("the hand-built fixtures agree with the vectors", () => {
    expect(() => validateCreateGroupedOrders(mkTx(GroupingType.OneTriggersTheOther, OTO))).not.toThrow();
    expect(() => validateCreateGroupedOrders(mkTx(GroupingType.OneCancelsTheOther, OCO))).not.toThrow();
    expect(() =>
      validateCreateGroupedOrders(mkTx(GroupingType.OneTriggersAOneCancelsTheOther, OTOCO)),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * §8.2 — common validation, before the switch
 * ---------------------------------------------------------------------------------------------- */

describe("§8.2 common validation", () => {
  test("account index bounds", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders({
          ...mkTx(GroupingType.OneTriggersTheOther, OTO),
          accountIndex: i64(-2n),
        }),
      "ACCOUNT_INDEX_TOO_LOW",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders({
          ...mkTx(GroupingType.OneTriggersTheOther, OTO),
          accountIndex: i64(281474976710655n),
        }),
      "ACCOUNT_INDEX_TOO_HIGH",
    );
  });

  test("api key index bounds — 255 is not carved out here", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders({
          ...mkTx(GroupingType.OneTriggersTheOther, OTO),
          apiKeyIndex: u8(255),
        }),
      "API_KEY_INDEX_TOO_HIGH",
    );
  });

  test("zero legs and four legs are rejected before the switch", () => {
    expectCode(
      () => validateCreateGroupedOrders(mkTx(GroupingType.OneTriggersTheOther, [])),
      "ORDER_GROUP_SIZE_INVALID",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
            PARENT,
            CHILD_SL,
            CHILD_TP,
            CHILD_TP,
          ]),
        ),
      "ORDER_GROUP_SIZE_INVALID",
    );
  });

  test("an invalid grouping type on a four-leg group still reports the size first", () => {
    // The §8.2 size gate runs before the switch, so this is not `GROUPING_TYPE_INVALID`.
    expectCode(
      () => validateCreateGroupedOrders(mkTx(0, [PARENT, CHILD_SL, CHILD_TP, CHILD_TP])),
      "ORDER_GROUP_SIZE_INVALID",
    );
  });

  test("a spot market index on leg 0 is MARKET_INDEX_INVALID, not a mismatch", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            { ...PARENT, marketIndex: 2048 },
            { ...CHILD_SL, marketIndex: 2048 },
          ]),
        ),
      "MARKET_INDEX_INVALID",
    );
  });

  test("the nil market index 255 on leg 0 is MARKET_INDEX_INVALID", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            { ...PARENT, marketIndex: 255 },
            { ...CHILD_SL, marketIndex: 255 },
          ]),
        ),
      "MARKET_INDEX_INVALID",
    );
  });

  test("a spot market index on leg 1 surfaces as MARKET_INDEX_MISMATCH", () => {
    // Only leg 0 is gated on the perps range; every other leg is compared to leg 0 alone.
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [PARENT, { ...CHILD_SL, marketIndex: 2048 }]),
        ),
      "MARKET_INDEX_MISMATCH",
    );
  });

  test("a differing perps market index on leg 1 is MARKET_INDEX_MISMATCH", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [PARENT, { ...CHILD_SL, marketIndex: 2 }]),
        ),
      "MARKET_INDEX_MISMATCH",
    );
  });

  test("duplicate non-nil ClientOrderIndex is rejected", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            { ...PARENT, clientOrderIndex: 2001n },
            { ...CHILD_SL, clientOrderIndex: 2001n },
          ]),
        ),
      "CLIENT_ORDER_INDEX_DUPLICATE",
    );
  });

  test("ClientOrderIndex 0 is the nil sentinel and is exempt from the duplicate check", () => {
    expect(() =>
      validateCreateGroupedOrders(
        mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
          { ...PARENT, clientOrderIndex: 0n },
          { ...CHILD_SL, clientOrderIndex: 0n },
          { ...CHILD_TP, clientOrderIndex: 0n },
        ]),
      ),
    ).not.toThrow();
  });

  test("ClientOrderIndex bounds still apply to non-nil values", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            { ...PARENT, clientOrderIndex: -1n },
            CHILD_SL,
          ]),
        ),
      "CLIENT_ORDER_INDEX_TOO_LOW",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            { ...PARENT, clientOrderIndex: 281474976710656n },
            CHILD_SL,
          ]),
        ),
      "CLIENT_ORDER_INDEX_TOO_HIGH",
    );
  });

  test("the shared per-leg core rules run on every leg", () => {
    // A nil size on a leg that is not reduce-only — `validateOrderCore` step 8.
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [
            PARENT,
            { ...CHILD_SL, reduceOnly: 0, baseAmount: 0n },
          ]),
        ),
      "BASE_AMOUNT_TOO_LOW",
    );
    // Price has no nil sentinel.
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [{ ...PARENT, price: 0 }, CHILD_SL]),
        ),
      "PRICE_TOO_LOW",
    );
    // OrderExpiry: `0` is nil, anything else is a positive int64 — and `i64` still admits
    // negatives, so this is the one core range rule a branded value can still violate.
    // (`TriggerPrice` cannot: `u32` already spans exactly `[0, 2^32 - 1]`, so
    // `validateTriggerPriceRange` is unreachable once `u32()` has accepted the value.)
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [PARENT, { ...CHILD_SL, orderExpiry: -1n }]),
        ),
      "ORDER_EXPIRY_INVALID",
    );
  });

  test("nonce and expiredAt are checked before the grouping switch", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders({ ...mkTx(0, OTO), nonce: i64(-1n) }),
      "NONCE_TOO_LOW",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders({ ...mkTx(0, OTO), expiredAt: i64(281474976710656n) }),
      "EXPIRED_AT_INVALID",
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * §8.1 / §8.5 — the grouping switch
 * ---------------------------------------------------------------------------------------------- */

describe("grouping type", () => {
  test("0 is the base sentinel and is always invalid", () => {
    expectCode(() => validateCreateGroupedOrders(mkTx(0, OTO)), "GROUPING_TYPE_INVALID");
  });

  test("4 is invalid", () => {
    expectCode(() => validateCreateGroupedOrders(mkTx(4, OTO)), "GROUPING_TYPE_INVALID");
  });
});

describe("OTO (1)", () => {
  const oto = (legs: readonly LegSpec[]): CreateGroupedOrdersTx =>
    mkTx(GroupingType.OneTriggersTheOther, legs);

  test("a three-leg OTO fails inside the switch", () => {
    expectCode(() => validateCreateGroupedOrders(oto(OTOCO)), "ORDER_GROUP_SIZE_INVALID");
  });

  test("a sized child is BASE_AMOUNT_NOT_NIL", () => {
    expectCode(
      () => validateCreateGroupedOrders(oto([PARENT, { ...CHILD_SL, baseAmount: 500n }])),
      "BASE_AMOUNT_NOT_NIL",
    );
  });

  test("a nil-sized parent is fine — only the child's size is constrained", () => {
    expect(() =>
      validateCreateGroupedOrders(oto([{ ...PARENT, baseAmount: 0n, reduceOnly: 1 }, CHILD_SL])),
    ).not.toThrow();
  });

  test("same-side legs are IS_ASK_INVALID", () => {
    expectCode(
      () => validateCreateGroupedOrders(oto([PARENT, { ...CHILD_SL, isAsk: 0 }])),
      "IS_ASK_INVALID",
    );
  });

  test("a set parent expiry must equal the child's", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(oto([PARENT, { ...CHILD_SL, orderExpiry: EXPIRY + 1n }])),
      "ORDER_EXPIRY_INVALID",
    );
  });

  test("a nil parent expiry imposes nothing on the child", () => {
    // An IOC limit parent legally carries no expiry; the child keeps its own.
    expect(() =>
      validateCreateGroupedOrders(
        oto([{ ...PARENT, timeInForce: 0, orderExpiry: 0n }, CHILD_SL]),
      ),
    ).not.toThrow();
  });

  test("parent rules apply to leg 0 and child rules to leg 1", () => {
    expectCode(
      () => validateCreateGroupedOrders(oto([{ ...PARENT, type: 6 }, CHILD_SL])),
      "ORDER_TYPE_INVALID",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(
          oto([PARENT, { ...CHILD_SL, type: 0, triggerPrice: 0, isAsk: 1, reduceOnly: 1 }]),
        ),
      "ORDER_TYPE_INVALID",
    );
  });

  test("either child family is a legal OTO child", () => {
    expect(() => validateCreateGroupedOrders(oto([PARENT, CHILD_TP]))).not.toThrow();
    expect(() =>
      validateCreateGroupedOrders(oto([PARENT, { ...CHILD_SL, type: 3, timeInForce: 1 }])),
    ).not.toThrow();
  });

  test("reduce-only is not required on either leg", () => {
    expect(() =>
      validateCreateGroupedOrders(
        oto([PARENT, { ...CHILD_SL, reduceOnly: 0, baseAmount: 0n, price: 4000 }]),
      ),
    ).toThrow(); // nil size needs reduce-only — §7.8 step 8, not a grouping rule
    expect(() =>
      validateCreateGroupedOrders(oto([{ ...PARENT, reduceOnly: 0 }, CHILD_SL])),
    ).not.toThrow();
  });
});

describe("OCO (2)", () => {
  const oco = (legs: readonly LegSpec[]): CreateGroupedOrdersTx =>
    mkTx(GroupingType.OneCancelsTheOther, legs);

  test("a three-leg OCO fails inside the switch", () => {
    expectCode(() => validateCreateGroupedOrders(oco(OTOCO)), "ORDER_GROUP_SIZE_INVALID");
  });

  test("unequal sizes are BASE_AMOUNTS_NOT_EQUAL", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          oco([
            { ...CHILD_SL, baseAmount: 100n },
            { ...CHILD_TP, baseAmount: 200n },
          ]),
        ),
      "BASE_AMOUNTS_NOT_EQUAL",
    );
  });

  test("equal non-nil sizes are legal", () => {
    expect(() =>
      validateCreateGroupedOrders(
        oco([
          { ...CHILD_SL, baseAmount: 100n },
          { ...CHILD_TP, baseAmount: 100n },
        ]),
      ),
    ).not.toThrow();
  });

  test("opposite sides are IS_ASK_INVALID — an OCO pair shares a direction", () => {
    expectCode(
      () => validateCreateGroupedOrders(oco([CHILD_SL, { ...CHILD_TP, isAsk: 0 }])),
      "IS_ASK_INVALID",
    );
  });

  test("both legs must be reduce-only", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          oco([CHILD_SL, { ...CHILD_TP, reduceOnly: 0, baseAmount: 0n }]),
        ),
      // The nil-size core rule fires first for a nil-sized non-reduce-only leg.
      "BASE_AMOUNT_TOO_LOW",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(
          oco([
            { ...CHILD_SL, baseAmount: 100n },
            { ...CHILD_TP, baseAmount: 100n, reduceOnly: 0 },
          ]),
        ),
      "ORDER_REDUCE_ONLY_INVALID",
    );
  });

  test("mismatched expiries are ORDER_EXPIRY_INVALID, even though neither is nil-exempt", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(oco([CHILD_SL, { ...CHILD_TP, orderExpiry: EXPIRY + 1n }])),
      "ORDER_EXPIRY_INVALID",
    );
  });

  test("two stop-losses are ORDER_TYPE_INVALID", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(oco([CHILD_SL, { ...CHILD_TP, type: 2, timeInForce: 0 }])),
      "ORDER_TYPE_INVALID",
    );
  });

  test("two take-profits are ORDER_TYPE_INVALID", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(oco([{ ...CHILD_SL, type: 4, timeInForce: 0 }, CHILD_TP])),
      "ORDER_TYPE_INVALID",
    );
  });

  test("mixed limit/market variants across the families are legal", () => {
    // `3` (StopLossLimit) + `4` (TakeProfit) is one of each family.
    expect(() =>
      validateCreateGroupedOrders(oco([{ ...CHILD_SL, type: 3, timeInForce: 2 }, CHILD_TP])),
    ).not.toThrow();
  });

  test("a limit leg is not a legal sibling", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          oco([{ ...CHILD_SL, type: 0, triggerPrice: 0, timeInForce: 1 }, CHILD_TP]),
        ),
      "ORDER_TYPE_INVALID",
    );
  });
});

describe("OTOCO (3)", () => {
  const otoco = (legs: readonly LegSpec[]): CreateGroupedOrdersTx =>
    mkTx(GroupingType.OneTriggersAOneCancelsTheOther, legs);

  test("a two-leg OTOCO fails inside the switch, not at the §8.2 gate", () => {
    expectCode(() => validateCreateGroupedOrders(otoco(OTO)), "ORDER_GROUP_SIZE_INVALID");
  });

  test("either sized child is BASE_AMOUNT_NOT_NIL", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(otoco([PARENT, { ...CHILD_SL, baseAmount: 10n }, CHILD_TP])),
      "BASE_AMOUNT_NOT_NIL",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(otoco([PARENT, CHILD_SL, { ...CHILD_TP, baseAmount: 10n }])),
      "BASE_AMOUNT_NOT_NIL",
    );
  });

  test("the parent must oppose each child", () => {
    expectCode(
      () => validateCreateGroupedOrders(otoco([PARENT, { ...CHILD_SL, isAsk: 0 }, CHILD_TP])),
      "IS_ASK_INVALID",
    );
    expectCode(
      () => validateCreateGroupedOrders(otoco([PARENT, CHILD_SL, { ...CHILD_TP, isAsk: 0 }])),
      "IS_ASK_INVALID",
    );
  });

  test("mismatched child expiries are ORDER_EXPIRY_INVALID", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          otoco([
            { ...PARENT, orderExpiry: 0n, timeInForce: 0 },
            CHILD_SL,
            { ...CHILD_TP, orderExpiry: EXPIRY + 1n },
          ]),
        ),
      "ORDER_EXPIRY_INVALID",
    );
  });

  test("a set parent expiry must match the children's", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          otoco([
            { ...PARENT, orderExpiry: EXPIRY + 1n },
            CHILD_SL,
            CHILD_TP,
          ]),
        ),
      "ORDER_EXPIRY_INVALID",
    );
  });

  test("a nil parent expiry imposes nothing", () => {
    expect(() =>
      validateCreateGroupedOrders(
        otoco([{ ...PARENT, timeInForce: 0, orderExpiry: 0n }, CHILD_SL, CHILD_TP]),
      ),
    ).not.toThrow();
  });

  test("parent rules apply, and a TWAP parent is rejected", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(otoco([{ ...PARENT, type: 6 }, CHILD_SL, CHILD_TP])),
      "ORDER_TYPE_INVALID",
    );
  });

  test("the tail pair is a sibling pair — two stop-losses are rejected", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          otoco([PARENT, CHILD_SL, { ...CHILD_TP, type: 2, timeInForce: 0 }]),
        ),
      "ORDER_TYPE_INVALID",
    );
  });

  test("the children need not be reduce-only when the parent is not", () => {
    expect(() =>
      validateCreateGroupedOrders(
        otoco([
          { ...PARENT, reduceOnly: 0 },
          { ...CHILD_SL, reduceOnly: 1 },
          { ...CHILD_TP, reduceOnly: 1 },
        ]),
      ),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * §8.3 / §8.4 — the exported per-leg rules
 * ---------------------------------------------------------------------------------------------- */

describe("validateParentOrder (§8.3)", () => {
  test("Limit and Market are the only parent types", () => {
    expect(() => validateParentOrder(mkLeg(PARENT))).not.toThrow();
    expect(() =>
      validateParentOrder(mkLeg({ ...PARENT, type: 1, timeInForce: 0, orderExpiry: 0n })),
    ).not.toThrow();
    for (const type of [2, 3, 4, 5, 6, 7, 8, 9]) {
      expectCode(
        () => validateParentOrder(mkLeg({ ...PARENT, type })),
        "ORDER_TYPE_INVALID",
      );
    }
  });

  test("a Market parent needs IOC, no expiry and no trigger", () => {
    const market: LegSpec = { ...PARENT, type: 1, timeInForce: 0, orderExpiry: 0n };
    expectCode(
      () => validateParentOrder(mkLeg({ ...market, timeInForce: 1 })),
      "ORDER_TIF_INVALID",
    );
    expectCode(
      () => validateParentOrder(mkLeg({ ...market, orderExpiry: EXPIRY })),
      "ORDER_EXPIRY_INVALID",
    );
    expectCode(
      () => validateParentOrder(mkLeg({ ...market, triggerPrice: 4100 })),
      "ORDER_TRIGGER_PRICE_INVALID",
    );
  });

  test("a Limit parent couples TIF and expiry in both directions", () => {
    // IOC + expiry.
    expectCode(
      () =>
        validateParentOrder(mkLeg({ ...PARENT, timeInForce: 0, orderExpiry: EXPIRY })),
      "ORDER_EXPIRY_INVALID",
    );
    // GoodTillTime + no expiry.
    expectCode(
      () => validateParentOrder(mkLeg({ ...PARENT, timeInForce: 1, orderExpiry: 0n })),
      "ORDER_EXPIRY_INVALID",
    );
    // PostOnly + no expiry — the "not IOC" half covers TIF 2 as well.
    expectCode(
      () => validateParentOrder(mkLeg({ ...PARENT, timeInForce: 2, orderExpiry: 0n })),
      "ORDER_EXPIRY_INVALID",
    );
    expect(() =>
      validateParentOrder(mkLeg({ ...PARENT, timeInForce: 2, orderExpiry: EXPIRY })),
    ).not.toThrow();
  });

  test("a Limit parent may not carry a trigger price", () => {
    expectCode(
      () => validateParentOrder(mkLeg({ ...PARENT, triggerPrice: 4100 })),
      "ORDER_TRIGGER_PRICE_INVALID",
    );
  });
});

describe("validateChildOrder (§8.4)", () => {
  test("only types 2, 3, 4 and 5 may be children", () => {
    for (const type of [0, 1, 6, 7, 8, 9]) {
      expectCode(
        () => validateChildOrder(mkLeg({ ...CHILD_SL, type })),
        "ORDER_TYPE_INVALID",
      );
    }
    for (const type of [2, 3, 4, 5]) {
      expect(() => validateChildOrder(mkLeg({ ...CHILD_SL, type }))).not.toThrow();
    }
  });

  test("types 2 and 4 require IOC", () => {
    for (const type of [2, 4]) {
      expectCode(
        () => validateChildOrder(mkLeg({ ...CHILD_SL, type, timeInForce: 1 })),
        "ORDER_TIF_INVALID",
      );
    }
  });

  test("types 3 and 5 carry NO time-in-force constraint", () => {
    // Not covered by any vector: all three grouped rows use `TimeInForce: 0` on their children.
    for (const type of [3, 5]) {
      for (const timeInForce of [0, 1, 2]) {
        expect(() =>
          validateChildOrder(mkLeg({ ...CHILD_SL, type, timeInForce })),
        ).not.toThrow();
      }
    }
  });

  test("every child type requires a trigger price and an expiry", () => {
    for (const type of [2, 3, 4, 5]) {
      expectCode(
        () => validateChildOrder(mkLeg({ ...CHILD_SL, type, triggerPrice: 0 })),
        "ORDER_TRIGGER_PRICE_INVALID",
      );
      expectCode(
        () => validateChildOrder(mkLeg({ ...CHILD_SL, type, orderExpiry: 0n })),
        "ORDER_EXPIRY_INVALID",
      );
    }
  });
});

describe("validateSiblingPair (§8.4)", () => {
  test("one of each family, in either order", () => {
    expect(() => validateSiblingPair(mkLeg(CHILD_SL), mkLeg(CHILD_TP))).not.toThrow();
    expect(() => validateSiblingPair(mkLeg(CHILD_TP), mkLeg(CHILD_SL))).not.toThrow();
  });

  test("every cross-family combination of the four types is legal", () => {
    for (const sl of [2, 3]) {
      for (const tp of [4, 5]) {
        expect(() =>
          validateSiblingPair(
            mkLeg({ ...CHILD_SL, type: sl, timeInForce: 0 }),
            mkLeg({ ...CHILD_TP, type: tp, timeInForce: 0 }),
          ),
        ).not.toThrow();
      }
    }
  });

  test("same-family pairs are ORDER_TYPE_INVALID", () => {
    for (const [a, b] of [
      [2, 2],
      [2, 3],
      [3, 3],
      [4, 4],
      [4, 5],
      [5, 5],
    ] as const) {
      expectCode(
        () =>
          validateSiblingPair(
            mkLeg({ ...CHILD_SL, type: a, timeInForce: 0 }),
            mkLeg({ ...CHILD_TP, type: b, timeInForce: 0 }),
          ),
        "ORDER_TYPE_INVALID",
      );
    }
  });

  test("each leg is child-validated before the family rule", () => {
    expectCode(
      () => validateSiblingPair(mkLeg({ ...CHILD_SL, triggerPrice: 0 }), mkLeg(CHILD_TP)),
      "ORDER_TRIGGER_PRICE_INVALID",
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * §8.6 / §15 row 8 — the strict-mode addition
 * ---------------------------------------------------------------------------------------------- */

describe("CHILD_REDUCE_ONLY_MISMATCH (strict only)", () => {
  /**
   * The reachable shape, and the reason it is the only one.
   *
   * §8.2's core rule already rejects a nil-sized leg that is not reduce-only, and OTO/OTOCO require
   * their children to be nil-sized — so a non-reduce-only child is necessarily a *sized* one, which
   * the reference rejects at rule 1 of the arm as `BASE_AMOUNT_NOT_NIL`. The §8.6 check therefore
   * runs ahead of §8.5, and the observable difference between the modes is which of the two codes a
   * doubly-invalid transaction reports.
   */
  const reduceOnlyParent: LegSpec = { ...PARENT, reduceOnly: 1 };
  const sizedPlainChild: LegSpec = { ...CHILD_SL, reduceOnly: 0, baseAmount: 5n };

  test("OTO: fires by default when the parent is reduce-only and the child is not", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [reduceOnlyParent, sizedPlainChild]),
        ),
      "CHILD_REDUCE_ONLY_MISMATCH",
    );
  });

  test("OTO: does not fire under { strict: false } — the reference code wins", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersTheOther, [reduceOnlyParent, sizedPlainChild]),
          { strict: false },
        ),
      "BASE_AMOUNT_NOT_NIL",
    );
  });

  test("OTOCO: fires for either child by default", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
            reduceOnlyParent,
            sizedPlainChild,
            CHILD_TP,
          ]),
        ),
      "CHILD_REDUCE_ONLY_MISMATCH",
    );
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
            reduceOnlyParent,
            CHILD_SL,
            { ...CHILD_TP, reduceOnly: 0, baseAmount: 5n },
          ]),
        ),
      "CHILD_REDUCE_ONLY_MISMATCH",
    );
  });

  test("OTOCO: does not fire under { strict: false }", () => {
    expectCode(
      () =>
        validateCreateGroupedOrders(
          mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
            reduceOnlyParent,
            sizedPlainChild,
            CHILD_TP,
          ]),
          { strict: false },
        ),
      "BASE_AMOUNT_NOT_NIL",
    );
  });

  test("a reduce-only parent with reduce-only children is unaffected", () => {
    expect(() =>
      validateCreateGroupedOrders(
        mkTx(GroupingType.OneTriggersAOneCancelsTheOther, [
          reduceOnlyParent,
          CHILD_SL,
          CHILD_TP,
        ]),
      ),
    ).not.toThrow();
  });

  test("a non-reduce-only parent imposes nothing, so the vectors are untouched in either mode", () => {
    for (const name of [
      "create_grouped_orders/oto",
      "create_grouped_orders/oco",
      "create_grouped_orders/otoco",
    ]) {
      expect(() => validateCreateGroupedOrders(groupedFromVector(name))).not.toThrow();
      expect(() =>
        validateCreateGroupedOrders(groupedFromVector(name), { strict: false }),
      ).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Purity
 * ---------------------------------------------------------------------------------------------- */

describe("the validator is side-effect-free", () => {
  test("it does not mutate or reorder Orders", () => {
    const tx: CreateGroupedOrdersTx = groupedFromVector("create_grouped_orders/otoco");
    const before: string = JSON.stringify(tx.orders, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const identities: readonly OrderInfo[] = [...tx.orders];

    validateCreateGroupedOrders(tx);
    validateCreateGroupedOrders(tx, { strict: false });

    const after: string = JSON.stringify(tx.orders, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(after).toBe(before);
    expect(tx.orders.length).toBe(identities.length);
    for (let i = 0; i < identities.length; i += 1) {
      expect(tx.orders[i]).toBe(identities[i] as never);
    }
  });

  test("a failing validation leaves the input untouched too", () => {
    const tx: CreateGroupedOrdersTx = mkTx(GroupingType.OneTriggersTheOther, [
      PARENT,
      { ...CHILD_SL, baseAmount: 500n },
    ]);
    const snapshot: readonly OrderInfo[] = [...tx.orders];
    expect(() => validateCreateGroupedOrders(tx)).toThrow(LighterValidationError);
    for (let i = 0; i < snapshot.length; i += 1) {
      expect(tx.orders[i]).toBe(snapshot[i] as never);
    }
  });
});
