/**
 * `src/client/brackets.ts` — the three conditional order shapes, and the legality table that
 * refuses the rest.
 *
 * Two kinds of assertion, and the first is the important one.
 *
 * **Conformance.** The three `create_grouped_orders/{oto,oco,otoco}` rows of
 * `conformance/vectors/tx.json` are reproduced by driving `MarketHandle.oto()`,
 * `positionBracket()` and `bracket()` with *equivalent human input* — decimal strings against a
 * market whose declared precision turns them into the vector's integers — and comparing the
 * resulting transaction hash. A hash match means the legs, their order, their types, their sides,
 * their sizes and their expiries are all byte-identical to the oracle's; nothing else in this file
 * could establish that.
 *
 * **Legality.** Every row of the OTO / OCO / OTOCO table has a rejecting case, and each one is
 * asserted to reject **locally** — before any I/O and before anything is signed — by checking that
 * the fake transport recorded nothing.
 *
 * Vectors are read at run time rather than transcribed: a number typed into a test is a number that
 * can be typed wrong.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { LighterAccount } from "../../src/client/account.js";
import { assertGroupLegality, buildOtoco } from "../../src/client/brackets.js";
import type { MarketInfo } from "../../src/client/markets.js";
import type { BookSnapshot } from "../../src/client/math/index.js";
import {
  type AppliedReceipt,
  MarketHandle,
  type MarketContext,
} from "../../src/client/market-handle.js";
import { createLease } from "../../src/client/nonce/types.js";
import type { NonceLease, NonceSnapshot, NonceSource } from "../../src/client/nonce/types.js";
import type { SubmitContext } from "../../src/client/submit.js";
import { ApiKey } from "../../src/crypto/key.js";
import { i16, i64, u8, u32 } from "../../src/tx/brands.js";
import { GroupingType, OrderTimeInForce, OrderType } from "../../src/tx/enums.js";
import type { OrderInfo } from "../../src/tx/types/orders.js";

/* ---------------------------------------------------------------------------------------------- */
/* Vectors                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface VectorRow {
  readonly name: string;
  readonly messageHashLeHex: string;
  readonly fields: Record<string, string>;
}

const VECTORS: { readonly chainId: number; readonly txHashes: readonly VectorRow[] } = JSON.parse(
  readFileSync(new URL("../../conformance/vectors/tx.json", import.meta.url), "utf8"),
) as { chainId: number; txHashes: VectorRow[] };

function vector(name: string): VectorRow {
  const found: VectorRow | undefined = VECTORS.txHashes.find((r: VectorRow): boolean => r.name === name);
  if (found === undefined) throw new Error(`no vector named ${name}`);
  return found;
}

/** A vector field as the `bigint` it is. Never through a float. */
function field(row: VectorRow, key: string): bigint {
  const raw: string | undefined = row.fields[key];
  if (raw === undefined) throw new Error(`vector ${row.name} has no field ${key}`);
  return BigInt(raw);
}

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const KEY: ApiKey = ApiKey.fromPrivateKey(
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a",
);

const NOW_MS: 1_700_000_000_000 = 1_700_000_000_000;

/**
 * The market the vectors imply: index 1, two price decimals, four size decimals.
 *
 * So `"50.00"` is the vector's `Price: 5000`, `"0.1"` is its `BaseAmount: 1000`, and `"41.00"` is
 * its `TriggerPrice: 4100`. Those are the *only* magic numbers in this file and they are the
 * market's own exponents.
 */
function aMarket(over: Partial<MarketInfo> = {}): MarketInfo {
  return Object.freeze({
    marketId: 1,
    symbol: "ETH",
    marketType: "perp",
    status: "active",
    sizeDecimals: 4,
    priceDecimals: 2,
    quoteDecimals: 6,
    minBaseAmount: "0.0010",
    minQuoteAmount: "0",
    orderQuoteLimit: "0",
    takerFee: "0.0000",
    makerFee: "0.0000",
    isTakerFeeEnabled: false,
    isMakerFeeEnabled: false,
    baseAssetId: 1,
    quoteAssetId: 3,
    quoteSizingSupported: true,
    ...over,
  }) as MarketInfo;
}

const EMPTY_BOOK: BookSnapshot = Object.freeze({ bids: [], asks: [] });

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

class TestNonces implements NonceSource {
  readonly kind: "optimistic" = "optimistic";
  lease(preferKey?: number): Promise<NonceLease> {
    return Promise.resolve(
      createLease({ apiKeyIndex: preferKey ?? 0, nonce: 0n, onRelease: (): void => {} }),
    );
  }
  resync(): Promise<void> {
    return Promise.resolve();
  }
  snapshot(): NonceSnapshot {
    return { version: 1, kind: "optimistic", accountIndex: 1, keys: [] };
  }
  restore(): void {}
}

interface Harness {
  readonly handle: MarketHandle;
  /** Every submission that reached the transport. Empty means the refusal was local. */
  readonly sent: string[];
}

function harness(market: MarketInfo = aMarket()): Harness {
  const sent: string[] = [];
  const refuse = (): never => {
    throw new Error("this test must not reach the network");
  };
  const transaction = {
    sendTx: (p: { tx_type: number; tx_info: string }): Promise<{ code: number; tx_hash: string }> => {
      sent.push(p.tx_info);
      return Promise.resolve({ code: 200, tx_hash: "" });
    },
    sendTxBatch: refuse,
    tx: refuse,
  };
  const ctx: SubmitContext = {
    chainId: VECTORS.chainId,
    accountIndex: 1n,
    rest: { transaction } as unknown as SubmitContext["rest"],
    nonces: new TestNonces(),
    keys: new Map<number, ApiKey>([[0, KEY]]),
    channel: "http",
    now: (): number => NOW_MS,
  };
  const account: LighterAccount = new LighterAccount({
    chainId: VECTORS.chainId,
    ctx,
    rest: { account: { account: refuse, accountsByL1Address: refuse } } as never,
    defaultTxExpiryMs: 599_000,
    now: (): number => NOW_MS,
  });
  const context: MarketContext = {
    chainId: VECTORS.chainId,
    account,
    markets: { get: (): MarketInfo => market },
    books: { snapshot: (): Promise<BookSnapshot> => Promise.resolve(EMPTY_BOOK) },
    now: (): number => NOW_MS,
  };
  return { handle: new MarketHandle(context, market), sent };
}

/** The `code` of a thrown Lighter error. */
async function codeOf(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected a rejection");
}

/* ---------------------------------------------------------------------------------------------- */
/* Conformance                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("the three grouped-order vectors, driven through the facade", (): void => {
  test("create_grouped_orders/oto", async (): Promise<void> => {
    const row: VectorRow = vector("create_grouped_orders/oto");
    const expiry: bigint = field(row, "Order0.OrderExpiry");
    const h: Harness = harness();

    const receipt: AppliedReceipt = await h.handle.oto({
      entry: {
        side: "buy",
        size: "0.1",
        price: "50.00",
        clientOrderId: field(row, "Order0.ClientOrderIndex"),
        expiry,
      },
      exitFamily: "stopLoss",
      exit: {
        triggerPrice: "41.00",
        price: "40.00",
        clientOrderId: field(row, "Order1.ClientOrderIndex"),
        expiry,
      },
      dryRun: true,
      send: { nonce: field(row, "Nonce"), apiKeyIndex: 0 },
      tx: { expiredAt: field(row, "ExpiredAt") },
    });

    expect(receipt.txHash).toBe(`0x${row.messageHashLeHex}`);
    expect(receipt.legs).toHaveLength(2);
    expect(receipt.legs?.[0]?.baseAmount).toBe(field(row, "Order0.BaseAmount"));
    expect(receipt.legs?.[1]?.baseAmount).toBe(field(row, "Order1.BaseAmount"));
    expect(receipt.legs?.[1]?.triggerPrice).toBe(field(row, "Order1.TriggerPrice"));
  });

  test("create_grouped_orders/oco", async (): Promise<void> => {
    const row: VectorRow = vector("create_grouped_orders/oco");
    const expiry: bigint = field(row, "Order0.OrderExpiry");
    const h: Harness = harness();

    const receipt: AppliedReceipt = await h.handle.positionBracket({
      // Both legs are asks in the vector: a stop and a target over one long are both sells.
      side: "sell",
      stopLoss: {
        triggerPrice: "41.00",
        price: "40.00",
        clientOrderId: field(row, "Order0.ClientOrderIndex"),
        expiry,
      },
      takeProfit: {
        triggerPrice: "59.00",
        price: "60.00",
        clientOrderId: field(row, "Order1.ClientOrderIndex"),
        expiry,
      },
      dryRun: true,
      send: { nonce: field(row, "Nonce"), apiKeyIndex: 0 },
      tx: { expiredAt: field(row, "ExpiredAt") },
    });

    expect(receipt.txHash).toBe(`0x${row.messageHashLeHex}`);
    expect(receipt.legs).toHaveLength(2);
  });

  test("create_grouped_orders/otoco", async (): Promise<void> => {
    const row: VectorRow = vector("create_grouped_orders/otoco");
    const expiry: bigint = field(row, "Order0.OrderExpiry");
    const h: Harness = harness();

    const receipt: AppliedReceipt = await h.handle.bracket({
      entry: {
        side: "buy",
        size: "0.25",
        price: "50.00",
        clientOrderId: field(row, "Order0.ClientOrderIndex"),
        expiry,
      },
      stopLoss: {
        triggerPrice: "41.00",
        price: "40.00",
        clientOrderId: field(row, "Order1.ClientOrderIndex"),
        expiry,
      },
      takeProfit: {
        triggerPrice: "59.00",
        price: "60.00",
        clientOrderId: field(row, "Order2.ClientOrderIndex"),
        expiry,
      },
      dryRun: true,
      send: { nonce: field(row, "Nonce"), apiKeyIndex: 0 },
      tx: { expiredAt: field(row, "ExpiredAt") },
    });

    expect(receipt.txHash).toBe(`0x${row.messageHashLeHex}`);
    expect(receipt.legs).toHaveLength(3);
    expect(receipt.legs?.[0]?.baseAmount).toBe(field(row, "Order0.BaseAmount"));
    // The children are nil-sized: they inherit whatever the parent filled.
    expect(receipt.legs?.[1]?.baseAmount).toBe(0n);
    expect(receipt.legs?.[2]?.baseAmount).toBe(0n);
  });

  test("the legs reach the builder in protocol order, unsorted", (): void => {
    const row: VectorRow = vector("create_grouped_orders/otoco");
    const expiry: bigint = field(row, "Order0.OrderExpiry");
    const plan = buildOtoco(
      aMarket(),
      {
        entry: { side: "buy", size: "0.25", price: "50.00", clientOrderId: 2_005n, expiry },
        stopLoss: { triggerPrice: "41.00", price: "40.00", clientOrderId: 2_006n, expiry },
        takeProfit: { triggerPrice: "59.00", price: "60.00", clientOrderId: 2_007n, expiry },
      },
      (): number => NOW_MS,
    );
    // Parent, then stop-loss, then take-profit — the fold is seeded with leg 0, so this is not a
    // presentation choice.
    expect(plan.orders.map((o: OrderInfo): number => o.type)).toEqual([
      OrderType.Limit,
      OrderType.StopLoss,
      OrderType.TakeProfit,
    ]);
    expect(plan.groupingType).toBe(GroupingType.OneTriggersAOneCancelsTheOther);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Legality                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** A hand-built leg, so a rule can be broken one field at a time. */
function leg(over: {
  clientOrderIndex?: bigint;
  baseAmount?: bigint;
  price?: number;
  isAsk?: 0 | 1;
  type?: number;
  timeInForce?: number;
  reduceOnly?: 0 | 1;
  triggerPrice?: number;
  orderExpiry?: bigint;
  marketIndex?: number;
}): OrderInfo {
  return {
    marketIndex: i16(over.marketIndex ?? 1),
    clientOrderIndex: i64(over.clientOrderIndex ?? 0n),
    baseAmount: i64(over.baseAmount ?? 0n),
    price: u32(over.price ?? 5_000),
    isAsk: u8(over.isAsk ?? 0),
    type: u8(over.type ?? OrderType.Limit),
    timeInForce: u8(over.timeInForce ?? OrderTimeInForce.GoodTillTime),
    reduceOnly: u8(over.reduceOnly ?? 0),
    triggerPrice: u32(over.triggerPrice ?? 0),
    orderExpiry: i64(over.orderExpiry ?? 1_893_456_000_000n),
  };
}

/** A legal stop-loss child. */
function stopChild(over: Parameters<typeof leg>[0] = {}): OrderInfo {
  return leg({
    type: OrderType.StopLoss,
    timeInForce: OrderTimeInForce.ImmediateOrCancel,
    triggerPrice: 4_100,
    price: 4_000,
    isAsk: 1,
    reduceOnly: 1,
    ...over,
  });
}

/** A legal take-profit child. */
function profitChild(over: Parameters<typeof leg>[0] = {}): OrderInfo {
  return leg({
    type: OrderType.TakeProfit,
    timeInForce: OrderTimeInForce.ImmediateOrCancel,
    triggerPrice: 5_900,
    price: 6_000,
    isAsk: 1,
    reduceOnly: 1,
    ...over,
  });
}

/** The parent of an OTO / OTOCO: a buy limit. */
function parentLeg(over: Parameters<typeof leg>[0] = {}): OrderInfo {
  return leg({ baseAmount: 1_000n, ...over });
}

function reject(groupingType: number, orders: readonly OrderInfo[], market?: MarketInfo): unknown {
  try {
    assertGroupLegality(market ?? aMarket(), groupingType, orders);
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected a rejection");
}

describe("group legality, enforced locally before signing", (): void => {
  test("a legal OTOCO passes", (): void => {
    expect(() =>
      assertGroupLegality(aMarket(), GroupingType.OneTriggersAOneCancelsTheOther, [
        parentLeg({ clientOrderIndex: 1n }),
        stopChild({ clientOrderIndex: 2n }),
        profitChild({ clientOrderIndex: 3n }),
      ]),
    ).not.toThrow();
  });

  test("OCO: mismatched base amounts", (): void => {
    expect(
      reject(GroupingType.OneCancelsTheOther, [
        stopChild({ clientOrderIndex: 1n, baseAmount: 1_000n }),
        profitChild({ clientOrderIndex: 2n, baseAmount: 2_000n }),
      ]),
    ).toBe("BASE_AMOUNTS_NOT_EQUAL");
  });

  test("OCO: opposite sides", (): void => {
    expect(
      reject(GroupingType.OneCancelsTheOther, [
        stopChild({ clientOrderIndex: 1n, isAsk: 1 }),
        profitChild({ clientOrderIndex: 2n, isAsk: 0 }),
      ]),
    ).toBe("IS_ASK_INVALID");
  });

  test("OCO: a leg that is not reduce-only", (): void => {
    expect(
      reject(GroupingType.OneCancelsTheOther, [
        stopChild({ clientOrderIndex: 1n, baseAmount: 1_000n, reduceOnly: 0 }),
        profitChild({ clientOrderIndex: 2n, baseAmount: 1_000n, reduceOnly: 1 }),
      ]),
    ).toBe("ORDER_REDUCE_ONLY_INVALID");
  });

  test("OCO: differing expiries", (): void => {
    expect(
      reject(GroupingType.OneCancelsTheOther, [
        stopChild({ clientOrderIndex: 1n, orderExpiry: 1_893_456_000_000n }),
        profitChild({ clientOrderIndex: 2n, orderExpiry: 1_893_456_000_001n }),
      ]),
    ).toBe("ORDER_EXPIRY_INVALID");
  });

  test("OCO: two stop-losses have no exit on the other side", (): void => {
    expect(
      reject(GroupingType.OneCancelsTheOther, [
        stopChild({ clientOrderIndex: 1n }),
        stopChild({ clientOrderIndex: 2n }),
      ]),
    ).toBe("ORDER_TYPE_INVALID");
  });

  test("OTO: both legs on the same side", (): void => {
    expect(
      reject(GroupingType.OneTriggersTheOther, [
        parentLeg({ clientOrderIndex: 1n, isAsk: 1 }),
        stopChild({ clientOrderIndex: 2n, isAsk: 1 }),
      ]),
    ).toBe("IS_ASK_INVALID");
  });

  test("OTO: a sized child", (): void => {
    expect(
      reject(GroupingType.OneTriggersTheOther, [
        parentLeg({ clientOrderIndex: 1n }),
        stopChild({ clientOrderIndex: 2n, baseAmount: 500n }),
      ]),
    ).toBe("BASE_AMOUNT_NOT_NIL");
  });

  test("OTO: a limit parent with a limit child", (): void => {
    expect(
      reject(GroupingType.OneTriggersTheOther, [
        parentLeg({ clientOrderIndex: 1n }),
        leg({ clientOrderIndex: 2n, isAsk: 1, type: OrderType.Limit, reduceOnly: 1 }),
      ]),
    ).toBe("ORDER_TYPE_INVALID");
  });

  test("OTO: one leg where two are required", (): void => {
    expect(reject(GroupingType.OneTriggersTheOther, [parentLeg({ clientOrderIndex: 1n })])).toBe(
      "ORDER_GROUP_SIZE_INVALID",
    );
  });

  test("OTOCO: a non-nil child size", (): void => {
    expect(
      reject(GroupingType.OneTriggersAOneCancelsTheOther, [
        parentLeg({ clientOrderIndex: 1n }),
        stopChild({ clientOrderIndex: 2n, baseAmount: 500n }),
        profitChild({ clientOrderIndex: 3n }),
      ]),
    ).toBe("BASE_AMOUNT_NOT_NIL");
  });

  test("four legs are more than the protocol allows", (): void => {
    expect(
      reject(GroupingType.OneTriggersAOneCancelsTheOther, [
        parentLeg({ clientOrderIndex: 1n }),
        stopChild({ clientOrderIndex: 2n }),
        profitChild({ clientOrderIndex: 3n }),
        profitChild({ clientOrderIndex: 4n }),
      ]),
    ).toBe("ORDER_GROUP_SIZE_INVALID");
  });

  test("duplicate client order indexes within one group", (): void => {
    expect(
      reject(GroupingType.OneTriggersAOneCancelsTheOther, [
        parentLeg({ clientOrderIndex: 7n }),
        stopChild({ clientOrderIndex: 7n }),
        profitChild({ clientOrderIndex: 8n }),
      ]),
    ).toBe("CLIENT_ORDER_INDEX_DUPLICATE");
  });

  test("legs on different markets", (): void => {
    expect(
      reject(GroupingType.OneTriggersTheOther, [
        parentLeg({ clientOrderIndex: 1n, marketIndex: 1 }),
        stopChild({ clientOrderIndex: 2n, marketIndex: 2 }),
      ]),
    ).toBe("MARKET_INDEX_MISMATCH");
  });

  test("a spot market, which the registry knows even where the index range would not", (): void => {
    const spot: MarketInfo = aMarket({ marketId: 2048, marketType: "spot" });
    expect(
      reject(
        GroupingType.OneTriggersTheOther,
        [parentLeg({ clientOrderIndex: 1n }), stopChild({ clientOrderIndex: 2n })],
        spot,
      ),
    ).toBe("MARKET_INDEX_NOT_PERPS");
  });

  test("an unknown grouping type", (): void => {
    expect(
      reject(0, [parentLeg({ clientOrderIndex: 1n }), stopChild({ clientOrderIndex: 2n })]),
    ).toBe("GROUPING_TYPE_INVALID");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Ergonomic refusals                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("the ergonomic layer refuses before any I/O", (): void => {
  test("a bracket child cannot face the same way as its parent", async (): Promise<void> => {
    const h: Harness = harness();
    expect(
      await codeOf(() =>
        h.handle.bracket({
          entry: { side: "buy", size: "0.1", price: "50.00" },
          // A long's exits are sells; saying `buy` here would double the position, not close it.
          stopLoss: { side: "buy", triggerPrice: "41.00", price: "40.00" },
          takeProfit: { triggerPrice: "59.00", price: "60.00" },
        }),
      ),
    ).toBe("IS_ASK_INVALID");
    expect(h.sent).toHaveLength(0);
  });

  test("a bracket on a spot market is refused, naming the market", async (): Promise<void> => {
    const h: Harness = harness(aMarket({ marketId: 2048, marketType: "spot" }));
    expect(
      await codeOf(() =>
        h.handle.bracket({
          entry: { side: "buy", size: "0.1", price: "50.00" },
          stopLoss: { triggerPrice: "41.00", price: "40.00" },
          takeProfit: { triggerPrice: "59.00", price: "60.00" },
        }),
      ),
    ).toBe("MARKET_INDEX_NOT_PERPS");
    expect(h.sent).toHaveLength(0);
  });

  test("an OCO's two legs share one clock reading, so their expiries are identical", (): void => {
    let ticks: number = 0;
    const plan = buildOtoco(
      aMarket(),
      {
        entry: { side: "buy", size: "0.1", price: "50.00" },
        stopLoss: { triggerPrice: "41.00", price: "40.00" },
        takeProfit: { triggerPrice: "59.00", price: "60.00" },
      },
      (): number => {
        ticks += 1;
        // A clock that advances on every read is exactly what breaks an OCO intermittently.
        return NOW_MS + ticks;
      },
    );
    expect(plan.orders[1]?.orderExpiry).toBe(plan.orders[2]?.orderExpiry);
  });
});
