/**
 * The human tier: `account.market('ETH').buy({ size: '0.1', maxSlippage: '0.5%' })`.
 *
 * This is the surface most users touch, and it is the layer that decides **what price and size an
 * order is actually submitted at**. It adds no protocol logic — the order math is
 * `src/client/math/`, the codec is `src/tx/`, the lifecycle is `src/client/submit.ts` — and it adds
 * exactly two things:
 *
 * 1. **Decimal strings in, protocol integers out, under a named rounding policy.** A size is always
 *    floored; a price is exact unless the caller opts into `conservative`, which rounds the way that
 *    cannot cost them money; a market order's cap is not derived here at all but delegated whole to
 *    `slippageBound`, so there is one place in the SDK where the direction of that rounding lives.
 * 2. **{@link Applied} on every call.** Every method reports the exact `baseAmount`, `price`,
 *    `triggerPrice` and `orderExpiry` it used. A conversion the caller cannot see is a conversion
 *    they cannot audit, and each of the reference's four arithmetic hazards
 *    (`docs/protocol-notes.md` §9) is invisible at the call site.
 *
 * ## What is delegated, and to what
 *
 * | Concern | Owner |
 * | --- | --- |
 * | slippage string → exact rational | `math/slippage.ts` `parseSlippage` |
 * | market-order price cap and its rounding direction | `math/slippage.ts` `slippageBound` |
 * | quote notional → base size, with the depth and slippage gates | `math/quote.ts` `quoteToBase` |
 * | base size gated on achievable price | `math/quote.ts` `baseOrderIfSlippage` |
 * | leverage → initial margin fraction | `math/leverage.ts` `leverageToImf` |
 * | decimal → integer, order legs, bracket legality | `./brackets.ts` |
 * | nonce, signing, submission, receipts | `./submit.ts` |
 *
 * ## `dryRun` never consumes a nonce slot
 *
 * A dry run signs in **caller-managed** mode with an explicit nonce (`0`, or whichever the caller
 * passed) on the account's first configured key. The nonce source is not consulted, no counter
 * moves, no lease is taken, and no request is issued — so the signature is over a transaction whose
 * nonce is a placeholder, and the receipt says so by carrying the signed transaction on
 * {@link AppliedReceipt.dryRun}. The alternative — allocating a real slot to produce a realistic
 * signature and rolling it back — was rejected: a rollback that is skipped on a throw silently burns
 * a nonce, and a burned nonce has no visible consequence until the *next* transaction on that key.
 *
 * No Node built-ins, no module-level mutable state, no clock read at import.
 */

import { LighterConfigError, LighterMathError, LighterValidationError } from "../errors.js";
import type { OrderBookOrders } from "../models/order.js";
import type { TxAttributes } from "../tx/attributes.js";
import { i16, i64, u8, u16, u32 } from "../tx/brands.js";
import type { SignedTx, UnsignedTx } from "../tx/build.js";
import { NIL_ORDER_EXPIRY } from "../tx/constants.js";
import { CancelAllTimeInForce, MarginDirection, MarginMode, OrderTimeInForce, OrderType } from "../tx/enums.js";
import { toTxInfo, txHashHex } from "../tx/pipeline.js";
import type { OrderInfo } from "../tx/types/orders.js";
import { toScaled } from "../util/decimal.js";
import type { RawTxOpts, RawTxSurface } from "./account.js";
import {
  type Applied,
  type BracketOpts,
  type EntryOpts,
  type Leg,
  NO_ORDER_INTEGERS,
  type OtoOpts,
  type PositionBracketOpts,
  type PriceRounding,
  type Side,
  type TimeInForceName,
  type TriggerFamily,
  type TriggerOpts,
  baseAmountOf,
  buildOco,
  buildOto,
  buildOtoco,
  clientOrderIndexOf,
  entryLeg,
  type GroupPlan,
  isAskOf,
  narrowToU32,
  priceOf,
  triggerLeg,
  triggerOf,
} from "./brackets.js";
import type { MarketInfo, MarketQuery } from "./markets.js";
import {
  type BaseSizing,
  type BookSnapshot,
  type Fraction,
  type LeverageInput,
  type LeverageResult,
  type QuoteSizing,
  type SlippageMode,
  baseOrderIfSlippage,
  bestPrice,
  bookFromRestOrders,
  leverageToImf,
  quoteToBase,
  slippageBound,
} from "./math/index.js";
import { normalizeTxHash, type TxReceipt, type TxResult, type WaitOptions } from "./receipt.js";
import type { PrepareOpts, SendOpts } from "./submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* Receipts                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A {@link TxReceipt} that also states what the conversion produced.
 *
 * `applied` is **not optional**. A human-tier call that submits without reporting the integers it
 * submitted is a defect, not a terser API.
 */
export type AppliedReceipt = TxReceipt & {
  /** The exact protocol integers this call used. */
  readonly applied: Applied;
  /**
   * The fully built and signed transaction, present only when `dryRun` was set.
   *
   * Its nonce is a placeholder — see the module header — so it is a real signature over a
   * transaction that is deliberately not the one that would have been submitted.
   */
  readonly dryRun?: SignedTx;
  /** For a grouped submission, what each leg resolved to, in protocol leg order. */
  readonly legs?: readonly Applied[];
};

/** What {@link MarketHandle.setLeverage} adds to its receipt. */
export interface LeverageApplied {
  /** The protocol field actually submitted: an integer in `[1, 10 000]`. */
  readonly imf: number;
  /**
   * `10 000 / imf`, exact and in lowest terms — the leverage the account is really running.
   *
   * The reference computes `int(10_000 / leverage)`, which floors: leverage 3 becomes imf 3333, an
   * effective **3.0003×**, i.e. *more* leverage than was asked for. This SDK rounds the imf up
   * instead, so the deviation lands on the safe side; it does not vanish, so it is reported rather
   * than hidden.
   */
  readonly effectiveLeverage: { readonly num: bigint; readonly den: bigint };
  /** `true` only when a request below 1× was raised to 1×, the least levered state the protocol has. */
  readonly clamped: boolean;
}

/* ---------------------------------------------------------------------------------------------- */
/* The seams                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The account half of a trading context. {@link LighterAccount} satisfies it structurally. */
export interface TradingAccount {
  readonly accountIndex: bigint;
  /** The twenty raw builders, already bound to this account. */
  readonly tx: RawTxSurface;
  /** The API key indices this account can sign with. A dry run signs with the first. */
  readonly apiKeyIndexes: readonly number[];
  /** Stamp, validate, hash and sign — everything except the network. */
  prepare(tx: UnsignedTx, opts?: PrepareOpts): Promise<SignedTx>;
  /** Sign (if needed) and submit. */
  send(tx: UnsignedTx | SignedTx, opts?: SendOpts): Promise<TxReceipt>;
}

/** Market metadata lookup. {@link MarketRegistry} satisfies it. */
export interface MarketLookup {
  /** Throws on a miss and on an ambiguous bare symbol; there is no safe guess about decimals. */
  get(query: MarketQuery): MarketInfo;
}

/** Where a book snapshot comes from: REST, a WebSocket-maintained book, or a fixture. */
export interface BookSource {
  snapshot(
    market: MarketInfo,
    opts?: { readonly depth?: number; readonly signal?: AbortSignal },
  ): Promise<BookSnapshot>;
}

/** The one REST operation {@link restBookSource} calls. `LighterRestClient` satisfies it. */
export interface OrderBookTransport {
  readonly order: {
    orderBookOrders(
      params: { market_id: number; limit: number },
      opts?: { signal?: AbortSignal },
    ): Promise<OrderBookOrders>;
  };
}

/** The reference's depth for a book walk. */
export const DEFAULT_BOOK_DEPTH: 100 = 100;

/** Depth requested when only the best price is needed. */
export const TOP_OF_BOOK_DEPTH: 1 = 1;

/**
 * A {@link BookSource} over `GET /api/v1/orderBookOrders`.
 *
 * That endpoint returns **individual resting orders**, not levels; `bookFromRestOrders` folds them
 * and asserts the ordering, so a mis-sorted book is an error rather than a plausible wrong average.
 */
export function restBookSource(rest: OrderBookTransport): BookSource {
  return {
    async snapshot(
      market: MarketInfo,
      opts?: { readonly depth?: number; readonly signal?: AbortSignal },
    ): Promise<BookSnapshot> {
      const response: OrderBookOrders = await rest.order.orderBookOrders(
        { market_id: market.marketId, limit: opts?.depth ?? DEFAULT_BOOK_DEPTH },
        opts?.signal !== undefined ? { signal: opts.signal } : undefined,
      );
      return bookFromRestOrders(response, market);
    },
  };
}

/** Everything a {@link MarketHandle} needs, passed in rather than reached for. */
export interface MarketContext {
  /** Signing domain. Needed to name the hash of a dry-run transaction; never inferred from a URL. */
  readonly chainId: number;
  readonly account: TradingAccount;
  readonly markets: MarketLookup;
  readonly books: BookSource;
  /** Injected clock, ms. Defaults to `Date.now`. Every expiry default reads it. */
  readonly now?: (() => number) | undefined;
}

/* ---------------------------------------------------------------------------------------------- */
/* Options                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** What every method here accepts on top of its own arguments. */
export interface TradeCallOptions {
  /** Passed to `account.send()`: nonce mode, key preference, channel, timeout, signal. */
  readonly send?: SendOpts;
  /** Per-call overrides for the raw builder: `expiredAt`, `attributes`, `strict`. */
  readonly tx?: RawTxOpts;
  /** Cancellation for the book read this call may make before signing. */
  readonly signal?: AbortSignal;
  /** Build and sign, submit nothing, issue no request. See the module header. */
  readonly dryRun?: boolean;
}

/** `buy` / `sell` — a MARKET/IOC order sized in base units or in quote notional. */
export interface SizedOrderOpts extends TradeCallOptions {
  /** Base units, decimal string. Exactly one of `size` / `notional`. */
  readonly size?: string;
  /** Quote units, decimal string. Exactly one of `size` / `notional`. */
  readonly notional?: string;
  /** `"0.005"`, `"0.5%"` or `"50bps"` — all three are the same exact rational. */
  readonly maxSlippage?: string;
  /**
   * Walk the book and refuse the order if the achievable average is worse than the bound.
   *
   * `false` (the default) is the reference's `create_market_order_limited_slippage`: the cap is
   * computed from the best price and the order simply fills less on a thin book. `true` adds the
   * `EXCESSIVE_SLIPPAGE` / `INSUFFICIENT_DEPTH` gates. A `notional` order always walks the book,
   * because the base size cannot be computed without it.
   */
  readonly checkDepth?: boolean;
  readonly reduceOnly?: boolean;
  readonly clientOrderId?: bigint;
  /** The price the bound is measured from, when the caller has a better one than the top of book. */
  readonly idealPrice?: string;
  /** Rounding policy for the bound. `conservative` unless stated. */
  readonly mode?: SlippageMode;
}

/** `limit` / `postOnly`. */
export interface LimitOpts extends TradeCallOptions {
  readonly side: Side;
  readonly size?: string;
  readonly price: string;
  /** `GTT` unless stated. `postOnly()` forces `PostOnly`. */
  readonly timeInForce?: TimeInForceName;
  readonly clientOrderId?: bigint;
  /** Absolute Unix ms; use {@link expiryIn}. Defaults to 28 days out for a non-IOC order. */
  readonly expiry?: bigint;
  readonly reduceOnly?: boolean;
  readonly rounding?: PriceRounding;
}

/** `modify`. A modification carries no side, no time in force and no expiry — only three numbers. */
export interface ModifyOpts extends TradeCallOptions {
  /** A client order index (`[1, 2^48−1]`) or an exchange order index (`[2^48, 2^60−1]`). */
  readonly orderId: bigint;
  /** New size. Omitted leaves it unchanged. */
  readonly size?: string;
  /** New price. Required: the protocol has no "leave the price" sentinel — `0` is `NilOrderPrice`. */
  readonly price: string;
  /** New trigger price. Omitted is nil. */
  readonly trigger?: string;
  /** Only read when `rounding` is `conservative`, to decide which way a price rounds. */
  readonly side?: Side;
  readonly rounding?: PriceRounding;
}

/** `cancelAll`. */
export interface CancelAllOpts extends TradeCallOptions {
  /**
   * `immediate` (the default) cancels now; `scheduled` arms a dead-man switch at {@link at};
   * `abort` disarms one.
   *
   * The per-market attribute (type 5) is only valid alongside an **immediate** cancel-all
   * (`docs/protocol-notes.md` §11), so a scheduled or aborting call from a market handle must say
   * {@link allMarkets} out loud rather than silently widening its own scope.
   */
  readonly mode?: "immediate" | "scheduled" | "abort";
  /** Absolute Unix ms for `scheduled`. Server-side it must land within `[now + 5 min, now + 15 days]`. */
  readonly at?: bigint;
  /** Required for `scheduled` / `abort`: acknowledges that the scope is every market, not this one. */
  readonly allMarkets?: boolean;
}

/** Cross or isolated margin. */
export type MarginModeName = "cross" | "isolated";

/**
 * `setLeverage`.
 *
 * The leverage is a decimal **string** or an exact `{ num, den }` rational, never a fractional
 * `number` (`docs/decisions.md` D7, which supersedes the numerically-typed leverage parameter of
 * `docs/ARCHITECTURE.md` §6.8). `{ initialMarginFraction }` is accepted directly so a caller reading
 * an account's existing configuration can round-trip it without a lossy conversion in the middle.
 */
export type LeverageOpts = LeverageInput &
  TradeCallOptions & {
    readonly marginMode: MarginModeName;
  };

/* ---------------------------------------------------------------------------------------------- */
/* The handle                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** USDC's protocol scale. A margin amount is an integer count of `10^-6` USDC by definition. */
const MICRO_USDC_DECIMALS: 6 = 6;

/**
 * One market's trading surface.
 *
 * Construct through {@link marketHandle}, which resolves the market from the registry — a handle
 * built around a `MarketInfo` from somewhere else would be free to disagree with the registry about
 * the decimals, which is a wrong-magnitude order rather than an error.
 */
export class MarketHandle {
  /** The market this handle trades. Frozen metadata, resolved once. */
  readonly market: MarketInfo;

  readonly #ctx: MarketContext;

  constructor(ctx: MarketContext, market: MarketInfo) {
    this.#ctx = ctx;
    this.market = market;
  }

  /** The market index used in every call and in every signature. */
  get marketId(): number {
    return this.market.marketId;
  }

  /* ---- market orders ---------------------------------------------------------------------------- */

  /** A MARKET/IOC buy, capped at the slippage bound. `orderExpiry` is nil, which is correct for IOC. */
  async buy(o: SizedOrderOpts): Promise<AppliedReceipt> {
    return this.#marketOrder("buy", o);
  }

  /** A MARKET/IOC sell, capped at the slippage bound. */
  async sell(o: SizedOrderOpts): Promise<AppliedReceipt> {
    return this.#marketOrder("sell", o);
  }

  /* ---- resting orders --------------------------------------------------------------------------- */

  /** A LIMIT order. Its expiry is nil if and only if it is IOC. */
  async limit(o: LimitOpts): Promise<AppliedReceipt> {
    return this.#restingOrder(o, o.timeInForce ?? "GTT");
  }

  /** A LIMIT order that may only ever be a maker. */
  async postOnly(o: LimitOpts): Promise<AppliedReceipt> {
    if (o.timeInForce !== undefined && o.timeInForce !== "PostOnly") {
      throw new LighterValidationError(
        "ORDER_TIF_INVALID",
        `postOnly() is the PostOnly time in force; it cannot also be ${JSON.stringify(o.timeInForce)}`,
        { field: "TimeInForce" },
      );
    }
    return this.#restingOrder(o, "PostOnly");
  }

  /** Change a resting order's size, price and trigger. Nothing else about it is modifiable. */
  async modify(o: ModifyOpts): Promise<AppliedReceipt> {
    const rounding: PriceRounding = o.rounding ?? "exact";
    if (rounding === "conservative" && o.side === undefined) {
      throw new LighterConfigError(
        "modify({ rounding: 'conservative' }) needs `side`: a conservative price rounds down for a " +
          "buy and up for a sell, and a modification carries no side of its own",
      );
    }
    const isAsk: boolean = o.side === undefined ? false : isAskOf(o.side);
    const baseAmount: bigint = baseAmountOf(this.market, o.size);
    const price: bigint = priceOf(this.market, o.price, isAsk, rounding);
    const triggerPrice: bigint =
      o.trigger === undefined
        ? 0n
        : triggerOf(this.market, o.trigger, isAsk, rounding);
    const tx: UnsignedTx = this.#ctx.account.tx.modifyOrder(
      {
        marketIndex: i16(this.marketId),
        index: i64(o.orderId),
        baseAmount: i64(baseAmount),
        price: u32(narrowToU32(price, "Price")),
        triggerPrice: u32(narrowToU32(triggerPrice, "TriggerPrice")),
      },
      o.tx,
    );
    return this.#submit(tx, { baseAmount, price, triggerPrice, orderExpiry: NIL_ORDER_EXPIRY }, o);
  }

  /** Cancel one resting order by client order index or exchange order index. */
  async cancel(orderId: bigint, o?: TradeCallOptions): Promise<AppliedReceipt> {
    const tx: UnsignedTx = this.#ctx.account.tx.cancelOrder(
      { marketIndex: i16(this.marketId), index: i64(orderId) },
      o?.tx,
    );
    return this.#submit(tx, NO_ORDER_INTEGERS, o);
  }

  /**
   * Cancel every resting order **on this market**, through L2 attribute type 5.
   *
   * Attribute 5 is only valid alongside an immediate cancel-all (`docs/protocol-notes.md` §11), and
   * setting an attribute changes the transaction hash — none of them is free metadata. A scheduled
   * or aborting cancel-all therefore carries no attribute 5 at all (its nil value is
   * `NIL_MARKET_INDEX`, and a nil-valued attribute is omitted rather than emitted), and is refused
   * here unless the caller acknowledged the widened scope.
   */
  async cancelAll(o?: CancelAllOpts): Promise<AppliedReceipt> {
    const mode: "immediate" | "scheduled" | "abort" = o?.mode ?? "immediate";
    const immediate: boolean = mode === "immediate";
    if (!immediate && o?.allMarkets !== true) {
      throw new LighterValidationError(
        "CANCEL_ALL_MARKET_CANT_BE_SCHEDULED",
        `a ${mode} cancel-all cannot be scoped to one market — attribute 5 is only valid alongside ` +
          `ImmediateCancelAll, so this would silently cancel across every market. Pass ` +
          `{ allMarkets: true } to say so, or use the immediate mode`,
        { field: "TimeInForce" },
      );
    }
    if (mode === "scheduled" && o?.at === undefined) {
      throw new LighterValidationError(
        "CANCEL_ALL_TIME_OUT_OF_RANGE",
        "a scheduled cancel-all needs an absolute `at` timestamp in Unix ms",
        { field: "Time" },
      );
    }
    if (mode !== "scheduled" && o?.at !== undefined) {
      throw new LighterValidationError(
        "CANCEL_ALL_TIME_NOT_NIL",
        `an ${mode} cancel-all carries Time = 0; only the scheduled mode takes a timestamp`,
        { field: "Time" },
      );
    }
    const timeInForce: number =
      mode === "immediate"
        ? CancelAllTimeInForce.ImmediateCancelAll
        : mode === "scheduled"
          ? CancelAllTimeInForce.ScheduledCancelAll
          : CancelAllTimeInForce.AbortScheduledCancelAll;
    // The market scope lives in the attribute map, never in a struct field. `255` is its nil value
    // and would be dropped by normalisation anyway; it is simply not set for the wider modes.
    const scoped: boolean = immediate && o?.allMarkets !== true;
    const attributes: TxAttributes | undefined = scoped
      ? { ...(o?.tx?.attributes ?? {}), 5: this.marketId }
      : o?.tx?.attributes;
    const tx: UnsignedTx = this.#ctx.account.tx.cancelAllOrders(
      { timeInForce: u8(timeInForce), time: i64(o?.at ?? 0n) },
      { ...o?.tx, ...(attributes !== undefined ? { attributes } : {}) },
    );
    return this.#submit(tx, NO_ORDER_INTEGERS, o);
  }

  /* ---- trigger orders --------------------------------------------------------------------------- */

  /**
   * A standalone take-profit. `TAKE_PROFIT` is IOC; `{ limit: true }` selects `TAKE_PROFIT_LIMIT`,
   * whose time in force is unconstrained. Both require a non-nil trigger and a non-nil expiry, and
   * both are **perps only**.
   */
  async takeProfit(o: TriggerOpts): Promise<AppliedReceipt> {
    return this.#triggerOrder(o, "takeProfit");
  }

  /** A standalone stop-loss. Same rules as {@link takeProfit}. */
  async stopLoss(o: TriggerOpts): Promise<AppliedReceipt> {
    return this.#triggerOrder(o, "stopLoss");
  }

  /* ---- grouped orders --------------------------------------------------------------------------- */

  /** OTOCO: an entry, and the take-profit / stop-loss pair armed when it fills. */
  async bracket(o: BracketOpts & TradeCallOptions): Promise<AppliedReceipt> {
    return this.#group(buildOtoco(this.market, o, this.#now), o);
  }

  /** OCO: a take-profit / stop-loss pair over a position that already exists. */
  async positionBracket(o: PositionBracketOpts & TradeCallOptions): Promise<AppliedReceipt> {
    return this.#group(buildOco(this.market, o, this.#now), o);
  }

  /** OTO: one order that, when it fills, arms exactly one other. */
  async oto(o: OtoOpts & TradeCallOptions): Promise<AppliedReceipt> {
    return this.#group(buildOto(this.market, o, this.#now), o);
  }

  /* ---- margin ----------------------------------------------------------------------------------- */

  /**
   * Set this market's leverage, as an initial margin fraction.
   *
   * `imf = ceil(10 000 / leverage)`: the account is never *more* levered than the number the caller
   * typed. The reference floors, so leverage 3 becomes an effective 3.0003×. The deviation is
   * returned exactly, as a rational, on {@link LeverageApplied.effectiveLeverage}.
   *
   * @throws {LighterValidationError} `IMF_TOO_LOW` when the request exceeds the market's maximum
   * leverage; the message names the market's own limit.
   */
  async setLeverage(o: LeverageOpts): Promise<AppliedReceipt & LeverageApplied> {
    const result: LeverageResult = leverageToImfFor(this.market, o);
    const marginMode: number = marginModeOf(o.marginMode);
    const tx: UnsignedTx = this.#ctx.account.tx.updateLeverage(
      {
        marketIndex: i16(this.marketId),
        initialMarginFraction: u16(result.imf),
        marginMode: u8(marginMode),
      },
      o.tx,
    );
    const receipt: AppliedReceipt = await this.#submit(tx, NO_ORDER_INTEGERS, o);
    return {
      ...receipt,
      imf: result.imf,
      effectiveLeverage: result.effectiveLeverage,
      clamped: result.clamped,
    };
  }

  /** Add isolated-margin collateral to this market's position — `Direction = 1`. */
  async addMargin(usdc: string, o?: TradeCallOptions): Promise<AppliedReceipt> {
    return this.#updateMargin(usdc, MarginDirection.AddToIsolated, o);
  }

  /** Remove isolated-margin collateral from this market's position — `Direction = 0`. */
  async removeMargin(usdc: string, o?: TradeCallOptions): Promise<AppliedReceipt> {
    return this.#updateMargin(usdc, MarginDirection.RemoveFromIsolated, o);
  }

  /* ---- internals -------------------------------------------------------------------------------- */

  get #now(): () => number {
    return this.#ctx.now ?? ((): number => Date.now());
  }

  /**
   * `buy` / `sell`: MARKET, IOC, nil expiry, nil trigger, priced at the slippage bound.
   *
   * The order of operations is `spec/07-high-level-client.md` §3.6, and two steps are deliberately
   * placed before any I/O: the cross-scale refusal, so a market that cannot express quote sizing is
   * rejected without a book fetch, and the "exactly one of size / notional" check.
   */
  async #marketOrder(side: Side, o: SizedOrderOpts): Promise<AppliedReceipt> {
    const isAsk: boolean = isAskOf(side);
    const bySize: boolean = o.size !== undefined;
    const byNotional: boolean = o.notional !== undefined;
    if (bySize === byNotional) {
      throw new LighterConfigError(
        "a market order is sized by exactly one of `size` (base units) and `notional` (quote units)",
      );
    }
    if (o.maxSlippage === undefined) {
      throw new LighterConfigError(
        "a market order needs `maxSlippage` — its `price` field is the worst price it may fill at, " +
          'and there is no safe default for that. Pass "0.005", "0.5%" or "50bps"',
      );
    }
    if (byNotional && this.market.quoteSizingSupported !== true) {
      // Checked here, ahead of the book fetch, so the refusal costs no request. `quoteToBase`
      // refuses the same market for the same reason; this is the guard, not a second copy of the
      // arithmetic.
      throw new LighterMathError(
        "SCALE_INVARIANT_VIOLATED",
        `${this.market.symbol} declares price ${String(this.market.priceDecimals)} + size ` +
          `${String(this.market.sizeDecimals)} decimals against a quote precision of ` +
          `${String(this.market.quoteDecimals)}; a quote-sized order on this market would be wrong ` +
          `by a power of ten, so it is refused rather than computed`,
      );
    }

    const idealPrice: bigint | undefined =
      o.idealPrice === undefined ? undefined : priceOf(this.market, o.idealPrice, isAsk, "exact");
    const walks: boolean = byNotional || o.checkDepth === true;
    const needsBook: boolean = walks || idealPrice === undefined;
    const book: BookSnapshot | undefined = needsBook
      ? await this.#ctx.books.snapshot(this.market, {
          depth: walks ? DEFAULT_BOOK_DEPTH : TOP_OF_BOOK_DEPTH,
          ...(o.signal !== undefined ? { signal: o.signal } : {}),
        })
      : undefined;

    const sizing: { baseAmount: bigint; price: bigint; notional?: bigint } = byNotional
      ? this.#quoteSized(book as BookSnapshot, o, isAsk, idealPrice)
      : this.#baseSized(book, o, isAsk, idealPrice);

    const applied: Applied = {
      baseAmount: sizing.baseAmount,
      price: sizing.price,
      triggerPrice: 0n,
      orderExpiry: NIL_ORDER_EXPIRY,
      ...(sizing.notional !== undefined ? { notional: sizing.notional } : {}),
    };
    const tx: UnsignedTx = this.#ctx.account.tx.createOrder(
      {
        marketIndex: i16(this.marketId),
        clientOrderIndex: i64(clientOrderIndexOf(o.clientOrderId)),
        baseAmount: i64(sizing.baseAmount),
        price: u32(narrowToU32(sizing.price, "Price")),
        isAsk: u8(isAsk ? 1 : 0),
        orderType: u8(OrderType.Market),
        timeInForce: u8(OrderTimeInForce.ImmediateOrCancel),
        reduceOnly: u8(o.reduceOnly === true ? 1 : 0),
        triggerPrice: u32(0),
        orderExpiry: i64(NIL_ORDER_EXPIRY),
      },
      o.tx,
    );
    return this.#submit(tx, applied, o);
  }

  /** Step 1–7 of §3.6, delegated whole to `quoteToBase`. */
  #quoteSized(
    book: BookSnapshot,
    o: SizedOrderOpts,
    isAsk: boolean,
    idealPrice: bigint | undefined,
  ): { baseAmount: bigint; price: bigint; notional: bigint } {
    const sized: QuoteSizing = quoteToBase(
      book,
      this.market,
      o.notional as string,
      isAsk,
      o.maxSlippage as string,
      {
        ...(idealPrice !== undefined ? { idealPrice } : {}),
        ...(o.mode !== undefined ? { mode: o.mode } : {}),
      },
    );
    return {
      baseAmount: sized.baseAmount,
      price: sized.price,
      // The same lexical, floored conversion `quoteToBase` performed at its step 1. Recomputed
      // rather than guessed so `applied.notional` is the integer the gate actually used: `"8.2"` at
      // six decimals is 8 200 000, where the reference's `int(8.2 × 1e6)` is 8 199 999.
      notional: toScaled(o.notional as string, this.market.quoteDecimals, "FLOOR"),
    };
  }

  /** A base-sized market order, with the depth gate only when the caller asked for it. */
  #baseSized(
    book: BookSnapshot | undefined,
    o: SizedOrderOpts,
    isAsk: boolean,
    idealPrice: bigint | undefined,
  ): { baseAmount: bigint; price: bigint } {
    const baseAmount: bigint = baseAmountOf(this.market, o.size);
    if (o.checkDepth === true) {
      const gated: BaseSizing = baseOrderIfSlippage(
        book as BookSnapshot,
        this.market,
        baseAmount,
        isAsk,
        o.maxSlippage as string,
        {
          ...(idealPrice !== undefined ? { idealPrice } : {}),
          ...(o.mode !== undefined ? { mode: o.mode } : {}),
        },
      );
      return { baseAmount, price: gated.price };
    }
    // No walk: the cap comes from the best price and the order fills less on a thin book (§3.7).
    const ideal: bigint = idealPrice ?? bestPrice(book as BookSnapshot, isAsk);
    return {
      baseAmount,
      price: slippageBound(ideal, o.maxSlippage as string, isAsk, o.mode ?? "conservative"),
    };
  }

  /** `limit` / `postOnly`, both of which are one entry leg submitted on its own. */
  #restingOrder(o: LimitOpts, timeInForce: TimeInForceName): Promise<AppliedReceipt> {
    const entry: EntryOpts = {
      side: o.side,
      ...(o.size !== undefined ? { size: o.size } : {}),
      price: o.price,
      timeInForce,
      ...(o.clientOrderId !== undefined ? { clientOrderId: o.clientOrderId } : {}),
      ...(o.expiry !== undefined ? { expiry: o.expiry } : {}),
      ...(o.reduceOnly !== undefined ? { reduceOnly: o.reduceOnly } : {}),
      ...(o.rounding !== undefined ? { rounding: o.rounding } : {}),
    };
    const leg: Leg = entryLeg(this.market, entry, this.#now);
    return this.#submit(this.#orderFromLeg(leg, o.tx), leg.applied, o);
  }

  /** `takeProfit` / `stopLoss`, both of which are one trigger leg submitted on its own. */
  #triggerOrder(o: TriggerOpts & TradeCallOptions, family: TriggerFamily): Promise<AppliedReceipt> {
    if (o.side === undefined) {
      throw new LighterConfigError(
        `a standalone ${family === "stopLoss" ? "stop-loss" : "take-profit"} needs \`side\`; only a ` +
          "bracket can infer it from its parent",
      );
    }
    if (this.market.marketType !== "perp") {
      throw new LighterValidationError(
        "MARKET_INDEX_NOT_PERPS",
        `stop-loss and take-profit orders are perps-only; ${this.market.symbol} is a ` +
          `${this.market.marketType} market`,
        { field: "MarketIndex" },
      );
    }
    const leg: Leg = triggerLeg(this.market, o, family, o.side, this.#now);
    return this.#submit(this.#orderFromLeg(leg, o.tx), leg.applied, o);
  }

  /** One resolved leg as a standalone `L2CreateOrder`. */
  #orderFromLeg(leg: Leg, txOpts: RawTxOpts | undefined): UnsignedTx {
    const order: OrderInfo = leg.order;
    return this.#ctx.account.tx.createOrder(
      {
        marketIndex: order.marketIndex,
        clientOrderIndex: order.clientOrderIndex,
        baseAmount: order.baseAmount,
        price: order.price,
        isAsk: order.isAsk,
        orderType: order.type,
        timeInForce: order.timeInForce,
        reduceOnly: order.reduceOnly,
        triggerPrice: order.triggerPrice,
        orderExpiry: order.orderExpiry,
      },
      txOpts,
    );
  }

  /** Submit a group plan whose legality was already asserted locally by `./brackets.ts`. */
  async #group(plan: GroupPlan, o: TradeCallOptions): Promise<AppliedReceipt> {
    const tx: UnsignedTx = this.#ctx.account.tx.createGroupedOrders(
      { groupingType: u8(plan.groupingType), orders: plan.orders },
      o.tx,
    );
    const parent: Applied = plan.applied[0] ?? NO_ORDER_INTEGERS;
    const receipt: AppliedReceipt = await this.#submit(tx, parent, o);
    return { ...receipt, legs: plan.applied };
  }

  /** `L2UpdateMargin` at the human tier: a positive micro-USDC amount plus an explicit direction. */
  #updateMargin(
    usdc: string,
    direction: number,
    o: TradeCallOptions | undefined,
  ): Promise<AppliedReceipt> {
    // `EXACT`: a margin amount carrying more than six decimals is a caller error, not a rounding
    // question. `"10.5"` is 10 500 000 exactly, where `int(10.5 * 1e6)` is a float product.
    const usdcAmount: bigint = toScaled(usdc, MICRO_USDC_DECIMALS, "EXACT");
    if (usdcAmount <= 0n) {
      throw new LighterValidationError(
        "NEGATIVE_MARGIN_AMOUNT",
        `a margin amount must be positive; the direction is a field, not a sign (received ${JSON.stringify(usdc)})`,
        { field: "USDCAmount" },
      );
    }
    const tx: UnsignedTx = this.#ctx.account.tx.updateMargin(
      {
        marketIndex: i16(this.marketId),
        usdcAmount: i64(usdcAmount),
        direction: u8(direction),
      },
      o?.tx,
    );
    return this.#submit(tx, { ...NO_ORDER_INTEGERS, usdcAmount }, o);
  }

  /**
   * Submit, or build-and-sign for a dry run, and attach {@link Applied} either way.
   *
   * A dry run never consults the nonce source: it signs in caller-managed mode with an explicit
   * nonce, so no counter moves and no request is issued. See the module header for why that is
   * preferred over allocating a real slot and rolling it back.
   */
  async #submit(
    tx: UnsignedTx,
    applied: Applied,
    o: TradeCallOptions | undefined,
  ): Promise<AppliedReceipt> {
    if (o?.dryRun !== true) {
      const receipt: TxReceipt = await this.#ctx.account.send(tx, o?.send);
      return { ...receipt, applied };
    }
    const apiKeyIndex: number | undefined =
      o.send?.apiKeyIndex ?? this.#ctx.account.apiKeyIndexes[0];
    if (apiKeyIndex === undefined) {
      throw new LighterConfigError(
        "a dry run signs with the account's first configured api key, and this account has none",
      );
    }
    const signed: SignedTx = await this.#ctx.account.prepare(tx, {
      nonce: o.send?.nonce ?? 0n,
      apiKeyIndex,
      ...(o.send?.sign !== undefined ? { sign: o.send.sign } : {}),
    });
    return { ...dryRunReceipt(signed, this.#ctx.chainId), applied, dryRun: signed };
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Construction                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Resolve a market and return its trading surface.
 *
 * ```ts
 * const eth = marketHandle(ctx, "ETH");
 * await eth.buy({ size: "0.1", maxSlippage: "0.5%" });
 * ```
 *
 * @throws {LighterConfigError} for an unknown market, or for a bare symbol listed on both the perp
 * and spot books — `{ symbol: "ETH", type: "perp" }` or the market id disambiguates.
 */
export function marketHandle(ctx: MarketContext, query: MarketQuery): MarketHandle {
  return new MarketHandle(ctx, ctx.markets.get(query));
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** `MarginMode` from its name. */
function marginModeOf(name: MarginModeName): number {
  if (name === "cross") return MarginMode.Cross;
  if (name === "isolated") return MarginMode.Isolated;
  throw new LighterValidationError(
    "MARGIN_MODE_INVALID",
    `marginMode must be "cross" or "isolated", received ${JSON.stringify(name)}`,
    { field: "MarginMode" },
  );
}

/**
 * `leverageToImf`, with the leverage half of {@link LeverageOpts} separated from its call options.
 *
 * The narrowing is written out because `LeverageInput` is a union of three single-property shapes
 * and an intersection with the call options widens it: passing the whole object through would let a
 * caller supply both `leverage` and `initialMarginFraction` and have the second silently ignored.
 */
function leverageToImfFor(market: MarketInfo, o: LeverageOpts): LeverageResult {
  if ("initialMarginFraction" in o) {
    return leverageToImf({ initialMarginFraction: o.initialMarginFraction }, market);
  }
  const leverage: string | Fraction = o.leverage;
  // `LeverageInput` spells the decimal-string and exact-rational forms as *separate* union members,
  // so the pair has to be re-narrowed here rather than forwarded as a union. The two arms are
  // identical at run time and are not at compile time, which is the entire point of the union: it is
  // what makes `{ leverage: 3 }` — a fractional binary float — fail to compile (D7).
  return leverageToImf(typeof leverage === "string" ? { leverage } : { leverage }, market);
}

/**
 * The receipt a dry run returns.
 *
 * Every locally known field is real — the hash is the digest that was signed, and `txInfo` is the
 * exact document that would have gone on the wire. `wait()` refuses rather than polling, because
 * there is no transaction at the far end to wait for and a silent 30-second timeout would be a worse
 * answer than a sentence.
 */
function dryRunReceipt(signed: SignedTx, chainId: number): TxReceipt {
  return Object.freeze({
    txHash: normalizeTxHash(txHashHex(signed, chainId)),
    txType: signed.type,
    txInfo: toTxInfo(signed),
    nonce: signed.nonce,
    apiKeyIndex: signed.apiKeyIndex,
    predictedExecutionTimeMs: 0,
    volumeQuotaRemaining: 0n,
    wait: (_opts?: WaitOptions): Promise<TxResult> =>
      Promise.reject(
        new LighterValidationError(
          "DRY_RUN",
          "this transaction was built and signed but never submitted, so there is nothing to wait for",
          { field: "tx_hash" },
        ),
      ),
  });
}
