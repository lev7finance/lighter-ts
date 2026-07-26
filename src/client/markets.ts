/**
 * The market registry: the table that decides what magnitude an order is submitted at.
 *
 * An order's wire `base_amount` is `size × 10^supported_size_decimals` and its wire `price` is
 * `price × 10^supported_price_decimals`. Those exponents differ per market — there are ~227 of
 * them — and there is no safe default, so a lookup that misses **throws** rather than guessing
 * (`spec/07-high-level-client.md` §8.2). A guessed exponent is a wrong-magnitude order, which is
 * strictly worse than an error.
 *
 * Three things here are load-bearing and easy to lose:
 *
 * 1. **Nothing monetary passes through `Number`.** `min_base_amount`, `min_quote_amount`,
 *    `order_quote_limit`, the fees and `mark_price`/`index_price` arrive as decimal strings and
 *    stay decimal strings (`docs/decisions.md` D7, `docs/protocol-notes.md` §8.4). Only the
 *    exponents themselves are numbers, and they are typed {@link Decimals} to say so out loud.
 * 2. **The cross-scale invariant is checked, recorded, and not assumed.** Quote-sized ordering is
 *    dimensionally correct only when `priceDecimals + sizeDecimals === quoteDecimals` (ETH-PERP:
 *    2 + 4 = 6 = micro-USDC). The reference assumes it (`§11` defect 14); here it is evaluated per
 *    market into {@link MarketInfo.quoteSizingSupported}. A market that violates it still loads —
 *    refusing the whole registry over one market would take the exchange down for every other
 *    market — and the order-math layer refuses that market alone.
 * 3. **A bare symbol can be ambiguous.** Perps occupy market ids `0…254` and spot `2048…4094`, and
 *    the same symbol may exist on both. `get('ETH')` never silently picks one: it throws naming
 *    both candidates, and `get({ symbol: 'ETH', type: 'perp' })` or `get(0)` disambiguates.
 *
 * `multiplier` and `quote_multiplier` are undocumented (risk R21) and look exactly like scaling
 * factors. They are carried through raw and verbatim and folded into nothing.
 *
 * No module-level mutable state (`docs/decisions.md` D8). Importing this module performs no I/O,
 * schedules no timer and reads no clock.
 */

import type { Diagnostic } from "../config/config.js";
import { LighterConfigError } from "../errors.js";
import type { MarketKind, MarketStatus } from "../models/common.js";
import type {
  MarketConfig,
  OrderBook,
  OrderBookDetails,
  OrderBooks,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
} from "../models/market.js";
import type { CallOptions, LighterRestClient } from "../rest/client.js";
import { parseDecimal } from "../util/decimal.js";
import type {
  AssetInfo,
  AssetSnapshot,
  Decimals,
  LoadOptions,
  RegistryOptions,
} from "./assets.js";
import { AssetRegistry, DEFAULT_METADATA_TTL_MS } from "./assets.js";

/* -------------------------------------------------------------------------------------------- */
/* Protocol constants                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `NilMarketIndex` — "all markets" for cancel-all, and never a market
 * (`spec/07-high-level-client.md` §1.5). `get(255)` therefore always throws.
 */
export const NIL_MARKET_INDEX: 255 = 255;

/** `MinPerpsMarketIndex` / `MaxPerpsMarketIndex` (§1.6). */
export const PERPS_MARKET_INDEX_RANGE: readonly [number, number] = Object.freeze([0, 254]);

/** `MinSpotMarketIndex` / `MaxSpotMarketIndex` (§1.6). */
export const SPOT_MARKET_INDEX_RANGE: readonly [number, number] = Object.freeze([2048, 4094]);

const MAX_DECIMALS: 36 = 36;

/* -------------------------------------------------------------------------------------------- */
/* MarketInfo                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** `market_config`, normalised. Tradability and liquidation policy for one perpetual market. */
export interface MarketConfigInfo {
  readonly marketMarginMode?: number;
  /**
   * `281474976710655` (2^48−1) is the sentinel for **"no insurance fund"**, not an account that
   * exists. Do not resolve it as an account index.
   */
  readonly insuranceFundAccountIndex?: number;
  readonly liquidationMode?: number;
  readonly forceReduceOnly: boolean;
  readonly fundingFeeDiscountsEnabled: boolean;
  /** `""` means 24/7. Non-empty for RWA and equity markets. */
  readonly tradingHours: string;
  readonly hidden: boolean;
  readonly rfqEnabled: boolean;
}

/**
 * Perpetual-only detail, present when the registry loaded from `/orderBookDetails`.
 *
 * **Margin fractions are basis points**: `500` is 5%, i.e. 20× leverage, and
 * `leverage = 10000 / fraction`. They are counts, not money.
 */
export interface PerpsMarketInfo {
  /** Basis points. `500` = 5% = 20× leverage. */
  readonly defaultInitialMarginFraction?: number;
  /** Basis points. `200` = 2% = 50× maximum leverage. */
  readonly minInitialMarginFraction?: number;
  /** Basis points. */
  readonly maintenanceMarginFraction?: number;
  /** Basis points. */
  readonly closeoutMarginFraction?: number;
  /**
   * The liquidation basis at load time, decimal string.
   *
   * A cached quote with a five-minute TTL. It is here because §8.1 lists it as bootstrap data for
   * risk display — it is not a live price and must not be used as one.
   */
  readonly markPrice?: string;
  /** The oracle price at load time, decimal string. Same caveat as {@link markPrice}. */
  readonly indexPrice?: string;
  /** Undocumented, risk R21. Raw and verbatim; folded into no conversion. */
  readonly quoteMultiplier?: number;
  readonly marketConfig?: MarketConfigInfo;
  readonly strategyIndex?: number;
  /** Bitfield; semantics undocumented. Live-only field, absent from the OpenAPI document. */
  readonly marketFlags?: number;
  readonly fundingPremiumMultiplier?: number;
  /** Decimal string, e.g. `"0.0500"`. */
  readonly fundingClampSmall?: string;
  /** Decimal string, e.g. `"4.0000"`. */
  readonly fundingClampBig?: string;
  /** Decimal string, e.g. `"0.0100"`. */
  readonly baseInterestRate?: string;
}

/**
 * One market, normalised. Everything the sizing layer needs and nothing float-derived.
 *
 * The daily statistics the wire also carries (`last_trade_price`, `daily_*`, `open_interest`) are
 * deliberately **not** here: they are JSON numbers on the wire, they change by the second, and
 * caching them for five minutes behind a name that reads like a price is how a stale float ends up
 * in an order. Read those from the ticker or the order book.
 */
export interface MarketInfo {
  /** The index used in every other call **and in transaction signing**. Never {@link NIL_MARKET_INDEX}. */
  readonly marketId: number;
  /** e.g. `"ETH"`. Not unique on its own — see the class doc on ambiguity. */
  readonly symbol: string;
  readonly marketType: MarketKind;
  readonly status: MarketStatus;
  /** `supported_size_decimals`. Scaling exponent for an order's integer `base_amount`. */
  readonly sizeDecimals: Decimals;
  /** `supported_price_decimals`. Scaling exponent for an order's integer `price`. */
  readonly priceDecimals: Decimals;
  /** `supported_quote_decimals`. Scaling exponent for a notional. */
  readonly quoteDecimals: Decimals;
  /** Decimal string, exactly as the wire sent it. */
  readonly minBaseAmount: string;
  /** Decimal string, exactly as the wire sent it. */
  readonly minQuoteAmount: string;
  /** Decimal string, exactly as the wire sent it. */
  readonly orderQuoteLimit: string;
  /** Percent, decimal string, e.g. `"0.0000"`. */
  readonly takerFee: string;
  /** Percent, decimal string. */
  readonly makerFee: string;
  readonly isTakerFeeEnabled: boolean;
  readonly isMakerFeeEnabled: boolean;
  readonly baseAssetId: number;
  readonly quoteAssetId: number;
  /**
   * `false` when `priceDecimals + sizeDecimals !== quoteDecimals`.
   *
   * Quote-sized orders (`floor(quoteInt / avgPrice)`) are dimensionally correct only when it
   * holds; where it does not, the order-math layer must refuse **this market** rather than emit an
   * order off by a power of ten (`spec/07-high-level-client.md` §3.6, open question #4).
   */
  readonly quoteSizingSupported: boolean;
  /** Percent, decimal string, e.g. `"1.0000"`. */
  readonly liquidationFee?: string;
  /** Epoch **milliseconds held in a string**. It looks like a number field and is not. */
  readonly createdAt?: string;
  /** Undocumented, risk R21. Raw and verbatim; folded into no conversion. */
  readonly multiplier?: string;
  /** Present when loaded from `/orderBookDetails` and this is a perpetual market. */
  readonly perps?: PerpsMarketInfo;
}

/**
 * A serialisable, versioned {@link MarketRegistry}.
 *
 * JSON-safe by construction: no `bigint`, no `undefined` holes, `null` rather than a missing key
 * for "never loaded". `JSON.parse(JSON.stringify(snapshot))` is deep-equal to `snapshot`.
 */
export interface MarketSnapshot {
  readonly version: 1;
  /** Epoch milliseconds of the load this snapshot came from, or `null`. */
  readonly loadedAt: number | null;
  readonly markets: readonly MarketInfo[];
  readonly assets: AssetSnapshot;
}

/** How to name a market: an id, a bare symbol, or a symbol qualified by market type. */
export type MarketQuery = number | string | { readonly symbol: string; readonly type?: MarketKind };

/** `list()` filter. */
export interface MarketFilter {
  readonly type?: MarketKind;
}

/* -------------------------------------------------------------------------------------------- */
/* Ingest                                                                                         */
/* -------------------------------------------------------------------------------------------- */

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "object") return "[object]";
  return String(v);
}

function requireInt(v: unknown, field: string, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new LighterConfigError(`${where}: \`${field}\` is missing or not an integer (${describe(v)})`);
  }
  return v;
}

function optionalInt(v: unknown, field: string, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return requireInt(v, field, where);
}

function requireDecimals(v: unknown, field: string, where: string): Decimals {
  const n: number = requireInt(v, field, where);
  if (n < 0 || n > MAX_DECIMALS) {
    throw new LighterConfigError(
      `${where}: \`${field}\` out of range (${String(n)}, expected 0..${String(MAX_DECIMALS)})`,
    );
  }
  return n;
}

function requireDecimalString(v: unknown, field: string, where: string): string {
  if (typeof v !== "string") {
    throw new LighterConfigError(`${where}: \`${field}\` is missing or not a string (${describe(v)})`);
  }
  try {
    parseDecimal(v);
  } catch {
    throw new LighterConfigError(`${where}: \`${field}\` is not a plain decimal string (${describe(v)})`);
  }
  return v;
}

function optionalDecimalString(v: unknown, field: string, where: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return requireDecimalString(v, field, where);
}

/** Absent booleans are Go's `omitempty` erasing `false`, which is exactly what `false` means here. */
function optionalBool(v: unknown): boolean {
  return v === true;
}

function requireStatus(v: unknown, where: string): MarketStatus {
  if (v === "active" || v === "inactive") return v;
  throw new LighterConfigError(`${where}: \`status\` is missing or unrecognised (${describe(v)})`);
}

/** The market kind, from the field when it is usable and from the id range when it is not. */
function resolveKind(raw: OrderBook, marketId: number, hint: MarketKind | undefined, where: string): MarketKind {
  if (raw.market_type === "perp" || raw.market_type === "spot") return raw.market_type;
  if (hint !== undefined) return hint;
  if (marketId >= SPOT_MARKET_INDEX_RANGE[0] && marketId <= SPOT_MARKET_INDEX_RANGE[1]) return "spot";
  if (marketId <= PERPS_MARKET_INDEX_RANGE[1]) return "perp";
  throw new LighterConfigError(
    `${where}: \`market_type\` is missing and market id ${String(marketId)} is in no known index range`,
  );
}

/** `market_config`, when present. Every field optional; absence of a boolean means `false`. */
function toMarketConfigInfo(raw: MarketConfig): MarketConfigInfo {
  const marketMarginMode: number | undefined = optionalInt(raw.market_margin_mode, "market_margin_mode", "market_config");
  const insurance: number | undefined = optionalInt(
    raw.insurance_fund_account_index,
    "insurance_fund_account_index",
    "market_config",
  );
  const liquidationMode: number | undefined = optionalInt(raw.liquidation_mode, "liquidation_mode", "market_config");
  return Object.freeze({
    ...(marketMarginMode !== undefined ? { marketMarginMode } : {}),
    ...(insurance !== undefined ? { insuranceFundAccountIndex: insurance } : {}),
    ...(liquidationMode !== undefined ? { liquidationMode } : {}),
    forceReduceOnly: optionalBool(raw.force_reduce_only),
    fundingFeeDiscountsEnabled: optionalBool(raw.funding_fee_discounts_enabled),
    tradingHours: typeof raw.trading_hours === "string" ? raw.trading_hours : "",
    hidden: optionalBool(raw.hidden),
    rfqEnabled: optionalBool(raw.rfq_enabled),
  });
}

/** The perps-only half of `/orderBookDetails`. Every field validated-if-present, omitted otherwise. */
function toPerpsMarketInfo(raw: PerpsOrderBookDetail, where: string): PerpsMarketInfo {
  const dimf: number | undefined = optionalInt(raw.default_initial_margin_fraction, "default_initial_margin_fraction", where);
  const mimf: number | undefined = optionalInt(raw.min_initial_margin_fraction, "min_initial_margin_fraction", where);
  const mmf: number | undefined = optionalInt(raw.maintenance_margin_fraction, "maintenance_margin_fraction", where);
  const cmf: number | undefined = optionalInt(raw.closeout_margin_fraction, "closeout_margin_fraction", where);
  const markPrice: string | undefined = optionalDecimalString(raw.mark_price, "mark_price", where);
  const indexPrice: string | undefined = optionalDecimalString(raw.index_price, "index_price", where);
  const quoteMultiplier: number | undefined = optionalInt(raw.quote_multiplier, "quote_multiplier", where);
  const strategyIndex: number | undefined = optionalInt(raw.strategy_index, "strategy_index", where);
  const marketFlags: number | undefined = optionalInt(raw.market_flags, "market_flags", where);
  const fundingPremiumMultiplier: number | undefined = optionalInt(
    raw.funding_premium_multiplier,
    "funding_premium_multiplier",
    where,
  );
  const fundingClampSmall: string | undefined = optionalDecimalString(raw.funding_clamp_small, "funding_clamp_small", where);
  const fundingClampBig: string | undefined = optionalDecimalString(raw.funding_clamp_big, "funding_clamp_big", where);
  const baseInterestRate: string | undefined = optionalDecimalString(raw.base_interest_rate, "base_interest_rate", where);
  return Object.freeze({
    ...(dimf !== undefined ? { defaultInitialMarginFraction: dimf } : {}),
    ...(mimf !== undefined ? { minInitialMarginFraction: mimf } : {}),
    ...(mmf !== undefined ? { maintenanceMarginFraction: mmf } : {}),
    ...(cmf !== undefined ? { closeoutMarginFraction: cmf } : {}),
    ...(markPrice !== undefined ? { markPrice } : {}),
    ...(indexPrice !== undefined ? { indexPrice } : {}),
    ...(quoteMultiplier !== undefined ? { quoteMultiplier } : {}),
    ...(raw.market_config !== undefined && raw.market_config !== null
      ? { marketConfig: toMarketConfigInfo(raw.market_config) }
      : {}),
    ...(strategyIndex !== undefined ? { strategyIndex } : {}),
    ...(marketFlags !== undefined ? { marketFlags } : {}),
    ...(fundingPremiumMultiplier !== undefined ? { fundingPremiumMultiplier } : {}),
    ...(fundingClampSmall !== undefined ? { fundingClampSmall } : {}),
    ...(fundingClampBig !== undefined ? { fundingClampBig } : {}),
    ...(baseInterestRate !== undefined ? { baseInterestRate } : {}),
  });
}

/**
 * Normalise one wire market.
 *
 * `kindHint` is what the containing collection implies — `/orderBookDetails` splits perps and spot
 * into two arrays, so the kind is known even if the field is absent. `withPerps` is set only for
 * the perps array of that endpoint; `/orderBooks` carries no perps detail at all.
 *
 * Throws {@link LighterConfigError} naming the market on any missing or malformed required field.
 * The one thing it will **not** throw for is the cross-scale invariant: that is recorded in
 * {@link MarketInfo.quoteSizingSupported} so one odd market cannot take the registry down.
 */
export function toMarketInfo(raw: OrderBook, kindHint?: MarketKind, withPerps: boolean = false): MarketInfo {
  const idHint: string = raw.market_id === undefined ? (raw.symbol ?? "?") : String(raw.market_id);
  const where: string = `market ${idHint}`;
  const marketId: number = requireInt(raw.market_id, "market_id", where);
  if (marketId === NIL_MARKET_INDEX) {
    throw new LighterConfigError(
      `market ${String(NIL_MARKET_INDEX)}: NilMarketIndex is the cancel-all sentinel, never a market`,
    );
  }
  if (marketId < 0) throw new LighterConfigError(`${where}: negative market id`);

  const sizeDecimals: Decimals = requireDecimals(raw.supported_size_decimals, "supported_size_decimals", where);
  const priceDecimals: Decimals = requireDecimals(raw.supported_price_decimals, "supported_price_decimals", where);
  const quoteDecimals: Decimals = requireDecimals(raw.supported_quote_decimals, "supported_quote_decimals", where);

  const liquidationFee: string | undefined = optionalDecimalString(raw.liquidation_fee, "liquidation_fee", where);
  const multiplier: string | undefined = optionalDecimalString(raw.multiplier, "multiplier", where);

  if (typeof raw.symbol !== "string" || raw.symbol.length === 0) {
    throw new LighterConfigError(`${where}: \`symbol\` is missing or empty (${describe(raw.symbol)})`);
  }

  return Object.freeze({
    marketId,
    symbol: raw.symbol,
    marketType: resolveKind(raw, marketId, kindHint, where),
    status: requireStatus(raw.status, where),
    sizeDecimals,
    priceDecimals,
    quoteDecimals,
    minBaseAmount: requireDecimalString(raw.min_base_amount, "min_base_amount", where),
    minQuoteAmount: requireDecimalString(raw.min_quote_amount, "min_quote_amount", where),
    orderQuoteLimit: requireDecimalString(raw.order_quote_limit, "order_quote_limit", where),
    takerFee: requireDecimalString(raw.taker_fee, "taker_fee", where),
    makerFee: requireDecimalString(raw.maker_fee, "maker_fee", where),
    isTakerFeeEnabled: optionalBool(raw.is_taker_fee_enabled),
    isMakerFeeEnabled: optionalBool(raw.is_maker_fee_enabled),
    baseAssetId: requireInt(raw.base_asset_id, "base_asset_id", where),
    quoteAssetId: requireInt(raw.quote_asset_id, "quote_asset_id", where),
    quoteSizingSupported: priceDecimals + sizeDecimals === quoteDecimals,
    ...(liquidationFee !== undefined ? { liquidationFee } : {}),
    // Epoch milliseconds in a *string*. Left as the string it is.
    ...(typeof raw.created_at === "string" && raw.created_at.length > 0 ? { createdAt: raw.created_at } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(withPerps ? { perps: toPerpsMarketInfo(raw as PerpsOrderBookDetail, where) } : {}),
  });
}

/* -------------------------------------------------------------------------------------------- */
/* The registry                                                                                   */
/* -------------------------------------------------------------------------------------------- */

function symbolKey(s: string): string {
  return s.toUpperCase();
}

/** One symbol index per market kind, because the same symbol legitimately exists on both. */
interface SymbolIndex {
  readonly perp: Map<string, MarketInfo[]>;
  readonly spot: Map<string, MarketInfo[]>;
}

function emptySymbolIndex(): SymbolIndex {
  return { perp: new Map<string, MarketInfo[]>(), spot: new Map<string, MarketInfo[]>() };
}

/**
 * `market_id`/`symbol → MarketInfo`, cached on the instance, plus the {@link AssetRegistry} it owns.
 *
 * Caching policy (`spec/07-high-level-client.md` §8.2):
 *
 * - Fetch once, cache, default TTL five minutes.
 * - A TTL expiry **never blocks a call**. `get()` on stale data returns the stale value and
 *   schedules a background refresh; `stale` is public so a strategy can decide for itself. A failed
 *   background refresh is a diagnostic, not a thrown error.
 * - `load()` is idempotent and concurrency-safe: two overlapping calls share one in-flight promise
 *   and therefore issue exactly one request per endpoint.
 * - Refreshes use `setTimeout`/`clearTimeout` only, never `setInterval`, and {@link stop} leaves no
 *   timer scheduled — Durable Object hibernation depends on that.
 * - Nothing else is cached here. Order books, balances and nonces are never served stale.
 */
export class MarketRegistry {
  #rest: LighterRestClient | undefined;
  readonly #ttlMs: number;
  readonly #nowFn: (() => number) | undefined;
  readonly #sink: ((d: Diagnostic) => void) | undefined;
  readonly #assets: AssetRegistry;

  #byId: Map<number, MarketInfo> = new Map<number, MarketInfo>();
  #bySymbol: SymbolIndex = emptySymbolIndex();
  #ordered: readonly MarketInfo[] = Object.freeze([]);
  #loadedAt: number | undefined;

  #inflight: Promise<void> | undefined;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #stopped: boolean = false;

  constructor(opts?: RegistryOptions) {
    this.#rest = opts?.rest;
    this.#ttlMs = opts?.ttlMs ?? DEFAULT_METADATA_TTL_MS;
    this.#nowFn = opts?.now;
    this.#sink = opts?.onDiagnostic;
    this.#assets = new AssetRegistry(opts);
  }

  /**
   * Build a fully usable registry from a build-time snapshot. **Synchronous, zero I/O**, and it
   * needs no transport — that is the entire point, and it is the single largest cold-start win on
   * Cloudflare Workers (§8.2). Attach a transport later with {@link setTransport} if the process
   * wants to revalidate out of band.
   */
  static fromSnapshot(snapshot: MarketSnapshot, opts?: RegistryOptions): MarketRegistry {
    const registry: MarketRegistry = new MarketRegistry(opts);
    registry.#restore(snapshot);
    return registry;
  }

  /** The asset table this registry owns. Shares its clock, TTL and diagnostics sink. */
  get assets(): AssetRegistry {
    return this.#assets;
  }

  /** Attach a transport after construction — `LighterClient` is built after its registry. */
  setTransport(rest: LighterRestClient): void {
    this.#rest = rest;
    this.#assets.setTransport(rest);
  }

  /** JSON-safe and versioned. `JSON.parse(JSON.stringify(s))` round-trips deep-equal. */
  toSnapshot(): MarketSnapshot {
    return Object.freeze({
      version: 1 as const,
      loadedAt: this.#loadedAt ?? null,
      markets: this.#ordered,
      assets: this.#assets.toSnapshot(),
    });
  }

  /** Epoch milliseconds of the last successful load, or `undefined` if there has never been one. */
  get loadedAt(): number | undefined {
    return this.#loadedAt;
  }

  /** `true` before the first load, and once `now() - loadedAt > ttlMs`. */
  get stale(): boolean {
    if (this.#loadedAt === undefined) return true;
    return this.#now() - this.#loadedAt > this.#ttlMs;
  }

  /** `true` while a background refresh timer is pending. Test seam and disposal check. */
  get refreshScheduled(): boolean {
    return this.#timer !== undefined || this.#assets.refreshScheduled;
  }

  /**
   * Fetch and cache market metadata and the asset table.
   *
   * A no-op when a fresh copy is already present and `force` is not set. Two overlapping calls
   * share one in-flight promise, so exactly one request goes out per endpoint.
   *
   * Freshness is judged for the two tables **separately**. A snapshot can legitimately carry fresh
   * markets and no assets at all; a single combined check would then report the whole registry
   * loaded and leave `asset()` permanently empty.
   */
  load(opts?: LoadOptions): Promise<void> {
    if (opts?.force !== true && !this.#marketsNeedLoad() && !this.#assetsNeedLoad()) return Promise.resolve();
    if (this.#inflight !== undefined) return this.#inflight;
    // The in-flight slot is cleared by the run itself, so a rejected load does not wedge the
    // registry. `run` is declared before `started` and closes over it: the `finally` only observes
    // it after the first `await`, by which point it is assigned.
    const run = async (): Promise<void> => {
      try {
        await this.#fetchAll(opts);
      } finally {
        if (this.#inflight === started) this.#inflight = undefined;
      }
    };
    const started: Promise<void> = run();
    this.#inflight = started;
    return started;
  }

  /** Every market, ordered by `marketId`, optionally filtered by kind. Frozen. */
  list(filter?: MarketFilter): readonly MarketInfo[] {
    this.#touch();
    const type: MarketKind | undefined = filter?.type;
    if (type === undefined) return this.#ordered;
    return Object.freeze(this.#ordered.filter((m: MarketInfo): boolean => m.marketType === type));
  }

  /**
   * Resolve a market. **Throws on a miss and on an ambiguous bare symbol** — never guesses.
   *
   * There is no safe fallback for decimals, and there is no safe way to pick between the perp
   * `ETH` and the spot `ETH`; both produce a wrong order rather than an error, so both are errors.
   */
  get(query: MarketQuery): MarketInfo {
    const resolved: MarketInfo | undefined = this.#resolve(query);
    if (resolved !== undefined) return resolved;
    throw new LighterConfigError(
      `unknown market ${describeQuery(query)}${
        this.#loadedAt === undefined ? " — the market registry has never been loaded; call load() first" : ""
      }`,
    );
  }

  /**
   * Resolve a market, `undefined` on a miss.
   *
   * An **ambiguous** bare symbol still throws: "undefined" would be read as "no such market", and
   * silently picking one of two is the failure this whole indexing scheme exists to prevent.
   */
  tryGet(query: MarketQuery): MarketInfo | undefined {
    return this.#resolve(query);
  }

  /** Delegates to the {@link AssetRegistry} this registry owns. Throws on a miss. */
  asset(idOrSymbol: number | string): AssetInfo {
    return this.#assets.get(idOrSymbol);
  }

  /** Clear any pending background refresh, here and in the asset registry. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      globalThis.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#assets.stop();
  }

  /** Backing method for `Symbol.dispose`; see the attachment below the class. */
  disposeSync(): void {
    this.stop();
  }

  /* -- internals ----------------------------------------------------------------------------- */

  #now(): number {
    const fn: (() => number) | undefined = this.#nowFn ?? this.#rest?.config.now;
    return fn !== undefined ? fn() : Date.now();
  }

  #emit(d: Diagnostic): void {
    const sink: ((d: Diagnostic) => void) | undefined = this.#sink ?? this.#rest?.config.onDiagnostic;
    if (sink === undefined) return;
    try {
      sink(d);
    } catch {
      /* a broken diagnostics sink must never take down a metadata load */
    }
  }

  #touch(): void {
    if (!this.stale) return;
    if (this.#loadedAt === undefined) return;
    this.#scheduleRefresh();
  }

  #scheduleRefresh(): void {
    if (this.#stopped || this.#rest === undefined) return;
    if (this.#timer !== undefined || this.#inflight !== undefined) return;
    this.#timer = globalThis.setTimeout((): void => {
      this.#timer = undefined;
      void this.load({ force: true }).catch((err: unknown): void => {
        this.#emit({
          level: "warn",
          event: "markets.refresh_failed",
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, 0);
  }

  #resolve(query: MarketQuery): MarketInfo | undefined {
    this.#touch();
    if (typeof query === "number") return this.#byId.get(query);

    const symbol: string = typeof query === "string" ? query : query.symbol;
    const type: MarketKind | undefined = typeof query === "string" ? undefined : query.type;
    if (typeof symbol !== "string" || symbol.length === 0) {
      throw new LighterConfigError(`market lookup: \`symbol\` must be a non-empty string (${describe(symbol)})`);
    }
    const key: string = symbolKey(symbol);
    const perp: readonly MarketInfo[] = type === "spot" ? [] : (this.#bySymbol.perp.get(key) ?? []);
    const spot: readonly MarketInfo[] = type === "perp" ? [] : (this.#bySymbol.spot.get(key) ?? []);
    const candidates: readonly MarketInfo[] = [...perp, ...spot];
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    throw new LighterConfigError(
      `ambiguous market symbol ${JSON.stringify(symbol)}: ${candidates
        .map((m: MarketInfo): string => `${m.marketType} id ${String(m.marketId)}`)
        .join(", ")} — qualify it as { symbol: ${JSON.stringify(symbol)}, type: "perp" | "spot" } or pass the id`,
    );
  }

  async #fetchAll(opts: LoadOptions | undefined): Promise<void> {
    const rest: LighterRestClient | undefined = this.#rest;
    if (rest === undefined) {
      throw new LighterConfigError(
        "MarketRegistry.load() needs a REST transport — construct with `{ rest }` or call setTransport()",
      );
    }
    const signal: AbortSignal | undefined = opts?.signal;
    const callOpts: CallOptions = signal !== undefined ? { signal } : {};
    // `AssetRegistry.load` gates itself on its own TTL, so the asset endpoint is not refetched just
    // because the market table went stale first.
    const assetLoad: Promise<void> = this.#assets.load(opts);
    const marketLoad: Promise<void> =
      opts?.force === true || this.#marketsNeedLoad() ? this.#fetchMarkets(rest, callOpts) : Promise.resolve();
    // `Promise.all` attaches a handler to both immediately, so a rejection on one side cannot
    // surface later as an unhandled rejection while the other is still running.
    await Promise.all([marketLoad, assetLoad]);
  }

  #marketsNeedLoad(): boolean {
    return this.#loadedAt === undefined || this.stale;
  }

  #assetsNeedLoad(): boolean {
    return this.#assets.loadedAt === undefined || this.#assets.stale;
  }

  async #fetchMarkets(rest: LighterRestClient, callOpts: CallOptions): Promise<void> {
    // `/orderBookDetails` is a superset of `/orderBooks` and is the preferred source. `/orderBooks`
    // is the fallback for a profile that serves the detail endpoint empty — without it the client
    // would have no decimals at all, which is worse than having no perps detail.
    const details: OrderBookDetails = await rest.order.orderBookDetails({}, callOpts);
    const perps: readonly PerpsOrderBookDetail[] = details.order_book_details ?? [];
    const spot: readonly SpotOrderBookDetail[] = details.spot_order_book_details ?? [];
    let infos: MarketInfo[];
    if (perps.length + spot.length > 0) {
      infos = [
        ...perps.map((m: PerpsOrderBookDetail): MarketInfo => toMarketInfo(m, "perp", true)),
        ...spot.map((m: SpotOrderBookDetail): MarketInfo => toMarketInfo(m, "spot", false)),
      ];
    } else {
      this.#emit({ level: "info", event: "markets.details_empty", detail: { fallback: "/orderBooks" } });
      const books: OrderBooks = await rest.order.orderBooks({}, callOpts);
      infos = (books.order_books ?? []).map((m: OrderBook): MarketInfo => toMarketInfo(m));
    }
    this.#index(infos);
    this.#loadedAt = this.#now();
    this.#reportCrossScale(infos);
  }

  #restore(snapshot: MarketSnapshot): void {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new LighterConfigError("market snapshot: not an object");
    }
    if (snapshot.version !== 1) {
      throw new LighterConfigError(`market snapshot: unsupported version ${describe(snapshot.version)} (expected 1)`);
    }
    if (!Array.isArray(snapshot.markets)) {
      throw new LighterConfigError("market snapshot: `markets` is not an array");
    }
    this.#index(
      snapshot.markets.map((m: MarketInfo): MarketInfo => {
        // Shallow copy rather than freezing the caller's object: the registry must not observe
        // later mutation, and the caller's snapshot must not become frozen behind their back.
        const copy: MarketInfo = { ...m };
        return Object.freeze(
          m.perps !== undefined ? { ...copy, perps: Object.freeze({ ...m.perps }) } : copy,
        );
      }),
    );
    this.#loadedAt = typeof snapshot.loadedAt === "number" ? snapshot.loadedAt : undefined;
    this.#assets.restore(snapshot.assets);
  }

  /** Build every index from a complete list, or throw without touching the previous state. */
  #index(infos: readonly MarketInfo[]): void {
    const byId: Map<number, MarketInfo> = new Map<number, MarketInfo>();
    const bySymbol: SymbolIndex = emptySymbolIndex();
    const ordered: MarketInfo[] = [...infos].sort((a: MarketInfo, b: MarketInfo): number => a.marketId - b.marketId);
    for (const info of ordered) {
      const id: number = requireInt(info.marketId, "marketId", "market snapshot entry");
      if (id === NIL_MARKET_INDEX) {
        throw new LighterConfigError(
          `market ${String(NIL_MARKET_INDEX)}: NilMarketIndex is the cancel-all sentinel, never a market`,
        );
      }
      if (byId.has(id)) throw new LighterConfigError(`duplicate market id ${String(id)}`);
      byId.set(id, info);

      const kind: MarketKind = info.marketType === "spot" ? "spot" : "perp";
      const range: readonly [number, number] =
        kind === "spot" ? SPOT_MARKET_INDEX_RANGE : PERPS_MARKET_INDEX_RANGE;
      if (id < range[0] || id > range[1]) {
        // A warning, not an error. The index ranges are protocol constants that could widen (227 of
        // the 255 perp slots are already used); refusing the metadata would take trading down
        // entirely, whereas a market outside the range is still perfectly usable for sizing.
        this.#emit({
          level: "warn",
          event: "markets.index_out_of_range",
          detail: { marketId: id, symbol: info.symbol, marketType: kind, expected: range },
        });
      }

      if (typeof info.symbol !== "string" || info.symbol.length === 0) {
        throw new LighterConfigError(`market ${String(id)}: \`symbol\` is missing or empty`);
      }
      const bucket: Map<string, MarketInfo[]> = kind === "spot" ? bySymbol.spot : bySymbol.perp;
      const key: string = symbolKey(info.symbol);
      const existing: MarketInfo[] | undefined = bucket.get(key);
      if (existing === undefined) bucket.set(key, [info]);
      else existing.push(info);
    }
    this.#byId = byId;
    this.#bySymbol = bySymbol;
    this.#ordered = Object.freeze(ordered);
  }

  /** One diagnostic per market that breaks the cross-scale invariant. Never a throw. */
  #reportCrossScale(infos: readonly MarketInfo[]): void {
    for (const m of infos) {
      if (m.quoteSizingSupported) continue;
      this.#emit({
        level: "warn",
        event: "markets.cross_scale_violation",
        detail: {
          marketId: m.marketId,
          symbol: m.symbol,
          priceDecimals: m.priceDecimals,
          sizeDecimals: m.sizeDecimals,
          quoteDecimals: m.quoteDecimals,
        },
      });
    }
  }
}

function describeQuery(query: MarketQuery): string {
  if (typeof query === "number") return String(query);
  if (typeof query === "string") return JSON.stringify(query);
  return `{ symbol: ${JSON.stringify(query.symbol)}${query.type !== undefined ? `, type: ${JSON.stringify(query.type)}` : ""} }`;
}

/*
 * Explicit resource management, attached defensively — see the identical note in `./assets.ts` and
 * in `src/ws/subscription.ts`. `Symbol.dispose` is `undefined` on Node 20 and older Safari, where a
 * computed `[Symbol.dispose]()` class member throws at import time.
 */
const disposeSym: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
if (typeof disposeSym === "symbol") {
  Object.defineProperty(MarketRegistry.prototype, disposeSym, {
    value: function dispose(this: MarketRegistry): void {
      this.disposeSync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}
