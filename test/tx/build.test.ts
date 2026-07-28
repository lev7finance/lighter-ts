/**
 * `src/tx/build.ts` — the twenty builders.
 *
 * Three things are checked here that the conformance replay in `pipeline.test.ts` cannot see:
 *
 * 1. **Coverage.** A table maps every member of `CONSTRUCTIBLE_TX_TYPES` to exactly one builder, and
 *    every builder's output carries the code it was filed under. A missing builder is otherwise
 *    invisible — nothing else in the package enumerates them.
 * 2. **The validators are wired in.** Each builder is handed one input its validator must reject,
 *    and the raised `LighterValidationError.code` is asserted. A builder that forgot its `validate`
 *    call would still hash correctly and would still pass all 38 vector rows.
 * 3. **Purity.** Builders freeze their output, copy the byte arrays and the leg array they are
 *    handed, and never reorder the legs — the leg fold is a left fold, so a sort would change the
 *    hash of every bracket order.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import { type I64, i16, i64, u8, u16, u32, u64 } from "../../src/tx/brands.js";
import {
  type UnsignedTx,
  buildApproveIntegrator,
  buildBurnShares,
  buildCancelAllOrders,
  buildCancelOrder,
  buildChangePubKey,
  buildCreateGroupedOrders,
  buildCreateOrder,
  buildCreatePublicPool,
  buildCreateSubAccount,
  buildMintShares,
  buildModifyOrder,
  buildStakeAssets,
  buildTransfer,
  buildUnstakeAssets,
  buildUpdateAccountAssetConfig,
  buildUpdateAccountConfig,
  buildUpdateLeverage,
  buildUpdateMargin,
  buildUpdatePublicPool,
  buildWithdraw,
} from "../../src/tx/build.js";
import { CONSTRUCTIBLE_TX_TYPES, TxType } from "../../src/tx/enums.js";
import type { TransactOpts } from "../../src/tx/opts.js";
import type { OrderInfo } from "../../src/tx/types/orders.js";

/** Shared options. `expiredAt` is explicit everywhere, so no builder may touch the clock. */
const OPTS: TransactOpts = {
  accountIndex: i64(1),
  apiKeyIndex: u8(0),
  nonce: i64(42),
  expiredAt: i64(1_893_456_000_000n),
  now: (): number => {
    throw new Error("a builder read the clock despite an explicit expiredAt");
  },
};

const PUB_KEY: Uint8Array = new Uint8Array(40).fill(7);
const MEMO: Uint8Array = new Uint8Array(32).fill(9);

/** A valid limit-buy parent leg, from `create_grouped_orders/oto`. */
const PARENT_LEG: OrderInfo = {
  marketIndex: i16(1),
  clientOrderIndex: i64(2001),
  baseAmount: i64(1000),
  price: u32(5000),
  isAsk: u8(0),
  type: u8(0),
  timeInForce: u8(1),
  reduceOnly: u8(0),
  triggerPrice: u32(0),
  orderExpiry: i64(1_893_456_000_000n),
};

/** The matching stop-loss child leg. */
const CHILD_LEG: OrderInfo = {
  marketIndex: i16(1),
  clientOrderIndex: i64(2002),
  baseAmount: i64(0),
  price: u32(4000),
  isAsk: u8(1),
  type: u8(2),
  timeInForce: u8(0),
  reduceOnly: u8(1),
  triggerPrice: u32(4100),
  orderExpiry: i64(1_893_456_000_000n),
};

function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but nothing was thrown");
}

/* -------------------------------------------------------------------------------------------------
 * The table: one row per constructible transaction type
 * ---------------------------------------------------------------------------------------------- */

interface BuilderCase {
  /** A builder call that must succeed. */
  readonly ok: () => UnsignedTx;
  /** A builder call that must be rejected, and the identity the validator must report. */
  readonly bad: () => UnsignedTx;
  /** The expected `LighterValidationError.code` of {@link BuilderCase.bad}. */
  readonly badCode: string;
}

const CASES: ReadonlyMap<number, BuilderCase> = new Map<number, BuilderCase>([
  [
    TxType.L2ChangePubKey,
    {
      ok: () => buildChangePubKey({ pubKey: PUB_KEY }, OPTS),
      bad: () => buildChangePubKey({ pubKey: new Uint8Array(39) }, OPTS),
      badCode: "PUBKEY_INVALID",
    },
  ],
  [
    TxType.L2CreateSubAccount,
    {
      ok: () => buildCreateSubAccount({}, OPTS),
      // The master range stops at 2^47 − 1, well below the general account ceiling.
      bad: () => buildCreateSubAccount({}, { ...OPTS, accountIndex: i64(140_737_488_355_328n) }),
      badCode: "FROM_ACCOUNT_INDEX_TOO_HIGH",
    },
  ],
  [
    TxType.L2CreatePublicPool,
    {
      ok: () =>
        buildCreatePublicPool(
          {
            operatorFee: i64(100),
            initialTotalShares: i64(1_000_000n),
            minOperatorShareRate: u16(1000),
          },
          OPTS,
        ),
      bad: () =>
        buildCreatePublicPool(
          {
            operatorFee: i64(1_000_001n),
            initialTotalShares: i64(1_000_000n),
            minOperatorShareRate: u16(1000),
          },
          OPTS,
        ),
      badCode: "POOL_OPERATOR_FEE_INVALID",
    },
  ],
  [
    TxType.L2UpdatePublicPool,
    {
      ok: () =>
        buildUpdatePublicPool(
          {
            publicPoolIndex: i64(140_737_488_355_428n),
            status: u8(1),
            operatorFee: i64(200),
            minOperatorShareRate: u16(2000),
          },
          OPTS,
        ),
      bad: () =>
        buildUpdatePublicPool(
          {
            publicPoolIndex: i64(140_737_488_355_428n),
            status: u8(2),
            operatorFee: i64(200),
            minOperatorShareRate: u16(2000),
          },
          OPTS,
        ),
      badCode: "POOL_STATUS_INVALID",
    },
  ],
  [
    TxType.L2Transfer,
    {
      ok: () =>
        buildTransfer(
          {
            toAccountIndex: i64(2),
            assetIndex: i16(3),
            fromRouteType: u8(0),
            toRouteType: u8(1),
            amount: i64(4_886_718_345n),
            usdcFee: i64(0),
            memo: MEMO,
          },
          OPTS,
        ),
      bad: () =>
        buildTransfer(
          {
            toAccountIndex: i64(2),
            assetIndex: i16(3),
            fromRouteType: u8(0),
            toRouteType: u8(1),
            amount: i64(4_886_718_345n),
            usdcFee: i64(0),
            memo: new Uint8Array(31),
          },
          OPTS,
        ),
      badCode: "MEMO_LENGTH_INVALID",
    },
  ],
  [
    TxType.L2Withdraw,
    {
      ok: () =>
        buildWithdraw(
          { assetIndex: i16(3), routeType: u8(0), amount: u64(549_755_813_887n) },
          OPTS,
        ),
      bad: () => buildWithdraw({ assetIndex: i16(3), routeType: u8(0), amount: u64(0) }, OPTS),
      badCode: "WITHDRAWAL_AMOUNT_TOO_LOW",
    },
  ],
  [
    TxType.L2CreateOrder,
    {
      ok: () =>
        buildCreateOrder(
          {
            marketIndex: i16(1),
            clientOrderIndex: i64(100),
            baseAmount: i64(1_000_000n),
            price: u32(250_000),
            isAsk: u8(0),
            orderType: u8(0),
            timeInForce: u8(1),
            reduceOnly: u8(0),
            triggerPrice: u32(0),
            orderExpiry: i64(1_893_456_000_000n),
          },
          OPTS,
        ),
      // `Price` has no nil sentinel — even a market order carries its slippage bound as a price.
      bad: () =>
        buildCreateOrder(
          {
            marketIndex: i16(1),
            clientOrderIndex: i64(100),
            baseAmount: i64(1_000_000n),
            price: u32(0),
            isAsk: u8(0),
            orderType: u8(0),
            timeInForce: u8(1),
            reduceOnly: u8(0),
            triggerPrice: u32(0),
            orderExpiry: i64(1_893_456_000_000n),
          },
          OPTS,
        ),
      badCode: "PRICE_TOO_LOW",
    },
  ],
  [
    TxType.L2CancelOrder,
    {
      ok: () => buildCancelOrder({ marketIndex: i16(1), index: i64(12_345) }, OPTS),
      bad: () => buildCancelOrder({ marketIndex: i16(1), index: i64(0) }, OPTS),
      badCode: "ORDER_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2CancelAllOrders,
    {
      ok: () => buildCancelAllOrders({ timeInForce: u8(0), time: i64(0) }, OPTS),
      bad: () => buildCancelAllOrders({ timeInForce: u8(3), time: i64(0) }, OPTS),
      badCode: "CANCEL_ALL_TIF_INVALID",
    },
  ],
  [
    TxType.L2ModifyOrder,
    {
      ok: () =>
        buildModifyOrder(
          {
            marketIndex: i16(1),
            index: i64(12_345),
            baseAmount: i64(5000),
            price: u32(777_777),
            triggerPrice: u32(0),
          },
          OPTS,
        ),
      // Same predicate as `L2CancelOrder`, different reported identity — reference copy-paste.
      bad: () =>
        buildModifyOrder(
          {
            marketIndex: i16(1),
            index: i64(0),
            baseAmount: i64(5000),
            price: u32(777_777),
            triggerPrice: u32(0),
          },
          OPTS,
        ),
      badCode: "CLIENT_ORDER_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2MintShares,
    {
      ok: () =>
        buildMintShares(
          { publicPoolIndex: i64(140_737_488_355_428n), shareAmount: i64(5000) },
          OPTS,
        ),
      bad: () => buildMintShares({ publicPoolIndex: i64(1), shareAmount: i64(5000) }, OPTS),
      badCode: "PUBLIC_POOL_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2BurnShares,
    {
      ok: () =>
        buildBurnShares(
          { publicPoolIndex: i64(140_737_488_355_428n), shareAmount: i64(2500) },
          OPTS,
        ),
      bad: () =>
        buildBurnShares({ publicPoolIndex: i64(140_737_488_355_428n), shareAmount: i64(0) }, OPTS),
      badCode: "POOL_BURN_AMOUNT_TOO_LOW",
    },
  ],
  [
    TxType.L2UpdateLeverage,
    {
      ok: () =>
        buildUpdateLeverage(
          { marketIndex: i16(1), initialMarginFraction: u16(500), marginMode: u8(0) },
          OPTS,
        ),
      bad: () =>
        buildUpdateLeverage(
          { marketIndex: i16(255), initialMarginFraction: u16(500), marginMode: u8(0) },
          OPTS,
        ),
      badCode: "MARKET_INDEX_INVALID",
    },
  ],
  [
    TxType.L2CreateGroupedOrders,
    {
      ok: () =>
        buildCreateGroupedOrders({ groupingType: u8(1), orders: [PARENT_LEG, CHILD_LEG] }, OPTS),
      // `0` is `GroupingType.None`: the base sentinel, not "ungrouped".
      bad: () =>
        buildCreateGroupedOrders({ groupingType: u8(0), orders: [PARENT_LEG, CHILD_LEG] }, OPTS),
      badCode: "GROUPING_TYPE_INVALID",
    },
  ],
  [
    TxType.L2UpdateMargin,
    {
      ok: () =>
        buildUpdateMargin(
          { marketIndex: i16(1), usdcAmount: i64(4_886_718_345n), direction: u8(1) },
          OPTS,
        ),
      bad: () =>
        buildUpdateMargin({ marketIndex: i16(1), usdcAmount: i64(0), direction: u8(1) }, OPTS),
      badCode: "TRANSFER_AMOUNT_TOO_LOW",
    },
  ],
  [
    TxType.L2StakeAssets,
    {
      ok: () =>
        buildStakeAssets(
          { stakingPoolIndex: i64(140_737_488_355_335n), shareAmount: i64(1_000_000n) },
          OPTS,
        ),
      bad: () =>
        buildStakeAssets({ stakingPoolIndex: i64(1), shareAmount: i64(1_000_000n) }, OPTS),
      badCode: "STAKING_POOL_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2UnstakeAssets,
    {
      ok: () =>
        buildUnstakeAssets(
          { stakingPoolIndex: i64(140_737_488_355_335n), shareAmount: i64(500_000n) },
          OPTS,
        ),
      // Predicate on StakingPoolIndex, identity PublicPoolIndex — the reference's own copy-paste.
      bad: () =>
        buildUnstakeAssets({ stakingPoolIndex: i64(1), shareAmount: i64(500_000n) }, OPTS),
      badCode: "PUBLIC_POOL_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2UpdateAccountConfig,
    {
      ok: () => buildUpdateAccountConfig({ accountTradingMode: u8(1) }, OPTS),
      bad: () => buildUpdateAccountConfig({ accountTradingMode: u8(2) }, OPTS),
      badCode: "ACCOUNT_TRADING_MODE_INVALID",
    },
  ],
  [
    TxType.L2UpdateAccountAssetConfig,
    {
      ok: () =>
        buildUpdateAccountAssetConfig({ assetIndex: i16(1), assetMarginMode: u8(1) }, OPTS),
      bad: () =>
        buildUpdateAccountAssetConfig({ assetIndex: i16(0), assetMarginMode: u8(1) }, OPTS),
      badCode: "ASSET_INDEX_TOO_LOW",
    },
  ],
  [
    TxType.L2ApproveIntegrator,
    {
      ok: () =>
        buildApproveIntegrator(
          {
            integratorAccountIndex: i64(4242),
            maxPerpsTakerFee: u32(1000),
            maxPerpsMakerFee: u32(500),
            maxSpotTakerFee: u32(800),
            maxSpotMakerFee: u32(400),
            approvalExpiry: i64(1_893_456_000_000n),
          },
          OPTS,
        ),
      bad: () =>
        buildApproveIntegrator(
          {
            integratorAccountIndex: i64(4242),
            maxPerpsTakerFee: u32(1_000_001),
            maxPerpsMakerFee: u32(500),
            maxSpotTakerFee: u32(800),
            maxSpotMakerFee: u32(400),
            approvalExpiry: i64(1_893_456_000_000n),
          },
          OPTS,
        ),
      badCode: "FEE_TOO_HIGH",
    },
  ],
]);

/* -------------------------------------------------------------------------------------------------
 * Coverage
 * ---------------------------------------------------------------------------------------------- */

describe("every constructible transaction type has exactly one builder", () => {
  test("CONSTRUCTIBLE_TX_TYPES has twenty members and the table matches it exactly", () => {
    expect(CONSTRUCTIBLE_TX_TYPES.size).toBe(20);
    expect(CASES.size).toBe(20);
    expect([...CASES.keys()].sort((a, b) => a - b)).toEqual(
      [...CONSTRUCTIBLE_TX_TYPES].sort((a, b) => a - b),
    );
  });

  for (const [code, kase] of CASES) {
    test(`type ${String(code)}: the builder's output carries its own code`, () => {
      const tx: UnsignedTx = kase.ok();
      expect(tx.type).toBe(code as UnsignedTx["type"]);
      expect(CONSTRUCTIBLE_TX_TYPES.has(tx.type)).toBe(true);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * The validators are wired in
 * ---------------------------------------------------------------------------------------------- */

describe("every builder rejects an invalid input with the right identity", () => {
  for (const [code, kase] of CASES) {
    test(`type ${String(code)} reports ${kase.badCode}`, () => {
      expect(thrown(kase.bad).code).toBe(kase.badCode);
    });
  }

  test("an invalid attribute map is rejected before any field rule", () => {
    // Type 2 without type 1 — the §6.2 cross-check, which runs first in every transaction.
    expect(
      thrown(() =>
        buildCancelOrder({ marketIndex: i16(1), index: i64(1) }, { ...OPTS, attributes: { 2: 5 } }),
      ).code,
    ).toBe("INTEGRATOR_REQUIRED_FOR_FEES");
  });
});

/* -------------------------------------------------------------------------------------------------
 * Shared options reach the transaction
 * ---------------------------------------------------------------------------------------------- */

describe("the shared options land on the transaction", () => {
  test("account index, api key index, nonce and expiry", () => {
    const tx = buildCancelOrder({ marketIndex: i16(1), index: i64(7) }, OPTS);
    expect(tx.accountIndex).toBe(1n as I64);
    expect(tx.apiKeyIndex).toBe(u8(0));
    expect(tx.nonce).toBe(42n as I64);
    expect(tx.expiredAt).toBe(1_893_456_000_000n as I64);
  });

  test("Transfer and Withdraw take the signing account as fromAccountIndex", () => {
    const t = buildTransfer(
      {
        toAccountIndex: i64(2),
        assetIndex: i16(3),
        fromRouteType: u8(0),
        toRouteType: u8(1),
        amount: i64(1),
        usdcFee: i64(0),
        memo: MEMO,
      },
      OPTS,
    );
    const w = buildWithdraw({ assetIndex: i16(3), routeType: u8(0), amount: u64(1) }, OPTS);
    expect(t.fromAccountIndex).toBe(1n as I64);
    expect(w.fromAccountIndex).toBe(1n as I64);
  });

  test("attributes are normalised onto the transaction", () => {
    const tx = buildCancelAllOrders(
      { timeInForce: u8(0), time: i64(0) },
      { ...OPTS, attributes: { 5: 3, 1: 0 } },
    );
    // Type 1 nils at 0 and is dropped; type 5 nils at 255 and `3` survives.
    expect(tx.attributes).toEqual({ 5: 3 });
  });

  test("strict is honoured — the negative-margin tightening is on by default", () => {
    const req = { marketIndex: i16(1), usdcAmount: i64(-1n), direction: u8(0) } as const;
    expect(thrown(() => buildUpdateMargin(req, OPTS)).code).toBe("NEGATIVE_MARGIN_AMOUNT");
    expect(buildUpdateMargin(req, { ...OPTS, strict: false }).usdcAmount).toBe(-1n as I64);
  });

  test("no builder reads the clock when expiredAt is supplied", () => {
    // Every `ok` case above already runs with a throwing clock; this states it as the property.
    for (const [, kase] of CASES) expect(() => kase.ok()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Purity
 * ---------------------------------------------------------------------------------------------- */

describe("builders are pure", () => {
  test("the returned transaction is frozen", () => {
    for (const [, kase] of CASES) expect(Object.isFrozen(kase.ok())).toBe(true);
  });

  test("byte arrays are copied, not aliased", () => {
    const pubKey: Uint8Array = new Uint8Array(40).fill(7);
    const tx = buildChangePubKey({ pubKey }, OPTS);
    pubKey[0] = 99;
    expect(tx.pubKey[0]).toBe(7);
    expect(tx.pubKey).not.toBe(pubKey);

    const memo: Uint8Array = new Uint8Array(32).fill(9);
    const transfer = buildTransfer(
      {
        toAccountIndex: i64(2),
        assetIndex: i16(3),
        fromRouteType: u8(0),
        toRouteType: u8(1),
        amount: i64(1),
        usdcFee: i64(0),
        memo,
      },
      OPTS,
    );
    memo[0] = 99;
    expect(transfer.memo[0]).toBe(9);
  });

  test("grouped legs are copied in the caller's order and never sorted", () => {
    const orders: OrderInfo[] = [PARENT_LEG, CHILD_LEG];
    const tx = buildCreateGroupedOrders({ groupingType: u8(1), orders }, OPTS);
    expect(tx.orders).not.toBe(orders);
    expect(Object.isFrozen(tx.orders)).toBe(true);
    expect(tx.orders.map((o) => o.clientOrderIndex)).toEqual([i64(2001), i64(2002)]);

    orders.reverse();
    // The transaction is unaffected by a later mutation of the caller's array.
    expect(tx.orders.map((o) => o.clientOrderIndex)).toEqual([i64(2001), i64(2002)]);
  });

  test("the same input builds the same transaction twice", () => {
    // Deep equality rather than `JSON.stringify`: the emitter is the only thing allowed to serialise
    // a transaction, and `JSON.stringify` throws on the bigint fields anyway.
    for (const [, kase] of CASES) expect(kase.ok()).toEqual(kase.ok());
  });
});
