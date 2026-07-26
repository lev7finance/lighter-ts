/**
 * `src/client/market-handle.ts` — the layer that decides what price and size an order is submitted
 * at.
 *
 * The assertions here are on **integers**, not on shapes. A structural test cannot tell `8_200_000`
 * from `8_199_999`, and that difference is the reference's second arithmetic hazard: a user asking
 * to spend 8.2 USDC getting an order for 8.199999. So every case below names the exact number the
 * order carries, read back out of the captured `tx_info` document as well as out of `applied`, and
 * the four hazards of `docs/protocol-notes.md` §9 each have a case of their own.
 *
 * Nothing here touches the network: a fake `fetch`-free transport is injected into a real
 * `LighterAccount`, so the real builders, the real validators, the real signer and the real
 * serialiser all run.
 */

import { describe, expect, test } from "bun:test";

import { LighterAccount } from "../../src/client/account.js";
import type { Applied } from "../../src/client/brackets.js";
import type { MarketInfo } from "../../src/client/markets.js";
import type { BookSnapshot } from "../../src/client/math/index.js";
import { slippageBound } from "../../src/client/math/index.js";
import {
  type AppliedReceipt,
  DEFAULT_BOOK_DEPTH,
  type LeverageApplied,
  MarketHandle,
  type MarketContext,
  marketHandle,
  restBookSource,
} from "../../src/client/market-handle.js";
import { createLease } from "../../src/client/nonce/types.js";
import type { NonceLease, NonceSnapshot, NonceSource } from "../../src/client/nonce/types.js";
import type { SubmitContext } from "../../src/client/submit.js";
import type { OrderBookOrders } from "../../src/models/order.js";
import { ApiKey } from "../../src/crypto/key.js";
import { LighterMathError, LighterValidationError } from "../../src/errors.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** `conformance/vectors/tx.json`'s signing key. Only the hash matters here, never the signature. */
const KEY: ApiKey = ApiKey.fromPrivateKey(
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a",
);

const CHAIN_ID: 304 = 304;

/** A fixed clock, so every expiry default in this file is a number the test can name. */
const NOW_MS: 1_700_000_000_000 = 1_700_000_000_000;

/** 28 days, the expiry a GTT order defaults to. */
const TWENTY_EIGHT_DAYS_MS: 2_419_200_000n = 2_419_200_000n;

/**
 * A perps market at ETH-PERP's shape: 4 size decimals, 2 price decimals, 6 quote decimals.
 *
 * `2 + 4 === 6` is the cross-scale invariant, so quote sizing is dimensionally correct here.
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
    orderQuoteLimit: "1000000",
    takerFee: "0.0000",
    makerFee: "0.0000",
    isTakerFeeEnabled: false,
    isMakerFeeEnabled: false,
    baseAssetId: 1,
    quoteAssetId: 3,
    quoteSizingSupported: true,
    perps: { minInitialMarginFraction: 200 },
    ...over,
  }) as MarketInfo;
}

/**
 * A two-level book on each side, at the market's precision.
 *
 * asks: 2500.00 × 1.0, then 2501.00 × 2.0. bids: 2499.00 × 1.0, then 2498.00 × 2.0.
 */
const BOOK: BookSnapshot = Object.freeze({
  asks: Object.freeze([
    { priceScaled: 250_000n, sizeScaled: 10_000n },
    { priceScaled: 250_100n, sizeScaled: 20_000n },
  ]),
  bids: Object.freeze([
    { priceScaled: 249_900n, sizeScaled: 10_000n },
    { priceScaled: 249_800n, sizeScaled: 20_000n },
  ]),
});

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** One captured submission. */
interface Sent {
  readonly txType: number;
  readonly txInfo: Record<string, unknown>;
}

/** A nonce source that rotates over its keys and counts what was done to it. */
class TestNonces implements NonceSource {
  readonly kind: "optimistic" = "optimistic";
  readonly counters: Map<number, bigint> = new Map<number, bigint>();
  leases: number = 0;
  releases: number = 0;
  rollbacks: number = 0;
  #keys: readonly number[];
  #cursor: number = 0;

  constructor(keys: readonly number[]) {
    this.#keys = keys;
  }

  lease(preferKey?: number): Promise<NonceLease> {
    const key: number = preferKey ?? this.#next();
    const nonce: bigint = this.counters.get(key) ?? 0n;
    this.counters.set(key, nonce + 1n);
    this.leases += 1;
    return Promise.resolve(
      createLease({
        apiKeyIndex: key,
        nonce,
        onRollback: (): void => {
          this.rollbacks += 1;
          this.counters.set(key, (this.counters.get(key) ?? 1n) - 1n);
        },
        onRelease: (): void => {
          this.releases += 1;
        },
      }),
    );
  }

  resync(): Promise<void> {
    return Promise.resolve();
  }

  snapshot(): NonceSnapshot {
    return { version: 1, kind: "optimistic", accountIndex: 1, keys: [] };
  }

  restore(): void {
    /* not exercised here */
  }

  #next(): number {
    const key: number = this.#keys[this.#cursor % this.#keys.length] as number;
    this.#cursor += 1;
    return key;
  }
}

/** An account whose transport records rather than sends. */
function testAccount(sent: Sent[], nonces: NonceSource): LighterAccount {
  const refuse = (): never => {
    throw new Error("this test must not reach the network");
  };
  const transaction = {
    sendTx: (p: { tx_type: number; tx_info: string }): Promise<{ code: number; tx_hash: string }> => {
      sent.push({ txType: p.tx_type, txInfo: JSON.parse(p.tx_info) as Record<string, unknown> });
      // An empty echo is legal — `RespSendTx.tx_hash` is `omitempty` — and keeps this fake from
      // having to recompute a digest the SDK already asserted against itself.
      return Promise.resolve({ code: 200, tx_hash: "" });
    },
    sendTxBatch: (p: { tx_types: string; tx_infos: string }): Promise<{ code: number; tx_hash: string[] }> => {
      const types: number[] = JSON.parse(p.tx_types) as number[];
      const infos: string[] = JSON.parse(p.tx_infos) as string[];
      infos.forEach((info: string, i: number): void => {
        sent.push({ txType: types[i] as number, txInfo: JSON.parse(info) as Record<string, unknown> });
      });
      return Promise.resolve({ code: 200, tx_hash: [] });
    },
    tx: refuse,
  };
  const ctx: SubmitContext = {
    chainId: CHAIN_ID,
    accountIndex: 1n,
    rest: transaction as unknown as SubmitContext["rest"],
    nonces,
    keys: new Map<number, ApiKey>([[0, KEY]]),
    channel: "http",
    now: (): number => NOW_MS,
  };
  // `SubmitTransport` groups its three operations under `transaction`; the shape above is flattened
  // for brevity, so it is re-nested here rather than declared twice.
  const nested: SubmitContext = { ...ctx, rest: { transaction } as unknown as SubmitContext["rest"] };
  return new LighterAccount({
    chainId: CHAIN_ID,
    ctx: nested,
    rest: { account: { account: refuse, accountsByL1Address: refuse } } as never,
    defaultTxExpiryMs: 599_000,
    now: (): number => NOW_MS,
  });
}

/** A handle over the fixture market, plus everything the test needs to inspect afterwards. */
interface Harness {
  readonly handle: MarketHandle;
  readonly sent: Sent[];
  readonly nonces: TestNonces;
  /** How many book snapshots were requested. `0` proves a refusal happened before any I/O. */
  bookReads(): number;
  readonly ctx: MarketContext;
}

function harness(market: MarketInfo = aMarket()): Harness {
  const sent: Sent[] = [];
  const nonces: TestNonces = new TestNonces([0]);
  let reads: number = 0;
  const ctx: MarketContext = {
    chainId: CHAIN_ID,
    account: testAccount(sent, nonces),
    markets: { get: (): MarketInfo => market },
    books: {
      snapshot: (): Promise<BookSnapshot> => {
        reads += 1;
        return Promise.resolve(BOOK);
      },
    },
    now: (): number => NOW_MS,
  };
  return {
    handle: marketHandle(ctx, market.marketId),
    sent,
    nonces,
    bookReads: (): number => reads,
    ctx,
  };
}

/** The last captured `tx_info`, as numbers the assertions can name. */
function lastInfo(h: Harness): Record<string, unknown> {
  const last: Sent | undefined = h.sent[h.sent.length - 1];
  if (last === undefined) throw new Error("nothing was submitted");
  return last.txInfo;
}

/** The `code` of a thrown Lighter error, or the error itself if it is not one. */
async function codeOf(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected a rejection");
}

/* ---------------------------------------------------------------------------------------------- */
/* Market orders                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("market orders", (): void => {
  test("a buy is MARKET/IOC with a nil expiry, priced at the slippage bound", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.buy({ size: "0.1", maxSlippage: "0.5%" });

    // floor(250000 × 201 / 200) = 251250.
    expect(receipt.applied).toEqual({
      baseAmount: 1_000n,
      price: 251_250n,
      triggerPrice: 0n,
      orderExpiry: 0n,
    } satisfies Applied);

    const info: Record<string, unknown> = lastInfo(h);
    expect(info["Type"]).toBe(1); // MARKET
    expect(info["TimeInForce"]).toBe(0); // IOC
    expect(info["OrderExpiry"]).toBe(0);
    expect(info["TriggerPrice"]).toBe(0);
    expect(info["IsAsk"]).toBe(0);
    expect(info["BaseAmount"]).toBe(1_000);
    expect(info["Price"]).toBe(251_250);
  });

  test('"0.005", "0.5%" and "50bps" are one bound', async (): Promise<void> => {
    const bounds: bigint[] = [];
    for (const spelling of ["0.005", "0.5%", "50bps"]) {
      const h: Harness = harness();
      const receipt: AppliedReceipt = await h.handle.buy({ size: "0.1", maxSlippage: spelling });
      bounds.push(receipt.applied.price);
    }
    expect(bounds).toEqual([251_250n, 251_250n, 251_250n]);
  });

  test("a sell's bound rounds the other way, and never below the exact bound", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.sell({ size: "0.1", maxSlippage: "0.5%" });
    // ceil(249900 × 199 / 200) = ceil(248650.5) = 248651.
    expect(receipt.applied.price).toBe(248_651n);
    // A sell's bound is a *minimum*; rounding it up can only tighten it. 200× the integer bound is
    // never below the exact rational bound, which is what "rounding never loosens protection" means.
    expect(receipt.applied.price * 200n).toBeGreaterThanOrEqual(249_900n * 199n);
    expect(lastInfo(h)["IsAsk"]).toBe(1);
  });

  test("exactly one of size and notional", async (): Promise<void> => {
    const h: Harness = harness();
    await expect(h.handle.buy({ maxSlippage: "0.5%" })).rejects.toThrow(/exactly one/);
    await expect(
      h.handle.buy({ size: "0.1", notional: "8.2", maxSlippage: "0.5%" }),
    ).rejects.toThrow(/exactly one/);
  });

  test("a market order refuses to invent a price cap", async (): Promise<void> => {
    const h: Harness = harness();
    await expect(h.handle.buy({ size: "0.1" })).rejects.toThrow(/maxSlippage/);
  });

  test("checkDepth surfaces slippage and depth as distinguishable failures", async (): Promise<void> => {
    const h: Harness = harness();
    // 2.0 base eats level 1, so the achievable average is 250050 — outside a zero bound.
    expect(
      await codeOf(() => h.handle.buy({ size: "2", maxSlippage: "0", checkDepth: true })),
    ).toBe("EXCESSIVE_SLIPPAGE");
    // 10 base is more than the whole visible book, at any price.
    expect(
      await codeOf(() => h.handle.buy({ size: "10", maxSlippage: "50%", checkDepth: true })),
    ).toBe("INSUFFICIENT_DEPTH");
  });

  test("without checkDepth the book is only read for the best price", async (): Promise<void> => {
    const h: Harness = harness();
    // The same 10 base that INSUFFICIENT_DEPTH refused above: with no walk it is simply submitted
    // and fills less, which is `create_market_order_limited_slippage` (§3.7).
    const receipt: AppliedReceipt = await h.handle.buy({ size: "10", maxSlippage: "0.5%" });
    expect(receipt.applied.baseAmount).toBe(100_000n);
    expect(receipt.applied.price).toBe(251_250n);
  });

  test("an explicit idealPrice needs no book at all", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.buy({
      size: "0.1",
      maxSlippage: "0.5%",
      idealPrice: "3000.00",
    });
    expect(h.bookReads()).toBe(0);
    expect(receipt.applied.price).toBe(301_500n);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Quote sizing                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("quote-sized orders", (): void => {
  test('"8.2" at six quote decimals is exactly 8_200_000 — hazard 2', async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.buy({ notional: "8.2", maxSlippage: "0.5%" });
    // The reference computes int(8.2 * 1e6) = 8_199_999, because 8.2 × 1e6 is 8199999.999999999.
    expect(receipt.applied.notional).toBe(8_200_000n);
    expect(receipt.applied.notional).not.toBe(8_199_999n);
    // floor(8_200_000 / 250_000) = 32, i.e. 0.0032 ETH at four size decimals.
    expect(receipt.applied.baseAmount).toBe(32n);
    expect(lastInfo(h)["BaseAmount"]).toBe(32);
  });

  test("a market that cannot express quote sizing is refused before any I/O", async (): Promise<void> => {
    const h: Harness = harness(aMarket({ quoteDecimals: 7, quoteSizingSupported: false }));
    let thrown: unknown;
    try {
      await h.handle.buy({ notional: "8.2", maxSlippage: "0.5%" });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LighterMathError);
    expect((thrown as LighterMathError).code).toBe("SCALE_INVARIANT_VIOLATED");
    expect(h.bookReads()).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test("both sizing paths report an exact integer price — hazard 4", async (): Promise<void> => {
    const h: Harness = harness();
    const byQuote: AppliedReceipt = await h.handle.buy({ notional: "8.2", maxSlippage: "0.5%" });
    const byBase: AppliedReceipt = await h.handle.buy({
      size: "0.1",
      maxSlippage: "0.5%",
      checkDepth: true,
    });
    // The reference returns an exact Fraction on one branch and a lossy float on the other, so the
    // two cannot be compared. Here both are the same integer type at the same precision.
    expect(typeof byQuote.applied.price).toBe("bigint");
    expect(typeof byBase.applied.price).toBe("bigint");
    expect(byQuote.applied.price).toBe(byBase.applied.price);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Rounding regressions                                                                             */
/* ---------------------------------------------------------------------------------------------- */

describe("the reference's arithmetic hazards", (): void => {
  test("a bound landing on a half is never rounded to nearest — hazard 1", (): void => {
    // Python's round() is half-to-even and JavaScript's is half-up; round(2500.5) is 2500 there and
    // 2501 here. Neither is a slippage bound, because neither knows which way protects the caller.
    const buy: bigint = slippageBound(5_001n, "0.5", false);
    const sell: bigint = slippageBound(5_001n, "0.5", true);
    expect(buy).toBe(7_501n); // floor(7501.5) — not 7502
    expect(sell).toBe(2_501n); // ceil(2500.5)  — not Python's 2500
  });

  test('a price is scaled by the market\'s decimals, not by deleting the point — hazard 3', async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.limit({
      side: "buy",
      size: "0.1",
      price: "2500.1",
    });
    // The reference's int("2500.1".replace(".", "")) is 25001 — a hundredfold price error.
    expect(receipt.applied.price).toBe(250_010n);
    expect(receipt.applied.price).not.toBe(25_001n);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Resting orders                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("limit orders", (): void => {
  test("a limit order is GTT with an expanded 28-day expiry", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.limit({
      side: "buy",
      size: "0.25",
      price: "2500",
    });
    expect(receipt.applied.baseAmount).toBe(2_500n);
    expect(receipt.applied.price).toBe(250_000n);
    expect(receipt.applied.orderExpiry).toBe(BigInt(NOW_MS) + TWENTY_EIGHT_DAYS_MS);
    const info: Record<string, unknown> = lastInfo(h);
    expect(info["Type"]).toBe(0);
    expect(info["TimeInForce"]).toBe(1);
  });

  test("an IOC limit order carries the nil expiry, which is the correct one", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.limit({
      side: "sell",
      size: "0.25",
      price: "2500",
      timeInForce: "IOC",
    });
    expect(receipt.applied.orderExpiry).toBe(0n);
  });

  test("a price the market cannot express is refused rather than rounded", async (): Promise<void> => {
    const h: Harness = harness();
    expect(
      await codeOf(() => h.handle.limit({ side: "buy", size: "0.1", price: "2500.123" })),
    ).toBe("NOT_REPRESENTABLE");
  });

  test("conservative rounding tightens on both sides", async (): Promise<void> => {
    const buy: Harness = harness();
    const sell: Harness = harness();
    const bought: AppliedReceipt = await buy.handle.limit({
      side: "buy",
      size: "0.1",
      price: "2500.129",
      rounding: "conservative",
    });
    const sold: AppliedReceipt = await sell.handle.limit({
      side: "sell",
      size: "0.1",
      price: "2500.121",
      rounding: "conservative",
    });
    expect(bought.applied.price).toBe(250_012n); // floored: never pay more
    expect(sold.applied.price).toBe(250_013n); // ceiled: never accept less
  });

  test("postOnly is the PostOnly time in force and refuses to be anything else", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.postOnly({
      side: "buy",
      size: "0.1",
      price: "2500",
    });
    expect(receipt.applied.price).toBe(250_000n);
    expect(lastInfo(h)["TimeInForce"]).toBe(2);
    await expect(
      h.handle.postOnly({ side: "buy", size: "0.1", price: "2500", timeInForce: "IOC" }),
    ).rejects.toThrow(/PostOnly/);
  });

  test("a size below one tick is refused, not silently turned into the whole position", async (): Promise<void> => {
    const h: Harness = harness();
    expect(
      await codeOf(() => h.handle.limit({ side: "buy", size: "0.00001", price: "2500" })),
    ).toBe("BASE_AMOUNT_TOO_LOW");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Modify, cancel, cancel-all                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("order lifecycle", (): void => {
  test("modify reports the three integers it changed", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.modify({
      orderId: 281_474_976_710_656n,
      size: "0.5",
      price: "2501",
      trigger: "2502",
    });
    expect(receipt.applied).toEqual({
      baseAmount: 5_000n,
      price: 250_100n,
      triggerPrice: 250_200n,
      orderExpiry: 0n,
    } satisfies Applied);
    expect(lastInfo(h)["Index"]).toBe(281_474_976_710_656);
  });

  test("cancel submits an L2CancelOrder for this market", async (): Promise<void> => {
    const h: Harness = harness();
    await h.handle.cancel(281_474_976_710_656n);
    expect(h.sent[0]?.txType).toBe(15);
    expect(lastInfo(h)["MarketIndex"]).toBe(1);
  });

  test("an immediate cancel-all is scoped to this market through attribute 5", async (): Promise<void> => {
    const h: Harness = harness();
    await h.handle.cancelAll();
    const info: Record<string, unknown> = lastInfo(h);
    expect(h.sent[0]?.txType).toBe(16);
    expect(info["TimeInForce"]).toBe(0);
    expect(info["Time"]).toBe(0);
    expect(info["L2TxAttributes"]).toEqual({ "5": 1 });
  });

  test("a scheduled cancel-all cannot be scoped to one market", async (): Promise<void> => {
    const h: Harness = harness();
    expect(
      await codeOf(() => h.handle.cancelAll({ mode: "scheduled", at: BigInt(NOW_MS) + 600_000n })),
    ).toBe("CANCEL_ALL_MARKET_CANT_BE_SCHEDULED");
    expect(h.sent).toHaveLength(0);
  });

  test("a scheduled cancel-all across every market carries no market attribute", async (): Promise<void> => {
    const h: Harness = harness();
    await h.handle.cancelAll({ mode: "scheduled", at: BigInt(NOW_MS) + 600_000n, allMarkets: true });
    const info: Record<string, unknown> = lastInfo(h);
    expect(info["TimeInForce"]).toBe(1);
    expect(info["Time"]).toBe(NOW_MS + 600_000);
    // Attribute 5's nil value is NIL_MARKET_INDEX (255), and a nil-valued attribute is omitted.
    expect(info["L2TxAttributes"]).toBeNull();
  });

  test("only the scheduled mode takes a timestamp", async (): Promise<void> => {
    const h: Harness = harness();
    expect(await codeOf(() => h.handle.cancelAll({ mode: "scheduled", allMarkets: true }))).toBe(
      "CANCEL_ALL_TIME_OUT_OF_RANGE",
    );
    expect(
      await codeOf(() => h.handle.cancelAll({ mode: "abort", at: 1n, allMarkets: true })),
    ).toBe("CANCEL_ALL_TIME_NOT_NIL");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Trigger orders                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("trigger orders", (): void => {
  test("takeProfit is TAKE_PROFIT / IOC with a non-nil trigger and expiry", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.takeProfit({
      side: "sell",
      triggerPrice: "2600",
      price: "2590",
    });
    expect(receipt.applied.triggerPrice).toBe(260_000n);
    expect(receipt.applied.price).toBe(259_000n);
    expect(receipt.applied.baseAmount).toBe(0n);
    expect(receipt.applied.orderExpiry).toBe(BigInt(NOW_MS) + TWENTY_EIGHT_DAYS_MS);
    const info: Record<string, unknown> = lastInfo(h);
    expect(info["Type"]).toBe(4);
    expect(info["TimeInForce"]).toBe(0);
    // A nil base amount is legal only on a reduce-only order, so an unsized exit is one.
    expect(info["ReduceOnly"]).toBe(1);
  });

  test("stopLoss is STOP_LOSS, and its limit variant is GTT", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.stopLoss({
      side: "sell",
      triggerPrice: "2400",
      price: "2390",
    });
    expect(receipt.applied).toEqual({
      baseAmount: 0n,
      price: 239_000n,
      triggerPrice: 240_000n,
      orderExpiry: BigInt(NOW_MS) + TWENTY_EIGHT_DAYS_MS,
    } satisfies Applied);
    expect(lastInfo(h)["Type"]).toBe(2);
    await h.handle.stopLoss({ side: "sell", triggerPrice: "2400", price: "2390", limit: true });
    const info: Record<string, unknown> = lastInfo(h);
    expect(info["Type"]).toBe(3);
    expect(info["TimeInForce"]).toBe(1);
  });

  test("a market trigger order cannot carry another time in force", async (): Promise<void> => {
    const h: Harness = harness();
    expect(
      await codeOf(() =>
        h.handle.stopLoss({ side: "sell", triggerPrice: "2400", price: "2390", timeInForce: "GTT" }),
      ),
    ).toBe("ORDER_TIF_INVALID");
  });

  test("trigger orders are perps only", async (): Promise<void> => {
    const spot: Harness = harness(
      aMarket({ marketId: 2048, marketType: "spot", symbol: "ETH" }),
    );
    expect(
      await codeOf(() => spot.handle.takeProfit({ side: "sell", triggerPrice: "2600", price: "2590" })),
    ).toBe("MARKET_INDEX_NOT_PERPS");
  });

  test("a standalone trigger order needs a side", async (): Promise<void> => {
    const h: Harness = harness();
    await expect(
      h.handle.takeProfit({ triggerPrice: "2600", price: "2590" }),
    ).rejects.toThrow(/side/);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Leverage and margin                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe("setLeverage", (): void => {
  test("leverage 3 is imf 3334, and the effective leverage is exact", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt & LeverageApplied = await h.handle.setLeverage({
      leverage: "3",
      marginMode: "cross",
    });
    // The reference's int(10000/3) is 3333, an effective 3.0003× — *more* leverage than asked for.
    expect(receipt.imf).toBe(3_334);
    expect(receipt.clamped).toBe(false);
    // 10000/3334 in lowest terms, asserted by cross-multiplication so the reduction is not assumed.
    expect(receipt.effectiveLeverage.num * 3_334n).toBe(receipt.effectiveLeverage.den * 10_000n);
    expect(lastInfo(h)["InitialMarginFraction"]).toBe(3_334);
    expect(lastInfo(h)["MarginMode"]).toBe(0);
  });

  test("an exact rational leverage gives the same answer as its decimal spelling", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt & LeverageApplied = await h.handle.setLeverage({
      leverage: { num: 3n, den: 1n },
      marginMode: "isolated",
    });
    expect(receipt.imf).toBe(3_334);
    expect(lastInfo(h)["MarginMode"]).toBe(1);
  });

  test("20× on a market whose floor is 200 is imf 500 and unclamped", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt & LeverageApplied = await h.handle.setLeverage({
      leverage: "20",
      marginMode: "cross",
    });
    expect(receipt.imf).toBe(500);
    expect(receipt.clamped).toBe(false);
  });

  test("a request above the market maximum names the market's own limit", async (): Promise<void> => {
    const h: Harness = harness();
    let thrown: unknown;
    try {
      await h.handle.setLeverage({ leverage: "100", marginMode: "cross" });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LighterValidationError);
    expect((thrown as LighterValidationError).code).toBe("IMF_TOO_LOW");
    expect((thrown as Error).message).toContain("200");
    expect(h.sent).toHaveLength(0);
  });

  test("an initialMarginFraction round-trips without a conversion", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt & LeverageApplied = await h.handle.setLeverage({
      initialMarginFraction: 500,
      marginMode: "cross",
    });
    expect(receipt.imf).toBe(500);
  });

  test("a fractional number leverage does not compile", (): void => {
    const h: Harness = harness();
    // @ts-expect-error — D7: a leverage is a decimal string or an exact rational, never a float.
    const rejected: unknown = (): unknown => h.handle.setLeverage({ leverage: 3, marginMode: "cross" });
    expect(typeof rejected).toBe("function");
  });
});

describe("margin", (): void => {
  test("addMargin scales exactly to micro-USDC and states its direction", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.addMargin("10.5");
    expect(receipt.applied.usdcAmount).toBe(10_500_000n);
    const info: Record<string, unknown> = lastInfo(h);
    expect(info["USDCAmount"]).toBe(10_500_000);
    expect(info["Direction"]).toBe(1);
  });

  test("removeMargin is the same amount with the other direction", async (): Promise<void> => {
    const h: Harness = harness();
    await h.handle.removeMargin("5");
    expect(lastInfo(h)["Direction"]).toBe(0);
  });

  test("a margin amount is positive; the direction is a field, not a sign", async (): Promise<void> => {
    const h: Harness = harness();
    expect(await codeOf(() => h.handle.addMargin("0"))).toBe("NEGATIVE_MARGIN_AMOUNT");
    expect(await codeOf(() => h.handle.addMargin("-1"))).toBe("NEGATIVE_MARGIN_AMOUNT");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Dry runs                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("dryRun", (): void => {
  test("returns a signed transaction, issues no request and moves no counter", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.limit({
      side: "buy",
      size: "0.1",
      price: "2500",
      dryRun: true,
    });

    expect(h.sent).toHaveLength(0);
    expect(receipt.dryRun).toBeDefined();
    expect(receipt.dryRun?.sig).toBeInstanceOf(Uint8Array);
    expect(receipt.dryRun?.sig?.length).toBe(80);
    expect(receipt.txHash).toMatch(/^0x[0-9a-f]{80}$/);
    expect(receipt.txInfo.startsWith("{")).toBe(true);
    expect(receipt.applied.price).toBe(250_000n);

    // The nonce source was never consulted, so no slot was allocated and none had to be rolled back.
    expect(h.nonces.leases).toBe(0);
    expect(h.nonces.rollbacks).toBe(0);
  });

  test("waiting on a dry run says so rather than polling forever", async (): Promise<void> => {
    const h: Harness = harness();
    const receipt: AppliedReceipt = await h.handle.limit({
      side: "buy",
      size: "0.1",
      price: "2500",
      dryRun: true,
    });
    await expect(receipt.wait()).rejects.toThrow(/never submitted/);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Construction                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("restBookSource", (): void => {
  test("folds resting orders into a book at the market's precision", async (): Promise<void> => {
    const market: MarketInfo = aMarket();
    const asked: { market_id: number; limit: number }[] = [];
    const source = restBookSource({
      order: {
        orderBookOrders: (params: { market_id: number; limit: number }): Promise<OrderBookOrders> => {
          asked.push(params);
          return Promise.resolve({
            code: 200,
            // Two resting orders at one price fold into one level.
            asks: [
              { price: "2500.00", remaining_base_amount: "0.6000" },
              { price: "2500.00", remaining_base_amount: "0.4000" },
            ],
            bids: [{ price: "2499.00", remaining_base_amount: "1.0000" }],
          } as unknown as OrderBookOrders);
        },
      },
    });

    const book: BookSnapshot = await source.snapshot(market);
    expect(asked).toEqual([{ market_id: 1, limit: DEFAULT_BOOK_DEPTH }]);
    expect(book.asks).toEqual([{ priceScaled: 250_000n, sizeScaled: 10_000n }]);
    expect(book.bids).toEqual([{ priceScaled: 249_900n, sizeScaled: 10_000n }]);
  });
});

describe("marketHandle", (): void => {
  test("resolves through the registry and exposes the market it resolved", (): void => {
    const h: Harness = harness();
    expect(h.handle).toBeInstanceOf(MarketHandle);
    expect(h.handle.marketId).toBe(1);
    expect(h.handle.market.symbol).toBe("ETH");
  });
});
