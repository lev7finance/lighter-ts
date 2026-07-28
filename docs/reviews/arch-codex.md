## Prioritized findings

1. **SEVERITY: critical**  
   **WHERE:** ADR-10, R1, §8.2(5), Open Question 6  
   **CLAIM:** “`'hedged'` (default) — RFC-6979-shaped HMAC-SHA-256 derivation…”  
   **PROBLEM:** This violates both higher-authority documents in different ways. `00-verified-facts.md` says: “`crypto.getRandomValues` by default.” `protocol-notes.md` says: “Use Poseidon2… Do not hand-roll SHA-256 and HMAC.” The architecture chooses neither. Worse, its only default-nonce test feeds a signature to `Validate`; that cannot detect a constant, biased, endian-swapped, message-independent, or reused nonce. Such implementations verify correctly while leaking the private key. The current conformance README already says hedged-deterministic, so Open Question 6 is also stale.  
   **FIX:** Block nonce implementation issues until one normative definition is ratified. Under the stated precedence, use random-by-default unless `00` is explicitly amended. If hedging is retained, specify one byte-exact KDF and add fixed `(sk,msg,entropy) → k` vectors, all-zero entropy, same-key/different-message, different-key/same-message, range/retry tests, and a nonce-reuse key-recovery regression. Make nonce derivation its own security-gated unit. Put Go reverse validation in a separate manual/scheduled job; ADR-12 otherwise forbids the Go execution §8.2 assumes.

2. **SEVERITY: critical**  
   **WHERE:** §6.4 `verify`, ADR-13, Risk R18  
   **CLAIM:** `verify(..., opts?: { allowNeutralPublicKey?: boolean })` and neutral rejection is bypassable under `strict`.  
   **PROBLEM:** `protocol-notes.md` says: “Reject the neutral public key in `verify`, with no opt-out flag” and calls `allowNeutralPublicKey` a supported universal-forgery configuration. An attacker can forge for `PK = 0` without knowing a private key.  
   **FIX:** Remove `allowNeutralPublicKey` from the public API and from the generic strictness policy. Reject neutral keys unconditionally. If diagnostic parity is necessary, keep a non-exported/test-only function whose name explicitly says it permits universal forgery.

3. **SEVERITY: major**  
   **WHERE:** §6.4 `verify`; ADR-13 parser policy  
   **CLAIM:** `verify` documents “out-of-range scalar → false,” while ADR-13 says “Scalar and public-key byte parsing reduce rather than reject.”  
   **PROBLEM:** These are mutually exclusive. `protocol-notes.md` records that the reference accepts `s+n`, `e+n`, non-canonical public-key limbs, and their combinations. Strict verification rejects signatures the sequencer accepts. General-purpose strict field decoders do not fix this; the verification path must deliberately use reducing decoders.  
   **FIX:** Define three separate APIs: canonical encoders, explicit strict diagnostic decoders, and length-strict/reducing protocol decoders used by `verify`. Pin `s+n`, `e+n`, both, and non-canonical public-key limbs in tests. Remove “out-of-range scalar → false” from `verify`.

4. **SEVERITY: major**  
   **WHERE:** ADR-9, §6.5 L1 API, source tree `src/l1`  
   **CLAIM:** “Only three of twenty transaction types need an L1 signature” and a built-in keccak/secp256k1/RFC-6979 signer will ship.  
   **PROBLEM:** `00-verified-facts.md` says: “Four flows need… `create_sub_account`.” The architecture’s own template table includes it, but the decision text would lead an implementation to omit its L1 signature. The same facts say any in-house secp256k1 proposal should be rejected unless the injected seam fails; no failure is identified, and the consumer already has viem. The proposed interface is not “satisfied verbatim” by viem either: viem takes an options object, so it needs an adapter.  
   **FIX:** Treat all four measured flows as L1-signed. Delete `./l1`, keccak, secp256k1, recovery, and RFC-6979 from v1. Keep message construction plus `EthPersonalSigner`; ship a tiny documented viem adapter.

5. **SEVERITY: major**  
   **WHERE:** §6.6 `mapCandle`; ADR-15  
   **CLAIM:** `open`, `high`, `low`, `close`, `baseVolume`, and `quoteVolume` are returned as `number`.  
   **PROBLEM:** `00-verified-facts.md` says monetary and size fields are decimal strings and: “Never parse them through `Number`.” The architecture reintroduces the exact precision bug ADR-15 claims to eliminate. `MarketHandle.setLeverage` similarly accepts fractional `number` values despite the two-tier rule.  
   **FIX:** Preserve candle monetary fields as decimal strings, or return explicitly scaled `bigint` values with scale metadata. Keep `number` only for proven-safe timestamps/counts. Accept leverage and margin fractions as decimal strings or exact numerator/denominator values.

6. **SEVERITY: major**  
   **WHERE:** ADR-1, ADR-2, R4, wave plan  
   **CLAIM:** A 60,000-`fpMul` run under 50 ms falsifies the BigInt design; above roughly 500 ns/multiply signing exceeds the CPU budget.  
   **PROBLEM:** The arithmetic does not support the gate. At 500 ns, 85,000 multiplications already cost 42.5 ms before point additions, allocations, Poseidon2, and nonce generation. The stated 60k/50 ms gate permits 833 ns/multiply, implying 70.8 ms for multiplications alone. That cannot fit the Workers Free 10 ms budget; on Workers Paid it is nowhere near design-invalidating because the default is 30 seconds and the maximum is five minutes. [Cloudflare’s current limits](https://developers.cloudflare.com/workers/platform/limits/) make the required deployment tier the actual decision. The existing benchmark extrapolates a complete signature from one hot multiplication loop, runs only on local Apple Silicon, and its runtime detection dereferences `process` in workerd. It also says `%` is fastest everywhere, contradicting ADR-1/2’s field fold. Finally, the benchmark is owned by wave-5 `docs-and-perf`, despite R4 calling it a wave-1 gate.  
   **FIX:** Decide whether Free-tier signing is a requirement. Benchmark a complete sign and verify, cold and warm, at p50/p99 on a deployed Worker and record `cloudflare.cpu_time_ms`; do not use `wrangler dev` or multiplication extrapolation as the acceptance test. Move this gate to wave 1. Add an injected asynchronous `L2Signer` to the high-level client now so a Worker can delegate signing if needed. ADR-1’s proposed limb fallback cannot sit “behind the same brand” while public `Fp` is literally branded `bigint`; either make the backend opaque or delete that fallback claim.

7. **SEVERITY: major**  
   **WHERE:** §1.1, ADR-12, §8.1 oracle inventory  
   **CLAIM:** The architecture repeatedly says `tx.json` has 35 transaction rows and says non-canonical signature acceptance still needs to be added.  
   **PROBLEM:** The documents and live artifacts disagree three ways: `00-verified-facts.md` says 9 end-to-end transactions; the architecture says 35; the current oracle has 38 rows covering all 20 types. `schnorr.json` already contains three `malleable` cases, despite §8 calling this a gap. Agents will implement against different acceptance contracts or duplicate/rename vector sections.  
   **FIX:** Reconcile `00`, the architecture, README, and vectors before issue creation. Generate counts and covered transaction-type IDs from the JSON in CI instead of copying counts into prose. Give every issue exact existing vector paths and keys, not prose totals.

8. **SEVERITY: major**  
   **WHERE:** §9 implementation plan  
   **CLAIM:** “Units within a wave own disjoint files.”  
   **PROBLEM:** No ownership table exists, and the source tree proves overlap: `repo-scaffold`, `public-api-barrel`, portability, and docs all need `package.json`, CI, and root indexes; core/long-tail model units share `models/index.ts`; every WS unit needs `ws/index.ts`; every client unit needs `client/index.ts`; every paper unit needs `paper/index.ts`. WS, client, and public API declarations are also centralized in the architecture, so agents will independently invent shared interfaces. The claim that L5 is the only mutable layer is false: WS transport, subscriptions, order books, pools, and the paper engine all hold mutable state.  
   **FIX:** Add a machine-readable unit ledger with `ownedFiles`, `createdTests`, `dependsOn`, and acceptance commands. A path may have one owner only. Assign all barrels and root configuration to a final integration unit; leaf units must not edit them. Replace “L5 is the only mutable layer” with explicit state ownership and lifetime rules.

9. **SEVERITY: major**  
   **WHERE:** §9 dependency graph; §11 blocking questions  
   **CLAIM:** `ws-live-capture` depends on completed WS client/send-tx/order-book units; REST fixtures follow the REST client; `docs-and-perf` follows the full public API.  
   **PROBLEM:** The arrows are backwards. Live capture is supposed to determine ack correlation, account update semantics, keepalive, channel shapes, and truncation before those modules are designed. REST fixtures are evidence for models, not a post-client deliverable. The performance gate must precede crypto design. Oracle extensions must precede the signer/curve acceptance tests, but no such edges exist.  
   **FIX:** Create wave 0 with standalone probes and artifacts: WS capture using a minimal raw socket script, committed REST fixtures, full-sign Worker benchmark, oracle extension, and input vendoring. Make implementation units depend on those artifacts.

10. **SEVERITY: major**  
    **WHERE:** §5 source tree; ADR-6; paper plan  
    **CLAIM:** `spec/openapi.snapshot.json` and `conformance/vectors/paper/*.json` are available inputs.  
    **PROBLEM:** Neither exists in the target repository. `rest-models-longtail` has no unit responsible for copying and pinning `ref-lighter-python/openapi.json`; the paper units have no predecessor that creates or independently checks their vectors. Those units cannot be verified independently and will stall or invent fixtures.  
    **FIX:** Add explicit prerequisite units that commit the snapshot with provenance/digest and commit paper vectors with a pinned Python revision plus independently derived cases. Otherwise cut both generated long-tail models and paper trading from v1.

11. **SEVERITY: major**  
    **WHERE:** §9 unit sizing  
    **CLAIM:** Five waves contain 18 + 11 + 15 + 11 + 5 units.  
    **PROBLEM:** That is 60 units, not the approximately 40 issues expected. Several remaining nodes are still multiple focused sessions: `crypto-schnorr-key`, all 20 builders in `tx-pipeline-builders`, 78 `rest-routes`, all 22 WS payloads/channels, the complete client write surface, the trading facade with brackets/batches/sequences, all repository documentation and benchmarks, and roughly 63 examples in one issue.  
    **FIX:** Split security-critical or independently testable work—nonce KDF, signature codecs/verify, transaction serializer/pipeline, order-book state/watcher. Merge trivial constants/barrel work. Defer low-value surfaces so each issue has one invariant and one independently runnable test command.

12. **SEVERITY: major**  
    **WHERE:** D4, ADR-11, §6 subscription/client APIs  
    **CLAIM:** One runner works on Node 20 using `--experimental-strip-types`, and the package runs unmodified in browsers while exposing `Disposable`/`Symbol.asyncDispose`.  
    **PROBLEM:** Node type stripping was added in Node 22.6, so the proposed command cannot test Node 20. [Node’s documentation](https://nodejs.org/download/release/v22.16.0/docs/api/typescript.html) records that version boundary. `Symbol.dispose` is still not Baseline, and `Symbol.asyncDispose` is unavailable in current Safari, so computed disposal APIs do not meet the browser claim. [MDN marks `Symbol.dispose` as limited availability](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose). The vector runner also tests mostly crypto, not REST, WebSocket, timers, abort composition, or disposal.  
    **FIX:** Emit the portability runner to JavaScript and execute built JS on Node 20. Make `close()`/`release()` the normative lifecycle APIs and add disposal symbols only conditionally. Add per-runtime smoke tests for imports, REST timeout/abort, WebSocket injection, randomness, and cleanup; qualify Node 20 WebSocket support as requiring an injected constructor.

13. **SEVERITY: major**  
    **WHERE:** Layer rules, §6.5 `TransactOpts`  
    **CLAIM:** “L0–L2… perform no clock reads except through an injected `now()`,” while `expiredAt` is optional and defaults to `now + 599_000`.  
    **PROBLEM:** `buildCreateOrder(req, opts)` receives neither `now` nor configuration. An agent must either call `Date.now()` inside the supposedly pure transaction layer, invent a hidden clock, or make the declared default false. Concurrent builder implementations will choose differently.  
    **FIX:** Require `expiredAt` on raw builders. Apply the configured clock/default only in the high-level account layer, before invoking the pure builder. Alternatively add an explicit clock parameter to a single options resolver owned by one unit.

14. **SEVERITY: major**  
    **WHERE:** ADR-7  
    **CLAIM:** One `Subscription` serves callback and `AsyncIterable` consumers; callbacks run before events are enqueued.  
    **PROBLEM:** A callback-only consumer never drains the queue, so the bounded buffer eventually triggers drop/resubscribe/error policy despite the callback keeping up. Two async iterators over the same object also have unspecified broadcast versus work-stealing semantics. The rejected alternatives omit the simpler design of separate views over one subscription.  
    **FIX:** Separate `subscription.on(...)` from `subscription.events()` with independent buffering, or instantiate the queue only when iteration begins. Specify whether multiple iterators are forbidden or independently broadcast. Test callback-only operation past buffer capacity.

15. **SEVERITY: major**  
    **WHERE:** §2 runtime validation non-goal; ADR-6/7  
    **CLAIM:** “Types are compile-time only; an `onResponse` hook is provided for users who want their own checks.”  
    **PROBLEM:** REST and WS payloads are untrusted runtime values, and the SDK itself consumes them for pagination, order-book mutation, exact arithmetic, nonce tracking, and trading decisions. A caller hook cannot protect internal code. Forward compatibility requires allowing unknown fields, not accepting wrong required-field types, invalid decimals, unsafe integers, or unbounded frames.  
    **FIX:** Add dependency-free, minimal trust-boundary decoders for fields the SDK consumes: object/array checks, required discriminants, decimal lexical validation, integer range checks, and frame/depth limits. Preserve unknown fields and offer raw access. Do not attempt full OpenAPI validation.

16. **SEVERITY: major**  
    **WHERE:** §6.4 `ApiKey`, D10, §6.2 errors  
    **CLAIM:** `ApiKey` publicly exposes `privateKeyBytes` and `privateKeyHex`; diagnostics are safe because `redact()` is applied at diagnostic boundaries.  
    **PROBLEM:** A `readonly Uint8Array` remains mutable, so callers can corrupt key state or serialize it. Enumerable private-key properties are easy to leak through object inspection or logging. `LighterError.toJSON()` includes an unspecified `cause`, while API errors expose `body` and blocked errors expose `rawBody`; those are serialization boundaries not covered by “diagnostic” wording. Total key compromise is possible without any bug in signing.  
    **FIX:** Keep private material in a non-enumerable private slot, copy inputs, and return defensive copies only through an explicitly named `exportPrivateKey()` method. Ensure `JSON.stringify(ApiKey)` exposes nothing. Specify cycle-safe redaction for error causes/bodies, cap raw body length, and test direct serialization—not only diagnostic callbacks.

17. **SEVERITY: major**  
    **WHERE:** ADR-13, §6.5 `TransactOpts.strict`, R18  
    **CLAIM:** Wire-changing fixes are “individually bypassable,” but the public API exposes one `strict?: boolean`.  
    **PROBLEM:** One switch couples unrelated policies: negative margin, pool shares, leverage range, grouped-order consistency, memo length, and possibly neutral-key handling. R18 says “all four individually bypassable” while listing six items. Agents cannot implement both the prose and the API. Disabling one compatibility check silently disables all others.  
    **FIX:** Replace `strict` with named `ValidationPolicy` fields. Keep neutral-key rejection outside it. Defaults and hash-equivalence tests must be specified per rule.

18. **SEVERITY: major**  
    **WHERE:** ADR-14  
    **CLAIM:** “Rejection → rollback… Network timeout → neither.”  
    **PROBLEM:** Timeout is not the only unknown outcome. Connection reset after sending, abort after body upload, HTTP 5xx, malformed response, WS close before ack, or tx-hash mismatch can all occur after sequencer acceptance. Rolling back any of those can reuse a nonce. The public `NonceSource` exposes `snapshot()` but no `restore()` despite the rationale depending on restore.  
    **FIX:** Define three outcomes: definitive acceptance, definitive sequencer rejection, and indeterminate. Roll back only definitive rejection; quarantine/resync or confirm indeterminate nonces before reuse. Add `restore` to the actual interface and test every transport failure point.

19. **SEVERITY: major**  
    **WHERE:** ADR-6, §8.2 REST fixtures  
    **CLAIM:** Imported JSON fixtures will be “asserted assignable… with no excess-property errors,” catching server fields omitted from models.  
    **PROBLEM:** TypeScript’s structural assignment generally allows extra properties once a JSON object is held in a variable; ordinary assignability will not detect newly observed server fields. Generated long-tail types with every property optional also provide little usable contract while implying coverage.  
    **FIX:** Use an explicit `Exact<Fixture, Model>` type check or a runtime known-key audit for core models. Treat long-tail responses as documented partial shapes plus `unknown` remainder, or defer them. Do not claim ordinary assignability detects drift.

20. **SEVERITY: minor**  
    **WHERE:** ADR-11 toolchain rationale  
    **CLAIM:** “No ESLint (the only configs in the house are Next-specific…).”  
    **PROBLEM:** `00-verified-facts.md` says: “Lint is eslint (`eslint.config.mjs`).” The ADR’s evidence is stale, and parallel agents will otherwise follow inconsistent style/check commands.  
    **FIX:** Reinspect and cite the current root configuration. Either adopt its ESLint rules or state that this standalone package deliberately uses typecheck-only validation without claiming it matches the house.

21. **SEVERITY: minor**  
    **WHERE:** D4, REST transport  
    **CLAIM:** The REST layer runs unmodified in browsers; no User-Agent policy is specified.  
    **PROBLEM:** `00-verified-facts.md` requires an explicit browser-like `User-Agent` on affected paths. The deeper REST spec simultaneously says browsers forbid setting it and custom headers would fail CORS. The architecture ignores the conflict. A browser naturally supplies its own UA; a Worker/Node request may not.  
    **FIX:** Specify runtime-dependent behavior: never set `User-Agent` in browsers; set a browser-like UA only where the runtime permits; expose header/fetch injection; test the affected endpoints from browser, Worker, and Node. Use “CDN/WAF” rather than alternating between Cloudflare and CloudFront until headers identify the vendor.

## Three likely parallel-implementation failures

1. **Shared barrels/configuration collide.** Cheapest check: require an `ownedFiles` manifest and fail issue generation if any path has multiple owners.

2. **Agents implement against stale or different vector contracts.** Cheapest check: generate a conformance manifest from the committed JSON and require each issue to name exact keys plus a runnable slice of the vector suite.

3. **WS, REST-model, paper, and performance units start before their evidence exists.** Cheapest check: a wave-0 preflight that verifies required artifacts, runs standalone live probes, and executes one complete signature on a deployed Worker.

## Cut from v1

- The built-in L1 signer, recovery, EIP-55, and associated SHA/RFC-6979 reuse.
- The paper engine and its opt-in funding/incremental-liquidation extensions until vectors exist.
- Generated all-optional long-tail REST models; retain core trading models and raw typed route access.
- `LighterWsPool` and the dual callback/iterator abstraction; add them only after one socket/subscription model is proven.
- One-for-one parity for roughly 63 examples; keep a small acceptance set covering read, sign, submit, stream, and L1 injection.

## Sections to retain

- **§2 non-goals:** ESM-only, unbundled output, no native/WASM path, honest timing limits, and no key-wiping claim.
- **ADR-1:** Canonical BigInt field representation; remove only the incompatible limb-fallback promise.
- **ADR-3:** Zero runtime dependencies.
- **ADR-4:** ESM-only per-file `tsc` output with explicit exports.
- **ADR-5:** `nodenext` authoring plus a separate bundler-resolution check.
- **ADR-8:** Open numeric server codes, structural guards, HTTP/body dual checking, and non-JSON error classification.
- **ADR-12:** Checked-in deterministic vectors and manual, reviewed regeneration; update the inventory.
- **ADR-15:** Separate raw protocol units from exact human decimal input; repair the conflicting APIs.
- **ADR-16:** Float64 and synchronous paper arithmetic, if the paper engine remains in scope.
- **§8.2:** Independent arithmetic models, seeded properties, and replay fixtures, excluding the ineffective nonce and excess-property checks above.
