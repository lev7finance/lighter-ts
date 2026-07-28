/**
 * Build, hash and sign a transaction with **no network and no clock**.
 *
 * - **What it does:** constructs an `L2CreateOrder`, prints the 40-byte transaction hash, signs it,
 *   prints the 80-byte signature, and prints the exact `tx_info` document that `POST
 *   /api/v1/sendTx` would carry.
 * - **Credentials:** `LIGHTER_API_PRIVATE_KEY` if you have one. If it is absent, an **ephemeral**
 *   key is generated in memory so the example still runs; nothing signed with it is submittable.
 * - **Network:** none is contacted. The chain id is passed explicitly — `LIGHTER_NETWORK` only
 *   chooses which number (testnet 300, mainnet 304).
 * - **Whether it moves real funds:** no. Nothing is submitted, and nothing here can submit.
 *
 * ```sh
 * bun examples/sign-offline.ts                 # ephemeral key
 * LIGHTER_API_PRIVATE_KEY=0x… bun examples/sign-offline.ts
 * ```
 *
 * ## Why this one matters
 *
 * `build → hash → sign → serialise` are four separate functions, so the machine holding the key
 * never needs the network and the machine holding the market data never needs the key. Forty bytes
 * cross between them. Pull the ethernet cable and this example still passes — that is the test.
 *
 * Three things it is careful about, each of which is a way to get a *valid-looking* signature that
 * the sequencer discards:
 *
 * 1. **The chain id is an argument, not an inference.** It is the first element of the hash. Sign
 *    with 304 and post to testnet and you get a perfectly well-formed signature over a transaction
 *    for a chain the sequencer is not.
 * 2. **`expiredAt` is explicit.** The builders read a clock only to default it. Passing it makes
 *    the transaction hash reproducible, which is exactly what an offline signer wants.
 * 3. **Sizes and prices are already integers here.** This is the raw tier: `baseAmount` is an
 *    integer count of `10^-size_decimals` and `price` an integer count of `10^-price_decimals`.
 *    There is no decimal arithmetic on this path at all — see `submit-market-order.ts` for the tier
 *    that does the conversion, and prints what it converted to.
 *
 * The hash is deterministic; **the signature is not**. `k` is hedged-deterministic — derived from
 * the key and the message and mixed with fresh randomness (`docs/decisions.md` D2) — so two runs
 * produce two different, equally valid signatures over the same hash.
 */

import { ApiKey } from "lighter-ts/crypto";
import {
  buildCreateOrder,
  type CreateOrderTx,
  i16,
  i64,
  signTx,
  txHashHex,
  txSubmission,
  type TxSubmission,
  u8,
  u32,
} from "lighter-ts/tx";
import { optionalEnv, reportFailure, selectNetwork, toHex } from "./env.js";

/**
 * A fixed expiry, so this example is reproducible.
 *
 * Unix **milliseconds**: 2030-01-01T00:00:00Z. A real caller passes `Date.now() + window` or lets
 * the builder default it — but then the hash changes every run, and an offline signer usually wants
 * the opposite.
 */
const EXPIRED_AT: bigint = 1_893_456_000_000n;

/** ETH-PERP on testnet, and the decimals it declares: size 4, price 2, quote 6. */
const MARKET_INDEX: 0 = 0;
const SIZE_DECIMALS: 4 = 4;
const PRICE_DECIMALS: 2 = 2;

function main(): void {
  const { chainId, name } = selectNetwork();

  const provided: string | undefined = optionalEnv("LIGHTER_API_PRIVATE_KEY");
  // `ApiKey.generate()` draws from `globalThis.crypto` **inside the call**, never at module scope:
  // Cloudflare Workers forbids randomness during global evaluation.
  const key: ApiKey = provided === undefined ? ApiKey.generate() : ApiKey.fromPrivateKey(provided);
  if (provided === undefined) {
    console.log("no LIGHTER_API_PRIVATE_KEY — signing with an ephemeral key, for demonstration only");
  }
  console.log(`public key  ${key.publicKeyHex}`);
  console.log(`chain id    ${String(chainId)} (${name}) — an explicit argument, never sniffed\n`);

  // 0.5000 ETH at 2500.00, expressed the way the wire expresses it: integers at the market's own
  // precision. 0.5 × 10^4 = 5000; 2500 × 10^2 = 250000.
  //
  // `baseAmount` is an `int64` and therefore a `bigint`; `price` is a `uint32`, whose whole domain
  // sits inside the safe-integer range, so the codec types it `number`. Both are **exact integer
  // counts**, not floating-point money — the thing D7 forbids is a fractional `number`, and neither
  // of these is one.
  const baseAmount: bigint = 5_000n;
  const price: number = 250_000;

  const unsigned: CreateOrderTx = buildCreateOrder(
    {
      marketIndex: i16(MARKET_INDEX),
      clientOrderIndex: i64(1n),
      baseAmount: i64(baseAmount),
      price: u32(price),
      isAsk: u8(0), // 0 = buy
      orderType: u8(0), // LIMIT
      timeInForce: u8(1), // GOOD_TILL_TIME
      reduceOnly: u8(0),
      triggerPrice: u32(0),
      orderExpiry: i64(EXPIRED_AT),
    },
    {
      accountIndex: i64(1n),
      apiKeyIndex: u8(1),
      nonce: i64(0n),
      // Supplied, so no clock is read anywhere on this path.
      expiredAt: i64(EXPIRED_AT),
    },
  );

  console.log(
    `order       baseAmount=${String(baseAmount)} (10^-${String(SIZE_DECIMALS)} ETH)  ` +
      `price=${String(price)} (10^-${String(PRICE_DECIMALS)} USDC)`,
  );

  // The digest, without a key in the room. This is the value an air-gapped signer receives.
  const hash: string = txHashHex(unsigned, chainId);
  console.log(
    `tx hash     ${hash}  (${String(hash.length)} hex chars, no 0x — this is what /sendTx echoes back)`,
  );

  const signed: CreateOrderTx & { sig: Uint8Array } = signTx(unsigned, key, chainId);
  console.log(`signature   ${toHex(signed.sig)}`);
  console.log(`            ${String(signed.sig.length)} bytes: s ‖ e. Synchronous on every runtime.`);

  const submission: TxSubmission = txSubmission(signed, chainId);
  console.log(`\ntx_type     ${String(submission.txType)}`);
  console.log(`tx_info     ${submission.txInfo}`);
  console.log(
    "\nThat document plus tx_type is the entire body of POST /api/v1/sendTx. Nothing above it " +
      "touched the network.",
  );
}

try {
  main();
} catch (error: unknown) {
  reportFailure(error);
}
