/**
 * Public-pool and staking-pool models.
 *
 * **This file declares no pool type that is embedded in an account.** `PublicPoolInfo`,
 * `PublicPoolShare`, `PendingUnlock` and `ApprovedIntegrator` all live inside `DetailedAccount`, so
 * `./account.js` owns them and this file imports them. The dependency arrow points that way and
 * only that way: declaring them in both places is a duplicate-definition bug that typechecks
 * locally and diverges on the first schema change (`docs/decisions.md` D8).
 *
 * What *is* here is the pool-as-a-listing surface — `GET /api/v1/publicPoolsMetadata` — plus the
 * three series element types that `PublicPoolInfo` leaves open, since they belong to this file and
 * `account.ts` cannot import them without inverting the arrow.
 *
 * Money split, as everywhere: pool values (`total_asset_value`, `operator_fee`, `collateral`) are
 * decimal **strings**; performance statistics (`annual_percentage_yield`, `sharpe_ratio`,
 * `share_price`, `daily_return`) are genuine JSON **floats** and must not feed money arithmetic
 * (`docs/decisions.md` D7).
 *
 * Types only. Nothing in this file runs.
 */

// Every pool type that an account embeds comes from `./account.js`. `PendingUnlock` and
// `ApprovedIntegrator` are imported alongside the two this file uses structurally, so that the
// ownership rule stated above is visible at the import site rather than only in prose.
import type {
  AccountAsset,
  ApprovedIntegrator,
  PendingUnlock,
  PublicPoolInfo,
  PublicPoolShare,
} from "./account.js";
import type { DecimalString, EpochMs, ResultCode } from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Series entries                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * One point on a pool's share-price curve.
 *
 * `share_price` is a **float**, not a decimal string. That is unusual for a price and it is what
 * the wire does: the server declares it `f64`, and the WebSocket `pool_info` payload
 * (`spec/06-websocket.md` §6.2.17) carries `share_prices:[{timestamp, share_price:F64}]`. It is a
 * charting statistic, in the same family as candle OHLCV, which is also float. Treat it as
 * display-only — a pool's actual value lives in {@link PublicPoolMetadata.total_asset_value}, which
 * *is* a decimal string.
 */
export interface SharePrice {
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Float-derived statistic. Must not feed money arithmetic. */
  share_price?: number;
}

/** One point on a pool's daily-return curve. `daily_return` is a float ratio, not an amount. */
export interface DailyReturn {
  /** Epoch milliseconds. */
  timestamp?: EpochMs;
  /** Float-derived statistic. Must not feed money arithmetic. */
  daily_return?: number;
}

/** One strategy bucket inside a pool. A single decimal-string field today. */
export interface Strategy {
  collateral?: DecimalString;
}

/**
 * {@link PublicPoolInfo} with its three series arrays narrowed to their element models.
 *
 * `account.ts` types them as open records on purpose — it cannot import from this file without
 * creating a cycle — and says so at the declaration. This alias is the boundary where they get
 * their real shape. A value of either type is assignable to the other's arrays element-wise, so
 * this is a narrowing, not a second definition.
 */
export type PublicPoolInfoDetail = Omit<
  PublicPoolInfo,
  "daily_returns" | "share_prices" | "strategies"
> & {
  daily_returns?: DailyReturn[];
  share_prices?: SharePrice[];
  strategies?: Strategy[];
};

/* -------------------------------------------------------------------------------------------- */
/* Pool listing                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * One pool as listed by `GET /api/v1/publicPoolsMetadata`.
 *
 * The wire form also carries the vestigial `code: 0` / `message` that the Go server's struct
 * embedding leaks onto nested models (`spec/05-rest-api.md` §2.5). They are always `0`/absent and
 * never meaningful, so they are stripped here — the envelope belongs to
 * {@link RespPublicPoolsMetadata}.
 *
 * Staking pools are the same shape; `?filter=stake` selects them. Both kinds of pool index sit in
 * the sub-account range, `>= 2^47` (`docs/protocol-notes.md` §11).
 */
export interface PublicPoolMetadata {
  account_index?: number;
  account_type?: number;
  master_account_index?: number;
  name?: string;
  l1_address?: string;
  status?: number;
  /** A percentage as a decimal string, e.g. `"0.1000"`. Not a float, unlike the yield beside it. */
  operator_fee?: DecimalString;
  /** The pool's net asset value. A decimal string — this is the number that is money. */
  total_asset_value?: DecimalString;
  total_perps_value?: DecimalString;
  total_spot_value?: DecimalString;
  /** Integer share units, not currency. */
  total_shares?: number;
  /** Float-derived statistic. Must not feed money arithmetic. */
  annual_percentage_yield?: number;
  /** Float-derived statistic. Must not feed money arithmetic. */
  sharpe_ratio?: number;
  /** The querying account's own holding, present only when `account_index` was supplied and authed. */
  account_share?: PublicPoolShare;
  assets?: AccountAsset[];
  /** Epoch milliseconds. */
  created_at?: EpochMs;
}

/**
 * `GET /api/v1/publicPoolsMetadata`.
 *
 * Unpaginated in the cursor sense: it takes `index` and `limit` (`1..100`) and walks the pool index
 * space, so there is no cursor to follow. `auth` is required whenever `account_index` is supplied.
 */
export interface RespPublicPoolsMetadata extends ResultCode {
  public_pools?: PublicPoolMetadata[];
}

/*
 * Re-exports are deliberately absent. A consumer that needs {@link PublicPoolInfo},
 * {@link PublicPoolShare}, {@link PendingUnlock} or {@link ApprovedIntegrator} imports them from
 * `./account.js`, the one file that declares them.
 */
