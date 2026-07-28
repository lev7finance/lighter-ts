import { describe, expect, test } from "bun:test";

import {
  AccountAssetMarginMode,
  AccountTradingMode,
  API_MAX_ORDER_TYPE,
  AssetMarginMode,
  AssetRouteType,
  CancelAllTimeInForce,
  CONSTRUCTIBLE_TX_TYPES,
  GroupingType,
  MAX_ASSET_MARGIN_MODE,
  MarginDirection,
  MarginMode,
  OrderTimeInForce,
  OrderType,
  PoolStatus,
  SelfTradeBehavior,
  SelfTradeEquality,
  TxType,
} from "../../src/tx/enums.js";

/**
 * The transaction-type table, written out independently of the module under test.
 *
 * Deliberately a literal list rather than anything derived from `TxType`: a test that reads the
 * table it is checking proves only that the table equals itself. 44 entries, `34` and `39` absent.
 */
const EXPECTED_TX_TYPES: ReadonlyArray<readonly [string, number]> = [
  ["Empty", 0],
  ["L1Deposit", 1],
  ["L1ChangePubKey", 2],
  ["L1CreateMarket", 3],
  ["L1UpdateMarket", 4],
  ["L1CancelAllOrders", 5],
  ["L1Withdraw", 6],
  ["L1CreateOrder", 7],
  ["L2ChangePubKey", 8],
  ["L2CreateSubAccount", 9],
  ["L2CreatePublicPool", 10],
  ["L2UpdatePublicPool", 11],
  ["L2Transfer", 12],
  ["L2Withdraw", 13],
  ["L2CreateOrder", 14],
  ["L2CancelOrder", 15],
  ["L2CancelAllOrders", 16],
  ["L2ModifyOrder", 17],
  ["L2MintShares", 18],
  ["L2BurnShares", 19],
  ["L2UpdateLeverage", 20],
  ["InternalClaimOrder", 21],
  ["InternalCancelOrder", 22],
  ["InternalDeleverage", 23],
  ["InternalExitPosition", 24],
  ["InternalCancelAllOrders", 25],
  ["InternalLiquidatePosition", 26],
  ["InternalCreateOrder", 27],
  ["L2CreateGroupedOrders", 28],
  ["L2UpdateMargin", 29],
  ["L1BurnShares", 30],
  ["L1RegisterAsset", 31],
  ["L1UpdateAsset", 32],
  ["L2CreateStakingPool", 33],
  ["L2StakeAssets", 35],
  ["L2UnstakeAssets", 36],
  ["L1UnstakeAssets", 37],
  ["L1SetSystemConfig", 38],
  ["L2ForceBurnShares", 40],
  ["L2UpdateAccountConfig", 41],
  ["L2UpdateAccountAssetConfig", 42],
  ["L2StrategyTransfer", 43],
  ["L2UpdateMarketConfig", 44],
  ["L2ApproveIntegrator", 45],
];

const table: Readonly<Record<string, number>> = TxType as unknown as Readonly<Record<string, number>>;

describe("TxType", () => {
  test("names exactly the 44 assigned codes", () => {
    expect(Object.keys(TxType).length).toBe(44);
    expect(EXPECTED_TX_TYPES.length).toBe(44);
  });

  test("every name maps to its exact protocol code", () => {
    for (const [name, code] of EXPECTED_TX_TYPES) {
      expect({ name, code: table[name] }).toEqual({ name, code });
    }
  });

  test("codes are unique", () => {
    const codes: number[] = Object.values(TxType);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("covers 0-33, 35-38 and 40-45 with no gaps and no extras", () => {
    const codes: readonly number[] = [...Object.values(TxType)].sort((a, b) => a - b);
    const expected: number[] = [];
    for (let i = 0; i <= 45; i += 1) {
      if (i === 34 || i === 39) continue;
      expected.push(i);
    }
    expect(codes).toEqual(expected);
  });

  test("34 (reserved upstream) and 39 (unassigned) are absent", () => {
    const codes: ReadonlySet<number> = new Set(Object.values(TxType));
    expect(codes.has(34)).toBe(false);
    expect(codes.has(39)).toBe(false);
  });
});

describe("CONSTRUCTIBLE_TX_TYPES", () => {
  const EXPECTED: readonly number[] = [
    8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 28, 29, 35, 36, 41, 42, 45,
  ];

  test("has exactly 20 members", () => {
    expect(CONSTRUCTIBLE_TX_TYPES.size).toBe(20);
  });

  test("membership matches the protocol list exactly", () => {
    expect([...CONSTRUCTIBLE_TX_TYPES].sort((a, b) => a - b)).toEqual([...EXPECTED]);
  });

  test("the four L2 codes with no builder are excluded", () => {
    // 33 create staking pool, 40 force burn shares, 43 strategy transfer, 44 update market config.
    for (const code of [33, 40, 43, 44]) {
      expect(CONSTRUCTIBLE_TX_TYPES.has(code)).toBe(false);
    }
  });

  test("no L1 or internal code is constructible", () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 37, 38]) {
      expect(CONSTRUCTIBLE_TX_TYPES.has(code)).toBe(false);
    }
  });

  test("every constructible code is a known TxType", () => {
    const known: ReadonlySet<number> = new Set(Object.values(TxType));
    for (const code of CONSTRUCTIBLE_TX_TYPES) {
      expect(known.has(code)).toBe(true);
    }
  });
});

describe("order enumerations", () => {
  test("OrderType spans 0-8", () => {
    expect(OrderType).toEqual({
      Limit: 0,
      Market: 1,
      StopLoss: 2,
      StopLossLimit: 3,
      TakeProfit: 4,
      TakeProfitLimit: 5,
      Twap: 6,
      TwapSub: 7,
      Liquidation: 8,
    });
  });

  test("API_MAX_ORDER_TYPE is 6, and the two types above it are engine-internal", () => {
    expect(API_MAX_ORDER_TYPE).toBe(6);
    expect(API_MAX_ORDER_TYPE).toBe(OrderType.Twap);
    expect(OrderType.TwapSub).toBeGreaterThan(API_MAX_ORDER_TYPE);
    expect(OrderType.Liquidation).toBeGreaterThan(API_MAX_ORDER_TYPE);
  });

  test("OrderTimeInForce", () => {
    expect(OrderTimeInForce).toEqual({ ImmediateOrCancel: 0, GoodTillTime: 1, PostOnly: 2 });
  });

  test("CancelAllTimeInForce", () => {
    expect(CancelAllTimeInForce).toEqual({
      ImmediateCancelAll: 0,
      ScheduledCancelAll: 1,
      AbortScheduledCancelAll: 2,
    });
  });

  test("GroupingType", () => {
    expect(GroupingType).toEqual({
      None: 0,
      OneTriggersTheOther: 1,
      OneCancelsTheOther: 2,
      OneTriggersAOneCancelsTheOther: 3,
    });
  });
});

describe("margin, asset and routing enumerations", () => {
  test("AssetMarginMode and its maximum", () => {
    expect(AssetMarginMode).toEqual({ Disabled: 0, Enabled: 1 });
    expect(MAX_ASSET_MARGIN_MODE).toBe(1);
    expect(MAX_ASSET_MARGIN_MODE).toBe(AssetMarginMode.Enabled);
  });

  test("AccountAssetMarginMode", () => {
    expect(AccountAssetMarginMode).toEqual({ MarginDisabled: 0, MarginEnabled: 1 });
  });

  test("AssetRouteType", () => {
    expect(AssetRouteType).toEqual({ Perps: 0, Spot: 1 });
  });

  test("MarginMode", () => {
    expect(MarginMode).toEqual({ Cross: 0, Isolated: 1 });
  });

  test("MarginDirection", () => {
    expect(MarginDirection).toEqual({ RemoveFromIsolated: 0, AddToIsolated: 1 });
  });
});

describe("self-trade enumerations", () => {
  test("SelfTradeBehavior", () => {
    expect(SelfTradeBehavior).toEqual({
      ExpireMaker: 0,
      ExpireTaker: 1,
      CancelBoth: 2,
      Reduce: 3,
    });
  });

  test("SelfTradeEquality", () => {
    expect(SelfTradeEquality).toEqual({ AccountIndex: 0, MasterAccountIndex: 1 });
  });
});

describe("account and pool enumerations", () => {
  test("AccountTradingMode", () => {
    expect(AccountTradingMode).toEqual({ Standard: 0, Unified: 1 });
  });

  test("PoolStatus", () => {
    expect(PoolStatus).toEqual({ Closed: 0, Open: 1 });
  });
});

describe("shape", () => {
  test("every enumeration value is a non-negative safe integer", () => {
    const groups: ReadonlyArray<Readonly<Record<string, number>>> = [
      TxType,
      OrderType,
      OrderTimeInForce,
      CancelAllTimeInForce,
      GroupingType,
      AssetMarginMode,
      AccountAssetMarginMode,
      AssetRouteType,
      MarginMode,
      MarginDirection,
      SelfTradeBehavior,
      SelfTradeEquality,
      AccountTradingMode,
      PoolStatus,
    ];
    for (const group of groups) {
      for (const value of Object.values(group)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("no enumeration carries a bigint (these are all narrow wire codes)", () => {
    for (const value of Object.values(TxType)) {
      expect(typeof value).toBe("number");
    }
  });
});
