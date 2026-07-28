/**
 * Market, asset and funding models.
 *
 * `OrderBook` is the model every order-placement path depends on: `supported_size_decimals` and
 * `supported_price_decimals` are the scaling factors the transaction codec needs, since an order's
 * integer `base_amount` is `size × 10^supported_size_decimals` and its integer `price` is
 * `price × 10^supported_price_decimals`. Markets must be fetched and cached before trading.
 *
 * Fields marked `[+]` in `spec/05-rest-api.md` §10.3 are present on the wire and **absent from the
 * vendored OpenAPI document**. Two of them, `mark_price` and `index_price`, are the basis of
 * liquidation and funding — a client generated from the document would not expose them at all.
 * That omission is the reason these types are hand-authored.
 *
 * Types only. Nothing in this file runs.
 */

import type {
  AssetMarginMode,
  DecimalString,
  MarketKind,
  MarketStatus,
  ResultCode,
} from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Markets                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The minimal market descriptor, from `GET /api/v1/orderBooks`.
 *
 * Every field is optional: the server omits zero values (`docs/protocol-notes.md` §8, §9.2).
 */
export interface OrderBook {
  symbol?: string;
  /** The market index used in every other call **and in transaction signing**. */
  market_id?: number;
  market_type?: MarketKind;
  base_asset_id?: number;
  quote_asset_id?: number;
  status?: MarketStatus;
  /** Percent, e.g. `"0.0000"`. Decimal string — not a number (`docs/decisions.md` D7). */
  taker_fee?: DecimalString;
  /** Percent, e.g. `"0.0000"`. */
  maker_fee?: DecimalString;
  is_taker_fee_enabled?: boolean;
  is_maker_fee_enabled?: boolean;
  /** Percent, e.g. `"1.0000"`. */
  liquidation_fee?: DecimalString;
  /** Smallest tradeable size, e.g. `"0.00020"`. */
  min_base_amount?: DecimalString;
  /** Smallest tradeable notional, e.g. `"10.000000"`. */
  min_quote_amount?: DecimalString;
  /** Largest notional per order, e.g. `"281474976.710655"` — that is (2^48−1)/1e6. */
  order_quote_limit?: DecimalString;
  /** Scaling exponent for an order's integer `base_amount`. */
  supported_size_decimals?: number;
  /** Scaling exponent for an order's integer `price`. */
  supported_price_decimals?: number;
  supported_quote_decimals?: number;
  /**
   * `[+]` Epoch **milliseconds held in a string** — `"1737098461107"`. Not a number, and not a
   * date. Live-only; absent from the OpenAPI document.
   */
  created_at?: string;
  /** `[+]` e.g. `"1.000000000000000000"`. Live-only. */
  multiplier?: DecimalString;
}

export interface OrderBooks extends ResultCode {
  order_books?: OrderBook[];
}

/**
 * Per-market risk and liquidation configuration, embedded in {@link PerpsOrderBookDetail}.
 */
export interface MarketConfig {
  market_margin_mode?: number;
  /**
   * `281474976710655` (= 2^48−1) is the sentinel for **"no insurance fund"**, not an account that
   * exists. Do not resolve it as an account index.
   */
  insurance_fund_account_index?: number;
  liquidation_mode?: number;
  force_reduce_only?: boolean;
  funding_fee_discounts_enabled?: boolean;
  /** `""` means 24/7. Non-empty for RWA and equity markets. */
  trading_hours?: string;
  hidden?: boolean;
  rfq_enabled?: boolean;
}

/**
 * A perpetual market with full detail, from `GET /api/v1/orderBookDetails`.
 *
 * **Margin fractions are basis points**: `default_initial_margin_fraction: 500` is 5%, i.e. 20×
 * leverage. `leverage = 10000 / initial_margin_fraction`. The OpenAPI document types four of them
 * with the typo `"format": "uin16"`; they are plain integers.
 */
export interface PerpsOrderBookDetail extends OrderBook {
  /** Duplicate of `supported_size_decimals`. */
  size_decimals?: number;
  /** Duplicate of `supported_price_decimals`. */
  price_decimals?: number;
  quote_multiplier?: number;
  /** Basis points. `500` = 5% = 20× leverage. */
  default_initial_margin_fraction?: number;
  /** Basis points. `200` = 2% = 50× maximum leverage. */
  min_initial_margin_fraction?: number;
  /** Basis points. */
  maintenance_margin_fraction?: number;
  /** Basis points. */
  closeout_margin_fraction?: number;
  /** `[+]` The liquidation basis, e.g. `"64398.5"`. Decimal string. Absent from the document. */
  mark_price?: DecimalString;
  /** `[+]` The oracle price, e.g. `"64422.5"`. Decimal string. Absent from the document. */
  index_price?: DecimalString;
  /**
   * Float-derived statistic. It is a JSON number on the wire and is reproduced as one here; it
   * must not feed money arithmetic. Use `mark_price` or a trade's `price` for that.
   */
  last_trade_price?: number;
  daily_trades_count?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_base_token_volume?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_quote_token_volume?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_price_low?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_price_high?: number;
  /** Percent, float-derived. Not for money arithmetic. */
  daily_price_change?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  open_interest?: number;
  /** Often `{}` — do not assume it is populated. Values are float-derived. */
  daily_chart?: Record<string, number>;
  market_config?: MarketConfig;
  strategy_index?: number;
  /** `[+]` Bitfield; semantics undocumented. Live-only. */
  market_flags?: number;
  /** `[+]` e.g. `100`. Live-only. */
  funding_premium_multiplier?: number;
  /** e.g. `"0.0500"`. */
  funding_clamp_small?: DecimalString;
  /** e.g. `"4.0000"`. */
  funding_clamp_big?: DecimalString;
  /** e.g. `"0.0100"`. */
  base_interest_rate?: DecimalString;
}

/**
 * A spot market with full detail. Structurally {@link PerpsOrderBookDetail} minus every perp-only
 * field: no margin fractions, no open interest, no market config, no funding.
 */
export interface SpotOrderBookDetail extends OrderBook {
  /** Duplicate of `supported_size_decimals`. */
  size_decimals?: number;
  /** Duplicate of `supported_price_decimals`. */
  price_decimals?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  last_trade_price?: number;
  daily_trades_count?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_base_token_volume?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_quote_token_volume?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_price_low?: number;
  /** Float-derived statistic. Not for money arithmetic. */
  daily_price_high?: number;
  /** Percent, float-derived. Not for money arithmetic. */
  daily_price_change?: number;
  /** Often `{}` — do not assume it is populated. */
  daily_chart?: Record<string, number>;
}

/** `GET /api/v1/orderBookDetails` returns both market families side by side. */
export interface OrderBookDetails extends ResultCode {
  order_book_details?: PerpsOrderBookDetail[];
  spot_order_book_details?: SpotOrderBookDetail[];
}

/* -------------------------------------------------------------------------------------------- */
/* Assets                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * A supported asset, from `GET /api/v1/assetDetails`.
 *
 * Asset ids are **not** stable knowledge to hard-code: `assetDetails` is the runtime source of
 * truth. (The reference signer's table — ETH 1, LIT 2, USDC 3, LINK 5, UNI 6, AAVE 7, SKY 8,
 * LDO 9 — is documentation, not an API contract.)
 */
export interface Asset {
  asset_id?: number;
  symbol?: string;
  /** Decimals of the asset's L1 ERC-20 contract. */
  l1_decimals?: number;
  /** Decimals used by Lighter's own balances. Often differs from `l1_decimals`. */
  decimals?: number;
  price_decimals?: number;
  l1_address?: string;
  /** Whether the asset may be used as margin. See {@link AssetMarginMode}. */
  margin_mode?: AssetMarginMode;
  /** Oracle price, decimal string. */
  index_price?: DecimalString;
  min_transfer_amount?: DecimalString;
  min_withdrawal_amount?: DecimalString;
  global_supply_cap?: DecimalString;
  user_supply_cap?: DecimalString;
  total_supplied?: DecimalString;
  liquidation_fee?: DecimalString;
  liquidation_threshold?: DecimalString;
  liquidation_factor?: DecimalString;
  loan_to_value?: DecimalString;
  /** `[+]` e.g. `"1.000000000000000000"`. Live-only; absent from the OpenAPI document. */
  multiplier?: DecimalString;
}

export interface AssetDetails extends ResultCode {
  asset_details?: Asset[];
}

/* -------------------------------------------------------------------------------------------- */
/* System configuration                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Exchange-wide constants, from `GET /api/v1/systemConfig`.
 *
 * The four `max_integrator_*_fee` values are fee **ticks**, not decimals.
 */
export interface SystemConfig extends ResultCode {
  liquidity_pool_index?: number;
  staking_pool_index?: number;
  funding_fee_rebate_account_index?: number;
  market_maker_incentive_account_index?: number;
  /** Milliseconds. */
  liquidity_pool_cooldown_period?: number;
  /** Milliseconds. */
  staking_pool_lockup_period?: number;
  max_integrator_perps_maker_fee?: number;
  max_integrator_perps_taker_fee?: number;
  max_integrator_spot_maker_fee?: number;
  max_integrator_spot_taker_fee?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Funding                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** One funding observation for a market. */
export interface Funding {
  /** Epoch milliseconds. */
  timestamp?: number;
  /** Decimal string. */
  value?: DecimalString;
  /** Decimal string. */
  rate?: DecimalString;
  direction?: string;
}

/** `GET /api/v1/fundings`. `resolution` accepts only `1h` and `1d`. */
export interface Fundings extends ResultCode {
  /** Echo of the requested resolution. */
  resolution?: string;
  fundings?: Funding[];
}

/**
 * A funding rate observation. This feed is **cross-venue** — the `exchange` field enumerates
 * competitors, so it can be used directly for basis comparison rather than only for Lighter.
 */
export interface FundingRate {
  market_id?: number;
  exchange?: "binance" | "bybit" | "hyperliquid" | "lighter";
  symbol?: string;
  /** Float-derived statistic. Not for money arithmetic. */
  rate?: number;
}

export interface FundingRates extends ResultCode {
  funding_rates?: FundingRate[];
}
