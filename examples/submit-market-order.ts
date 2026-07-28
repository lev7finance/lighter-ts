/**
 * A market order at the human tier: decimal strings in, protocol integers out, both printed.
 *
 * - **What it does:** dry-runs a MARKET/IOC order (builds and signs, submits nothing), prints every
 *   integer the SDK derived, then submits the real thing.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_API_PRIVATE_KEY`.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300). Mainnet needs
 *   `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds: YES.** The second half of this file places a real order on
 *   whichever network is selected.
 *
 * ```sh
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_API_KEY_INDEX=1 LIGHTER_API_PRIVATE_KEY=0x… \
 *   LIGHTER_MARKET=ETH LIGHTER_SIZE=0.01 LIGHTER_SIDE=buy LIGHTER_MAX_SLIPPAGE=0.5% \
 *   bun examples/submit-market-order.ts
 *
 * # size by notional instead of base units:
 * LIGHTER_NOTIONAL=25 … bun examples/submit-market-order.ts
 * ```
 *
 * **Precondition:** `/sendTx` is blocked from restricted jurisdictions with API code 20558, which
 * arrives as HTTP 400 (`docs/protocol-notes.md` §8.3). Reads will keep working while this fails.
 * The failure is reported explicitly rather than left to look like a validation error.
 *
 * ## The arithmetic, which is the whole point
 *
 * Sizes, notionals and slippage bounds are **decimal strings** and are converted by the SDK, once,
 * under a stated rounding policy. Every reference-SDK arithmetic hazard lives in this conversion
 * (`docs/protocol-notes.md` §9):
 *
 * - `int(quote * 1e6)` turns 8.2 USDC into 8.199999, because `8.2 * 1e6 === 8199999.999999999`.
 *   This SDK scales the *string* lexically, so `"8.2"` is 8 200 000 exactly.
 * - `int(price.replace(".", ""))` is right only while the API pads every price to the market's
 *   declared decimals. `"2500.1"` would become 25001 — off by 100×.
 * - Python's `round()` is banker's rounding; JavaScript's built-in rounding is half-up. Neither is
 *   a translation of the other, and they disagree only on even halves, so it survives casual
 *   testing.
 *
 * So: no float parse, no numeric coercion and no half-up rounding helper anywhere near a price or a
 * size — here or in anything you copy from here. `receipt.applied` reports the integers that were
 * actually signed, so the conversion is auditable instead of implied.
 *
 * ## Rounding direction
 *
 * A market order's `price` field is not a price to trade at — it is the **worst** price the order
 * may fill at, which is why `maxSlippage` has no default. The bound rounds in the direction that
 * cannot loosen protection: a **buy's** maximum acceptable price rounds **down** to the tick, while
 * a **sell's** minimum acceptable price rounds **up** (`docs/decisions.md` D7). `mode: "exact"`
 * opts out and refuses a bound that is not representable rather than moving it.
 */

import {
  type AppliedReceipt,
  type LighterAccount,
  LighterClient,
  type MarketContext,
  type MarketHandle,
  marketHandle,
  restBookSource,
  type SizedOrderOpts,
} from "lighter-ts/client";
import {
  marketSymbol,
  type Network,
  optionalEnv,
  reportFailure,
  requireAccountIndex,
  requireApiKeyIndex,
  requireApiPrivateKey,
  selectNetwork,
} from "./env.js";

/** Report an {@link AppliedReceipt}'s integers — the numbers that were signed, not the ones typed. */
function printApplied(label: string, receipt: AppliedReceipt): void {
  console.log(label);
  console.log(`  baseAmount    ${String(receipt.applied.baseAmount)}   (integer, 10^-size_decimals)`);
  console.log(
    `  price         ${String(receipt.applied.price)}   (integer, 10^-price_decimals — the slippage bound)`,
  );
  if (receipt.applied.notional !== undefined) {
    console.log(`  notional      ${String(receipt.applied.notional)}   (integer, 10^-quote_decimals)`);
  }
  console.log(
    `  orderExpiry   ${String(receipt.applied.orderExpiry)}   (0 is nil, which is correct for IOC)`,
  );
  console.log(`  nonce         ${String(receipt.nonce)} on api key ${String(receipt.apiKeyIndex)}`);
  console.log(`  txHash        ${receipt.txHash}`);
}

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const account: { big: bigint; num: number } = requireAccountIndex();
  const apiKeyIndex: number = requireApiKeyIndex();

  const side: string = optionalEnv("LIGHTER_SIDE") ?? "buy";
  if (side !== "buy" && side !== "sell") {
    throw new Error(`LIGHTER_SIDE must be "buy" or "sell", received ${JSON.stringify(side)}`);
  }
  const size: string | undefined = optionalEnv("LIGHTER_SIZE");
  const notional: string | undefined = optionalEnv("LIGHTER_NOTIONAL");
  if ((size === undefined) === (notional === undefined)) {
    throw new Error(
      "set exactly one of LIGHTER_SIZE (base units, e.g. 0.01) or LIGHTER_NOTIONAL (quote units, e.g. 25)",
    );
  }
  // "0.005", "0.5%" and "50bps" are the same exact rational. There is no default: the price field of
  // a market order is the worst fill it will accept, and no default for that is safe.
  const maxSlippage: string = optionalEnv("LIGHTER_MAX_SLIPPAGE") ?? "0.5%";

  const client: LighterClient = new LighterClient({ endpoint: network.name });
  try {
    // Metadata: the decimals that make the conversion below meaningful. One round trip, cached.
    await client.markets.load();

    const lighterAccount: LighterAccount = client.account({
      accountIndex: account.big,
      keys: { [apiKeyIndex]: requireApiPrivateKey() },
      // Local counter, seeded lazily from `GET /nextNonce`, advanced optimistically and rolled back
      // when the sequencer refuses a slot.
      nonces: "optimistic",
      submit: "http",
    });

    const ctx: MarketContext = {
      // From the profile, not from the URL. It is hash element 0.
      chainId: client.chainId,
      account: lighterAccount,
      markets: client.markets,
      // The book source a market order walks when it needs a price. `GET /orderBookOrders` returns
      // individual resting orders, not levels; the SDK folds and re-sorts them.
      books: restBookSource(client.rest),
    };

    const handle: MarketHandle = marketHandle(ctx, marketSymbol());
    console.log(
      `${handle.market.symbol} (market ${String(handle.marketId)})  ` +
        `size_decimals=${String(handle.market.sizeDecimals)} ` +
        `price_decimals=${String(handle.market.priceDecimals)} ` +
        `quote_decimals=${String(handle.market.quoteDecimals)}`,
    );
    console.log(
      `${side} ${size ?? `${notional ?? ""} (quote)`} with maxSlippage ${maxSlippage} on ${network.name}\n`,
    );

    const common: SizedOrderOpts = {
      ...(size !== undefined ? { size } : {}),
      ...(notional !== undefined ? { notional } : {}),
      maxSlippage,
      // `true` walks the book and refuses the order if the achievable average is worse than the
      // bound (EXCESSIVE_SLIPPAGE / INSUFFICIENT_DEPTH). `false` — the default, and the reference's
      // behaviour — computes the cap from the best price and lets a thin book simply fill less.
      checkDepth: true,
    };

    // 1. Dry run. Builds, validates and signs; submits nothing and issues no request. It does not
    //    consume a nonce slot either — it signs in caller-managed mode with a placeholder nonce, so
    //    nothing has to be rolled back if you decide not to send.
    const dry: AppliedReceipt =
      side === "buy"
        ? await handle.buy({ ...common, dryRun: true })
        : await handle.sell({ ...common, dryRun: true });
    printApplied("dry run — nothing was submitted", dry);
    console.log("  (the nonce above is a placeholder: a dry run never consults the nonce source)\n");

    // 2. The real submission. Same inputs, same conversion, a real nonce lease this time.
    const sent: AppliedReceipt =
      side === "buy" ? await handle.buy(common) : await handle.sell(common);
    printApplied("submitted", sent);
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
