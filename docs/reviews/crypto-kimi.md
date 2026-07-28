• I'll start by reading the spec files, then cross-check against the reference code.

• I'll cross-check every load-bearing claim in the spec against the Go reference by launching parallel verification agents.

• While those run, I'll read the spec files myself.

• All four spec files read. Now let me spot-check the most load-bearing constants directly in the Go reference while the agents finish.

• Schnorr layer confirmed. Now the scalar field and curve constants.

• Agent 3's findings are solid. Now let me verify the Poseidon2 sponge and the curve decode myself.

• Constants verified. Let me check what the prior external reviews found, then collect the remaining agents.

• Two external reviews exist; several of their claims need verification. Let me check the sharpest ones myself.

• Now let me collect the remaining subagent results.

• Window/mul semantics confirmed. Let me numerically verify the spec's field constants with Python.

• All field constants verified. Reading the Poseidon2 agent's report.

• Curve constants independently verified. Waiting on the last two agents.

• All agents done. One open question: where did spec 00's `ORDER+4` generator claim come from — let me check the pinned v0.0.15 in the module cache.

• Spec 00's `ORDER+4` claim is confirmed true — via the actual public-key path. Let me restore the harness I modified.

• All verification complete. Let me confirm the `update_margin.go` signed-split detail for a precise quote.

• All verification is done — my own spot checks, four cross-check agents, and numerical re-derivation of the constants. Writing up the findings.

• # Adversarial review: crypto specs vs. Go reference

  Method: I read all four spec files, read the reference source directly (`schnorr.go`, `scalar_field.go`, `point.go`, `goldilocks_plonky2.go`, `goldilocks_quintic_extension.go`, `poseidon2.go`, `config.go`), ran the reference (`gochk`, plus an added probe, since reverted), and re-derived the constants in Python (field goldens, FROB tables, `POWER_OF_TWO_GENERATOR` provenance, curve equation, `legendre(b)`, `legendre(a²−4b)`, `n` primality/Hasse, diag table hex↔decimal). Four independent agents cross-checked the remaining claims, several by execution.

  Headline: **the algebra is right.** Every load-bearing formula and constant I could check — extension polynomial, mul/square folds, inversion chain, Frobenius tables, Tonelli–Shanks, sgn0, curve constants, group order, recoding, Poseidon2 parameters/constants/sponge, Schnorr equation and preimage — matches the reference. The real problems are **contradictory normative instructions across the four documents**, a few false factual claims, and omissions at exactly the spots an implementer will trip over.

  ---

  ## CRITICAL

  ### 1. The two specs give contradictory decoder policies, and one of them breaks interop with the exchange

  - CLAIM: `01-crypto-field.md` §5.1 — "**decoders are strict by default**: `fpFromBytes(b)` throws if `b.length !== 8 or value >= p`", §10.3 "Strict by default". But `03-crypto-curve-schnorr.md` §2.8 — "reduce on parse… Default `strict: false` for compatibility", §5.3 "it reduces, it does not reject", §7.6 "Parsing reduces each half mod n". And `03` §10.4 then says `verify` returns false on an "out-of-range scalar", contradicting §7.6 in the same file.
  - REALITY: the reference reduces everywhere on the input path. `FromCanonicalLittleEndianBytesF` is `return GoldilocksField(binary.LittleEndian.Uint64(b))` (`ref-poseidon-crypto/field/goldilocks/goldilocks_plonky2.go:177-179`) — no checks. The Fp5 decoder checks length only (`field/goldilocks_quintic_extension/goldilocks_quintic_extension.go:37-50`). `ScalarElementFromLittleEndianBytes` returns `v mod n` when `v >= n` (`curve/ecgfp5/scalar_field.go:46-60`), and `SigFromBytes` uses it for both halves (`signature/schnorr/schnorr.go:78-89`). The reference's own test pins acceptance of a signature re-encoded as `(s+n)‖(e+n)` (`signature/schnorr/schnorr_test.go:196-202` — executed, it verifies).
  - IMPACT: under the canonical-arithmetic decision, every *computed* value is identical to Go (all arithmetic is congruence-preserving and every output boundary canonicalizes — verified). The **only** place full-reduction changes an observable result is input validation: a strict-by-default TS verifier rejects public keys (`limb + p`), message hashes, private keys (`≥ n`, silently reduced by `NewKeyManager`, `ref-lighter-go/signer/key_manager.go:27-32`), and malleable signatures that the exchange's Go verifier accepts. If dimension 01 ships strict decoders and dimension 03's `verify` consumes them, you get a verifier that is stricter than the sequencer.
  - FIX: one policy, stated once: **internal arithmetic always canonical; encoders always emit canonical; parsers on the sign/verify/key-ingest path check exact length and reduce** (bug-compatible with Go); strict mode is opt-in hygiene for keys you generate or round-trip. Delete "strict by default" from 01 §5.1/§10.3, and fix 03 §10.4's "out-of-range scalar → false" (after the reducing parse there is no out-of-range scalar — `sig.IsCanonical()` at `schnorr.go:189` is dead code on the wire path, as 03 §7.7 itself notes).

  ## MAJOR

  ### 2. The most important formula in the stack lacks a normative reduction rule

  - CLAIM: `03` §7.3 step 6 — "`s = (k − e·sk) mod n`". Nothing normative follows about *how* to reduce in JS. §10.1 warns about truncated `%` for the field `(a - b + P) % P`, but the scalar layer (§5.4) just says "reduce instead of throwing".
  - REALITY: Go computes `k.Sub(e.Mul(sk))` with an explicit conditional add of `n` (`curve/ecgfp5/scalar_field.go:166-213`), and its big-int conversions use `big.Int.Mod` (non-negative). In JS, `k - e*sk` is negative roughly half the time and `(k - e*sk) % n` then yields a **negative** `s`, which `asUintN`/byte serialization turns into garbage.
  - IMPACT: a literal implementation produces invalid signatures despite a perfect field, hash, and curve. This is the single most likely bug to be written.
  - FIX: make it normative next to §7.3: `s = ((k - (e*sk % n)) % n + n) % n`. State that every scalar constructor/subtractor uses Euclidean reduction.

  ### 3. Nonce: `00` and `03` prescribe different defaults, and `00` claims precedence

  - CLAIM: `00-verified-facts.md` — "The TypeScript signer must expose the same seam: caller-supplied nonce for tests, **`crypto.getRandomValues` by default**", plus "where this document disagrees with a dimension spec, this wins". `03` §8 D5/§9 — "Default nonce is **hedged-deterministic**, not pure random".
  - REALITY: the reference samples `k` via `cryptorand.Int(cryptorand.Reader, ORDER)` (`curve/ecgfp5/scalar_field.go:72-78`) — uniform over **[0, n)**, rejection-sampled, no bias (so 03 §7.4's description is accurate, but 03 §7.3 step 1's "`k ∈ [1, n)`" should read `[0, n)`). Verification recomputes `e` from `r_v` and compares (`schnorr.go:187-207`); **it cannot observe how `k` was derived** — so both defaults are genuinely wire-compatible. On your specific questions: the hedged derivation is sound — fixed-length `sk‖msg‖rnd‖label` fields give adequate domain separation, 384-bit → mod-`n` bias is `< 2^-64` as claimed, the `k != 0` retry is correct, and HMAC-SHA-256-with-added-entropy is the standard pattern. I would change only one thing: `rnd = 32 zero bytes if unavailable` silently downgrades; prefer throwing in `'hedged'` mode unless the caller sets an explicit `allowDeterministicOnly` flag, so a stubbed-RNG test helper can't leak into production.
  - IMPACT: two normative documents, two defaults; whichever an implementer picks, the other document says they're wrong. Worse, **no conformance vector can catch a broken hedged implementation** — verify is blind to `k`, so a constant/biased/endian-swapped nonce generator passes every test in §12 while leaking the key on reuse.
  - FIX: pick one default in one place (I'd keep hedged — it strictly dominates the reference's failure mode — but either is wire-safe). Add to the test plan: SHA-256 and HMAC-SHA-256 standard KATs, pinned `(sk, msg, rnd) → k` vectors including the all-zero-entropy case, and a nonce-reuse key-recovery regression test. Delete the precedence sentence from `00` or re-issue `00` with the hedged default.

  ### 4. `fpFromInt` is a loaded gun, and the `−2^63` "overflow" claim is false

  - CLAIM: `01` §4.2/§10.5 — "`NonCannonicalGoldilocksField(x int64)` … TypeScript equivalent: `fpFromInt(x) = ((x % p) + p) % p`, which additionally fixes the reference's overflow at `x = -2^63`" and "Misspelled, and overflows at `x = -2^63` — **FIX**".
  - REALITY: two errors in one sentence. (a) There is no overflow bug: at `x = −2^63`, Go's signed negation wraps (`-x` = `−2^63`) and the `int64→uint64` conversion wraps back (`→ 2^63`); `NegF(2^63) = p − 2^63`, which **is** the correct mapping of `−2^63` — the two wraps cancel (`goldilocks_plonky2.go:22-28`; verified arithmetically). (b) More dangerously: the function is a correct equivalent of `NonCannonicalGoldilocksField`, but that function has **zero call sites in lighter-go** (verified by grep). Every tx encoder uses raw casts (`g.GoldilocksField(txInfo.AccountIndex)`, e.g. `ref-lighter-go/types/txtypes/create_order.go:184`), so the wire mapping of `-1` is `2^64−1 → 2^32−2 = 4294967294` — while `fpFromInt(-1n) = p−1`. These differ. Spec 02 §2.1 has the correct rule (`BigInt.asUintN(64, x) % p`); spec 01 never warns that `fpFromInt` must not be used for protocol integers.
  - IMPACT: an implementer who routes signed tx fields through the field layer's `fpFromInt` (the natural place to look) gets `p−1` instead of `4294967294`, a different Poseidon digest, and rejected transactions. `MinAccountIndex = -1` makes this reachable.
  - FIX: delete the false `−2^63` claim; annotate `fpFromInt`: "equivalent of the reference's (unused, misspelled) helper; **not** the wire encoding of signed protocol integers — that is `fromI64` (02 §2.1), a two's-complement reinterpretation."

  ### 5. Signed value split into 32-bit halves is not covered anywhere

  - CLAIM: `02` §2.1 specifies `fromI64` for signed values but says nothing about values that are split *before* conversion.
  - REALITY: `ref-lighter-go/types/txtypes/update_margin.go:94-95` — `g.GoldilocksField(txInfo.USDCAmount & 0xFFFFFFFF)` then `g.GoldilocksField(txInfo.USDCAmount >> 32)`. Go's `>>` on a negative `int64` is arithmetic, then the cast wraps. Validation (`update_margin.go:62-66`) rejects `==0` and `> MaxTransferAmount` but not negatives, so this path is reachable.
  - IMPACT: `BigInt.asUintN(64, x) >> 32n` gives the wrong high half for negative amounts (`4294967295` instead of the wrap of `-1`); negative margin updates hash differently and are rejected. BigInt's own `&`/`>>` on the *signed* value happen to match Go, but nobody will know that without it being written down.
  - FIX: add to 02 §2.1: "split first on the signed value, then convert each half: `fromI64(x & 0xFFFF_FFFFn)`, `fromI64(x >> 32n)`. Never normalize to unsigned before shifting." Add `-1`, `-2^32` vectors.

  ### 6. The neutral-public-key escape hatch re-opens universal forgery

  - CLAIM: `03` §8 D2 and §10.4 — verify rejects the neutral public key by default, with `{ allowNeutralPublicKey: true }` as an escape hatch.
  - REALITY: the reference performs **no** neutral-PK rejection (`schnorr.go:187-207`), and the forgery is real: with `PK = N`, `[e]PK = N`, so `R_v = [s]G` for any attacker-chosen `s`, and setting `e = H(encode([s]G) ‖ m)` satisfies verification. Executed: the reference accepts a forged signature against the all-zero public key.
  - IMPACT: D2 is a correct and necessary hardening (document it as a deliberate divergence from the reference verifier: TS-verify will reject what the exchange's Go verifier accepts). But shipping `allowNeutralPublicKey` as a public option converts a known universal forgery into one flag.
  - FIX: keep the rejection, remove the public escape hatch; if reference-exact verification is needed for diagnostics, make it an explicitly-unsafe internal/test-only function.

  ## MINOR

  7. **`03` §2.8 — inverted malleability quantification.** "Each coefficient in `[0, p)` has a second byte representation as `coefficient + p` whenever that fits in 64 bits, which it does for all but the top `2^32 − 1` values." Backwards: `c + p ≤ 2^64 − 1` ⟺ `c ≤ 2^32 − 2`, so the alias exists only for the **bottom** `2^32 − 1` coefficients. The "up to 32 byte strings per element" upper bound still holds. (Verified arithmetically.)

  8. **`03` §2.7 — "the negation is a no-op" is wrong.** When both roots have `c0 = 0`, `CanonicalSqrt` still calls `Neg(sqrtX)` (`goldilocks_quintic_extension.go:328-338`), which flips coefficients 1–4. `01` §7.10 states the correct behavior ("returns `neg(sqrt(x))` unconditionally"). Harmless for decode (root-selection is sign-independent) but the prose will produce a wrong `canonicalSqrt` vector.

  9. **`03` §2.5 — "`a` is a square in `Fp5` iff `legendre(a) = 1`"** misses zero: `Legendre(0) = 0` (via `inverseOrZero(0)=0`, lines 398-414) and 0 is a square. `01` §7.8 (`∈ {0,1}`) is correct; fix 03's prose or property tests will fail on `sqrt(0)`.

  10. **`03` §7.4 — "~1-bit bias" quantification is wrong.** For a 320-bit draw reduced mod `n`: `2^320/n = 2.0000000023283`, so only a `2^-31` fraction of residues are over-represented (statistical distance ≈ `2^-31`), not a one-bit entropy loss. The advice (rejection-sample, or draw 64 bytes) is correct; state the real numbers. (§7.4's `< 2^-192` for 64 bytes and §9's `< 2^-64` for 384 bits check out.)

  11. **`01` §3.1 — wrong consumer attribution.** "It is used only by the BN254-Poseidon path…" — the gnark/Montgomery wrapper is the element type of `hash/poseidon2_goldilocks` (used by `ConstructAuthToken`, `ref-lighter-go/types/tx_request.go:165`); `hash/poseidon_bn254` uses `bn254/fr` and never touches it. The advice (ignore Montgomery) is unaffected.

  12. **`02` attribution nits.** `TestLongRunningCompare` compares `HashNToMNoPad(…, 12)`, not `HashToQuinticExtension` (`hash/poseidon2_test.go:20-88`); `TestConstantsAreInTheField` covers the 118 round constants but **not** the 12 diagonal values (`poseidon2_test.go:297-313`) — the diagonal is canonical, but the digest gate is the real guarantee. Also `02` §2.2's "strict mode … needed by public-key / signature parsing" mischaracterizes the reference, whose Fp5 parsing is lenient everywhere (see finding 1).

  13. **`03` §12.1 version statement.** The local checkout is `poseidon_crypto v0.0.18` while the oracle pins `v0.0.15` via the module proxy (`gochk/go.mod` requires v0.0.15 but `replace`s to the local checkout — so "pins v0.0.15" is not what actually runs there). Behavior was verified byte-identical across both versions, so this is bookkeeping, but restate the pin accurately.

  14. **`03` §7.3 vs §7.4 bracket:** step 1 says `k ∈ [1, n)`, §7.4 correctly says `[0, n)`. Align.

  ## Verified-correct sections (one line each)

  - `01` §2, §4, §7, §8, §9: prime, reduction identities, mul/square/inv/Legendre/sqrt/sgn0/Frobenius formulas and **every §13 golden** — reproduced numerically or against Go line-by-line; the `POWER_OF_TWO_GENERATOR` note (`= (7^((p-1)/2^32))^4168946053`) is exactly right.
  - `01` §3/§10 non-canonical analysis, and `00`'s `ORDER+4` generator claim — **true**: `SchnorrPkFromSk(ONE)` returns raw limbs `[18446744069414584325, 0,0,0,0]` (executed; the direct `GENERATOR.Encode()` returns raw `4`, which is what makes the example a perfect illustration of the trap).
  - `02` wholesale: parameters, round schedule (incl. the fused/unfused version note), `M4 = circ(2,3,1,1)`, `M_I = J + diag(D)`, all 130 constants (digest recomputed and matching), overwrite/no-pad sponge, empty-input and squeeze behavior, `fromI64` rule, KAT vectors (re-executed against the reference — all match).
  - `03` §3–§7: curve equation/constants, shifted group law, complete add/double formulas, encode/decode incl. the six decode-failure test values, `n` and its limbs, recoding, `s = k − e·sk`, preimage order `r‖m` (10 elements), `fromFp5` with the load-bearing canonicalize (`scalar_field.go:260`), 80-byte `s‖e` format, dead canonicality check, no subgroup/neutral/`R≠identity` checks — all confirmed, much of it by execution.

  ## Omissions an implementer will otherwise rediscover by debugging

  - `HashOut.ToUint64Array` returns **raw** limbs (`poseidon2.go:57-59`) — if any vector is ever generated through it, it carries non-canonical values that a canonical TS fails against. (Unused by the SDK; gfp5's `ToUint64Array` does canonicalize.)
  - `HashNoPad(m)`'s 4 outputs equal the first 4 limbs of `HashToQuinticExtension(m)` — free cross-check, stated nowhere.
  - The challenge preimage limbs (`r`, `m`) are fed to Poseidon2 possibly non-canonical and it doesn't matter — say so next to `03` §7.3 step 4 or someone will "fix" a non-bug.
  - The reference's `MakeWindowAffine` builds `win[i] = [i+1]P` via an odd/even add-double pattern, not sequential additions (`point.go:527-538`) — same result, but don't diff intermediate points against a sequential builder.
  - `Signed161`/`RecodeSigned5` (spec 01 §9.2) is **dead code on the sign/verify path** — the curve uses only the 64-digit `RecodeSigned`. Mark it optional so nobody blocks signing on it.

  ## The single most likely thing to go wrong

  **A negative `s` from `(k − e·sk) % n` in JS.** Everything else — field, Poseidon2, curve — can pass every vector while this one line silently produces a negative scalar that serializes to garbage, and it only fires on ~50% of signatures, so it looks intermittent. Catch it in the first hour: before any window/curve optimization, implement scalar `mul/sub` plus the flat signing formula and replay the three explicit-`k` vectors in `03` §12.2 — they have `e·sk > k` cases and fail loudly if `s` went negative. Assert `s ∈ [0, n)` at the serialization boundary so the bug can never ship silently. The runner-up, which the vectors *won't* catch, is the signed-integer mapping on the tx-codec path (findings 4–5): gate it with the `H([fromI64(-1)])` vector from `02` §11.2 before any end-to-end test.

