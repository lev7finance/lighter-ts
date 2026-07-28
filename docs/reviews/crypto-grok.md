I'll adversarially review the crypto specs against the Go and Poseidon reference sources, starting with the verified facts and then cross-checking each load-bearing claim.Continuing the curve/Schnorr spec and pulling the corresponding reference implementations for cross-check.Digging into the load-bearing reference sources for algebra, Schnorr, and any mismatches with the specs.Checking one more conflict: whether `div` and `inverse` interact with decode, and verifying the `fpFromInt`/`fromI64` contradiction is as sharp as it looks.# Adversarial review: crypto specs vs reference

Cross-checked against `ref-poseidon-crypto` and `ref-lighter-go` by reading source and running the reference (casts, Poseidon KATs, Schnorr vector 0, malleability). Correct sections are one-liners at the end.

---

## CRITICAL

### 1. Spec 01 teaches the wrong signed-integer → field map for transaction hashing

- **SEVERITY:** critical  
- **CLAIM:** (`01-crypto-field.md` §4.2, §10.5)

  > `NonCannonicalGoldilocksField(x int64)` … maps a signed 64-bit integer into the field as `x < 0 ? neg(-x) : x`. TypeScript equivalent: `fpFromInt(x)` = `((x % p) + p) % p`

  and that this “fixes” the reference.

- **REALITY:** Every `Hash()` path in `ref-lighter-go/types/txtypes/*.go` does a **raw cast**, not `NonCannonicalGoldilocksField` (which has **zero call sites** in lighter-go):

```184:184:ref-lighter-go/types/txtypes/create_order.go
	elems = append(elems, g.GoldilocksField(txInfo.AccountIndex))
```

  For `var x int64 = -1`, Go’s `GoldilocksField(x)` is `uint64(x) = 2^64−1` → canonical **`2^32−2 = 4294967294`**.  
  `NonCannonicalGoldilocksField(-1)` / Euclidean `((-1)%p+p)%p` → **`p−1`**. Measured: **not equal for any negative I tried**.

  Spec 02 §2.1 **does** state the correct rule (`BigInt.asUintN(64, x) % p`). Spec 01 contradicts it.

- **IMPACT:** `MinAccountIndex = -1` is a real, validated value (`constants.go`). Any tx hash that routes `AccountIndex` (or any other signed field) through Spec 01’s `fpFromInt` produces a **different Poseidon digest** → signatures the sequencer rejects. Same footgun for any negative `int64` that reaches `GoldilocksField(...)`.

- **FIX:** Normative map for **all protocol integers** is:

  ```
  fromI64(x) = BigInt.asUintN(64, x) % p   // two’s-complement bit pattern, then reduce
  ```

  Delete or quarantine the Euclidean `fpFromInt` wording for wire values. Document that `NonCannonicalGoldilocksField` is unused dead code and **must not** be the model for tx encoding.

---

### 2. Spec 00 vs Spec 03 disagree on default Schnorr nonce (and Spec 00 is wrong about `encode(G)`)

- **SEVERITY:** critical (process / product contract)  
- **CLAIM A:** (`00-verified-facts.md` — “wins on disagreement”)

  > The TypeScript signer must expose … `crypto.getRandomValues` **by default**.

- **CLAIM B:** (`03-crypto-curve-schnorr.md` §8 D5, §9)

  > Default nonce is **hedged-deterministic**, not pure random.

- **REALITY:** Production Go uses pure CSPRNG:

```96:98:ref-poseidon-crypto/signature/schnorr/schnorr.go
func SchnorrSignHashedMessage(hashedMsg gFp5.Element, sk curve.ECgFp5Scalar) Signature {
	// Sample random scalar `k` and compute `r = k * G`
	k := curve.SampleScalar()
```

  `SampleScalar` = `crypto/rand.Int(..., ORDER)` over **`[0, n)`**.

  Also **false** in the same 00 section:

  > the reference encodes the curve generator as `[18446744069414584325, 0, 0, 0, 0]` (`ORDER+4`)

  Measured: `GENERATOR.Encode()` and `sk=1` pubkey are **`[4,0,0,0,0]`**, bytes `04` then zeros. Non-canonical `ORDER` limbs appear in **`GeneratorWindowAffine[0].u`** (raw `p` as zero), not as `encode(G)`.

- **IMPACT:**  
  - Implementers following 00 vs 03 ship different defaults.  
  - Hedged mode is still **wire-compatible** (verify never sees `k`) — that part of 03 is right.  
  - The `ORDER+4` “proof” mis-trains people about where non-canonicity shows up (window tables / lazy `uint64`s, not the public generator encoding).

- **FIX:** Resolve deliberately in one place. Recommendation: **default `'random'`** (match Go + 00 + smaller crypto surface); keep **`'hedged'` opt-in** and **explicit `bigint` k** for vectors. Correct the generator fact to: wire/`Encode(G) = 4` (canonical); lazy non-canonicity is elsewhere (e.g. window `u` limbs = `p`).

---

## MAJOR

### 3. Spec 01 vs Spec 02: “hand-rolled Goldilocks reduce” performance claim is inverted

- **SEVERITY:** major  
- **CLAIM:** (`01` §4.3) “Do not replace the fixups with `%` — BigInt division is ~4–8× the cost”  
- **REALITY / COUNTER-CLAIM:** (`02` §7.5) measured on the target engines: naive `% p` **faster** than hi/lo Goldilocks reduce (~31k vs ~14k perm/s Node).  
- **IMPACT:** Wave-1 implementers burn time (and risk off-by-one fixup bugs) on a reduction path Spec 02 already measured as a regression.  
- **FIX:** For pure BigInt TS, **normative reduce is `(x % p + p) % p` for signed, `x % p` for non-negative**. Treat `reduce128`/`reduceWide` as optional, with Spec 02’s numbers as the default performance guidance.

---

### 4. Strict vs reducing byte decoders: Spec 01 and Spec 03 conflict; Go accepts non-canonical PK / msg / sig limbs

- **SEVERITY:** major  
- **CLAIM:** (`01` §5.1) decoders **strict by default** (`value >= p` throws).  
  (`03` §2.8) Fp5 loader default **`strict: false`** (reduce).  
- **REALITY:**

```37:49:ref-poseidon-crypto/field/goldilocks_quintic_extension/goldilocks_quintic_extension.go
func FromCanonicalLittleEndianBytes(in []byte) (Element, error) {
	if len(in) != Bytes {
		return FP5_ZERO, errors.New("invalid input length. Expected 40 bytes")
	}
	// ... FromCanonicalLittleEndianBytesF per limb — no range check
```

```46:59:ref-poseidon-crypto/curve/ecgfp5/scalar_field.go
func ScalarElementFromLittleEndianBytes(data []byte) ECgFp5Scalar {
	// ...
	if bigValue.Cmp(ORDER) < 0 {
		return value
	}
	return FromNonCanonicalBigInt(bigValue) // reduces mod n
}
```

  Measured: signature with **`s+n` / `e+n`** still **Validate**s. PK limb `+p` when it fits in u64 is accepted the same way.

- **IMPACT:** Strict-by-default **verify** rejects inputs the exchange accepts (hostile or sloppy encodings). Reducing-by-default with no `strict` for **hex key compare** can make two equal keys look different if someone stores non-canonical hex.  
- **FIX:** Single policy: **parse/reduce like Go for verify & sign inputs; always emit canonical; optional `strict` for local key hygiene.** Spec 01’s “strict default” must not apply to `Validate`-equivalent paths.

---

### 5. Canonical-only arithmetic is fine for honest outputs — but Spec 03 understates one place raw limbs feed the hash

- **SEVERITY:** major (if someone “optimizes” challenge construction)  
- **CLAIM:** (`03` §2.9 / `00`) eager reduction “cannot change a single observable bit”; only serialization/equality care.  
- **REALITY:** Challenge is:

```102:119:ref-poseidon-crypto/signature/schnorr/schnorr.go
	copy(preImage[:5], r[:])
	copy(preImage[5:], hashedMsg[:])
	e := curve.FromGfp5(p2.HashToQuinticExtension(preImage))
```

  `r` is the raw `Encode()` element (lazy `uint64` limbs). Poseidon is congruence-preserving, and `FromGfp5` **canonicalizes** limbs — so **eager TS still matches**.  

- **IMPACT:** If an implementer copies **non-canonical limb arrays into a test oracle** or compares preimage bytes without reducing, vectors diverge. Not a wire break if everything reduces before hash/compare.  
- **FIX:** State explicitly: **challenge preimage is five+five field elements modulo p; always reduce before absorb.** Do not hash raw 40-byte strings without the Fp5 parse rule.

---

### 6. Hedged-nonce construction: wire-OK, but defaulting it adds a second crypto stack and a mild design flaw surface

- **SEVERITY:** major (design), not a wire break  
- **CLAIM:** (`03` §9) hedged HMAC-SHA-256 default is sound and wire-compatible.  
- **REALITY:** Wire-compat: **yes** — `IsSchnorrSignatureValid` only checks `e_v == e` after `MulAddG`.  
  Soundness: RFC-6979-shaped init with fixed-length `sk||msg||rnd||label` is fine; 384-bit `mod n` bias ≲ 2^−65; reject `k==0` is correct.  
  Flaws / costs:  
  - Extra **sync SHA-256 + HMAC** to implement and audit (~2.5KB, new bug class).  
  - `rnd = 0` if CSPRNG missing → **fully deterministic** from `(sk,m)` (stated, but easy to mis-handle in Workers if someone stubs RNG to zeros in tests and ships it).  
  - Label at end is OK only because all parts are fixed length — must not become variable-length without length prefixes.  
- **IMPACT:** Wrong HMAC/byte order/`mod n` yields valid-looking but non-reproducible signatures in tests; security depends on correct hedged code rather than OS CSPRNG alone.  
- **FIX:** Keep hedged as **opt-in**. If kept as default: pin KATs for “rnd=0” and “rnd fixed” and test `k≠0` loop; document big-endian `T` and 48-byte length as normative.

---

### 7. BigInt / scalar hazards the specs under-emphasize

- **SEVERITY:** major  
- **CLAIM:** (`03` §5.5 / §10.1) scalar is one `bigint` in `[0,n)`; recode 64 digits.  
- **REALITY:** Recoding only consumes **320 bits**. Unreduced `a*b` (forgetting `% n`) with `bitLength > 320` silently uses the low 320 bits ≠ value mod n. Go panics on non-canonical Montgomery inputs; TS “reduce instead of panic” can **hide** this.  
  Also: JS `%` is remainder: `(-1n) % n === -1n` (Spec 02 notes this; Spec 03 §10.1 too) — one missed fixup in `sub`/`neg` breaks every signature.  
  `SampleScalar` allows **`k = 0`**; Spec’s random path rejects 0 — fine, but not identical.  
- **IMPACT:** Unreduced scalar → wrong `R`/`s` with hard-to-localize failures. Negative `%` → wrong field/scalar forever.  
- **FIX:** Hard assert `0 ≤ s < n` (and same for `e`,`k`) at **scalarmul and sign** boundaries; use `((x % n) + n) % n` anywhere subtraction exists; document `k=0` rejection as intentional.

---

## MINOR

### 8. Spec 01 presents Signed161 / 33-digit recode as required for scalar mul; Schnorr never uses it

- **SEVERITY:** minor  
- **CLAIM:** (`01` §1 table, §9.2) windowed scalar mul needs Signed161.  
- **REALITY:** `ECgFp5Point.Mul` / `MulAddG` use `RecodeSigned` on full 5-limb scalars, **64 digits**, width 5 (`point.go`). Signed161 is for a half-size / GLV-style path that is **not** on the sign/verify path.  
- **IMPACT:** Wasted implementation or wrong digit count (33 vs 64).  
- **FIX:** Mark Signed161 optional / unused for Lighter signing; only §03 §5.5 is normative for Schnorr.

---

### 9. Spec 03 §2.6 says “any sqrt”; reference `Decode` uses `CanonicalSqrt`

- **SEVERITY:** minor  
- **CLAIM:** any root; sign irrelevant.  
- **REALITY:** `Decode` calls `gFp5.CanonicalSqrt(delta)` (`point.go:173`). Algebraically the Legendre branch still yields the same non-square `x`, so final points match.  
- **IMPACT:** Intermediate `x1`/`x2` tests against Go may fail if you use a different root before the Legendre select.  
- **FIX:** Say “final point independent of root sign; match Go tests only after selection (or call the same CanonicalSqrt).”

---

### 10. Go comment / Spec echo: `IsCanonical` after `SigFromBytes` is dead

- **SEVERITY:** minor  
- **CLAIM:** (`03` §7.7) canonicality check is effectively dead after reducing parse — **correct**.  
- **REALITY:** Comment on `SigFromBytes` claims it “will check” canonicity; it **reduces**. Spec already says this.  
- **IMPACT:** None if you trust the spec’s later note; confusion if you only read the Go comment.  
- **FIX:** No code change; don’t invent a strict-reject path thinking Go has one.

---

### 11. `Lookup` is not constant-time (Spec notes this; still a footgun)

- **SEVERITY:** minor (security hygiene)  
- **REALITY:** `affine_point.go` `Lookup` has `if c != 0` and `if c != 0` for negation — variable-time. Spec 03 §6.3/§10.2 is accurate.  
- **FIX:** Don’t claim CT; branchless scan if you care about coarse timing.

---

## Sections that checked out (no padding)

| Area | Verdict |
| --- | --- |
| `p`, `ε`, `2^96≡−1`, `2^128≡−2^32`, two-adicity 32, `POWER_OF_TWO_GENERATOR` | Correct |
| `Fp5 = Fp[X]/(X^5−3)`, mul/square fold formulas, `FP5_DTH_ROOT` | Correct (recomputed) |
| Frobenius tables FROB1–4 | Match ζ powers |
| Norm / inv / Legendre structure | Match reference |
| Sgn0 ≡ “c0 even” collapse | Correct |
| Curve `a=2`, `b=263·X`, group law `⊕ = + + N`, `encode = T/U`, decode quadratic + non-square root | Correct |
| Order `n`, LE limbs, `N0I`, SampleScalar / FromGfp5 | Correct |
| Addition / doubling formulas vs `point.go` | Match |
| Poseidon2 width 12, R_F=8, R_P=22, M4 circ(2,3,1,1), overwrite sponge, empty→0 | Correct; zero-state permute KAT matches |
| Round constants (spot-checked row0 / diag / internal) | Match `config.go` |
| Schnorr: `s = k − e·sk`, preimage `r‖m` (10 limbs), sig `s‖e` 80 bytes, no e-truncation | Correct; comparative vector 0 reproduces |
| Cofactor 1 / no subgroup check | Correct |
| Auth token uses **gnark** Poseidon package + strict LE packing (`tx_request.go`) while txs use **plonky2** | Spec 02 §1 is right that functions match; still implement **one** TS Poseidon |

---

## Omissions an implementer will rediscover the hard way

1. **Signed casts are two’s-complement, not modular** — Spec 02 has it; Spec 01 will poison you (Finding 1).  
2. **Challenge preimage order and arity** — exactly 10 Goldilocks limbs, `r` then `m`, c0..c4 each; two absorb blocks with **no padding** (lanes 2..7 keep first-block state).  
3. **`hash.Hash` argument to `Sign` is unused** — do not “fix” by hashing again.  
4. **Chain ID is not on the wire crypto docs but is in every tx hash** (mainnet **304**) — out of scope here but kills e2e.  
5. **`ExpiredAt` must be pinned** for vectors (`now+…` in Go makes non-reproducible hashes).  
6. **Generator window raw dump has non-canonical zeros (`p`)** — canonicalize if you ever hardcode tables.  
7. **Neutral public key is forgeable** — Spec D2 is real and should stay.  
8. **Oracle gaps Spec 03 already lists** (decodeFailures, mulAdd, recode digits) — still missing; implement without them and you only fail at full sign.  
9. **Do not port fused Permute layout from ≥v0.0.16 by eye** — use Spec 02 unfused form **or** the fused form, not a mix; EC[4] is folded into the last partial in fused code.

---

## Single most likely implementation failure — and how to catch it early

**Most likely:** wrong **integer → Goldilocks** mapping on the tx path (Euclidean / `Number` / plain `%` on negatives / Spec 01 `fpFromInt`), producing a perfect curve implementation that still fails every live `create_order` hash.

**Catch early:**

1. Before any curve code: pin Spec 02 §2.1 / §11.2 vectors, especially  
   `fromI64(-1) → H = [14065920794586377789, …]` (measured match in reference).  
2. Assert `encode(G) === [4,0,0,0,0]` and Schnorr comparative vector 0 (`03` §12.2) with **explicit `k`**.  
3. One e2e: fixed chainId/account/nonce/ExpiredAt → `Hash()` 40 bytes must equal Go oracle **before** signing.  
4. Gate: `((-1n % P) + P) % P === P-1n` is the **wrong** map for protocol ints; `BigInt.asUintN(64, -1n) % P === 4294967294n` is the right smoke test — put it in CI so Spec 01 cannot regress the stack.
