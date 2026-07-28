/**
 * The resting-order lifecycle over HTTP: place a post-only limit, reprice it, cancel it.
 *
 * - **What it does:** submits three transactions in sequence and waits for the first to execute.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_API_PRIVATE_KEY`.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300). Mainnet needs
 *   `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds: YES.** A post-only order that crosses the book is rejected
 *   rather than filled, but this still places a live order with real collateral behind it.
 *
 * ```sh
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_API_KEY_INDEX=1 LIGHTER_API_PRIVATE_KEY=0x… \
 *   LIGHTER_MARKET=ETH LIGHTER_SIDE=buy LIGHTER_SIZE=0.01 \
 *   LIGHTER_LIMIT_PRICE=1500.00 LIGHTER_LIMIT_PRICE_2=1490.00 \
 *   bun examples/create-modify-cancel.ts
 * ```
 *
 * Pick a price far from the touch. `postOnly` refuses to take, so an aggressive price is rejected
 * by the sequencer rather than filled — safe, but it ends the example early.
 *
 * **Precondition:** `/sendTx` returns HTTP 400 with API code 20558 from restricted jurisdictions
 * (`docs/protocol-notes.md` §8.3). Reads succeed while writes fail; that is not a bug in this file.
 *
 * ## Three things worth copying
 *
 * 1. **The client order index is chosen here, not by the server.** It is what `modify` and `cancel`
 *    address, and it must be unique per `(account, market)` within its lifetime — so it comes from
 *    the clock, not a counter that resets when the process does.
 * 2. **`modify` requires a price.** The protocol has no "leave the price alone" sentinel: `0` is
 *    `NilOrderPrice`. Omitting it is not an option the SDK can offer honestly.
 * 3. **`rounding: "conservative"` needs a `side`.** A modification carries none of its own, and the
 *    safe direction depends on it — a buy's price rounds **down**, a sell's **up**, so rounding a
 *    resting order never makes it more aggressive than asked. The default, `"exact"`, refuses a
 *    price the market's tick cannot represent instead of moving it.
 */

import {
  type AppliedReceipt,
  type LighterAccount,
  LighterClient,
  type MarketContext,
  type MarketHandle,
  marketHandle,
  restBookSource,
  type TxResult,
} from "lighter-ts/client";
import {
  marketSymbol,
  type Network,
  optionalCount,
  optionalEnv,
  reportFailure,
  requireAccountIndex,
  requireApiKeyIndex,
  requireApiPrivateKey,
  requireEnv,
  selectNetwork,
} from "./env.js";

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const account: { big: bigint; num: number } = requireAccountIndex();
  const apiKeyIndex: number = requireApiKeyIndex();

  const side: string = optionalEnv("LIGHTER_SIDE") ?? "buy";
  if (side !== "buy" && side !== "sell") {
    throw new Error(`LIGHTER_SIDE must be "buy" or "sell", received ${JSON.stringify(side)}`);
  }
  const size: string = optionalEnv("LIGHTER_SIZE") ?? "0.01";
  // Decimal strings, straight from the environment to the SDK. Nothing parses them into a float on
  // the way past — `"1500.00"`, `"1500.0"` and `"1500"` are the same price and must stay so.
  const price: string = requireEnv("LIGHTER_LIMIT_PRICE", "the limit price, e.g. 1500.00");
  const newPrice: string = requireEnv("LIGHTER_LIMIT_PRICE_2", "the repriced limit, e.g. 1490.00");
  const waitMs: number = optionalCount("LIGHTER_WAIT_MS", 20_000);

  const client: LighterClient = new LighterClient({ endpoint: network.name });
  try {
    await client.markets.load();

    const lighterAccount: LighterAccount = client.account({
      accountIndex: account.big,
      keys: { [apiKeyIndex]: requireApiPrivateKey() },
      nonces: "optimistic",
      submit: "http",
    });

    const ctx: MarketContext = {
      chainId: client.chainId,
      account: lighterAccount,
      markets: client.markets,
      books: restBookSource(client.rest),
    };
    const handle: MarketHandle = marketHandle(ctx, marketSymbol());

    // Unique per (account, market) for the order's lifetime. Milliseconds are inside the protocol's
    // `[1, 2^48 - 1]` client-order-index range for the next several thousand years.
    const clientOrderId: bigint = BigInt(Date.now());
    console.log(`${handle.market.symbol}: client order index ${String(clientOrderId)}\n`);

    // ---- create ---------------------------------------------------------------------------------
    const created: AppliedReceipt = await handle.postOnly({
      side,
      size,
      price,
      clientOrderId,
    });
    console.log(`created   ${created.txHash}`);
    console.log(
      `          baseAmount=${String(created.applied.baseAmount)} ` +
        `price=${String(created.applied.price)} ` +
        `orderExpiry=${String(created.applied.orderExpiry)}  nonce=${String(created.nonce)}`,
    );

    // `wait()` polls `GET /api/v1/tx?by=hash`. The first delay is seeded from the sequencer's own
    // execution estimate. A timeout says nothing about the transaction's fate — it may still land.
    try {
      const result: TxResult = await created.wait({ timeoutMs: waitMs });
      console.log(`          executed, status ${String(result.status)}`);
    } catch (error: unknown) {
      console.log(`          not confirmed within ${String(waitMs)} ms: ${String(error)}`);
    }

    // ---- modify ---------------------------------------------------------------------------------
    const modified: AppliedReceipt = await handle.modify({
      orderId: clientOrderId,
      price: newPrice,
      size,
      // Required by `rounding: "conservative"`: a modification carries no side of its own.
      side,
      rounding: "conservative",
    });
    console.log(`\nmodified  ${modified.txHash}`);
    console.log(
      `          baseAmount=${String(modified.applied.baseAmount)} ` +
        `price=${String(modified.applied.price)}  nonce=${String(modified.nonce)}`,
    );

    // ---- cancel ---------------------------------------------------------------------------------
    const cancelled: AppliedReceipt = await handle.cancel(clientOrderId);
    console.log(`\ncancelled ${cancelled.txHash}  nonce=${String(cancelled.nonce)}`);

    // `handle.cancelAll()` cancels every resting order on this market via L2 attribute 5. The
    // scheduled and aborting modes are every-market by protocol, so they must say
    // `{ allMarkets: true }` out loud rather than silently widening their own scope.
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
