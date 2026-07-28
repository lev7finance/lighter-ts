/**
 * One request, several transactions, consecutive nonces — and what the nonce source did about it.
 *
 * - **What it does:** cancels several orders in a single `sendTxBatch`, printing the nonce counter
 *   before and after so the run of leases is visible.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_API_PRIVATE_KEY`,
 *   plus `LIGHTER_CANCEL_IDS` — two or more comma-separated order indices to cancel.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300). Mainnet needs
 *   `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds: YES.** Cancelling live orders changes your resting exposure.
 *
 * ```sh
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_API_KEY_INDEX=1 LIGHTER_API_PRIVATE_KEY=0x… \
 *   LIGHTER_MARKET=ETH LIGHTER_CANCEL_IDS=1770000000000,1770000000001 \
 *   bun examples/send-batch.ts
 * ```
 *
 * **Precondition:** `/sendTx` is blocked from restricted jurisdictions (API code 20558, arriving as
 * HTTP 400 — `docs/protocol-notes.md` §8.3).
 *
 * ## Why the callback, instead of an array
 *
 * Every transaction in a batch must share **one** API key and carry **consecutive** nonces. The
 * obvious API — build a few transactions, push them into an array, submit the array — has nothing
 * stopping one of them from being signed by a different key, and the failure is a rejected batch
 * with no local signal. So `batch()` hands you a context whose builders are the only way in: a
 * transaction built through `b.tx` is in the batch by construction, and the whole run of nonces is
 * allocated from one key in one pass. If another caller interleaves on that key, the batch is
 * abandoned **before anything is signed**.
 *
 * `b.add(tx)` takes a transaction built elsewhere, for the same reason a callback needs an escape
 * hatch — it queues it into the same run.
 *
 * ## The raw tier
 *
 * `b.tx.*` is the raw tier: fields are `bigint`s in protocol units, 1:1 with the wire. A cancel
 * carries no price and no size, so there is no decimal conversion here at all. Anything that does
 * carry money should be built through the human tier (`marketHandle`), which reports the integers
 * it derived — see `submit-market-order.ts`.
 */

import {
  batch,
  type BatchContext,
  type LighterAccount,
  LighterClient,
  type MarketInfo,
  type NonceKeySnapshot,
  type TxReceipt,
} from "lighter-ts/client";
import { i16, i64 } from "lighter-ts/tx";
import {
  marketSymbol,
  type Network,
  reportFailure,
  requireAccountIndex,
  requireApiKeyIndex,
  requireApiPrivateKey,
  requireEnv,
  selectNetwork,
} from "./env.js";

/** Parse `"123,456"` into exact `bigint`s. Order indices are integers; nothing here is money. */
function parseOrderIds(raw: string): readonly bigint[] {
  const ids: bigint[] = [];
  for (const part of raw.split(",")) {
    const trimmed: string = part.trim();
    if (trimmed.length === 0) continue;
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new Error(`LIGHTER_CANCEL_IDS: ${JSON.stringify(trimmed)} is not a whole number`);
    }
    ids.push(BigInt(trimmed));
  }
  if (ids.length < 2) throw new Error("LIGHTER_CANCEL_IDS needs at least two order indices");
  return ids;
}

/** `apiKeyIndex → last issued nonce`, as the source reports it. `counter` is a decimal string. */
function describeNonces(keys: readonly NonceKeySnapshot[]): string {
  return keys
    .map((k: NonceKeySnapshot): string => `key ${String(k.apiKeyIndex)}: ${k.counter ?? "unused"}`)
    .join("  ");
}

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const account: { big: bigint; num: number } = requireAccountIndex();
  const apiKeyIndex: number = requireApiKeyIndex();
  const orderIds: readonly bigint[] = parseOrderIds(
    requireEnv("LIGHTER_CANCEL_IDS", "two or more comma-separated order indices to cancel"),
  );

  const client: LighterClient = new LighterClient({ endpoint: network.name });
  try {
    await client.markets.load();
    const market: MarketInfo = client.markets.get(marketSymbol());

    const lighterAccount: LighterAccount = client.account({
      accountIndex: account.big,
      keys: { [apiKeyIndex]: requireApiPrivateKey() },
      nonces: "optimistic",
      submit: "http",
    });

    console.log(`before  ${describeNonces(lighterAccount.nonces.snapshot().keys)}`);

    const receipts: readonly TxReceipt[] = await batch(lighterAccount, (b: BatchContext): void => {
      console.log(`batch is pinned to api key ${String(b.apiKeyIndex)}`);
      for (const orderId of orderIds) {
        // Queued by construction: the builder returns the transaction *and* adds it.
        b.tx.cancelOrder({ marketIndex: i16(market.marketId), index: i64(orderId) });
      }
      console.log(`queued ${String(b.size)} transactions`);
    });

    console.log(`after   ${describeNonces(lighterAccount.nonces.snapshot().keys)}\n`);
    for (const receipt of receipts) {
      console.log(
        `  nonce ${String(receipt.nonce)} on key ${String(receipt.apiKeyIndex)}  ${receipt.txHash}`,
      );
    }
    console.log(
      "\nThe nonces above are consecutive and all on one key. That is not a coincidence: it is the " +
        "one property a batch must have, and the reason `batch()` owns the builders.",
    );
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
