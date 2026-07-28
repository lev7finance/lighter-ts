# Ratified decisions

The architecture was reviewed by three independent agents (grok, codex, kimi), each reading the
reference source directly, plus an eight-agent internal verification fleet. They found real
contradictions — several of them between documents that were each individually correct.

This file resolves them. **Where any other document disagrees with this one, this one wins**, and
the other document is wrong and should be fixed. Issue authors: read this before
`docs/ARCHITECTURE.md`.

Raw reviews are preserved in `docs/reviews/` rather than summarized away, because the reasoning
matters more than the verdicts.

---

## D1 — The neutral public key is rejected unconditionally

**Unanimous across all three reviewers, and the only critical they all independently raised.**

`verify()` takes no `allowNeutralPublicKey` option. It does not exist, and it is not covered by any
general `strict` flag.

With the neutral public key anyone forges a signature: pick `s`, compute `R = [s]G`, set
`e = H(encode(R) ‖ m)`. `Decode(0)` succeeds in the reference and its verification does not reject
the result, so this is a live universal forgery, not a theoretical one. An option to permit it turns
a known forgery into a supported configuration.

No legitimate account holds the neutral key, so nothing is lost.

If bug-for-bug reference behaviour is ever needed for diagnostics, it lives in a non-exported
function named `verifyReferenceInsecure`. `spec/03-crypto-curve-schnorr.md:792` says otherwise and
is superseded.

## D2 — The signing nonce is hedged-deterministic, derived with Poseidon2

Three documents said three different things: `verified-facts.md` said random by default,
`protocol-notes.md` said hedged via Poseidon2, and the architecture said hedged via a hand-rolled
HMAC-SHA-256. Ratifying one:

**`k` is derived from the private key and message hash, mixed with fresh randomness, using
Poseidon2.** `'random'` remains available as an explicit option; an explicit `k` remains available
for vectors.

- *Hedged over random*: the nonce never appears on the wire, so both are wire-compatible and a
  verifier cannot tell them apart. Under pure randomness a weak or repeating RNG leaks the private
  key after two signatures, silently.
- *Poseidon2 over SHA-256*: the architecture argued for HMAC-SHA-256 so that nonce and challenge
  do not share a primitive. That is a real argument, and it loses to a bigger one — a hand-written
  synchronous SHA-256 is ~150 lines of unvalidated cryptography on the signing path, and WebCrypto
  cannot substitute because `crypto.subtle.digest` is async while signing is synchronous. Poseidon2
  is already implemented and already pinned by vectors.

`crypto.getRandomValues` is never called at module scope — Cloudflare Workers forbids it there.

**A broken nonce derivation passes every signature conformance test.** Verification only
reconstructs `R` and the challenge; it cannot see where `k` came from. A constant, biased,
endian-swapped, or message-independent nonce verifies perfectly and leaks the key on the second
signature. So the nonce unit ships with its own gate, and nothing on the signing path merges
without it:

- fixed `(sk, msg, entropy) → k` vectors, including all-zero entropy
- same-key/different-message, and different-key/same-message
- `k ∈ [1, n)`
- an explicit nonce-reuse test that recovers the private key, so the failure mode stays visible

Feeding a signature to the Go verifier proves wire compatibility only. It is not a nonce test.

## D3 — Parsers on the signing path reduce; strict parsing is opt-in, and the names are inverted

The reference **accepts** non-canonical input: `SigFromBytes` reduces both halves, and the `GF(p^5)`
loader checks length only. Verified — signatures with `s+n`, `e+n`, or both re-encoded into the raw
bytes all still validate (`conformance/vectors/schnorr.json`, `malleable`).

So strict parsing rejects signatures the sequencer accepts. That is an interop bug, not extra
safety.

| Path | Behaviour |
| --- | --- |
| `sign`, `verify`, key import | exact length check, then **reduce** |
| explicit user-facing decode API | strict, rejects non-canonical |
| all encoders | always canonical |
| internal arithmetic | always canonical |

**Names are inverted from the architecture's proposal**: `fp5FromBytes` *reduces* (reference
semantics, the interoperable default) and `fp5FromBytesStrict` rejects. The architecture named the
reducing variant `…Unchecked`, which makes the correct choice look like the unsafe one and
guarantees someone wires `verify` to the wrong parser.

The `malleable` vectors are part of the wave-1 signer gate.

## D4 — Target is paid-tier Workers; free-tier signing is explicitly unsupported

Measured, across three runtimes, 2M iterations after warmup
(`bench/field.bench.ts`, `bench/README.md`):

| Runtime | best ns/mul | ~ms per signature |
| --- | --- | --- |
| Bun 1.3.0 | 34.6 | ~2.9 |
| Node 24.10 | 28.0 | ~2.4 |
| Deno 2.9.0 | 19.0 | ~1.6 |

That is 15–25× better than the ~500 ns/mul threshold the risk register feared, so **R4 is not
design-invalidating**. No WASM fallback is needed.

Related, and it changes the code: **plain `(a * b) % P` beat hand-folded Goldilocks reduction by
2.5–4× on every engine.** The Go intuition inverts under BigInt, where each folding intermediate is
a heap allocation. Use `%` everywhere, including inside Poseidon2. This supersedes ADR-2.

Remaining honest gaps, which is why this stays a gate rather than a closed risk:

- These numbers are desktop Apple Silicon, not a Workers isolate.
- Extrapolating a signature from a hot multiplication loop ignores point additions, allocation
  pressure, Poseidon2, and nonce derivation.

**The gate is therefore a full `sign()` and `verify()` on a *deployed* Worker, recording
`cloudflare.cpu_time_ms` at p50/p99 — not `wrangler dev`, and not extrapolation.** It moves to
wave 0 and blocks wave 2.

The consuming monorepo deploys through `@opennextjs/cloudflare`, i.e. the paid tier, where the CPU
limit is 30 s (configurable to 5 min). The free tier's ~10 ms budget would require ≤117 ns/mul
sustained for signing alone and is not a supported target. Say so in the README rather than leaving
it implied.

**Pre-authorized fallback, decided now so no issue has to be rewritten later:** signing's scalar
multiplication is fixed-base (`[k]G`), so a precomputed comb table on `G` — pure data, generated at
build time, cached per isolate — cuts it roughly 4–8×. If the gate fails, that lands behind the
existing vectors. It is no longer a v1 non-goal. `verify()` is variable-base and stays slower; on a
Worker nothing should be verifying, since the sequencer does that.

## D5 — `User-Agent` is runtime-conditional

Two measured documents contradicted each other, and both were right about their own environment:

- Server runtimes: a request without a browser-like `User-Agent` gets a 403 HTML interstitial from
  the CDN on some paths.
- Browsers: `User-Agent` is a forbidden header name — the fetch spec silently drops it — and adding
  custom headers can push a simple request into a CORS preflight that then fails.

Resolution: **never attempt to set `User-Agent` in a browser environment; set a configurable
browser-like one everywhere else.** Detect the environment rather than the runtime name.

The evidence gap is real and gets its own wave-0 probe: my measurement was `curl`-based, which says
nothing about what workerd's *default* UA does against the CDN. Hit `/orderBooks` from workerd with
no UA override and record the result before the transport is written. If workerd's default is
rejected from some IP ranges, the SDK fails in exactly the runtime it was built for.

## D6 — L1 signing is injected. Four flows, not three. No secp256k1 in this package.

Four flows need an Ethereum `personal_sign`: `change_pub_key`, `transfer`, `approve_integrator`,
and **`create_sub_account`** — the architecture's prose said three and would have led to the fourth
being omitted, though its own template table lists all four.

The SDK builds the exact message string, which is the part that is easy to get wrong and is pinned
in `conformance/vectors/tx.json` under `l1Messages`. The signature comes from an injected
`L1Signer`.

**Cut from v1**: `src/l1`, keccak256, secp256k1, public-key recovery, EIP-55, and the RFC-6979
machinery. The consuming monorepo already has `viem ^2.55.4` and holds L1 keys in a wallet/custody
layer; this package never has an L1 private key to sign with.

Ship a small documented viem adapter. viem's `signMessage` takes an options object, so the seam is
not satisfied verbatim by it — write the adapter rather than claiming it is.

## D7 — No `number` for anything monetary

`mapCandle` returned `open`/`high`/`low`/`close`/`baseVolume`/`quoteVolume` as `number`, which
reintroduces exactly the precision bug ADR-15 exists to prevent. `setLeverage` likewise took a
fractional `number`.

Monetary and size values are decimal strings or explicitly scaled `bigint` with scale metadata,
end to end. `number` is permitted only for timestamps and counts, and only where the safe-integer
range is provably sufficient.

Rounding direction is stated per call site: a buy's maximum acceptable price rounds **down**, while
a sell's minimum acceptable price rounds **up**, so rounding never loosens slippage protection.
Python's `round()` is banker's rounding and `Math.round` is half-up — neither is a valid translation
of the other, and the reference's four float hazards (`docs/protocol-notes.md` §9) become regression
tests.

## D8 — One owner per file, enforced mechanically

The plan claimed units within a wave own disjoint files. They do not: `package.json`, CI config,
`models/index.ts`, `ws/index.ts`, `client/index.ts`, `paper/index.ts` and the root barrel are each
needed by several units. Parallel agents would collide on every one of them.

- Every unit declares `ownedFiles`. **A path has exactly one owner.** Issue generation fails if any
  path is claimed twice — checked, not asserted.
- Barrels, `package.json`, and CI belong to a single final integration unit. Leaf units never touch
  them; they export from their own module files only.
- "L5 is the only mutable layer" is false — WS transport, subscriptions, order books, pools, and the
  paper engine all hold mutable state. Each unit states what state it owns and for how long.

## D9 — Wave 0 exists, because several dependency edges point the wrong way

The plan had `ws-live-capture` depending on the finished WS client, REST fixtures depending on the
REST client, and the performance gate in wave 5. Each of those is evidence that should *precede*
the design it informs.

Wave 0 produces artifacts, not abstractions:

1. **WS live capture** — a raw socket script, no SDK, recording real frames: channel shapes, ack
   correlation, account update semantics, keepalive timing, truncation behaviour.
2. **REST golden fixtures** — committed real responses, including `/withdrawalDelay` (no `code`
   field) and an authenticated endpoint's error.
3. **Full-signature Worker benchmark** — D4's gate.
4. **OpenAPI snapshot vendored** — `spec/openapi.snapshot.json` does not exist in this repo yet;
   something must copy and pin it from the Python SDK.
5. **`User-Agent` probe from workerd** — D5.

Implementation units depend on these artifacts, not on each other's abstractions.

## D10 — Cuts from v1

Scope reduction is a finding, not a failure. All three reviewers independently proposed most of
this list.

| Cut | Why |
| --- | --- |
| Built-in L1 signer (keccak, secp256k1, recovery, EIP-55) | D6 — hand-rolled crypto for a signature we cannot produce anyway |
| Paper trading engine | No conformance vectors exist for it, so no unit can be verified independently. Defer until they do. |
| Generated all-optional long-tail REST models | Keep the core trading models hand-authored and expose raw typed route access for the tail |
| `LighterWsPool`, and the dual callback + async-iterator API | Prove one socket and one subscription model first |
| One-for-one parity with ~63 Python examples | Keep a small acceptance set: read, sign, submit, stream, L1 injection |

Cutting these removes the two units with no independent verification path and the largest block of
unvalidated cryptography.

---

## Corrections to earlier documents

Recorded rather than silently patched, since they were stated confidently and someone may have read
them already.

- **`verified-facts.md`** said `crypto.getRandomValues` by default — superseded by D2.
- **`verified-facts.md`** said the SDK must always send a `User-Agent` — too broad, superseded by D5.
  The measurement was `curl`-based and does not describe browsers or workerd defaults.
- **`ARCHITECTURE.md` ADR-2** preferred a compare-and-subtract reduction chain — measured backwards,
  superseded by D4.
- **`ARCHITECTURE.md`** cited 35 transaction vector rows, `verified-facts.md` cited 9; the oracle now
  emits **38** covering all 20 constructible types. Counts belong in CI output, not prose — generate
  them from the JSON rather than copying numbers into documents.
- **One review claimed** the curve generator encodes canonically and that my note was wrong.
  Re-measured: `GENERATOR_WEIERSTRASS.Encode()` and `SchnorrPkFromSk(1)` both return limbs above the
  modulus. The note stands. Reviews are evidence, not verdicts.
