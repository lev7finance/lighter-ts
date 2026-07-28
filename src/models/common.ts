/**
 * Envelope vocabulary shared by every REST model.
 *
 * Three facts about the wire drive everything in this directory, and all three are measured
 * (`docs/protocol-notes.md` §8, `spec/05-rest-api.md` §3, §9):
 *
 * 1. **Success and failure are signalled twice.** Most bodies carry a top-level `code`, `200` on
 *    success and a domain code otherwise. But `GET /withdrawalDelay`, `GET /executeStats` and
 *    `GET /referral/points` return `200` with **no `code` field at all**, so the success predicate
 *    is "HTTP 2xx *and* (`code` absent *or* `code === 200`)". Models for those three endpoints must
 *    not extend {@link ResultCode}; giving them a `code` would make the transport's rule look wrong.
 * 2. **Every other response field is optional.** The server is Go with `omitempty`, so a
 *    zero-valued field is simply absent from the JSON. The vendored OpenAPI document marks ~95% of
 *    response fields `required` anyway; a live `Trade` omitted 13 of them (§9.2). Optionality here
 *    is `?:`, never `| undefined` — `exactOptionalPropertyTypes` is on, and the difference is
 *    exactly "the key may be absent" versus "the key exists holding `undefined`". Only `code` is
 *    non-optional, and only on the models that carry it.
 * 3. **Money is a decimal string; statistics are JSON numbers.** The split is inconsistent and it
 *    is a wire fact. See {@link DecimalString}.
 *
 * Types only. Nothing in this file runs.
 */

/* -------------------------------------------------------------------------------------------- */
/* Unit aliases                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Epoch **milliseconds**. The API's most common timestamp unit, but not its only one, and nothing
 * in the payload distinguishes them — hence these aliases, which force every field to state its
 * unit at the point of declaration. Never write a blanket `new Date(x)` helper.
 */
export type EpochMs = number;

/**
 * Epoch **seconds**. Used by `Status.timestamp` (`GET /`), `Announcement.created_at` /
 * `expired_at`, `ExecuteStat.timestamp`, and the auth-token deadline.
 */
export type EpochSeconds = number;

/**
 * Epoch **microseconds**. Used by `transaction_time` on accounts, orders and trades — and by
 * nothing else. Values are ~1.78e15, three decimal digits wider than the millisecond fields
 * alongside them, which is the only clue on the wire.
 */
export type EpochMicros = number;

/**
 * A fixed-point decimal rendered at the market's or asset's declared precision — `"64397.7"`,
 * `"0.00089"`, `"3113.800050"`.
 *
 * Every monetary and size quantity on this API arrives as one of these. **Never** parse one with
 * `Number` (`docs/decisions.md` D7): `Number("3113.800050")` loses money silently and the loss is
 * invisible until it is settled. Use `src/util/decimal.ts`, which converts to scaled `bigint`.
 *
 * This is a documentation alias, not a brand — it does not stop you passing a plain string. Its
 * job is to make the numeric domain of a field legible where it is declared.
 */
export type DecimalString = string;

/**
 * A decimal integer carried as a string because its domain is `int64` and `JSON.parse` rounds
 * silently above 2^53−1 (`spec/05-rest-api.md` §2.4).
 *
 * Where the API offers both spellings — `trade_id` / `trade_id_str`, `ask_id` / `ask_id_str`,
 * `order_index` / `order_id` — **the string is canonical**. The numeric twin is retained on these
 * models because it is on the wire, and is marked lossy where it appears. Live order ids are
 * already ~5.6e14 and the sequence is monotonic and unbounded.
 */
export type Int64String = string;

/* -------------------------------------------------------------------------------------------- */
/* Envelopes                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * The universal envelope, and the structural base of nearly every success model.
 *
 * `code` is `200` on success and a domain error code otherwise; it is *not* an HTTP status that
 * happens to share the value. `0` appears only on vestigial nested structs and is never meaningful
 * (§2.5). `message` is `omitempty` — on success it is **absent**, not `null`, not `""`.
 */
export interface ResultCode {
  code: number;
  message?: string;
}

/** Collections that paginate with `next_cursor` — orders, trades, accounts, leases, RFQs. */
export interface Cursored {
  /** Absent when the collection is exhausted. Not `""`, not `null`. */
  next_cursor?: string;
}

/**
 * Collections that paginate with the older `cursor` spelling — deposit, withdraw and transfer
 * history, and user referrals. Same semantics, different key; the API never settled on one.
 */
export interface LegacyCursored {
  /** Absent when the collection is exhausted. Not `""`, not `null`. */
  cursor?: string;
}

/**
 * Either cursor spelling. This is what the pagination helper reads, so that it can follow both
 * families without knowing which endpoint it is walking.
 */
export interface CursorPage {
  next_cursor?: string;
  cursor?: string;
}

/**
 * The escape hatch for endpoints with no hand-authored model.
 *
 * `docs/decisions.md` D10 cuts the generated long tail from v1: the trading core is modelled
 * precisely, and everything else flows through this permissive type rather than through a shape
 * guessed from an OpenAPI document that is known to be wrong. The route table spells such routes
 * `{} as UnmodelledResponse`.
 *
 * The index signature deliberately disables excess-property checking: an unmodelled response is
 * one whose fields we have not verified, and pretending otherwise is the failure mode this avoids.
 */
export type UnmodelledResponse = ResultCode & Record<string, unknown>;

/* -------------------------------------------------------------------------------------------- */
/* Shared literal unions                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The `market_type` / `filter` **query** value on `orderBooks`, `orderBookDetails`, `trades` and
 * the account order endpoints. Includes `'all'`, which is the default.
 *
 * Distinct from {@link MarketKind}, which is what a market object actually reports about itself —
 * a market is never `'all'`.
 */
export type MarketType = "all" | "spot" | "perp";

/** The `market_type` **field** on a market object. `'all'` is a query filter, never a wire value. */
export type MarketKind = "perp" | "spot";

/** `status` on a market. Inactive markets are still listed and still carry full metadata. */
export type MarketStatus = "active" | "inactive";

/**
 * `sort_dir` on `trades`. A one-member union: the server accepts only `'desc'`, so ascending
 * iteration is impossible through this API. Reproduced as a union rather than dropped so the
 * limitation is visible at the call site.
 */
export type SortDir = "desc";

/** `role` filter on `trades` and `export`. */
export type Role = "all" | "maker" | "taker";

/** `side` filter on `export` and `positionFunding`. Directional, not ask/bid. */
export type Side = "all" | "long" | "short";

/** The direction of an open position, as reported by `positionFunding`. */
export type PositionSide = "long" | "short";

/**
 * `margin_mode` on an **asset** (`AccountAsset`, `Asset`) — whether the asset may be used as
 * margin.
 *
 * `AccountPosition.margin_mode` is a different thing under the same name: an integer, `0` cross and
 * `1` isolated. The two are deliberately not unified (`spec/05-rest-api.md` §10.8).
 */
export type AssetMarginMode = "enabled" | "disabled";
