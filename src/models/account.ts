/**
 * Account, position, risk and liquidation models, plus the account-scoped request bodies.
 *
 * Two traps live here and both are silent:
 *
 * - **`AccountPosition.position` is an unsigned magnitude.** Exposure is `sign × position`. A
 *   consumer who reads `position` directly gets the right number for longs and the wrong sign for
 *   shorts, which is exactly the bug that survives testing on a long-only book. Hence
 *   {@link signedPositionSize}, the one function in this directory.
 * - **`margin_mode` is two different types under one name.** On {@link AccountAsset} it is
 *   `'enabled' | 'disabled'`; on {@link AccountPosition} it is an integer, `0` cross and `1`
 *   isolated. They are deliberately not unified and share no alias.
 *
 * This file also owns {@link PublicPoolInfo}, {@link PublicPoolShare}, {@link PendingUnlock} and
 * {@link ApprovedIntegrator} even though "pool" suggests `src/models/pool.ts`. They are embedded
 * inside {@link DetailedAccount}, and `pool.ts` depends on this file rather than the reverse;
 * declaring them there would be a cycle.
 */

import type {
  AssetMarginMode,
  Cursored,
  DecimalString,
  EpochMicros,
  EpochMs,
  PositionSide,
  ResultCode,
} from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Positions and assets                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * An open position. The single most important model for a trading client.
 *
 * `position` is a **magnitude**, never negative. Combine it with `sign` — or call
 * {@link signedPositionSize}, which does the string surgery without touching binary floats.
 */
export interface AccountPosition {
  market_id?: number;
  symbol?: string;
  /** `+1` long, `-1` short. The sign of the exposure; `position` carries only its magnitude. */
  sign?: number;
  /** **Unsigned** size. Not the exposure. See {@link signedPositionSize}. */
  position?: DecimalString;
  avg_entry_price?: DecimalString;
  position_value?: DecimalString;
  unrealized_pnl?: DecimalString;
  realized_pnl?: DecimalString;
  liquidation_price?: DecimalString;
  total_funding_paid_out?: DecimalString;
  /** Decimal string, unlike the basis-point integers on markets and trades. */
  initial_margin_fraction?: DecimalString;
  /**
   * `0` = cross, `1` = isolated. An **integer**, unlike {@link AccountAsset.margin_mode}, which is
   * `'enabled' | 'disabled'`. Same field name, different type, different meaning.
   */
  margin_mode?: number;
  allocated_margin?: DecimalString;
  total_discount?: DecimalString;
  open_order_count?: number;
  pending_order_count?: number;
  position_tied_order_count?: number;
}

/** A balance in a single asset. */
export interface AccountAsset {
  symbol?: string;
  asset_id?: number;
  balance?: DecimalString;
  locked_balance?: DecimalString;
  margin_balance?: DecimalString;
  /**
   * `'enabled' | 'disabled'` — whether this asset counts as margin. A **string**, unlike
   * {@link AccountPosition.margin_mode}, which is an integer cross/isolated flag.
   */
  margin_mode?: AssetMarginMode;
}

/* -------------------------------------------------------------------------------------------- */
/* Pool structures embedded in an account                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * A structural placeholder for the pool series entries embedded in {@link PublicPoolInfo}.
 *
 * Their precise models — `DailyReturn`, `SharePrice`, `Strategy` — are owned by
 * `src/models/pool.ts`, which imports *from* this file. Importing them back would invert that
 * dependency, so the embedded arrays are left open here and narrowed at the pool-facing API.
 * `pool.ts` is free to declare `PublicPoolInfo['daily_returns']` as `DailyReturn[]` at its own
 * boundary; an entry is assignable either way.
 */
export interface PoolSeriesEntry {
  [key: string]: unknown;
}

/**
 * Public-pool operating parameters and performance, present on {@link DetailedAccount} only when
 * the account **is** a pool. Absent otherwise, despite being marked `required` by the document.
 *
 * `daily_returns`, `share_prices` and `strategies` are typed loosely here on purpose: their element
 * models (`DailyReturn`, `SharePrice`, `Strategy`) belong to `src/models/pool.ts`, which imports
 * *from* this file. Declaring them in both places is a duplicate-definition bug that typechecks
 * locally and diverges later.
 */
export interface PublicPoolInfo {
  status?: number;
  operator_fee?: DecimalString;
  min_operator_share_rate?: DecimalString;
  /** Share counts are integer units, not currency. */
  total_shares?: number;
  operator_shares?: number;
  /** Float-derived statistic. Must not feed money arithmetic. */
  annual_percentage_yield?: number;
  /** Float-derived statistic. Must not feed money arithmetic. */
  sharpe_ratio?: number;
  daily_returns?: PoolSeriesEntry[];
  share_prices?: PoolSeriesEntry[];
  strategies?: PoolSeriesEntry[];
}

/** An account's holding in a public pool. */
export interface PublicPoolShare {
  public_pool_index?: number;
  /** Integer share units, not currency. */
  shares_amount?: number;
  entry_usdc?: DecimalString;
  /** Epoch milliseconds. */
  entry_timestamp?: EpochMs;
  principal_amount?: DecimalString;
}

/** A staking or pool withdrawal still inside its lockup. */
export interface PendingUnlock {
  /** Epoch milliseconds. */
  unlock_timestamp?: EpochMs;
  asset_index?: number;
  amount?: DecimalString;
}

/** An integrator the account has authorised to collect fees on its trades. */
export interface ApprovedIntegrator {
  account_index?: number;
  name?: string;
  /** Fee tick ceiling, not a currency amount. */
  max_perps_taker_fee?: number;
  /** Fee tick ceiling. */
  max_perps_maker_fee?: number;
  /** Fee tick ceiling. */
  max_spot_taker_fee?: number;
  /** Fee tick ceiling. */
  max_spot_maker_fee?: number;
  /** Epoch milliseconds. */
  approval_expiry?: EpochMs;
}

/* -------------------------------------------------------------------------------------------- */
/* Accounts                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Free-form account metadata. Live responses carry `{ "color": "" }`; the field is absent from the
 * OpenAPI document entirely (`spec/05-rest-api.md` §9.1), so its full key set is unknown and the
 * index signature is honest rather than lax.
 */
export interface AccountMetadataObject {
  color?: string;
  [key: string]: unknown;
}

/**
 * A full account, from `GET /api/v1/account?by=index|l1_address&value=…`.
 *
 * The wire form of this object also carries `code: 0` and sometimes `message`, produced by struct
 * embedding on the Go side (`spec/05-rest-api.md` §2.5). They are **always** `0`/absent and never
 * meaningful, so they are stripped here: a consumer who can see `code` on a nested account will
 * eventually branch on it.
 */
export interface DetailedAccount {
  /** Duplicate of {@link DetailedAccount.account_index}; both are present on the wire. */
  index?: number;
  account_index?: number;
  l1_address?: string;
  account_type?: number;
  account_trading_mode?: number;
  status?: number;
  collateral?: DecimalString;
  available_balance?: DecimalString;
  total_asset_value?: DecimalString;
  cross_asset_value?: DecimalString;
  cross_initial_margin_requirement?: DecimalString;
  cross_maintenance_margin_requirement?: DecimalString;
  positions?: AccountPosition[];
  assets?: AccountAsset[];
  total_order_count?: number;
  total_isolated_order_count?: number;
  pending_order_count?: number;
  /** Epoch milliseconds. Orders placed before this are treated as cancelled. */
  cancel_all_time?: EpochMs;
  /** Epoch milliseconds. */
  created_at?: EpochMs;
  /** Epoch **microseconds**. */
  transaction_time?: EpochMicros;
  name?: string;
  description?: string;
  can_invite?: boolean;
  /** A percentage as a decimal string; `""` when unset. */
  referral_points_percentage?: DecimalString;
  can_rfq?: boolean;
  /** Market ids as **strings**, e.g. `["0","1","2"]`. */
  can_rfq_market_ids?: string[];
  /** Absent for non-pool accounts, despite being marked `required` by the document. */
  pool_info?: PublicPoolInfo;
  shares?: PublicPoolShare[];
  pending_unlocks?: PendingUnlock[];
  /** Absent when the account has approved no integrators. */
  approved_integrators?: ApprovedIntegrator[];
  /** `[+]` Present live, absent from the OpenAPI document. */
  metadata?: AccountMetadataObject;
}

export interface DetailedAccounts extends ResultCode, Cursored {
  total?: number;
  accounts?: DetailedAccount[];
}

/**
 * The lightweight account variant returned inside `SubAccounts.sub_accounts` — {@link
 * DetailedAccount} minus positions, assets and pool data.
 *
 * The vestigial `code: 0` the server embeds here is stripped (§2.5).
 */
export interface Account {
  index?: number;
  l1_address?: string;
  account_type?: number;
  account_trading_mode?: number;
  status?: number;
  collateral?: DecimalString;
  available_balance?: DecimalString;
  total_order_count?: number;
  total_isolated_order_count?: number;
  pending_order_count?: number;
  /** Epoch milliseconds. */
  cancel_all_time?: EpochMs;
  /** Epoch **microseconds**. */
  transaction_time?: EpochMicros;
}

export interface SubAccounts extends ResultCode, Cursored {
  l1_address?: string;
  sub_accounts?: Account[];
}

/** Per-account display metadata, from `GET /api/v1/accountMetadata`. */
export interface AccountMetadata {
  account_index?: number;
  name?: string;
  description?: string;
  can_invite?: boolean;
  referral_points_percentage?: DecimalString;
  can_rfq?: boolean;
  /** Market ids as strings. */
  can_rfq_market_ids?: string[];
  /** Epoch milliseconds. */
  created_at?: EpochMs;
}

export interface AccountMetadatas extends ResultCode, Cursored {
  account_metadatas?: AccountMetadata[];
}

/**
 * A registered API key. On the signer's verification path: `public_key` is the Schnorr key whose
 * private half signs transactions for `(account_index, api_key_index)`.
 */
export interface ApiKey {
  account_index?: number;
  /** `0..255`. Index `0` is conventionally the master key. */
  api_key_index?: number;
  /** The next expected nonce for this key. */
  nonce?: number;
  /** Hex-encoded compressed Schnorr public key. */
  public_key?: string;
  /** Epoch **microseconds**. */
  transaction_time?: EpochMicros;
}

export interface AccountApiKeys extends ResultCode {
  api_keys?: ApiKey[];
}

/** Tier-derived limits for an account, from `GET /api/v1/accountLimits`. */
export interface AccountLimits extends ResultCode {
  /** Percentage as an integer. */
  max_llp_percentage?: number;
  max_llp_amount?: DecimalString;
  user_tier?: string;
  user_tier_name?: string;
  /** Epoch milliseconds. */
  user_tier_last_update?: EpochMs;
  can_create_public_pool?: boolean;
  /** Fee tick, not a currency amount. */
  current_maker_fee_tick?: number;
  /** Fee tick, not a currency amount. */
  current_taker_fee_tick?: number;
  effective_lit_stakes?: DecimalString;
  leased_lit?: DecimalString;
}

/* -------------------------------------------------------------------------------------------- */
/* Position funding                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** One funding payment against an open position. */
export interface PositionFunding {
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  market_id?: number;
  funding_id?: number;
  /** Signed decimal string: negative when the position paid. */
  change?: DecimalString;
  discount?: DecimalString;
  rate?: DecimalString;
  position_size?: DecimalString;
  position_side?: PositionSide;
}

export interface PositionFundings extends ResultCode, Cursored {
  position_fundings?: PositionFunding[];
}

/* -------------------------------------------------------------------------------------------- */
/* Risk and liquidation                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Margin requirements for one margin bucket — the cross bucket, or one isolated market. */
export interface RiskParameters {
  /** The isolated market this bucket covers. Meaningless on the cross bucket. */
  market_id?: number;
  collateral?: DecimalString;
  total_account_value?: DecimalString;
  initial_margin_req?: DecimalString;
  maintenance_margin_req?: DecimalString;
  close_out_margin_req?: DecimalString;
  total_account_liquidation_threshold?: DecimalString;
  usdc_collateral_with_funding?: DecimalString;
  usdc_portfolio_value?: DecimalString;
}

/** The account's margin state: one cross bucket plus one bucket per isolated market. */
export interface RiskInfo {
  cross_risk_parameters?: RiskParameters;
  isolated_risk_parameters?: RiskParameters[];
}

/** The trade leg of a liquidation. */
export interface LiqTrade {
  price?: DecimalString;
  size?: DecimalString;
  /** A decimal string here, unlike the integer fee ticks on `Trade`. */
  taker_fee?: DecimalString;
  /** A decimal string here, unlike the integer fee ticks on `Trade`. */
  maker_fee?: DecimalString;
  /** Epoch **microseconds**. */
  transaction_time?: EpochMicros;
}

/** The account snapshot either side of a liquidation — what the risk engine saw and produced. */
export interface LiquidationInfo {
  positions?: AccountPosition[];
  risk_info_before?: RiskInfo;
  risk_info_after?: RiskInfo;
  /** Keyed by market id. Values are float-derived; not for money arithmetic. */
  mark_prices?: Record<string, number>;
  assets?: AccountAsset[];
  /** Keyed by asset id. Values are decimal **strings**, unlike `mark_prices`. */
  asset_index_prices?: Record<string, DecimalString>;
}

export interface Liquidation {
  id?: number;
  market_id?: number;
  /** `'partial'` is a margin-call liquidation; `'deleverage'` is auto-deleveraging. */
  type?: "partial" | "deleverage";
  trade?: LiqTrade;
  info?: LiquidationInfo;
  /** Epoch milliseconds. */
  executed_at?: EpochMs;
}

export interface LiquidationInfos extends ResultCode, Cursored {
  liquidations?: Liquidation[];
}

/* -------------------------------------------------------------------------------------------- */
/* Request bodies                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * `POST /api/v1/apikeys` — mint a managed read-only API token (auth scheme B).
 *
 * `scopes` is a free-form string, observed `"read.*"`. It is not an enum and not an array.
 */
export interface ReqPostApiToken {
  name: string;
  account_index: number;
  /** Epoch **seconds**, like the auth-token deadline. */
  expiry: number;
  sub_account_access: boolean;
  scopes?: string;
}

/** `POST /api/v1/revokeApiToken`. */
export interface ReqRevokeApiToken {
  token_id: number;
  account_index: number;
}

/**
 * `POST /api/v1/changeAccountTier`.
 *
 * `auth` is the scheme-A signed token. The SDK injects it from the auth provider rather than
 * making callers thread it through, and prefers the `Authorization` header when one is available.
 */
export interface ReqChangeAccountTier {
  account_index: number;
  new_tier: string;
  auth?: string;
}

/**
 * `POST /api/v1/setMakerOnlyApiKeys`.
 *
 * `api_key_indexes` is a **JSON array encoded into a string**, e.g. `"[4,5]"`; `"[]"` clears the
 * set. It is not a repeated form field and not a comma list.
 */
export interface ReqSetMakerOnlyApiKeys {
  account_index: number;
  api_key_indexes: string;
  auth?: string;
}

/**
 * `POST /api/v1/setAccountMetadata` — the **only** endpoint on the API that takes
 * `application/json` rather than `application/x-www-form-urlencoded`.
 *
 * `metadata` is itself a JSON **string** nested inside that JSON body.
 */
export interface ReqSetAccountMetadata {
  master_account_index: number;
  target_account_index: number;
  api_key_index: number;
  /** A JSON document encoded as a string. */
  metadata: string;
  auth?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Returns `true` when a decimal string denotes zero — no digit `1`–`9` anywhere in it.
 *
 * Deliberately character-based: `Number("0.00000000000000000001")` is not zero but a naive
 * comparison against `0` after a lossy parse can make it look like zero, and the whole point of
 * this file is that no monetary string is ever handed to `Number`.
 */
function isZeroMagnitude(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x31 && code <= 0x39) return false;
  }
  return true;
}

/**
 * The signed exposure of a position, as a decimal string.
 *
 * `position` is an unsigned magnitude and `sign` is `+1` long / `-1` short
 * (`spec/05-rest-api.md` §10.8). Every consumer that computes exposure has to combine them, so it
 * is done once, here.
 *
 * Zero stays `"0"` — never `"-0"`, which would compare unequal to `"0"` as a string and sort
 * strangely, and never `"+0"`. Positive values keep no sign, matching the wire's own spelling.
 *
 * String surgery only: no `Number`, no `parseFloat`, no `Math`. Feeding a price or size through a
 * binary float is the precision bug `docs/decisions.md` D7 exists to prevent.
 *
 * ```ts
 * signedPositionSize({ sign: -1, position: "0.04220" }); // "-0.04220"
 * signedPositionSize({ sign: 1, position: "0" });        // "0"
 * ```
 */
export function signedPositionSize(p: Pick<AccountPosition, "sign" | "position">): string {
  const magnitude = p.position ?? "0";
  if (magnitude.length === 0) return magnitude;
  if (p.sign === undefined || p.sign >= 0) return magnitude;
  if (magnitude.charCodeAt(0) === 0x2d) return magnitude;
  if (isZeroMagnitude(magnitude)) return magnitude;
  return `-${magnitude}`;
}
