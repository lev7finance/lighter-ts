/**
 * Every REST operation, as one declarative table.
 *
 * This replaces ~78 hand-written request methods (and the reference Python SDK's 13 API classes
 * × 3 method variants = 234 methods) with data: one `request()` implementation reads this table,
 * and the grouped client facade is derived from it by mapping over the entries.
 *
 * ## Reading an entry
 *
 * `query`, `body` and `response` are phantom properties — `{} as T` carries the type and emits an
 * empty object literal, so the whole table is inert data with no runtime cost beyond its string
 * literals. `as const satisfies Record<string, RouteDef>` checks every entry against
 * {@link RouteDef} while preserving literal key types so the facade can be built from `typeof
 * routes`. **Do not add an explicit type annotation to `routes`** — that widens the phantoms and
 * destroys the inference the entire design rests on.
 *
 * Keys are the OpenAPI operation ids, camel-cased: `referral_userReferrals` → `referralUserReferrals`,
 * `deposit_history` → `depositHistory`, `funding-rates` → `fundingRates`. `export` is one of them;
 * it is a legal property key and a legal method name, so it stays as the wire spells it.
 *
 * ## What is hand-maintained here, and why
 *
 * `auth` is corrected data, seeded from `spec/openapi.snapshot.json` and then **overridden by live
 * probes** (`spec/05-rest-api.md` §5.4). Six operations the document declares optional are enforced
 * at runtime; two write operations the naive reading would protect take no token at all. A
 * generator pointed at the document gets all eight wrong. See the comments on those entries — and
 * `test/rest/routes.test.ts`, which pins them.
 *
 * Ranges and defaults live in doc comments and in the phantom types, never in validation code:
 * the server enforces them, its errors are the authority, and a client-side copy of a bound is a
 * second source of truth that will drift.
 *
 * ## Array-shaped inputs
 *
 * Exactly two parameters repeat their key (`style=form, explode=true`) and are typed as arrays:
 * `accountTxs.types` and `transferHistory.type`. **Every other array-shaped input is a
 * JSON-encoded string in a single field** — `sendTxBatch.tx_types` (`"[14,15]"`),
 * `sendTxBatch.tx_infos` (a JSON array of strings, each itself a JSON object) and
 * `setMakerOnlyApiKeys.api_key_indexes` (`"[4,5]"`; `"[]"` clears). Those three are `string` on
 * their request models, so the transport never has to guess which convention applies.
 *
 * ## `auth` as an input field
 *
 * Nine form bodies declare an optional `auth` field, and it is optional on their request models.
 * Callers are never asked for it: the transport injects credentials, preferring the `Authorization`
 * header and omitting the body field (`spec/05-rest-api.md` §5.2). For the same reason the four
 * operations that declare an `auth` **query** parameter (`accountTxs`, `leases`,
 * `referralUserReferrals`, `referralGet`) do not carry it in their phantom query types — the
 * server accepts header and query interchangeably on *every* operation, so singling out four of
 * sixty would document a distinction that does not exist.
 */

import type {
  AccountApiKeys,
  AccountLimits,
  AccountMetadatas,
  DetailedAccounts,
  LiquidationInfos,
  PositionFundings,
  ReqChangeAccountTier,
  ReqPostApiToken,
  ReqRevokeApiToken,
  ReqSetAccountMetadata,
  ReqSetMakerOnlyApiKeys,
  SubAccounts,
} from "../models/account.js";
import type { MarketType, ResultCode, Role, Side, SortDir } from "../models/common.js";
import type { ReqLITLease, RespGetLeaseOptions, RespGetLeases } from "../models/lease.js";
import type {
  AssetDetails,
  Fundings,
  FundingRates,
  OrderBookDetails,
  OrderBooks,
  SystemConfig,
} from "../models/market.js";
import type {
  AccountPnL,
  Announcements,
  BridgeSupportedNetworks,
  CreateIntentAddressResp,
  Deposit,
  DepositHistory,
  ExchangeStats,
  ExportData,
  Layer1BasicInfo,
  ReqAckNotif,
  ReqCreateIntentAddress,
  ReqFastwithdraw,
  RespChangeAccountTier,
  RespGetApiTokens,
  RespGetExchangeMetrics,
  RespGetExecuteStats,
  RespGetFastBridgeInfo,
  RespGetFastwithdrawalInfo,
  RespGetMakerOnlyApiKeys,
  RespPostApiToken,
  RespRevokeApiToken,
  RespSetMakerOnlyApiKeys,
  RespSyntheticSpotInfo,
  RespWithdrawalDelay,
  Status,
  TokenList,
  TransferFeeInfo,
  TransferHistory,
  WithdrawHistory,
  ZkLighterInfo,
} from "../models/misc.js";
import type { Candles, OrderBookOrders, Orders, Trades } from "../models/order.js";
import type { RespPublicPoolsMetadata } from "../models/pool.js";
import type {
  L1Metadata,
  PartnerStats,
  ReferralCode,
  ReferralPoints,
  ReqCreateReferralCode,
  ReqUpdateKickback,
  ReqUpdateReferralCode,
  ReqUseReferralCode,
  RespUpdateKickback,
  RespUpdateReferralCode,
  UserReferrals,
} from "../models/referral.js";
import type {
  ReqCreateRFQ,
  ReqRespondToRFQ,
  ReqUpdateRFQ,
  RespCreateRFQ,
  RespGetRFQ,
  RespListRFQs,
  RespRespondToRFQ,
  RespUpdateRFQ,
  RFQListStatus,
} from "../models/rfq.js";
import type {
  Blocks,
  CurrentHeight,
  EnrichedTx,
  NextNonce,
  ReqSendTx,
  ReqSendTxBatch,
  RespSendTx,
  RespSendTxBatch,
  TxHash,
  Txs,
} from "../models/transaction.js";
import type { RouteDef } from "./route-types.js";

/* ---------------------------------------------------------------------------------------------- */
/* Query-parameter vocabularies                                                                     */
/*                                                                                                  */
/* Local to this module on purpose: they describe *inputs* to specific operations, not wire models,  */
/* and several are near-misses of each other that must not be merged.                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `candles` only. **Three resolution unions exist and they are not interchangeable** — sharing one
 * silently permits requests the server rejects with a bare `invalid param `.
 */
type CandleResolution = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "1d" | "1w";

/** `pnl` only. No `30m`, no `12h`, no `1w`. */
type PnlResolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** `fundings` only. Two values. */
type FundingResolution = "1h" | "1d";

/**
 * The `ask_filter` tri-state, declared `i8`: `-1` both sides, `0` bids, `1` asks.
 *
 * Modelled exactly as the wire declares it. Translating it into a friendlier `side` is the
 * facade's job; doing it here would make the table lie about the request it produces.
 */
type AskFilter = -1 | 0 | 1;

/** `deposit/history` and `withdraw/history`. */
type HistoryFilter = "all" | "pending" | "claimable";

/** `trades.type` and `export.trade_type` — {@link import("../models/order.js").TradeType} plus `'all'`. */
type TradeKindFilter = "all" | "trade" | "liquidation" | "deleverage" | "market-settlement";

/**
 * `transferHistory.type`, repeated per value.
 *
 * These are the **undirected** names. The response's `type` field uses direction-qualified ones
 * (`L2TransferInflow`, `L2TransferOutflow`, …). The two vocabularies are not interchangeable.
 */
type TransferTypeFilter =
  | "all"
  | "L2Transfer"
  | "L2MintShares"
  | "L2BurnShares"
  | "L2StakeAssets"
  | "L2UnstakeAssets";

/** `publicPoolsMetadata.filter`. `stake` surfaces staking pools. */
type PublicPoolFilter = "all" | "user" | "protocol" | "account_index" | "stake";

/** `exchangeMetrics.period`. Includes `h`, which `executeStats` does not. */
type ExchangeMetricPeriod = "h" | "d" | "w" | "m" | "q" | "y" | "all";

/** `exchangeMetrics.kind`. */
type ExchangeMetricKind =
  | "volume"
  | "maker_fee"
  | "taker_fee"
  | "liquidation_fee"
  | "trade_count"
  | "liquidation_count"
  | "liquidation_volume"
  | "inflow"
  | "outflow"
  | "transfer_fee"
  | "withdraw_fee"
  | "open_interest"
  | "account_count"
  | "active_account_count"
  | "tps"
  | "buyback"
  | "buyback_usdc";

/** `executeStats.period`. No `h`. */
type ExecuteStatsPeriod = "d" | "w" | "m" | "q" | "y" | "all";

/* ---------------------------------------------------------------------------------------------- */
/* The table                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export const routes = {
  /* -- group `account` (26) -------------------------------------------------------------------- */

  /** Look an account up by index or by L1 address. Paginated. */
  account: {
    method: "GET",
    path: "/api/v1/account",
    auth: "none",
    group: "account",
    itemsKey: "accounts",
    query: {} as {
      by: "index" | "l1_address";
      value: string;
      /** Hide markets the account has never traded. Defaults to `false`. */
      active_only?: boolean;
      cursor?: string;
    },
    response: {} as DetailedAccounts,
  },

  /** Account limits and tier. See https://apidocs.lighter.xyz/docs/account-types */
  accountLimits: {
    method: "GET",
    path: "/api/v1/accountLimits",
    auth: "required",
    group: "account",
    query: {} as { account_index: number },
    response: {} as AccountLimits,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4. The OpenAPI document declares
   * `authorization` optional here; a live unauthenticated call is rejected. Do not "fix" this back.
   */
  accountMetadata: {
    method: "GET",
    path: "/api/v1/accountMetadata",
    auth: "required",
    group: "account",
    itemsKey: "account_metadatas",
    query: {} as { by: "index" | "l1_address"; value: string; cursor?: string },
    response: {} as AccountMetadatas,
  },

  /** Every sub-account under one L1 address. */
  accountsByL1Address: {
    method: "GET",
    path: "/api/v1/accountsByL1Address",
    auth: "none",
    group: "account",
    itemsKey: "sub_accounts",
    query: {} as { l1_address: string; cursor?: string },
    response: {} as SubAccounts,
  },

  /** Set `api_key_index` to `255` (the default) to retrieve every key on the account. */
  apikeys: {
    method: "GET",
    path: "/api/v1/apikeys",
    auth: "none",
    group: "account",
    itemsKey: "api_keys",
    query: {} as { account_index: number; api_key_index?: number },
    response: {} as AccountApiKeys,
  },

  /** Once per 24h, and only with no open orders or positions. */
  changeAccountTier: {
    method: "POST",
    path: "/api/v1/changeAccountTier",
    auth: "optional",
    encoding: "form",
    group: "account",
    body: {} as ReqChangeAccountTier,
    response: {} as RespChangeAccountTier,
  },

  getMakerOnlyApiKeys: {
    method: "GET",
    path: "/api/v1/getMakerOnlyApiKeys",
    auth: "required",
    group: "account",
    query: {} as { account_index: number },
    response: {} as RespGetMakerOnlyApiKeys,
  },

  l1Metadata: {
    method: "GET",
    path: "/api/v1/l1Metadata",
    auth: "required",
    group: "account",
    query: {} as { l1_address: string },
    response: {} as L1Metadata,
  },

  /** Available LIT lease duration/rate tiers, sorted by duration descending. No parameters. */
  leaseOptions: {
    method: "GET",
    path: "/api/v1/leaseOptions",
    auth: "none",
    group: "account",
    itemsKey: "options",
    response: {} as RespGetLeaseOptions,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4 (declared optional, enforced).
   *
   * `limit` is `1..100` and defaults to `20` — one of only two endpoints with a `limit` default.
   */
  leases: {
    method: "GET",
    path: "/api/v1/leases",
    auth: "required",
    group: "account",
    itemsKey: "leases",
    query: {} as { account_index: number; cursor?: string; limit?: number },
    response: {} as RespGetLeases,
  },

  /** `limit` is required, range `1..100`. `market_id` defaults to `255` (all markets). */
  liquidations: {
    method: "GET",
    path: "/api/v1/liquidations",
    auth: "required",
    group: "account",
    itemsKey: "liquidations",
    query: {} as {
      account_index: number;
      market_id?: number;
      cursor?: string;
      limit: number;
    },
    response: {} as LiquidationInfos,
  },

  /**
   * A LIT lease transfer. Like `fastwithdraw`, this carries its own signed transaction rather
   * than going through `/sendTx`, so the L2 signature is inside `tx_info`.
   */
  litLease: {
    method: "POST",
    path: "/api/v1/litLease",
    auth: "optional",
    encoding: "form",
    group: "account",
    body: {} as ReqLITLease,
    response: {} as TxHash,
  },

  /** All-time figures when both timestamps are omitted. */
  partnerStats: {
    method: "GET",
    path: "/api/v1/partnerStats",
    auth: "none",
    group: "account",
    query: {} as {
      account_index: number;
      /** Epoch milliseconds. */
      start_timestamp?: number;
      /** Epoch milliseconds. */
      end_timestamp?: number;
    },
    response: {} as PartnerStats,
  },

  /**
   * Account PnL chart. Genuinely auth-optional — verified 200 without a token; a bad range is
   * rejected on the range, not on auth (`spec/05-rest-api.md` §5.4).
   *
   * `resolution` is {@link PnlResolution}, which is **narrower** than `candles`'.
   */
  pnl: {
    method: "GET",
    path: "/api/v1/pnl",
    auth: "optional",
    group: "account",
    itemsKey: "pnl",
    query: {} as {
      by: "index";
      value: string;
      resolution: PnlResolution;
      /** Epoch milliseconds, range `0..5000000000000`. */
      start_timestamp: number;
      /** Epoch milliseconds, range `0..5000000000000`. */
      end_timestamp: number;
      count_back: number;
      ignore_transfers?: boolean;
    },
    response: {} as AccountPnL,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4. Declared optional; a live
   * unauthenticated call returns `auth required for main accounts`.
   *
   * `limit` is required, range `1..100`.
   */
  positionFunding: {
    method: "GET",
    path: "/api/v1/positionFunding",
    auth: "required",
    group: "account",
    itemsKey: "position_fundings",
    query: {} as {
      account_index: number;
      market_id?: number;
      cursor?: string;
      limit: number;
      side?: Side;
      /** Epoch milliseconds. */
      start_timestamp?: number;
      /** Epoch milliseconds. */
      end_timestamp?: number;
    },
    response: {} as PositionFundings,
  },

  /**
   * Genuinely auth-optional — verified 200 without a token (`spec/05-rest-api.md` §5.4). A token
   * is only needed when filtering by `account_index`.
   *
   * Both `index` and `limit` are required; `limit` is `1..100`.
   */
  publicPoolsMetadata: {
    method: "GET",
    path: "/api/v1/publicPoolsMetadata",
    auth: "optional",
    group: "account",
    itemsKey: "public_pools",
    query: {} as {
      filter?: PublicPoolFilter;
      index: number;
      limit: number;
      account_index?: number;
    },
    response: {} as RespPublicPoolsMetadata,
  },

  /**
   * Tagged `account` by the document, not `referral`. `limit` is `1..300` here — the widest bound
   * on the API.
   */
  referralUserReferrals: {
    method: "GET",
    path: "/api/v1/referral/userReferrals",
    auth: "optional",
    group: "account",
    itemsKey: "referrals",
    query: {} as {
      l1_address: string;
      cursor?: string;
      /** Epoch milliseconds. */
      stats_start_timestamp?: number;
      /** Epoch milliseconds. */
      stats_end_timestamp?: number;
      /** Range `1..300`. */
      limit?: number;
    },
    response: {} as UserReferrals,
  },

  /** RFQ operations are tagged `account` by the document. */
  rfqCreate: {
    method: "POST",
    path: "/api/v1/rfq/create",
    auth: "required",
    encoding: "form",
    group: "account",
    body: {} as ReqCreateRFQ,
    response: {} as RespCreateRFQ,
  },

  rfqGet: {
    method: "GET",
    path: "/api/v1/rfq/get",
    auth: "required",
    group: "account",
    query: {} as { rfq_id: number },
    response: {} as RespGetRFQ,
  },

  /**
   * `account_index` defaults to `281474976710655` (2^48−1, the "none" sentinel) and `limit`
   * defaults to `20`.
   */
  rfqList: {
    method: "GET",
    path: "/api/v1/rfq/list",
    auth: "required",
    group: "account",
    itemsKey: "rfqs",
    query: {} as {
      account_index?: number;
      status?: RFQListStatus;
      cursor?: string;
      limit?: number;
    },
    response: {} as RespListRFQs,
  },

  rfqRespond: {
    method: "POST",
    path: "/api/v1/rfq/respond",
    auth: "required",
    encoding: "form",
    group: "account",
    body: {} as ReqRespondToRFQ,
    response: {} as RespRespondToRFQ,
  },

  rfqUpdate: {
    method: "POST",
    path: "/api/v1/rfq/update",
    auth: "required",
    encoding: "form",
    group: "account",
    body: {} as ReqUpdateRFQ,
    response: {} as RespUpdateRFQ,
  },

  /**
   * Replaces the whole maker-only set. `api_key_indexes` is a JSON array **string** (`"[4,5]"`;
   * `"[]"` clears) — not a repeated field, not a comma list.
   *
   * The document also advertises `multipart/form-data` for this operation. It is not modelled and
   * must not be implemented; `encoding: 'form'` is the only supported serialisation.
   */
  setMakerOnlyApiKeys: {
    method: "POST",
    path: "/api/v1/setMakerOnlyApiKeys",
    auth: "required",
    encoding: "form",
    group: "account",
    body: {} as ReqSetMakerOnlyApiKeys,
    response: {} as RespSetMakerOnlyApiKeys,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4 (declared optional, enforced).
   *
   * Lists the managed read-only tokens of auth scheme B; the request itself is authenticated with
   * scheme A.
   */
  tokens: {
    method: "GET",
    path: "/api/v1/tokens",
    auth: "required",
    group: "account",
    itemsKey: "api_tokens",
    query: {} as { account_index: number },
    response: {} as RespGetApiTokens,
  },

  /**
   * Mint a managed read-only token (scheme B). `spec/05-rest-api.md` §5.3 says the three token
   * management operations are themselves scheme-A authenticated, but only the `tokens` *read* was
   * probed live (§5.4), so this stays `'optional'` rather than being upgraded on inference — the
   * whole point of §5.4 is that auth requirement is evidence, not derivation.
   */
  tokensCreate: {
    method: "POST",
    path: "/api/v1/tokens/create",
    auth: "optional",
    encoding: "form",
    group: "account",
    body: {} as ReqPostApiToken,
    response: {} as RespPostApiToken,
  },

  /** See the note on `tokensCreate` about why this is `'optional'` and not `'required'`. */
  tokensRevoke: {
    method: "POST",
    path: "/api/v1/tokens/revoke",
    auth: "optional",
    encoding: "form",
    group: "account",
    body: {} as ReqRevokeApiToken,
    response: {} as RespRevokeApiToken,
  },

  /* -- group `announcement` (1) ---------------------------------------------------------------- */

  /** No parameters. `created_at` / `expired_at` on the items are epoch **seconds**. */
  announcement: {
    method: "GET",
    path: "/api/v1/announcement",
    auth: "none",
    group: "announcement",
    itemsKey: "announcements",
    response: {} as Announcements,
  },

  /* -- group `block` (3) ----------------------------------------------------------------------- */

  /** One block, by height or by commitment. Returns the collection shape regardless. */
  block: {
    method: "GET",
    path: "/api/v1/block",
    auth: "none",
    group: "block",
    itemsKey: "blocks",
    query: {} as { by: "commitment" | "height"; value: string },
    response: {} as Blocks,
  },

  /** `limit` is required, range `1..100`. `sort` defaults to `asc`. */
  blocks: {
    method: "GET",
    path: "/api/v1/blocks",
    auth: "none",
    group: "block",
    itemsKey: "blocks",
    query: {} as { index?: number; limit: number; sort?: "asc" | "desc" },
    response: {} as Blocks,
  },

  /**
   * No parameters. Note that CloudFront answers this path with an HTML 403 on some routes
   * (`docs/protocol-notes.md` §8.2) — a non-JSON body here is a transport condition, not a parse bug.
   */
  currentHeight: {
    method: "GET",
    path: "/api/v1/currentHeight",
    auth: "none",
    group: "block",
    response: {} as CurrentHeight,
  },

  /* -- group `bridge` (6) ---------------------------------------------------------------------- */

  /** Mint a CCTP bridge intent address. */
  createIntentAddress: {
    method: "POST",
    path: "/api/v1/createIntentAddress",
    auth: "none",
    encoding: "form",
    group: "bridge",
    body: {} as ReqCreateIntentAddress,
    response: {} as CreateIntentAddressResp,
  },

  depositLatest: {
    method: "GET",
    path: "/api/v1/deposit/latest",
    auth: "none",
    group: "bridge",
    query: {} as { l1_address: string },
    response: {} as Deposit,
  },

  /** No parameters. */
  depositNetworks: {
    method: "GET",
    path: "/api/v1/deposit/networks",
    auth: "none",
    group: "bridge",
    itemsKey: "networks",
    response: {} as BridgeSupportedNetworks,
  },

  /** No parameters. */
  fastbridgeInfo: {
    method: "GET",
    path: "/api/v1/fastbridge/info",
    auth: "none",
    group: "bridge",
    response: {} as RespGetFastBridgeInfo,
  },

  /** Carries its own signed withdraw inside `tx_info`; does not go through `/sendTx`. */
  fastwithdraw: {
    method: "POST",
    path: "/api/v1/fastwithdraw",
    auth: "optional",
    encoding: "form",
    group: "bridge",
    body: {} as ReqFastwithdraw,
    response: {} as ResultCode,
  },

  fastwithdrawInfo: {
    method: "GET",
    path: "/api/v1/fastwithdraw/info",
    auth: "required",
    group: "bridge",
    query: {} as { account_index: number },
    response: {} as RespGetFastwithdrawalInfo,
  },

  /* -- group `candlestick` (2) ----------------------------------------------------------------- */

  /**
   * At most 500 candles per call; zero values are omitted from the response.
   *
   * `itemsKey` is `c` — `Candles.c` is the array, while `Candle.c` one level down is the close
   * price. Both are correct and neither may be renamed.
   */
  candles: {
    method: "GET",
    path: "/api/v1/candles",
    auth: "none",
    group: "candlestick",
    itemsKey: "c",
    query: {} as {
      market_id: number;
      resolution: CandleResolution;
      /** Epoch milliseconds, range `0..5000000000000`. */
      start_timestamp: number;
      /** Epoch milliseconds, range `0..5000000000000`. */
      end_timestamp: number;
      count_back: number;
      /** Report `t` as the interval *end* rather than its start. Defaults to `false`. */
      set_timestamp_to_end?: boolean;
    },
    response: {} as Candles,
  },

  /** `resolution` here is {@link FundingResolution} — `1h` or `1d`, nothing else. */
  fundings: {
    method: "GET",
    path: "/api/v1/fundings",
    auth: "none",
    group: "candlestick",
    itemsKey: "fundings",
    query: {} as {
      market_id: number;
      resolution: FundingResolution;
      /** Epoch milliseconds, range `0..5000000000000`. */
      start_timestamp: number;
      /** Epoch milliseconds, range `0..5000000000000`. */
      end_timestamp: number;
      count_back: number;
    },
    response: {} as Fundings,
  },

  /* -- group `funding` (1) --------------------------------------------------------------------- */

  /** Operation id `funding-rates`. No parameters. */
  fundingRates: {
    method: "GET",
    path: "/api/v1/funding-rates",
    auth: "none",
    group: "funding",
    itemsKey: "funding_rates",
    response: {} as FundingRates,
  },

  /* -- group `info` (5) ------------------------------------------------------------------------ */

  /**
   * No parameters. Carries three separate collections (`l1_providers`, `validator_info`,
   * `contract_addresses`), so it declares no `itemsKey`.
   */
  layer1BasicInfo: {
    method: "GET",
    path: "/api/v1/layer1BasicInfo",
    auth: "none",
    group: "info",
    response: {} as Layer1BasicInfo,
  },

  /** Synthetic spot (RWA index) metadata for one symbol. */
  syntheticSpotInfo: {
    method: "GET",
    path: "/api/v1/syntheticSpotInfo",
    auth: "none",
    group: "info",
    query: {} as { symbol: string },
    response: {} as RespSyntheticSpotInfo,
  },

  /** No parameters. */
  systemConfig: {
    method: "GET",
    path: "/api/v1/systemConfig",
    auth: "none",
    group: "info",
    response: {} as SystemConfig,
  },

  /** `to_account_index` defaults to `-1`. */
  transferFeeInfo: {
    method: "GET",
    path: "/api/v1/transferFeeInfo",
    auth: "required",
    group: "info",
    query: {} as { account_index: number; to_account_index?: number },
    response: {} as TransferFeeInfo,
  },

  /**
   * No parameters, and **no `code` field in the response** — `{"seconds":1542}`
   * (`docs/protocol-notes.md` §8.1). A success check of `body.code === 200` rejects a perfectly
   * good response here.
   */
  withdrawalDelay: {
    method: "GET",
    path: "/api/v1/withdrawalDelay",
    auth: "none",
    group: "info",
    response: {} as RespWithdrawalDelay,
  },

  /* -- group `notification` (1) ---------------------------------------------------------------- */

  /** Notifications arrive over the WebSocket; acknowledgement is REST-only. */
  notificationAck: {
    method: "POST",
    path: "/api/v1/notification/ack",
    auth: "optional",
    encoding: "form",
    group: "notification",
    body: {} as ReqAckNotif,
    response: {} as ResultCode,
  },

  /* -- group `order` (12) ---------------------------------------------------------------------- */

  /** Not paginated, despite returning `Orders`. `market_id` defaults to `255` (all markets). */
  accountActiveOrders: {
    method: "GET",
    path: "/api/v1/accountActiveOrders",
    auth: "required",
    group: "order",
    itemsKey: "orders",
    query: {} as { account_index: number; market_id?: number; market_type?: MarketType },
    response: {} as Orders,
  },

  /** `limit` is required, range `1..100`. `ask_filter` defaults to `-1` (both sides). */
  accountInactiveOrders: {
    method: "GET",
    path: "/api/v1/accountInactiveOrders",
    auth: "required",
    group: "order",
    itemsKey: "orders",
    query: {} as {
      account_index: number;
      market_id?: number;
      ask_filter?: AskFilter;
      between_timestamps?: string;
      cursor?: string;
      limit: number;
      market_type?: MarketType;
    },
    response: {} as Orders,
  },

  /** Omit `asset_id` for every asset. */
  assetDetails: {
    method: "GET",
    path: "/api/v1/assetDetails",
    auth: "none",
    group: "order",
    itemsKey: "asset_details",
    query: {} as { asset_id?: number },
    response: {} as AssetDetails,
  },

  /** When `filter` is `byMarket`, `value` is the market **symbol**, not its index. */
  exchangeMetrics: {
    method: "GET",
    path: "/api/v1/exchangeMetrics",
    auth: "none",
    group: "order",
    itemsKey: "metrics",
    query: {} as {
      period: ExchangeMetricPeriod;
      kind: ExchangeMetricKind;
      filter?: "byMarket";
      value?: string;
    },
    response: {} as RespGetExchangeMetrics,
  },

  /** No parameters. */
  exchangeStats: {
    method: "GET",
    path: "/api/v1/exchangeStats",
    auth: "none",
    group: "order",
    itemsKey: "order_book_stats",
    response: {} as ExchangeStats,
  },

  /** `period` here is {@link ExecuteStatsPeriod} — no `h`, unlike `exchangeMetrics`. */
  executeStats: {
    method: "GET",
    path: "/api/v1/executeStats",
    auth: "none",
    group: "order",
    itemsKey: "result",
    query: {} as { period: ExecuteStatsPeriod },
    response: {} as RespGetExecuteStats,
  },

  /**
   * Operation id `export`, kept verbatim: a legal property key and a legal method name
   * (`client.order.export(...)`), even though a bare top-level `export … export()` declaration is
   * not — nothing downstream may emit one.
   *
   * Bounded to 12 months or 1M trades. Both timestamps are epoch **milliseconds** in
   * `1735689600000..1830297600000` — the lower bound is Lighter's mainnet genesis.
   */
  export: {
    method: "GET",
    path: "/api/v1/export",
    auth: "required",
    group: "order",
    query: {} as {
      /** Defaults to `-1`. */
      account_index?: number;
      /** Defaults to `255` (all markets). */
      market_id?: number;
      type: "funding" | "trade";
      /** Epoch milliseconds, range `1735689600000..1830297600000`. */
      start_timestamp?: number;
      /** Epoch milliseconds, range `1735689600000..1830297600000`. */
      end_timestamp?: number;
      side?: Side;
      role?: Role;
      trade_type?: TradeKindFilter;
    },
    response: {} as ExportData,
  },

  /**
   * Carries both `order_book_details` (perps) and `spot_order_book_details`, so it declares no
   * `itemsKey` — there is no single collection to flatten to.
   */
  orderBookDetails: {
    method: "GET",
    path: "/api/v1/orderBookDetails",
    auth: "none",
    group: "order",
    query: {} as { market_id?: number; filter?: MarketType },
    response: {} as OrderBookDetails,
  },

  /**
   * Depth for one market. `limit` is required and its range is `1..250` — wider than the `1..100`
   * that holds nearly everywhere else.
   *
   * Two collections (`asks`, `bids`), so no `itemsKey`.
   */
  orderBookOrders: {
    method: "GET",
    path: "/api/v1/orderBookOrders",
    auth: "none",
    group: "order",
    query: {} as { market_id: number; limit: number },
    response: {} as OrderBookOrders,
  },

  /** Market metadata. `market_id` defaults to `255`, `filter` to `all`. */
  orderBooks: {
    method: "GET",
    path: "/api/v1/orderBooks",
    auth: "none",
    group: "order",
    itemsKey: "order_books",
    query: {} as { market_id?: number; filter?: MarketType },
    response: {} as OrderBooks,
  },

  /** Public tape for one market. `limit` is required, range `1..100`. Not paginated. */
  recentTrades: {
    method: "GET",
    path: "/api/v1/recentTrades",
    auth: "none",
    group: "order",
    itemsKey: "trades",
    query: {} as { market_id: number; limit: number },
    response: {} as Trades,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4, and the notable one. The
   * document marks `authorization` optional and the operation has no required account parameter,
   * yet an unauthenticated call returns
   * `{"code":20001,"message":"invalid param : auth query param and Authorization header are empty"}`.
   * Do not "fix" this back to `'optional'`.
   *
   * `sort_by` is **required**. `sort_dir` has exactly one legal value, so ascending order is not
   * reachable through this endpoint. `limit` is required, range `1..100`.
   */
  trades: {
    method: "GET",
    path: "/api/v1/trades",
    auth: "required",
    group: "order",
    itemsKey: "trades",
    query: {} as {
      /** Defaults to `255` (all markets). */
      market_id?: number;
      market_type?: MarketType;
      /** Defaults to `-1`. */
      account_index?: number;
      order_index?: number;
      sort_by: "block_height" | "timestamp" | "trade_id";
      /** Only `'desc'` is accepted; it is also the default. */
      sort_dir?: SortDir;
      cursor?: string;
      /** Defaults to `-1`. */
      from?: number;
      /** Tri-state: `-1` both, `0` bids, `1` asks. Defaults to `-1`. */
      ask_filter?: AskFilter;
      role?: Role;
      type?: TradeKindFilter;
      /** Range `1..100`. */
      limit: number;
      aggregate?: boolean;
      skip_ask_order_id?: string;
      skip_bid_order_id?: string;
    },
    response: {} as Trades,
  },

  /* -- group `referral` (6) -------------------------------------------------------------------- */

  referralCreate: {
    method: "POST",
    path: "/api/v1/referral/create",
    auth: "optional",
    encoding: "form",
    group: "referral",
    body: {} as ReqCreateReferralCode,
    response: {} as ReferralCode,
  },

  /**
   * `auth: 'required'` — **corrected**, `spec/05-rest-api.md` §5.4 (declared optional, enforced).
   *
   * This operation declares `authorization` as a **query** parameter rather than a header. That is
   * a document bug of the same family as the rest: it is deliberately absent from the query type
   * above, and the transport sends the header.
   */
  referralGet: {
    method: "GET",
    path: "/api/v1/referral/get",
    auth: "required",
    group: "referral",
    query: {} as { account_index: number },
    response: {} as ReferralCode,
  },

  /** Once per day. `kickback_percentage` is a share, not money. */
  referralKickbackUpdate: {
    method: "POST",
    path: "/api/v1/referral/kickback/update",
    auth: "optional",
    encoding: "form",
    group: "referral",
    body: {} as ReqUpdateKickback,
    response: {} as RespUpdateKickback,
  },

  /**
   * The response carries **no `code` field** (`spec/05-rest-api.md` §3.2), like `withdrawalDelay`
   * and `executeStats`.
   */
  referralPoints: {
    method: "GET",
    path: "/api/v1/referral/points",
    auth: "required",
    group: "referral",
    itemsKey: "referrals",
    query: {} as { account_index: number },
    response: {} as ReferralPoints,
  },

  /** Once per account. */
  referralUpdate: {
    method: "POST",
    path: "/api/v1/referral/update",
    auth: "optional",
    encoding: "form",
    group: "referral",
    body: {} as ReqUpdateReferralCode,
    response: {} as RespUpdateReferralCode,
  },

  referralUse: {
    method: "POST",
    path: "/api/v1/referral/use",
    auth: "optional",
    encoding: "form",
    group: "referral",
    body: {} as ReqUseReferralCode,
    response: {} as ResultCode,
  },

  /* -- group `root` (2) ------------------------------------------------------------------------ */

  /**
   * Operation id `status`. **No `/api/v1` prefix** — this and `info` sit at the origin root, which
   * is exactly why the prefix belongs on the route and not in the base URL. No parameters.
   *
   * Its `timestamp` is epoch **seconds**, unlike almost everything else on the API.
   */
  status: {
    method: "GET",
    path: "/",
    auth: "none",
    group: "root",
    response: {} as Status,
  },

  /** Operation id `info`. **No `/api/v1` prefix.** No parameters. */
  info: {
    method: "GET",
    path: "/info",
    auth: "none",
    group: "root",
    response: {} as ZkLighterInfo,
  },

  /* -- group `tokenlist` (1) ------------------------------------------------------------------- */

  /** No parameters. */
  tokenlist: {
    method: "GET",
    path: "/api/v1/tokenlist",
    auth: "none",
    group: "tokenlist",
    itemsKey: "tokens",
    response: {} as TokenList,
  },

  /* -- group `transaction` (12) ---------------------------------------------------------------- */

  /**
   * `types` is one of the **two** parameters on the whole API that repeat their key
   * (`?types=14&types=15`), which is why it is an array here rather than a JSON string.
   *
   * `limit` is required, range `1..100`.
   */
  accountTxs: {
    method: "GET",
    path: "/api/v1/accountTxs",
    auth: "optional",
    group: "transaction",
    itemsKey: "txs",
    query: {} as {
      index?: number;
      limit: number;
      by: "account_index";
      value: string;
      /** Transaction type discriminators; the key repeats, one occurrence per value. */
      types?: number[];
    },
    response: {} as Txs,
  },

  blockTxs: {
    method: "GET",
    path: "/api/v1/blockTxs",
    auth: "none",
    group: "transaction",
    itemsKey: "txs",
    query: {} as { by: "block_height" | "block_commitment"; value: string },
    response: {} as Txs,
  },

  /** Paginates with the legacy `cursor` response key rather than `next_cursor`. */
  depositHistory: {
    method: "GET",
    path: "/api/v1/deposit/history",
    auth: "required",
    group: "transaction",
    itemsKey: "deposits",
    query: {} as {
      account_index: number;
      l1_address: string;
      cursor?: string;
      filter?: HistoryFilter;
    },
    response: {} as DepositHistory,
  },

  /** Public: nonce lookup needs no credential, even though it feeds the write path. */
  nextNonce: {
    method: "GET",
    path: "/api/v1/nextNonce",
    auth: "none",
    group: "transaction",
    query: {} as { account_index: number; api_key_index: number },
    response: {} as NextNonce,
  },

  /**
   * `auth: 'none'` — **not an oversight**, `spec/05-rest-api.md` §5.4. Authentication is the L2
   * signature inside `tx_info`. Marking this `'required'` would make every submission depend on a
   * read token and push a bearer credential onto the write path for no reason.
   *
   * Blocked with code `20558` from restricted jurisdictions while every read still succeeds
   * (`docs/protocol-notes.md` §8.3).
   */
  sendTx: {
    method: "POST",
    path: "/api/v1/sendTx",
    auth: "none",
    encoding: "form",
    group: "transaction",
    body: {} as ReqSendTx,
    response: {} as RespSendTx,
  },

  /**
   * `auth: 'none'` for the same reason as `sendTx` — see that entry and §5.4.
   *
   * `tx_types` and `tx_infos` are both JSON **strings**, and not the same shape: `"[14,15]"` versus
   * a JSON array of strings each of which is itself a JSON object. Their lengths must match and the
   * batch must be non-empty.
   */
  sendTxBatch: {
    method: "POST",
    path: "/api/v1/sendTxBatch",
    auth: "none",
    encoding: "form",
    group: "transaction",
    body: {} as ReqSendTxBatch,
    response: {} as RespSendTxBatch,
  },

  /**
   * The **only** `application/json` operation on the API; every other `POST` is form-encoded
   * (`spec/05-rest-api.md` §2.1). `metadata` is a JSON string nested inside that JSON body.
   */
  setAccountMetadata: {
    method: "POST",
    path: "/api/v1/setAccountMetadata",
    auth: "optional",
    encoding: "json",
    group: "transaction",
    body: {} as ReqSetAccountMetadata,
    response: {} as ResultCode,
  },

  /**
   * Genuinely auth-optional — verified 200 without a token; an unknown account is rejected on the
   * lookup, not on auth, and public pools are readable unauthenticated
   * (`spec/05-rest-api.md` §5.4).
   *
   * `type` is the second and last parameter that repeats its key, and it takes the **undirected**
   * names ({@link TransferTypeFilter}); the response's `type` field uses direction-qualified ones.
   */
  transferHistory: {
    method: "GET",
    path: "/api/v1/transfer/history",
    auth: "optional",
    group: "transaction",
    itemsKey: "transfers",
    query: {} as {
      account_index: number;
      cursor?: string;
      /** The key repeats, one occurrence per value. */
      type?: TransferTypeFilter[];
    },
    response: {} as TransferHistory,
  },

  tx: {
    method: "GET",
    path: "/api/v1/tx",
    auth: "none",
    group: "transaction",
    query: {} as { by: "hash" | "sequence_index"; value: string },
    response: {} as EnrichedTx,
  },

  txFromL1TxHash: {
    method: "GET",
    path: "/api/v1/txFromL1TxHash",
    auth: "none",
    group: "transaction",
    query: {} as { hash: string },
    response: {} as EnrichedTx,
  },

  /** `limit` is required, range `1..100`. */
  txs: {
    method: "GET",
    path: "/api/v1/txs",
    auth: "none",
    group: "transaction",
    itemsKey: "txs",
    query: {} as { index?: number; limit: number },
    response: {} as Txs,
  },

  /** Paginates with the legacy `cursor` response key rather than `next_cursor`. */
  withdrawHistory: {
    method: "GET",
    path: "/api/v1/withdraw/history",
    auth: "required",
    group: "transaction",
    itemsKey: "withdraws",
    query: {} as {
      account_index: number;
      cursor?: string;
      filter?: HistoryFilter;
    },
    response: {} as WithdrawHistory,
  },
} as const satisfies Record<string, RouteDef>;
