# Examples

A small acceptance set, not a tour. Five things prove the SDK is *usable* rather than merely
correct — **read, sign, submit, stream, and L1 signature injection** — and there is one example for
each, plus three that exist to show the runtimes this package was built for. That is a deliberate
scope choice (`docs/decisions.md` D10): the Python SDK ships roughly 63 scripts and mirroring them
would produce sixty-three places for the same mistake to be copied out of.

Because examples are the most-copied code in any SDK, each one is also a style contract. Whatever
these do with money arithmetic, users will do too — so none of them ever puts a price or a size
through a float.

## The set

| File | Demonstrates | Credentials | Moves funds |
| --- | --- | --- | --- |
| [`read-order-books.ts`](read-order-books.ts) | `GET /orderBooks`; the three decimal exponents everything else depends on | none | no |
| [`read-authenticated.ts`](read-authenticated.ts) | minting an auth token offline; it travels in the `Authorization` header, not the `auth` query parameter | account index, API key index, API private key | no |
| [`sign-offline.ts`](sign-offline.ts) | build → hash → sign → serialise with **no network and no clock** | API private key (optional — an ephemeral one is generated) | no |
| [`submit-market-order.ts`](submit-market-order.ts) | the human tier: decimal strings in, protocol integers out, `dryRun` first, `applied` printed | account index, API key index, API private key | **yes** |
| [`create-modify-cancel.ts`](create-modify-cancel.ts) | the resting-order lifecycle over HTTP, and `receipt.wait()` | account index, API key index, API private key | **yes** |
| [`send-batch.ts`](send-batch.ts) | one `sendTxBatch`, one key, consecutive nonces — with the nonce counter printed either side | account index, API key index, API private key, order ids to cancel | **yes** |
| [`stream-order-book.ts`](stream-order-book.ts) | a WebSocket book kept sorted, with gaps and resets surfaced rather than swallowed | none | no |
| [`l1-change-pub-key.ts`](l1-change-pub-key.ts) | the injected `EthPersonalSigner` seam: the SDK builds the EIP-191 message, a wallet signs it | account index, key slot, an L1 signature from your wallet | not directly — it changes who *can* |
| [`workers/signer-worker.ts`](workers/signer-worker.ts) | signing and submitting inside a Cloudflare Worker (paid tier) | Worker secrets | **yes** |
| [`deno/quickstart.ts`](deno/quickstart.ts) | Deno, `npm:lighter-ts`, no install and no build step | none | no |
| [`browser/index.html`](browser/index.html) | signing in the browser with a plain `<script type="module">`, no bundler | none | no |
| [`env.ts`](env.ts) | shared: network selection, credential reading, the mainnet guard | none | no |

Every `.ts` file opens with a header stating those four things for itself. `env.ts` is imported by
the others rather than run directly; `deno/quickstart.ts` and `workers/signer-worker.ts` are
self-contained, for reasons each explains.

## Running them

The documented runner is Bun, from the repository root:

```sh
bun run build                      # the examples typecheck against dist/
bun examples/sign-offline.ts       # needs nothing at all
bun examples/read-order-books.ts   # public reads, testnet by default
```

`deno/quickstart.ts` runs under Deno (`deno run --allow-net --allow-env examples/deno/quickstart.ts`),
`browser/index.html` wants any static file server, and `workers/signer-worker.ts` is illustrative —
copy it into a Worker project of your own.

CI typechecks every file here against the built `dist/` and **never executes any of them**.

## Environment

| Variable | Meaning |
| --- | --- |
| `LIGHTER_NETWORK` | `testnet` (default) or `mainnet` |
| `LIGHTER_ALLOW_MAINNET` | must be `yes` before anything will target mainnet |
| `LIGHTER_ACCOUNT_INDEX` | the account to act on |
| `LIGHTER_API_KEY_INDEX` | the API key slot to sign with (`0` is the web app's; use `>= 1`) |
| `LIGHTER_API_PRIVATE_KEY` | that slot's private key, `0x` + 80 hex characters |
| `LIGHTER_MARKET` | market symbol, default `ETH` |
| `LIGHTER_SIDE`, `LIGHTER_SIZE`, `LIGHTER_NOTIONAL`, `LIGHTER_MAX_SLIPPAGE` | order parameters, all decimal **strings** |
| `LIGHTER_LIMIT_PRICE`, `LIGHTER_LIMIT_PRICE_2` | `create-modify-cancel.ts` |
| `LIGHTER_CANCEL_IDS` | `send-batch.ts`, comma-separated |
| `LIGHTER_NEW_API_KEY_INDEX`, `LIGHTER_NEW_API_PRIVATE_KEY`, `LIGHTER_L1_SIGNATURE` | `l1-change-pub-key.ts` |
| `LIGHTER_STREAM_UPDATES` | how many frames `stream-order-book.ts` prints before exiting |

No private key, token or account index is hard-coded anywhere here, and a missing variable produces
an error that names it.

## Preconditions worth knowing before you debug the wrong thing

**Geo-restriction.** From a restricted jurisdiction, `/sendTx` and the WebSocket upgrade are refused
with API code **20558**, which arrives as **HTTP 400** — so it reads as a validation error while
every public read keeps succeeding (`docs/protocol-notes.md` §8.3). Each fund-moving example says so
in its header, and `env.ts` prints an explicit note when it sees that code. Run those examples by
hand against testnet; they are never run in CI.

**Mainnet is opt-in twice.** `LIGHTER_NETWORK=mainnet` alone is refused. It also needs
`LIGHTER_ALLOW_MAINNET=yes`, because a typo in one variable should not be enough to trade real
money.

**The chain id is configuration.** It is the first element of every transaction hash and is
discoverable from no endpoint (`docs/protocol-notes.md` §7). `env.ts` states it explicitly —
testnet 300, mainnet 304 — and cross-checks it against the endpoint profile's own copy. Nothing here
infers it from a URL.

**Node 20 has no global `WebSocket`.** Bun, Deno, browsers and Workers do. The SDK accepts an
injected constructor instead of shipping one:

```ts
import { WebSocket } from "undici";
const client = new LighterClient({ endpoint: "testnet", WebSocket });
```

**Cloudflare's free tier is not supported for signing** (`docs/decisions.md` D4). A signature is
about 85 000 base-field multiplications; the paid tier's 30 s CPU limit is not a constraint, and the
free tier's ~10 ms budget is.

## The rules these examples follow, and why

**No third-party imports.** This package has zero runtime dependencies and these files add none —
a grep for `viem`, `ethers` or any scoped package across `examples/` comes back empty.
`l1-change-pub-key.ts` writes its signer against the structural `EthPersonalSigner` interface and
shows the viem call shape in a comment. viem's `signMessage` takes an **options object**, so it does
not satisfy that interface verbatim; the one-line adapter is real, not ceremonial
(`docs/decisions.md` D6).

**No `number` for money.** Sizes, prices, notionals and slippage bounds are decimal strings, and the
SDK converts them once, under a stated rounding policy. The float-arithmetic grep in this unit's
verification block comes back empty across `examples/`, comments included. The reference SDKs have
four documented arithmetic hazards here (`docs/protocol-notes.md` §9) and each of them is invisible
at the call site, which is why every human-tier call in these examples prints `receipt.applied` —
the integers that were actually signed.

**Rounding direction is stated.** A buy's acceptable price rounds **up** and a sell's rounds
**down**, so rounding can never loosen slippage protection. A resting order rounds the other way, for
the same reason.

**Nothing that can move money defaults to mainnet.**
