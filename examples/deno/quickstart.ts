/**
 * Deno, with no install step and no build step.
 *
 * - **What it does:** reads the market table and signs a transaction offline, on Deno, importing
 *   the package straight from npm.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX` and `LIGHTER_API_KEY_INDEX`;
 *   `LIGHTER_API_PRIVATE_KEY` is optional, otherwise an ephemeral key is generated.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300). One public `GET`.
 * - **Whether it moves real funds:** no. Nothing is submitted.
 *
 * ```sh
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_API_KEY_INDEX=… \
 *   deno run --allow-net --allow-env quickstart.ts
 * ```
 *
 * The executable imports below use `npm:lighter-ts/*` directly. Copy this one file anywhere; there
 * is no import map, package.json, node_modules directory, or source edit to make first.
 *
 * ## Why Deno needs no adaptation
 *
 * The SDK imports no Node built-in and touches no Node global: no `node:crypto`, no `Buffer`, no
 * filesystem. It uses `fetch`, `WebSocket`, `globalThis.crypto` and `BigInt`, all of which Deno
 * provides natively. No polyfill, no `--compat`, no shim, no bundling.
 *
 * The one Deno-specific note is `process.env`, used below to read an optional key: Deno 2 provides
 * a global `process`, so it works, but a Deno-only program would idiomatically write
 * `Deno.env.get("…")`. It is not written that way here because this file is also typechecked with
 * Node's type definitions.
 *
 * Deno is also the **fastest** of the three server runtimes on the signing path: 19.0 ns per
 * base-field multiplication against Node 24.10's 28.0 and Bun 1.3.0's 34.6, roughly 1.6 ms per
 * signature (`bench/README.md`, 2 000 000 iterations after warmup, desktop Apple Silicon).
 */

// @ts-ignore -- NodeNext does not understand Deno's npm: scheme; Deno resolves and types it.
import { LighterClient, type MarketInfo } from "npm:lighter-ts/client";
// @ts-ignore -- NodeNext does not understand Deno's npm: scheme; Deno resolves and types it.
import { ApiKey } from "npm:lighter-ts/crypto";
// @ts-ignore -- NodeNext does not understand Deno's npm: scheme; Deno resolves and types it.
import { buildCreateOrder, CHAIN_ID, type CreateOrderTx, i16, i64, signTx, txHashHex, u8, u32 } from "npm:lighter-ts/tx";

/**
 * The helpers below are inlined rather than imported from `../env.ts`, unlike every other example
 * in this directory.
 *
 * Deno resolves module specifiers literally: `import "../env.js"` looks for a file named `env.js`
 * and does not fall back to `env.ts` the way Bun and `tsc` do. A quickstart you cannot copy out of
 * the repository and run is not a quickstart, so these thirty lines stay local.
 */
interface Network {
  readonly name: "testnet" | "mainnet";
  readonly chainId: number;
}

/** Testnet unless told otherwise; mainnet needs a second, separate opt-in. */
function selectNetwork(): Network {
  const requested: string = process.env["LIGHTER_NETWORK"] ?? "testnet";
  if (requested !== "testnet" && requested !== "mainnet") {
    throw new Error('LIGHTER_NETWORK must be "testnet" or "mainnet"');
  }
  if (requested === "mainnet" && process.env["LIGHTER_ALLOW_MAINNET"] !== "yes") {
    throw new Error("mainnet requires LIGHTER_ALLOW_MAINNET=yes");
  }
  // Explicit, always. The chain id is hash element 0 and is discoverable from no endpoint.
  return {
    name: requested,
    chainId: requested === "mainnet" ? CHAIN_ID.mainnet : CHAIN_ID.testnet,
  };
}

function optionalEnv(name: string): string | undefined {
  const value: string | undefined = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Read an externally supplied protocol index without accepting partial or exponential strings. */
function requiredIndex(name: string): bigint {
  const value: string | undefined = optionalEnv(name);
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative whole number`);
  }
  return BigInt(value);
}

/** The API-key slot is an 8-bit count, so a validated decimal parse is exact. */
function requiredCount(name: string): number {
  const value: string | undefined = optionalEnv(name);
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative whole number`);
  }
  return Number.parseInt(value, 10);
}

/** Lowercase hex, for printing a signature. */
function toHex(bytes: Uint8Array): string {
  let out: string = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Fixed, so the hash below is reproducible. Unix ms, 2030-01-01T00:00:00Z. */
const EXPIRED_AT: bigint = 1_893_456_000_000n;

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const accountIndex: bigint = requiredIndex("LIGHTER_ACCOUNT_INDEX");
  const apiKeyIndex: number = requiredCount("LIGHTER_API_KEY_INDEX");
  if (apiKeyIndex > 254) throw new Error("LIGHTER_API_KEY_INDEX must be in [0, 254]");
  console.log(`deno quickstart — ${network.name}, chain id ${String(network.chainId)}`);

  // ---- read (public) ----------------------------------------------------------------------------
  const client: LighterClient = new LighterClient({ endpoint: network.name });
  try {
    await client.markets.load();
    const market: MarketInfo = client.markets.get(optionalEnv("LIGHTER_MARKET") ?? "ETH");
    console.log(
      `${market.symbol}: market ${String(market.marketId)}, ` +
        `size_decimals=${String(market.sizeDecimals)} price_decimals=${String(market.priceDecimals)}`,
    );

    // ---- sign (offline) -------------------------------------------------------------------------
    const provided: string | undefined = optionalEnv("LIGHTER_API_PRIVATE_KEY");
    const key: ApiKey =
      provided === undefined ? ApiKey.generate() : ApiKey.fromPrivateKey(provided);
    if (provided === undefined) console.log("(no LIGHTER_API_PRIVATE_KEY — using an ephemeral key)");

    const unsigned: CreateOrderTx = buildCreateOrder(
      {
        marketIndex: i16(market.marketId),
        clientOrderIndex: i64(1n),
        // Protocol integers. The human tier (`marketHandle`) is what converts decimal strings, and
        // it reports what it converted them to — see `../submit-market-order.ts`.
        baseAmount: i64(5_000n),
        price: u32(250_000),
        isAsk: u8(0),
        orderType: u8(0),
        timeInForce: u8(1),
        reduceOnly: u8(0),
        triggerPrice: u32(0),
        orderExpiry: i64(EXPIRED_AT),
      },
      {
        accountIndex: i64(accountIndex),
        apiKeyIndex: u8(apiKeyIndex),
        nonce: i64(0n),
        expiredAt: i64(EXPIRED_AT),
      },
    );

    console.log(`tx hash   ${txHashHex(unsigned, network.chainId)}`);
    console.log(`signature ${toHex(signTx(unsigned, key, network.chainId).sig)}`);
    console.log("\nNo install, no bundler, no native module, no WASM.");
  } finally {
    await client.close();
  }
}

await main().catch((error: unknown): void => {
  process.exitCode = 1;
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
});
