/**
 * Referral, partner and L1-metadata models, plus the four referral request bodies.
 *
 * Nothing here is on the trading hot path, but two facts about the envelope are load-bearing and
 * both are easy to get wrong:
 *
 * - **{@link ReferralPoints} carries no `code` field.** `GET /api/v1/referral/points` is one of the
 *   three endpoints verified to return `200` with no envelope at all (`docs/protocol-notes.md` §8,
 *   `spec/05-rest-api.md` §3.2). It must not extend `ResultCode`: giving it a `code` would make the
 *   transport's success predicate — HTTP 2xx **and** (`code` absent **or** `code === 200`) — look
 *   like a workaround instead of the rule.
 * - **{@link UserReferrals} paginates with `cursor`, not `next_cursor`.** The API never settled on
 *   one spelling (§6). Exhaustion is the key being *absent*, not `""` and not `null`.
 *
 * The points fields are genuine JSON floats. Everything denominated in an asset — trade volumes,
 * partner fees — is a decimal string (`docs/decisions.md` D7).
 *
 * Types only. Nothing in this file runs.
 */

import type {
  DecimalString,
  EpochMs,
  LegacyCursored,
  ResultCode,
} from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Referrals                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Trading volume attributed to a referred user, split by the client the trade came from.
 *
 * Counts are integers; every `*_volume` is a decimal **string** and must never be parsed with
 * `Number` (`docs/decisions.md` D7).
 */
export interface TradeStats {
  count?: number;
  volume?: DecimalString;
  web_count?: number;
  web_volume?: DecimalString;
  mobile_app_count?: number;
  mobile_app_volume?: DecimalString;
  mobile_browser_count?: number;
  mobile_browser_volume?: DecimalString;
}

/** One user who signed up under a referral code, as listed by `GET /referral/userReferrals`. */
export interface Referral {
  l1_address?: string;
  referral_code?: string;
  /**
   * Epoch milliseconds. The unit is not stated by any source; milliseconds is the API's default
   * and every other `*_at` on an account-scoped model is milliseconds (`spec/05-rest-api.md` §2.4).
   */
  used_at?: EpochMs;
  trade_stats?: TradeStats;
  tier?: string;
}

/**
 * `POST /referral/create` and `GET /referral/get` — the account's own code and how many more times
 * it may be used.
 */
export interface ReferralCode extends ResultCode {
  referral_code?: string;
  remaining_usage?: number;
}

/**
 * `GET /referral/userReferrals`. Paginates with the **legacy `cursor` key**, not `next_cursor`
 * (`spec/05-rest-api.md` §6). `limit` is `1..300` here, wider than the usual `1..100`.
 */
export interface UserReferrals extends ResultCode, LegacyCursored {
  referrals?: Referral[];
  /** The code this account itself signed up under, if any. */
  used_code?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Referral points                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** One referred address's point totals. All point values are float-derived; see {@link ReferralPoints}. */
export interface ReferralPointEntry {
  l1_address?: string;
  /** Float-derived. Points, not currency — must not feed money arithmetic. */
  total_points?: number;
  /** Float-derived. */
  week_points?: number;
  /** Float-derived. */
  total_reward_points?: number;
  /** Float-derived. */
  week_reward_points?: number;
  /** A multiplier rendered as a decimal **string**, unlike the point totals beside it. */
  reward_point_multiplier?: DecimalString;
}

/**
 * `GET /api/v1/referral/points`.
 *
 * **This model deliberately has no `code`.** It is one of the three endpoints that return `200`
 * with no envelope (`docs/protocol-notes.md` §8, `spec/05-rest-api.md` §3.2); the other two are
 * `GET /api/v1/withdrawalDelay` and `GET /api/v1/executeStats`, both in `./misc.js`. A client whose
 * success check is `body.code === 200` rejects a perfectly good response from all three.
 *
 * Point values are JSON floats — the wire's choice, not ours. They are scores, not balances, so the
 * decimal-string rule does not apply; they must still never be mixed into money arithmetic.
 */
export interface ReferralPoints {
  referrals?: ReferralPointEntry[];
  /** Float-derived. */
  user_total_points?: number;
  /** Float-derived. */
  user_last_week_points?: number;
  /** Float-derived. */
  user_total_referral_reward_points?: number;
  /** Float-derived. */
  user_last_week_referral_reward_points?: number;
  /** A decimal **string**, unlike every point total on this model. */
  reward_point_multiplier?: DecimalString;
}

/* -------------------------------------------------------------------------------------------- */
/* Partner and L1 metadata                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/partnerStats` — fee revenue attributed to a partner account.
 *
 * Every fee and volume is a decimal **string**; only the trade and client counts are numbers. With
 * no `start_timestamp`/`end_timestamp` the server returns all-time figures.
 */
export interface PartnerStats extends ResultCode {
  total_fees_earned?: DecimalString;
  total_taker_fees_earned?: DecimalString;
  total_maker_fees_earned?: DecimalString;
  total_volume?: DecimalString;
  total_taker_volume?: DecimalString;
  total_maker_volume?: DecimalString;
  total_trades?: number;
  total_taker_trades?: number;
  total_maker_trades?: number;
  unique_clients?: number;
}

/**
 * `GET /api/v1/l1Metadata` — invite and kickback settings keyed by L1 address.
 *
 * **No `code`.** The vendored OpenAPI snapshot declares `code`/`message` on a response model
 * exactly when the Go handler embeds the shared result struct, and it omits both here. That signal
 * is right on all three endpoints where the envelope was checked against a live capture
 * (`withdrawalDelay`, `executeStats`, `referral/points` — all three lack `code` in the snapshot and
 * on the wire), so it is trusted here too. `spec/05-rest-api.md` §3.2 lists only those three
 * because only those three were probed; this endpoint requires auth and was never reached. The
 * transport's success rule tolerates either outcome, which is the reason it is written the way it
 * is — but a consumer reading `code` off this model would be reading a field that is not there.
 */
export interface L1Metadata {
  l1_address?: string;
  can_invite?: boolean;
  /** A percentage as a decimal string; `""` when unset, exactly as on `DetailedAccount`. */
  referral_points_percentage?: DecimalString;
}

/* -------------------------------------------------------------------------------------------- */
/* Single-value responses                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `POST /referral/kickback/update`. Allowed once per day; the server rejects the second call. */
export interface RespUpdateKickback extends ResultCode {
  success?: boolean;
}

/** `POST /referral/update`. Allowed once per account, ever. */
export interface RespUpdateReferralCode extends ResultCode {
  success?: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Request bodies                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/*
 * All four are `application/x-www-form-urlencoded`. `auth` is the scheme-A signed token
 * (`spec/05-rest-api.md` §5.2): the SDK injects it from the auth provider rather than making
 * callers thread it through, and prefers the `Authorization` header when one is available — which
 * is why it is optional on every body here rather than required.
 */

/** `POST /api/v1/referral/create`. */
export interface ReqCreateReferralCode {
  account_index: number;
  auth?: string;
}

/** `POST /api/v1/referral/update` — rename the account's code. One shot per account. */
export interface ReqUpdateReferralCode {
  account_index: number;
  new_referral_code: string;
  auth?: string;
}

/**
 * `POST /api/v1/referral/use` — sign up under someone else's code.
 *
 * `x` is required while `discord` and `telegram` are not: an asymmetry in the server's validation,
 * not a transcription slip (`spec/05-rest-api.md` §8, group `referral`).
 */
export interface ReqUseReferralCode {
  l1_address: string;
  referral_code: string;
  /** Required by the server, unlike the other two social handles. */
  x: string;
  discord?: string;
  telegram?: string;
  signature?: string;
  auth?: string;
}

/**
 * `POST /api/v1/referral/kickback/update`.
 *
 * `kickback_percentage` is declared `f64` by the server and is a **percentage share, not a monetary
 * amount** — the one float input in this group. It is form-encoded to its decimal spelling on the
 * way out, so no binary-float value ever reaches a balance (`docs/decisions.md` D7).
 */
export interface ReqUpdateKickback {
  account_index: number;
  kickback_percentage: number;
  auth?: string;
}
