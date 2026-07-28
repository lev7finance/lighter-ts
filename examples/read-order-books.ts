/**
 * `GET /api/v1/orderBooks` — the smallest useful thing this SDK does.
 *
 * - **What it does:** lists the perpetual markets and prints the three decimal exponents every
 *   other call depends on.
 * - **Credentials:** none. This endpoint is public.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300).
 * - **Whether it moves real funds:** no. One `GET`, nothing signed.
 *
 * Run it:
 *
 * ```sh
 * bun examples/read-order-books.ts
 * LIGHTER_NETWORK=mainnet LIGHTER_ALLOW_MAINNET=yes bun examples/read-order-books.ts
 * ```
 *
 * ## Why the decimals are the point
 *
 * `supported_size_decimals`, `supported_price_decimals` and `supported_quote_decimals` are the
 * exponents that turn a human number into the integer the protocol signs. Every wrong-magnitude
 * order starts by getting one of them wrong, so they are printed first and printed together — and
 * so is whether they are self-consistent: a market where
 * `price_decimals + size_decimals !== quote_decimals` cannot express a quote-sized ("spend 500
 * USDC") order without being off by a power of ten, and the SDK refuses that market rather than
 * computing it (`MarketInfo.quoteSizingSupported`).
 *
 * Note also what is **not** done to any of these values: `min_base_amount`, `min_quote_amount` and
 * the fees arrive as decimal strings and are printed as decimal strings. No float parse and no
 * numeric coercion touches them (`docs/decisions.md` D7).
 */

import { LighterClient } from "lighter-ts/client";
import type { OrderBook, OrderBooks } from "lighter-ts";
import { type Network, reportFailure, selectNetwork } from "./env.js";

/** How many markets to print. The response carries every listed market. */
const HOW_MANY: 8 = 8;

async function main(): Promise<void> {
  const network: Network = selectNetwork();

  // Synchronous, no I/O: the constructor opens nothing and fetches nothing, which is what makes it
  // safe at module scope in a Worker. The chain id comes from the named profile.
  const client: LighterClient = new LighterClient({ endpoint: network.name });
  console.log(`network ${network.name}, chain id ${String(client.chainId)}`);

  try {
    const response: OrderBooks = await client.rest.order.orderBooks({ filter: "perp" });
    const books: readonly OrderBook[] = response.order_books ?? [];
    console.log(`${String(books.length)} perpetual markets\n`);

    for (const book of books.slice(0, HOW_MANY)) {
      const size: number | undefined = book.supported_size_decimals;
      const price: number | undefined = book.supported_price_decimals;
      const quote: number | undefined = book.supported_quote_decimals;
      // Every field on this model is optional: the OpenAPI document marks them so, and a field that
      // is absent must read as absent rather than as zero.
      const consistent: string =
        size === undefined || price === undefined || quote === undefined
          ? "unknown"
          : size + price === quote
            ? "yes"
            : "NO — quote-sized orders are refused on this market";

      console.log(`${(book.symbol ?? "?").padEnd(8)} market_id=${String(book.market_id ?? -1)}`);
      console.log(
        `  decimals   size=${String(size)} price=${String(price)} quote=${String(quote)}` +
          `   size+price === quote? ${consistent}`,
      );
      console.log(
        `  minimums   base=${book.min_base_amount ?? "?"}  quote=${book.min_quote_amount ?? "?"}` +
          `  order cap=${book.order_quote_limit ?? "?"}`,
      );
      console.log(`  fees       taker=${book.taker_fee ?? "?"}%  maker=${book.maker_fee ?? "?"}%`);
    }
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
