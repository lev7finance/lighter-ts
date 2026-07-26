/**
 * `src/ws/orderbook.ts` — reconciliation, gap detection and the recovery loop.
 *
 * Nothing here touches a network. The state machine is driven by handing it decoded frames, and the
 * watcher is driven by a hand-built {@link FakeSubscriber} implementing the structural `WsSubscriber`
 * seam plus injected timers and clock, so every assertion about the recovery loop is deterministic
 * and none of them waits on a real 100 ms.
 *
 * The `order_book/1` frame chain from `test/ws-harness.ts` is used verbatim where it fits: it is the
 * one place a snapshot-plus-four-deltas sequence with a real `begin_nonce`/`nonce` chain already
 * exists, and it is frozen, so a mutation here could not leak into another test file.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import type { ChannelSpec } from "../../src/ws/channels.js";
import type { SubscribeOptions, WsClientState, WsSubscriber } from "../../src/ws/client.js";
import {
  isOrderBookSnapshot,
  ORDER_BOOK_DECIMALS,
  OrderBookState,
  watchOrderBook,
} from "../../src/ws/orderbook.js";
import type {
  ApplyResult,
  OrderBookFaultReason,
  OrderBookLevel,
  OrderBookTimers,
  OrderBookWatcher,
  TimerHandle,
} from "../../src/ws/orderbook.js";
import type { ChannelEvent, Subscription } from "../../src/ws/subscription.js";
import type { OrderBookMessage } from "../../src/ws/types.js";
import { BUILTIN_FIXTURES } from "../ws-harness.js";

/* -------------------------------------------------------------------------------------------- */
/* Frame builders                                                                                 */
/* -------------------------------------------------------------------------------------------- */

type Pair = readonly [price: string, size: string];

function levels(pairs: readonly Pair[]): { price: string; size: string }[] {
  return pairs.map((p: Pair) => ({ price: p[0], size: p[1] }));
}

function snapshotFrame(
  market: number,
  nonce: number,
  bids: readonly Pair[],
  asks: readonly Pair[],
): OrderBookMessage {
  return {
    type: "subscribed/order_book",
    channel: `order_book:${String(market)}`,
    offset: nonce,
    order_book: {
      code: 0,
      asks: levels(asks),
      bids: levels(bids),
      offset: nonce,
      nonce,
      begin_nonce: nonce,
    },
  };
}

function deltaFrame(
  market: number,
  begin: number,
  nonce: number,
  bids: readonly Pair[],
  asks: readonly Pair[],
): OrderBookMessage {
  return {
    type: "update/order_book",
    channel: `order_book:${String(market)}`,
    offset: nonce,
    order_book: {
      code: 0,
      asks: levels(asks),
      bids: levels(bids),
      offset: nonce,
      nonce,
      begin_nonce: begin,
    },
  };
}

/** The harness's `order_book/1` chain: one snapshot at nonce 10 000 plus four chained deltas. */
const CHAIN: readonly OrderBookMessage[] = BUILTIN_FIXTURES[
  "order_book/1"
] as unknown as readonly OrderBookMessage[];

/** Scale a decimal string the same way the module does, so expectations stay readable. */
function s(v: string): bigint {
  const dot: number = v.indexOf(".");
  const digits: string = dot < 0 ? v : v.slice(0, dot) + v.slice(dot + 1);
  const frac: number = dot < 0 ? 0 : v.length - dot - 1;
  return BigInt(digits) * 10n ** BigInt(ORDER_BOOK_DECIMALS - frac);
}

function shape(book: OrderBookState): { bids: string[]; asks: string[] } {
  return {
    bids: book.bids.map((l: OrderBookLevel) => `${l.price}@${l.size}`),
    asks: book.asks.map((l: OrderBookLevel) => `${l.price}@${l.size}`),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* State: snapshots and sorting                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe("OrderBookState — snapshot", () => {
  test("an empty book reports nothing and is not synced", () => {
    const book: OrderBookState = new OrderBookState(1);
    expect(book.status).toBe("empty");
    expect(book.marketIndex).toBe(1);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(book.bestBid()).toBeUndefined();
    expect(book.bestAsk()).toBeUndefined();
    expect(book.midScaled()).toBeUndefined();
    expect(book.spreadScaled()).toBeUndefined();
    expect(book.vwap("ask", s("1"))).toBeUndefined();
    expect(book.depth("bid", 0n)).toBe(0n);
  });

  test("a snapshot sorts both sides and anchors the chain", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);

    expect(book.status).toBe("synced");
    expect(book.nonce).toBe(10_000n);
    expect(book.offset).toBe(10_000n);
    expect(shape(book)).toEqual({
      bids: ["2499.90@2.0000", "2499.80@3.2500"],
      asks: ["2500.10@1.5000", "2500.20@0.7500"],
    });
    expect(book.bestBid()?.price).toBe("2499.90");
    expect(book.bestAsk()?.price).toBe("2500.10");
    expect(book.spreadScaled()).toBe(s("0.20"));
    expect(book.midScaled()).toBe(s("2500.00"));
  });

  test("a snapshot arriving out of price order is stored sorted", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(
      snapshotFrame(
        0,
        1,
        [
          ["99.00", "1"],
          ["101.00", "2"],
          ["100.00", "3"],
        ],
        [
          ["105.00", "1"],
          ["103.00", "2"],
          ["104.00", "3"],
        ],
      ),
    );
    expect(book.bids.map((l: OrderBookLevel) => l.price)).toEqual(["101.00", "100.00", "99.00"]);
    expect(book.asks.map((l: OrderBookLevel) => l.price)).toEqual(["103.00", "104.00", "105.00"]);
  });

  test("zero-size levels in a snapshot are dropped, not stored", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(
      snapshotFrame(
        0,
        1,
        [
          ["100.00", "1"],
          ["99.00", "0.0000"],
        ],
        [["101.00", "1"]],
      ),
    );
    expect(book.bidCount).toBe(1);
    expect(book.bids[0]?.price).toBe("100.00");

    // …which is what makes a later tombstone for that price a harmless no-op.
    const before: string = JSON.stringify(book.toJSON());
    expect(book.applyUpdate(deltaFrame(0, 1, 2, [["99.00", "0"]], []))).toEqual({ ok: true });
    expect(JSON.stringify({ ...book.toJSON(), nonce: "1", offset: "1" })).toBe(before);
  });

  test("a snapshot replaces both sides wholesale", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    book.applySnapshot(snapshotFrame(0, 7, [["90.00", "5"]], []));
    expect(shape(book)).toEqual({ bids: ["90.00@5"], asks: [] });
    expect(book.nonce).toBe(7n);
    expect(book.bestAsk()).toBeUndefined();
  });

  test("a snapshot with no nonce is refused and leaves the previous book intact", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    const bad: OrderBookMessage = {
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { code: 0, asks: [], bids: [] },
    };
    expect(() => book.applySnapshot(bad)).toThrow(LighterValidationError);
    expect(shape(book)).toEqual({ bids: ["100.00@1"], asks: ["101.00@1"] });
    expect(book.nonce).toBe(1n);
  });

  test("a malformed level is refused before anything is cleared", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    const bad: OrderBookMessage = snapshotFrame(0, 2, [["100.00", "1e3"]], []);
    expect(() => book.applySnapshot(bad)).toThrow(LighterValidationError);
    expect(shape(book)).toEqual({ bids: ["100.00@1"], asks: ["101.00@1"] });
    expect(book.nonce).toBe(1n);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* State: deltas and the continuity gate                                                          */
/* -------------------------------------------------------------------------------------------- */

describe("OrderBookState — deltas", () => {
  test("the harness chain replays to the expected final book", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    for (const frame of CHAIN.slice(1)) {
      expect(book.applyUpdate(frame)).toEqual({ ok: true });
    }
    expect(book.status).toBe("synced");
    expect(book.nonce).toBe(10_004n);
    expect(book.offset).toBe(10_004n);
    expect(shape(book)).toEqual({
      bids: ["2499.80@3.2500", "2499.70@4.0000"],
      asks: ["2500.10@1.2500", "2500.20@0.7500", "2500.30@0.2500"],
    });
    // The reference client appends new levels, so its `bids[0]` would still be the deleted 2499.90.
    expect(book.bestBid()?.price).toBe("2499.80");
    expect(book.bestAsk()?.price).toBe("2500.10");
  });

  test("dropping any non-final delta yields exactly one gap, naming the surrounding nonces", () => {
    const deltas: readonly OrderBookMessage[] = CHAIN.slice(1);
    for (let drop: number = 0; drop < deltas.length - 1; drop += 1) {
      const book: OrderBookState = new OrderBookState(1);
      book.applySnapshot(CHAIN[0] as OrderBookMessage);

      const gaps: ApplyResult[] = [];
      const others: ApplyResult[] = [];
      deltas.forEach((frame: OrderBookMessage, i: number): void => {
        if (i === drop) return;
        const r: ApplyResult = book.applyUpdate(frame);
        if (!r.ok && r.reason === "gap") gaps.push(r);
        else others.push(r);
      });

      expect(gaps).toHaveLength(1);
      const gap: ApplyResult = gaps[0] as ApplyResult;
      expect(gap).toEqual({
        ok: false,
        reason: "gap",
        // `expected` is where the book stopped, `got` is what the surviving delta asked for.
        expected: BigInt(10_000 + drop),
        got: BigInt(10_000 + drop + 1),
      });
      expect(book.status).toBe("stale");
      // Everything after the gap is refused as `not-synced`, never half-applied.
      expect(
        others.slice(drop).every((r: ApplyResult) => !r.ok && r.reason === "not-synced"),
      ).toBe(true);

      // Recovery: a fresh snapshot re-anchors the chain and a full replay lands on the same book.
      book.applySnapshot(CHAIN[0] as OrderBookMessage);
      for (const frame of deltas) expect(book.applyUpdate(frame)).toEqual({ ok: true });
      expect(shape(book)).toEqual({
        bids: ["2499.80@3.2500", "2499.70@4.0000"],
        asks: ["2500.10@1.2500", "2500.20@0.7500", "2500.30@0.2500"],
      });
    }
  });

  test("dropping the final delta is undetectable until the next one arrives", () => {
    // Stated as a property, not an omission: a hole at the tail of the stream leaves the chain
    // internally consistent. Only the *next* delta reveals it.
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    for (const frame of CHAIN.slice(1, CHAIN.length - 1)) {
      expect(book.applyUpdate(frame)).toEqual({ ok: true });
    }
    expect(book.status).toBe("synced");
    expect(book.nonce).toBe(10_003n);

    const next: OrderBookMessage = deltaFrame(1, 10_004, 10_005, [], [["2500.40", "1"]]);
    expect(book.applyUpdate(next)).toEqual({
      ok: false,
      reason: "gap",
      expected: 10_003n,
      got: 10_004n,
    });
  });

  test("a duplicate delta is a replay: dropped silently, book byte-identical, still synced", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    expect(book.applyUpdate(CHAIN[1] as OrderBookMessage)).toEqual({ ok: true });
    const before: string = JSON.stringify(book.toJSON());

    expect(book.applyUpdate(CHAIN[1] as OrderBookMessage)).toEqual({ ok: false, reason: "stale" });
    // …and an even older one.
    expect(
      book.applyUpdate(deltaFrame(1, 9_998, 9_999, [["2499.00", "9"]], [])),
    ).toEqual({ ok: false, reason: "stale" });

    expect(JSON.stringify(book.toJSON())).toBe(before);
    expect(book.status).toBe("synced");
    expect(book.nonce).toBe(10_001n);
  });

  test("an out-of-order delta gaps, and everything after it is refused until a snapshot", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);

    expect(book.applyUpdate(CHAIN[2] as OrderBookMessage)).toEqual({
      ok: false,
      reason: "gap",
      expected: 10_000n,
      got: 10_001n,
    });
    expect(book.status).toBe("stale");
    // The gapping delta itself was not applied.
    expect(book.bidCount).toBe(2);

    expect(book.applyUpdate(CHAIN[1] as OrderBookMessage)).toEqual({
      ok: false,
      reason: "not-synced",
    });
    expect(book.applyUpdate(CHAIN[3] as OrderBookMessage)).toEqual({
      ok: false,
      reason: "not-synced",
    });
    expect(book.status).toBe("stale");

    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    expect(book.status).toBe("synced");
    expect(book.applyUpdate(CHAIN[1] as OrderBookMessage)).toEqual({ ok: true });
  });

  test("a delta that crosses the book is reported and goes stale", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    // A bid above the best ask: nonces are contiguous, so only the sanity gate catches this.
    expect(book.applyUpdate(deltaFrame(1, 10_000, 10_001, [["2500.50", "1"]], []))).toEqual({
      ok: false,
      reason: "crossed",
    });
    expect(book.status).toBe("stale");
    // The mutation is kept — `status` is the signal, and erasing it would hide how far it drifted.
    expect(book.bestBid()?.price).toBe("2500.50");
  });

  test("a touching book (bid === ask) counts as crossed", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    expect(book.applyUpdate(deltaFrame(0, 1, 2, [["101.00", "1"]], []))).toEqual({
      ok: false,
      reason: "crossed",
    });
    expect(book.status).toBe("stale");
  });

  test("a delta before any snapshot is refused", () => {
    const book: OrderBookState = new OrderBookState(1);
    expect(book.applyUpdate(CHAIN[1] as OrderBookMessage)).toEqual({
      ok: false,
      reason: "not-synced",
    });
    expect(book.status).toBe("empty");
  });

  test("the gate runs before the mutation: a gapping delta leaves the book untouched", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    const before: string = JSON.stringify(book.toJSON());
    book.applyUpdate(deltaFrame(0, 5, 6, [["100.00", "0"]], [["102.00", "3"]]));
    expect(JSON.stringify(book.toJSON())).toBe(before.replace('"status":"synced"', '"status":"stale"'));
  });

  test("a malformed level in a delta throws and leaves the book unmodified", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    const bad: OrderBookMessage = deltaFrame(0, 1, 2, [], [["102.00", "abc"]]);
    expect(() => book.applyUpdate(bad)).toThrow(LighterValidationError);
    expect(shape(book)).toEqual({ bids: ["100.00@1"], asks: ["101.00@1"] });
    expect(book.nonce).toBe(1n);
    expect(book.status).toBe("synced");

    // A negative size is refused too: it is neither a tombstone nor a level.
    expect(() => book.applyUpdate(deltaFrame(0, 1, 2, [], [["102.00", "-1"]]))).toThrow(
      LighterValidationError,
    );
  });

  test("absent offset and last_updated_at keep the previous values", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot({
      type: "subscribed/order_book",
      channel: "order_book:0",
      order_book: { code: 0, asks: [], bids: [], nonce: 1, offset: 42, last_updated_at: 1_700n * 1n },
    } as unknown as OrderBookMessage);
    expect(book.offset).toBe(42n);
    expect(book.lastUpdatedAtUs).toBe(1_700n);

    // The harness fixtures carry no `last_updated_at` at all; it must not reset to zero.
    expect(
      book.applyUpdate({
        type: "update/order_book",
        channel: "order_book:0",
        order_book: { code: 0, asks: [], bids: [], nonce: 2, begin_nonce: 1 },
      } as unknown as OrderBookMessage),
    ).toEqual({ ok: true });
    expect(book.offset).toBe(42n);
    expect(book.lastUpdatedAtUs).toBe(1_700n);
  });

  test("a frame with no order_book payload is refused", () => {
    const book: OrderBookState = new OrderBookState(0);
    expect(() =>
      book.applySnapshot({ type: "subscribed/order_book", channel: "order_book:0" } as unknown as OrderBookMessage),
    ).toThrow(LighterValidationError);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Exact decimals: tombstones and price identity                                                  */
/* -------------------------------------------------------------------------------------------- */

describe("OrderBookState — exact decimal handling", () => {
  for (const zero of ["0", "0.0", "0.0000", "0.00000000"]) {
    test(`size ${JSON.stringify(zero)} removes the level`, () => {
      const book: OrderBookState = new OrderBookState(0);
      book.applySnapshot(
        snapshotFrame(
          0,
          1,
          [
            ["100.00", "1"],
            ["99.00", "1"],
          ],
          [["101.00", "1"]],
        ),
      );
      expect(book.applyUpdate(deltaFrame(0, 1, 2, [["100.00", zero]], []))).toEqual({ ok: true });
      expect(book.bidCount).toBe(1);
      expect(book.bids[0]?.price).toBe("99.00");
      expect(book.bestBid()?.price).toBe("99.00");
    });
  }

  test("a tombstone for a price that was never stored is a no-op", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["100.00", "1"]], [["101.00", "1"]]));
    const before: string = JSON.stringify(book.toJSON());
    expect(book.applyUpdate(deltaFrame(0, 1, 2, [["1.00", "0.000"]], []))).toEqual({ ok: true });
    expect(JSON.stringify({ ...book.toJSON(), nonce: "1", offset: "1" })).toBe(before);
  });

  test('"2064.54" and "2064.5400" are one level, and the newest spelling is displayed', () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [["2064.54", "1.0"]], [["2100.00", "1"]]));
    expect(book.bidCount).toBe(1);

    expect(book.applyUpdate(deltaFrame(0, 1, 2, [["2064.5400", "2.50"]], []))).toEqual({ ok: true });
    expect(book.bidCount).toBe(1);
    expect(book.bids[0]?.price).toBe("2064.5400");
    expect(book.bids[0]?.size).toBe("2.50");
    expect(book.bestBid()?.price).toBe("2064.5400");
    expect(book.bestBid()?.size).toBe("2.50");
    expect(book.bids[0]?.priceScaled).toBe(s("2064.54"));

    // …and either spelling tombstones it.
    expect(book.applyUpdate(deltaFrame(0, 2, 3, [["2064.5", "0"]], []))).toEqual({ ok: true });
    expect(book.bidCount).toBe(1); // "2064.5" is a *different* price, so nothing was removed
    expect(book.applyUpdate(deltaFrame(0, 3, 4, [["2064.540000", "0.00"]], []))).toEqual({
      ok: true,
    });
    expect(book.bidCount).toBe(0);
    expect(book.bestBid()).toBeUndefined();
  });

  test("a snapshot with two spellings of one price collapses to one level", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(
      snapshotFrame(
        0,
        1,
        [
          ["2064.50", "1"],
          ["2064.5", "2"],
        ],
        [],
      ),
    );
    expect(book.bidCount).toBe(1);
    expect(book.bids[0]?.size).toBe("2");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Sorting and top-of-book invalidation                                                           */
/* -------------------------------------------------------------------------------------------- */

describe("OrderBookState — sorted views and best-price caches", () => {
  test("a delta inserting new inside levels moves bids[0] / asks[0]", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    // Read the views first so the memo is warm — a stale memo is the failure this guards.
    expect(book.bids[0]?.price).toBe("2499.90");
    expect(book.asks[0]?.price).toBe("2500.10");

    expect(
      book.applyUpdate(
        deltaFrame(1, 10_000, 10_001, [["2499.95", "1.0"]], [["2500.05", "2.0"]]),
      ),
    ).toEqual({ ok: true });

    expect(book.bids[0]?.price).toBe("2499.95");
    expect(book.asks[0]?.price).toBe("2500.05");
    expect(book.bestBid()?.price).toBe("2499.95");
    expect(book.bestAsk()?.price).toBe("2500.05");

    // The whole array is ordered, not merely its head — the reference appends and fails here.
    const bidPrices: readonly bigint[] = book.bids.map((l: OrderBookLevel) => l.priceScaled);
    const askPrices: readonly bigint[] = book.asks.map((l: OrderBookLevel) => l.priceScaled);
    for (let i: number = 1; i < bidPrices.length; i += 1) {
      expect((bidPrices[i] as bigint) < (bidPrices[i - 1] as bigint)).toBe(true);
    }
    for (let i: number = 1; i < askPrices.length; i += 1) {
      expect((askPrices[i] as bigint) > (askPrices[i - 1] as bigint)).toBe(true);
    }
  });

  test("deleting the current best bid updates bestBid() on the next read", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    expect(book.bestBid()?.price).toBe("2499.90"); // warm the cache

    expect(book.applyUpdate(deltaFrame(1, 10_000, 10_001, [["2499.90", "0.0000"]], []))).toEqual({
      ok: true,
    });
    expect(book.bestBid()?.price).toBe("2499.80");
    expect(book.bids[0]?.price).toBe("2499.80");

    // …and again, down to nothing.
    expect(book.applyUpdate(deltaFrame(1, 10_001, 10_002, [["2499.80", "0"]], []))).toEqual({
      ok: true,
    });
    expect(book.bestBid()).toBeUndefined();
    expect(book.midScaled()).toBeUndefined();
  });

  test("deleting the current best ask updates bestAsk() on the next read", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    expect(book.bestAsk()?.price).toBe("2500.10");
    expect(book.applyUpdate(deltaFrame(1, 10_000, 10_001, [], [["2500.10", "0"]]))).toEqual({
      ok: true,
    });
    expect(book.bestAsk()?.price).toBe("2500.20");
  });

  test("resizing the level that is the best swaps in the new size", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    expect(book.bestAsk()?.size).toBe("1.5000");
    expect(book.applyUpdate(deltaFrame(1, 10_000, 10_001, [], [["2500.10", "0.0001"]]))).toEqual({
      ok: true,
    });
    expect(book.bestAsk()?.size).toBe("0.0001");
    expect(book.bestBid()?.size).toBe("2.0000");
  });

  test("toJSON is an immutable, sorted copy", () => {
    const book: OrderBookState = new OrderBookState(1);
    book.applySnapshot(CHAIN[0] as OrderBookMessage);
    const json = book.toJSON();
    expect(json).toEqual({
      marketIndex: 1,
      status: "synced",
      nonce: "10000",
      offset: "10000",
      bids: [
        { price: "2499.90", size: "2.0000" },
        { price: "2499.80", size: "3.2500" },
      ],
      asks: [
        { price: "2500.10", size: "1.5000" },
        { price: "2500.20", size: "0.7500" },
      ],
    });
    // A captured copy does not move when the book does.
    book.applyUpdate(CHAIN[1] as OrderBookMessage);
    expect(json.asks).toHaveLength(2);
    expect(JSON.stringify(book)).toContain('"nonce":"10001"');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* depth and vwap                                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe("OrderBookState — depth and vwap", () => {
  function ladder(): OrderBookState {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(
      snapshotFrame(
        0,
        1,
        [
          ["100.00", "1"],
          ["99.00", "1"],
          ["98.00", "2"],
        ],
        [
          ["101.00", "1"],
          ["102.00", "1"],
          ["103.00", "2"],
        ],
      ),
    );
    return book;
  }

  test("depth sums exactly, on the good side of the limit only", () => {
    const book: OrderBookState = ladder();
    expect(book.depth("bid", s("100.00"))).toBe(s("1"));
    expect(book.depth("bid", s("99.00"))).toBe(s("2"));
    expect(book.depth("bid", s("98.00"))).toBe(s("4"));
    expect(book.depth("bid", s("97.00"))).toBe(s("4"));
    expect(book.depth("bid", s("100.01"))).toBe(0n);

    expect(book.depth("ask", s("101.00"))).toBe(s("1"));
    expect(book.depth("ask", s("102.50"))).toBe(s("2"));
    expect(book.depth("ask", s("103.00"))).toBe(s("4"));
    expect(book.depth("ask", s("100.00"))).toBe(0n);
  });

  test("vwap fills exactly when the quotient is exact", () => {
    const book: OrderBookState = ladder();
    expect(book.vwap("ask", s("1"))).toBe(s("101.00"));
    expect(book.vwap("ask", s("2"))).toBe(s("101.50"));
    expect(book.vwap("bid", s("1"))).toBe(s("100.00"));
    expect(book.vwap("bid", s("2"))).toBe(s("99.50"));
  });

  test("vwap returns undefined when the book cannot fill the size", () => {
    const book: OrderBookState = ladder();
    expect(book.vwap("ask", s("4"))).toBe(s("102.25"));
    expect(book.vwap("ask", s("4.000000000000000001"))).toBeUndefined();
    expect(book.vwap("bid", s("5"))).toBeUndefined();
    expect(book.vwap("ask", 0n)).toBeUndefined();
    expect(book.vwap("ask", -1n)).toBeUndefined();
  });

  test("an inexact quotient rounds against the trader: buy up, sell down", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(
      snapshotFrame(
        0,
        1,
        [
          ["100", "1"],
          ["99", "1"],
        ],
        [
          ["100", "1"],
          ["101", "1"],
        ],
      ),
    );
    // Buy 1.5 on the asks: (100×1 + 101×0.5) / 1.5 = 100.3333… — never representable at 18 dp.
    // Truncation toward zero would hand back …333, understating the cost of the fill.
    expect(book.vwap("ask", s("1.5"))).toBe(100_333_333_333_333_333_334n);
    // Sell 1.5 on the bids: (100×1 + 99×0.5) / 1.5 = 99.6666… — rounded down, never up.
    expect(book.vwap("bid", s("1.5"))).toBe(99_666_666_666_666_666_666n);
  });

  test("vwap walks in price order, not insertion order", () => {
    const book: OrderBookState = new OrderBookState(0);
    book.applySnapshot(snapshotFrame(0, 1, [], [["103.00", "1"]]));
    // A new, better ask arrives after the worse one — the reference would append it and average the
    // wrong levels first.
    expect(book.applyUpdate(deltaFrame(0, 1, 2, [], [["101.00", "1"]]))).toEqual({ ok: true });
    expect(book.vwap("ask", s("1"))).toBe(s("101.00"));
    expect(book.vwap("ask", s("2"))).toBe(s("102.00"));
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Snapshot classification                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("isOrderBookSnapshot", () => {
  test("classifies by prefix, then by the absence of begin_nonce", () => {
    expect(isOrderBookSnapshot(CHAIN[0] as OrderBookMessage)).toBe(true);
    expect(isOrderBookSnapshot(CHAIN[1] as OrderBookMessage)).toBe(false);
    // The published example labelled "Subscribed" that shows `update/order_book` (spec §5.3).
    expect(
      isOrderBookSnapshot({
        type: "update/order_book",
        channel: "order_book:0",
        order_book: { code: 0, asks: [], bids: [], nonce: 5 },
      } as unknown as OrderBookMessage),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The watcher: fakes                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Deterministic timers. Nothing here waits on a real 100 ms. */
class FakeTimers implements OrderBookTimers {
  #next: number = 1;
  readonly #pending: Map<number, () => void> = new Map<number, () => void>();

  setTimeout(fn: () => void, _ms: number): TimerHandle {
    const id: number = this.#next;
    this.#next += 1;
    this.#pending.set(id, fn);
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#pending.delete(handle as number);
  }

  get pending(): number {
    return this.#pending.size;
  }

  /** Fire everything currently armed, in arm order. */
  run(): void {
    for (const [id, fn] of [...this.#pending]) {
      this.#pending.delete(id);
      fn();
    }
  }
}

/** One fake subscription. The test pushes events into it by hand. */
class FakeSubscription {
  readonly key: string;
  state: "pending" | "active" | "closed" = "active";
  #cb: ((e: ChannelEvent<OrderBookMessage, OrderBookMessage>) => void) | undefined = undefined;
  readonly #onClose: () => void;

  constructor(key: string, onClose: () => void) {
    this.key = key;
    this.#onClose = onClose;
  }

  snapshot(): Promise<OrderBookMessage> {
    return new Promise<OrderBookMessage>((): void => {
      /* never resolves; the watcher does not use it */
    });
  }

  on(cb: (e: ChannelEvent<OrderBookMessage, OrderBookMessage>) => void): () => void {
    this.#cb = cb;
    return (): void => {
      this.#cb = undefined;
    };
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.#cb = undefined;
    this.#onClose();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *[Symbol.asyncIterator](): AsyncIterator<ChannelEvent<OrderBookMessage, OrderBookMessage>> {
    /* the watcher consumes via on(); iteration is here only to satisfy the interface */
  }

  emit(e: ChannelEvent<OrderBookMessage, OrderBookMessage>): void {
    this.#cb?.(e);
  }
}

/** A `WsSubscriber` with no socket behind it. */
class FakeSubscriber implements WsSubscriber {
  state: WsClientState = "open";
  readonly subscribeCalls: { key: string; overflow: string | undefined }[] = [];
  readonly closedKeys: string[] = [];
  readonly reconnects: string[] = [];
  readonly subs: FakeSubscription[] = [];
  /** Set to make the next `subscribe()` throw, as a closed or rate-limited client would. */
  failNextSubscribe: boolean = false;

  subscribe<S, U>(spec: ChannelSpec<S, U>, opts?: SubscribeOptions): Subscription<S, U> {
    this.subscribeCalls.push({ key: spec.key, overflow: opts?.overflow });
    if (this.failNextSubscribe) {
      this.failNextSubscribe = false;
      throw new Error("client closed");
    }
    const sub: FakeSubscription = new FakeSubscription(spec.key, (): void => {
      this.closedKeys.push(spec.key);
    });
    this.subs.push(sub);
    return sub as unknown as Subscription<S, U>;
  }

  reconnect(reason: string): void {
    this.reconnects.push(reason);
  }

  /** The subscription the watcher is currently attached to. */
  get live(): FakeSubscription {
    const sub: FakeSubscription | undefined = this.subs[this.subs.length - 1];
    if (sub === undefined) throw new Error("no subscription yet");
    return sub;
  }
}

/** Let queued microtasks and already-resolved promises settle. */
async function flush(): Promise<void> {
  for (let i: number = 0; i < 8; i += 1) await Promise.resolve();
}

/** Drive one full resync: the pending unsubscribe, the delay timer, and the re-subscribe. */
async function completeResync(client: FakeSubscriber, timers: FakeTimers): Promise<void> {
  await flush();
  timers.run();
  await flush();
  void client;
}

/* -------------------------------------------------------------------------------------------- */
/* The watcher: behaviour                                                                         */
/* -------------------------------------------------------------------------------------------- */

describe("watchOrderBook", () => {
  test("subscribes once, with overflow 'resubscribe' stated explicitly", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    expect(client.subscribeCalls).toEqual([{ key: "order_book/1", overflow: "resubscribe" }]);
    expect(watcher.book.marketIndex).toBe(1);
    expect(watcher.book.status).toBe("empty");
    await watcher.close();
  });

  test("applies a snapshot and then deltas, yielding the same instance each time", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    const seen: OrderBookState[] = [];
    const consumer: Promise<void> = (async (): Promise<void> => {
      for await (const book of watcher) {
        seen.push(book);
        if (seen.length === 2) break;
      }
    })();

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    await flush();
    client.live.emit({
      kind: "update",
      data: CHAIN[1] as OrderBookMessage,
      raw: undefined,
      receivedAt: 1,
    });
    await consumer;

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(watcher.book);
    expect(seen[1]).toBe(watcher.book);
    expect(watcher.book.status).toBe("synced");
    expect(watcher.book.nonce).toBe(10_001n);
    await watcher.close();
  });

  test("a mislabelled update/order_book with no begin_nonce is taken as a snapshot", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 0, { timers });
    client.live.emit({
      kind: "update",
      data: {
        type: "update/order_book",
        channel: "order_book:0",
        order_book: { code: 0, asks: [{ price: "101", size: "1" }], bids: [], nonce: 9 },
      } as unknown as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    expect(watcher.book.status).toBe("synced");
    expect(watcher.book.nonce).toBe(9n);
    await watcher.close();
  });

  test("a gap unsubscribes, waits the delay, resubscribes, and resyncs on the next snapshot", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const gaps: { marketIndex: number; expected: bigint; got: bigint }[] = [];
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      resubscribeDelayMs: 100,
      onGap: (info): void => {
        gaps.push(info);
      },
    });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    expect(watcher.book.status).toBe("synced");

    // Skip CHAIN[1]: CHAIN[2] expects to sit on nonce 10 001.
    client.live.emit({
      kind: "update",
      data: CHAIN[2] as OrderBookMessage,
      raw: undefined,
      receivedAt: 1,
    });

    expect(gaps).toEqual([{ marketIndex: 1, expected: 10_000n, got: 10_001n }]);
    expect(watcher.book.status).toBe("stale");

    // The unsubscribe goes out first; the resubscribe waits for the timer.
    await flush();
    expect(client.closedKeys).toEqual(["order_book/1"]);
    expect(client.subscribeCalls).toHaveLength(1);
    expect(timers.pending).toBe(1);

    timers.run();
    await flush();
    expect(client.subscribeCalls).toEqual([
      { key: "order_book/1", overflow: "resubscribe" },
      { key: "order_book/1", overflow: "resubscribe" },
    ]);
    expect(client.reconnects).toEqual([]);

    // A fresh snapshot on the new subscription returns the book to synced.
    client.live.emit({
      kind: "snapshot",
      data: snapshotFrame(1, 20_000, [["2499.90", "1"]], [["2500.10", "1"]]),
      raw: undefined,
      receivedAt: 2,
    });
    expect(watcher.book.status).toBe("synced");
    expect(watcher.book.nonce).toBe(20_000n);
    await watcher.close();
  });

  test("deltas arriving between the gap and the new snapshot are refused, not applied", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    const sub: FakeSubscription = client.live;
    sub.emit({ kind: "update", data: CHAIN[2] as OrderBookMessage, raw: undefined, receivedAt: 1 });
    expect(watcher.book.status).toBe("stale");

    const before: string = JSON.stringify(watcher.book.toJSON());
    sub.emit({ kind: "update", data: CHAIN[3] as OrderBookMessage, raw: undefined, receivedAt: 2 });
    sub.emit({ kind: "update", data: CHAIN[4] as OrderBookMessage, raw: undefined, receivedAt: 3 });
    expect(JSON.stringify(watcher.book.toJSON())).toBe(before);
    await watcher.close();
  });

  test("a crossed book triggers the same recovery as a gap", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const faults: OrderBookFaultReason[] = [];
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      onFault: (info): void => {
        faults.push(info.reason);
      },
    });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    client.live.emit({
      kind: "update",
      data: deltaFrame(1, 10_000, 10_001, [["2500.50", "1"]], []),
      raw: undefined,
      receivedAt: 1,
    });

    expect(faults).toEqual(["crossed"]);
    expect(watcher.book.status).toBe("stale");
    await completeResync(client, timers);
    expect(client.subscribeCalls).toHaveLength(2);
    await watcher.close();
  });

  test("a replayed delta is not a fault: no resync, no gap callback", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const gaps: unknown[] = [];
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      onGap: (info): void => {
        gaps.push(info);
      },
    });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    client.live.emit({
      kind: "update",
      data: CHAIN[1] as OrderBookMessage,
      raw: undefined,
      receivedAt: 1,
    });
    client.live.emit({
      kind: "update",
      data: CHAIN[1] as OrderBookMessage,
      raw: undefined,
      receivedAt: 2,
    });
    await flush();

    expect(gaps).toEqual([]);
    expect(client.closedKeys).toEqual([]);
    expect(client.subscribeCalls).toHaveLength(1);
    expect(watcher.book.status).toBe("synced");
    expect(watcher.book.nonce).toBe(10_001n);
    await watcher.close();
  });

  test("more than maxGapsPerMinute gaps inside the window escalates to exactly one reconnect", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    let clock: number = 1_000;
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      now: (): number => clock,
      // maxGapsPerMinute defaults to 5, so the sixth gap escalates.
    });

    for (let i: number = 0; i < 6; i += 1) {
      clock += 1_000; // six gaps inside 60 s
      const base: number = 100 * (i + 1);
      client.live.emit({
        kind: "snapshot",
        data: snapshotFrame(1, base, [["99", "1"]], [["101", "1"]]),
        raw: undefined,
        receivedAt: i,
      });
      expect(watcher.book.status).toBe("synced");
      // A delta whose begin_nonce is one ahead of the anchor: a gap.
      client.live.emit({
        kind: "update",
        data: deltaFrame(1, base + 1, base + 2, [], [["102", "1"]]),
        raw: undefined,
        receivedAt: i,
      });
      expect(watcher.book.status).toBe("stale");
      if (i < 5) await completeResync(client, timers);
    }

    expect(client.reconnects).toEqual(["orderbook-gap-storm"]);
    // Escalation replaces the local resync: no seventh subscribe, no pending timer.
    expect(client.subscribeCalls).toHaveLength(6);
    expect(timers.pending).toBe(0);
    await watcher.close();
  });

  test("gaps outside the rolling window do not accumulate", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    let clock: number = 0;
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      now: (): number => clock,
    });

    for (let i: number = 0; i < 8; i += 1) {
      clock += 61_000; // each gap is a minute past the last
      const base: number = 100 * (i + 1);
      client.live.emit({
        kind: "snapshot",
        data: snapshotFrame(1, base, [["99", "1"]], [["101", "1"]]),
        raw: undefined,
        receivedAt: i,
      });
      client.live.emit({
        kind: "update",
        data: deltaFrame(1, base + 1, base + 2, [], [["102", "1"]]),
        raw: undefined,
        receivedAt: i,
      });
      await completeResync(client, timers);
    }

    expect(client.reconnects).toEqual([]);
    expect(watcher.book.status).toBe("stale");
    await watcher.close();
  });

  test("a client reset marks the book stale before any post-reconnect frame lands", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const faults: OrderBookFaultReason[] = [];
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      onFault: (info): void => {
        faults.push(info.reason);
      },
    });

    const sub: FakeSubscription = client.live;
    sub.emit({ kind: "snapshot", data: CHAIN[0] as OrderBookMessage, raw: undefined, receivedAt: 0 });
    expect(watcher.book.status).toBe("synced");

    sub.emit({ kind: "reset", reason: "reconnect" });
    expect(watcher.book.status).toBe("stale");
    expect(faults).toEqual(["reset"]);

    // A delta that would otherwise have applied cleanly is refused while stale.
    const before: string = JSON.stringify(watcher.book.toJSON());
    sub.emit({ kind: "update", data: CHAIN[1] as OrderBookMessage, raw: undefined, receivedAt: 1 });
    expect(JSON.stringify(watcher.book.toJSON())).toBe(before);

    // The client owns the resubscribe after a reconnect: the watcher must not race it.
    await flush();
    expect(client.closedKeys).toEqual([]);
    expect(client.subscribeCalls).toHaveLength(1);
    expect(timers.pending).toBe(0);

    sub.emit({ kind: "snapshot", data: CHAIN[0] as OrderBookMessage, raw: undefined, receivedAt: 2 });
    expect(watcher.book.status).toBe("synced");
    await watcher.close();
  });

  test("an unparsable frame resyncs instead of escaping into the read loop", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const faults: OrderBookFaultReason[] = [];
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, {
      timers,
      onFault: (info): void => {
        faults.push(info.reason);
      },
    });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    expect((): void => {
      client.live.emit({
        kind: "update",
        data: deltaFrame(1, 10_000, 10_001, [], [["2500.15", "not-a-number"]]),
        raw: undefined,
        receivedAt: 1,
      });
    }).not.toThrow();

    expect(faults).toEqual(["malformed"]);
    expect(watcher.book.status).toBe("stale");
    await completeResync(client, timers);
    expect(client.subscribeCalls).toHaveLength(2);
    await watcher.close();
  });

  test("an unknown error is not fatal; a fatal one ends the stream", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    client.live.emit({ kind: "error", code: 30009, message: "throttled", fatal: false });
    expect(watcher.book.status).toBe("synced");

    const seen: OrderBookState[] = [];
    const consumer: Promise<void> = (async (): Promise<void> => {
      for await (const book of watcher) seen.push(book);
    })();

    client.live.emit({ kind: "error", code: 23001, message: "socket limit", fatal: true });
    await consumer;
    expect(watcher.book.status).toBe("stale");
    await watcher.close();
  });

  test("close is idempotent, unsubscribes, cancels the pending timer and ends iteration", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    client.live.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 0,
    });
    client.live.emit({
      kind: "update",
      data: CHAIN[2] as OrderBookMessage,
      raw: undefined,
      receivedAt: 1,
    });
    await flush();
    expect(timers.pending).toBe(1);

    const seen: OrderBookState[] = [];
    const consumer: Promise<void> = (async (): Promise<void> => {
      for await (const book of watcher) seen.push(book);
    })();

    await watcher.close();
    await watcher.close();
    await consumer;

    expect(timers.pending).toBe(0);
    expect(client.closedKeys).toEqual(["order_book/1"]);
    // A frame after close changes nothing.
    const after: string = JSON.stringify(watcher.book.toJSON());
    client.subs[0]?.emit({
      kind: "snapshot",
      data: CHAIN[0] as OrderBookMessage,
      raw: undefined,
      receivedAt: 9,
    });
    expect(JSON.stringify(watcher.book.toJSON())).toBe(after);
  });

  test("a subscribe that throws ends the watcher rather than spinning", async () => {
    const client: FakeSubscriber = new FakeSubscriber();
    const timers: FakeTimers = new FakeTimers();
    client.failNextSubscribe = true;
    const watcher: OrderBookWatcher = watchOrderBook(client, 1, { timers });

    const seen: OrderBookState[] = [];
    for await (const book of watcher) seen.push(book);
    expect(seen).toEqual([]);
    expect(client.subscribeCalls).toHaveLength(1);
    await watcher.close();
  });

  test("an invalid market index is rejected before any subscribe", () => {
    const client: FakeSubscriber = new FakeSubscriber();
    expect(() => watchOrderBook(client, -1)).toThrow(LighterValidationError);
    expect(() => watchOrderBook(client, 1.5)).toThrow(LighterValidationError);
    expect(client.subscribeCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* House rules                                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe("house rules", () => {
  test("no float parsing, numeric coercion, Node built-in or setInterval in the module", async () => {
    const source: string = await Bun.file(
      new URL("../../src/ws/orderbook.ts", import.meta.url),
    ).text();
    const banned: RegExp = /parseFloat|Number\(|Math\.|node:|\bBuffer\b|require\(|setInterval/;
    const offenders: string[] = source
      .split("\n")
      .filter((line: string) => banned.test(line));
    expect(offenders).toEqual([]);
  });
});
