/**
 * Register an API key: `ChangePubKey`, signed by the new key at L2 and by your Ethereum key at L1.
 *
 * - **What it does:** generates (or accepts) an API keypair, builds the transaction, prints the
 *   exact EIP-191 message the account's L1 owner must sign, takes that signature from an
 *   **injected** signer, attaches it and submits.
 * - **Credentials:** `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_NEW_API_KEY_INDEX`, and either
 *   `LIGHTER_NEW_API_PRIVATE_KEY` (to register a key you already hold) or nothing (one is
 *   generated and printed once). The L1 signature comes from `LIGHTER_L1_SIGNATURE` in this
 *   example; in an application it comes from a wallet.
 * - **Network:** `LIGHTER_NETWORK`, default testnet (chain id 300). Mainnet needs
 *   `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds: not directly — but it changes who can move them.** Registering
 *   a key grants that key the ability to trade the account. Rotating a slot something else is
 *   using breaks that thing.
 *
 * ```sh
 * # 1. print the message to sign, and stop
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_NEW_API_KEY_INDEX=2 bun examples/l1-change-pub-key.ts
 *
 * # 2. sign it with your wallet, then re-run with the same key material and the signature
 * LIGHTER_ACCOUNT_INDEX=… LIGHTER_NEW_API_KEY_INDEX=2 \
 *   LIGHTER_NEW_API_PRIVATE_KEY=0x… LIGHTER_L1_SIGNATURE=0x… \
 *   bun examples/l1-change-pub-key.ts
 * ```
 *
 * **Precondition:** `/sendTx` is blocked from restricted jurisdictions (API code 20558 arriving as
 * HTTP 400 — `docs/protocol-notes.md` §8.3).
 *
 * ## This package holds no Ethereum key and ships no secp256k1
 *
 * Four flows bind an L2 action to an Ethereum address — `change_pub_key`, `transfer`,
 * `approve_integrator` and `create_sub_account`. For all four the SDK builds the **exact message
 * string**, which is the part that is easy to get wrong and is pinned byte-for-byte by
 * `conformance/vectors/tx.json` → `l1Messages`. The signature comes from outside
 * (`docs/decisions.md` D6): your application already holds its L1 keys in a wallet or custody
 * layer, and reimplementing keccak256, secp256k1 and public-key recovery here would mean several
 * hundred lines of unvalidated cryptography for a signature this package cannot produce anyway.
 *
 * The seam is one structural interface:
 *
 * ```ts
 * interface EthPersonalSigner {
 *   signMessage(message: string): Promise<`0x${string}`>;   // r ‖ s ‖ v, 65 bytes
 *   getAddress?(): Promise<`0x${string}`>;
 * }
 * ```
 *
 * ### viem does not satisfy it verbatim
 *
 * viem's `signMessage` takes an **options object**, not a bare string, so the adapter is a real
 * (one-line) adapter and not a coincidence:
 *
 * ```ts
 * // in your application — viem is not a dependency of this package, and the single quotes below
 * // are deliberate: CI greps this directory for a double-quoted third-party import.
 * import { createWalletClient, custom } from 'viem';
 * const walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
 *
 * const l1Signer: EthPersonalSigner = {
 *   signMessage: (message) => walletClient.signMessage({ account, message }),
 *   getAddress: async () => account.address,
 * };
 * ```
 *
 * An EIP-1193 provider needs the message as UTF-8 hex, with the arguments the other way round:
 *
 * ```ts
 * const l1Signer: EthPersonalSigner = {
 *   signMessage: (message) =>
 *     provider.request({ method: "personal_sign", params: [toHex(message), address] }),
 * };
 * ```
 *
 * A library whose `signMessage` already takes a bare string — ethers' `Signer` — satisfies the
 * interface as it stands.
 *
 * ## Order of operations
 *
 * The L1 message renders the **nonce**, so the nonce has to be settled before the message exists.
 * The L2 hash, by contrast, covers neither `Sig` nor `L1Sig` — so the two signatures are
 * independent and may be produced in either order. This example fetches the nonce explicitly and
 * signs in caller-managed mode, which means nothing is allocated (and nothing is burned) while you
 * are away signing in a wallet.
 *
 * The **new** key signs at L2: a key authorises its own registration.
 */

import {
  createApiKey,
  type GeneratedApiKey,
  type LighterAccount,
  LighterClient,
  type TxReceipt,
} from "lighter-ts/client";
import { ApiKey } from "lighter-ts/crypto";
import type { NextNonce } from "lighter-ts";
import {
  type ChangePubKeyTx,
  type EthPersonalSigner,
  l1MessageFor,
  type SignedTx,
} from "lighter-ts/tx";
import {
  type Network,
  optionalEnv,
  reportFailure,
  requireAccountIndex,
  requireCount,
  selectNetwork,
} from "./env.js";

/** `0x` followed by 130 hex digits: 65 bytes of `r ‖ s ‖ v`, with `v ∈ {27, 28}`. */
const L1_SIG_PATTERN: RegExp = /^0x[0-9a-fA-F]{130}$/;

/**
 * A stand-in for your wallet.
 *
 * It does no cryptography — it cannot, and neither can this package. It prints the message the SDK
 * built and reads the signature back out of the environment, which is exactly the shape of the real
 * thing: the message goes out to something that holds an L1 key, and 65 bytes come back.
 */
function envSigner(): EthPersonalSigner {
  return {
    async signMessage(message: string): Promise<`0x${string}`> {
      const provided: string | undefined = optionalEnv("LIGHTER_L1_SIGNATURE");
      if (provided === undefined) {
        console.log("\n--- sign this message with the account's L1 owner ------------------------");
        console.log(message);
        console.log("--------------------------------------------------------------------------");
        console.log(
          "\nSign it verbatim — EIP-191 personal_sign, no trimming, no re-encoding. Then re-run\n" +
            "with LIGHTER_L1_SIGNATURE=0x… and the same LIGHTER_NEW_API_PRIVATE_KEY.\n",
        );
        throw new Error("no LIGHTER_L1_SIGNATURE provided; nothing was submitted");
      }
      if (!L1_SIG_PATTERN.test(provided)) {
        throw new Error(
          "LIGHTER_L1_SIGNATURE must be 0x followed by 130 hex characters (r ‖ s ‖ v, 65 bytes)",
        );
      }
      return provided as `0x${string}`;
    },
  };
}

async function main(): Promise<void> {
  const network: Network = selectNetwork();
  const account: { big: bigint; num: number } = requireAccountIndex();
  const slot: number = requireCount(
    "LIGHTER_NEW_API_KEY_INDEX",
    "the API key slot to register or rotate (0 is the web app's; use >= 1)",
  );

  // Either the key you already hold, or a fresh one. `createApiKey()` draws from the platform
  // CSPRNG inside the call — never at module scope, which Cloudflare Workers forbids.
  const existing: string | undefined = optionalEnv("LIGHTER_NEW_API_PRIVATE_KEY");
  let privateKeyHex: string;
  if (existing === undefined) {
    const generated: GeneratedApiKey = createApiKey();
    privateKeyHex = generated.privateKeyHex;
    console.log(
      "\n!! A NEW API PRIVATE KEY WAS GENERATED. Store it now — it is not recoverable, and the\n" +
        "!! registration below is worthless without it.\n",
    );
    console.log(`LIGHTER_NEW_API_PRIVATE_KEY=${generated.privateKeyHex}\n`);
  } else {
    privateKeyHex = existing;
  }

  const newKey: ApiKey = ApiKey.fromPrivateKey(privateKeyHex);
  console.log(`registering ${newKey.publicKeyHex}`);
  console.log(`  on account ${String(account.num)}, api key slot ${String(slot)}, ${network.name}`);

  const client: LighterClient = new LighterClient({ endpoint: network.name });
  try {
    // The nonce for this slot, read explicitly. `nextNonce` is public — it needs no credential.
    // Fetching it here (rather than letting the account lease one) keeps the wallet round trip out
    // of the middle of a lease: if you never come back with a signature, nothing was consumed.
    const next: NextNonce = await client.rest.transaction.nextNonce({
      account_index: account.num,
      api_key_index: slot,
    });
    if (next.nonce === undefined) throw new Error("nextNonce returned no nonce");
    const nonce: bigint = BigInt(next.nonce);
    console.log(`  nonce ${String(nonce)}\n`);

    // One signer, configured on the account *and* called directly below. Configuring it is what a
    // real application does — the higher-level write helpers reach for `account.l1Signer` — while
    // calling it here is what makes the message visible in this example's output.
    const l1Signer: EthPersonalSigner = envSigner();

    // The account signs with the *new* key, in the slot being registered.
    const lighterAccount: LighterAccount = client.account({
      accountIndex: account.big,
      keys: { [slot]: privateKeyHex },
      // Caller-managed below, so the source is never consulted; named for completeness.
      nonces: "manual",
      l1Signer,
      submit: "http",
    });

    const tx: ChangePubKeyTx = lighterAccount.tx.changePubKey({
      // 40 bytes, five little-endian 64-bit limbs — not the hex string.
      pubKey: newKey.publicKeyBytes,
    });

    // Caller-managed mode: the nonce and the key are stated, so nothing is leased and nothing has
    // to be rolled back. The message below renders this exact nonce.
    const prepared: SignedTx = await lighterAccount.prepare(tx, { nonce, apiKeyIndex: slot });

    // The byte-exact `Register Lighter Account` body. Every character of it is pinned by
    // `conformance/vectors/tx.json` → `l1Messages`.
    const message: string | null = l1MessageFor(prepared, client.chainId);
    if (message === null) {
      throw new Error("ChangePubKey has no L1 message; the template table is corrupt");
    }

    const signature: `0x${string}` = await l1Signer.signMessage(message);

    // Attaches `L1Sig` and submits. The L2 hash does not cover `L1Sig`, so the signature computed
    // above is still valid for the transaction this sends.
    const receipt: TxReceipt = await lighterAccount.submitWithL1Signature(prepared, signature);
    console.log(`submitted ${receipt.txHash}  nonce=${String(receipt.nonce)}`);
    console.log(
      "\nGive the sequencer a few seconds, then confirm with " +
        `GET /api/v1/apikeys?account_index=${String(account.num)}&api_key_index=${String(slot)} — ` +
        "the registered public key should equal the one printed above.",
    );
  } finally {
    await client.close();
  }
}

await main().catch(reportFailure);
