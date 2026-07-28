/**
 * The typed channel registry: a channel is a **value, not a string**.
 *
 * `client.subscribe(channels.orderBook(0))` types everything downstream from what was subscribed to,
 * which is the one decisive API choice in this package (`docs/ARCHITECTURE.md` ADR-7). The reference
 * Python client supports three of these twenty-two channels and hard-codes two of them into
 * constructor callbacks; this file is what makes the other nineteen reachable at all.
 *
 * ## Two spellings, and only one of them lives here
 *
 * Every `key` below is the **outbound, slash-separated** form — `order_book/0`, `candle/0/1m`,
 * `account_orders/3/1234` — which is what a `subscribe` frame carries. The server echoes a *colon*
 * form on the way back (`order_book:0`), except for `account_market`, which echoes slashes, and
 * `account_orders`, which echoes `account_orders:{M}` with the account index missing entirely.
 * Reconciling the two is `src/ws/protocol.ts`'s job (`resolveRouteKey`), and it can only do it
 * because {@link ChannelSpec} carries `marketIndex` and `accountIndex` as structured values rather
 * than leaving them buried in a string.
 *
 * ## Argument order on the two-index channels
 *
 * `accountMarket(market, account)` and `accountMarketOrders(market, account)` — **market first**,
 * matching the keys `account_market/{M}/{A}` and `account_orders/{M}/{A}`. Swapping the arguments
 * produces a syntactically valid key that subscribes to a different thing, and the server accepts it
 * without complaint.
 *
 * ## Parsing does not validate, and does not throw
 *
 * `parseSnapshot` / `parseUpdate` are shape casts. This SDK performs no runtime schema validation
 * (`docs/ARCHITECTURE.md` §2 — the only available schema is known-wrong and would reject valid live
 * responses), so there is nothing to validate against, and a parser that threw would kill a read
 * loop over a field it merely did not recognise. That is defect 6 of the reference client
 * (`docs/protocol-notes.md` §10.2). Consequently:
 *
 * - an unmodelled extra field passes through **untouched** — the object identity is preserved;
 * - a missing optional field reads as `undefined`, never an exception;
 * - `{}`, `null` and a payload of the wrong shape all come back unchanged, cast.
 *
 * Wide integers are **not** rewritten here either. `parseFrameJson` has already quoted any integer
 * over 15 digits before this point (`src/util/json.ts`), so the value is a `number` or a `string`
 * exactly as {@link WireInt} describes, and `wireInt()` converts on read. Rewriting them into
 * `bigint`s here would mean deep-cloning every order-book delta — thousands per second on a busy
 * market — to change fields most consumers never look at, and would break the pass-through
 * guarantee above.
 *
 * ## Evidence status
 *
 * `test/fixtures/ws/capture.json` carries **no frames**: the wave-0 capture was refused at the
 * upgrade from a restricted jurisdiction (API code 20558, `docs/protocol-notes.md` §8.3). Keys, auth
 * flags and payload shapes therefore come from `docs/spec/06-websocket.md` §6.1–§6.2, where most
 * entries are marked `[DOC]` — published, unverified — and §15 lists fifteen open questions. The
 * auth table in particular is `[DOC]`: §15 item 4 records that the documented subscribe examples for
 * `account_all`, `user_stats`, `account_all_trades` and `account_all_positions` omit `auth` and that
 * the reference client proves `account_all` works without one, which may be a documentation omission
 * rather than a policy. That is exactly why `acceptsAuth` exists alongside `requiresAuth`.
 *
 * Side-effect-free at import: no I/O, no timers, no globals mutated, no `node:` import.
 */

import { LighterValidationError } from "../errors.js";
import type {
  AccountAllMessage,
  AccountAllOrdersMessage,
  AccountAllPositionsMessage,
  AccountAllTradesSnapshot,
  AccountAllTradesUpdate,
  AccountAssetsMessage,
  AccountMarketMessage,
  AccountOrdersMessage,
  AccountTxMessage,
  CandleMessage,
  CandleResolution,
  HeightMessage,
  MarkPriceCandleMessage,
  MarketStatsMessage,
  NotificationMessage,
  OrderBookMessage,
  PoolDataMessage,
  PoolInfoMessage,
  RfqMessage,
  SpotAvgEntryMessage,
  SpotMarketStatsMessage,
  TickerMessage,
  TradeMessage,
  UserStatsMessage,
} from "./types.js";

/* -------------------------------------------------------------------------------------------- */
/* The spec                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * One subscribable channel, with the types of what it delivers attached.
 *
 * Two type parameters, not one, because `account_all_trades` genuinely delivers different shapes for
 * its snapshot and its updates: a flat `trades` array plus volume aggregates on subscribe, a
 * market-keyed `trades` map and no aggregates thereafter (`docs/spec/06-websocket.md` §6.2.13).
 * Every other channel instantiates both parameters with the same type, which costs nothing and keeps
 * the asymmetry expressible where it is real.
 */
export interface ChannelSpec<Snapshot, Update> {
  /** The channel family, with no index: `"order_book"`, `"account_all_assets"`. Matches the `type` suffix. */
  readonly family: string;
  /** The **outbound**, slash-separated subscribe key: `"order_book/0"`, `"candle/0/1m"`. */
  readonly key: string;
  /** The server rejects a subscribe without a token. */
  readonly requiresAuth: boolean;
  /**
   * Attach a token whenever the caller has one.
   *
   * True for every `account_*`, `user_stats`, `pool_*`, `notification` and `rfq` channel, including
   * those that work without one today. The server ignores a superfluous `auth`, so attaching one
   * costs nothing and survives the server tightening its policy — which §15 item 4 flags as an open
   * question, not a settled fact.
   */
  readonly acceptsAuth: boolean;
  /**
   * The account this subscription belongs to, when it has one.
   *
   * Carried structurally because for `account_all_assets` the inbound frame has **no `account`
   * field at all** — the index exists only inside the `channel` string — and for `account_orders`
   * the inbound `channel` omits it instead. Both are unrecoverable without this.
   */
  readonly accountIndex?: number;
  /** The market this subscription belongs to, when it has one. Absent for the `all` wildcard. */
  readonly marketIndex?: number;
  /** Cast a `subscribed/*` payload. Never validates, never throws. */
  parseSnapshot(raw: unknown): Snapshot;
  /** Cast an `update/*` payload. Never validates, never throws. */
  parseUpdate(raw: unknown): Update;
}

/* -------------------------------------------------------------------------------------------- */
/* Construction                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Reject an index that could never name a real market or account.
 *
 * This is caller-facing argument checking, not wire parsing — the distinction matters, because wire
 * parsing must never throw and this must. `channels.orderBook(1.5)` would otherwise build the key
 * `order_book/1.5`, which the server answers with a bare 30005 that names nothing.
 *
 * Only a lower bound is enforced. **Spot markets start at index 2048** while perps are low indices
 * (`docs/spec/06-websocket.md` §6, `[REF]`), and account indices reach into the sub-account range
 * above 2^47, so any upper bound invented here would eventually be wrong.
 *
 * @throws {LighterValidationError} `WS_CHANNEL_INDEX_INVALID`
 */
function checkIndex(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LighterValidationError(
      "WS_CHANNEL_INDEX_INVALID",
      `${what} must be a non-negative safe integer, got ${String(value)}`,
      { field: what },
    );
  }
  return value;
}

/** The eight accepted candle bucket widths, as data. Frozen; not a side effect. */
const CANDLE_RESOLUTIONS: ReadonlySet<string> = new Set<string>([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
]);

/**
 * Reject a resolution the candle channels do not accept.
 *
 * The type union already covers TypeScript callers; this catches the JavaScript ones and, more
 * usefully, a value that came from configuration. The REST `/candles` endpoint additionally accepts
 * `1w` and `/pnl` accepts a different set again, so a string that is valid *somewhere* in this API is
 * not evidence that it is valid here.
 *
 * @throws {LighterValidationError} `WS_CANDLE_RESOLUTION_INVALID`
 */
function checkResolution(r: CandleResolution): CandleResolution {
  if (!CANDLE_RESOLUTIONS.has(r)) {
    throw new LighterValidationError(
      "WS_CANDLE_RESOLUTION_INVALID",
      `unsupported candle resolution: ${JSON.stringify(r)}`,
      { field: "resolution" },
    );
  }
  return r;
}

/**
 * Build one spec.
 *
 * `marketIndex` and `accountIndex` are omitted from the object entirely when absent rather than set
 * to `undefined`, which `exactOptionalPropertyTypes` requires and which also makes
 * `"accountIndex" in spec` a truthful test.
 *
 * The result is frozen. A spec is a value that gets passed around, stored in the client's desired-
 * subscription table and compared after a reconnect; a mutated `key` would silently resubscribe to
 * something else.
 */
function makeSpec<Snapshot, Update>(
  family: string,
  key: string,
  requiresAuth: boolean,
  acceptsAuth: boolean,
  marketIndex?: number,
  accountIndex?: number,
): ChannelSpec<Snapshot, Update> {
  const spec: {
    family: string;
    key: string;
    requiresAuth: boolean;
    acceptsAuth: boolean;
    marketIndex?: number;
    accountIndex?: number;
    parseSnapshot(raw: unknown): Snapshot;
    parseUpdate(raw: unknown): Update;
  } = {
    family,
    key,
    requiresAuth,
    acceptsAuth,
    parseSnapshot: (raw: unknown): Snapshot => raw as Snapshot,
    parseUpdate: (raw: unknown): Update => raw as Update,
  };
  if (marketIndex !== undefined) spec.marketIndex = marketIndex;
  if (accountIndex !== undefined) spec.accountIndex = accountIndex;
  return Object.freeze(spec);
}

/** A market key segment: the index, or the literal `all` wildcard. */
function marketSegment(m: number | "all"): string {
  return m === "all" ? "all" : String(checkIndex(m, "market"));
}

/** The market index of a wildcard-capable channel, or `undefined` for `all`. */
function marketIndexOf(m: number | "all"): number | undefined {
  return m === "all" ? undefined : m;
}

/* -------------------------------------------------------------------------------------------- */
/* The registry                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * All 22 channels (`docs/spec/06-websocket.md` §6.1).
 *
 * Ordered as the spec's table is: public market data first, then the account and pool channels that
 * take a token. The count is asserted by a test — a channel added here without a payload interface,
 * or an interface added without a factory, is the failure mode this registry exists to prevent.
 */
export const channels = {
  /** `order_book/{M}` — the only channel with true delta semantics. Public. */
  orderBook(m: number): ChannelSpec<OrderBookMessage, OrderBookMessage> {
    return makeSpec("order_book", `order_book/${checkIndex(m, "market")}`, false, false, m);
  },

  /** `ticker/{M}` — best bid and offer, complete replacement each frame. Public. */
  ticker(m: number): ChannelSpec<TickerMessage, TickerMessage> {
    return makeSpec("ticker", `ticker/${checkIndex(m, "market")}`, false, false, m);
  },

  /**
   * `trade/{M}` — executions. Public.
   *
   * Note the family is singular (`trade`) while the payload key is plural (`trades`), and that
   * liquidations arrive in a separate `liquidation_trades` array.
   */
  trades(m: number): ChannelSpec<TradeMessage, TradeMessage> {
    return makeSpec("trade", `trade/${checkIndex(m, "market")}`, false, false, m);
  },

  /**
   * `market_stats/{M}` or `market_stats/all` — perp market statistics. Public.
   *
   * With `all`, `marketIndex` is absent and the server's fan-out shape is undocumented
   * (§15 item 6); `resolveRouteKey` routes the per-market echoes back to the single `all`
   * subscription.
   */
  marketStats(m: number | "all"): ChannelSpec<MarketStatsMessage, MarketStatsMessage> {
    return makeSpec(
      "market_stats",
      `market_stats/${marketSegment(m)}`,
      false,
      false,
      marketIndexOf(m),
    );
  },

  /** `spot_market_stats/{M}` or `/all` — spot statistics. Spot indices start at 2048. Public. */
  spotMarketStats(m: number | "all"): ChannelSpec<SpotMarketStatsMessage, SpotMarketStatsMessage> {
    return makeSpec(
      "spot_market_stats",
      `spot_market_stats/${marketSegment(m)}`,
      false,
      false,
      marketIndexOf(m),
    );
  },

  /** `candle/{M}/{R}` — OHLCV buckets. Public; no candle-family channel takes auth. */
  candles(m: number, r: CandleResolution): ChannelSpec<CandleMessage, CandleMessage> {
    return makeSpec(
      "candle",
      `candle/${checkIndex(m, "market")}/${checkResolution(r)}`,
      false,
      false,
      m,
    );
  },

  /** `mark_price_candle/{M}/{R}` — mark-price OHLC plus a sample count. Public. */
  markPriceCandles(
    m: number,
    r: CandleResolution,
  ): ChannelSpec<MarkPriceCandleMessage, MarkPriceCandleMessage> {
    return makeSpec(
      "mark_price_candle",
      `mark_price_candle/${checkIndex(m, "market")}/${checkResolution(r)}`,
      false,
      false,
      m,
    );
  },

  /** `height` — block height. No index, in the key or the echo. Public. */
  height(): ChannelSpec<HeightMessage, HeightMessage> {
    return makeSpec("height", "height", false, false);
  },

  /**
   * `account_all/{A}` — the fattest account channel.
   *
   * Works without a token (the reference client proves it, `[REF]`), so `requiresAuth` is false —
   * but `acceptsAuth` is true, because §15 item 4 leaves open whether that is policy or a
   * documentation omission.
   */
  accountAll(a: number): ChannelSpec<AccountAllMessage, AccountAllMessage> {
    return makeSpec(
      "account_all",
      `account_all/${checkIndex(a, "account")}`,
      false,
      true,
      undefined,
      a,
    );
  },

  /**
   * `account_market/{M}/{A}` — one account in one market. **Market first.** Requires auth.
   *
   * The one channel whose inbound `channel` echoes slashes rather than colons.
   */
  accountMarket(m: number, a: number): ChannelSpec<AccountMarketMessage, AccountMarketMessage> {
    return makeSpec(
      "account_market",
      `account_market/${checkIndex(m, "market")}/${checkIndex(a, "account")}`,
      true,
      true,
      m,
      a,
    );
  },

  /** `user_stats/{A}` — margin and portfolio figures. Token attached when available. */
  accountStats(a: number): ChannelSpec<UserStatsMessage, UserStatsMessage> {
    return makeSpec("user_stats", `user_stats/${checkIndex(a, "account")}`, false, true, undefined, a);
  },

  /** `account_tx/{A}` — transaction lifecycle. Requires auth. */
  accountTxs(a: number): ChannelSpec<AccountTxMessage, AccountTxMessage> {
    return makeSpec("account_tx", `account_tx/${checkIndex(a, "account")}`, true, true, undefined, a);
  },

  /** `account_all_orders/{A}` — every open order, keyed by market. Requires auth. */
  accountOrders(a: number): ChannelSpec<AccountAllOrdersMessage, AccountAllOrdersMessage> {
    return makeSpec(
      "account_all_orders",
      `account_all_orders/${checkIndex(a, "account")}`,
      true,
      true,
      undefined,
      a,
    );
  },

  /**
   * `account_orders/{M}/{A}` — one market's orders. **Market first.** Requires auth.
   *
   * Its inbound `channel` is `account_orders:{M}` — the account index is missing entirely and
   * arrives in a sibling `account` field. Both indices are populated on the spec so
   * `resolveRouteKey` can rebuild the full key from the family plus that field.
   */
  accountMarketOrders(m: number, a: number): ChannelSpec<AccountOrdersMessage, AccountOrdersMessage> {
    return makeSpec(
      "account_orders",
      `account_orders/${checkIndex(m, "market")}/${checkIndex(a, "account")}`,
      true,
      true,
      m,
      a,
    );
  },

  /**
   * `account_all_trades/{A}` — the one channel whose snapshot and update shapes genuinely differ.
   *
   * Snapshot: `trades` is a flat array, plus four volume aggregates. Update: `trades` is a
   * market-keyed map and the aggregates are absent. Hence the two distinct type arguments.
   */
  accountTrades(a: number): ChannelSpec<AccountAllTradesSnapshot, AccountAllTradesUpdate> {
    return makeSpec(
      "account_all_trades",
      `account_all_trades/${checkIndex(a, "account")}`,
      false,
      true,
      undefined,
      a,
    );
  },

  /** `account_all_positions/{A}` — positions plus pool shares as an **array**. */
  accountPositions(
    a: number,
  ): ChannelSpec<AccountAllPositionsMessage, AccountAllPositionsMessage> {
    return makeSpec(
      "account_all_positions",
      `account_all_positions/${checkIndex(a, "account")}`,
      false,
      true,
      undefined,
      a,
    );
  },

  /**
   * `account_all_assets/{A}` — per-asset balances. Requires auth.
   *
   * The payload carries **no `account` field**: the index survives only on this spec and in the
   * `channel` string. {@link AccountAssetsState} is constructed with it for exactly that reason.
   */
  accountAssets(a: number): ChannelSpec<AccountAssetsMessage, AccountAssetsMessage> {
    return makeSpec(
      "account_all_assets",
      `account_all_assets/${checkIndex(a, "account")}`,
      true,
      true,
      undefined,
      a,
    );
  },

  /** `account_spot_avg_entry_prices/{A}` — spot cost basis per asset. Requires auth. */
  accountSpotAvgEntry(a: number): ChannelSpec<SpotAvgEntryMessage, SpotAvgEntryMessage> {
    return makeSpec(
      "account_spot_avg_entry_prices",
      `account_spot_avg_entry_prices/${checkIndex(a, "account")}`,
      true,
      true,
      undefined,
      a,
    );
  },

  /** `pool_data/{A}` — a public pool's live trading state. Requires auth. */
  poolData(a: number): ChannelSpec<PoolDataMessage, PoolDataMessage> {
    return makeSpec("pool_data", `pool_data/${checkIndex(a, "account")}`, true, true, undefined, a);
  },

  /** `pool_info/{A}` — a public pool's configuration and performance series. Requires auth. */
  poolInfo(a: number): ChannelSpec<PoolInfoMessage, PoolInfoMessage> {
    return makeSpec("pool_info", `pool_info/${checkIndex(a, "account")}`, true, true, undefined, a);
  },

  /** `notification/{A}` — liquidation and deleverage notices. Requires auth. Ack is REST-only. */
  notifications(a: number): ChannelSpec<NotificationMessage, NotificationMessage> {
    return makeSpec(
      "notification",
      `notification/${checkIndex(a, "account")}`,
      true,
      true,
      undefined,
      a,
    );
  },

  /** `rfq` — requests for quote. No index; requires auth. */
  rfq(): ChannelSpec<RfqMessage, RfqMessage> {
    return makeSpec("rfq", "rfq", true, true);
  },
} as const;

/** The name of every factory on {@link channels}. Useful for exhaustive iteration in tests and tools. */
export type ChannelName = keyof typeof channels;
