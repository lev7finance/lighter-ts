• I'll start by reading the core documents, then cross-check against the reference implementations.

• Reading the rest of the architecture document now.

• I have the full picture of the architecture document. Now let me verify specific claims against the actual vector files and specs.

• A few final cross-checks on transport details and the browser/workerd lanes.

• I have everything I need. Cross-checks done: vector files in `conformance/vectors/`, `spec/03` and `spec/05`, and the two measured docs. Here is the review.

  ---

  # Architecture review — lighter-ts

  ## Findings, prioritized

  ### 1. `verify()` exposes `allowNeutralPublicKey` — a universal forgery as a supported configuration

  - **SEVERITY:** critical
  - **WHERE:** §6.4 (`crypto`), ADR-13 "fix behind a `strict` flag" list
  - **CLAIM:** `verify(publicKey, hashedMessage, signature, opts?: { allowNeutralPublicKey?: boolean })`, and ADR-13 lists "`verify()` rejecting a neutral public key" among the *individually bypassable* tightenings.
  - **PROBLEM:** `docs/protocol-notes.md` §5.2.2 — verified by execution — says: "Reject the neutral public key in `verify`, with **no** opt-out flag. An `allowNeutralPublicKey` option turns a known universal forgery into a supported configuration." The notes document the forgery explicitly: `Decode(0)` succeeds, and with the neutral key anyone forges by picking `s`, computing `R = [s]G`, `e = H(encode(R) ‖ m)`. Per your own rule, protocol-notes outranks the architecture. (Note: `spec/03-crypto-curve-schnorr.md:792` agrees with the architecture, so this is a live three-way contradiction — a wave-1 issue cut from spec/03 will implement the flag, and a reviewer holding protocol-notes will reject it, or worse, nobody will reject it.)
  - **FIX:** Remove `allowNeutralPublicKey` from the `verify` signature and remove the neutral-pubkey row from ADR-13's bypassable list. If bug-for-bug diagnostics are needed, a test-only function named `verifyReferenceInsecure` — as the notes prescribe. Amend spec/03:792 to match.

  ### 2. ADR-10 hand-rolls SHA-256/HMAC for the nonce PRF, contradicting the pinned protocol decision

  - **SEVERITY:** critical
  - **WHERE:** ADR-10; source tree `crypto/sha256.ts`; DAG node `sha[crypto-sha256-hmac]` with edge `sha → sig`
  - **CLAIM:** "HMAC-SHA-256 rather than Poseidon2 is deliberate: deriving the nonce with the same algebraic primitive that produces the challenge would couple two failure modes … hence ~150 lines of synchronous SHA-256."
  - **PROBLEM:** `protocol-notes.md` §5.1 says the opposite, as a recorded decision: "**Use Poseidon2** — already implemented, already vector-pinned, and synchronous. Do not hand-roll SHA-256 and HMAC for this … a hand-written SHA-256 adds a second unvalidated primitive whose failure is invisible." The notes' invisibility argument is exactly right for this plan: §8 of the architecture contains *no* SHA-256 known-answer tests and *no* nonce-derivation tests (see finding 7), so the "unvalidated primitive" hazard is currently real, not hypothetical. Additionally, ADR-10's own "Rejected" note only flags the conflict with `conformance/README.md`, but the default-mode conflict is with `00-verified-facts.md` itself: "caller-supplied nonce for tests, `crypto.getRandomValues` by default." The two designated sources of truth disagree with each other (facts says random default, notes say hedged default), and the architecture silently sides with notes on the mode while contradicting notes on the PRF. Whichever way this resolves, at least one wave-1 issue (`crypto-sha256-hmac` or `crypto-schnorr-key`) is currently specified wrong, and `sha` sits on the signing dependency chain (`sha → sig → txp`).
  - **FIX:** Reconcile the three documents *before* cutting wave-1 issues, in one place. If hedged+HMAC-SHA-256 stands, amend protocol-notes §5.1 and 00-verified-facts' "by default" sentence, and add NIST SHA-256/HMAC KATs plus the §5.1 nonce test battery to §8. If Poseidon2 stands, delete the `sha` unit, the `sha → sig` edge, and ~150 LOC of crypto surface.

  ### 3. User-Agent: the two measured documents demand opposite behaviour; the architecture says nothing

  - **SEVERITY:** critical (production 403s in the primary deployment target)
  - **WHERE:** absent from ARCHITECTURE.md entirely (grep confirms zero occurrences); transport responsibility per §5 `rest/transport.ts`
  - **CLAIM (verified-facts):** "A request without a browser-like `User-Agent` gets a 403 HTML interstitial on some paths. **The SDK must send an explicit `User-Agent`**."
  - **CLAIM (spec/05 §1.1, also marked verified):** "No custom headers beyond `Authorization` and `Content-Type` may be sent, or the preflight will fail — in particular **do not add a `User-Agent`** … browsers forbid setting `User-Agent` anyway."
  - **PROBLEM:** Both were measured; they contradict. The likely resolution is runtime-conditional: in a browser you *cannot* set UA (forbidden header name, silently dropped) and the browser's own UA satisfies the CDN; in Workers/Node/Bun/Deno there is no CORS preflight and the default UA (`undici`, `Bun/1.3`, workerd's) may or may not pass CloudFront's reputation check — the verified-facts probe was curl-based, which proves nothing about workerd's default. The `rest-transport` issue will be written from spec/05 and ship no UA handling; if workerd's default UA 403s from some IP ranges, the SDK fails in exactly the runtime it was built for.
  - **FIX:** Add a transport decision now: never attempt to set UA when `typeof window !== "undefined"` (or detect forbidden-header environments), otherwise inject a configurable browser-like UA with an opt-out. Add a wave-3 probe task: hit `/orderBooks` from `wrangler dev` with the default UA and record the result. One line in ADR-6/§6.6.

  ### 4. Strict-vs-reducing parser wiring is ambiguous on the verify path — rejects signatures the sequencer accepts

  - **SEVERITY:** major
  - **WHERE:** ADR-13 (two rows that contradict each other), §6.4 naming
  - **CLAIM:** ADR-13 "Fix unconditionally (no wire impact): strict-by-default byte decoders with explicit `Unchecked` variants" — and three rows later, "Preserve … Scalar and public-key byte parsing **reduce** rather than reject." §6.4 names the strict decoder `fpFromBytes` and the reducing one `fpFromBytesUnchecked`.
  - **PROBLEM:** `protocol-notes.md` §5.2.1 prescribes the split explicitly: parsers on the `sign`/`verify` path check length then **reduce**; strict is opt-in. The vectors prove the stakes (`schnorr.json → malleable`: `s+n`, `e+n` re-encodings all validate). The architecture never states *which* parser `verify`, `ApiKey.fromPrivateKey`, and `publicKeyFromPrivateKey` use, and its naming makes strict the attractive default — an implementer wiring `verify` through `fp5FromBytes` produces a library that rejects real, sequencer-accepted signatures while passing every non-malleability vector. ADR-13 as written instructs two different agents to do two different things.
  - **FIX:** State in ADR-13 and §6.4: sign/verify/key-import use the reducing decoders; strict decoders are only for explicit user-facing decode APIs. Better: invert the names — `fp5FromBytes` reduces (reference semantics), `fp5FromBytesStrict` rejects — so the natural name is the interoperable one. Wire `schnorr.json → malleable` into the wave-1 signer gate (§8.1's schnorr row omits the `malleable` section, which exists in the file with 3 cases — also a doc gap).

  ### 5. R4: the CPU budget is unanchored, the gate is unowned, and the fallback is currently a non-goal

  - **SEVERITY:** major
  - **WHERE:** §10 R4, ADR-1 benchmark gate, §2 non-goals ("`mDouble` / fixed-base comb optimisations in v1"), §9 (no bench unit)
  - **CLAIM:** "If BigInt mul+reduce lands above ~500 ns in a Workers isolate, signing exceeds the CPU budget." And the gate is "60k-`fpMul`-under-50 ms", "benchmarked in wave 1 (`bench/field.bench.ts`)".
  - **PROBLEM:** Four defects. (a) The budget is never stated. Workers CPU-time limits are ~10 ms on the free tier and 30 s (configurable to 5 min via `cpu_ms`) on paid. 85k muls × 500 ns ≈ 42 ms: trivially fine on paid (the monorepo deploys via `@opennextjs/cloudflare`, i.e. paid), *impossible at any plausible BigInt speed* on free (it would need ≤117 ns/mul sustained). So "exceeds the CPU budget" is only meaningful if the product is promising free-tier signing — which the document neither promises nor disclaims. (b) The gate (833 ns/mul) maps to no budget; a proxy passing the gate still fails free-tier by 4×. (c) No unit owns the benchmark: §9's DAG and wave table contain no bench unit; the only perf-bearing unit is wave-5 `docs-and-perf` — directly contradicting R4's "wave 1 … falsifies ADR-1 early". (d) The fallback is undeclared *and pre-forbidden*: signing's scalar mul is fixed-base (`[k]G`), so a precomputed comb table on `G` (pure data, generatable at build time, cacheable per isolate) cuts the work ~4–8× — but §2 defers fixed-base combs as a v1 non-goal. If R4 bites, that non-goal is wrong and every issue written against it needs rework. `verify()` is variable-base and would stay slow regardless — worth stating who verifies on a Worker (nobody should; the sequencer verifies).
  - **FIX:** (1) State the budget: "paid-tier Workers, `cpu_ms` default; free-tier signing is not supported" (or prove 10 ms is achievable — it is not). (2) Replace the 50 ms proxy gate with "one `sign()` < X ms wall in `wrangler dev`", X chosen against the stated budget. (3) Create a wave-1 `bench` unit gating wave-2. (4) Amend the non-goal: fixed-base comb on `G` is the pre-authorized R4 fallback, landing behind the existing vectors if the gate fails — decided now, not during a wave.

  ### 6. The decomposition has wrong counts, missing edges, unowned files, and a barrel collision point

  - **SEVERITY:** major
  - **WHERE:** §9 wave table + DAG
  - **CLAIM:** Wave counts "18 / 11 / 15 / 11 / 5"; "units within a wave own **disjoint files**".
  - **PROBLEM:**
    - **Counts don't match the DAG.** Wave 1 shows 15 nodes (needs 18 — bench? CI? unnamed); wave 3 shows 17 (6 REST + 11 WS, table says 15); wave 4 shows 12 if `cf` is included (table says 11), and `cf[client-trading-facade]` — the *end of the stated critical path* — appears in no wave's count. The totals coincidentally sum to 60 both ways, which means units were silently reshuffled and the table was not updated.
    - **Missing oracle edges.** §8.1's "gaps to close in the oracle" are prerequisites for wave-1 units: the goldilocks edge list (`fp`), `decodeFailures`/`pointOps`/`mulAdd`/`window`/`recode` (`pt`, `sm`), schnorr negatives (`sig`), `numOutputs = 12` multi-squeeze (`p2p`/`p2s`). The DAG has only `oracle → p2c` and `oracle → port`. As drawn, four wave-1 units can reach "code complete" with their required negative tests impossible — a mid-wave stall.
    - **Barrel ownership.** `crypto/index.ts` is touched by seven wave-1 units (fp, fp5, p2c/p2p/p2s, sc, pt/sm, sha, sig) if each exports its own surface — guaranteed parallel-merge collisions — or is owned by wave-5 `api`, in which case no subpath is importable or size-testable until the final wave. Same problem, smaller, for `tx/index.ts`, `ws/index.ts`, `models/index.ts` (both `rmc` and `rml` feed it — a genuine two-unit-one-file overlap), and `client/index.ts`.
    - **Unowned files:** `ws/account-assets-stream.ts` (in the tree, in no unit), `client/system-config.ts`, `client/submit.ts`, `version.ts`, `bench/`, `size-budget.json` maintenance.
    - **`ex` is too large for one session.** ~63 Python examples mirrored one-for-one is the largest unit in the plan by an order of magnitude, and the write-path examples aren't CI-verifiable (need credentials). `docs-and-perf` merges two unrelated concerns and puts perf in wave 5 (see R4).
  - **FIX:** Publish a unit manifest: per unit, exact file list, exact vector sections consumed, exact acceptance command. Land the oracle extension as the *first* blocking unit. Assign each layer's `index.ts` to the last unit in that layer's chain (or generate barrels in CI and check reachability). Split `ex` into 4–5 domain units; move perf out of `docs`.

  ### 7. The nonce derivation — the one thing that passes every conformance test while leaking keys — has no test plan

  - **SEVERITY:** major
  - **WHERE:** §8 (all tiers), ADR-10, R1
  - **CLAIM:** R1 mitigation is "ADR-10 hedged default … the nonce unit is reviewed as security-critical code, not plumbing." §8.2 tier 5 reverse-validates TS signatures through Go's `schnorr.Validate`.
  - **PROBLEM:** `protocol-notes.md` §5.1 states the required battery verbatim: "fixed `(sk, msg, entropy) → k` vectors including all-zero entropy, same-key/different-message and different-key/same-message cases, an assertion that `k ∈ [1, n)`, and an explicit nonce-reuse regression demonstrating key recovery." None of that exists in §8. Tier 5 proves wire-compatibility, which is precisely the property that *cannot* detect a broken derivation — a constant or message-independent `k` verifies fine and leaks the key on the second signature. The hedged construction is novel (the Go reference does plain random), so there is no external oracle; the construction must be frozen with self-pinned vectors. "Reviewed as security-critical" is not a test.
  - **FIX:** Add to §8.1/§8.2: KATs for the exact derivation (`skBytes ‖ msgBytes ‖ entropy ‖ domain-separator → k`, including all-zero entropy and entropy-independence), `k ∈ [1, n)` over 10⁴ draws, determinism for fixed inputs, distinctness across messages/keys, and a reuse-demonstrates-recovery regression. Also add SHA-256/HMAC NIST KATs if ADR-10 stands (finding 2).

  ### 8. ADR-9's built-in `./l1` signer overturns a measured directive with a non-qualifying reason

  - **SEVERITY:** major (also the top cut candidate)
  - **WHERE:** ADR-9; source tree `src/l1/*`; unit `l1s`
  - **CLAIM:** "A pure-TypeScript `keccak256` + secp256k1 + RFC-6979 implementation ships behind the `./l1` subpath." Rejected (c): "Omitting the built-in entirely — it is needed for `system-setup`-style bootstrap scripts and for the monorepo's Python-script migration."
  - **PROBLEM:** `00-verified-facts.md` records this as decided: "Implementing that in-house means shipping keccak256 **and** secp256k1 in pure TypeScript — a large amount of hand-rolled cryptography, on the zero-dependency budget … **Any proposal to hand-roll secp256k1 should be rejected unless it comes with a specific reason the injected-signer seam fails.**" ADR-9's reason does not show the seam failing: bootstrap scripts run in the monorepo, which already depends on `viem ^2.55.4` and can satisfy `EthPersonalSigner` in three lines. This is a preference (self-containedness) dressed as a decision, and it buys a whole unit of hand-rolled crypto, a `@noble/secp256k1` dev-dependency for cross-checking, RFC-6979 surface, and an honest-security-posture documentation burden — for a flow ~zero users of this SDK will exercise without a wallet. It also creates an ongoing maintenance trap: secp256k1 bugs are silent and catastrophic.
  - **FIX:** Cut `./l1` (delete `l1s`, `l1/`, the devDep, ADR-9's built-in half) or write into verified-facts the specific bootstrap scenario that viem cannot serve, and have that scenario drive a much smaller deliverable. Also fix ADR-9's rationale error: "Only three of twenty transaction types need an L1 signature" — both measured docs say **four** flows (`change_pub_key`, `transfer`, `approve_integrator`, `create_sub_account`); `create_sub_account` is missing from the rationale (§6.5's templates correctly include it).

  ### 9. `ApiKey` leaks its private key to any `JSON.stringify` or structured log

  - **SEVERITY:** major
  - **WHERE:** §6.4 `ApiKey`, D10
  - **CLAIM:** `readonly privateKeyBytes: Uint8Array; readonly privateKeyHex: string;` as public instance properties; D10 tests only that "no error message or serialised error contains … key material."
  - **PROBLEM:** Enumerable public properties mean `JSON.stringify(apiKey)`, `console.log(apiKey)`, `structuredClone` into a postMessage, or a catch-all logger serializing a config object emits the private key. D10's redaction test covers errors, not the key container itself. Non-goal "key memory wiping" is honest; leaking by default serialization is a separate, avoidable failure.
  - **FIX:** Store key material in non-enumerable properties (or a `#private` field) with explicit accessor methods (`getPrivateKeyBytes()`), and define `toJSON()` returning `{ publicKeyHex }` only. Extend the D10 test: `JSON.stringify(new ApiKey(…))` must not contain the key.

  ### 10. REST write retry policy is undefined — auto-retrying `sendTx` is a double-submission hazard

  - **SEVERITY:** major
  - **WHERE:** §6.3 `retry?: { attempts, baseMs, capMs }` (global, no method scoping); §10 R-register (absent); ADR-14
  - **CLAIM:** `transport.ts: request(): URL, auth, encoding, timeout, retry, classify`. Nothing anywhere states which operations retry.
  - **PROBLEM:** ADR-14 correctly rules that a network timeout does not roll back the nonce *because a timed-out tx may still land*. A transport-level automatic retry of `POST /sendTx` after timeout submits the same signed payload twice — the exact "may still land" scenario, now deliberately duplicated. Whether the sequencer dedupes identical signed `tx_info` is unknown (not even an open question in §11). A wave-3 agent given "timeout, retry" will implement uniform retry-on-timeout for all routes.
  - **FIX:** One sentence, load-bearing: automatic retry applies to idempotent GETs and classified-5xx only; POST submissions never auto-retry (the caller may resubmit explicitly, informed by ADR-14's no-rollback rule). Add it to §6.6 and the open-questions list (sequencer dedup behaviour).

  ### 11. Route count: "exactly 78" rests on a number the measured docs dispute

  - **SEVERITY:** minor
  - **WHERE:** §1.1(c), §6.6 ("exactly 78 entries"), ADR-6
  - **CLAIM:** "REST parity — 78 operations across 13 groups."
  - **PROBLEM:** `00-verified-facts.md`: "**76** distinct endpoint paths exist in the Python client." `spec/05`: "78 paths … 78 operations … exact match." These are reconcilable (paths vs operations; two ops may share paths, or two Robinhood/managed-token ops lack Python counterparts) but nobody has reconciled them, and §6.6 turns the disputed number into a hard CI gate. If the truth is 76, the gate fails on a correct implementation, or two phantom routes get invented to satisfy it.
  - **FIX:** Do the diff now (spec/05's table vs the Python client's path list — mechanical, one hour), record which two operations explain the gap, and gate on the route *table's* internal consistency rather than a magic number.

  ### 12. Hard-coded vector counts are stale in both documents — and §1.1 defines parity by them

  - **SEVERITY:** minor
  - **WHERE:** §1.1(a) "all 35 `tx.json` `txHashes` rows"; §8.1 "35 end-to-end transaction vectors"; `00-verified-facts.md` "9 end-to-end transaction hashes"
  - **PROBLEM:** The committed `tx.json` has **38** `txHashes` rows (covering all 20 constructible types — good). The architecture says 35, verified-facts says 9. All other counts I checked match (goldilocks 118/14, gfp5 46, poseidon2 23/45/17/16, schnorr 16+3, curve 20+11, `POWER_OF_TWO_GENERATOR` 7277203076849721926, sgn0-even polarity — all verified against the files). The tx counts rotted fastest precisely because that file is the one still growing.
  - **FIX:** Define parity as "every row in the committed file", never a count. Refresh both documents' numbers once, without making them load-bearing.

  ### 13. D4 claims browsers; no browser harness exists

  - **SEVERITY:** minor
  - **WHERE:** D4 ("all six"), ADR-11
  - **CLAIM:** "`run-vectors.ts` — one framework-free artifact executed against the built `dist/` under all six."
  - **PROBLEM:** ADR-11 enumerates the runner for Bun, Node, Deno, and workerd ("wrapped in a `fetch` handler") — no browser mechanism, and the four devDependencies include no headless browser or driver. "Runs in browsers" is currently proven only by the grep gates and workerd similarity.
  - **FIX:** Either drop browsers from D4's claim to "browser-compatible by construction (no Node APIs, WHATWG WebSocket/fetch only)" or add the cheapest real lane: a static HTML page + one headless run (Playwright chromium-only as a devDep) replaying the same artifact.

  ### 14. Smaller items

  - **SEVERITY:** minor
  - **`txHashHex` returns 80 hex *no 0x* (§6.5) but `TxReceipt.txHash` is ``0x${string}`` (§6.8).** Undocumented convention flip across layers; exactly the kind of thing parallel agents "fix" in opposite directions. Pick one per layer and say why.
  - **`CHAIN_ID` const (§6.5) omits robinhood 466324** while §6.3 `profiles` includes two Robinhood profiles — two chain-id sources, already drifted. Single-source it from `config/endpoints.ts`.
  - **`mapCandle` returns `number` (§6.6)** for OHLCV — money through `Number`, contradicting the verified "never parse money through Number" rule. If display-tier floats are intentional, carve the exception out explicitly in ADR-15.
  - **Named `ERR_*` constants beyond the two measured codes** (`ERR_INVALID_AUTH 20013`, `ERR_RESTRICTED_JURISDICTION 20558`, `ERR_ACCOUNT_NOT_FOUND 21100`, etc., §6.2): verified-facts measured only 20001 and 29404 and warns no authoritative list exists. Mark the rest "reference-source-derived, unverified against live" or drop them to a doc table.
  - **REST rate limiting is absent** — `LighterErrorKind` has no `ratelimit`, no 429/`Retry-After` classification, no open question; only WS has `ratelimit.ts`. Add 429 → retryable-with-backoff classification, or state that the server never 429s with evidence.
  - **`Disposable`/`Symbol.asyncDispose` and `AbortSignal.any` (§6.3, §6.7, §6.8, ADR-3)** are recent platform additions; early Node 20.x and 2023-era browsers lack them. The library only *implements* the interfaces (fine), but consumers' `using` needs the symbols — add a runtime-matrix note rather than discovering it in a consumer's CI.
  - **`NonceMode = "hedged" | "random"`** omits the `"pinned"` mode the source tree advertises (bigint covers it — cosmetic, but the tree comment and type will be implemented by different agents).
  - **`sendTx(txType, txInfo: object)` (§6.7)** accepts a plain object whose JSON key order depends on the caller's insertion order; `toTxInfo`'s canonical string exists precisely because key order matters. Accept `SignedTx` (or the canonical string) and serialize internally.
  - **Live-capture units (`rg`, `wslive`) gate release** (open questions 1–3) but their operational prerequisite — mainnet API credentials with a funded account, plus an IP that CloudFront likes — is stated nowhere. If credentials don't exist, three "blocking before release" questions are unanswerable.
  - **verified-facts itself mislabels the CDN:** "Cloudflare sits in front of the API" — the body says "Generated by cloudfront" and the architecture's `x-amz-cf-id` request id is CloudFront. The architecture is right here; fix the facts file so a future reader doesn't "correct" the architecture against it.

  ---

  ## Three things most likely to go wrong during parallel implementation

  1. **The sign/verify parser wiring and neutral-key flag get implemented from the wrong document.** Four files (ARCHITECTURE, spec/03, protocol-notes, verified-facts) currently instruct three different behaviours on the same 50 lines of code. *Cheapest catch:* before cutting wave-1 issues, reconcile the documents and write the three acceptance tests into the signer issue verbatim — `schnorr.json → malleable` (s+n accepted), neutral key rejected with no opt-out, 79/81-byte length rejection. These run against existing vectors on day one.
  2. **Barrel/index.ts merge collisions and phantom-complete units.** Seven wave-1 units converge on `crypto/index.ts`; `models/index.ts` has two owners; several tree files have no owner. *Cheapest catch:* the unit manifest (finding 6) plus a CI check that every `src/**/*.ts` is reachable from exactly one subpath barrel — fails the first PR that orphans or double-claims a file.
  3. **The R4 benchmark never runs until wave 5** because no wave-1 unit owns it, and if it fails there is no pre-authorized fallback — the fixed-base comb is currently a written non-goal. *Cheapest catch:* create the `bench` unit now with the gate restated as "one `sign()` in `wrangler dev` under X ms against the stated paid-tier budget", and amend the non-goal to name the comb as the fallback.

  ## What I would cut

  - **`./l1` built-in secp256k1/keccak256 signer** (finding 8) — directly against the measured directive; viem already satisfies the seam in the only known consumer. Deletes a unit, a devDep, and the largest avoidable crypto-risk surface. If ADR-10 also moves the nonce PRF to Poseidon2 per protocol-notes, `crypto/sha256.ts` and its unit go too.
  - **`docs-and-perf` as a unit** — split: perf benchmark to wave 1 (it is the R4 gate), docs to per-module ownership by each unit's author.
  - **`LighterWsPool`** — sharding policy within the 500/500/255 limits is application topology, not protocol; a documented recipe plus the per-socket limits enforced in the client earns the same value without a class to maintain. (Weak cut — keep if the DO example needs it.)
  - **Hard-coded counts in parity definitions** (findings 11–12) — cut the numbers, keep the gates.

  ## Sections that check out

  - ADR-1 canonical-bigint representation — matches protocol-notes §1 and the vectors; rejected alternatives fairly characterized.
  - ADR-2 split reduction strategy — measurement-backed; consistent with the katgen benchmarks in this repo.
  - ADR-3/ADR-4/ADR-5 — zero-dep enforcement, ESM-only `tsc` emit, `nodenext`: internally consistent and correctly argued.
  - ADR-6 — OpenAPI handling matches the measured facts (no live spec, `required` wrong, `mark_price` missing).
  - ADR-7 — WS channel registry and the five-step routing ladder match the measured reference-client defects.
  - ADR-8 — HTTP-status-first success rule and the three envelope-less exceptions are consistent across §1.1(c) and ADR-8.
  - ADR-11 (minus the browser gap), ADR-12 — portability-runner design and checked-in-vectors contract are sound and match the working oracle.
  - ADR-13's preserve-list contents — each quirk I spot-checked (sgn0-even polarity, `POWER_OF_TWO_GENERATOR`, −1 → 2³²−2, arithmetic-shift split) is confirmed by the vector files and protocol-notes; the *table* is right even where its fix/bypass categories conflict (findings 1, 4).
  - ADR-14 — lease-based nonces with no-rollback-on-timeout is correct and fixes a real reference defect.
  - ADR-15/ADR-16 — numeric-tier separation and float64 paper engine match the measured hazards and the 1e-12 parity requirement.

