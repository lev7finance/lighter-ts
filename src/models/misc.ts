/**
 * Everything else with a named response model: chain and L1 info, the single-value responses,
 * stats and metrics, bridge and history, managed API tokens, announcements and the token list.
 *
 * Four facts shape this file, and each of them is somewhere a naive reading goes wrong:
 *
 * 1. **Two of the three envelope-less endpoints live here.** `GET /api/v1/withdrawalDelay` returns
 *    `{"seconds":1805}` and `GET /api/v1/executeStats` returns `{"period":"d","result":[…]}` — both
 *    `200`, both with **no `code` field at all** (`docs/protocol-notes.md` §8,
 *    `spec/05-rest-api.md` §3.2; the first is a captured fixture). {@link RespWithdrawalDelay} and
 *    {@link RespGetExecuteStats} therefore do not extend `ResultCode`. The success predicate is
 *    "HTTP 2xx **and** (`code` absent **or** `code === 200`)", and these two are why.
 * 2. **Timestamp units are not uniform.** {@link Status.timestamp}, {@link Announcement.created_at}
 *    / `expired_at`, {@link ExecuteStat.timestamp} and {@link ApiToken.expiry} are epoch
 *    **seconds**, while nearly everything else on the API is milliseconds. Nothing in the payload
 *    distinguishes them, so every field states its unit through the aliases in `./common.js`.
 * 3. **The `l1_providers` entries are camelCase** — `chainId`, `networkId`, `latestBlockNumber` —
 *    the only place on this API where §2.1's "every key is snake_case" is false. Verified in the
 *    captured `layer1BasicInfo` body, so it is a wire fact, not a transcription slip.
 * 4. **Money is a decimal string; statistics are floats.** Deposit, withdraw and transfer amounts,
 *    the fast-bridge limits and the transfer fee are all strings. The exchange stats, the metric
 *    series, the PnL series and `avg_slippage` are genuine JSON floats and must never feed money
 *    arithmetic (`docs/decisions.md` D7).
 *
 * Where an endpoint in `spec/05-rest-api.md` §8 has no model named here or in the core files, it
 * stays `UnmodelledResponse` — D10 gives the long tail raw typed route access rather than a shape
 * guessed from an OpenAPI document that is known to be wrong about ~95% of its `required` markers.
 *
 * Types only. Nothing in this file runs.
 */

import type {
  DecimalString,
  EpochMs,
  EpochSeconds,
  LegacyCursored,
  ResultCode,
} from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Chain and L1 info                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /` — the liveness probe, and the only endpoint outside `/api/v1`.
 *
 * **No `code`.** `spec/05-rest-api.md` §10.10 records it as having no `code`-200 envelope, and the
 * vendored schema agrees; the root endpoints predate the envelope convention.
 *
 * `timestamp` is epoch **seconds** (`1785022683`) — three decimal digits narrower than the
 * millisecond timestamps everywhere else, which is the only clue on the wire.
 */
export interface Status {
  status?: number;
  network_id?: number;
  /** Epoch **seconds**, not milliseconds. */
  timestamp?: EpochSeconds;
}

/** `GET /info`. No `code` envelope, same as {@link Status}. */
export interface ZkLighterInfo {
  contract_address?: string;
}

/**
 * One configured L1 RPC provider.
 *
 * **These three keys are camelCase.** Verified in the captured `layer1BasicInfo` response; they are
 * the sole exception to the API's snake_case rule (`spec/05-rest-api.md` §2.1). Do not "fix" them.
 */
export interface L1ProviderInfo {
  chainId?: number;
  networkId?: number;
  latestBlockNumber?: number;
}

/** A named deployed contract, e.g. `ZkLighterContract`, `USDCContract`. */
export interface ContractAddress {
  name?: string;
  address?: string;
}

/** A sequencer validator. Live captures have returned an empty `validator_info` array. */
export interface ValidatorInfo {
  address?: string;
  is_active?: boolean;
}

/**
 * `GET /api/v1/layer1BasicInfo` — chain ids, contract addresses and L1 sync heights.
 *
 * A captured response is in `test/fixtures/rest/responses.json`; every field on this model appeared
 * in it, including `latest_l1_*` values of `0`, which means those particular fields are *not* under
 * `omitempty`. Optionality is still `?:` throughout — one capture is not proof of the general case.
 */
export interface Layer1BasicInfo extends ResultCode {
  l1_providers?: L1ProviderInfo[];
  l1_providers_health?: boolean;
  validator_info?: ValidatorInfo[];
  contract_addresses?: ContractAddress[];
  latest_l1_generic_block?: number;
  latest_l1_governance_block?: number;
  latest_l1_desert_block?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Single-value responses                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/withdrawalDelay` — `{"seconds":1805}`.
 *
 * **The envelope counterexample, and it is a captured fixture, not a claim.** No `code`, no
 * `message`, one key. A transport whose success check is `body.code === 200` rejects this response.
 */
export interface RespWithdrawalDelay {
  /** The withdrawal delay, in seconds. Not a timestamp — a duration. */
  seconds?: number;
}

/**
 * `GET /api/v1/transferFeeInfo`.
 *
 * `transfer_fee_usdc` is an **integer count of raw USDC units** (scale `1e-6`, so `10000` is one
 * cent), not a decimal string and not a float. The server declares it `int64`; reproducing it as a
 * string would be a lie that only surfaces at runtime. Convert it with the fixed-point helpers in
 * `src/util/decimal.ts` — never with floating-point division (`docs/decisions.md` D7).
 */
export interface TransferFeeInfo extends ResultCode {
  /** Raw USDC units, `1 USDC = 1000000`. An integer, not a decimal string. */
  transfer_fee_usdc?: number;
}

/** `GET /api/v1/export` — the export is generated asynchronously and fetched from `data_url`. */
export interface ExportData extends ResultCode {
  data_url?: string;
}

/** `POST /api/v1/createIntentAddress` — the CCTP bridge address to send funds to. */
export interface CreateIntentAddressResp extends ResultCode {
  intent_address?: string;
}

/** `GET /api/v1/fastbridge/info`. The limit is a decimal string. */
export interface RespGetFastBridgeInfo extends ResultCode {
  fast_bridge_limit?: DecimalString;
}

/** `GET /api/v1/fastwithdraw/info`. Both limits are decimal strings. */
export interface RespGetFastwithdrawalInfo extends ResultCode {
  /** The account that fronts the fast withdrawal. */
  to_account_index?: number;
  withdraw_limit?: DecimalString;
  max_withdrawal_amount?: DecimalString;
}

/**
 * `POST /api/v1/changeAccountTier` — the envelope and nothing else.
 *
 * An alias rather than an empty interface: there is no payload, and inventing one would suggest
 * there is. Allowed once every 24 hours, with no open orders or positions.
 */
export type RespChangeAccountTier = ResultCode;

/** `POST /api/v1/setMakerOnlyApiKeys` — the envelope and nothing else. */
export type RespSetMakerOnlyApiKeys = ResultCode;

/** `GET /api/v1/getMakerOnlyApiKeys` — the current maker-only set, as api-key indexes. */
export interface RespGetMakerOnlyApiKeys extends ResultCode {
  api_key_indexes?: number[];
}

/** `GET /api/v1/syntheticSpotInfo` — the RWA / equity-index wrapper metadata for one symbol. */
export interface RespSyntheticSpotInfo extends ResultCode {
  symbol?: string;
  /** The carry, in basis points per day. Float-derived; must not feed money arithmetic. */
  bps_per_day?: number;
  /** Epoch milliseconds — the field name says so. */
  expiry_time_ms?: EpochMs;
  /** Epoch milliseconds. When the underlying spot market closes. */
  spot_close_ms?: EpochMs;
  /** The price source the synthetic tracks. */
  source?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Stats and metrics                                                                              */
/* -------------------------------------------------------------------------------------------- */

/*
 * Everything in this section is float-derived. That is a wire fact, not a modelling choice: the
 * server declares these fields `f64`, exactly as it does for candle OHLCV (`spec/05-rest-api.md`
 * §2.4 rule 5). They are display and analytics values. None of them may be used to size an order,
 * settle a balance, or compute a fee.
 */

/** Per-market 24h statistics, embedded in {@link ExchangeStats}. */
export interface OrderBookStats {
  symbol?: string;
  /** Float-derived. The decimal-string prices live on the market and trade models. */
  last_trade_price?: number;
  daily_trades_count?: number;
  /** Float-derived. */
  daily_base_token_volume?: number;
  /** Float-derived. */
  daily_quote_token_volume?: number;
  /** Float-derived, as a fraction of the opening price. */
  daily_price_change?: number;
}

/** `GET /api/v1/exchangeStats` — the exchange-wide rollup plus a per-market breakdown. */
export interface ExchangeStats extends ResultCode {
  /** The number of markets in `order_book_stats`. */
  total?: number;
  order_book_stats?: OrderBookStats[];
  /** Float-derived. */
  daily_usd_volume?: number;
  daily_trades_count?: number;
}

/** One point in a metric series. `data` is whatever `kind` selected — volume, fees, TPS, counts. */
export interface ExchangeMetric {
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Float-derived, whatever the metric. Must not feed money arithmetic even when it is a fee. */
  data?: number;
}

/** `GET /api/v1/exchangeMetrics`. The `period` and `kind` that shaped the series are not echoed. */
export interface RespGetExchangeMetrics extends ResultCode {
  metrics?: ExchangeMetric[];
}

/** Measured slippage for one venue, market and notional bucket. */
export interface SlippageResult {
  /** The venue compared against — this series benchmarks across exchanges. */
  exchange?: string;
  market?: string;
  /** The notional bucket, in whole USD. A bucket label, not an amount to compute with. */
  size_usd?: number;
  /** Float-derived. */
  avg_slippage?: number;
  /** How many samples went into `avg_slippage`. */
  data_count?: number;
}

/** One timestamped bucket of {@link SlippageResult}s. */
export interface ExecuteStat {
  /** Epoch **seconds**, unlike almost every other timestamp on this API. */
  timestamp?: EpochSeconds;
  slippage?: SlippageResult[];
}

/**
 * `GET /api/v1/executeStats`.
 *
 * **No `code`.** The second of the three envelope-less endpoints (`spec/05-rest-api.md` §3.2); the
 * body is `{"period":"d","result":[…]}` and nothing else. See the note at the top of this file.
 */
export interface RespGetExecuteStats {
  /** Echoes the requested period. */
  period?: "d" | "w" | "m" | "q" | "y" | "all";
  result?: ExecuteStat[];
}

/**
 * One point on an account's PnL chart.
 *
 * Every value here is `f64` on the wire, including the ones that name a currency movement. They are
 * chart data: the authoritative balances are the decimal strings on `DetailedAccount`.
 */
export interface PnLEntry {
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Float-derived. */
  trade_pnl?: number;
  /** Float-derived. */
  trade_spot_pnl?: number;
  /** Float-derived. */
  inflow?: number;
  /** Float-derived. */
  outflow?: number;
  /** Float-derived. */
  spot_inflow?: number;
  /** Float-derived. */
  spot_outflow?: number;
  /** Float-derived. */
  pool_pnl?: number;
  /** Float-derived. */
  pool_inflow?: number;
  /** Float-derived. */
  pool_outflow?: number;
  /** Float-derived. Share units, as a float, on a chart series. */
  pool_total_shares?: number;
  /** Float-derived. */
  staked_lit?: number;
  /** Float-derived. */
  staking_inflow?: number;
  /** Float-derived. */
  staking_outflow?: number;
  /** Float-derived. */
  staking_pnl?: number;
  /** Float-derived. */
  volume?: number;
}

/** `GET /api/v1/pnl`. `resolution` echoes the request: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. */
export interface AccountPnL extends ResultCode {
  resolution?: string;
  pnl?: PnLEntry[];
}

/* -------------------------------------------------------------------------------------------- */
/* Bridge and history                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/deposit/latest` — the most recent bridge deposit for an L1 address.
 *
 * A deposit crosses several chains, so it carries several transaction hashes, each empty until that
 * leg happens. `status` and `step` are free-form progress strings; `description` is human-readable
 * and must not be parsed.
 */
export interface Deposit extends ResultCode {
  source?: string;
  /** The originating chain id, as a **string**. */
  source_chain_id?: string;
  fast_bridge_tx_hash?: string;
  batch_claim_tx_hash?: string;
  cctp_burn_tx_hash?: string;
  amount?: DecimalString;
  intent_address?: string;
  status?: string;
  step?: string;
  /** Human-readable progress text. Never branch on it. */
  description?: string;
  /** Epoch milliseconds. */
  created_at?: EpochMs;
  /** Epoch milliseconds. */
  updated_at?: EpochMs;
  is_external_deposit?: boolean;
  is_next_bridge_fast?: boolean;
}

/** Terminal and in-flight states of a deposit. */
export type DepositStatus = "failed" | "pending" | "completed" | "claimable";

/** One row of `GET /api/v1/deposit/history`. */
export interface DepositHistoryItem {
  /** An opaque row id, carried as a string. */
  id?: string;
  amount?: DecimalString;
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  status?: DepositStatus;
  l1_tx_hash?: string;
  asset_id?: number;
}

/**
 * `GET /api/v1/deposit/history`.
 *
 * Paginates with the **legacy `cursor` key**, not `next_cursor` (`spec/05-rest-api.md` §6).
 * Exhaustion is the key being absent.
 */
export interface DepositHistory extends ResultCode, LegacyCursored {
  deposits?: DepositHistoryItem[];
}

/**
 * States of a withdrawal. `completed` is only reached by **fast** withdrawals via Arbitrum; a
 * secure withdrawal stops at `claimable` and waits for the user to claim it on L1.
 */
export type WithdrawStatus = "failed" | "pending" | "claimable" | "refunded" | "completed";

/** One row of `GET /api/v1/withdraw/history`. */
export interface WithdrawHistoryItem {
  /** An opaque row id, carried as a string. */
  id?: string;
  amount?: DecimalString;
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  status?: WithdrawStatus;
  /** `secure` settles through the L1 escape hatch; `fast` is fronted on Arbitrum. */
  type?: "secure" | "fast";
  l1_tx_hash?: string;
  asset_id?: number;
}

/** `GET /api/v1/withdraw/history`. Paginates with the legacy `cursor` key. */
export interface WithdrawHistory extends ResultCode, LegacyCursored {
  withdraws?: WithdrawHistoryItem[];
}

/**
 * The direction-qualified transfer kinds.
 *
 * Note that the response spells direction into the value (`…Inflow` / `…Outflow`) while the request
 * filter does not — `GET /transfer/history?type=L2Transfer&type=L2MintShares` takes the undirected
 * names and repeats the key. The two vocabularies are not interchangeable.
 */
export type TransferKind =
  | "L2TransferInflow"
  | "L2TransferOutflow"
  | "L2BurnSharesInflow"
  | "L2BurnSharesOutflow"
  | "L2MintSharesInflow"
  | "L2MintSharesOutflow"
  | "L2SelfTransfer"
  | "L2StakeAssetInflow"
  | "L2StakeAssetOutflow"
  | "L2UnstakeAssetInflow"
  | "L2UnstakeAssetOutflow"
  | "L2ForceBurnSharesInflow"
  | "L2ForceBurnSharesOutflow";

/** One row of `GET /api/v1/transfer/history`. Both the amount and the fee are decimal strings. */
export interface TransferHistoryItem {
  /** An opaque row id, carried as a string. */
  id?: string;
  amount?: DecimalString;
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  type?: TransferKind;
  from_l1_address?: string;
  to_l1_address?: string;
  from_account_index?: number;
  to_account_index?: number;
  tx_hash?: string;
  asset_id?: number;
  fee?: DecimalString;
  /** Which book the funds left. */
  from_route?: "spot" | "perps";
  /** Which book the funds landed in. */
  to_route?: "spot" | "perps";
}

/** `GET /api/v1/transfer/history`. Paginates with the legacy `cursor` key. */
export interface TransferHistory extends ResultCode, LegacyCursored {
  transfers?: TransferHistoryItem[];
}

/** A chain that supports deposits through an intent address. */
export interface BridgeSupportedNetwork {
  name?: string;
  /** The chain id, as a **string**. */
  chain_id?: string;
  /** Block-explorer base URL, for rendering `l1_tx_hash` as a link. */
  explorer?: string;
}

/** `GET /api/v1/deposit/networks`. */
export interface BridgeSupportedNetworks extends ResultCode {
  networks?: BridgeSupportedNetwork[];
}

/**
 * `POST /api/v1/createIntentAddress` — form-encoded.
 *
 * `chain_id` is a string here, matching {@link BridgeSupportedNetwork.chain_id}, and `amount` is a
 * decimal string.
 */
export interface ReqCreateIntentAddress {
  chain_id: string;
  from_addr: string;
  amount: DecimalString;
  is_external_deposit?: boolean;
}

/**
 * `POST /api/v1/fastwithdraw` — form-encoded.
 *
 * `tx_info` is the signed withdraw transaction as a JSON **string** beginning with `{`
 * (`spec/05-rest-api.md` §2.3), produced by the transaction layer. Like `litLease`, this endpoint
 * carries its own signed transaction rather than going through `/sendTx`.
 */
export interface ReqFastwithdraw {
  /** The signed withdraw, as a JSON string beginning with `{`. */
  tx_info: string;
  to_address: string;
  auth?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Managed API tokens (auth scheme B)                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * A server-stored read-only credential, so a third party can be granted scoped read access without
 * ever seeing a private key (`spec/05-rest-api.md` §5.3). All three management operations are
 * themselves authenticated with scheme A.
 *
 * `api_token` is the credential itself and is returned **only** by `tokens/create`. Where it is
 * then presented is not stated by any reference material — presumed `Authorization`, unverified
 * (§13.1). Treat the value as a secret: it must never be logged.
 *
 * `scopes` is a **free-form string**, observed `"read.*"`. Not an enum, not an array; its grammar
 * is an open question (§13.2).
 */
export interface ApiToken {
  token_id?: number;
  /** The credential. Secret. Present only in the `tokens/create` response. */
  api_token?: string;
  name?: string;
  account_index?: number;
  /** Epoch **seconds**, like the scheme-A auth-token deadline. */
  expiry?: EpochSeconds;
  sub_account_access?: boolean;
  revoked?: boolean;
  /** Free-form, observed `"read.*"`. Not an enum. */
  scopes?: string;
}

/** `GET /api/v1/tokens`. The listed tokens do not carry `api_token` — it is shown once, at mint. */
export interface RespGetApiTokens extends ResultCode {
  api_tokens?: ApiToken[];
}

/**
 * `POST /api/v1/tokens/create`.
 *
 * The envelope with an {@link ApiToken} flattened into it — the token's fields sit at the top
 * level, not under a key. This is the one response that carries `api_token`.
 */
export interface RespPostApiToken extends ResultCode, ApiToken {}

/** `POST /api/v1/tokens/revoke`. */
export interface RespRevokeApiToken extends ResultCode {
  token_id?: number;
  revoked?: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Announcements and the token list                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * One exchange announcement.
 *
 * `created_at` and `expired_at` are epoch **seconds**, unlike the millisecond timestamps on
 * accounts, orders and trades (`spec/05-rest-api.md` §2.4 rule 6).
 */
export interface Announcement {
  title?: string;
  content?: string;
  /** Epoch **seconds**. */
  created_at?: EpochSeconds;
  /** Epoch **seconds**. */
  expired_at?: EpochSeconds;
}

/** `GET /api/v1/announcement`. */
export interface Announcements extends ResultCode {
  announcements?: Announcement[];
}

/**
 * Display metadata for a listed token: logos, external data-provider ids, categorisation.
 *
 * This is presentation data. The tradable properties of an asset — decimals, caps, margin mode,
 * index price — are on `Asset` in `./market.js`, and that is the runtime source of truth.
 */
export interface Token {
  symbol?: string;
  name?: string;
  logo?: string;
  logo_extension?: "svg" | "png";
  /** A key into the front end's copy deck, not the description itself. */
  description_key?: string;
  /** CoinGecko id. */
  gecko_id?: string;
  /** CoinPaprika id. */
  paprika_id?: string;
  market?: "SPOT" | "PERPS";
  /** `RWA` covers the synthetic equity indices; see {@link RespSyntheticSpotInfo}. */
  asset_type?: "CRYPTO" | "RWA";
  categories?: string[];
  is_allowed_mainnet?: boolean;
  is_asset_allowed_mainnet?: boolean;
}

/** `GET /api/v1/tokenlist`. */
export interface TokenList extends ResultCode {
  tokens?: Token[];
}

/* -------------------------------------------------------------------------------------------- */
/* Notification                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * `POST /api/v1/notification/ack` — form-encoded.
 *
 * Notifications themselves arrive over the WebSocket `notification` channel; acknowledgement is
 * REST-only (`spec/06-websocket.md` §6.2.16). `notif_id` is the string id from that frame.
 */
export interface ReqAckNotif {
  notif_id: string;
  account_index: number;
  auth?: string;
}
