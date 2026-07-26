1. SEVERITY: critical

CLAIM: [03 §7.3](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:660) specifies:

> `s = (k − e·sk) mod n`

but never normatively defines signed scalar reduction for JavaScript.

REALITY: The reference explicitly compensates for underflow by adding `n` in `Sub`:

> `r0, c := s.SubInner(rhs)`  
> `r1 := r0.AddInner(N)`  
> `return Select(c, r0, r1)`

([scalar_field.go:179](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/scalar_field.go:179)). Its general converter likewise uses `big.Int.Mod`, which returns a non-negative residue ([scalar_field.go:267](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/scalar_field.go:267)). JavaScript’s `%` does not: `(-1n) % n === -1n`.

IMPACT: A literal implementation of `(k - e * sk) % N` is negative for a large fraction of signatures. Serializing that through shifts or `asUintN(320)` produces a different, generally invalid scalar. This breaks signing even when every field and curve operation is correct.

FIX: Make this normative:

```ts
const modN = (x: bigint) => {
  const r = x % N;
  return r < 0n ? r + N : r;
};

s = modN(k - modN(e * sk));
```

Use `modN` in every scalar constructor, subtraction, explicit nonce parser, and private-key reduction.

2. SEVERITY: major

CLAIM: [02 §2.1](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/02-crypto-poseidon2.md:70) says all signed transaction values should go through:

> `fromI64(x) ≡ BigInt.asUintN(64, x) % p`

It does not specify what happens when a signed value is split into 32-bit pieces.

REALITY: `UpdateMargin` splits a signed `int64` before conversion:

> `GoldilocksField(txInfo.USDCAmount & 0xFFFFFFFF)`  
> `GoldilocksField(txInfo.USDCAmount >> 32)`

([update_margin.go:95](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-lighter-go/types/txtypes/update_margin.go:95)). Go’s right shift of negative `int64` is arithmetic. For `USDCAmount = -1`:

- low field element = `4294967295`
- high expression remains `-1`
- high field element canonicalizes to `4294967294`

If TypeScript first applies `BigInt.asUintN(64, -1n)` and then shifts, the high half becomes `4294967295`, which is wrong.

Negative amounts are accepted: validation rejects zero and overly large positive values, but not negative ones ([update_margin.go:63](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-lighter-go/types/txtypes/update_margin.go:63)).

IMPACT: Negative margin-update transactions hash differently and are rejected.

FIX:

```ts
const lo = fromI64(x & 0xffff_ffffn);
const hi = fromI64(x >> 32n); // arithmetic shift while still signed
```

Do not unsigned-normalize `x` before the shift. Add vectors for `-1`, `-2^32`, and a realistic negative margin amount.

3. SEVERITY: major

CLAIM: The decoder policy contradicts itself:

- [01 §5.1](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/01-crypto-field.md:381): “decoders are strict by default.”
- [03 §2.8](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:172): reduce by default, `strict: false`.
- [03 public API](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:980): an “out-of-range scalar” makes `verify` return false.
- Yet [03 §7.6](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:721) says signature components are reduced.

REALITY:

- `Fp5.FromCanonicalLittleEndianBytes` checks length only, then loads all five raw limbs without checking `< p` ([goldilocks_quintic_extension.go:37](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/field/goldilocks_quintic_extension/goldilocks_quintic_extension.go:37)).
- `ScalarElementFromLittleEndianBytes` reduces `v mod n` ([scalar_field.go:46](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/scalar_field.go:46)).
- `SigFromBytes` uses that reducing parser for both halves ([schnorr.go:78](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr.go:78)).
- The reference test explicitly verifies `(s+n, e+n)` ([schnorr_test.go:196](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr_test.go:196)).

IMPACT: Eager canonical arithmetic is wire-identical, but strict parsing is not. Depending on which document is followed, TypeScript will either accept or reject non-canonical public-key, message-hash, private-key, and signature bytes that Go accepts.

FIX: Separate the two decisions explicitly:

- Internal arithmetic: always canonical.
- Compatibility parsers used by `sign`/`verify`: exact length, reduce limbs/scalars.
- Strict parsers: explicit opt-in and reject non-canonical bytes.
- Encoders: always canonical.

Do not claim canonical arithmetic makes strict parsing “observationally identical.”

4. SEVERITY: major

CLAIM: [00 §Signature nonce](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/00-verified-facts.md:48) mandates:

> `crypto.getRandomValues` by default.

But [03 §8–9](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:784) mandates hedged-deterministic by default. `00` says it wins on disagreement.

REALITY: The reference samples directly with `crypto/rand.Int(..., ORDER)`, including zero ([scalar_field.go:72](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/scalar_field.go:72), [schnorr.go:96](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr.go:96)). Verification only reconstructs `R` and the challenge; it cannot observe nonce provenance ([schnorr.go:187](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr.go:187)).

IMPACT: Both defaults are wire-compatible, but the normative API, reproducibility, failure behavior without a CSPRNG, and security guarantees are unresolved.

FIX: Choose one and update every document. I would choose hedged-deterministic as default, retain `'random'`, reject `k=0`, and retain explicit `k` for vectors. The proposed fixed-width seed and label are adequately domain-separated and wire-compatible.

5. SEVERITY: major

CLAIM: [03 §9](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:804) introduces a new hand-written SHA-256, HMAC, and HMAC-DRBG-style nonce construction. The test plan merely checks that signatures verify and that zero-entropy calls repeat ([03 §12.5](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:1145)).

REALITY: The reference has no deterministic derivation to act as an oracle; it samples `k` randomly ([schnorr.go:96](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr.go:96)). Signature verification cannot detect a nonce generator that is constant, biased, endian-swapped, or accidentally independent of the message.

IMPACT: A broken nonce derivation can pass every proposed Schnorr conformance test while leaking the private key after nonce reuse.

FIX: Add:

- SHA-256 and HMAC-SHA-256 standard KATs.
- Normative `sk,msg,rnd → k` vectors, including all-zero entropy.
- Same key/different message and different key/same message vectors.
- An assertion that `k ∈ [1,n)`.
- A nonce-reuse regression test demonstrating key recovery so the risk is visible.

6. SEVERITY: major

CLAIM: [03 D2 and public API](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:789) rejects the neutral public key by default but exposes:

> `{ allowNeutralPublicKey: true }`

REALITY: `Decode(0)` deliberately succeeds and returns the neutral ([point.go:190](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/point.go:190)); verification performs no neutral-key rejection ([schnorr.go:193](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/signature/schnorr/schnorr.go:193)).

IMPACT: For the neutral public key, anyone can forge: choose `s`, compute `R=[s]G`, and set `e=H(encode(R)‖m)`. The escape hatch converts a known universal forgery into a public option.

FIX: Remove `allowNeutralPublicKey`. If exact-reference verification is needed for diagnostics, put it in an explicitly unsafe internal/test-only function.

7. SEVERITY: minor

CLAIM: [03 §2.7](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:143) says that when root coefficient zero is zero:

> “the negation is a no-op.”

REALITY: `CanonicalSqrt` calls `Neg(sqrtX)` whenever `Sgn0` is true ([goldilocks_quintic_extension.go:328](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/field/goldilocks_quintic_extension/goldilocks_quintic_extension.go:328)). Negation changes coefficients 1–4 even when coefficient 0 is zero. The field spec states the correct behavior at [01 §7.10](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/01-crypto-field.md:612).

IMPACT: An implementer following the prose can return the wrong `canonicalSqrt` vector. Point decoding remains unaffected because its root-selection logic is sign-independent.

FIX: Replace “negation is a no-op” with “the entire root is still negated; only coefficient 0 remains unchanged.”

8. SEVERITY: minor

CLAIM: [00 lines 40–41](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/00-verified-facts.md:40) says:

> “the reference encodes the curve generator as `[ORDER + 4, 0, …]`.”

REALITY: The generator has `u=1`, `t=4` ([point.go:58](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/point.go:58)), and `Encode` computes `t * inverseOrZero(u)` ([point.go:146](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/point.go:146)). That raw computation is `4`, agreeing with `curve.json`, not `ORDER+4`.

The broader “everything observable is canonicalized” claim is also too broad: `HashOut.ToUint64Array` returns raw limbs without canonicalization ([poseidon2.go:57](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/hash/poseidon2_goldilocks_plonky2/poseidon2.go:57)).

IMPACT: The canonical implementation decision remains correct for protocol bytes, hashing, equality, point encoding, and verification, but its stated proof is false.

FIX: Say eager reduction is identical at all protocol-relevant boundaries. Do not claim every public Go accessor is observationally identical, and delete the generator example.

9. SEVERITY: minor

CLAIM: [03 §7.4](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:692) says reducing a 40-byte draw has:

> “a ~1-bit bias … exactly the shape of bias that lattice attacks eat.”

REALITY: For this particular modulus, `2^320/n = 2.000000002328…`. Exact total-variation distance after 320-bit modulo reduction is about `2^-29.68`, not a one-bit loss of nonce entropy. For the proposed sizes:

- 384-bit reduction: approximately `2^-93.68`
- 512-bit reduction: approximately `2^-196.62`

The reference avoids bias entirely with `rand.Int(..., ORDER)` ([scalar_field.go:72](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/curve/ecgfp5/scalar_field.go:72)).

IMPACT: The recommendation to use rejection sampling or wider reduction is sound, but the stated threat analysis is inaccurate.

FIX: Give the actual statistical distances. Prefer rejection sampling if exact uniformity matters; the proposed 384-bit hedged reduction is already comfortably negligible.

10. SEVERITY: minor

CLAIM: [03 §2.5](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/spec/03-crypto-curve-schnorr.md:115) says:

> “`a` is a square in `Fp5` iff `legendre(a) = 1`.”

REALITY: The reference returns zero for zero through `inverseOrZero(0)` ([goldilocks_quintic_extension.go:398](/private/tmp/claude-501/-Users-joeblau-Developer-lev7-src-lighter-ts/c9b263cb-e094-48b1-b3e4-533612c0833b/scratchpad/ref-poseidon-crypto/field/goldilocks_quintic_extension/goldilocks_quintic_extension.go:398)), and zero is a square.

IMPACT: Mostly a property-test/specification error; `sqrt(0)` is otherwise handled correctly.

FIX: “A non-zero element is a square iff Legendre is `1`; zero is also a square and has Legendre `0`.”

Correct sections, without padding:

- Goldilocks modulus, reductions, multiplication, inversion chain, and Tonelli–Shanks algorithm: correct.
- `Fp5 = Fp[X]/(X^5−3)`, multiplication/squaring, Frobenius, norm inversion, and sqrt algorithm: correct apart from the listed zero/sign prose.
- Poseidon2 constants, matrices, round schedule, overwrite sponge, empty input, and squeeze behavior: correct.
- Curve equation/constants, shifted group law, complete addition/doubling formulas, encoding/decoding, group order, scalar modulus, recoding, and Schnorr equation/preimage order: correct.

The single most likely implementation failure is negative scalar `%` in `s = k − e·sk`. Catch it before implementing the curve by asserting `modN(-1n) === N-1n`, then replay the three explicit-`k` Schnorr vectors. If `s` is ever negative before serialization, fail immediately.
