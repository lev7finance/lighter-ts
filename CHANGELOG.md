# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version below must match `package.json` and the literal in `src/version.ts`. The publish workflow
asserts that the release tag agrees with both before anything reaches the registry.

## [Unreleased]

Nothing yet.

## [0.1.0]

First release. A clean-room TypeScript reimplementation of the Lighter SDK, written from the
specification and verified byte-for-byte against vectors generated from the Go reference.

### Added

- **Crypto** (`lighter-ts/crypto`) — the Goldilocks base field `p = 2^64 − 2^32 + 1`, the quintic
  extension `GF(p^5)`, Poseidon2, the ECgFp5 group, and Schnorr sign/verify with `ApiKey`. Signing is
  synchronous on every runtime.
- **Transactions** (`lighter-ts/tx`) — builders, validators, field encoding, hashing, signing and
  serialisation for every constructible transaction type, plus grouped-order (OTO / OCO / OTOCO)
  folding and the four EIP-191 message templates.
- **REST** (`lighter-ts/rest`) — 78 typed operations in 13 groups, a transport that classifies every
  response, jittered retry with `Retry-After` support, and cursor pagination.
- **WebSocket** (`lighter-ts/ws`) — the stream client, 22 channel factories, subscriptions as async
  iterables or callbacks, JSON ping/pong keepalive, reconnection with backoff and automatic
  resubscribe, per-subscription overflow policies, and transaction submission over the socket.
- **Client** (`lighter-ts/client`) — `LighterClient`, `LighterAccount`, market and asset registries,
  three nonce-leasing strategies, exact order math, and a decimal trading tier reporting the precise
  protocol integers it derived on every call.
- **Config** (`lighter-ts/config`) — four endpoint profiles, each binding REST origin, stream URL and
  chain id together.
- **Errors** (`lighter-ts/errors`) — typed error classes, structural type guards
  (`isLighterError`, `isLighterApiError`, `hasCode`, `isRetryable`), and the API codes observed in the
  wild.

### Decisions worth knowing before you upgrade anything

- **The neutral public key is rejected unconditionally.** `verify()` takes no options; there is no
  `allowNeutralPublicKey` and there never will be. `Decode(0)` succeeds in the reference, which makes
  that key a universal forgery.
- **The signing nonce is hedged-deterministic**, derived with Poseidon2 from the private key and the
  message hash, mixed with fresh randomness. `'random'` and an explicit `k` remain available.
- **Parsers on the sign/verify path reduce rather than reject.** The reference accepts non-canonical
  input, so a strict parser would reject signatures the sequencer accepts. `fp5FromBytesStrict` and
  `scalarFromBytesStrict` are the opt-in strict variants.
- **L1 signing is injected.** The SDK builds the exact EIP-191 message for `change_pub_key`,
  `transfer`, `approve_integrator` and `create_sub_account`, and takes the signature from an
  `EthPersonalSigner`. It ships no secp256k1 and no keccak256.
- **No `number` for anything monetary.** Decimal strings or scaled `bigint`, end to end.
- **Chain id is configuration**, never inferred from a URL. A custom endpoint without an explicit
  `chainId` throws at construction.
- **Paid-tier Cloudflare Workers is the supported deployment target.** Free-tier signing is not
  supported.

### Not in this release

- `LighterWsPool` and a dual callback + async-iterator API — one socket and one subscription model
  first.
- A built-in L1 signer (keccak256, secp256k1, public-key recovery, EIP-55).
- A paper-trading engine. No conformance vectors exist for one, so no implementation could be
  verified independently.
- Generated all-optional long-tail REST models. The core trading models are hand-authored and the
  tail is reachable through raw typed route access.

### Known limitations

- **WebSocket payload shapes are not verified against live traffic.** The handshake, the keepalive
  and the channel naming are; the per-channel body types are modelled from the reference client and
  the published examples. The capture that would confirm them was refused at the upgrade with API
  code `20558` (restricted jurisdiction).
- **No `cloudflare.cpu_time_ms` measurement from a deployed Worker yet.** The performance figures in
  the README are desktop measurements and an extrapolation from them.
- **No numeric API code is known for "invalid nonce"**, so that condition currently classifies as an
  ordinary rejection rather than triggering a hard resync. See
  [docs/client.md](docs/client.md#the-rule-the-reference-gets-wrong).
- **The order-book maintainer in `src/ws/orderbook.ts` is not exported** from the `./ws` barrel.
- Node 20 has no global `WebSocket`; the WS layer needs one injected there.

[Unreleased]: https://github.com/lev7finance/lighter-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lev7finance/lighter-ts/releases/tag/v0.1.0
