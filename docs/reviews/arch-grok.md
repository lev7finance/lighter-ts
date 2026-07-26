I'll review the architecture adversarially against measured facts, protocol notes, and the conformance oracle. Reading the primary sources first.Continuing through ADRs, work decomposition, risks, and remaining architecture sections.Checking measured contradictions: L1 flows, neutral-key policy, R4 budget math, and unit file ownership.Checking a few more load-bearing claims before writing the review.# Adversarial architecture review — lighter-ts

Sources outrank in this order: `00-verified-facts.md` → `protocol-notes.md` → measured vectors → architecture. Quotes below are exact or near-exact.

---

## CRITICAL

### 1. Neutral-pubkey policy: architecture reintroduces a universal forgery as a feature

- **SEVERITY:** critical  
- **WHERE:** §6.4 `verify` API; ADR-13 “fix behind `strict`”; R18  
- **CLAIM:**

  ```ts
  opts?: { allowNeutralPublicKey?: boolean }
  ```

  ADR-13: `verify()` rejecting a neutral public key is behind `strict`, default on, **bypassable**.  
  R18 frames neutral pubkey as a “strict tightening” that might refuse “legitimate calls.”

- **PROBLEM:** `protocol-notes.md` §5.2.2 (measured):

  > Reject the neutral public key in `verify`, with **no** opt-out flag. An `allowNeutralPublicKey` option turns a known universal forgery into a supported configuration.

  Forgery: pick any `s`, set `R = [s]G`, `e = H(encode(R) ‖ m)`. No legitimate account holds the neutral key. R18’s “legitimate calls refused” framing is false. Spec 03 D2 also ships the opt-out — same defect.

- **FIX:** Hard-reject neutral in production `verify`. No option. Diagnostics only via a test-only symbol named like `verifyAllowingNeutralForTests`. Remove from ADR-13 flag list and R18. Delete `allowNeutralPublicKey` from the public API.

---

### 2. Schnorr nonce quality is untested by the stated plan (broken k still goes green)

- **SEVERITY:** critical  
- **WHERE:** ADR-10; R1; §8.2 item 5; open question 6  
- **CLAIM:** ADR-10 hedged HMAC-SHA-256 default; R1 mitigates with “nonce unit reviewed as security-critical”; §8.2.5 Go reverse-validation of default-mode signatures proves wire compatibility.  
- **PROBLEM:** `protocol-notes.md` §5.1 (and `00`):

  > a broken nonce derivation passes every signature conformance test. Verification only reconstructs `R` and the challenge; it cannot observe where `k` came from.

  Committed vectors only pin **caller-supplied** `nonceKLeHex`. Reverse-validating a TS signature through Go `Validate` only proves “some valid `k` existed.” It accepts:

  - constant `k`
  - `k` independent of `sk` or message
  - endian-swapped derivation
  - pure random labeled as “hedged”

  None of the required tests are in §8:

  - fixed `(sk, msg, entropy) → k` including all-zero entropy  
  - same-key/different-message and different-key/same-message  
  - `k ∈ [1, n)`  
  - explicit nonce-reuse → key-recovery regression  

  Open question 6 still claims `conformance/README.md` says `getRandomValues`; current README already says hedged. `00` still says random by default. Three docs, three stories.

- **FIX:** Before any sign unit merges: commit hedged KATs (oracle or pure-TS golden), key-recovery test on reuse, and a single ratified default in `00` + architecture + README. Treat reverse-validation as wire-compat only, never as nonce security.

---

### 3. Parser strictness on the verify path rejects signatures the sequencer accepts

- **SEVERITY:** critical  
- **WHERE:** ADR-13 preserve table vs “Fix unconditionally”; §6.4 `fpFromBytes` / `fp5FromBytes`  
- **CLAIM:** ADR-13 preserve: “Scalar and public-key byte parsing **reduce** rather than reject.”  
  Same ADR “fix unconditionally”: “**strict-by-default** byte decoders with explicit `Unchecked` variants.”  
  API: `fpFromBytes` = strict; `fpFromBytesUnchecked` = reduces.  
- **PROBLEM:** `protocol-notes.md` §5.2.1 + `schnorr.json` `malleable` (`shiftedValidates: true` for `s+n`, `e+n`, both):

  > the reference **accepts** non-canonical public keys, message hashes, and signatures. … a strict parser rejects signatures the sequencer accepts.

  Architecture documents both policies and defaults the wrong one on the public byte API. An implementer wiring `verify` through `fpFromBytes` / strict Fp5 decode will fail interop while vectors for *canonical* cases still pass.

- **FIX:** Normative split (match protocol-notes):  
  - `sign`/`verify` path: length check + **reduce**  
  - strict parsers: opt-in only, never default on verify  
  - encoders: always canonical  
  Rename so the safe interop path is not `Unchecked`.

---

### 4. R4 gate does not measure the risk it claims; fallback is empty

- **SEVERITY:** critical  
- **WHERE:** R4; ADR-1; non-goals (`mDouble` / fixed-base comb deferred); §3 D6  
- **CLAIM:** R4: ~85 000 modular multiplications per scalar mul; if mul+reduce > ~500 ns in Workers, signing exceeds CPU budget. Mitigation: `60k-fpMul-under-50 ms` in wave 1; falsifies ADR-1; limb backend “behind the same brand.”  
- **PROBLEM:**

  | ns/mul | 60k gate | one scalarmul (85k) | verify (~2×) |
  |---:|---:|---:|---:|
  | 50 (desktop Node here) | 3 ms pass | ~4 ms | ~9 ms |
  | 500 (R4 threshold) | 30 ms pass | ~43 ms | ~85 ms |
  | 833 (gate limit) | 50 ms pass | ~71 ms | ~142 ms |

  The hard gate allows ~833 ns/mul while the design-invalidating threshold is ~500 ns. A build can pass the gate and still blow a 10–50 ms Workers CPU budget on **one** sign, before Poseidon, JSON, or fetch. The gate is base-field `fpMul` only — not `mulScalar`, not `sign`, not workerd.

  Spec 03 budgets sign < 25 ms / verify < 50 ms on Node laptop — different metric, never cross-wired to R4.

  Fallback: limb backend is already **rejected** in ADR-1 (“lost on every engine”). Fixed-base comb / `mDouble` are **non-goals for v1**. WASM is banned. **There is no credible Workers plan B.**

  Monorepo target is Cloudflare Workers. If R4 fails late, ~40 issues of pure-BigInt crypto are scrap.

- **FIX now (not wave 5):**  
  1. Wave-1 gate: full `sign` + `verify` on **workerd** with numeric budgets (e.g. sign ≤ 25 ms, verify ≤ 50 ms, or measured CPU time API).  
  2. Promote fixed-base tables for `G` into wave 1 (sign path), not “later optimisation.”  
  3. Pre-decide: if budget fails → (a) Workers-only signing via DO with higher CPU, (b) optional WASM crypto subpath for Workers only, or (c) drop “unmodified Workers signing” from D4. Document the product decision **before** cutting issues.

---

### 5. L1 scope: architecture vs measured facts (and vs Go wire)

- **SEVERITY:** critical (doc/contract)  
- **WHERE:** ADR-9; §6.5 `L1_TEMPLATES`; `00` “L1 signing should be injected”  
- **CLAIM (ADR-9):** “Only **three** of twenty transaction types need an L1 signature (`ChangePubKey` always; `Transfer` when cross-owner; `ApproveIntegrator` …).” Ships full `./l1` secp256k1+keccak.  
- **PROBLEM:**

  `00-verified-facts.md`:

  > Four flows need an Ethereum `personal_sign` … `change_pub_key`, `transfer`, `approve_integrator`, `create_sub_account`.  
  > **Any proposal to hand-roll secp256k1 should be rejected** unless the injected-signer seam fails.

  Vectors: 6 `l1Messages` including two `create_sub_account/*`.  
  Go `L2CreateSubAccountTxInfo` has **no** `L1Sig` field (L2 wire does not attach it). Spec 04 says the create-sub-account template is “not wired to any tx.”

  Architecture undercounts vs `00`, ships the rejected hand-rolled crypto, and never reconciles “four flows” vs “three L2 types with L1Sig” vs “template-only.” Parallel issues will invent three different `requiresL1Signature` implementations.

- **FIX:** One table in architecture: flow → L2 field? → template? → when required. Align ADR-9 count with `00` (message construction for four + airdrop). **Drop `./l1` secp256k1 from v1** (or quarantine as non-published example). Injected `EthPersonalSigner` only; monorepo already has viem.

---

## MAJOR

### 6. Parallel wave plan is not file-disjoint and crypto is not parallel

- **SEVERITY:** major  
- **WHERE:** §9 Implementation plan  
- **CLAIM:** “units within a wave own **disjoint files**, so everything unblocked can run in parallel.” Wave 1 = 18 units.  
- **PROBLEM:**

  **Shared files (secret contention):** `errors.ts`, `util/{bytes,json,decimal,redact}.ts`, `crypto/index.ts`, `package.json` exports, `src/index.ts`, `tx/{constants,enums,brands,schema}.ts`, `models/index.ts`, barrels. Multiple units will collide on every merge.

  **Wrong / missing edges:**  
  - `conformance-oracle-extend` is not an ancestor of `crypto-point` / `crypto-schnorr` even though §8.1 says those units need `decodeFailures[]`, neutral PK, malleable, `hashTwoToOne`, etc. Units ship against incomplete vectors.  
  - Critical path is serial: `fp → fp5 → pt → sm → sig → tx-pipeline → client-core → facade`. Wave-1 “18 parallel agents” is fiction for crypto; wall clock is the chain.  
  - `tx-pipeline-builders` (20 builders + pipeline + serialize) is multi-session for one agent.  
  - `examples-parity` (~63 scripts) is not one unit.  
  - `client-core` + `client-write-surface` + `client-trading-facade` all touch account/send paths.

  Units that cannot be verified alone: anything that only has partial vectors until oracle-extend lands; REST routes without golden fixtures; WS without live-capture answers to open Q 1–3.

- **FIX:** Explicit file ownership matrix per issue. Put oracle-extend **before** crypto negative paths. Split `tx-pipeline` into hash+serialize core vs per-family builders. Defer examples and paper. Mark shared files as “wave-0 owned by scaffold only.”

---

### 7. Vector / parity counts already disagree with the oracle

- **SEVERITY:** major  
- **WHERE:** §1.1(a); §8.1 table  
- **CLAIM:** “all 35 `tx.json` `txHashes` rows”  
- **PROBLEM:** Live oracle output: **38** `txHashes`, all **20** constructible types present. Architecture freezes a stale count into acceptance criteria and issue templates.  
- **FIX:** Replace hard-coded 35 with “every row of committed `tx.json`” (currently 38). Re-count after every oracle regen.

---

### 8. Default nonce still unresolved across authoritative docs

- **SEVERITY:** major  
- **WHERE:** ADR-10; open Q6; `00` Signature nonce; `conformance/README.md`  
- **CLAIM:** ADR-10 hedged default.  
- **PROBLEM:** `00` (outranks architecture):

  > The TypeScript signer must expose … `crypto.getRandomValues` **by default**.

  README now matches ADR-10 (hedged). Open Q6 cites a stale README. Cutting 40 issues without a single ratified line guarantees two nonce modules.

- **FIX:** Amend `00` or ADR-10 in one commit. Recommendation consistent with security goals: **hedged default**, random opt-in, pinned `k` for vectors — but `00` must say so explicitly.

---

### 9. ADR-10 PRF choice contradicts committed protocol-notes (and adds unvalidated crypto)

- **SEVERITY:** major  
- **WHERE:** ADR-10; L0 `sha256.ts`; protocol-notes §5.1  
- **CLAIM:** HMAC-SHA-256 deliberate; Poseidon2 couples failure modes; ~150 LOC sync SHA-256.  
- **PROBLEM:** protocol-notes:

  > Deriving the nonce needs a PRF. **Use Poseidon2** … Do not hand-roll SHA-256 and HMAC for this … a hand-written SHA-256 adds a second unvalidated primitive whose failure is invisible.

  ADR rationale (domain separation of primitives) is reasonable **as cryptography taste**, but it is not settled against the committed trap doc, and it forces an extra pure-TS hash with **no** conformance vectors. SHA-256 bugs won’t fail `schnorr.json` (same class as finding #2).

- **FIX:** Pick one PRF in a single ADR amendment. If HMAC stays: commit HMAC-SHA-256 KATs + hedged k vectors in wave 1. If Poseidon2: delete `sha256.ts` from the required sign path (keep only if `./l1` survives, which it should not).

---

### 10. `mapCandle` and integrator fees reintroduce float money

- **SEVERITY:** major  
- **WHERE:** §6.6 `mapCandle`; §6.8 `integrator?: { takerFee?: number; makerFee?: number }`; ADR-15  
- **CLAIM:** ADR-15: human money is decimal strings / bigint; never `number` for money.  
- **PROBLEM:**

  ```ts
  open: number; high: number; … baseVolume: number; quoteVolume: number;
  ```

  and fee fields as `number`. Contradicts `00` (“Never parse them through `Number`”) and ADR-15. Silent precision loss on the exact surface monorepo candles already use (`workers/web/src/lib/candles.ts`).

- **FIX:** Candle OHLCV as strings or scaled bigint. Integrator fees as protocol integers or decimal strings. No `number` on money paths.

---

### 11. ADR-13 internal contradiction + R18 misclassifies security as UX strictness

- **SEVERITY:** major  
- **WHERE:** ADR-13; R18  
- **CLAIM:** One ADR both “preserve reduce-on-parse” and “strict-by-default decoders”; R18 bundles neutral pubkey with memo length as bypassable strictness.  
- **PROBLEM:** Implementers cannot know the default. Security properties (neutral reject, interop reduce) are not “strict flags.”  
- **FIX:** Split ADR-13 into: wire-observable preserve | interop parsers | local validation flags. Never put forgery rejection on a user-facing bypass list.

---

### 12. JavaScript `%` sign bug not elevated as a first-class gate

- **SEVERITY:** major  
- **WHERE:** protocol-notes §5.0; architecture §8 / scalar  
- **CLAIM:** Architecture mentions total scalar arithmetic; does not name the JS trap.  
- **PROBLEM:** protocol-notes:

  > This is the single most likely way to get a correct-looking implementation that cannot sign.  
  > `(-1n) % n === -1n`

  Vectors with pinned `k` can still pass if reduction is correct on those paths while a general `modN` is missing in another constructor. Parallel agents will each invent `%` vs `modN`.

- **FIX:** Shared `modN` in `scalar.ts` only; property test `∀ s,e,k: s = modN(k - modN(e*sk)) ∈ [0,n)` with half the samples forcing negative intermediate; ban raw `%` on scalars in CI grep for crypto.

---

### 13. Wave-1 “disjoint files” vs Poseidon constants generation race

- **SEVERITY:** major  
- **WHERE:** §5 scripts; units `poseidon2-constants` / `oracle`  
- **CLAIM:** `gen-poseidon2-constants.ts` vectors → `constants.generated.ts`.  
- **PROBLEM:** Two agents can both own constants (oracle regen vs gen script vs hand edit). Digest pin is good; ownership is not specified.  
- **FIX:** Single owner issue for constants; all others import only.

---

### 14. REST “78 ops” vs `00` “76 paths”; OpenAPI long-tail still in tree

- **SEVERITY:** major (process)  
- **WHERE:** §1.1(c); ADR-6; scripts `generate-models.ts`  
- **CLAIM:** 78 operations; long-tail generated with `required` ignored.  
- **PROBLEM:** `00` measured 76 distinct paths. Off-by-two will produce empty/wrong routes. Generator exists while ADR-6 says no generator in build path — fine offline, but agents will treat `openapi.snapshot.json` as truth despite `00` saying there is no live OpenAPI and the snapshot is known-wrong.  
- **FIX:** Reconcile 76 vs 78 with a path list in-repo. Label snapshot `UNTRUSTED`. Core models hand-only for trading path in v1; long-tail optional later.

---

### 15. Private key surface is easy to leak

- **SEVERITY:** major  
- **WHERE:** §6.4 `ApiKey`; §6.8 `keys: Record<number, string | Uint8Array>`  
- **CLAIM:** D10 no secrets in logs; `redact()` at diagnostic boundaries.  
- **PROBLEM:** `privateKeyBytes` / `privateKeyHex` are public readonly fields; account holds raw key map. `JSON.stringify(apiKey)`, devtools, Worker logging of config all dump sk. BigInt/key wiping is a non-goal (honest) but accidental serialization is unmitigated.  
- **FIX:** Non-enumerable / private fields; `toJSON` redacts; forbid logging `ApiKey`; constructor takes keys and never re-exports hex by default; tests that `JSON.stringify` on account/config has no 80-char key material.

---

## MINOR

### 16. Open question 6 is stale

- **SEVERITY:** minor  
- **WHERE:** §11 Q6  
- **CLAIM:** README says random default.  
- **PROBLEM:** README already says hedged; real conflict is `00` vs ADR-10.  
- **FIX:** Rewrite Q6 to cite `00`.

---

### 17. `AbortSignal.timeout` listed as universal base API

- **SEVERITY:** minor  
- **WHERE:** ADR-3  
- **CLAIM:** Built on `AbortSignal.timeout/any`.  
- **PROBLEM:** Not available on all Node 20 minor versions / some polyfill environments; Workers support varies by compat date. Silent runtime break.  
- **FIX:** Local timeout helper with `AbortController` + `setTimeout`; feature-detect.

---

### 18. Auth-token packing strictness underspecified in architecture API

- **SEVERITY:** minor  
- **WHERE:** §6.8 `createAuthToken`; protocol-notes §6; `00`  
- **CLAIM:** Auth tokens use same Poseidon path.  
- **PROBLEM:** `00`/protocol: gnark packing **validates** 8-byte chunks vs modulus (never fires for ASCII messages, but check is real). Architecture does not assign this to a file/test.  
- **FIX:** Explicit test in auth-token unit + chunk validation.

---

### 19. ADR-2 / ADR-1 dual reduce strategy will fork in parallel

- **SEVERITY:** minor  
- **WHERE:** ADR-1, ADR-2  
- **CLAIM:** compare-and-subtract in `reduce128`; plain `%` in Poseidon2.  
- **PROBLEM:** Good if measured, but two field agents will “unify” for cleanliness and break one path. Prior crypto review already saw Spec 01 vs 02 conflict.  
- **FIX:** Comment + CI: Poseidon path must not call `reduce128` in hot loop without bench.

---

### 20. Preference dressed as ADR: shipping paper + full WS surface + `./l1` in same product definition

- **SEVERITY:** minor (scope)  
- **WHERE:** §1.1(d)(f); ADR-9; ADR-16  
- **CLAIM:** Parity includes 22 channels, paper engine, built-in L1.  
- **PROBLEM:** None required for monorepo Workers candle/market-limits replacement. Multiplies issue count and review surface. ADR-16’s float paper is coherent *if* paper ships; shipping paper in v1 is preference.  
- **FIX:** v1 = crypto + tx + REST trading core + WS order book + client order math. Defer paper, RFQ, pool WS, long-tail REST, `./l1`, 63 examples.

---

## ADRs — compressed verdicts

| ADR | Verdict |
|---|---|
| 1 Canonical BigInt Fp | Right for interop; limb fallback already disproven — don’t call it a plan B. |
| 2 Dual reduce strategy | OK if measured; document “do not unify.” |
| 3 Zero deps | Right for product. |
| 4 ESM tsc | Right for library. |
| 5 nodenext | Right for publish. |
| 6 Hand REST models | Right; 76/78 and snapshot trust need tightening. |
| 7 WS dual consumption | Sound. |
| 8 Error hierarchy + HTTP-first success | Sound; load-bearing. |
| 9 Inject L1 + ship `./l1` | Inject right; ship secp256k1 **wrong vs `00`**; L1 count wrong. |
| 10 Hedged nonce | Direction right; PRF conflict; **no security tests**. |
| 11 bun:test + portability runner | Sound. |
| 12 Vectors committed, no Go in CI | Sound. |
| 13 Preserve / fix / flag | Internally contradictory; neutral key wrong. |
| 14 Nonce lease, no timeout rollback | Right; load-bearing. |
| 15 Numeric tiers | Right; violated by public API (`mapCandle`, fees). |
| 16 Paper float64 | Coherent if paper ships; shipping is optional fat. |

**Load-bearing but undocumented as ADRs:**  
(1) `sign`/`verify` reduce-on-parse  
(2) hard neutral reject  
(3) Workers signing budget + fixed-base in v1  
(4) hedged k KATs  
(5) `modN` for all scalar ops  
(6) CreateSubAccount L1 template vs L2 wire

---

## Three most likely parallel-implementation failures

1. **Crypto chain merge hell + incomplete vectors**  
   Agents land field/curve/schnorr against incomplete negatives; later oracle-extend rewrites tests.  
   **Cheap catch:** Issue 0 = oracle-extend + freeze vector SHAs; crypto issues blocked on that tag.

2. **Interop-breaking “strict” defaults** (parse reject, neutral flag, banker’s vs conservative only in math)  
   **Cheap catch:** CI job: malleable `schnorr.json` vectors **must verify true**; neutral **must verify false** with no options; one end-to-end `tx.json` row per type.

3. **Broken or divergent nonce modules**  
   **Cheap catch:** Committed `(sk,msg,entropy)→k` file + key-recovery unit test in the same PR as `nonce.ts`; no merge without them.

---

## Cut from the plan

- Entire `./l1` secp256k1/keccak/rfc6979 subpath (use viem/Turnkey)  
- Paper engine + paper vectors + Python generator from v1  
- WS pool sharding, RFQ, most of 22 channels beyond book + account + sendtx  
- `examples-parity` as a gate (ship 5 critical paths)  
- Long-tail OpenAPI model generation (~100 types)  
- Dual naive 10⁴–10⁵ independent models as required CI (keep as optional nightly)  
- `allowNeutralPublicKey` and other “strict bypass” security knobs  
- Treating wave-1 18 crypto-adjacent units as parallelizable without a file-ownership matrix  

---

## Correct (one line each)

- Canonical BigInt field vs Go non-canonical is the right call and matches vectors.  
- One Poseidon2 (not two) is proven and correctly scoped.  
- Injected L1 message construction (not peer dep on viem) matches monorepo reality.  
- Chain id configured, never URL-sniffed.  
- REST dual status/`code` + non-JSON Cloudflare body handling.  
- WS JSON ping/pong, not protocol frames.  
- Integer/rational order math vs Python float hazards.  
- Lease nonces without timeout rollback.  
- Vectors committed; CI never runs Go.  
- ESM-only, zero runtime deps, workerd without `nodejs_compat` as real proof.  
- Shifted group law / `encode(G)===4` smoke test.  
- Attribute aggregation and grouped-order left-fold traps acknowledged.
