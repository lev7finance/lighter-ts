/**
 * `order_book/{M}` reconciliation: a price-indexed, always-sorted book with gap detection, plus the
 * watcher that resyncs one when the delta chain breaks.
 *
 * This is the only channel with true delta semantics (`docs/spec/06-websocket.md` §6.3), and the
 * only one where getting the reconciliation wrong produces *silently wrong prices* rather than a
 * visible error. A book that has drifted looks exactly like a book that has not, so every rule
 * below is stated normatively and every deviation is a defect rather than a preference.
 *
 * ## The reference client's defects are this file's requirements
 *
 * `lighter-python/lighter/ws_client.py` is a 172-line demo (`docs/protocol-notes.md` §10.2,
 * `docs/spec/06-websocket.md` §12.1). Five of its behaviours are inverted here:
 *
 * 1. **It stops being sorted.** Snapshots arrive sorted, but its update path *appends* new price
 *    levels to the end of the array. After the first new level `bids[0]` is no longer the best bid,
 *    and mid, spread and slippage are all quietly wrong from then on. Here the sides are
 *    price-keyed `Map`s and {@link OrderBookState.bids} / {@link OrderBookState.asks} are
 *    materialised in genuine price order every time they are read after a mutation.
 * 2. **It has no sequence tracking and no gap detection at all.** A single dropped delta
 *    desynchronises it silently and permanently. Here `nonce`/`begin_nonce` are checked *before*
 *    any mutation, and a break sets `status = 'stale'` and drives a resubscribe.
 * 3. **Price identity is raw string equality**, so `"2064.50"` and `"2064.5"` become two levels.
 *    Here the map key is `toScaled(price, 18)`, so both spellings are one `bigint` key.
 * 4. **Sizes are compared through `float()`**, so a size that should test equal to zero can miss
 *    the tombstone path — the money-through-float hazard of `docs/protocol-notes.md` §9. Here the
 *    zero test is `=== 0n` on an exactly scaled `bigint`. No float parser, no numeric coercion and
 *    no global rounding helper appears anywhere in this file, by rule (`docs/decisions.md` D7) —
 *    and that absence is asserted by a grep in the test suite, not merely intended.
 * 5. **Its merge is O(new × existing)** and iterates a stale copy while mutating the original. Here
 *    a delta costs O(changed levels) of map work plus one sort per *read* of a dirtied side.
 *
 * ## Mutable state, and who owns it
 *
 * One {@link OrderBookState} per watcher (`docs/decisions.md` D8): two price-keyed maps, a
 * nonce/offset pair, dirty flags, memoised sorted arrays and the best-bid/best-ask caches, living
 * for the lifetime of the watcher. **Nothing at module scope** — no clock is read, no timer is
 * armed and no socket is opened by importing this file.
 *
 * ## Evidence status
 *
 * `test/fixtures/ws/capture.json` contains **zero frames**: the wave-0 capture was refused at the
 * WebSocket upgrade from a restricted jurisdiction (API code 20558, `docs/protocol-notes.md` §8.3).
 * So the payload shape this file consumes is `[REF]`/`[DOC]` from `docs/spec/06-websocket.md`
 * §6.2.1 and the continuity rule in §6.3 is `[DOC]` — Lighter's own words, quoted there, but not
 * yet observed on a live socket by us. Every place that depends on an unverified shape carries a
 * comment naming the section, so it can be re-checked the moment a capture lands. Concretely, the
 * unverified assumptions are:
 *
 * - `order_book.nonce` is the sequence **after** the message is applied and `begin_nonce` the one
 *   it applies **on top of** (§6.2.1, §6.3.3).
 * - a snapshot's `nonce` anchors the chain, so the first delta has `begin_nonce == snapshot.nonce`
 *   (§6.3.3).
 * - a numerically-zero `size` in a delta is a tombstone rather than a real zero-size level
 *   (§6.2.1).
 *
 * Everything else is defensive: unknown fields are ignored, absent `offset` and `last_updated_at`
 * leave the previous values in place rather than resetting them to zero, and an unrecognised
 * message never becomes fatal.
 */

import { LighterValidationError } from "../errors.js";
import { divRound, toScaled } from "../util/decimal.js";
import { channels } from "./channels.js";
import type { ChannelSpec } from "./channels.js";
import type { SubscribeOptions, WsSubscriber } from "./client.js";
import type { ChannelEvent, Subscription } from "./subscription.js";
import type { OrderBookMessage, OrderBookPayload, WireInt } from "./types.js";
import { wireInt } from "./types.js";

/* -------------------------------------------------------------------------------------------- */
/* Constants                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Fixed scale for every price and size in the book.
 *
 * 18 covers every documented Lighter field with room to spare (`docs/spec/06-websocket.md` §3.2)
 * and, crucially, makes price *identity* independent of how many trailing zeros the server printed:
 * `"2064.54"` and `"2064.5400"` both scale to `2064540000000000000n` and therefore occupy exactly
 * one map slot. The reference client keys on the raw string and ends up with two levels for one
 * price.
 */
export const ORDER_BOOK_DECIMALS: 18 = 18;

/** Rolling window for the gap-storm escalation, in milliseconds (`docs/spec/06-websocket.md` §6.3.5). */
const GAP_WINDOW_MS: 60_000 = 60_000;

/** Default gaps-per-minute before escalating to a socket reconnect (§6.3.5). */
const DEFAULT_MAX_GAPS_PER_MINUTE: 5 = 5;

/**
 * Default pause between `unsubscribe` and the matching `subscribe` (§6.3.5).
 *
 * Not a politeness delay: re-subscribing before the server has processed the unsubscribe is
 * answered with error 30003 `Already Subscribed` (§5.4), and a resync loop that trips 30003 every
 * time never recovers.
 */
const DEFAULT_RESUBSCRIBE_DELAY_MS: 100 = 100;

/** The reason string handed to {@link WsSubscriber.reconnect} when gaps are persistent. */
const GAP_STORM_REASON: "orderbook-gap-storm" = "orderbook-gap-storm";

/* -------------------------------------------------------------------------------------------- */
/* Types                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * One price level of a reconciled book.
 *
 * `price` and `size` are kept as the server delivered them, so display fidelity survives — a UI
 * that shows `"2064.5400"` should keep showing the market's declared precision rather than a
 * re-rendered `"2064.54"`. All arithmetic uses `priceScaled`/`sizeScaled`, which are exact.
 *
 * Distinct from the wire-level `OrderBookLevel` in `./types.js`, whose `price` and `size` are both
 * optional because a raw frame may omit them. By the time a level reaches this type it has been
 * validated and scaled.
 */
export interface OrderBookLevel {
  /** As delivered, for display fidelity. */
  readonly price: string;
  /** As delivered, for display fidelity. */
  readonly size: string;
  /** `toScaled(price, 18)`. The map key, and the sort key. */
  readonly priceScaled: bigint;
  /** `toScaled(size, 18)`. Never zero for a stored level — zero is a tombstone. */
  readonly sizeScaled: bigint;
}

/**
 * Why a message was not applied, or that it was.
 *
 * The failure reasons are deliberately distinct, because they demand different responses:
 * `'stale'` is a replay and is *normal*, `'not-synced'` means we are already waiting for a
 * snapshot, and `'gap'`/`'crossed'` mean the book has diverged and must be resynchronised.
 */
export type ApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "gap"; readonly expected: bigint; readonly got: bigint }
  | { readonly ok: false; readonly reason: "stale" | "not-synced" | "crossed" };

/** Book lifecycle. `'stale'` means "diverged, awaiting a fresh snapshot" — do not quote off it. */
export type OrderBookStatus = "empty" | "synced" | "stale";

/** Which side of the book an operation reads. */
export type BookSide = "bid" | "ask";

/* -------------------------------------------------------------------------------------------- */
/* Level parsing                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** A wire level before validation. Both fields are optional on the wire. */
interface RawLevel {
  readonly price?: string;
  readonly size?: string;
}

/** A parsed level plus its map key, or a tombstone (`level: undefined`) for that key. */
interface ParsedLevel {
  readonly key: bigint;
  readonly level: OrderBookLevel | undefined;
}

/**
 * One wire level → an exact key and either a level or a tombstone.
 *
 * **This throws, and that is deliberate**, which makes it the one place in the WebSocket layer that
 * departs from "wire parsing must never throw". The alternative — the tolerant fallback used by
 * `./account-assets-stream.ts`, where an unparsable decimal becomes `0n` — is actively dangerous
 * here: `0n` *is* the tombstone, so a malformed size would silently **delete a price level** and
 * leave a book that is wrong in the direction nobody notices. Skipping the level silently is no
 * better; a level dropped from a delta is exactly the desynchronisation this file exists to detect.
 *
 * The throw is safe because {@link OrderBookState.applyUpdate} parses **every** level of a message
 * before mutating anything, so a rejected message leaves the book untouched, and because
 * {@link watchOrderBook} catches it and treats it as a resync trigger rather than letting it escape
 * into a read loop.
 *
 * @throws {LighterValidationError} `WS_ORDER_BOOK_LEVEL_INVALID`
 */
function parseLevel(raw: unknown, side: BookSide, marketIndex: number): ParsedLevel {
  const level: RawLevel | null =
    typeof raw === "object" && raw !== null ? (raw as RawLevel) : null;
  const price: unknown = level?.price;
  const size: unknown = level?.size;
  if (typeof price !== "string" || typeof size !== "string") {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_LEVEL_INVALID",
      `order_book/${String(marketIndex)} ${side} level is missing price or size: ${describe(raw)}`,
      { field: side },
    );
  }
  let priceScaled: bigint;
  let sizeScaled: bigint;
  try {
    // "EXACT", never a rounding mode: at 18 decimals nothing legitimate needs rounding, and a
    // silently rounded price level is the defect class `docs/protocol-notes.md` §9 catalogues.
    priceScaled = toScaled(price, ORDER_BOOK_DECIMALS, "EXACT");
    sizeScaled = toScaled(size, ORDER_BOOK_DECIMALS, "EXACT");
  } catch (cause: unknown) {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_LEVEL_INVALID",
      `order_book/${String(marketIndex)} ${side} level is not a plain decimal: ` +
        `price=${JSON.stringify(price)} size=${JSON.stringify(size)}`,
      { field: side, cause },
    );
  }
  if (sizeScaled < 0n) {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_LEVEL_INVALID",
      `order_book/${String(marketIndex)} ${side} level has a negative size: ${JSON.stringify(size)}`,
      { field: side },
    );
  }
  // Numerically zero is a tombstone, and "0", "0.0", "0.0000" and "0.00000000" are all spellings of
  // it that appear on this wire (`docs/spec/06-websocket.md` §6.2.1, §3.2). `=== 0n` catches every
  // one; a textual comparison catches only the first.
  if (sizeScaled === 0n) return { key: priceScaled, level: undefined };
  return { key: priceScaled, level: { price, size, priceScaled, sizeScaled } };
}

/** Parse every level of one side. Throws before the caller has mutated anything. */
function parseSide(raw: unknown, side: BookSide, marketIndex: number): ParsedLevel[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_LEVEL_INVALID",
      `order_book/${String(marketIndex)} ${side} side is not an array: ${describe(raw)}`,
      { field: side },
    );
  }
  const out: ParsedLevel[] = [];
  for (const entry of raw as readonly unknown[]) out.push(parseLevel(entry, side, marketIndex));
  return out;
}

/** A short, non-throwing rendering of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") return Array.isArray(value) ? "an array" : "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * A required wire integer.
 *
 * @throws {LighterValidationError} when absent or not an integer.
 */
function requiredInt(v: WireInt | undefined, what: string): bigint {
  if (v === undefined || v === null) {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_NONCE_MISSING",
      `order_book payload has no ${what}; the continuity chain cannot be anchored without it ` +
        `(docs/spec/06-websocket.md §6.3)`,
      { field: what },
    );
  }
  return wireInt(v);
}

/**
 * An optional wire integer, falling back to the value already held.
 *
 * `offset` and `last_updated_at` are duplicated at the top level and inside `order_book`
 * (`docs/spec/06-websocket.md` §6.2.1) and the harness fixtures omit `last_updated_at` entirely, so
 * neither may be treated as required. Keeping the previous value beats resetting a monotonic
 * counter to zero.
 */
function optionalInt(primary: WireInt | undefined, secondary: WireInt | undefined, previous: bigint): bigint {
  const chosen: WireInt | undefined = primary ?? secondary;
  if (chosen === undefined || chosen === null) return previous;
  try {
    return wireInt(chosen);
  } catch {
    // Neither field gates anything (§6.3: `offset` is explicitly *not* the continuity key), so a
    // malformed one must not cost us an otherwise-applicable delta.
    return previous;
  }
}

/**
 * Whether an `order_book` frame is a snapshot rather than a delta.
 *
 * Two rules, because the published documentation is inconsistent with itself
 * (`docs/spec/06-websocket.md` §5.3, `[DOC]`): the example for the order-book **snapshot** is
 * labelled "Subscribed" but shows `"type": "update/order_book"`.
 *
 * 1. `subscribed/` prefix ⇒ snapshot. This is what the reference client and its fixtures show.
 * 2. Otherwise, an `order_book` frame carrying **no `begin_nonce`** cannot be a delta, because
 *    `begin_nonce` is by definition the sequence a delta applies on top of.
 *
 * The third clause of §5.3 — "the first message on a fresh subscription" — is applied upstream in
 * `src/ws/protocol.ts`, which reclassifies such a frame to `kind: 'snapshot'` before it reaches a
 * subscriber. This function is the belt-and-braces for a caller driving {@link OrderBookState}
 * directly.
 */
export function isOrderBookSnapshot(msg: OrderBookMessage): boolean {
  const type: unknown = (msg as { type?: unknown } | null)?.type;
  if (typeof type === "string" && type.startsWith("subscribed/")) return true;
  const payload: OrderBookPayload | undefined = (msg as { order_book?: OrderBookPayload } | null)
    ?.order_book;
  return payload === undefined || payload === null || payload.begin_nonce === undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* OrderBookState                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** Ascending by `priceScaled`. `bigint` has no subtraction-comparator shortcut that stays in range. */
function ascending(a: OrderBookLevel, b: OrderBookLevel): number {
  if (a.priceScaled < b.priceScaled) return -1;
  if (a.priceScaled > b.priceScaled) return 1;
  return 0;
}

/** Descending by `priceScaled`. */
function descending(a: OrderBookLevel, b: OrderBookLevel): number {
  return ascending(b, a);
}

/**
 * One market's reconciled order book.
 *
 * A pure state machine: it consumes decoded {@link OrderBookMessage}s and holds no client, no
 * socket, no timer and no clock. That is what makes the whole reconciliation policy — the part that
 * fails silently when it is wrong — testable in-process against a replayed frame sequence.
 *
 * Instances are **mutable and long-lived**: {@link watchOrderBook} yields this same object after
 * every applied message so that a hot loop allocates nothing. Callers that need an immutable
 * snapshot use {@link toJSON}.
 */
export class OrderBookState {
  /** The market this book belongs to. */
  readonly marketIndex: number;

  readonly #bids: Map<bigint, OrderBookLevel> = new Map<bigint, OrderBookLevel>();
  readonly #asks: Map<bigint, OrderBookLevel> = new Map<bigint, OrderBookLevel>();

  #status: OrderBookStatus = "empty";
  #nonce: bigint = 0n;
  #offset: bigint = 0n;
  #lastUpdatedAtUs: bigint = 0n;

  /** Memoised sorted views. `undefined` means "dirty, rebuild on next read". */
  #sortedBids: readonly OrderBookLevel[] | undefined = [];
  #sortedAsks: readonly OrderBookLevel[] | undefined = [];

  /**
   * Incremental top-of-book caches.
   *
   * Maintained on every `set` without a scan, and invalidated only when the level that *is* the
   * current best is tombstoned — the failure mode called out in the issue, where a best-price cache
   * survives the deletion of the level it points at and reports a price that no longer exists. On
   * invalidation the recovery is a single O(n) pass over the map, never a sort.
   */
  #bestBid: OrderBookLevel | undefined = undefined;
  #bestAsk: OrderBookLevel | undefined = undefined;
  #bestBidDirty: boolean = false;
  #bestAskDirty: boolean = false;

  constructor(marketIndex: number) {
    this.marketIndex = marketIndex;
  }

  /* ---- observable state ---------------------------------------------------------------------- */

  /**
   * `'empty'` before the first snapshot, `'synced'` while the chain is intact, `'stale'` once it has
   * broken and until a fresh snapshot arrives.
   *
   * Public on purpose. A strategy must be able to stop quoting the instant the book goes stale
   * rather than quote off a divergent one (`docs/spec/06-websocket.md` §6.3.5). Nothing in this
   * class hides staleness by continuing to serve levels as if they were current — the levels stay
   * readable, and it is `status` that says whether they mean anything.
   */
  get status(): OrderBookStatus {
    return this.#status;
  }

  /** Sequence number **after** the last applied message. The continuity key. */
  get nonce(): bigint {
    return this.#nonce;
  }

  /**
   * The coarser, monotonically non-decreasing version counter.
   *
   * Tracked and exposed, **never gated on**. Only `nonce`/`begin_nonce` detect a gap; the reference
   * paper client stores `offset` and never validates it, which detects nothing
   * (`docs/spec/06-websocket.md` §6.2.1, §6.3).
   */
  get offset(): bigint {
    return this.#offset;
  }

  /** Server-side update time in epoch **microseconds** (`docs/spec/06-websocket.md` §3.4). */
  get lastUpdatedAtUs(): bigint {
    return this.#lastUpdatedAtUs;
  }

  /** Number of distinct bid price levels. */
  get bidCount(): number {
    return this.#bids.size;
  }

  /** Number of distinct ask price levels. */
  get askCount(): number {
    return this.#asks.size;
  }

  /* ---- sorted views -------------------------------------------------------------------------- */

  /**
   * Bids, **strictly descending** by price: `bids[0]` is always the best bid.
   *
   * Rebuilt from the map on the first read after a mutation and memoised until the next one, so a
   * burst of deltas costs one sort rather than one per delta. The returned array is the memo — do
   * not mutate it; the type says `readonly` for that reason.
   */
  get bids(): readonly OrderBookLevel[] {
    let view: readonly OrderBookLevel[] | undefined = this.#sortedBids;
    if (view === undefined) {
      view = [...this.#bids.values()].sort(descending);
      this.#sortedBids = view;
    }
    return view;
  }

  /** Asks, **strictly ascending** by price: `asks[0]` is always the best ask. See {@link bids}. */
  get asks(): readonly OrderBookLevel[] {
    let view: readonly OrderBookLevel[] | undefined = this.#sortedAsks;
    if (view === undefined) {
      view = [...this.#asks.values()].sort(ascending);
      this.#sortedAsks = view;
    }
    return view;
  }

  /** Highest bid, or `undefined` on an empty side. Never triggers a sort. */
  bestBid(): OrderBookLevel | undefined {
    if (this.#bestBidDirty) {
      this.#bestBid = extreme(this.#bids, true);
      this.#bestBidDirty = false;
    }
    return this.#bestBid;
  }

  /** Lowest ask, or `undefined` on an empty side. Never triggers a sort. */
  bestAsk(): OrderBookLevel | undefined {
    if (this.#bestAskDirty) {
      this.#bestAsk = extreme(this.#asks, false);
      this.#bestAskDirty = false;
    }
    return this.#bestAsk;
  }

  /**
   * `(bestBid + bestAsk) / 2` at scale 18, or `undefined` unless both sides have liquidity.
   *
   * Rounds **down** on the odd sum. A mid price is a reference, not a tradable quote, so no
   * slippage protection depends on the direction; it is fixed rather than left to `bigint`'s
   * truncation-toward-zero so that the value is reproducible for a hypothetical negative price.
   */
  midScaled(): bigint | undefined {
    const bid: OrderBookLevel | undefined = this.bestBid();
    const ask: OrderBookLevel | undefined = this.bestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return divRound(bid.priceScaled + ask.priceScaled, 2n, "FLOOR");
  }

  /** `bestAsk − bestBid` at scale 18, or `undefined` unless both sides have liquidity. */
  spreadScaled(): bigint | undefined {
    const bid: OrderBookLevel | undefined = this.bestBid();
    const ask: OrderBookLevel | undefined = this.bestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return ask.priceScaled - bid.priceScaled;
  }

  /**
   * Cumulative base size on `side` at prices at least as good as `limitPriceScaled`.
   *
   * "At least as good" is from the resting order's point of view: bids at or **above** the limit,
   * asks at or **below** it. So `depth('bid', p)` is what a seller could hit without going through
   * `p`, and `depth('ask', p)` is what a buyer could lift without paying more than `p`.
   *
   * Exact: a sum of scale-18 `bigint`s, with no division and therefore no rounding at all.
   */
  depth(side: BookSide, limitPriceScaled: bigint): bigint {
    let total: bigint = 0n;
    if (side === "bid") {
      for (const level of this.bids) {
        if (level.priceScaled < limitPriceScaled) break; // descending: the rest are worse
        total += level.sizeScaled;
      }
    } else {
      for (const level of this.asks) {
        if (level.priceScaled > limitPriceScaled) break; // ascending: the rest are worse
        total += level.sizeScaled;
      }
    }
    return total;
  }

  /**
   * Volume-weighted fill price for a market order that consumes `side`, at scale 18.
   *
   * `vwap('ask', s)` is a **buy** walking the ask side; `vwap('bid', s)` is a **sell** walking the
   * bid side. Returns `undefined` when `baseSizeScaled` is not positive, or when the book is too
   * thin to fill it — never a partial-fill average, which would understate the cost of the order
   * actually requested.
   *
   * **Rounding direction is not free.** The quotient `Σ(price × size) / size` is frequently
   * inexact, and a bare `/` on `bigint` truncates toward zero, which rounds a buy's fill price
   * *down* — loosening the slippage protection built on top of it. So a buy (consuming asks) rounds
   * **up** and a sell (consuming bids) rounds **down** (`docs/decisions.md` D7). Integer end to
   * end: the numerator is scale 36, the denominator scale 18, the quotient scale 18.
   */
  vwap(side: BookSide, baseSizeScaled: bigint): bigint | undefined {
    if (baseSizeScaled <= 0n) return undefined;
    const levels: readonly OrderBookLevel[] = side === "ask" ? this.asks : this.bids;
    let remaining: bigint = baseSizeScaled;
    let cost: bigint = 0n;
    for (const level of levels) {
      const take: bigint = level.sizeScaled < remaining ? level.sizeScaled : remaining;
      cost += level.priceScaled * take;
      remaining -= take;
      if (remaining === 0n) break;
    }
    if (remaining > 0n) return undefined; // the book cannot fill it
    return divRound(cost, baseSizeScaled, side === "ask" ? "CEIL" : "FLOOR");
  }

  /* ---- mutation ------------------------------------------------------------------------------ */

  /**
   * Replace the whole book from a `subscribed/order_book` frame
   * (`docs/spec/06-websocket.md` §6.3.2).
   *
   * Both sides are cleared first: a snapshot is the complete book for both sides, and a documented
   * example showing one side empty means "no liquidity", not "unchanged" (§6.2.1). Levels whose
   * size is numerically zero are **dropped rather than stored**, which is what makes a later
   * tombstone for that price a harmless no-op `delete`.
   *
   * Every level is parsed before anything is cleared, so a malformed frame leaves the previous book
   * intact rather than emptying it.
   *
   * @throws {LighterValidationError} `WS_ORDER_BOOK_LEVEL_INVALID` for a malformed level, or
   *   `WS_ORDER_BOOK_NONCE_MISSING` when the payload carries no `nonce` — without it the delta
   *   chain has no anchor and every subsequent delta would read as a gap.
   */
  applySnapshot(msg: OrderBookMessage): void {
    const payload: OrderBookPayload = requirePayload(msg, this.marketIndex);
    const asks: ParsedLevel[] = parseSide(payload.asks, "ask", this.marketIndex);
    const bids: ParsedLevel[] = parseSide(payload.bids, "bid", this.marketIndex);
    const nonce: bigint = requiredInt(payload.nonce, "nonce");

    this.#bids.clear();
    this.#asks.clear();
    this.#sortedBids = undefined;
    this.#sortedAsks = undefined;
    this.#bestBid = undefined;
    this.#bestAsk = undefined;
    this.#bestBidDirty = false;
    this.#bestAskDirty = false;

    for (const parsed of bids) if (parsed.level !== undefined) this.#store("bid", parsed);
    for (const parsed of asks) if (parsed.level !== undefined) this.#store("ask", parsed);

    this.#nonce = nonce;
    this.#offset = optionalInt(payload.offset, msg.offset, this.#offset);
    this.#lastUpdatedAtUs = optionalInt(
      payload.last_updated_at,
      msg.last_updated_at,
      this.#lastUpdatedAtUs,
    );
    this.#status = "synced";
  }

  /**
   * Apply an `update/order_book` delta (`docs/spec/06-websocket.md` §6.3.3).
   *
   * Three phases, in this order and no other:
   *
   * 1. **Continuity gate, before any mutation.** Applying the levels and *then* noticing
   *    `begin_nonce !== nonce` leaves a half-applied book, which is strictly worse than a detected
   *    gap: it is a divergence that has already been reported as success.
   * 2. **Mutate**, reached only when `begin_nonce === nonce`.
   * 3. **Crossed-book sanity check.** Contiguous nonces are necessary but not sufficient — a
   *    crossed book means something was mis-applied or missed regardless of what the sequence says.
   *
   * The three failure reasons are not interchangeable. `n <= nonce` is a **replay**: dropped
   * silently, `status` untouched, book byte-identical — treating it as a gap would trigger a
   * pointless resubscribe storm on a server that retransmits. Only `begin_nonce !== nonce` with
   * `n > nonce` is a real gap.
   *
   * @throws {LighterValidationError} `WS_ORDER_BOOK_LEVEL_INVALID` / `WS_ORDER_BOOK_NONCE_MISSING`.
   *   Levels are parsed after the gate but before the mutation, so a throw leaves the book
   *   unmodified and `status` unchanged; {@link watchOrderBook} turns it into a resync.
   */
  applyUpdate(msg: OrderBookMessage): ApplyResult {
    const payload: OrderBookPayload = requirePayload(msg, this.marketIndex);

    // ---- 1. continuity gate, before any mutation --------------------------------------------
    if (this.#status !== "synced") return { ok: false, reason: "not-synced" };
    const begin: bigint = requiredInt(payload.begin_nonce, "begin_nonce");
    const next: bigint = requiredInt(payload.nonce, "nonce");
    if (next <= this.#nonce) return { ok: false, reason: "stale" };
    if (begin !== this.#nonce) {
      this.#status = "stale";
      return { ok: false, reason: "gap", expected: this.#nonce, got: begin };
    }

    // ---- 2. mutate ---------------------------------------------------------------------------
    // Parsed in full first: a throw here must not leave half a delta applied.
    const asks: ParsedLevel[] = parseSide(payload.asks, "ask", this.marketIndex);
    const bids: ParsedLevel[] = parseSide(payload.bids, "bid", this.marketIndex);
    for (const parsed of bids) this.#store("bid", parsed);
    for (const parsed of asks) this.#store("ask", parsed);

    this.#nonce = next;
    this.#offset = optionalInt(payload.offset, msg.offset, this.#offset);
    this.#lastUpdatedAtUs = optionalInt(
      payload.last_updated_at,
      msg.last_updated_at,
      this.#lastUpdatedAtUs,
    );

    // ---- 3. crossed-book sanity gate ---------------------------------------------------------
    const bid: OrderBookLevel | undefined = this.bestBid();
    const ask: OrderBookLevel | undefined = this.bestAsk();
    if (bid !== undefined && ask !== undefined && bid.priceScaled >= ask.priceScaled) {
      this.#status = "stale";
      return { ok: false, reason: "crossed" };
    }
    return { ok: true };
  }

  /**
   * Force the book into `'stale'`.
   *
   * Called by {@link watchOrderBook} for the divergence sources the book itself cannot see: a
   * `{kind:'reset'}` from the client (the socket cycled, so the old `nonce` names nothing on the new
   * one), a client-side backpressure drop, and a message that failed to parse. Levels are kept
   * readable — `status` is the signal, and erasing the book would only hide how far it had drifted.
   */
  markStale(): void {
    if (this.#status === "synced") this.#status = "stale";
  }

  /**
   * An immutable, JSON-safe copy: sorted levels, `bigint`s rendered as decimal strings.
   *
   * The iteration API hands out the same mutable instance every time, which is what keeps a hot
   * loop allocation-free. This is the escape hatch for a caller that needs a value it can keep.
   */
  toJSON(): {
    marketIndex: number;
    status: string;
    nonce: string;
    offset: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
  } {
    return {
      marketIndex: this.marketIndex,
      status: this.#status,
      nonce: this.#nonce.toString(),
      offset: this.#offset.toString(),
      bids: this.bids.map((l: OrderBookLevel) => ({ price: l.price, size: l.size })),
      asks: this.asks.map((l: OrderBookLevel) => ({ price: l.price, size: l.size })),
    };
  }

  /* ---- internals ----------------------------------------------------------------------------- */

  /**
   * Insert, replace or tombstone one level, keeping the memoised views and top-of-book caches
   * honest.
   *
   * The invalidation rule is the subtle half. A `set` can only ever improve or replace the best, so
   * it is handled incrementally. A `delete` of the current best invalidates the cache — the case
   * that, left out, makes the book report a price that no longer exists.
   */
  #store(side: BookSide, parsed: ParsedLevel): void {
    const map: Map<bigint, OrderBookLevel> = side === "bid" ? this.#bids : this.#asks;
    if (parsed.level === undefined) {
      // A tombstone for a price that was never stored is a legitimate no-op: snapshots drop
      // zero-size levels rather than storing them (§6.3.2).
      if (!map.delete(parsed.key)) return;
      this.#invalidateView(side);
      this.#invalidateBestOnDelete(side, parsed.key);
      return;
    }
    map.set(parsed.key, parsed.level);
    this.#invalidateView(side);
    this.#improveBest(side, parsed.level);
  }

  #invalidateView(side: BookSide): void {
    if (side === "bid") this.#sortedBids = undefined;
    else this.#sortedAsks = undefined;
  }

  #improveBest(side: BookSide, level: OrderBookLevel): void {
    if (side === "bid") {
      if (this.#bestBidDirty) return;
      const current: OrderBookLevel | undefined = this.#bestBid;
      // `>=` and not `>`: re-setting the level that *is* the best must swap in the new object, or
      // the cache keeps reporting the old size.
      if (current === undefined || level.priceScaled >= current.priceScaled) this.#bestBid = level;
      return;
    }
    if (this.#bestAskDirty) return;
    const current: OrderBookLevel | undefined = this.#bestAsk;
    if (current === undefined || level.priceScaled <= current.priceScaled) this.#bestAsk = level;
  }

  #invalidateBestOnDelete(side: BookSide, key: bigint): void {
    if (side === "bid") {
      if (this.#bestBidDirty) return;
      if (this.#bestBid !== undefined && this.#bestBid.priceScaled === key) {
        this.#bestBid = undefined;
        this.#bestBidDirty = true;
      }
      return;
    }
    if (this.#bestAskDirty) return;
    if (this.#bestAsk !== undefined && this.#bestAsk.priceScaled === key) {
      this.#bestAsk = undefined;
      this.#bestAskDirty = true;
    }
  }
}

/** The extreme level of one side: the highest price when `highest`, else the lowest. One O(n) pass. */
function extreme(
  map: ReadonlyMap<bigint, OrderBookLevel>,
  highest: boolean,
): OrderBookLevel | undefined {
  let best: OrderBookLevel | undefined = undefined;
  for (const level of map.values()) {
    if (best === undefined) {
      best = level;
      continue;
    }
    if (highest ? level.priceScaled > best.priceScaled : level.priceScaled < best.priceScaled) {
      best = level;
    }
  }
  return best;
}

/** The nested `order_book` object, or a named failure. */
function requirePayload(msg: OrderBookMessage, marketIndex: number): OrderBookPayload {
  const payload: unknown = (msg as { order_book?: unknown } | null)?.order_book;
  if (typeof payload !== "object" || payload === null) {
    throw new LighterValidationError(
      "WS_ORDER_BOOK_PAYLOAD_INVALID",
      `order_book/${String(marketIndex)} frame has no order_book payload: ${describe(payload)}`,
      { field: "order_book" },
    );
  }
  return payload as OrderBookPayload;
}

/* -------------------------------------------------------------------------------------------- */
/* watchOrderBook                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** An opaque timer handle. `setTimeout`'s return type differs across the supported runtimes. */
export type TimerHandle = unknown;

/** Injectable timers, so a test never waits on a real clock and a Worker never sees `unref`. */
export interface OrderBookTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Why the watcher marked the book stale. Mirrors `ChannelEvent`'s reset reasons plus our own. */
export type OrderBookFaultReason = "gap" | "crossed" | "reset" | "malformed";

/** Tuning for {@link watchOrderBook}. Every field has a documented default. */
export interface OrderBookWatcherOptions {
  /**
   * Gaps inside a rolling 60 s window before escalating to a full socket reconnect. Default `5`.
   *
   * Escalation fires when the count **exceeds** this, so the default value tolerates five gaps in a
   * minute and escalates on the sixth. Persistent gapping usually indicates the connection rather
   * than the channel (`docs/spec/06-websocket.md` §6.3.5).
   */
  maxGapsPerMinute?: number;
  /**
   * Pause between `unsubscribe` and `subscribe` during a resync. Default `100` ms.
   *
   * An immediate re-subscribe is answered with error 30003 `Already Subscribed` (§5.4), so this is
   * load-bearing rather than cosmetic.
   */
  resubscribeDelayMs?: number;
  /** Called for every detected gap, before the resync begins. Exceptions are swallowed. */
  onGap?: (info: { marketIndex: number; expected: bigint; got: bigint }) => void;
  /** Called whenever the book goes stale, whatever the cause. Exceptions are swallowed. */
  onFault?: (info: { marketIndex: number; reason: OrderBookFaultReason }) => void;
  /** Injected clock in milliseconds, for the rolling gap window. Default `Date.now`. */
  now?: () => number;
  /** Injected timers. Default the global `setTimeout`/`clearTimeout`. */
  timers?: OrderBookTimers;
}

/**
 * A live order book plus its recovery loop.
 *
 * **Iteration yields the same mutable {@link OrderBookState} instance every time** — deliberately,
 * so that a hot consumer allocates nothing per message. Two consequences a caller must know:
 * a value captured from a previous iteration has already changed, and successive yields coalesce
 * when the consumer is slower than the stream (you always see the newest book, never a queue of
 * historical ones). Call {@link OrderBookState.toJSON} for a value that keeps.
 *
 * A yield happens after every successfully applied message **and** on every transition into
 * `'stale'`, because "the book just became untrustworthy" is the single most important thing this
 * stream can tell a strategy (`docs/spec/06-websocket.md` §6.3.5).
 *
 * One consumer at a time; a second `for await` on the same watcher shares — and therefore steals
 * from — the first.
 */
export interface OrderBookWatcher extends AsyncIterable<OrderBookState> {
  /** The live book. Read `book.status` before trusting `book.bids`/`book.asks`. */
  readonly book: OrderBookState;
  /** Idempotent. Unsubscribes, cancels any pending resync timer, and ends iteration. */
  close(): Promise<void>;
}

/**
 * Subscribe to `order_book/{M}`, reconcile it, and resynchronise it when the chain breaks.
 *
 * Attaches through the structural {@link WsSubscriber} seam rather than the concrete client, so the
 * whole recovery loop is drivable by a fake with no socket behind it — which is the only way to
 * test it at all, since a server-side delta drop is not provokable on demand.
 *
 * The subscription is opened with `overflow: 'resubscribe'` **explicitly**. It is also the client's
 * per-family default, and it is restated here because the guarantee is this file's to keep: an
 * order-book delta must never be silently discarded by backpressure, because a hole in the queue is
 * a hole in the nonce chain (`docs/spec/06-websocket.md` §13.6, §14.4).
 *
 * Recovery, identical for all four divergence sources (§6.3.5):
 *
 * 1. `status = 'stale'`, surfaced on the stream and through {@link OrderBookWatcherOptions.onFault}.
 * 2. Every subsequent delta is refused with `'not-synced'` until a fresh snapshot arrives — which
 *    falls out of the gate in {@link OrderBookState.applyUpdate} rather than needing a flag here.
 * 3. `unsubscribe`, wait `resubscribeDelayMs`, `subscribe`.
 * 4. The next snapshot returns the book to `'synced'`.
 * 5. More than `maxGapsPerMinute` gaps inside 60 s escalates to `client.reconnect(...)` instead.
 *
 * **The book is never seeded from REST.** `GET /api/v1/orderBookOrders` returns levels with no
 * `nonce`, so there is no way to splice a REST snapshot into the delta chain without a race
 * (§6.3.5). WS resubscription is the only sound recovery path, and this function has no REST client
 * to be tempted by.
 */
export function watchOrderBook(
  client: WsSubscriber,
  marketIndex: number,
  options?: OrderBookWatcherOptions,
): OrderBookWatcher {
  return new OrderBookWatcherImpl(client, marketIndex, options);
}

/** Default timers, resolved per instance — never read at module scope (`docs/decisions.md` D2). */
function defaultTimers(): OrderBookTimers {
  return {
    setTimeout: (fn: () => void, ms: number): TimerHandle => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: TimerHandle): void => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

/** The concrete watcher. Not exported: {@link watchOrderBook} is the only way to build one. */
class OrderBookWatcherImpl implements OrderBookWatcher {
  readonly book: OrderBookState;

  readonly #client: WsSubscriber;
  readonly #spec: ChannelSpec<OrderBookMessage, OrderBookMessage>;
  readonly #maxGaps: number;
  readonly #resubscribeDelayMs: number;
  readonly #now: () => number;
  readonly #timers: OrderBookTimers;
  readonly #onGap: ((info: { marketIndex: number; expected: bigint; got: bigint }) => void) | undefined;
  readonly #onFault: ((info: { marketIndex: number; reason: OrderBookFaultReason }) => void) | undefined;

  #sub: Subscription<OrderBookMessage, OrderBookMessage> | undefined = undefined;
  #off: (() => void) | undefined = undefined;
  #timer: TimerHandle | undefined = undefined;
  #delayResolve: (() => void) | undefined = undefined;
  #closed: boolean = false;
  #ended: boolean = false;
  #resyncing: boolean = false;

  /** Millisecond timestamps of the gaps still inside the rolling window. */
  readonly #gapTimes: number[] = [];

  /** Single-slot notification: `#pending` says "the book moved", `#wake` resumes the consumer. */
  #pending: boolean = false;
  #wake: (() => void) | undefined = undefined;

  constructor(client: WsSubscriber, marketIndex: number, options?: OrderBookWatcherOptions) {
    // Throws `WS_CHANNEL_INDEX_INVALID` for a non-integer or negative index, before any subscribe.
    this.#spec = channels.orderBook(marketIndex);
    this.#client = client;
    this.book = new OrderBookState(marketIndex);
    this.#maxGaps = options?.maxGapsPerMinute ?? DEFAULT_MAX_GAPS_PER_MINUTE;
    this.#resubscribeDelayMs = options?.resubscribeDelayMs ?? DEFAULT_RESUBSCRIBE_DELAY_MS;
    this.#now = options?.now ?? ((): number => Date.now());
    this.#timers = options?.timers ?? defaultTimers();
    this.#onGap = options?.onGap;
    this.#onFault = options?.onFault;
    this.#subscribe();
  }

  /* ---- consumption --------------------------------------------------------------------------- */

  async *[Symbol.asyncIterator](): AsyncIterator<OrderBookState> {
    for (;;) {
      if (this.#pending) {
        this.#pending = false;
        yield this.book;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve: () => void): void => {
        this.#wake = resolve;
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    const off: (() => void) | undefined = this.#off;
    this.#off = undefined;
    if (off !== undefined) {
      try {
        off();
      } catch {
        /* an unregister that throws must not prevent the rest of teardown */
      }
    }
    const sub: Subscription<OrderBookMessage, OrderBookMessage> | undefined = this.#sub;
    this.#sub = undefined;
    if (sub !== undefined) {
      try {
        await sub.close();
      } catch {
        /* `Subscription.close()` is documented never to reject; belt and braces */
      }
    }
    this.#finish();
  }

  /* ---- subscription plumbing ------------------------------------------------------------------ */

  #subscribe(): void {
    if (this.#closed) return;
    let sub: Subscription<OrderBookMessage, OrderBookMessage>;
    try {
      const opts: SubscribeOptions = { overflow: "resubscribe" };
      sub = this.#client.subscribe<OrderBookMessage, OrderBookMessage>(this.#spec, opts);
    } catch {
      // The client is closed, rate-limited, or already holds this key. None of those recover by
      // retrying on a timer, so the watcher ends rather than spinning.
      this.book.markStale();
      this.#fire("reset");
      this.#finish();
      return;
    }
    this.#sub = sub;
    this.#off = sub.on((event: ChannelEvent<OrderBookMessage, OrderBookMessage>): void => {
      this.#onEvent(event);
    });
  }

  #onEvent(event: ChannelEvent<OrderBookMessage, OrderBookMessage>): void {
    if (this.#closed) return;
    switch (event.kind) {
      case "snapshot":
        this.#applySnapshot(event.data);
        return;
      case "update":
        // The published snapshot example is mislabelled `update/order_book` (§5.3). `protocol.ts`
        // already reclassifies the frames it can; this catches the rest.
        if (isOrderBookSnapshot(event.data)) this.#applySnapshot(event.data);
        else this.#applyUpdate(event.data);
        return;
      case "reset":
        // Every reason the client emits — `reconnect`, `resubscribe`, `auth-refresh` — means a
        // fresh snapshot is already on its way, so this marks the book stale and waits. It must not
        // start a resync of its own: the client owns the resubscribe in all three cases.
        this.book.markStale();
        this.#fire("reset");
        this.#notify();
        return;
      case "error":
        // Non-fatal server errors (a transient 30xx) leave the subscription alive; a fatal one has
        // already terminated it, so keep the book but stop pretending it is live. An unrecognised
        // error is never made fatal here — forward compatibility, defect 5 of the reference client.
        if (event.fatal) {
          this.book.markStale();
          this.#fire("reset");
          this.#notify();
          this.#finish();
        }
        return;
      default:
        // An event kind added upstream must not take this watcher down.
        return;
    }
  }

  #applySnapshot(msg: OrderBookMessage): void {
    try {
      this.book.applySnapshot(msg);
    } catch {
      // A snapshot we cannot parse is not recoverable by applying more deltas on top of it.
      this.#fault("malformed");
      return;
    }
    // The gap window is deliberately **not** cleared here. Every recovery ends in a snapshot, so
    // clearing on one would mean the count never reached two and the escalation in §6.3.5 could
    // never fire. Decay is the rolling 60 s window's job and nothing else's.
    this.#notify();
  }

  #applyUpdate(msg: OrderBookMessage): void {
    let result: ApplyResult;
    try {
      result = this.book.applyUpdate(msg);
    } catch {
      this.book.markStale();
      this.#fault("malformed");
      return;
    }
    if (result.ok) {
      this.#notify();
      return;
    }
    switch (result.reason) {
      case "stale":
      case "not-synced":
        // A replay, or a delta arriving while we already await a snapshot. Both are normal and
        // neither is a divergence: dropped silently, no resync, no gap counted.
        return;
      case "gap":
        if (this.#onGap !== undefined) {
          try {
            this.#onGap({
              marketIndex: this.book.marketIndex,
              expected: result.expected,
              got: result.got,
            });
          } catch {
            /* a caller's callback must not break recovery */
          }
        }
        this.#fault("gap");
        return;
      case "crossed":
        this.#fault("crossed");
        return;
      default:
        return;
    }
  }

  /* ---- recovery -------------------------------------------------------------------------------- */

  /**
   * One divergence: surface it, count it against the rolling window, and either resubscribe this
   * channel or — when gaps are persistent — cycle the whole socket.
   */
  #fault(reason: OrderBookFaultReason): void {
    this.#fire(reason);
    this.#notify();
    if (this.#closed) return;

    const at: number = this.#now();
    this.#gapTimes.push(at);
    while (this.#gapTimes.length > 0 && at - (this.#gapTimes[0] as number) >= GAP_WINDOW_MS) {
      this.#gapTimes.shift();
    }
    if (this.#gapTimes.length > this.#maxGaps) {
      // Reset the window so a seventh gap does not immediately escalate again while the socket is
      // still cycling; the reconnect will deliver a `reset` and a fresh snapshot on its own.
      this.#gapTimes.length = 0;
      try {
        this.#client.reconnect(GAP_STORM_REASON);
      } catch {
        /* a client that refuses to reconnect leaves the book stale, which is already surfaced */
      }
      return;
    }
    void this.#resync();
  }

  /** `unsubscribe` → wait → `subscribe`. At most one in flight; a fault during one is ignored. */
  async #resync(): Promise<void> {
    if (this.#resyncing || this.#closed) return;
    this.#resyncing = true;
    try {
      const off: (() => void) | undefined = this.#off;
      this.#off = undefined;
      const sub: Subscription<OrderBookMessage, OrderBookMessage> | undefined = this.#sub;
      this.#sub = undefined;
      if (off !== undefined) {
        try {
          off();
        } catch {
          /* ignored */
        }
      }
      if (sub !== undefined) {
        try {
          await sub.close();
        } catch {
          /* ignored */
        }
      }
      if (this.#closed) return;
      await this.#delay(this.#resubscribeDelayMs);
      if (this.#closed) return;
      this.#subscribe();
    } finally {
      this.#resyncing = false;
    }
  }

  /**
   * The resubscribe pause, cancellable.
   *
   * `close()` clears the timer *and* resolves the promise. Clearing alone would leave `#resync`
   * suspended forever on an awaited promise that can never settle — a leak that only shows up as a
   * `finally` block that never runs, which is exactly the kind of thing a test does not notice.
   */
  #delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      this.#delayResolve = resolve;
      this.#timer = this.#timers.setTimeout((): void => {
        this.#timer = undefined;
        this.#delayResolve = undefined;
        resolve();
      }, ms);
    });
  }

  #cancelTimer(): void {
    const handle: TimerHandle | undefined = this.#timer;
    this.#timer = undefined;
    if (handle !== undefined) {
      try {
        this.#timers.clearTimeout(handle);
      } catch {
        /* ignored */
      }
    }
    const resolve: (() => void) | undefined = this.#delayResolve;
    this.#delayResolve = undefined;
    if (resolve !== undefined) resolve();
  }

  /* ---- notification ---------------------------------------------------------------------------- */

  #fire(reason: OrderBookFaultReason): void {
    if (this.#onFault === undefined) return;
    try {
      this.#onFault({ marketIndex: this.book.marketIndex, reason });
    } catch {
      /* a caller's callback must not break recovery */
    }
  }

  #notify(): void {
    this.#pending = true;
    const wake: (() => void) | undefined = this.#wake;
    this.#wake = undefined;
    if (wake !== undefined) wake();
  }

  /** End iteration after anything already pending has been observed. */
  #finish(): void {
    this.#ended = true;
    const wake: (() => void) | undefined = this.#wake;
    this.#wake = undefined;
    if (wake !== undefined) wake();
  }
}
