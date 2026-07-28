/**
 * Signing and submitting from inside a Cloudflare Worker.
 *
 * - **What it does:** a Worker that takes `{ market, side, size, maxSlippage }` as JSON, signs a
 *   market order in the isolate and submits it over HTTPS, returning the protocol integers it used.
 * - **Credentials:** Worker **secrets**, not `process.env` — `LIGHTER_ACCOUNT_INDEX`,
 *   `LIGHTER_API_KEY_INDEX`, `LIGHTER_API_PRIVATE_KEY`, optionally `LIGHTER_NETWORK`.
 * - **Network:** the `LIGHTER_NETWORK` binding; testnet (chain id 300) unless it says `mainnet`,
 *   which additionally requires `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds: YES.** Anything that can reach this Worker can trade the
 *   account behind it. Put authentication in front of it; the `TODO` below is not decorative.
 *
 * ```sh
 * # in your own Worker project — this file is illustrative, not deployable as-is
 * wrangler secret put LIGHTER_API_PRIVATE_KEY
 * wrangler deploy
 * ```
 *
 * ## Paid tier. Not free tier.
 *
 * A signature is roughly 85 000 base-field multiplications. Measured (`bench/README.md`, 2 000 000
 * iterations after warmup, desktop Apple Silicon): **19.0 ns/mul on Deno 2.9.0, 28.0 on Node 24.10,
 * 34.6 on Bun 1.3.0** — about 1.6–2.9 ms per signature. The paid tier's 30 s CPU limit is not
 * remotely a constraint. The free tier's ~10 ms budget would need <=117 ns/mul sustained for
 * signing *alone*, and is **not a supported target** (`docs/decisions.md` D4). Those numbers are
 * desktop measurements, not measurements from inside a Workers isolate; treat them as an order of
 * magnitude, not a guarantee.
 *
 * ## Three Workers-specific rules this file follows
 *
 * 1. **No randomness at module scope.** Cloudflare forbids `crypto.getRandomValues` during global
 *    evaluation, and it is on the signing path (the hedged nonce, `docs/decisions.md` D2). The SDK
 *    resolves `globalThis.crypto` per call for exactly this reason, and nothing here draws a random
 *    byte outside a request.
 * 2. **No WebSocket.** Outside a Durable Object a Worker cannot hold an outbound socket across
 *    requests (risk R12), so `submit: "ws"` here would mean one socket per submission. This Worker
 *    submits over HTTPS. Streaming from Workers is out of scope for this example — it belongs in a
 *    Durable Object.
 * 3. **Secrets come from `env`, not from a global.** There is no `process.env` here.
 *
 * ## What is at module scope, and why
 *
 * The `LighterClient` constructor performs no I/O: no fetch, no timer, no clock read, no
 * randomness. So it *could* be built once during global evaluation and reused by every request. The
 * *account* cannot be — it needs the key, and the key arrives with the request — which is why both
 * are constructed inside `fetch` here.
 *
 * Market metadata still costs one round trip per cold isolate. `MarketRegistry.fromSnapshot(SNAP)`
 * removes even that, if you are willing to ship a snapshot and revalidate on a schedule.
 */

import {
  type AppliedReceipt,
  type LighterAccount,
  LighterClient,
  type MarketContext,
  type MarketHandle,
  marketHandle,
  restBookSource,
} from "lighter-ts/client";

/** The bindings this Worker needs. Everything secret is a `wrangler secret`, never a `var`. */
export interface Env {
  readonly LIGHTER_API_PRIVATE_KEY: string;
  readonly LIGHTER_ACCOUNT_INDEX: string;
  readonly LIGHTER_API_KEY_INDEX: string;
  readonly LIGHTER_NETWORK?: string;
  readonly LIGHTER_ALLOW_MAINNET?: string;
}

/** The request body. Sizes and prices are decimal **strings**, all the way from the caller. */
interface OrderRequest {
  readonly market: string;
  readonly side: "buy" | "sell";
  /** Base units, decimal string, e.g. `"0.01"`. */
  readonly size: string;
  /** `"0.005"`, `"0.5%"` or `"50bps"`. No default: this is the worst fill the order will accept. */
  readonly maxSlippage: string;
}

/** Non-negative integers only — indices and counts, never money (`docs/decisions.md` D7). */
function readIndex(raw: string, name: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative whole number`);
  return Number.parseInt(raw, 10);
}

function readNetwork(env: Env): "testnet" | "mainnet" {
  const requested: string = env.LIGHTER_NETWORK ?? "testnet";
  if (requested !== "testnet" && requested !== "mainnet") {
    throw new Error('LIGHTER_NETWORK must be "testnet" or "mainnet"');
  }
  if (requested === "mainnet" && env.LIGHTER_ALLOW_MAINNET !== "yes") {
    throw new Error("mainnet requires the LIGHTER_ALLOW_MAINNET=yes binding");
  }
  return requested;
}

/** Minimal shape check. A body that arrives from the internet is `unknown` until proven otherwise. */
function parseOrder(body: unknown): OrderRequest {
  if (typeof body !== "object" || body === null) throw new Error("expected a JSON object");
  const o: Record<string, unknown> = body as Record<string, unknown>;
  const market: unknown = o["market"];
  const side: unknown = o["side"];
  const size: unknown = o["size"];
  const maxSlippage: unknown = o["maxSlippage"];
  if (typeof market !== "string" || market.length === 0) throw new Error("market must be a string");
  if (side !== "buy" && side !== "sell") throw new Error('side must be "buy" or "sell"');
  // A decimal string, and it stays one: converting it to a float here would reintroduce every
  // hazard the SDK exists to avoid.
  if (typeof size !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(size)) {
    throw new Error('size must be a decimal string, e.g. "0.01"');
  }
  if (typeof maxSlippage !== "string" || maxSlippage.length === 0) {
    throw new Error('maxSlippage must be a string, e.g. "0.5%"');
  }
  return { market, side, size, maxSlippage };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // TODO(you): authenticate the caller. This endpoint can trade the account behind it.
    if (request.method !== "POST") {
      return new Response("POST a JSON order", { status: 405 });
    }

    try {
      const network: "testnet" | "mainnet" = readNetwork(env);
      const order: OrderRequest = parseOrder(await request.json());

      // No I/O in the constructor, so this is also safe at module scope; it is here only because
      // `env` is not available during global evaluation.
      const client: LighterClient = new LighterClient({ endpoint: network });
      await client.markets.load();

      const account: LighterAccount = client.account({
        accountIndex: BigInt(readIndex(env.LIGHTER_ACCOUNT_INDEX, "LIGHTER_ACCOUNT_INDEX")),
        keys: {
          [readIndex(env.LIGHTER_API_KEY_INDEX, "LIGHTER_API_KEY_INDEX")]: env.LIGHTER_API_PRIVATE_KEY,
        },
        // A Worker isolate is short-lived and there may be several at once, so an optimistic local
        // counter is the wrong default here: `"server"` re-reads `GET /nextNonce` and paces itself.
        // A Durable Object holding a `NonceSnapshot` is the better answer for a busy account.
        nonces: "server",
        // Never `"ws"` outside a Durable Object — see rule 2 in the header.
        submit: "http",
      });

      const ctx: MarketContext = {
        chainId: client.chainId,
        account,
        markets: client.markets,
        books: restBookSource(client.rest),
      };

      const handle: MarketHandle = marketHandle(ctx, order.market);
      const receipt: AppliedReceipt =
        order.side === "buy"
          ? await handle.buy({ size: order.size, maxSlippage: order.maxSlippage })
          : await handle.sell({ size: order.size, maxSlippage: order.maxSlippage });

      await client.close();

      // `bigint` does not survive `JSON.stringify`, and rounding one through a float would describe
      // a different transaction than the one that was signed. Decimal strings out.
      return Response.json({
        txHash: receipt.txHash,
        nonce: receipt.nonce.toString(10),
        apiKeyIndex: receipt.apiKeyIndex,
        applied: {
          baseAmount: receipt.applied.baseAmount.toString(10),
          price: receipt.applied.price.toString(10),
          orderExpiry: receipt.applied.orderExpiry.toString(10),
        },
      });
    } catch (error: unknown) {
      const code: unknown =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)["code"]
          : undefined;
      // 20558 arrives as HTTP 400 and looks like a validation error. It is a jurisdiction block on
      // /sendTx, and a Worker's egress IP decides it — not your laptop's.
      const restricted: boolean = code === 20558;
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ...(restricted
            ? { hint: "API code 20558: this Worker's egress is a restricted jurisdiction" }
            : {}),
        },
        { status: restricted ? 451 : 400 },
      );
    }
  },
};
