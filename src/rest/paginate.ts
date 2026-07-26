/**
 * Cursor pagination, for every collection endpoint on the API.
 *
 * Pagination on this API is cursor-based, opaque and forward-only — there is no offset, no page
 * number and no total (`spec/05-rest-api.md` §6). Three facts about it are load-bearing, and each
 * one is a way this file could be written wrongly:
 *
 * 1. **The response spells the cursor two different ways; the request spells it one way.**
 *    `next_cursor` on `DetailedAccounts`, `AccountMetadatas`, `SubAccounts`, `Orders`, `Trades`,
 *    `PositionFundings`, `LiquidationInfos`, `RespGetLeases` and `RespListRFQs`; the older plain
 *    `cursor` on `DepositHistory`, `WithdrawHistory`, `TransferHistory` and `UserReferrals`. The
 *    request parameter is **always** `cursor`. {@link nextCursor} is the one normaliser that reads
 *    both, so no caller ever has to know which family an endpoint belongs to.
 * 2. **Exhaustion is the key being *absent*.** The server is Go with `omitempty`, so the final page
 *    simply has no cursor key at all — not `""`, not `null`. A single-page `account` response
 *    contains no `next_cursor` key. Testing `cursor !== ""` therefore loops forever on the last
 *    page, which is exactly the bug this comment exists to prevent.
 * 3. **A cursor is opaque.** Nothing here constructs one, parses one, or infers anything from its
 *    contents. The only thing ever asked of a cursor value is whether it is present and whether it
 *    equals one already used — see {@link nextCursor} for the single deliberate exception, and why
 *    an empty string is treated as absence rather than as a cursor.
 *
 * Pages are yielded rather than items, so the caller controls concurrency, can stop early with a
 * `break`, and can see the envelope (`code`, and whatever else a particular response carries).
 * {@link paginateItems} is the flattening variant for when none of that matters.
 *
 * Two bounds keep a misbehaving server from turning an iteration into a bill: a repeated cursor
 * **throws**, and `maxPages` (default {@link DEFAULT_MAX_PAGES}) stops the loop. `limit` is passed
 * through untouched — its accepted range differs per endpoint (`1..100` mostly, `1..250` for
 * `orderBookOrders`, `1..300` for `referral/userReferrals`) and is enforced server-side, so
 * inventing a default here would silently break the endpoints whose range is different.
 *
 * No I/O of its own: every request goes through the {@link LighterRestClient} the caller supplies.
 */

import { LighterError, LighterValidationError } from "../errors.js";
import type { CursorPage } from "../models/common.js";
import type { CallOptions, LighterRestClient } from "./client.js";
import type { ItemOf, ParamsOf, ResponseOf, RouteDef } from "./route-types.js";

/* ---------------------------------------------------------------------------------------------- */
/* Options                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Ceiling on the number of pages one iteration will fetch.
 *
 * Chosen to be far beyond any legitimate walk (1000 pages at the usual `limit` of 100 is 100 000
 * records) while still being *a* bound. An unbounded generator against a paginating API is a
 * resource leak with an invoice attached.
 */
export const DEFAULT_MAX_PAGES: 1000 = 1000;

/**
 * Everything a single call may override, plus the page bound.
 *
 * Extends {@link CallOptions} so an iteration can carry a `signal` — cancelling a walk halfway
 * through is the common case, and the alternative is a second client. `raw` is deliberately not
 * available: pagination has to read the body to find the cursor.
 */
export interface PaginateOptions extends CallOptions {
  /**
   * Stop after this many pages. Default {@link DEFAULT_MAX_PAGES}.
   *
   * Reaching the bound ends the iteration quietly — it is a safety ceiling, not an assertion. A
   * caller who needs to know whether the collection was exhausted should count the pages it saw.
   */
  readonly maxPages?: number;
}

/* ---------------------------------------------------------------------------------------------- */
/* The normaliser                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The next cursor of a page, or `undefined` when the collection is exhausted.
 *
 * `next_cursor ?? cursor`, in that order — the two spellings never appear together, and preferring
 * the newer one costs nothing if they ever do.
 *
 * An empty string is reported as exhaustion. That is the one place this module looks *inside* a
 * cursor value, and it is a safety measure rather than an interpretation: `?cursor=` is not a
 * request for the next page (several endpoints distinguish an empty parameter from an absent one),
 * so a `""` cursor could only ever re-fetch page one. Absence is what the server actually sends,
 * and is the case the loop is built around.
 */
export function nextCursor(page: unknown): string | undefined {
  if (typeof page !== "object" || page === null) return undefined;
  const cursored: CursorPage = page as CursorPage;
  const candidate: string | undefined = cursored.next_cursor ?? cursored.cursor;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return candidate;
}

/* ---------------------------------------------------------------------------------------------- */
/* Page iteration                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Walk a paginated route, yielding one response envelope per page.
 *
 * ```ts
 * for await (const page of paginate(client, routes.trades, { sort_by: "trade_id", limit: 100 })) {
 *   for (const trade of page.trades ?? []) record(trade);
 *   if (enough()) break; // no further request is issued
 * }
 * ```
 *
 * The first page uses `params` exactly as given — including a `cursor` the caller supplies, which
 * is how a walk is resumed. Every later page is `params` with `cursor` replaced; no other parameter
 * is touched, so `limit`, filters and sort order carry through unchanged.
 *
 * @throws {LighterValidationError} `maxPages` is not a positive integer (`code: "MAX_PAGES_INVALID"`).
 * @throws {LighterError} the server returned a cursor it had already returned, which would spin
 *   forever (`kind: "decode"`, `code: "CURSOR_REPEATED"`).
 * @throws every error {@link LighterRestClient.request} throws, on any page.
 */
export function paginate<R extends RouteDef>(
  client: LighterRestClient,
  route: R,
  params: ParamsOf<R>,
  opts?: PaginateOptions,
): AsyncGenerator<ResponseOf<R>> {
  // Eager, so a bad `maxPages` fails at the call site rather than on the first `next()` — a
  // generator body does not run until it is iterated, and a deferred argument error is reported
  // against the loop instead of against the mistake.
  const maxPages: number = resolveMaxPages(opts?.maxPages);
  return pages(client, route, params, maxPages, callOptions(opts));
}

async function* pages<R extends RouteDef>(
  client: LighterRestClient,
  route: R,
  params: ParamsOf<R>,
  maxPages: number,
  opts: CallOptions,
): AsyncGenerator<ResponseOf<R>> {
  const base: Record<string, unknown> = toRecord(params);

  // Every cursor already sent, including one the caller resumed from. A `Set` rather than "is it
  // the same as last time" because a server that alternates between two cursors spins just as
  // hard as one that repeats a single one, and the set is bounded by `maxPages` either way.
  const seen: Set<string> = new Set<string>();
  const resumed: unknown = base["cursor"];
  if (typeof resumed === "string" && resumed.length > 0) seen.add(resumed);

  let current: Record<string, unknown> = base;

  for (let fetched: number = 0; fetched < maxPages; fetched += 1) {
    const page: ResponseOf<R> = await client.request(
      route,
      current as unknown as ParamsOf<R>,
      opts,
    );
    yield page;

    const cursor: string | undefined = nextCursor(page);
    if (cursor === undefined) return;
    if (seen.has(cursor)) {
      throw new LighterError(
        "decode",
        `${route.method} ${route.path} returned a cursor it had already returned; iterating ` +
          `further would repeat the same page forever. This is a server-side fault — the ` +
          `collection may have changed underneath the walk`,
        { code: "CURSOR_REPEATED" },
      );
    }
    seen.add(cursor);
    // The request spelling is always `cursor`, whichever key the response used.
    current = { ...base, cursor };
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Item iteration                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Walk a paginated route, yielding its individual records.
 *
 * The collection field is the route's own `itemsKey` (`"trades"`, `"orders"`, `"sub_accounts"`, …),
 * so `ItemOf<typeof routes.trades>` is `Trade` and nothing has to be named twice. A page whose
 * collection is absent — the server omits an empty array — contributes nothing and is not an error.
 *
 * Routes that declare no `itemsKey` are rejected. Those are exactly the responses with more than
 * one plausible collection (`orderBookOrders` has `asks` and `bids`; `orderBookDetails` has a perp
 * and a spot array), where there is no single right answer to flatten to; `ItemOf<R>` is `never`
 * for them, so the call is already a type error at any real call site.
 *
 * @throws {LighterValidationError} the route declares no `itemsKey`
 *   (`code: "ROUTE_NOT_A_COLLECTION"`), or a page's collection field is not an array
 *   (`code: "ITEMS_NOT_AN_ARRAY"`).
 * @throws everything {@link paginate} throws.
 */
export function paginateItems<R extends RouteDef>(
  client: LighterRestClient,
  route: R,
  params: ParamsOf<R>,
  opts?: PaginateOptions,
): AsyncGenerator<ItemOf<R>> {
  const itemsKey: string | undefined = route.itemsKey;
  if (itemsKey === undefined) {
    throw new LighterValidationError(
      "ROUTE_NOT_A_COLLECTION",
      `${route.method} ${route.path} declares no itemsKey, so there is no single collection to ` +
        `flatten to. Use paginate() and read the field you want off each page`,
    );
  }
  const maxPages: number = resolveMaxPages(opts?.maxPages);
  return items(client, route, params, itemsKey, maxPages, callOptions(opts));
}

async function* items<R extends RouteDef>(
  client: LighterRestClient,
  route: R,
  params: ParamsOf<R>,
  itemsKey: string,
  maxPages: number,
  opts: CallOptions,
): AsyncGenerator<ItemOf<R>> {
  for await (const page of pages(client, route, params, maxPages, opts)) {
    const collection: unknown = (page as Record<string, unknown> | null)?.[itemsKey];
    // Absent is the normal empty case: Go's `omitempty` drops an empty slice entirely.
    if (collection === undefined || collection === null) continue;
    if (!Array.isArray(collection)) {
      throw new LighterValidationError(
        "ITEMS_NOT_AN_ARRAY",
        `${route.method} ${route.path} answered with a "${itemsKey}" field that is not an array`,
        { field: itemsKey },
      );
    }
    for (const item of collection as readonly unknown[]) yield item as ItemOf<R>;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Helpers                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

function resolveMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined) return DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new LighterValidationError(
      "MAX_PAGES_INVALID",
      `maxPages must be a positive integer; received ${String(maxPages)}`,
      { field: "maxPages" },
    );
  }
  return maxPages;
}

/** Strip `maxPages` — it is ours, not the transport's — and keep everything else as a per-call override. */
function callOptions(opts: PaginateOptions | undefined): CallOptions {
  if (opts === undefined) return {};
  const { maxPages: _ignored, ...rest } = opts;
  return rest;
}

/**
 * The caller's parameters as a plain record.
 *
 * `ParamsOf<R>` is `unknown` for the two routes that take no parameters at all, and those are not
 * paginated — but the conversion still has to be total, because a generic `R` cannot prove it.
 */
function toRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null) return {};
  return { ...(params as Record<string, unknown>) };
}
