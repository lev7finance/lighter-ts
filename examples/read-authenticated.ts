/**
 * An authenticated read: mint an auth token offline, then call an endpoint that requires one.
 *
 * - **What it does:** builds a Lighter auth token from an API key, uses it to fetch the account's
 *   active orders, and shows where the token goes on the wire.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_API_PRIVATE_KEY`.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300).
 * - **Whether it moves real funds:** no. Two `GET`s; nothing is submitted.
 *
 * ```sh
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_API_KEY_INDEX=1 LIGHTER_API_PRIVATE_KEY=0x… \
 *   bun examples/read-authenticated.ts
 * ```
 *
 * ## The token goes in the `Authorization` header
 *
 * The API accepts it in **either** the `Authorization` header or an `auth` query parameter — a fact
 * neither reference SDK documents, discovered from the error text on an unauthenticated call
 * (`docs/protocol-notes.md` §8.1.1):
 *
 * ```
 * {"code":20001,"message":"invalid param : auth query param and Authorization header are empty"}
 * ```
 *
 * This SDK sends the header by default, and that is the right default: a token is a bearer
 * credential, and a query parameter puts it into URLs, access logs and referrers. The query channel
 * is still reachable per call (`{ authIn: "query" }`) for environments that strip the header — it
 * is a workaround, not an alternative.
 *
 * Note there is **no scheme prefix**: the value is the raw token, not `Bearer <token>`.
 *
 * ## Two ways to supply it, and why the second is usually right
 *
 * `auth` takes a constant string or a provider function. A token carries an absolute deadline, so a
 * constant minted at start-up expires while a long-lived process is still running; a provider is
 * called per request and can re-mint. This example shows both — the provider is the one to copy.
 */

import { createAuthToken, LighterClient } from "lighter-ts/client";
import { ApiKey } from "lighter-ts/crypto";
import type { Order, Orders } from "lighter-ts";
import {
  type Network,
  reportFailure,
  requireAccountIndex,
  requireApiKeyIndex,
  requireApiPrivateKey,
  selectNetwork,
} from "./env.js";

/** Ten minutes, the Python client's default. Short on purpose: a token is a bearer credential. */
const TOKEN_LIFETIME_SECONDS: 600 = 600;

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const account: { big: bigint; num: number } = requireAccountIndex();
  const apiKeyIndex: number = requireApiKeyIndex();

  // The one object in this SDK that holds secret material. The token is signed locally; the private
  // key never leaves this process and is never sent anywhere.
  const key: ApiKey = ApiKey.fromPrivateKey(requireApiPrivateKey());
  const keys: ReadonlyMap<number, ApiKey> = new Map<number, ApiKey>([[apiKeyIndex, key]]);

  // Entirely offline: three integers, a Poseidon2 hash and a Schnorr signature. No I/O, no clock
  // beyond `Date.now()` for the deadline.
  const token: string = createAuthToken(
    { accountIndex: account.big, keys },
    { apiKeyIndex, expirySeconds: TOKEN_LIFETIME_SECONDS },
  );
  const [deadline = "?", tokenAccount = "?", tokenKey = "?"] = token.split(":");
  console.log(
    "token       <deadline>:<accountIndex>:<apiKeyIndex>:<signature>\n" +
      `            deadline=${deadline} (unix SECONDS, not ms)  account=${tokenAccount}  key=${tokenKey}\n` +
      "            signature elided — this is a bearer credential; do not log it",
  );

  const client: LighterClient = new LighterClient({
    endpoint: network.name,
    // A provider, called per request. Re-minting is one Schnorr signature, so there is no reason to
    // cache a credential that carries an absolute deadline.
    //
    //   auth: token,                       // also valid: a constant string
    auth: (): string => createAuthToken({ accountIndex: account.big, keys }, { apiKeyIndex }),
  });

  try {
    const orders: Orders = await client.rest.order.accountActiveOrders({
      account_index: account.num,
    });
    const list: readonly Order[] = orders.orders ?? [];
    console.log(`\n${String(list.length)} active order(s) on account ${String(account.num)}`);
    for (const order of list.slice(0, 10)) {
      // Prices and sizes stay decimal strings all the way to the screen. Rendering one through a
      // float is how `"2064.54"` becomes `2064.5399999999995`.
      console.log(
        `  #${order.order_index ?? "?"}  market=${String(order.market_index ?? -1)}  ` +
          `${order.is_ask === true ? "sell" : "buy"}  ` +
          `${order.remaining_base_amount ?? "?"} @ ${order.price ?? "?"}  ${order.status ?? "?"}`,
      );
    }
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
