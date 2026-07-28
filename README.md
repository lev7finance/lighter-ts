# lighter-ts

Pure-TypeScript SDK for [Lighter](https://lighter.xyz). No native binaries, no WASM, no FFI, zero
runtime dependencies.

[![npm](https://img.shields.io/npm/v/lighter-ts.svg)](https://www.npmjs.com/package/lighter-ts)
[![ci](https://github.com/lev7finance/lighter-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/lev7finance/lighter-ts/actions/workflows/ci.yml)
[![gzip](https://img.shields.io/bundlephobia/minzip/lighter-ts)](https://bundlephobia.com/package/lighter-ts)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#zero-dependencies-is-a-ci-gate)
[![runtimes](https://img.shields.io/badge/runtimes-Bun%20%C2%B7%20Node%2020%2B%20%C2%B7%20Deno%20%C2%B7%20Workers%20%C2%B7%20Browser-informational)](#runtime-support)

Signing, transaction encoding, REST, WebSocket and a stateful trading client — all of it TypeScript
that runs unmodified on Bun, Node 20+, Deno, Cloudflare Workers and in a browser.

---

## Why this exists

The official SDKs cannot run in the places a modern trading service runs.

| | how it signs | where it runs |
| --- | --- | --- |
| `lighter-python` | a platform-specific compiled Go shared library loaded through `ctypes` | wherever a matching prebuilt `.so`/`.dylib` exists |
| `lighter-go` | Go | wherever Go runs |
| **`lighter-ts`** | TypeScript, `BigInt` arithmetic | any ES2022 runtime with `fetch` |

The Python SDK's signer is not Python. It is a Go binary shipped per platform, so an unusual
architecture, a slim container, a serverless isolate or a browser has nothing to load. Neither
official SDK runs on Cloudflare Workers, and neither runs in a browser tab.

This package reimplements the protocol — the Goldilocks field, `GF(p^5)`, Poseidon2, the ECgFp5
curve, Schnorr, the transaction codec, the REST surface and the WebSocket protocol — from the
specification, and proves the result byte-identical against vectors generated from the Go reference.
It shares no code with either SDK.

What that buys, concretely: one signing implementation for your server, your edge worker, your CLI
and your front end; no postinstall step; no binary to audit; and a dependency tree that is exactly
empty.

### Zero dependencies is a CI gate

`"dependencies": {}` in `package.json`, and CI fails the build if that changes, if anything in
`src/` imports a `node:` built-in or touches a Node global, or if a `.wasm`/`.node`/`.so`/`.dylib`
file appears anywhere in the published files. `typescript`, `@types/node`, `bun-types`,
`@cloudflare/workers-types` and `wrangler` are devDependencies and are not installed by consumers.

---

## Install

```sh
bun add lighter-ts
npm i lighter-ts
pnpm add lighter-ts
deno add npm:lighter-ts
```

ESM only. There is no CommonJS entry point.

**Node 20 has no global `WebSocket`.** REST and signing work there with nothing extra; the WebSocket
layer needs a constructor passed in:

```ts
import { WebSocket } from "undici";
import { LighterClient } from "lighter-ts/client";

const lighter = new LighterClient({ endpoint: "mainnet", WebSocket });
```

Node 22+, Bun, Deno, Cloudflare Workers and browsers all have a global `WebSocket`, and the SDK uses
it without configuration. Touching `lighter.ws` in a runtime with neither throws a
`LighterConfigError` that says so.

---

## 60-second quickstart, read-only

No keys, no signing, no account.

```ts
import { LighterClient } from "lighter-ts/client";
import { channels } from "lighter-ts/ws";

const lighter = await LighterClient.connect({ endpoint: "mainnet" });

const eth = lighter.markets.get("ETH");
const book = await lighter.rest.order.orderBookOrders({ market_id: eth.marketId, limit: 5 });

console.log("best bid", book.bids?.[0]?.price, "best ask", book.asks?.[0]?.price);

const trades = lighter.ws.subscribe(channels.trades(eth.marketId));
for await (const event of trades) {
  if (event.kind === "update") console.log(event.data.trades?.length, "trades");
  if (event.kind === "reset") console.log("resync:", event.reason);
}

await lighter.close();
```

`LighterClient.connect()` is `new LighterClient(...)` plus `await markets.load()`. The constructor
itself performs no I/O at all — no fetch, no timer, no randomness — so a client can be built at
module scope in a Worker's global phase and reused per request.

Prices and sizes are decimal **strings**, exactly as the wire sent them. Do not put them through
`Number`; see [docs/rest.md](docs/rest.md#money-arrives-as-decimal-strings).

---

## Signing quickstart

> **Keys.** An API key private key signs money-moving transactions. Read it from your secret store at
> runtime. Do not commit it, do not ship it in a bundle that reaches a browser, and do not log
> objects that might contain it — the SDK redacts credentials from its own diagnostics
> ([Security](#security)), but it cannot redact yours.

```ts
import { LighterClient } from "lighter-ts/client";
import { i16, i64, OrderTimeInForce, OrderType, u32, u8 } from "lighter-ts/tx";

const lighter = await LighterClient.connect({ endpoint: "mainnet" });

const account = lighter.account({
  accountIndex: 12345n,
  keys: { 0: API_KEY_PRIVATE_KEY }, // slot -> 40-byte private key, hex or bytes
});

const eth = lighter.markets.get("ETH");

const order = account.tx.createOrder({
  marketIndex: i16(eth.marketId),
  clientOrderIndex: i64(1n),
  baseAmount: i64(1_000n),
  price: u32(250_000),
  isAsk: u8(0),
  orderType: u8(OrderType.Limit),
  timeInForce: u8(OrderTimeInForce.GoodTillTime),
  reduceOnly: u8(0),
  triggerPrice: u32(0),
  orderExpiry: i64(BigInt(Date.now() + 86_400_000)),
});

const receipt = await account.send(order); // build -> validate -> hash -> sign -> submit
console.log(receipt.txHash);

const result = await receipt.wait({ timeoutMs: 30_000 });
console.log(result.status);
```

That is the **raw tier**: `bigint` in protocol units, 1:1 with the wire, width-branded so a bare
`number` cannot land where an `int64` belongs. If you would rather write `"0.10"` and `"4210.25"`
and have the SDK convert them under a stated rounding policy, that is the **decimal tier** —
[docs/client.md](docs/client.md#two-numeric-tiers).

### L1 signatures are injected

Four flows bind an L2 action to an Ethereum address and need an EIP-191 `personal_sign`:

| flow | builder |
| --- | --- |
| `change_pub_key` | `account.tx.changePubKey(...)` |
| `transfer` | `account.tx.transfer(...)` |
| `approve_integrator` | `account.tx.approveIntegrator(...)` |
| `create_sub_account` | `account.tx.createSubAccount(...)` |

**This package ships no secp256k1, no keccak256, no public-key recovery and no EIP-55.** It builds
the exact message string — the part that is easy to get wrong, and the part pinned byte for byte in
`conformance/vectors/tx.json` under `l1Messages` — and takes the 65-byte signature from a signer you
inject. Your application already holds its L1 keys in a wallet or custody layer; hand-rolling that
curve here would be several hundred lines of unvalidated cryptography for a signature this package
cannot produce anyway, because it never sees the key.

viem's `signMessage` takes an **options object**, so it does not satisfy the interface verbatim. The
adapter is real code, not a cast:

```ts
import type { EthPersonalSigner } from "lighter-ts/tx";

// walletClient: a viem WalletClient. account: the viem Account it signs with.
const l1Signer: EthPersonalSigner = {
  signMessage: (message) => walletClient.signMessage({ account, message }),
  getAddress: async () => account.address,
};

const acct = lighter.account({ accountIndex: 12345n, keys: { 0: API_KEY_PRIVATE_KEY }, l1Signer });
```

ethers' `Signer.signMessage` already takes a bare string and satisfies the interface as it stands.
An EIP-1193 provider needs the message as UTF-8 hex with the arguments reversed; the TSDoc on
`EthPersonalSigner` carries that adapter too.

Without an `l1Signer`, those four flows raise `L1SignatureRequiredError`, which carries the exact
message that needs signing. Sign it out of band and resume with
`account.submitWithL1Signature(tx, sig)`.

---

## Runtime support

| | REST | WebSocket | Signing |
| --- | --- | --- | --- |
| **Bun ≥ 1.1** | yes | yes | yes |
| **Node 20** | yes | needs an injected `WebSocket` (e.g. `undici`'s) — Node 20 has no global one | yes |
| **Node 22 / 24** | yes | yes | yes |
| **Deno 2** | yes | yes | yes |
| **Cloudflare Workers** | yes | a socket cannot be held across requests outside a Durable Object | **paid tier only**, see below |
| **Browser** | yes, subject to the venue's CORS policy; `User-Agent` is never set, because it is a forbidden header name | yes | yes, but a key in a browser is a key the user can read |

Every row is exercised in CI: the built `dist/` is replayed against the conformance vectors on Bun
1.3.0, Bun latest, Node 20, 22 and 24, Deno 2, and `workerd` with `nodejs_compat` **off** — which is
what proves, rather than asserts, that no Node built-in is reachable.

`User-Agent` is environment-conditional and deliberately so. On server runtimes the SDK sends a
configurable browser-like one, because some paths are answered with a 403 HTML interstitial by the
CDN without it. In a browser it sends none: `User-Agent` is a forbidden header name that the fetch
spec drops silently, and adding custom headers can turn a simple request into a CORS preflight that
then fails. The SDK detects the environment rather than the runtime name. Never set it yourself in
browser code.

### Cloudflare Workers: paid tier is the supported target; free-tier signing is not

**Signing on the Workers free tier is not a supported configuration.** The paid tier's CPU limit is
30 s, configurable to 5 min, which is comfortable. The free tier's budget is roughly 10 ms of CPU per
request, and one Schnorr signature is on the order of 85,000 base-field multiplications — so staying
inside it would require ≤117 ns per multiplication sustained, for the signature alone, before the
transaction hash, the nonce derivation and everything else the request does.

The figures below are measurements on **desktop Apple Silicon**, 2,000,000 iterations after a
200,000-iteration warmup, best of three reduction strategies, taken 2026-07-25 with
`bench/field.bench.ts` ([`bench/README.md`](bench/README.md)):

| runtime | ns per field multiplication | extrapolated ms per signature |
| --- | --- | --- |
| Bun 1.3.0 | 34.6 | ~2.9 |
| Node 24.10 | 28.0 | ~2.4 |
| Deno 2.9.0 | 19.0 | ~1.6 |

Read those as what they are. They were taken on a laptop, not in a Workers isolate, and a
per-signature figure extrapolated from a hot multiplication loop ignores point additions, allocation
pressure, Poseidon2 and nonce derivation. They sit comfortably inside a paid-tier budget, and that is
the only claim being made. `cloudflare.cpu_time_ms` at p50/p99 from a *deployed* Worker has not been
recorded in this repository yet; when it is, it replaces the table above, because it is the real
number and these are extrapolation.

Two more Workers notes:

- **`crypto.getRandomValues` is forbidden at module scope**, and nothing in this SDK calls it at
  import time — not in a barrel, not in a constant, not in a memoised table. Importing any module of
  this package evaluates nothing.
- **An outbound WebSocket cannot be held across requests outside a Durable Object** (risk R12). In a
  plain Worker, submitting over the socket therefore means one socket per submission. Prefer HTTP
  submission unless the code runs inside a Durable Object. See
  [docs/ws.md](docs/ws.md#cloudflare-workers).

---

## Module map

**Import from the subpaths.** Each is an independent entry in the `exports` map and pulls in only its
own module graph.

| import | what it is | docs |
| --- | --- | --- |
| `lighter-ts/crypto` | Goldilocks field, `GF(p^5)`, Poseidon2, ECgFp5, Schnorr, `ApiKey` | [docs/crypto.md](docs/crypto.md) |
| `lighter-ts/tx` | the transaction types: builders, validators, hashing, signing, serialisation, and the four EIP-191 message templates | TSDoc; the L1 seam is above |
| `lighter-ts/rest` | 78 typed routes in 13 groups, the transport, and cursor pagination | [docs/rest.md](docs/rest.md) |
| `lighter-ts/ws` | the stream client, the channel factories, subscriptions, reconnection, and `sendtx` over the socket | [docs/ws.md](docs/ws.md) |
| `lighter-ts/client` | `LighterClient`, `LighterAccount`, market and asset registries, nonce leasing, order math, the decimal trading tier | [docs/client.md](docs/client.md) |
| `lighter-ts/config` | endpoint profiles, chain ids, `resolveConfig` | TSDoc |
| `lighter-ts/errors` | the error classes, the structural type guards, and the observed API codes | [docs/rest.md](docs/rest.md#errors) |

`import { … } from "lighter-ts"` — the root barrel — re-exports all of the above under one specifier.
It exists for scripts, examples and REPLs, and it is a **tree-shaking trap**: it names every module
in the package, so a bundler puts the whole graph into its reachability set before shaking. Measured
with `bun run size`, the root's transitive graph gzips to 342.8 KB as emitted (JSDoc included, which
is most of those bytes) against 57.2 KB for `./crypto` and 37.7 KB for `./rest`. Reach for the
subpath.

Per-symbol documentation lives in TSDoc, not here. Every exported symbol carries it, including the
reasoning behind the non-obvious ones.

---

## Conformance

`conformance/oracle/` is a small Go program that depends on the published reference modules
(`github.com/elliottech/lighter-go` v1.0.7 and `github.com/elliottech/poseidon_crypto` v0.0.15). It
feeds deterministic inputs through the reference and records the outputs as JSON. The TypeScript is
written from the specification, never from the Go source; the suite replays the vectors against it,
and a divergence anywhere fails the build.

| file | what it pins |
| --- | --- |
| `goldilocks.json` | the base field `p = 2^64 − 2^32 + 1`: add, sub, mul, square, exp, sqrt, little-endian encoding |
| `gfp5.json` | the quintic extension `GF(p^5)`: arithmetic, Frobenius, Legendre, sqrt, the 40-byte codec |
| `poseidon2.json` | the permutation and its constants, `hashToQuinticExtension`, `hashNoPad`, `hashNToMNoPad` |
| `curve.json` | ECgFp5 point add/double, scalar multiplication, encode/decode, scalar reduction |
| `schnorr.json` | key derivation, signing with a pinned nonce, verification, rejection and malleability cases |
| `tx.json` | end-to-end transaction hashes and signatures for every constructible type, plus the EIP-191 `l1Messages` and the read-only auth tokens |

Regenerate:

```sh
cd conformance/oracle && go run . -out ../vectors
```

Generation is seeded and reads no clock and no RNG, so re-running produces byte-identical files.
**A vector diff in a pull request is a protocol change, not a test fix.** A dirty `git status` after
regeneration means the reference moved — inspect the diff and explain it. Never hand-edit a vector,
and never adjust one to make a test pass.

CI never runs Go and never regenerates the vectors: they are checked in, and regenerating them inside
the job that verifies them would make the job verify nothing.

### What is verified against the live venue, and what is not

The REST behaviour documented in [docs/rest.md](docs/rest.md) was established by calling the live
API. The **WebSocket payload shapes are not verified against live traffic.** The handshake, the JSON
keepalive and the channel naming are; the per-channel body shapes are modelled from the reference
client and the published examples.

The reason is geographic. From a restricted jurisdiction the API answers reads normally and returns
HTTP 400 with code `20558` for both `/sendTx` and the `/stream` upgrade, so the capture that would
confirm those shapes could not be taken. Treat the channel payload types as best-effort, and open an
issue if a field disagrees with what you receive.

---

## Security

**Key handling.** An `ApiKey` is built from 40 bytes (or the equivalent hex) and validated on the way
in; there is no way to hold an instance whose key was never checked. `ApiKey.generate()` draws 64
bytes from the platform CSPRNG and reduces mod `n`, which leaves the result uniform in `[1, n)` to
within `2^-192` — a 40-byte draw would leave about a bit of bias. There is no fallback when no CSPRNG
is present: a key derived from anything weaker is a key an attacker can also derive.

**The signing nonce is hedged-deterministic**, derived with Poseidon2 from the private key and the
message hash, mixed with fresh randomness. Under pure randomness a weak or repeating RNG leaks the
private key outright after two signatures, silently. `'random'` and an explicit `k` remain available;
an explicit `k` reused across two messages recovers the private key, and there is a regression test
that performs exactly that recovery so the failure mode stays visible.

**What is never logged.** Diagnostics, error payloads and request/response hooks pass through a
redactor with two independent mechanisms:

- *by name*, case-insensitively — `api_token`, `apiToken`, `auth`, `authorization`, `signature`,
  `sig`, `private_key`, `privateKey`, `privateKeyHex`, `secret`, `token` — as object properties,
  headers, `Map` keys and query parameters;
- *by shape*, in any free text that survives the first pass: a Lighter auth token
  (`<deadline>:<accountIndex>:<apiKeyIndex>:<160 hex>`) and a private key (`0x` + exactly 80 hex).

Long hex runs are deliberately **not** blanket-redacted. Message hashes, public keys and signatures
appear in legitimate diagnostics, and redacting them makes bug reports useless.

Errors raised for a malformed key name lengths and reasons only, never key material.

**What this package does not claim.** No constant-time execution — see
[docs/crypto.md](docs/crypto.md#what-is-not-claimed) for exactly what is and is not guaranteed. No
key-memory wiping: a `bigint` cannot be zeroed. Treat a private key used in a shared runtime as
exposed to a local attacker.

**Reporting.** Report a vulnerability privately through this repository's GitHub Security Advisories
— "Report a vulnerability" on the Security tab. Please do not open a public issue for anything
affecting key material, signature validity or transaction integrity.

---

## Contributing

```sh
bun install
bun test                 # unit + conformance
bun run lint             # tsc under both nodenext and bundler resolution
bun run build            # emit dist/
bun run check:deps       # zero dependencies, no node: imports, no Node globals in src/
bun run size             # every exports target resolves; per-subpath gzip budgets
bun run test:all         # the above, then replay the vectors on Node, Deno and workerd
```

Ground rules, in the order they will bite you:

1. `docs/decisions.md` outranks every other document in this repository, including this one.
2. `docs/protocol-notes.md` records what was established by *running* the reference or the live API.
   Where it disagrees with anything except `decisions.md`, it wins.
3. Do not hand-edit `conformance/vectors/` or `test/fixtures/`.
4. `src/` may not import a `node:` built-in, touch a Node global, or add a runtime dependency. CI
   enforces all three.
5. No monetary value passes through `number`. Decimal strings or scaled `bigint`, end to end.

## License

MIT — see [LICENSE](LICENSE).

`lighter-ts` is an independent, unofficial implementation. It is not published, endorsed or reviewed
by Lighter or Elliot Technologies.
