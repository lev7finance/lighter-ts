/**
 * Evidence and fakes shared by the three registry test files.
 *
 * **Everything that can come from a golden fixture does.** `test/fixtures/rest/responses.json` is a
 * real capture from `https://mainnet.zklighter.elliot.ai` (wave 0, no SDK code involved), and the
 * `orderBooks`, `assetDetails` and `systemConfig` bodies below are its bytes, untouched.
 *
 * Two things the capture does **not** contain, and how they are handled:
 *
 * 1. **`/orderBookDetails` was never captured.** The registry prefers it because it is a superset of
 *    `/orderBooks`, so the fake serves a body *derived from the golden `/orderBooks` records* —
 *    every shared field is the captured value, verbatim. The perps-only fields added on top
 *    (`mark_price`, the margin fractions, `market_config`) follow `spec/05-rest-api.md` §10.3 and
 *    `src/models/market.ts`; they are labelled `SYNTHETIC` at each site so nobody mistakes them for
 *    captured evidence.
 * 2. **The capture has no spot market and no cross-scale violation.** All 227 captured markets are
 *    perps and all three retained ones satisfy `price + size === quote`. The two edge cases the
 *    registry must handle are therefore constructed *from* a golden record, changing only the field
 *    under test, so the assertion is about that field and nothing else.
 *
 * The fixture's own note is binding: *"Values are live market data and will not match a later
 * capture; assert on SHAPE, not on numbers."* Where a number is asserted below it is read out of the
 * fixture at run time rather than typed in.
 */

import { readFileSync } from "node:fs";

import type { LighterConfig } from "../../src/config/config.js";
import type {
  AssetDetails,
  OrderBook,
  OrderBookDetails,
  OrderBooks,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
  SystemConfig,
} from "../../src/models/market.js";
import { LighterRestClient } from "../../src/rest/client.js";

/* ---------------------------------------------------------------------------------------------- */
/* Golden fixtures                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

interface FixtureCase {
  readonly request: { readonly path: string };
  readonly status: number;
  readonly body: unknown;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/rest/responses.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, FixtureCase> };

function fixtureBody(name: string): unknown {
  const found: FixtureCase | undefined = fixtures.cases[name];
  if (found === undefined) throw new Error(`no fixture named ${name}`);
  return found.body;
}

/** The captured `GET /api/v1/orderBooks` body — 227 markets truncated to 3 by the capture script. */
export function goldenOrderBooks(): OrderBooks {
  return fixtureBody("orderBooks") as OrderBooks;
}

/** The captured `GET /api/v1/assetDetails` body — 9 assets truncated to 3 (LDO, USDC, UNI). */
export function goldenAssetDetails(): AssetDetails {
  return fixtureBody("assetDetails") as AssetDetails;
}

/** The captured `GET /api/v1/systemConfig` body, in full — the capture truncated nothing. */
export function goldenSystemConfig(): SystemConfig {
  return fixtureBody("systemConfig") as SystemConfig;
}

/** The captured markets, in capture order. */
export function goldenMarkets(): readonly OrderBook[] {
  const books: readonly OrderBook[] | undefined = goldenOrderBooks().order_books;
  if (books === undefined || books.length === 0) throw new Error("orderBooks fixture has no markets");
  return books;
}

/** One captured market by symbol. Throws rather than returning a silently wrong record. */
export function goldenMarket(symbol: string): OrderBook {
  const found: OrderBook | undefined = goldenMarkets().find((m: OrderBook): boolean => m.symbol === symbol);
  if (found === undefined) throw new Error(`no captured market named ${symbol}`);
  return found;
}

/* ---------------------------------------------------------------------------------------------- */
/* Derived bodies                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * SYNTHETIC perps detail, layered on a captured record.
 *
 * Only fields absent from `/orderBooks` are added; every captured field is passed through unchanged.
 */
function withPerpsDetail(base: OrderBook): PerpsOrderBookDetail {
  return {
    ...base,
    ...(base.supported_size_decimals !== undefined ? { size_decimals: base.supported_size_decimals } : {}),
    ...(base.supported_price_decimals !== undefined ? { price_decimals: base.supported_price_decimals } : {}),
    quote_multiplier: 1,
    default_initial_margin_fraction: 500,
    min_initial_margin_fraction: 200,
    maintenance_margin_fraction: 300,
    closeout_margin_fraction: 100,
    mark_price: "64398.5",
    index_price: "64422.5",
    market_config: {
      market_margin_mode: 0,
      insurance_fund_account_index: 281474976710655,
      liquidation_mode: 0,
      force_reduce_only: false,
      trading_hours: "",
      hidden: false,
      rfq_enabled: true,
    },
    funding_clamp_small: "0.0500",
    funding_clamp_big: "4.0000",
    base_interest_rate: "0.0100",
  };
}

/**
 * A spot market, built from a captured perp record by moving its id into the spot index range and
 * relabelling it. Every other field — including all three decimal counts — is the captured value.
 *
 * It exists to exercise one thing the capture cannot: the same symbol listed on both market types.
 */
export function derivedSpotMarket(fromSymbol: string, marketId: number): SpotOrderBookDetail {
  const base: OrderBook = goldenMarket(fromSymbol);
  return { ...base, market_id: marketId, market_type: "spot", base_asset_id: 1, quote_asset_id: 3 };
}

/**
 * A market that violates the cross-scale invariant, built from a captured record by changing
 * `supported_quote_decimals` alone.
 *
 * The captured value satisfies `price + size === quote`; adding one to the quote exponent breaks it
 * and touches nothing else, so a failing assertion can only be about the invariant.
 */
export function derivedCrossScaleViolator(fromSymbol: string, marketId: number): PerpsOrderBookDetail {
  const base: OrderBook = goldenMarket(fromSymbol);
  const quote: number = base.supported_quote_decimals ?? 6;
  return { ...base, market_id: marketId, symbol: `${base.symbol ?? "X"}X`, supported_quote_decimals: quote + 1 };
}

/** The `/orderBookDetails` body the fake serves: golden perps, plus whatever the test asked for. */
export function orderBookDetailsBody(
  extraPerps: readonly PerpsOrderBookDetail[] = [],
  spot: readonly SpotOrderBookDetail[] = [],
): OrderBookDetails {
  return {
    code: 200,
    order_book_details: [...goldenMarkets().map(withPerpsDetail), ...extraPerps],
    spot_order_book_details: [...spot],
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The fake server                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** A counting fake `fetch`. `counts` is keyed by URL pathname, which is what "per endpoint" means. */
export interface FakeServer {
  readonly client: LighterRestClient;
  readonly counts: Map<string, number>;
  /** Total requests, over every path. */
  total(): number;
  countOf(path: string): number;
}

export type Handler = (url: URL) => Response;

export function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A {@link LighterRestClient} whose `fetch` never touches the network.
 *
 * A path with no handler is a test bug, not a 404: it throws, so a registry that starts calling a
 * new endpoint fails loudly rather than silently degrading.
 */
export function fakeServer(handlers: Record<string, Handler>, config?: LighterConfig): FakeServer {
  const counts: Map<string, number> = new Map<string, number>();
  const impl = (input: string | URL | Request): Promise<Response> => {
    const url: URL = new URL(String(input));
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    const handler: Handler | undefined = handlers[url.pathname];
    if (handler === undefined) throw new Error(`fake server: no handler for ${url.pathname}`);
    return Promise.resolve(handler(url));
  };
  const client: LighterRestClient = new LighterRestClient({
    endpoint: "mainnet",
    ...config,
    fetch: impl as unknown as typeof globalThis.fetch,
  });
  return {
    client,
    counts,
    total: (): number => [...counts.values()].reduce((a: number, b: number): number => a + b, 0),
    countOf: (path: string): number => counts.get(path) ?? 0,
  };
}

/** Endpoint paths, spelled once. */
export const PATH_ORDER_BOOKS: string = "/api/v1/orderBooks";
export const PATH_ORDER_BOOK_DETAILS: string = "/api/v1/orderBookDetails";
export const PATH_ASSET_DETAILS: string = "/api/v1/assetDetails";
export const PATH_SYSTEM_CONFIG: string = "/api/v1/systemConfig";

/* ---------------------------------------------------------------------------------------------- */
/* Clocks and timers                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** A clock the test drives. Every registry reads the time through the injected `now()`. */
export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start: number = 1_700_000_000_000): FakeClock {
  let t: number = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

/** What {@link recordTimers} observed. */
export interface TimerLog {
  readonly created: unknown[];
  readonly cleared: unknown[];
  /** Handles created and never cleared. Must be empty after disposal. */
  outstanding(): unknown[];
}

/**
 * Run `body` with `globalThis.setTimeout` / `clearTimeout` wrapped, and report what leaked.
 *
 * Deliberately scoped to a synchronous block that performs no I/O, so the only timers it can see are
 * the registry's own — the transport schedules its own timers per request and those are not this
 * unit's to account for.
 */
export function recordTimers<T>(body: (log: TimerLog) => T): T {
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  const realSet: typeof globalThis.setTimeout = globalThis.setTimeout;
  const realClear: typeof globalThis.clearTimeout = globalThis.clearTimeout;
  const log: TimerLog = {
    created,
    cleared,
    outstanding: (): unknown[] => created.filter((h: unknown): boolean => !cleared.includes(h)),
  };
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown => {
    const handle: unknown = (realSet as unknown as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    created.push(handle);
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: unknown): void => {
    cleared.push(handle);
    (realClear as unknown as (h: unknown) => void)(handle);
  }) as unknown as typeof globalThis.clearTimeout;
  try {
    return body(log);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}
