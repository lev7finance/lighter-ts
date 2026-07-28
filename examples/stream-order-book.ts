/**
 * Subscribe to an order book, keep it sorted, print best bid/ask, and surface every resync.
 *
 * - **What it does:** opens one WebSocket, subscribes to `order_book/{marketId}`, folds the deltas
 *   into a sorted book, and prints the touch on each update. Gaps, resets and reconnects are
 *   printed rather than swallowed.
 * - **Credentials:** none. `order_book` is a public channel.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300).
 * - **Whether it moves real funds:** no. Read-only; nothing is signed and nothing is submitted.
 *
 * ```sh
 * LIGHTER_MARKET=ETH LIGHTER_STREAM_UPDATES=20 bun examples/stream-order-book.ts
 * ```
 *
 * **Preconditions, and what is actually verified:**
 *
 * - The stream is blocked from restricted jurisdictions — the upgrade fails with HTTP 400 and API
 *   code 20558, and a failed upgrade carries no payload, so a bare `Expected 101 status code` is
 *   all a naive client sees. This SDK probes the URL over plain HTTPS and surfaces the real body
 *   (`docs/protocol-notes.md` §8.3). If the upgrade fails for you, check that first.
 * - **Only `order_book` is verified.** This file was run against live testnet traffic and its
 *   snapshot/update frames fold correctly, so the shapes it reads are observed rather than
 *   inferred. The wave-0 capture that would have covered the *other* twenty-one channels was
 *   refused at the upgrade for the reason above, so treat their field-level details as provisional.
 *
 * ## Node 20 has no global `WebSocket`
 *
 * Bun, Deno, browsers and Cloudflare Workers all provide one. Node 20 does not, so the constructor
 * is injected rather than imported — this SDK ships no WebSocket implementation and adds no
 * dependency to get one:
 *
 * ```ts
 * import { WebSocket } from "undici";               // in *your* application, not in this package
 * const client = new LighterClient({ endpoint: "testnet", WebSocket });
 * ```
 *
 * This example checks for the global and tells you exactly that if it is missing.
 *
 * ## Keeping the book sorted is not optional
 *
 * The reference client appends new price levels to the end of its arrays, so its book stops being
 * sorted after the first update and `bids[0]` is no longer the best bid
 * (`docs/protocol-notes.md` §10.2). A walk down a mis-sorted book returns a plausible, wrong
 * average price — the worst kind of wrong. So this example re-derives the touch on every apply and
 * compares prices **exactly**: `compareDecimal` below is integer arithmetic on the digits, because
 * a binary64 reading of `"2064.54"` is not 2064.54, and `"2064.50"` must compare equal to
 * `"2064.5"`.
 *
 * A numerically-zero size is a **tombstone** meaning "remove this level", and `"0"`, `"0.0"` and
 * `"0.0000"` all appear — so the zero test is exact, never textual.
 *
 * ## Gaps
 *
 * Each frame carries `nonce` (the sequence after applying it) and, on updates, `begin_nonce` (what
 * it expects to be applied on top of). A mismatch means a frame was lost and the book is no longer
 * the exchange's book. There is no repairing that locally: this example forces a socket cycle,
 * which discards the state and resubscribes. `{kind: "reset"}` is the SDK's own signal for the same
 * class of event — it is delivered on every reconnect **before** any fresh snapshot can arrive, so
 * a consumer learns its delta-derived state is void while that is still actionable.
 */

import { LighterClient, type MarketInfo } from "lighter-ts/client";
import {
  channels,
  type OrderBookLevel,
  type OrderBookMessage,
  type Subscription,
  wireInt,
} from "lighter-ts/ws";
import { marketSymbol, type Network, optionalCount, reportFailure, selectNetwork } from "./env.js";

/* ---------------------------------------------------------------------------------------------- */
/* Exact decimal comparison                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Compare two non-negative decimal strings exactly.
 *
 * Local to this example on purpose: `src/util/decimal.ts` is internal and not part of the published
 * surface, and the point here is to show that the comparison is integer arithmetic on the digits.
 * No float parse and no numeric coercion anywhere on this path — see `docs/decisions.md` D7.
 */
function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [aInt = "0", aFrac = ""] = a.split(".");
  const [bInt = "0", bFrac = ""] = b.split(".");
  const width: number = Math.max(aFrac.length, bFrac.length);
  const left: bigint = BigInt(aInt + aFrac.padEnd(width, "0"));
  const right: bigint = BigInt(bInt + bFrac.padEnd(width, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A numerically-zero size: the tombstone. `"0"`, `"0.0"` and `"0.0000"` all qualify. */
function isTombstone(size: string): boolean {
  return compareDecimal(size, "0") === 0;
}

/* ---------------------------------------------------------------------------------------------- */
/* The book                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** One side, keyed by the price string exactly as the wire spelled it. */
type Side = Map<string, string>;

/** Apply one side's levels, honouring tombstones. */
function applySide(side: Side, levels: readonly OrderBookLevel[] | undefined): void {
  for (const level of levels ?? []) {
    const price: string | undefined = level.price;
    const size: string | undefined = level.size;
    if (price === undefined || size === undefined) continue;
    if (isTombstone(size)) side.delete(price);
    else side.set(price, size);
  }
}

/** The best price on a side: highest for bids, lowest for asks. Derived exactly, on every read. */
function best(side: Side, descending: boolean): { price: string; size: string } | undefined {
  let bestPrice: string | undefined;
  for (const price of side.keys()) {
    if (bestPrice === undefined) {
      bestPrice = price;
      continue;
    }
    const cmp: -1 | 0 | 1 = compareDecimal(price, bestPrice);
    if (descending ? cmp > 0 : cmp < 0) bestPrice = price;
  }
  if (bestPrice === undefined) return undefined;
  return { price: bestPrice, size: side.get(bestPrice) ?? "0" };
}

/* ---------------------------------------------------------------------------------------------- */
/* The stream                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const wanted: number = optionalCount("LIGHTER_STREAM_UPDATES", 20);

  if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
      "this runtime has no global WebSocket. Node 20 is the usual case — pass one in:\n" +
        '  import { WebSocket } from "undici";\n' +
        '  new LighterClient({ endpoint: "testnet", WebSocket })',
    );
  }

  const client: LighterClient = new LighterClient({ endpoint: network.name });
  await client.markets.load();
  const market: MarketInfo = client.markets.get(marketSymbol());
  console.log(`${market.symbol} — order_book/${String(market.marketId)} on ${network.name}\n`);

  const bids: Side = new Map<string, string>();
  const asks: Side = new Map<string, string>();
  let nonce: bigint | undefined;
  let seen: number = 0;

  // Building the WS client reads no global and opens no socket; `subscribe` connects.
  const sub: Subscription<OrderBookMessage, OrderBookMessage> = client.ws.subscribe(
    channels.orderBook(market.marketId),
  );

  try {
    // Each `event` is a `ChannelEvent<OrderBookMessage, OrderBookMessage>`: a discriminated union of
    // `snapshot` / `update` / `reset` / `error`. Iterating and `sub.on(cb)` drain the same queue,
    // and using both at once is a `TypeError` rather than a silently split stream.
    for await (const event of sub) {
      if (event.kind === "reset") {
        // Delivered *before* any post-reconnect snapshot, which is the only order in which it is
        // useful: after a fresh snapshot it would make a consumer discard good state.
        console.log(
          `\n[reset: ${event.reason}] every delta-derived level is void; waiting for a snapshot`,
        );
        bids.clear();
        asks.clear();
        nonce = undefined;
        continue;
      }
      if (event.kind === "error") {
        console.log(`[error ${String(event.code)}${event.fatal ? " fatal" : ""}] ${event.message}`);
        if (event.fatal) break;
        continue;
      }

      const payload: OrderBookMessage["order_book"] = event.data.order_book;
      const isSnapshot: boolean = event.kind === "snapshot" || payload.begin_nonce === undefined;

      if (isSnapshot) {
        bids.clear();
        asks.clear();
      } else {
        // Gap detection. `begin_nonce` is what this frame expects to sit on top of; if that is not
        // where we are, a frame was lost and the book is no longer the exchange's book.
        const begin: bigint | undefined =
          payload.begin_nonce === undefined ? undefined : wireInt(payload.begin_nonce);
        if (nonce !== undefined && begin !== undefined && begin !== nonce) {
          console.log(
            `\n[gap] expected begin_nonce ${String(nonce)}, got ${String(begin)} — ` +
              "the local book has diverged; forcing a resubscribe",
          );
          bids.clear();
          asks.clear();
          nonce = undefined;
          client.ws.reconnect("order book gap");
          continue;
        }
      }

      applySide(bids, payload.bids);
      applySide(asks, payload.asks);
      nonce = payload.nonce === undefined ? nonce : wireInt(payload.nonce);

      const bestBid: { price: string; size: string } | undefined = best(bids, true);
      const bestAsk: { price: string; size: string } | undefined = best(asks, false);
      seen += 1;
      console.log(
        `${isSnapshot ? "snapshot" : "update  "} nonce=${String(nonce ?? "?")}  ` +
          `bid ${bestBid?.size ?? "-"} @ ${bestBid?.price ?? "-"}   ` +
          `ask ${bestAsk?.size ?? "-"} @ ${bestAsk?.price ?? "-"}   ` +
          `(${String(bids.size)}×${String(asks.size)} levels)`,
      );

      if (seen >= wanted) break;
    }
  } finally {
    await sub.close();
    await client.close();
  }
}

await main().catch(reportFailure);
