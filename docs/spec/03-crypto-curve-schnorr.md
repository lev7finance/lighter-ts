# 03 — ECgFp5 elliptic curve + Schnorr signature scheme

**Status:** functional specification for a clean-room TypeScript implementation.
**Scope:** everything from `GF(p^5)` up to `sign`/`verify` and the `KeyManager`-equivalent public API.
**Out of scope (owned by other dimensions):** the Poseidon2 permutation itself (dimension 02),
transaction field ordering and `Hash()` preimages (dimension 04).

Every numeric claim in this document was verified independently — by re-deriving the value with an
ad-hoc `GF(p^5)` model in Python and by cross-checking against the committed conformance vectors in
`/Users/joeblau/Developer/lev7/src/lighter-ts/conformance/vectors/`. Where a claim is *unverified*
it says so explicitly.

---

## 0. Why this layer exists, and the one non-negotiable constraint

Lighter authenticates every L2 transaction with a Schnorr signature over a curve defined on the
quintic extension of the Goldilocks field ("ECgFp5", from Thomas Pornin's `ecgfp5` construction).
The chain is a zk-rollup; the curve is chosen so that signature *verification* is cheap inside a
plonky2 circuit, not so that signing is cheap on a client.

The Python SDK does not implement any of this. It ships a compiled Go `.so` and calls it through
`ctypes`. That is the thing we are replacing. **Everything in this document must be pure
TypeScript**: no WASM, no native module, no `node:crypto`. It must run on Bun, Node 20+, Deno,
Cloudflare Workers, and browsers, from the same ESM build.

The entire signing path is synchronous and deterministic given `(sk, hashedMessage, k)`. There is
no reason for any of it to touch `crypto.subtle` (which is async-only on the web platform). Keeping
`sign()` synchronous is a deliberate design goal — see §9.

---

## 1. Notation

| Symbol | Meaning |
| --- | --- |
| `p` | Goldilocks prime, `2^64 − 2^32 + 1` = `18446744069414584321` = `0xFFFFFFFF00000001` |
| `Fp` | `GF(p)` |
| `Fp5` | `GF(p^5)`, represented as `Fp[X]/(X^5 − 3)` |
| `X` | the root of `X^5 − 3` in `Fp5`; the basis is `{1, X, X², X³, X⁴}` |
| `E` | the curve, see §3 |
| `N` | the point `(0, 0)` on `E`; the neutral element of the group we use |
| `G` | the group of order `n` used by the protocol (§3.3) |
| `n` | the prime order of `G`, `≈ 2^319` (§5.1) |
| `⊕` | the group law of `G` (§3.3) — **not** ordinary curve addition |
| `[k]P` | `k`-fold `⊕` of `P` |
| `w` | the canonical `Fp5` encoding of a group element (§4.1) |
| `LE64(v)` | 8-byte little-endian encoding of a `uint64` |

A "limb array" `[c0, c1, c2, c3, c4]` always means `Σ cᵢ·Xⁱ` for `Fp5` elements, and
`Σ cᵢ·2^(64i)` for scalars. This distinction matters and is a classic source of bugs: the same
5×u64 shape means two completely different things depending on which type it is.

---

## 2. Layer 1 — `GF(p^5)`

### 2.1 Field construction

`Fp5 = Fp[X]/(X^5 − 3)`. Verified: `3^((p−1)/5) mod p ≠ 1`, so `3` is not a fifth power in `Fp`
and `X^5 − 3` is irreducible.

An element is five `Fp` coefficients. Serialized width is **40 bytes** (`5 × 8`). This is the
origin of both `PubKeyLength = 40` and `HashLength = 40` (§6.6).

### 2.2 Arithmetic

Addition, subtraction and negation are coefficient-wise in `Fp`.

Multiplication `c = a·b` folds `X^5 → 3`:

```
c0 = a0b0 + 3(a1b4 + a2b3 + a3b2 + a4b1)
c1 = a0b1 + a1b0 + 3(a2b4 + a3b3 + a4b2)
c2 = a0b2 + a1b1 + a2b0 + 3(a3b4 + a4b3)
c3 = a0b3 + a1b2 + a2b1 + a3b0 + 3(a4b4)
c4 = a0b4 + a1b3 + a2b2 + a3b1 + a4b0
```

Squaring is the same with the cross terms collected (`c0 = a0² + 6a1a4 + 6a2a3`, etc.). Under
`BigInt` the doubling/tripling micro-optimizations of the Go reference are pointless — implement
`square(a) = mul(a, a)` first and only specialize if a benchmark demands it.

`double(a) = a + a`, `triple(a) = 3·a`, `scalarMul(a, s) = ` coefficient-wise `Fp` multiply by a
base-field scalar `s`.

### 2.3 Frobenius

`Frob(a) = a^p`. Since `X^p = X·(X^5)^((p−1)/5) = z·X` with

```
z = 3^((p−1)/5) mod p = 1041288259238279555     (verified)
```

the map is: **multiply coefficient `i` by `z^i`**. `RepeatedFrobenius(a, c)` (i.e. `a^(p^c)`)
multiplies coefficient `i` by `(z^c)^i`. `c ≥ 5` reduces mod 5 (`Frob^5 = id`).

Precompute the four vectors `[1, z^c, z^(2c), z^(3c), z^(4c)]` for `c ∈ {1,2,3,4}` as constants.

### 2.4 Inverse

Uses the norm map. Let `d = Frob(a)`, `e = d·Frob(d)`, `f = e·Frob²(e)`. Then
`f = a^(p + p² + p³ + p⁴)` and `a·f = Norm(a) ∈ Fp`. Only the constant coefficient of `a·f` needs
computing:

```
Norm(a) = a0·f0 + 3(a1·f4 + a2·f3 + a3·f2 + a4·f1)
```

Then `a⁻¹ = f · Norm(a)⁻¹` (base-field scalar multiply). `inverseOrZero(0) = 0` — the zero case
must return zero, not throw, because `encode()` relies on it (§4.1).

`div(a, b) = a · inverseOrZero(b)`; throw on `b = 0`.

### 2.5 Legendre symbol

`legendre(a) = Norm(a)^((p−1)/2) ∈ Fp`, returning `1` for a non-zero square, `p−1` for a
non-square, `0` for zero. Note `(p−1)/2 = 2^63 − 2^31`, so it is computed as
`Norm^(2^63) / Norm^(2^31)` — 63 squarings and one inversion in `Fp`, no big exponentiation.

`a` is a square in `Fp5` iff `legendre(a) = 1` — because `Norm(a)^((p−1)/2) = a^((p^5−1)/2)`.

### 2.6 Square root

Any correct square-root algorithm is acceptable — the *sign* of the returned root is irrelevant to
everything the protocol does (proved in §4.2). Requirements:

1. Return `{ root, exists }`.
2. **Always verify `root² == a` before reporting `exists: true`.** This makes the implementation
   robust regardless of which algorithm is chosen, and it is cheap (one `Fp5` square).

Two viable algorithms:

- **Norm-based (what the reference does, ~70 `Fp5` squarings + one `Fp` square root).** Compute
  `v = a^(2^31)`, `d = a·v^(2^32)·v⁻¹` (`= a^((p+1)/2)`), `e = Frob(d·Frob²(d))`, `f = e²`. Then
  `a·f` lies in `Fp`; take `g = (a·f)[0] = a0f0 + 3(a1f4 + a2f3 + a3f2 + a4f1)`, compute `s =
  sqrt_Fp(g)` by Tonelli–Shanks in `Fp` (2-adicity 32, generator `7277203076849721926`), and
  return `s·e⁻¹`.
- **Tonelli–Shanks directly in `Fp5`** (2-adicity of `p^5 − 1` is also 32; needs a fixed `Fp5`
  non-residue). Simpler to reason about, ~4× slower. Fine — square roots only appear in `decode()`,
  which runs once per verification.

### 2.7 `sgn0` and `canonicalSqrt`

The reference's `Sgn0` is written as a five-limb loop but **collapses to a single test**: it
returns `true` iff the *canonical* value of coefficient 0 is even (including when it is zero).
Trace: the loop's `zero` guard is only reachable when coefficient 0 is `0`, and `0` is even, so the
first iteration already sets the result. Verified by case analysis.

`canonicalSqrt(a)` = `sqrt(a)`, negated if `sgn0(root)` is true. Net effect: **pick the root whose
coefficient 0 is odd**, with the degenerate case that when coefficient 0 of both roots is `0`
neither is "odd" and the negation is a no-op.

Verified against `gfp5.json`: the predicate "coefficient 0 is even" matches `sgn0A` on **46 of 46**
cases, and every existing `canonicalSqrtA` has an odd coefficient 0 (21 cases) except the single
degenerate case where it is 0.

Implement it to match (`gfp5.json` pins `sgn0A`, `sqrtA`, `canonicalSqrtA`), but understand that
`decode()` does not depend on it (§4.2).

### 2.8 40-byte codec

`toLittleEndianBytes(a)` = `LE64(canon(a0)) ‖ LE64(canon(a1)) ‖ … ‖ LE64(canon(a4))`, 40 bytes.

`fromCanonicalLittleEndianBytes(b)`:
- reference behaviour: requires `len(b) == 40`, then reads five little-endian `uint64`s and
  **performs no range check** — a limb `≥ p` is accepted and becomes a non-canonical element.
- Consequence: the encoding is **not injective at the byte level**. Each coefficient in
  `[0, p)` has a second byte representation as `coefficient + p` whenever that fits in 64 bits,
  which it does for all but the top `2^32 − 1` values. Up to `2^5 = 32` distinct 40-byte strings
  can denote one `Fp5` element.
- **TypeScript decision:** reduce on parse (so any Lighter-issued key keeps working), always emit
  canonical, and expose `{ strict?: boolean }` that rejects any limb `≥ p`. Default `strict:
  false` for compatibility; the high-level `ApiKey` API should default to `strict: true` for
  *public keys it generates or round-trips*, because the server compares public keys as hex
  strings and a non-canonical limb would silently fail that comparison.

### 2.9 Non-canonical representation — do not port it

The Go `GoldilocksField` is a raw `uint64` that arithmetic leaves only partially reduced (`< 2^64`,
possibly one `p` above the true residue). Because `2^64 − 1 < 2p`, a *single* conditional subtract
canonicalizes, which is what `ToCanonicalUint64` does.

This is a 64-bit-hardware trick with no `BigInt` analogue. **lighter-ts reduces fully on every
operation.** All committed vectors are canonical. This is already recorded in
`conformance/vectors/goldilocks.json` under `nonCanonicalNotes` and in `spec/00-verified-facts.md`;
this document just restates it because it is the single easiest way to produce a vector mismatch.

One consequence worth internalizing: every `Fp` operation in the reference is *modularly correct*
even on non-canonical inputs, so eager reduction produces identical results everywhere. The only
places non-canonicality is observable are (a) byte serialization and (b) equality comparison — and
both go through `ToCanonicalUint64` in the reference. There is no behavioural divergence.

---

## 3. Layer 2 — the curve

### 3.1 Curve equation and constants

```
E : y² = x·(x² + a·x + b)     over Fp5

a = 2                = [2, 0, 0, 0, 0]
b = 263·X            = [0, 263, 0, 0, 0]
```

Derived constants used by the point formulas: `2b = [0, 526, 0, 0, 0]`,
`4b = [0, 1052, 0, 0, 0]`, `16b = [0, 4208, 0, 0, 0]`.

Verified properties:

- `b` is a **non-square** in `Fp5` (`legendre(b) = p−1`). This is what makes decoding canonical:
  the two roots `x₁, x₂` of the decoding quadratic satisfy `x₁·x₂ = b`, so exactly one of them is
  a square.
- `a² − 4b` is a **non-square**. This is what makes `w = 0` decode to the neutral rather than to a
  real point.

This is a *double-odd* curve: `E` has a single point of order 2, namely

```
N = (0, 0)
```

and `|E(Fp5)| = 2n` with `n` prime (§5.1). Verified: `2n` satisfies the Hasse bound against `p^5`,
and `[n]G = N`, `[2n]G = O` under ordinary curve addition.

### 3.2 Short Weierstrass form (optional — circuit interop only)

Substituting `x = X_w − a/3` gives `Y² = X³ + A_w·X + B_w` with

```
A_w = b − a²/3 = [6148914689804861439, 263, 0, 0, 0]     (verified: 6148914689804861439 = −4/3 mod p)
B_w = 2a³/27 − a·b/3                                      (never materialized by the reference)
```

**The Weierstrass representation is not used anywhere in signing or verification.** It exists so
the same group can be handed to a plonky2 gadget. Ship it in a separate, tree-shakeable module or
omit it from v1.

The mapping is subtler than "change of variable", and the reference's own naming hides it. Verified
relationship, for a group element with encoding `w`:

- `decode(w)` yields the double-odd point `P = (x_ns, w·x_ns)` where `x_ns` is the **non-square**
  root of the decoding quadratic.
- `decodeFp5AsWeierstrass(w)` yields `(X_w, Y_w) = (x_sq + a/3, −w·x_sq)` where `x_sq` is the
  **square** root of the same quadratic — i.e. it is `P + N` (ordinary curve addition), then
  x-shifted by `a/3`.
- Consistently, the reference's `GENERATOR_WEIERSTRASS` maps back to a curve point whose `w` is
  exactly `4` — the same group element as `GENERATOR_ECgFp5Point` (verified numerically).

So: *Weierstrass point = (group element + N), shifted.* The neutral `N` maps to `O` (`IsInf`),
which is why `NEUTRAL_WEIERSTRASS` is the point at infinity. The `X` value baked into the
reference's neutral expectation (`6148914689804861440`) is dead data — the reference's `Equals`
short-circuits on `IsInf` and never compares it.

### 3.3 The group `G` and its law

`E` has order `2n`. The protocol group is **not** a subgroup of `E` under ordinary addition. It is
the set of curve points equipped with the shifted law

```
P ⊕ Q  =  P + Q + N          (ordinary curve addition on the right)
```

with neutral element `N = (0,0)` and inverse `⊖P = −P − 2N = −P` (since `2N = O`; negation is
still just `y ↦ −y`).

`(G, ⊕)` is cyclic of **prime order `n`**. Consequences that matter:

- **Cofactor is 1.** No cofactor clearing, no small-subgroup check, ever. Any successfully decoded
  point is a valid group element.
- Multiples relate to ordinary arithmetic by `[k]P = kP + (k−1)N`. Verified against the
  reference's precomputed generator window: entry `i` equals `(i+1)G + i·N`, for `i = 0..3`.
- The complete addition formulas already build `+ N` in. **Callers never add `N` explicitly.** A
  naive implementation that uses plain curve addition and forgets the `+ N` will produce points
  that pass `isOnCurve` and fail every vector.

### 3.4 Generator

```
G.x = [12883135586176881569, 4356519642755055268, 5248930565894896907,
       2165973894480315022, 2448410071095648785]
G.u = 1/4  (i.e. the fractional form is  z = 1, u = 1, t = 4)
G.y = 4·G.x
encode(G) = [4, 0, 0, 0, 0]
```

Verified: `G` satisfies the curve equation; `[n]G = N`; and `encode(G) = 4` matches
`conformance/vectors/curve.json → generatorEncoded`. `encode(N) = 0` matches `neutralEncoded`.

`encode(G) = 4` is the single cheapest smoke test in the whole crypto stack. Assert it in a unit
test before anything else.

### 3.5 Coordinate systems and how they relate

| Name | Shape | Meaning | Used for |
| --- | --- | --- | --- |
| plain affine | `(x, y)` | on `E` | conceptual / spec only |
| `(x, u)` affine | `(x, u)` with `u = x/y` | `u = 0` denotes `N` | window tables, mixed addition |
| fractional | `(X:Z, U:T)` with `x = X/Z`, `u = U/T` | working representation | all arithmetic |
| Weierstrass | `(X_w, Y_w, isInf)` | `= (element + N)` shifted by `a/3` | zk-circuit interop only |

Identity handling: **the neutral is exactly `u = 0`** (`U = 0`, any `T ≠ 0`). Its canonical
fractional form is `(X:Z, U:T) = (0:1, 0:1)`.

Equality is `U₁·T₂ == U₂·T₁` — note this compares *only* the `u` coordinate. That is sound: on this
curve `u` determines the point (§4.2 shows `x` is recovered from `w = 1/u`). Do not "improve" it by
also comparing `x`; two representations of the same point can carry different `(X:Z)` scalings and
the reference's own vectors rely on the `u`-only test.

### 3.6 Point operations

All of the following are published algorithms from the `ecgfp5` reference construction
(https://github.com/pornin/ecgfp5), stated here as algebra.

**Addition (complete, 10 multiplications).** Given `P₁ = (X₁:Z₁, U₁:T₁)`, `P₂ = (X₂:Z₂, U₂:T₂)`:

```
t1 = X₁X₂            t2 = Z₁Z₂            t3 = U₁U₂            t4 = T₁T₂
t5 = (X₁+Z₁)(X₂+Z₂) − t1 − t2                 [ = X₁Z₂ + X₂Z₁ ]
t6 = (U₁+T₁)(U₂+T₂) − t3 − t4                 [ = U₁T₂ + U₂T₁ ]
t7 = t1 + b·t2
t8 = t4·t7
t9 = t3·(2b·t5 + 2·t7)
t10 = (t4 + 2·t3)·(t5 + t7)

X₃ = b·(t10 − t8)
Z₃ = t8 − t9
U₃ = t6·(b·t2 − t1)
T₃ = t8 + t9
```

Complete: no exceptional cases, works when either operand is the neutral and when `P₁ = P₂`.

**Mixed addition (affine right operand, 8 multiplications).** Same shape with `Z₂ = T₂ = 1`, i.e.
`t2 = Z₁`, `t4 = T₁`, `t5 = X₁ + x₂·Z₁`, `t6 = U₁ + u₂·T₁`. Verified by algebra that adding the
affine neutral `(0, 0)` leaves `(X:Z, U:T)` unchanged up to a common factor.

**Doubling (4M + 5S).**

```
t1 = Z·T            t2 = t1·T            x1 = t2²
z1 = t1·U           t3 = U²              w1 = t2 − 2(X + Z)·t3
t4 = z1²

X' = 4b·t4
Z' = w1²
U' = (w1 + z1)² − t4 − Z'
T' = 2·x1 − (4·t4 + Z')
```

**n-fold doubling `mDouble(k)`.** The reference has a specialized routine costing
`k·(2M+5S) + 2M + 1S` by working in an intermediate `(X:W:Z)` representation. It is **purely an
optimization** — `k` iterations of `double()` is functionally identical.

> **Implementation guidance:** ship v1 with repeated `double()`. Add `mDouble` later, gated by the
> same vectors. Getting `mDouble` wrong is the most likely source of a subtle, intermittent-looking
> bug in this whole spec (it has a distinct `k = 0`, `k = 1`, and `k ≥ 2` code path), and it buys
> maybe 30% of one scalar multiplication.

**Negation.** `−(x, u) = (x, −u)`; in fractional form negate `U` (or `T`, not both).

**Batch affine conversion.** Converting `m` fractional points to `(x, u)` affine costs one `Fp5`
inversion plus `3(m−1)` multiplications, using Montgomery's trick (accumulate the running product
of all `Z` and `T`, invert once, walk backwards). Needed for window construction (§5.5).

---

## 4. Encoding and decoding of group elements

### 4.1 Encoding

```
encode(P) = T / U        ( = 1/u = y/x )
```

using `inverseOrZero`, so `encode(N) = 0`. The result is a single `Fp5` element → **40 bytes**.

This is the canonical serialized form of a group element, and it is the *only* form that appears
on the wire (public keys) or in a hash preimage (the `r` component of the challenge).

### 4.2 Decoding

Given `w ∈ Fp5`, we want the point with `y/x = w`. Substituting into the curve equation and
dividing by `x`:

```
x² − (w² − a)·x + b = 0
```

Algorithm:

```
e     = w² − a
delta = e² − 4b
(r, ok) = sqrt(delta)                 // any root; sign is irrelevant, see below
if !ok: r = 0
x₁ = (e + r)/2
x₂ = (e − r)/2
x  = (legendre(x₁) == 1) ? x₂ : x₁    // keep the NON-square root
success = ok || (w == 0)
if success and w == 0:  result = N    // (x:z, u:t) = (0:1, 0:1)
if success and w != 0:  result = (x : 1, 1 : w)
if !success:            reject
```

Facts that make this correct and that the implementation should encode as assertions/tests:

- `x₁·x₂ = b` and `b` is a non-square, so **exactly one root is a square** — the selection is
  well-defined. (Verified.)
- Swapping the sign of `r` swaps `x₁` and `x₂`, and the selection rule is stated in terms of
  squareness, so **the decoded point does not depend on the square-root sign convention**.
  (Verified for `w = 4`: `x₁ = G.x`, `legendre(G.x) ≠ 1`, so the non-square root is chosen.)
- `w = 0` ⟹ `delta = a² − 4b`, a non-square, so the sqrt fails; the `w == 0` special case turns
  that failure into a success returning `N`.
- **Canonical decoding:** each group element has exactly one valid `Fp5` encoding, and invalid
  encodings are rejected. There is no point malleability and — because the order is prime — no
  subgroup check to perform.

Round-trip: `encode(decode(w)) == w` for all valid `w`. `curve.json → cases[].decodeRoundTrip`
pins this; the reference's own test set additionally contains six `Fp5` values that must **fail**
to decode (see §12.3 — these are not in the oracle output yet and should be added).

---

## 5. Layer 3 — the scalar field

### 5.1 Modulus

```
n = 1067993516717146951041484916571792702745057740581727230159139685185762082554198619328292418486241

hex   = 0x7FFFFFFD800000077FFFFFF1000000167FFFFFE6CFB80639E8885C39D724A09CE80FD996948BFFE1
limbs = [0xE80FD996948BFFE1, 0xE8885C39D724A09C, 0x7FFFFFE6CFB80639,
         0x7FFFFFF100000016, 0x7FFFFFFD80000007]      (little-endian 64-bit limbs)
bits  = 319   (n < 2^319)
```

Verified prime (Fermat test) and verified equal to its limb decomposition.

`n − 1` limbs = `[0xE80FD996948BFFE0, …]` (only limb 0 differs) — the reference calls this
`NEG_ONE`.

Because `n < 2^319 < 2^320`, a scalar always fits in five 64-bit limbs with room to spare, and a
40-byte encoding can represent values up to `2^320 − 1`, i.e. slightly under `3n`.

### 5.2 40-byte little-endian representation

```
toLittleEndianBytes(s) = LE64(s₀) ‖ LE64(s₁) ‖ LE64(s₂) ‖ LE64(s₃) ‖ LE64(s₄)   // 40 bytes
```

### 5.3 `ScalarElementFromLittleEndianBytes` — exact semantics

This function name appears in the task brief; here is precisely what it does, because the answer is
not what the name suggests:

1. It **requires at least 40 bytes** (the reference's bounds hint panics below that). Bytes beyond
   index 39 are **ignored**.
2. It reads five little-endian `uint64` limbs, producing an integer `v ∈ [0, 2^320)`.
3. If `v < n` it returns `v` unchanged.
4. Otherwise it returns **`v mod n`**.

So: it **reduces, it does not reject**. There is no canonicality validation anywhere on the input
path. Two consequences:

- A 40-byte private key whose value is `≥ n` is silently reduced. Two distinct hex strings can name
  the same key.
- A signature component `s` and `s + n` are the same signature: `SigFromBytes` reduces both. Since
  `n ≈ 2^319` and `s < n`, `s + n < 2^320` always fits, so **every signature has at least two valid
  byte encodings**. The reference's own test asserts this ("works with non-canonical inputs").

**TypeScript decision:** match the reference by default (reduce on parse — otherwise we would
reject signatures and keys the exchange accepts), *and* expose `isCanonical` plus a `strict` parse
mode. Always emit canonical bytes. Reject inputs whose length is not exactly 40 (the reference's
"ignore the tail" behaviour is a bug surface, not a feature).

`NewKeyManager` in the Go SDK *does* enforce `len == 40` before calling this, so exact-length
enforcement is already the effective contract at the SDK boundary.

### 5.4 Arithmetic

`add`, `sub`, `mul` are all mod `n`. The reference uses Montgomery multiplication with

```
N0I  = 0xD78BEF72057B7BDF   ( = −1/n₀ mod 2^64,  verified )
R2   = 2^640 mod n          ( verified )
T632 = 2^632 mod n          ( verified; unused by the signature path )
```

**None of this is needed in TypeScript.** With `BigInt`, `(a * b) % n` is one operation. Record the
constants here only so that anyone reading the Go source knows they are an artifact, not protocol.

Two reference behaviours to *not* copy: `Add`/`Sub`/`Mul` panic on non-canonical operands, and
`MontyMul` panics on a non-canonical first operand. In TypeScript, reduce instead of throwing;
arithmetic on scalars should be total.

### 5.5 Signed 5-bit window recoding

Used by scalar multiplication. Given `s ∈ [0, n)`, produce **64 digits** `d₀ … d₆₃` with

```
s = Σ dᵢ · 2^(5i)          dᵢ ∈ [−15, +16]
```

Algorithm (exact, matches the reference bit for bit):

```
carry = 0
for i in 0..63:
    chunk = bits [5i, 5i+5) of s          // 0..31
    v = chunk + carry                     // 0..32
    if v > 16:  dᵢ = v − 32;  carry = 1
    else:       dᵢ = v;       carry = 0
```

`64 × 5 = 320 ≥ 319`, so the value is fully represented and, because `s < n < 2^319`, the final
carry is absorbed and `d₆₃ ∈ [0, 16]` (non-negative). The digit count in the reference is written
as `(319 + 5)/5 = 64`.

The reference exposes this generically for window widths 2..10; we only ever use 5. Hard-code 5,
and keep the generic form only if a test vector requires it.

`splitTo4BitLimbs` (80 unsigned 4-bit digits, little-endian nibble order within each limb) exists
in the reference solely for the Weierstrass `MulAdd2` path. Skip it unless §3.2 is implemented.

### 5.6 `Fp5 → scalar` (used for the challenge)

```
fromFp5(h) = ( Σ_{i=0}^{4} canon(hᵢ) · 2^(64i) )  mod  n
```

The `canon()` is load-bearing: the reference explicitly canonicalizes each limb before assembling
the integer. Since we reduce eagerly everywhere this is automatic — but state it, because it is the
one place where the non-canonical representation *would* have changed a result if the reference had
forgotten it.

Note the mild non-uniformity this induces (each limb is uniform over `[0, p)`, not `[0, 2^64)`) —
irrelevant for the challenge `e`, but see §9 for why it matters for the nonce `k`.

---

## 6. Layer 4 — scalar multiplication

### 6.1 Window construction

For a point `P`, build `win[0..15]` with `win[i] = [i+1]P` (in `⊕` arithmetic), then batch-convert
to `(x, u)` affine. Verified against the reference's precomputed generator table for
`i = 0, 1, 2, 3`.

Window size is `2^(w−1) = 16` for `w = 5`; only positive multiples are stored because the digit
recoding is signed and negation is free.

### 6.2 Digit lookup

For digit `d ∈ [−15, 16]`:

```
d == 0  →  affine neutral (x, u) = (0, 0)
d  > 0  →  win[d − 1]
d  < 0  →  negate(win[−d − 1])         // (x, u) ↦ (x, −u)
```

### 6.3 Variable-base multiplication `[s]P`

```
win = window(P)
d[0..63] = recode(s)
acc = toPoint(lookup(win, d[63]))
for i = 62 down to 0:
    acc = mDouble(acc, 5)              // or 5 × double()
    acc = addAffine(acc, lookup(win, d[i]))
return acc
```

Cost: 320 doublings + 64 mixed additions + 15 additions/doublings and one inversion for the window.

**Reference warts to fix:**
- It rebuilds the 16-point window on *every* multiplication, including for the generator, even
  though a precomputed generator table sits right next to it unused by `Mul`. Public-key derivation
  and signing both pay for this pointlessly.
- It uses the constant-time `Lookup` inside the loop but the variable-time `LookupVarTime` for the
  top digit — leaking the top 5 bits of the secret scalar in a way the rest of the function tries
  to avoid. Inconsistent; see §10.2.
- `Lookup`'s "constant-time" masking is undermined by an `if c != 0` branch in the Go source, so it
  is not actually constant time either.

### 6.4 `s·G + e·PK` (verification)

Interleaved double-and-add over both scalars sharing one doubling chain:

```
winA = generatorWindow          // precomputed / memoized
winB = window(PK)
dA = recode(s);  dB = recode(e)
acc = toPoint(lookup(winA, dA[63])) ; acc = addAffine(acc, lookup(winB, dB[63]))
for i = 62 down to 0:
    acc = mDouble(acc, 5)
    acc = addAffine(acc, lookup(winA, dA[i]))
    acc = addAffine(acc, lookup(winB, dB[i]))
```

All inputs here are public, so variable-time lookups are fine and preferable.

### 6.5 Generator table strategy (TypeScript)

Three options, with the recommendation:

| Option | Table | Code size | Sign cost |
| --- | --- | --- | --- |
| (a) rebuild every call (reference) | — | 0 | 1.0× |
| (b) **memoize the 16-entry affine window, built lazily on first use** | 160 `u64` | 0 (derived) | ~0.95× |
| (c) fixed-base comb, 8 sub-tables × 16 points, built lazily and memoized | 1280 `u64` | 0 (derived) | ~0.3× |

**Recommendation: (b) for v1, (c) as a measured phase-2 optimization.** Critically, both are
*derived at runtime from `G`*, so neither costs a single byte of bundle size — a hard-coded table
would add ~10 KB of hex to a Workers bundle for no functional gain, and would be one more thing to
get wrong. Build the table on first use, never at module scope.

> **Cloudflare Workers constraint:** module-scope initialization runs in the isolate's global scope
> where certain operations are disallowed (notably `crypto.getRandomValues`) and where startup CPU
> is budgeted. Table construction needs no randomness so it is *legal* at module scope, but do it
> lazily anyway to keep cold starts cheap. **Never call `crypto.getRandomValues` at module scope.**

---

## 7. Layer 5 — the Schnorr scheme

### 7.1 Keys

- **Private key** = a scalar `sk ∈ [1, n)`, serialized as **40 bytes little-endian** (§5.2).
- **Public key** = `PK = [sk]G`, serialized as its `Fp5` encoding: `encode([sk]G)`, **40 bytes
  little-endian** (§4.1).
- Hex form on the SDK boundary is `0x`-prefixed lowercase: **80 hex digits plus the prefix = 82
  characters** for each. The Go SDK accepts the private key with or without the `0x` prefix and
  requires exactly 40 bytes after decoding.

Sanity anchors (independently derived and cross-checked against `curve.json`):

```
sk = 1  →  PK = [4, 0, 0, 0, 0]
           PK bytes = 0400000000000000 0000…00   (40 bytes)
sk = 2  →  PK = [9158372289535233080, 10327954189174774606, 15619016834217869504,
                 16517814385077291378, 10141215455047792195]
sk = 3  →  PK = [6052337009455581569, 14364284273112518944, 6784982068192735943,
                 3108585027458804187, 12998922769182173772]
```

### 7.2 The signed message is already hashed

`KeyManager.Sign` takes a **40-byte hashed message**, parses it as an `Fp5` element
(`fromCanonicalLittleEndianBytes`), and signs that element. It does **not** hash anything itself.
The `hash.Hash` parameter in the Go signature is accepted and never used — dead API surface. Do not
reproduce it.

The 40 bytes come from dimension 04 (`txInfo.Hash(chainId)`), which is
`HashToQuinticExtension(fieldElements)` optionally folded with transaction attributes. From this
layer's point of view it is an opaque `Fp5` element.

### 7.3 Signing

Inputs: `hashedMsg ∈ Fp5`, `sk ∈ [1, n)`. Output: `(s, e)`, both scalars.

```
1.  choose nonce k ∈ [1, n)                       // see §7.4 and §9
2.  R = [k]G
3.  r = encode(R)                                 // an Fp5 element
4.  preimage = [ r₀, r₁, r₂, r₃, r₄,
                 m₀, m₁, m₂, m₃, m₄ ]             // exactly 10 Goldilocks elements, this order
5.  e = fromFp5( HashToQuinticExtension(preimage) )    // §5.6
6.  s = (k − e·sk) mod n
7.  signature = (s, e)
```

**Field order in step 4 is protocol.** `r` first, then the hashed message, five limbs each, index 0
first. The preimage is exactly 10 elements — which, with the sponge rate of 8, means two absorb
blocks (the second overwrites only lanes 0 and 1 and leaves lanes 2..7 carrying permutation output
from the first block). That is the reference's overwrite-mode, no-padding sponge behaviour and it
must be reproduced exactly; see dimension 02.

### 7.4 The nonce `k` — **randomized in the reference**

> **This is the single most security-critical fact in this document.**

The production entry point samples `k` uniformly from `[0, n)` using Go's `crypto/rand`. It is
**not** deterministic. There is no RFC 6979, no key-and-message derivation, no domain separation.
Signatures are therefore not reproducible, which is why the conformance oracle uses the reference's
second entry point that takes `k` as an explicit argument.

Implications for TypeScript:

- If we mirror the reference exactly, `k` must come from `crypto.getRandomValues`, which exists on
  all five target runtimes. It must be reduced to `[1, n)` **without modulo bias**: draw 64 bytes
  (512 bits) and reduce mod `n` (statistical distance from uniform `< 2^-192`), or use rejection
  sampling on 40-byte draws (≈50% acceptance since `n ≈ 2^319` and `2^320/n ≈ 2.0`). Do **not**
  draw exactly 40 bytes and reduce — that is a ~1-bit bias and it is exactly the shape of bias that
  lattice attacks eat.
- Risks of the randomized design: a repeated `k` across two signatures leaks `sk` immediately
  (`sk = (s₁ − s₂)/(e₂ − e₁)`); a biased `k` leaks `sk` after a few hundred signatures; a
  virtualized/forked/cloned environment (snapshot-restore of a Worker isolate, a fuzzing harness, a
  browser tab restored from bfcache) can replay RNG state. Browsers and Workers do not guarantee
  fork-safety of userland RNG state, but `crypto.getRandomValues` is a syscall-backed CSPRNG on all
  targets, so the realistic residual risk is low — provided we never cache or stretch its output
  ourselves.

**Any choice of `k` produces a signature the exchange accepts.** Verification recomputes `e` from
`r_v` and compares; it never learns how `k` was derived. This means we are free to make signing
deterministic without any wire-compatibility risk. See §9 for the recommended derivation.

### 7.5 The challenge `e`

```
e = fromFp5( HashToQuinticExtension( r ‖ hashedMsg ) )   mod n
```

`e` therefore ranges over the full scalar field (~319 bits) rather than the 128 bits a short
Schnorr would use. The reference carries a TODO about truncating to 128 bits "in coordination with
Rust". **Do not implement that truncation.** If the chain ever adopts it, it is a hard fork of the
signature scheme and will need a version flag.

### 7.6 Signature encoding — 80 bytes

```
byte range   content
[ 0, 40)     s, 40-byte little-endian scalar   (limb 0 first, each limb little-endian)
[40, 80)     e, 40-byte little-endian scalar
```

Concretely, byte `8·i + j` of the `s` half is bit-block `j` of limb `i`, little-endian within the
limb and ascending across limbs. Same for `e` at offset 40.

Parsing reduces each half mod `n` (§5.3) rather than rejecting non-canonical input.

### 7.7 Verification

```
verify(PK_bytes, hashedMsg_bytes, sig_bytes) -> bool

1.  pk  = fp5FromLE(PK_bytes)                     // 40 bytes
2.  m   = fp5FromLE(hashedMsg_bytes)              // 40 bytes
3.  (s, e) = scalars from sig_bytes               // 80 bytes, §7.6
4.  reject unless s < n and e < n                 // canonicality of the *parsed* values
5.  P = decode(pk)                                // reject if decoding fails
6.  R_v = [s]G ⊕ [e]P                             // §6.4
7.  r_v = encode(R_v)
8.  e_v = fromFp5( HashToQuinticExtension( r_v ‖ m ) )
9.  return e_v == e
```

Correctness: `[s]G ⊕ [e]PK = [k − e·sk]G ⊕ [e·sk]G = [k]G = R`.

There is **no** subgroup check and none is needed (prime order). There is no `R != identity` check
in the reference.

Note step 4 in the reference operates on the values *after* the reducing parse, so it always
passes — the "canonicality check" is effectively dead code. Keep the check in TypeScript (it costs
nothing) but understand it is not a rejection path unless `strict` parsing is used.

### 7.8 Where `SignatureLength = 80` and `PubKeyLength = 40` come from

```
PubKeyLength   = gFp5.Bytes            = 5 limbs × 8 bytes = 40
HashLength     = gFp5.Bytes            = 40                        (the hashed message is an Fp5 element)
SignatureLength= 2 × 40                = 80                        (two scalars, s and e)
```

`gFp5.Bytes = goldilocks.Bytes × 5 = 8 × 5`. There is no header, no prefix byte, no length tag, no
recovery id. Every one of these three lengths is fixed and must be enforced.

### 7.9 Malleability summary

| Layer | Malleable? | Why |
| --- | --- | --- |
| Group element encoding (`w`) | No | canonical decoding, one encoding per element |
| Public key **bytes** | Yes | limbs `≥ p` accepted and reduced (§2.8) |
| Signature **bytes** | Yes | `s`, `e` parsed with reduction mod `n` (§5.3) |
| `(s, e)` pair itself | No | `e` is bound by the hash |

Byte-level malleability is harmless for signature validity, but it is *not* harmless if any
component hashes or compares raw signature/public-key bytes. Emit canonical, always.

---

## 8. Deviations from the reference (intentional, and why)

Each of these changes observable behaviour. They are listed so they can be accepted or rejected as
a batch rather than discovered later.

| # | Deviation | Rationale | Escape hatch |
| --- | --- | --- | --- |
| D1 | Reject `sk ≡ 0 (mod n)` at key construction | `sk = 0` yields `PK = 0` and a "key" nobody controls | none — this is always a caller bug |
| D2 | `verify` returns `false` if `PK` decodes to the neutral | with `PK = 0` an attacker forges freely (`e` need only match `encode([s]G)`); no real account has this key | `{ allowNeutralPublicKey: true }` |
| D3 | Reject inputs whose length ≠ 40 / 80 exactly | reference ignores trailing bytes on scalar parse | none |
| D4 | Scalar arithmetic reduces instead of panicking on non-canonical operands | total functions | none |
| D5 | Default nonce is hedged-deterministic, not pure random (§9) | eliminates RNG-failure key loss; wire-identical | `{ nonce: 'random' \| bigint }` |
| D6 | Eager canonical reduction of all field elements | no `BigInt` analogue to the non-canonical form; already ratified in `00-verified-facts.md` | none |
| D7 | `sign()` takes no hash-function argument | reference's parameter is unused | none |

D5 conflicts with the line in `conformance/README.md` ("`crypto.getRandomValues` by default") —
see open questions.

---

## 9. Nonce derivation for TypeScript (recommended)

Because verification cannot observe how `k` was produced, we can strictly improve on the reference.

**Recommended default: hedged deterministic (`'hedged'`).** Deterministic derivation from
`(sk, message)` plus optional fresh entropy. This is the EdDSA/RFC-6979-with-added-entropy pattern:
it cannot repeat a nonce for distinct messages even if the RNG is broken or absent, and it cannot
be replayed by snapshotting because fresh entropy is mixed in when available.

```
LighterNonce-v1

  skBytes  = 40-byte LE encoding of (sk mod n)
  msgBytes = the 40-byte hashed message, as given
  rnd      = 32 bytes from crypto.getRandomValues, or 32 zero bytes if unavailable
  label    = ASCII "lighter-ecgfp5-schnorr-v1"           (25 bytes)
  seed     = skBytes ‖ msgBytes ‖ rnd ‖ label

  V = 0x01 × 32 ;  K = 0x00 × 32
  K = HMAC-SHA256(K, V ‖ 0x00 ‖ seed) ;  V = HMAC-SHA256(K, V)
  K = HMAC-SHA256(K, V ‖ 0x01 ‖ seed) ;  V = HMAC-SHA256(K, V)
  loop:
      T = ""
      while len(T) < 48:  V = HMAC-SHA256(K, V) ;  T = T ‖ V
      k = (big-endian integer of T[0..48)) mod n         // 384-bit input ⇒ bias < 2^-64
      if k != 0: return k
      K = HMAC-SHA256(K, V ‖ 0x00) ;  V = HMAC-SHA256(K, V)
```

Why HMAC-SHA-256 and not Poseidon2 (which we already ship):

- Poseidon2 is an algebraic hash with a 128-bit security claim, and it is the *same* primitive that
  produces the challenge. Deriving the nonce with it couples two failure modes: an algebraic
  weakness in Poseidon2 would compromise the secret nonce as well as the challenge.
- SHA-256 is ~150 lines of pure synchronous TypeScript (`Uint32Array` + `Math.imul`), adds ~2.5 KB
  minified, has no dependencies, and is the most-reviewed hash in existence.
- `crypto.subtle.sign('HMAC', …)` would work but is **async-only** on the web platform, which would
  make `sign()` return a Promise on Workers and browsers. Not worth it.

Other modes to expose:

- `'random'` — draw 64 bytes from `crypto.getRandomValues`, reduce mod `n`. Mirrors reference
  behaviour. Throws if no CSPRNG is present.
- an explicit `bigint` — the test seam that reproduces `schnorr.json → nonceKLeHex` exactly. This
  is mandatory; without it the conformance vectors cannot be replayed.

Private-key generation (`generate()`) uses the same rule: 64 random bytes reduced mod `n`, rejected
if zero. `crypto.getRandomValues` is required here and there is no deterministic fallback.

---

## 10. TypeScript design

### 10.1 Representation and performance budget

- `Fp` element: a `bigint` in `[0, p)`. Always canonical.
- `Fp5` element: `readonly [bigint, bigint, bigint, bigint, bigint]`.
- Scalar: a single `bigint` in `[0, n)`. **Do not model scalars as five limbs.** The limb form
  exists in Go because it has no big integers; under `BigInt` a single value is simpler, faster and
  removes an entire class of carry bugs. Limbs appear only in the byte codec and in `fromFp5`.
- Point: an object/tuple of four `Fp5` values.

`mulmod`: start with `(a * b) % P`. Benchmark it against the Goldilocks-specific folded reduction
(`2^64 ≡ 2^32 − 1`, `2^96 ≡ −1`, `2^128 ≡ −2^32`) before hand-optimizing — V8's `BigInt` division
by a 64-bit modulus is fast, and the shift-based version costs more `BigInt` allocations. Measure,
do not assume.

Rough operation counts for a scalar multiplication with repeated `double()`: ~320 doublings + ~64
mixed additions ≈ 85 000 `mulmod`s. Budget: **sign < 25 ms and verify < 50 ms on Node 20 on an
M-series laptop** for v1. If the fixed-base comb (§6.5c) lands, sign should drop under 10 ms. Gate
these in a benchmark test so a regression is visible.

`BigInt` subtraction uses truncated `%` in JS — `(a - b + P) % P`, or an explicit conditional. This
is the single most common source of a silent sign bug in a from-scratch field implementation.

### 10.2 Constant-time: what is and is not achievable — state this honestly

**It is not possible to write constant-time code in portable TypeScript.** Specifically:

- `BigInt` operations allocate, and their cost depends on the *magnitude* of the operands (V8 uses
  a variable-length digit array). A value that happens to have fewer significant digits is cheaper
  to multiply.
- The engine is free to deoptimize, inline-cache, and GC based on runtime-observable state.
- There is no `subtle`-style barrier and no way to pin a value into a fixed-width representation.

What we *can* do, and should:

1. **No secret-dependent control flow.** The window lookup must scan all 16 entries and select
   arithmetically (mask via `BigInt` `&`/`|` on a 0/all-ones mask, or a branchless conditional
   swap), not `win[d-1]`. Fix the reference's inconsistency: use the same scan for the top digit as
   for the rest.
2. **No secret-dependent loop counts.** 64 digits, always. No early exit on leading zero digits.
3. **No secret-dependent memory indexing.** Same point as (1), stated because the cache side
   channel is the one that actually gets exploited.
4. Verification operates only on public data — use the fast variable-time path there.

This buys resistance to coarse remote timing. It does **not** buy resistance to a co-resident
attacker with cache/µarch observation. The README must say so plainly. The mitigating context: this
SDK signs on the user's own machine or in the user's own Worker isolate; there is no
multi-tenant-with-shared-secret scenario in the intended deployment. If someone runs it in a shared
isolate with an attacker, ECgFp5 timing is not their biggest problem.

**Memory hygiene is also not achievable:** a `bigint` cannot be zeroed. If key wiping matters,
store the key as a `Uint8Array` and reconstruct the scalar per signature — but the reconstructed
`bigint` and every intermediate still live on the heap until GC. Do not claim wiping we cannot
deliver; document the limitation instead.

### 10.3 Module layout and exports

```
src/crypto/
  goldilocks.ts     Fp arithmetic + LE64 codec                        (shared with dimension 02)
  fp5.ts            GF(p^5): arithmetic, Frobenius, inverse, legendre, sqrt, sgn0, 40-byte codec
  scalar.ts         scalar field mod n: codec, arithmetic, signed recoding, fromFp5
  point.ts          ECgFp5 point type, add/double/negate/equals, encode/decode
  scalarmul.ts      windows, lookup, [s]P, [s]G ⊕ [e]P, memoized generator table
  sha256.ts         sync SHA-256 + HMAC (nonce derivation only)
  schnorr.ts        sign / verify / nonce modes
  key.ts            ApiKey (the KeyManager equivalent)
  weierstrass.ts    OPTIONAL, circuit interop only
  index.ts          re-exports
```

Exports map must expose `"./crypto"` as its own entry point so a consumer that only needs signing
does not pull in REST/WS code, and so `weierstrass.ts` and `verify` can be shaken out of a
signing-only bundle. Keep `sign` and `verify` in separate modules internally: `verify` is the only
thing that needs `decode`, which is the only thing that needs `sqrt` and `legendre` — that is
several KB a signing-only Worker never has to ship.

### 10.4 Public API (the `KeyManager` equivalent)

The reference's `KeyManager` interface is four methods and one unused parameter. Proposed
replacement:

```ts
export type NonceMode = 'hedged' | 'random';

export interface SignOptions {
  /** 'hedged' (default): deterministic + mixed entropy. 'random': mirrors the Go SDK.
   *  A bigint pins k explicitly — for conformance vectors only. */
  nonce?: NonceMode | bigint;
}

export class ApiKey {
  static fromPrivateKey(key: Uint8Array | string): ApiKey;   // 40 bytes, or 0x-hex / bare hex
  static generate(): ApiKey;                                 // requires crypto.getRandomValues

  /** 40 bytes, little-endian, canonical. */
  readonly privateKeyBytes: Uint8Array;
  /** 40 bytes, little-endian, canonical. */
  readonly publicKeyBytes: Uint8Array;
  /** 0x-prefixed lowercase, 82 chars. */
  readonly privateKeyHex: string;
  readonly publicKeyHex: string;

  /** hashedMessage is 40 bytes (an Fp5 element). Returns 80 bytes. Synchronous. */
  sign(hashedMessage: Uint8Array, opts?: SignOptions): Uint8Array;
}

/** Stateless verification. Returns false on any malformed input — never throws. */
export function verify(
  publicKey: Uint8Array,
  hashedMessage: Uint8Array,
  signature: Uint8Array,
  opts?: { allowNeutralPublicKey?: boolean },
): boolean;

// Low-level, for tests and advanced use:
export function publicKeyFromPrivateKey(sk: bigint): Fp5;
export function signHashed(hashedMsg: Fp5, sk: bigint, k: bigint): { s: bigint; e: bigint };
```

Design notes:

- `sign` is **synchronous** on every target runtime. This is a real advantage over any design that
  reaches for `crypto.subtle`, and it keeps the transaction-building layer synchronous too.
- `verify` never throws. Malformed length, non-decodable key, out-of-range scalar → `false`.
  Constructors *do* throw (`InvalidKeyError`) because a bad key is a programming error.
- No `hash.Hash` parameter. No interface-per-capability split (`Signer` + `KeyManager` in Go buys
  nothing here).
- Named `ApiKey` rather than `KeyManager` because that is what Lighter calls it everywhere else
  (`api_key_index`, `/apikeys`), and because it manages exactly one key.

### 10.5 Error model

```ts
class InvalidKeyError extends Error {}        // wrong length, zero scalar, bad hex
class InvalidSignatureError extends Error {}  // only from strict parsing helpers
class NoSecureRandomError extends Error {}    // generate() / nonce:'random' with no CSPRNG
```

No error should ever include key material in its message.

---

## 11. Runtime compatibility checklist

| Requirement | Where it bites |
| --- | --- |
| No `node:crypto`, no `Buffer` | Workers, Deno, browser |
| No top-level `crypto.getRandomValues` | Cloudflare Workers forbids randomness in global scope |
| No top-level heavy compute | Workers startup CPU budget — build tables lazily |
| `BigInt` literals (`123n`) | fine everywhere; target ES2020+ |
| No dynamic `import()` of optional deps | breaks Workers bundling |
| Uint8Array only, never Buffer | `Buffer` is Node-only |
| Byte↔hex helpers written by hand | `Buffer.from(hex,'hex')` unavailable |

---

## 12. Test plan and conformance vectors

### 12.1 What already exists — use it, do not regenerate it

`/Users/joeblau/Developer/lev7/src/lighter-ts/conformance/` is already built and working. It pins
`lighter-go v1.0.7` and `poseidon_crypto v0.0.15` from the module proxy. Regenerate with:

```sh
cd /Users/joeblau/Developer/lev7/src/lighter-ts/conformance/oracle
go run . -out ../vectors
```

Output is byte-stable (splitmix64, fixed seed, no clock, no RNG). A dirty `git status` after
regeneration means the upstream reference changed — inspect before accepting.

Relevant files and the fields this dimension consumes:

**`gfp5.json`** — `bytes: 40`, `cases[46]` with keys `a, b, add, sub, mul, squareA, doubleA,
tripleA, negA, inverseA, divAB, frobeniusA, frobenius2A, scalarMulA, legendreA, sgn0A, sqrtA,
sqrtAExists, canonicalSqrtA, canonicalSqrtAExists, aLeBytesHex`. All `Fp5` values are arrays of
five decimal **strings** (never JSON numbers — precision). This covers §2 completely.

**`curve.json`** — `generatorEncoded` (`["4","0","0","0","0"]`), `neutralEncoded`
(`["0",…]`), `cases[20]` with `scalarLeHex, scalar, mulGenEncoded, mulGenLeBytesHex,
doubleEncoded, addGenEncoded, decodeRoundTrip`, and `scalarCases[11]` with
`inputLeHex, scalar, isCanonical, outputLeHex` (this is the §5.3 reduction contract).

**`schnorr.json`** — `signatureBytes: 80`, `pubKeyBytes: 40`, `cases[16]` with
`privateKeyLeHex, publicKey, publicKeyLeHex, messageElements, hashedMessage, hashedMessageLeHex,
nonceKLeHex, sigS, sigE, signatureBytesHex, valid, canonical`, plus `negative[3]`
("signature byte flipped", "message byte flipped", "wrong public key"). **`nonceKLeHex` is the seam
that makes signing reproducible** — the TS signer must accept an explicit `k`.

**`goldilocks.json`**, **`poseidon2.json`**, **`tx.json`** belong to dimensions 02 and 04.

### 12.2 Independent cross-check (already done — assert these first)

These were derived from an independent `GF(p^5)` model, *not* from the reference, and they agree
with the committed vectors. They are the fastest possible smoke tests and belong in the first
commit of the point unit:

```
encode(G)            = [4,0,0,0,0]
encode(N)            = [0,0,0,0,0]
G on curve           : y² = x(x² + 2x + 263X)  with y = 4x
[n]G                 = N        (ordinary curve arithmetic)
generatorWindow[i]   = (i+1)G + i·N            for i = 0..3
legendre(b)          = p − 1     (non-square)
legendre(a² − 4b)    = p − 1     (non-square)
3^((p−1)/5) mod p    = 1041288259238279555
A_w = b − a²/3       = [6148914689804861439, 263, 0, 0, 0]
```

And the three Schnorr vectors transcribed from the reference's own comparative test, whose scalar
relation `s = (k − e·sk) mod n` was verified independently, together with public keys derived from
the independent model:

| # | `sk` (LE hex) | `k` (LE hex) | hashed msg (LE hex) | public key (LE hex) | signature (80-byte hex) |
| --- | --- | --- | --- | --- | --- |
| 0 | `4980df1a5a76cba9fef4d80446e951108e16a5b21f497976475c950bd2588c5a58771d5b06498d28` | `5866d18f345acc487b5bfbc92bb1a3d2351628e54cd41a3d47e351fa62c16bd454075f200178017c` | `4b1047aff6018e74d095f1655d639d99192e1b447abe1087078612814b88ddfabc53f279194014ee` | `2db191eb16d3314974f8708363909aeee607d06fb743156b18d3b353a5d40fef70ae377dd68d06fe` | `22794fdf937575606fc2b233d1b565ee085991dc9a68d598989a3e2f76b338e4914e79f85259a45125468abb012d123fe4d13619c90e053a3749737b72c8f9294e8db2469e832ed664b6afcc65bb055e` |
| 1 | `da83ea081245bfca42565b26d74febd75d352595f3c4d70be0a1adc310582bf496971dcdbdce1c05` | `ccdb244528d07a1b650d8abebda67294970e727411b8922c60f74502ea6df8557098287a2ea25230` | `200f3542633a31ca34718a69ea6b9125ff5f5fee6d4f2d683f036d1b71cc70aeae65a79bd0babe3b` | `eefa1471806d8a2ad9223744395fce69bb53f06a2a0ef8fcc15e4b5bfc1bea29d87182cc11d7c793` | `73f87970ae46cbd209481301c261e0eae574369d2fba049af1a759922624c89e98786a36a1ac2a1f98e6b5fa46b21344a925866d03c3b88071dacb4555921a909ab9221406c02c5fc29ddab1c0fc3a62` |
| 2 | `11120994deffbe0be8b5fce19703cb12e30278d58ff9d04f1e8c98f8b453f9437e4e840de9f2ef0e` | `1d9ebc9ecd85ef8e23a65ab3b01a9e7662292b36153804aa35ff6641786f4e49255dc45ab300f349` | `89f2ce47371044f30f0e2efb70e93218d484839c7ad516433635ba23a193244c413470f70ee6ae64` | `471aad416215652058b2b932aa9b8547726619f3ca0e4fcb5752493b04cffe7eb1b2a5af68323cf6` | `0473d22ef51a4218c1a217d1e244f5fa8a9644c54851a2fd889e5a36573894d1622760250b557f458482c8f98af4294412ebe5c8693a63a9247b44cd748b0fe45ffcc00df0b5e2ccde842bcd72235c23` |

(The signature hex is `s ‖ e`; the public keys and the `s = k − e·sk` relation were re-derived
independently, the `(s, e)` pairs come from the reference's published test expectations.)

### 12.3 Gaps in the current oracle — extend it

The following are needed by this dimension and are **not** currently emitted. Add them to
`conformance/oracle/main.go` (new fields on the existing structs; keep the file deterministic — no
clock, no RNG outside the seeded splitmix64) and regenerate.

1. **`curve.json → decodeFailures[]`** — `Fp5` values that must fail to decode. The reference's own
   curve test carries exactly six such values; emit them as `{ wLeHex, w[5] }`. Without this we
   have no negative test for `decode`, which is the only attacker-reachable parser in the crypto
   layer.
2. **`curve.json → pointOps[]`** — for a pair of *non-generator* points `P, Q` given by their
   encodings: `encode(P ⊕ Q)`, `encode(P ⊕ P)`, `encode(mDouble(P, j))` for `j ∈ {0,1,2,5,10}`,
   `encode(⊖P)`. This is what catches an `mDouble` bug; today the vectors only exercise
   generator multiples.
3. **`curve.json → mulAdd[]`** — `encode([s]G ⊕ [e]P)` for pinned `s, e, P`. This is the exact
   verification primitive and it is currently untested in isolation.
4. **`curve.json → window[]`** — the 16 affine `(x, u)` entries of the generator window. Lets the
   table builder be tested before scalar multiplication works.
5. **`curve.json → recode[]`** — for pinned scalars, the 64 signed digits. Cheap, and a recoding
   bug otherwise only shows up as a wrong final point with no localization.
6. **`schnorr.json → negative[]`** — add: neutral (all-zero) public key; `s = n` (i.e. reduces to
   0); `e = n`; a 79-byte and an 81-byte signature; a public key encoding that fails to decode.
7. **`schnorr.json → nonCanonicalAccepted[]`** — a signature re-encoded as `(s + n) ‖ (e + n)` that
   the reference still accepts (§5.3), so our reducing parser's behaviour is pinned rather than
   assumed.

Suggested oracle additions, in reference-API terms (the harness lives in the oracle, never in
`src/`): drive `curve.Decode`, `ECgFp5Point.Add/Double/MDouble`, `curve.MulAddG`,
`ECgFp5Scalar.RecodeSigned`, `ECgFp5Point.MakeWindowAffine`, and
`schnorr.SchnorrSignHashedMessage2` / `schnorr.Validate`. Emit every field element and scalar as an
array of decimal strings **and** as an LE hex string, matching the existing convention.

### 12.4 End-to-end vectors and the randomized-nonce problem

`ref-lighter-go/client/sign_test.go` is a *transaction-shape* test, not a crypto test: it builds
each transaction type with a fixed chain id (`304`), account index (`1`), api key index (`0`) and
nonce (`42`), then asserts field placement and that `Sig` is non-empty. It deliberately does not
pin signature bytes, **because the production signing path samples `k` randomly**.

That gives the recipe for end-to-end vectors:

1. In the oracle, construct each transaction with the same fixed inputs `sign_test.go` uses
   (chain id `304`, account `1`, api key `0`, nonce `42`, and a **pinned `ExpiredAt`** — the Go SDK
   defaults it to `now + 10min − 1s`, which would make the vector non-reproducible, so it must be
   set explicitly).
2. Emit `txInfo.Hash(chainId)` — the 40-byte hashed message. **This is the deterministic part** and
   it is what `tx.json` already pins.
3. Sign with the explicit-`k` entry point, not the production one, and emit the 80-byte signature.
4. Emit the expected `SignedHash` string for each transaction.

Then in TypeScript, the round trip is:

```
tx fields ──(dim 04)──► 40-byte hash ──(compare to tx.json)
              │
              └─ sign with pinned k ──► 80 bytes ──(compare to tx.json)
                                            │
                                            └─ verify() ──► true
```

and, as a belt-and-braces check that our *randomized* signing is also acceptable to the reference:
generate a signature in TypeScript with the default nonce mode, feed `(pubkey, hash, sig)` back
through the oracle's `schnorr.Validate`, and assert it returns no error. That is the only test that
proves an independently derived nonce is wire-compatible; run it in CI as a Go-side fixture check,
not on every unit test run.

### 12.5 Property tests (fast, no oracle needed)

- `decode(encode(P)) == P` for random `P = [s]G`.
- `[a]G ⊕ [b]G == [a + b mod n]G`.
- `[a]([b]G) == [a·b mod n]G`.
- `[n]G == N`, `[n+1]G == G`, `[0]G == N`.
- `verify(pk, m, sign(sk, m))` for random `(sk, m)`, all nonce modes.
- Flipping any single bit of a signature, message, or public key makes `verify` return `false`.
- Round-trip every codec: `fp5 → 40 bytes → fp5`, `scalar → 40 bytes → scalar`,
  `sig → 80 bytes → sig`.
- Determinism: `'hedged'` with entropy stubbed to zeros gives byte-identical signatures across
  calls; with real entropy it does not, but both verify.

---

## 13. Appendix — constants to hard-code

```
p                    = 18446744069414584321                      // 0xFFFFFFFF00000001
epsilon              = 4294967295                                // 2^32 − 1
two-adicity of p−1   = 32
Fp 2^32-th root      = 7277203076849721926                       // POWER_OF_TWO_GENERATOR

Fp5 modulus poly     = X^5 − 3
Fp5 dth root (z)     = 1041288259238279555                       // 3^((p−1)/5)

curve a              = [2, 0, 0, 0, 0]
curve b              = [0, 263, 0, 0, 0]
neutral N            = (0, 0)   →  encode = [0,0,0,0,0]
generator G.x        = [12883135586176881569, 4356519642755055268, 5248930565894896907,
                        2165973894480315022, 2448410071095648785]
generator fractional = z = 1, u = 1, t = 4
encode(G)            = [4, 0, 0, 0, 0]

group order n        = 1067993516717146951041484916571792702745057740581727230159139685185762082554198619328292418486241
n limbs (LE u64)     = [0xE80FD996948BFFE1, 0xE8885C39D724A09C, 0x7FFFFFE6CFB80639,
                        0x7FFFFFF100000016, 0x7FFFFFFD80000007]
cofactor of G        = 1
|E(Fp5)|             = 2n

window width         = 5      → 16 stored multiples, digits in [−15, 16], 64 digits
PubKeyLength         = 40
HashLength           = 40
SignatureLength      = 80

A_w (Weierstrass)    = [6148914689804861439, 263, 0, 0, 0]        // optional, circuit interop only
```

Montgomery constants (`N0I = 0xD78BEF72057B7BDF`, `R2 = 2^640 mod n`, `T632 = 2^632 mod n`) are
verified-correct but are an artifact of Go's lack of big integers. **Do not port them.**
