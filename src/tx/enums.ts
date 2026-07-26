/**
 * Protocol enumerations — pure data, zero imports, zero side effects.
 *
 * Every enumeration in the Lighter protocol is a small integer on the wire. This module is the one
 * place those integers are named, and every other module under `src/tx/**` reads them from here.
 *
 * Three things about the shape of this file are deliberate:
 *
 * 1. **Nothing here uses TypeScript's built-in enumeration declaration.** The package compiles with
 *    `erasableSyntaxOnly` (`docs/ARCHITECTURE.md` §2, D9), which forbids that syntax outright, and
 *    a grep gate in CI enforces the keyword's absence. Every enumeration is an `as const` object
 *    plus a literal union derived from it. That is strictly more useful than the built-in form: the
 *    union is assignable from a raw decoded `number` after a narrowing check, values round-trip
 *    through JSON unchanged, and nothing is emitted at runtime beyond the object itself.
 * 2. **{@link TxType} is the complete code table, not the constructible subset.** Codes for L1
 *    transactions, sequencer-internal transactions, and L2 transactions this SDK has no builder for
 *    all appear in the `tx_type` field of REST and WebSocket responses. A decoder that only knows
 *    the twenty types it can build cannot name what it reads back. The subset that *can* be built
 *    is {@link CONSTRUCTIBLE_TX_TYPES}, and it is a separate thing.
 * 3. **Codes `34` and `39` are absent, and that is not an oversight.** `34` is reserved upstream
 *    (commented out in the reference's own table) and `39` was never assigned. Inventing names for
 *    them would put values on the wire that the sequencer rejects.
 *
 * The enumerations here name values. They do not decide which values are legal in which position —
 * `ApiMaxOrderType` exists precisely because {@link OrderType} carries two internal types a client
 * may never submit, and the same is true of {@link TxType} versus {@link CONSTRUCTIBLE_TX_TYPES}.
 * Those rules live with the validators.
 */

/* -------------------------------------------------------------------------------------------------
 * Transaction types
 * ---------------------------------------------------------------------------------------------- */

/**
 * The complete transaction-type code table.
 *
 * 44 members covering `0`–`33`, `35`–`38` and `40`–`45`. `34` is reserved and `39` is unassigned;
 * both are omitted rather than named.
 *
 * Prefixes carry meaning:
 * - `L1*` — originates on Ethereum and is observed, never constructed here.
 * - `Internal*` — produced by the sequencer itself (liquidations, deleveraging, claims). Appears in
 *   responses; never submittable.
 * - `L2*` — an L2 transaction. Most, but *not* all, are constructible by this SDK — see
 *   {@link CONSTRUCTIBLE_TX_TYPES}.
 */
export const TxType = {
  /** Placeholder / unset. Never valid on the wire. */
  Empty: 0,

  // ---- L1-originated ----
  L1Deposit: 1,
  L1ChangePubKey: 2,
  L1CreateMarket: 3,
  L1UpdateMarket: 4,
  L1CancelAllOrders: 5,
  L1Withdraw: 6,
  L1CreateOrder: 7,

  // ---- L2, constructible ----
  L2ChangePubKey: 8,
  L2CreateSubAccount: 9,
  L2CreatePublicPool: 10,
  L2UpdatePublicPool: 11,
  L2Transfer: 12,
  L2Withdraw: 13,
  L2CreateOrder: 14,
  L2CancelOrder: 15,
  L2CancelAllOrders: 16,
  L2ModifyOrder: 17,
  L2MintShares: 18,
  L2BurnShares: 19,
  L2UpdateLeverage: 20,

  // ---- sequencer-internal ----
  InternalClaimOrder: 21,
  InternalCancelOrder: 22,
  InternalDeleverage: 23,
  InternalExitPosition: 24,
  InternalCancelAllOrders: 25,
  InternalLiquidatePosition: 26,
  InternalCreateOrder: 27,

  // ---- L2, constructible (continued) ----
  L2CreateGroupedOrders: 28,
  L2UpdateMargin: 29,

  // ---- L1-originated (continued) ----
  L1BurnShares: 30,
  L1RegisterAsset: 31,
  L1UpdateAsset: 32,

  /** L2, but there is no client builder — it appears only in decoded responses. */
  L2CreateStakingPool: 33,

  // 34 is reserved upstream and intentionally unnamed.

  L2StakeAssets: 35,
  L2UnstakeAssets: 36,

  L1UnstakeAssets: 37,
  L1SetSystemConfig: 38,

  // 39 is unassigned and intentionally unnamed.

  /** L2, sequencer-issued. No client builder. */
  L2ForceBurnShares: 40,

  L2UpdateAccountConfig: 41,
  L2UpdateAccountAssetConfig: 42,

  /** L2, no client builder. */
  L2StrategyTransfer: 43,
  /** L2, no client builder — market configuration is an operator action. */
  L2UpdateMarketConfig: 44,

  L2ApproveIntegrator: 45,
} as const;

/** Any transaction-type code this SDK can name. Includes L1, internal and non-constructible codes. */
export type TxTypeCode = (typeof TxType)[keyof typeof TxType];

/** The name side of {@link TxType} — useful for exhaustive tables keyed by transaction. */
export type TxTypeName = keyof typeof TxType;

/**
 * The twenty L2 transaction types this SDK can build, hash and sign.
 *
 * Membership is the *only* correct test for "can I construct this?". It is not derivable from the
 * `L2` prefix: `33` (create staking pool), `40` (force burn shares), `43` (strategy transfer) and
 * `44` (update market config) are all L2 codes that exist purely so responses can be decoded.
 */
export const CONSTRUCTIBLE_TX_TYPES: ReadonlySet<number> = new Set<number>([
  TxType.L2ChangePubKey,
  TxType.L2CreateSubAccount,
  TxType.L2CreatePublicPool,
  TxType.L2UpdatePublicPool,
  TxType.L2Transfer,
  TxType.L2Withdraw,
  TxType.L2CreateOrder,
  TxType.L2CancelOrder,
  TxType.L2CancelAllOrders,
  TxType.L2ModifyOrder,
  TxType.L2MintShares,
  TxType.L2BurnShares,
  TxType.L2UpdateLeverage,
  TxType.L2CreateGroupedOrders,
  TxType.L2UpdateMargin,
  TxType.L2StakeAssets,
  TxType.L2UnstakeAssets,
  TxType.L2UpdateAccountConfig,
  TxType.L2UpdateAccountAssetConfig,
  TxType.L2ApproveIntegrator,
]);

/* -------------------------------------------------------------------------------------------------
 * Orders
 * ---------------------------------------------------------------------------------------------- */

/**
 * Order type (`spec/04-tx-types.md` §11.1).
 *
 * `0`–`6` are client-settable; `7` and `8` are produced by the matching engine and appear only in
 * decoded responses. {@link API_MAX_ORDER_TYPE} is the boundary.
 */
export const OrderType = {
  Limit: 0,
  Market: 1,
  StopLoss: 2,
  StopLossLimit: 3,
  TakeProfit: 4,
  TakeProfitLimit: 5,
  Twap: 6,

  /** Internal: a single slice of a TWAP parent. Not client-settable. */
  TwapSub: 7,
  /** Internal: generated by the liquidation engine. Not client-settable. */
  Liquidation: 8,
} as const;

/** Any order-type code, including the two internal ones. */
export type OrderTypeCode = (typeof OrderType)[keyof typeof OrderType];

/**
 * Highest order type a client may submit — `6` (`Twap`).
 *
 * Anything above this is engine-generated. Named separately because the reference validator's rule
 * is `type > ApiMaxOrderType → reject`, not membership in a set.
 */
export const API_MAX_ORDER_TYPE: 6 = 6;

/** Order time-in-force (`spec/04-tx-types.md` §11.2). */
export const OrderTimeInForce = {
  ImmediateOrCancel: 0,
  GoodTillTime: 1,
  PostOnly: 2,
} as const;

/** Any order time-in-force code. */
export type OrderTimeInForceCode = (typeof OrderTimeInForce)[keyof typeof OrderTimeInForce];

/**
 * Cancel-all time-in-force (`spec/04-tx-types.md` §11.3).
 *
 * A distinct enumeration from {@link OrderTimeInForce} despite the overlapping numeric range: these
 * are the modes of `L2CancelAllOrders`, and the per-market cancel-all attribute is valid only
 * alongside `ImmediateCancelAll` (`docs/protocol-notes.md` §11).
 */
export const CancelAllTimeInForce = {
  ImmediateCancelAll: 0,
  ScheduledCancelAll: 1,
  AbortScheduledCancelAll: 2,
} as const;

/** Any cancel-all time-in-force code. */
export type CancelAllTimeInForceCode =
  (typeof CancelAllTimeInForce)[keyof typeof CancelAllTimeInForce];

/**
 * Grouped-order relationship (`spec/04-tx-types.md` §11.4).
 *
 * Leg counts and leg rules are fixed per type and enforced strictly — see
 * `docs/protocol-notes.md` §4.
 */
export const GroupingType = {
  /** No grouping. */
  None: 0,
  /** One-triggers-the-other. Exactly two legs. */
  OneTriggersTheOther: 1,
  /** One-cancels-the-other. Exactly two legs. */
  OneCancelsTheOther: 2,
  /** One-triggers-a-one-cancels-the-other. Exactly three legs. */
  OneTriggersAOneCancelsTheOther: 3,
} as const;

/** Any grouping-type code. */
export type GroupingTypeCode = (typeof GroupingType)[keyof typeof GroupingType];

/* -------------------------------------------------------------------------------------------------
 * Margin, assets and routing
 * ---------------------------------------------------------------------------------------------- */

/** Whether an asset may be used as margin at all, exchange-wide (`spec/04-tx-types.md` §11.5). */
export const AssetMarginMode = {
  Disabled: 0,
  Enabled: 1,
} as const;

/** Any asset-margin-mode code. */
export type AssetMarginModeCode = (typeof AssetMarginMode)[keyof typeof AssetMarginMode];

/** Highest legal {@link AssetMarginMode} value. The validator compares against a bound, not a set. */
export const MAX_ASSET_MARGIN_MODE: 1 = 1;

/**
 * Whether *this account* uses a given asset as margin (`spec/04-tx-types.md` §11.5).
 *
 * Numerically identical to {@link AssetMarginMode} and semantically distinct: this is per-account
 * opt-in, that is an exchange-wide capability. They are separate types so one cannot be passed
 * where the other belongs.
 */
export const AccountAssetMarginMode = {
  MarginDisabled: 0,
  MarginEnabled: 1,
} as const;

/** Any account-asset-margin-mode code. */
export type AccountAssetMarginModeCode =
  (typeof AccountAssetMarginMode)[keyof typeof AccountAssetMarginMode];

/** Which market family an asset routes into (`spec/04-tx-types.md` §11.5). */
export const AssetRouteType = {
  Perps: 0,
  Spot: 1,
} as const;

/** Any asset-route-type code. */
export type AssetRouteTypeCode = (typeof AssetRouteType)[keyof typeof AssetRouteType];

/** Position margin mode (`spec/04-tx-types.md` §11.5). */
export const MarginMode = {
  Cross: 0,
  Isolated: 1,
} as const;

/** Any margin-mode code. */
export type MarginModeCode = (typeof MarginMode)[keyof typeof MarginMode];

/**
 * Direction of an `L2UpdateMargin` (`spec/04-tx-types.md` §11.5).
 *
 * Note that the direction is a *separate* field from the amount's sign: `USDCAmount` has no lower
 * bound in the reference validator and negative values are reachable
 * (`docs/protocol-notes.md` §3.2).
 */
export const MarginDirection = {
  RemoveFromIsolated: 0,
  AddToIsolated: 1,
} as const;

/** Any margin-direction code. */
export type MarginDirectionCode = (typeof MarginDirection)[keyof typeof MarginDirection];

/* -------------------------------------------------------------------------------------------------
 * Self-trade handling
 * ---------------------------------------------------------------------------------------------- */

/** What happens when an order would trade against its own side (`spec/04-tx-types.md` §11.6). */
export const SelfTradeBehavior = {
  ExpireMaker: 0,
  ExpireTaker: 1,
  CancelBoth: 2,
  /** Net the two orders down. Not combinable with mark-adjusted-index margin. */
  Reduce: 3,
} as const;

/** Any self-trade-behavior code. */
export type SelfTradeBehaviorCode = (typeof SelfTradeBehavior)[keyof typeof SelfTradeBehavior];

/** Which identity counts as "self" for self-trade detection (`spec/04-tx-types.md` §11.6). */
export const SelfTradeEquality = {
  /** Only the exact sub-account. */
  AccountIndex: 0,
  /** The whole account family, master included. */
  MasterAccountIndex: 1,
} as const;

/** Any self-trade-equality code. */
export type SelfTradeEqualityCode = (typeof SelfTradeEquality)[keyof typeof SelfTradeEquality];

/* -------------------------------------------------------------------------------------------------
 * Account and pool configuration
 * ---------------------------------------------------------------------------------------------- */

/** Account trading mode (`spec/04-tx-types.md` §7.17). */
export const AccountTradingMode = {
  Standard: 0,
  Unified: 1,
} as const;

/** Any account-trading-mode code. */
export type AccountTradingModeCode = (typeof AccountTradingMode)[keyof typeof AccountTradingMode];

/** Public-pool status (`spec/04-tx-types.md` §7.4). */
export const PoolStatus = {
  Closed: 0,
  Open: 1,
} as const;

/** Any pool-status code. */
export type PoolStatusCode = (typeof PoolStatus)[keyof typeof PoolStatus];
