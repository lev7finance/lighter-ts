# 01 — Crypto Field Layer: Goldilocks `GF(p)` and the Quintic Extension `GF(p^5)`

**Status:** functional specification for a clean-room TypeScript implementation.
**Scope:** the arithmetic substrate that everything else in the Lighter SDK sits on — Poseidon2
hashing, the ecgFp5 elliptic curve, Schnorr signing, key encoding, and transaction hashing.
**Non-goals:** Poseidon2 constants/permutation, the curve group law, the scalar field, Schnorr,
transaction codecs. Those are separate dimensions; this document only guarantees they have a
bit-exact base to stand on.

Everything numeric in this document was mechanically verified against the Go reference by
generating vectors (see §12) and re-deriving each result from an independent model. Where the
reference has a quirk or an outright inconsistency, §10 names it and states whether we preserve it.

---

## 1. Why this layer exists and what depends on it

The Lighter L2 signs transactions with a Schnorr scheme over an elliptic curve defined over
`GF(p^5)`, where `p` is the Goldilocks prime. The message being signed is itself a `GF(p^5)`
element produced by a Poseidon2 sponge over `GF(p)`. Consequently:

| Consumer | What it needs from this layer |
| --- | --- |
| Poseidon2 permutation | `add`, `mul`, `square`, `reduce96`, `reduce128`, x^7 S-box, non-canonical tolerance |
| ecgFp5 curve arithmetic | full `GF(p^5)` field: `add/sub/mul/square/inv/div`, `legendre`, `canonicalSqrt`, `sgn0` |
| Public key encoding | `GF(p^5)` 40-byte little-endian codec |
| Message hash → signature input | `GF(p^5)` 40-byte little-endian codec |
| Scalar multiplication (windowed) | signed 5-bit recoding of a 161-bit two's-complement integer (§9) |

A single wrong bit anywhere here produces a signature the exchange rejects, with no useful error.
This layer must be proven bit-identical, not merely "mathematically correct" — see §11 on the
places where several mathematically-valid answers exist and only one is the wire answer.

---

## 2. The prime

```
p  = 2^64 - 2^32 + 1
   = 18446744069414584321
   = 0xFFFFFFFF00000001
```

Properties that the algorithms below exploit. All of these are load-bearing:

| Fact | Value | Used by |
| --- | --- | --- |
| `2^64 mod p` | `2^32 - 1 = 4294967295` (call it `EPSILON`) | add/sub carry fixups, all reductions |
| `2^96 mod p` | `p - 1` (i.e. `-1`) | 128-bit product reduction |
| `2^128 mod p` | `p - 2^32 = 18446744065119617025` (i.e. `-2^32`) | 192-bit accumulator reduction |
| `p - 1` factorization | `2^32 · 3 · 5 · 17 · 257 · 65537` | two-adicity, 5th roots |
| two-adicity | `32` (`p - 1 = 2^32 · (2^32 - 1)`) | Tonelli–Shanks |
| odd part `t = (p-1)/2^32` | `2^32 - 1 = 4294967295` | Tonelli–Shanks |
| multiplicative generator | `7` (verified: `7^((p-1)/q) ≠ 1` for every prime `q \| p-1`) | field construction |
| 2^32-th root of unity used by the reference | `POWER_OF_TWO_GENERATOR = 7277203076849721926` | Tonelli–Shanks (§5.6) |
| `(p-1)/2` | `9223372034707292160` | Legendre / QR test |
| `(t-1)/2` | `2^31 - 1 = 2147483647` | Tonelli–Shanks warm-up exponent |
| `2^-1 mod p` | `9223372034707292161` | — |
| `p - 1 mod 5` | `0` (so `GF(p)` contains primitive 5th roots of unity) | Frobenius in `GF(p^5)` |

> **Note on `POWER_OF_TWO_GENERATOR`.** It is *not* `7^((p-1)/2^32)` (that value is
> `1753635133440165772`). It is a different primitive 2^32-th root of unity — specifically
> `(7^((p-1)/2^32))^4168946053`. It is inherited verbatim from plonky2. Its exact value changes
> *which* of the two square roots Tonelli–Shanks returns, and that choice propagates all the way
> into `GF(p^5)` square roots and therefore into curve point decompression. **Use this constant
> literally. Do not re-derive it.**

Because `p > 2^63`, we have `2p > 2^64`. This single inequality is what makes the reference's
representation trick work (§3).

---

## 3. Representation: what the reference does, and what we will do

### 3.1 The reference (Go, plonky2 lineage)

`GoldilocksField` is a bare `uint64`. **Plain integer domain, not Montgomery.** Crucially:

* **Every one of the 2^64 `uint64` values is a legal representation of a field element.** Because
  `2p > 2^64`, each `uint64` `x` maps to `x mod p`, and `x mod p` is either `x` or `x - p` — never
  further. So canonicalization is *exactly one conditional subtraction*:

  ```
  toCanonical(x) = x >= p ? x - p : x
  ```

* Arithmetic accepts arbitrary `uint64` inputs and returns results in `[0, 2^64)` that are
  congruent but **not guaranteed canonical**. Concrete witness: `add(p-1, 1)` returns the literal
  value `p`, not `0`. `reduce128` with a zero high word is the identity, so it returns `2^64 - 1`
  unchanged.

* Therefore **equality, zero-testing, sign extraction, and serialization must canonicalize first.**
  The reference does this consistently (`IsZero`, `Equals`, `Sgn0`, `ToLittleEndianBytesF` all go
  through `ToCanonicalUint64`). One reference *test* compares raw `uint64`s and only passes by
  luck; do not copy that pattern.

* A second, unrelated representation also exists in the reference tree: a thin wrapper around
  gnark-crypto's `goldilocks.Element`, which **is** in Montgomery form (`R = 2^64 mod p = 2^32 - 1`,
  `R^2 = 18446744065119617025`, `-p^{-1} mod 2^64 = 18446744069414584319`). It is used only by the
  BN254-Poseidon path and by a handful of byte helpers. **We do not need Montgomery form anywhere.**
  Ignore it, except for the one behavioral difference it introduces in decoding (§7.3).

### 3.2 What TypeScript will do — decision

> **Decision: represent a `GF(p)` element as a `bigint` held in fully-reduced canonical range
> `[0, p)`, in the plain (non-Montgomery) domain, branded as `Fp`.**

Rationale, stated as a decision rather than a menu:

1. **Canonical-only is observationally identical to the reference.** Every value the reference lets
   escape non-canonically is canonicalized before it becomes observable (bytes, equality, parity,
   `IsZero`). Every consumer's precondition (`reduce96` needs its input `< 2^96`; Poseidon2's
   external layer sums ≤ 7 state words) is *weaker* under canonical inputs than under arbitrary
   `uint64` inputs. So restricting to `[0, p)` cannot change a single observable bit, and it removes
   an entire class of bugs.
2. **The non-canonical trick is a Go artifact.** It exists because hardware gives 64-bit wraparound
   for free. In BigInt-land, emulating wraparound costs a `BigInt.asUintN(64, …)` on every operation
   — strictly *more* work than the one conditional subtraction that canonicalization needs. Porting
   the trick would be slower *and* harder to reason about.
3. **No Montgomery form.** Montgomery pays off when reduction requires division. Goldilocks
   reduction is shifts/masks/adds (§4.3); Montgomery would add conversions at every boundary for
   zero benefit and would make the byte codec (§7) diverge from the wire format.
4. **Not two 32-bit `Number` limbs.** A limb representation avoids BigInt allocation, but a
   64×64→128 multiply then needs 16-bit sub-limbs (to stay under 2^53), i.e. 16 partial products
   plus carry plumbing per field multiply, in hand-written JS. Measured against a single
   `bigint` `*` (one machine `mulq` inside V8/JSC for 1-digit BigInts) plus a shift/mask reduction,
   the limb version loses on every engine we target and costs ~5× the code. Revisit only if a
   benchmark (§13, unit `crypto-field-bench`) shows signing exceeding its budget.
5. **Not `BigUint64Array`.** Reading an element out of a `BigUint64Array` allocates a fresh BigInt
   anyway, so it saves nothing and forces wraparound semantics back on us.

**Branding.** Use a zero-cost nominal brand so an unreduced `bigint` can never be passed where a
field element is expected:

```ts
declare const FpBrand: unique symbol;
/** A Goldilocks field element, always canonical: 0 <= value < p. */
export type Fp = bigint & { readonly [FpBrand]: never };
```

Every function in the module takes and returns `Fp`. The only producers of `Fp` from raw data are
`fpFrom*` constructors, all of which reduce. Internally, casts are a single
`as unknown as Fp` in the constructor and in each arithmetic primitive — never in consumer code.

**`GF(p^5)` representation.**

```ts
export type Fp5 = readonly [Fp, Fp, Fp, Fp, Fp];
```

A frozen-by-convention 5-tuple, coefficient `i` = the coefficient of `X^i`. Not a class (classes
defeat tree-shaking and add megamorphic property loads); not a flat `bigint[]` (loses arity in the
type system). Functions are pure and return fresh tuples. Allocation of a 5-element array is cheap
relative to the 5 BigInts it holds, so an out-parameter API is not worth the ergonomic cost.

---

## 4. `GF(p)` — the operations

Notation below: `a`, `b` are canonical (`0 ≤ a,b < p`). `MASK64 = 2^64 - 1`, `MASK32 = 2^32 - 1`,
`EPSILON = 2^32 - 1`.

### 4.1 Addition

Mathematically `(a + b) mod p`.

*Reference algorithm (for cross-reading only):* 64-bit wrapping add producing a carry; add
`EPSILON & -carry` (because `2^64 ≡ EPSILON`); repeat the correction once more, because the first
correction can itself carry. The double correction is required — the reference has a regression
test for exactly this ("double wraparound").

*TypeScript:*
```
s = a + b            // < 2p, no overflow concept in BigInt
return s >= p ? s - p : s
```

There is also `AddCanonicalUint64(lhs, rhs)` in the reference, which assumes `lhs < p` and `rhs`
is an arbitrary `uint64`, and can therefore skip the second carry correction. In TypeScript this
collapses into `add(a, fpFromU64(rhs))` — reduce `rhs` first, then plain add. Keep it as a named
export `addU64` only if the Poseidon2 module wants it; it is not a distinct algorithm.

### 4.2 Subtraction and negation

`sub(a,b)`: `a >= b ? a - b : a - b + p`.
`neg(a)`: `a === 0n ? 0n : p - a`.
`double(a)`: `add(a,a)`.

The reference's `SubF` mirrors `AddF` with borrows and a mandatory double correction.

`NonCannonicalGoldilocksField(x int64)` (sic — the reference misspells "canonical") maps a signed
64-bit integer into the field as `x < 0 ? neg(-x) : x`. TypeScript equivalent: `fpFromInt(x)` =
`((x % p) + p) % p`, which additionally fixes the reference's overflow at `x = -2^63`.

### 4.3 Multiplication, squaring, and the 128-bit reduction — **the core primitive**

This is the only piece of the field layer where the exact algorithm matters for performance rather
than for correctness of the result. State it mathematically:

Let `x = a·b`, so `0 ≤ x < p^2 < 2^128`. Decompose:

```
lo = x mod 2^64          (64 bits)
hi = floor(x / 2^64)     (64 bits)
hh = floor(hi / 2^32)    (32 bits)   -- "hi_hi"
hl = hi mod 2^32         (32 bits)   -- "hi_lo"
```

Then, using `2^64 ≡ 2^32 - 1` and `2^96 ≡ -1` (mod p):

```
x = lo + hl·2^64 + hh·2^96  ≡  lo + hl·(2^32 - 1) - hh   (mod p)
```

**Required TypeScript form (validated against the Go vectors and against `x mod p` on 3·10^5
random inputs at 64/100/128 bits):**

```
function reduce128(x /* 0 <= x < 2^128 */): Fp {
  const lo = x & MASK64;
  const hi = x >> 64n;
  const hh = hi >> 32n;          // < 2^32
  const hl = hi & MASK32;        // < 2^32
  let r = lo + hl * EPSILON - hh;   // in (-2^32, 2^65)
  if (r < 0n) r += P;               // at most one fixup
  if (r >= P) r -= P;               // at most two fixups
  if (r >= P) r -= P;
  return r;
}
mul(a,b)    = reduce128(a * b)
square(a)   = reduce128(a * a)
mulAcc(s,x,y) = add(s, mul(x,y))     // see 4.4
```

Bound proof for the three fixups: `lo < 2^64`, `hl·EPSILON < 2^64`, so `r < 2^65 - 2^32`; and
`r > -2^32`. `2^65 - 2^32 < 3p`, so at most two subtractions after at most one addition. Do not
replace the fixups with `%` — a BigInt division is ~4–8× the cost of the compare-and-subtract chain.

*Reference note (do not port):* the Go version performs the same reduction with hardware borrow/
carry flags, and its `MulF` returns a possibly non-canonical `uint64`. There is also a
`branchHint()` assembly stub (literally `NOP; RET`) used in the reference's *benchmarks only* to
steer Go's branch layout. It is a micro-optimization artifact with zero semantic content and has
no TypeScript analogue.

### 4.4 Fused multiply-accumulate

`MulAccF(self, x, y) = self + x·y (mod p)`. The reference computes the 128-bit product, adds `self`
into the low word with carry into the high word, then runs the same reduction. Mathematically it
is exactly `add(self, mul(x,y))` and is verified equal on all vectors. In TypeScript, express it as
`reduce128(a*b + s)` — note `a·b + s < p^2 + p < 2^128`, so the single reduction still applies and
this saves one conditional-subtraction chain versus `add(s, mul(a,b))`.

### 4.5 Narrower reductions used by Poseidon2

The Poseidon2 layers accumulate sums of state words in a wider accumulator and reduce once.
Two entry points exist:

* **`reduce96(x)`**, precondition `x < 2^96` (i.e. high word `< 2^32`). Mathematically
  `x mod p`, implemented as `lo + hi·(2^32-1)` with a single carry fixup, where `hi = x >> 64`.
  In TypeScript this is just `reduce128(x)` — one extra compare in exchange for deleting a
  precondition that is easy to violate silently. **Recommendation: do not expose `reduce96`
  separately. Export only `reduce128`, and document its domain as `[0, 2^128)`.**

* **`reduceWide(x)`**, precondition `x < 2^192` — the `acc192` reduce in the reference. Using
  `2^128 ≡ -2^32`:

  ```
  reduceWide(x) = reduce128(x mod 2^128) - reduce128((x >> 128n) << 32n)   (mod p)
  ```
  with a single `if (r < 0n) r += P` fixup. Validated on 3·10^5 random 130/160/192-bit inputs.
  This is what `GF(p^5)` multiplication needs (§8.4).

### 4.6 Exponentiation

`exp(x, e)`: square-and-multiply, scanning `e` from the least-significant bit, `e` an arbitrary
non-negative integer (the reference takes `uint64`; TypeScript should take `bigint` and reject
negatives). Variable-time (§11.3).

`expPow2(x, n)`: `n` repeated squarings. Used pervasively; export it.

### 4.7 Inversion — exact addition chain

`inverseOrZero(0) = 0`. Otherwise `x^(p-2)` via this chain (verified: the chain computes exactly
`x^(2^64 - 2^32 - 1) = x^(p-2)`):

| step | definition | exponent |
| --- | --- | --- |
| `t2`  | `square(x) · x`            | `2^2 - 1 = 3` |
| `t3`  | `square(t2) · x`           | `2^3 - 1 = 7` |
| `t6`  | `expPow2(t3, 3) · t3`      | `2^6 - 1` |
| `t12` | `expPow2(t6, 6) · t6`      | `2^12 - 1` |
| `t24` | `expPow2(t12,12) · t12`    | `2^24 - 1` |
| `t30` | `expPow2(t24, 6) · t6`     | `2^30 - 1` |
| `t31` | `square(t30) · x`          | `2^31 - 1` |
| `t63` | `expPow2(t31,32) · t31`    | `2^63 + 2^31 - 2^32 - 1` |
| out   | `square(t63) · x`          | `2^64 - 2^32 - 1 = p - 2` |

Cost: 72 squarings + 8 multiplications. Keep this chain — it is ~20% cheaper than a generic
63-bit ladder and, more importantly, it has no data-dependent branching (beyond the `isZero` test),
which is the closest thing to constant-time we can achieve.

`inverse(x)` = same, but throws `FieldError("inverse of zero")` on zero. Prefer `inverseOrZero`
internally; the extension field's inversion depends on the zero-returning behaviour.

**Batch inversion.** The reference has none. Add `batchInverse(xs: Fp[]): Fp[]` using Montgomery's
trick (running products, one `inverseOrZero`, back-substitution), with zeros mapping to zeros.
`GF(p^5)` inversion and curve normalization both benefit; this is a real ergonomics win over the
reference.

### 4.8 Quadratic residue test

```
isQuadraticResidue(x) = true             if x == 0
                      = (x^((p-1)/2) == 1)
```
`x^((p-1)/2)` is always `1` or `p-1` for `x ≠ 0`; the reference panics on anything else (an
unreachable branch). In TypeScript, return a boolean and do not throw.

### 4.9 Square root — **must be bit-exact**

There are always two roots; the reference picks one deterministically and everything downstream
(including `GF(p^5)` sqrt and curve decompression) depends on *which*. Reproduce this exact
Tonelli–Shanks variant. It was verified digit-for-digit against 57 Go-produced roots.

```
sqrt(x) -> Fp | null
  if x == 0: return 0
  if not isQuadraticResidue(x): return null
  t  = (p - 1) / 2^32          = 4294967295
  z  = 7277203076849721926     (POWER_OF_TWO_GENERATOR)
  w  = exp(x, (t - 1) / 2)     = exp(x, 2147483647)
  r  = mul(x, w)               // running root
  b  = mul(r, w)               // x^t
  v  = 32                      (TWO_ADICITY)
  while b != 1:
      k = 0; b2k = b
      while b2k != 1: b2k = square(b2k); k += 1
      j = v - k - 1
      w = z; repeat j times: w = square(w)
      z = square(w)
      b = mul(b, z)
      r = mul(r, w)
      v = k
  return r
```

Notes for the implementer:
* `exp(x, 2^31 - 1)` is an all-ones exponent; implement it as `y = x; repeat 30 times { y = mul(square(y), x) }`
  (30 squarings + 30 multiplications) or via the generic `exp` — both give identical results.
* Comparisons `b != 1` are on canonical values. If you ever relax canonicality, this loop silently
  becomes an infinite loop.
* **Do not substitute gnark's square root.** gnark-crypto's `Sqrt` for the same field uses a
  different non-residue seed (`15733474329512464024`, in Montgomery form) and returns *the other
  root* for some inputs. It is not interchangeable.

### 4.10 Miscellaneous

`powers(e, n)`: `[1, e, e^2, …, e^(n-1)]`. Used by the reference's Frobenius; in TypeScript we
replace that use with precomputed tables (§8.5), but keep `powers` exported — Poseidon2 and the
curve want it.

---

## 5. `GF(p)` serialization

* **Element width: 8 bytes. Byte order: little-endian. Value: canonical.**
* `toBytes(a) -> Uint8Array(8)`: write `toCanonical(a)` as a 64-bit little-endian integer.
* `fromBytes(b)`: read 8 bytes little-endian as a `uint64`.

### 5.1 The validation asymmetry (important)

The reference exposes **two** functions whose names both say "FromCanonicalLittleEndianBytes" and
which behave differently:

| Function | Length check | Value `< p` check |
| --- | --- | --- |
| `goldilocks.FromCanonicalLittleEndianBytesF` (plonky2 path, `uint64` domain) | none (indexes 8 bytes) | **none** — accepts `[p, 2^64)` and keeps it non-canonically |
| `goldilocks.FromCanonicalLittleEndianBytes` (gnark path, Montgomery domain) | must be exactly 8 | **yes** — errors if the value ≥ p |
| `gFp5.FromCanonicalLittleEndianBytes` (40 bytes) | must be exactly 40 | **none**, for any of the 5 limbs |

**TypeScript design decision:** decoders are strict by default.

```ts
fpFromBytes(b: Uint8Array): Fp                  // throws if b.length !== 8 or value >= p
fpFromBytesUnchecked(b: Uint8Array): Fp         // reduces instead of throwing
```

Strictness matters because a non-canonical encoding is a *second* valid byte string for the same
public key / message hash — i.e. encoding malleability. Since our own encoder never emits one, and
the exchange's encoder (Go, via `ToLittleEndianBytes*`) never emits one either, strict decoding
rejects only malformed input. The `Unchecked` variant exists so that a caller who has to interop
with a sloppy producer can opt in explicitly. Same policy for `GF(p^5)` (§8.9).

### 5.2 Array decoding with zero padding

`ArrayFromCanonicalLittleEndianBytes(in)` splits `in` into `ceil(len/8)` groups of 8 bytes;
the final group, if short, is **zero-padded on the right** (the supplied bytes are the low-order
bytes; the missing high-order bytes are zero). Each group must satisfy `value < p` or the whole
call fails. (The reference contains a dead padding branch — the effective behaviour is exactly as
described.)

`ArrayToLittleEndianBytes(es)` = concatenation of `toBytes(e)` in order; output length `8·n`.

---

## 6. `GF(p^5)` — construction

```
GF(p^5) = GF(p)[X] / (X^5 - 3)
```

`X^5 - 3` is irreducible over `GF(p)` (equivalently, 3 is not a 5th power in `GF(p)`). The
reference names the constant `FP5_W = 3`; the reduction rule is:

```
X^5 ≡ 3,   X^6 ≡ 3X,   X^7 ≡ 3X^2,   X^8 ≡ 3X^3
```

An element is the 5-tuple `(a0, a1, a2, a3, a4)` meaning `a0 + a1·X + a2·X^2 + a3·X^3 + a4·X^4`.
`|GF(p^5)| = p^5 = 2135987033434293902082969833143585405490115481162544232032811052120416417467265840012020259225601` (320 bits).

Constants:

| Name | Value | Meaning |
| --- | --- | --- |
| `FP5_D` | `5` | extension degree |
| `FP5_W` | `3` | `X^5 = W` |
| `FP5_DTH_ROOT` | `1041288259238279555` | `= 3^((p-1)/5) mod p`; a primitive 5th root of unity; verified `order == 5` |
| `FP5_ZERO/ONE/TWO` | `(0,0,0,0,0) / (1,0,0,0,0) / (2,0,0,0,0)` | |
| `Bytes` | `40` | `5 × 8` |

---

## 7. `GF(p^5)` — arithmetic

### 7.1 Add, sub, neg, double, triple, scalar-mul

All coefficient-wise:
```
add(a,b)[i]        = fpAdd(a[i], b[i])
sub(a,b)[i]        = fpSub(a[i], b[i])
neg(a)[i]          = fpNeg(a[i])
double(a)          = add(a,a)
triple(a)[i]       = fpMul(a[i], 3)
scalarMul(a, c)[i] = fpMul(a[i], c)          // c: Fp
fromFp(c)          = (c, 0, 0, 0, 0)
```

### 7.2 Multiplication

With `X^5 = 3`, the schoolbook product folded once gives:

```
c0 = a0·b0 + 3·(a1·b4 + a2·b3 + a3·b2 + a4·b1)
c1 = a0·b1 + a1·b0 + 3·(a2·b4 + a3·b3 + a4·b2)
c2 = a0·b2 + a1·b1 + a2·b0 + 3·(a3·b4 + a4·b3)
c3 = a0·b3 + a1·b2 + a2·b1 + a3·b0 + 3·(a4·b4)
c4 = a0·b4 + a1·b3 + a2·b2 + a3·b1 + a4·b0
```

**Lazy reduction is mandatory for performance and permitted for correctness.** Accumulate each
`c_k` as an exact integer (BigInt) and reduce once:

* Largest accumulator is `c0`: 1 + 4 terms scaled by 3 ⇒ bounded by `13·(p-1)^2 < 2^132`.
  (Measured maximum bit length over the vector corpus: **131 bits**.)
* Therefore a single `reduceWide` (§4.5, domain `< 2^192`) suffices for every `c_k`.

Validated: this formulation reproduces all 87 Go `Mul` vectors exactly.

*Reference note:* the Go code implements the same thing with a hand-rolled 192-bit accumulator
(`acc192{lo,mid,hi}`) and specialised `addProduct`, `addProduct2`, `addProduct3`, `addProduct6`
helpers that pre-scale a 128-bit product by 1/2/3/6 via shift-and-add. **All of that is Go-specific
scaffolding for the absence of a 128-bit integer type. In TypeScript it evaporates:
`3n * a1 * b4` is one expression.** Deleting it is a genuine simplification, not a shortcut.

### 7.3 Squaring

Same folding with the cross terms merged:

```
c0 = a0^2 + 6·a1·a4 + 6·a2·a3
c1 = 2·a0·a1 + 6·a2·a4 + 3·a3^2
c2 = 2·a0·a2 + a1^2 + 6·a3·a4
c3 = 2·a0·a3 + 2·a1·a2 + 3·a4^2
c4 = 2·a0·a4 + 2·a1·a3 + a2^2
```

Same accumulation and single `reduceWide` per coefficient. 15 base multiplications vs 25 for the
general product — keep `square` as a distinct export; the curve and sqrt paths call it heavily.

### 7.4 Division

`div(a, b) = mul(a, inverseOrZero(b))`, and **throw on `b == 0`** (the reference panics). Prefer
exposing `inverseOrZero` plus `mul` and making `div` a thin convenience.

### 7.5 Frobenius

The Frobenius endomorphism is `φ(x) = x^p`. Since `X^p = X·(X^5)^((p-1)/5) = X·3^((p-1)/5) = X·ζ`
with `ζ = FP5_DTH_ROOT`, the `n`-fold Frobenius acts coefficient-wise:

```
frobenius^n (a)[i] = a[i] · (ζ^n)^i,      i = 0..4
```

`frobenius^n` for `n ≡ 0 (mod 5)` is the identity.

**TypeScript improvement:** the reference recomputes `ζ^n` and then a `powers(...)` table on every
call, with a recursive `count % 5` reduction. Replace that with four frozen constant tables (values
computed and verified here):

```
FROB1 = [1, 1041288259238279555, 15820824984080659046,   211587555138949697,  1373043270956696022]
FROB2 = [1, 15820824984080659046, 1373043270956696022,  1041288259238279555,  211587555138949697]
FROB3 = [1,  211587555138949697, 1041288259238279555,   1373043270956696022, 15820824984080659046]
FROB4 = [1, 1373043270956696022,  211587555138949697,  15820824984080659046, 1041288259238279555]
```

`frobenius(a) = repeatedFrobenius(a, 1)`; `repeatedFrobenius(a, n)` selects `FROB[n mod 5]`
(identity for `0`) and does 4 base multiplications (coefficient 0 is unchanged, since every table
starts with `1`).

### 7.6 Norm

`N(x) = x^(1 + p + p^2 + p^3 + p^4) = x · φ(x) · φ^2(x) · φ^3(x) · φ^4(x)` lies in `GF(p)`.
The reference never names it but computes it twice (inside `inverseOrZero` and `legendre`).
**Export `norm(x): Fp` explicitly** — it makes both call sites obvious and is independently
testable. Verified: the coefficients 1..4 of the full product are always zero.

### 7.7 Inversion

Standard norm trick, exactly as the reference does it:

```
d = φ(a)                              // a^p
e = d · φ(d)                          // a^(p + p^2)
f = e · φ^2(e)                        // a^(p + p^2 + p^3 + p^4)
g = (a · f)[0]                        // = N(a), an Fp element
    = a0·f0 + 3·(a1·f4 + a2·f3 + a3·f2 + a4·f1)
a^-1 = scalarMul(f, fpInverse(g))
inverseOrZero(0) = FP5_ZERO
```

Only coefficient 0 of `a·f` needs computing (the rest are provably zero) — that shortcut is worth
keeping. Cost: 3 Frobenius (12 base muls), 2 `GF(p^5)` muls, 5 base muls + 4 adds for `g`,
1 base inversion, 5 base muls for the final scaling.

### 7.8 Legendre symbol

```
legendre(x) = 0                       if N(x) == 0   (i.e. x == 0)
            = N(x)^((p-1)/2)          otherwise     (∈ {1, p-1})
```

The reference computes `N(x)` via `x · (φ(x)·φ^2(x)) · φ^2(φ(x)·φ^2(x))`, then
`N^(2^63) · (N^(2^31))^{-1}` (which equals `N^(2^63 - 2^31) = N^((p-1)/2)`), relying on
`inverseOrZero(0) = 0` to produce `0` for `x = 0`. Either formulation is bit-identical; prefer the
explicit `norm` + `exp(·, (p-1)/2)` with an explicit zero check, and note the chain variant
(31 squarings, 32 squarings, one inversion) in a comment as the cheaper option to benchmark.

`x` is a square in `GF(p^5)` iff `legendre(x) ∈ {0, 1}`.

### 7.9 Square root — **must be bit-exact**

The algorithm pushes the problem down to a base-field square root by finding `e` such that
`x·e^2 ∈ GF(p)` (verified for every corpus element: coefficients 1..4 of `x·e^2` are always zero).

```
sqrt(x) -> { root: Fp5, exists: boolean }

  v = expPow2_fp5(x, 31)                    // x^(2^31), 31 squarings
  d = mul(mul(x, expPow2_fp5(v, 32)), inverseOrZero(v))
                                            // = x^(1 + 2^63 - 2^31)
  e = frobenius( mul(d, repeatedFrobenius(d, 2)) )     // = d^(p + p^3)
  f = square(e)
  g = x0·f0 + 3·(x1·f4 + x2·f3 + x3·f2 + x4·f1)        // = (x·f)[0], an Fp element
  s = fpSqrt(g)                              // §4.9 — the exact plonky2 Tonelli–Shanks
  if s is null: return { root: FP5_ZERO, exists: false }
  return { root: mul(fromFp(s), inverseOrZero(e)), exists: true }
```

Edge case `x = 0`: `v = 0`, `inverseOrZero(0) = 0`, so `d = e = f = g = 0`, `fpSqrt(0) = 0`,
`inverseOrZero(0) = 0`, result `(0,0,0,0,0)` with `exists = true`. This is the reference's
behaviour and the vectors confirm it.

This whole procedure was re-derived independently and matched the Go output on all 87 corpus
elements, including the 32 non-squares. The chosen root depends on `fpSqrt`'s root choice, hence
on `POWER_OF_TWO_GENERATOR` — see §2.

### 7.10 `sgn0` and `canonicalSqrt`

The reference's `Sgn0` is written as a five-iteration "first non-zero limb" loop, but **it provably
reduces to a single test** (verified over the entire corpus):

```
sgn0(x) = (toCanonical(x[0]) is EVEN)
```

Proof sketch: the loop's accumulator is `OR_i ( x[0..i-1] all zero AND x[i] even )`. At `i = 0` the
prefix is empty (`zero = true`), so the term is `x0 even`. If `x0` is even the result is already
true; if `x0` is odd then `x0 ≠ 0`, so `zero` becomes false and no later term can fire.

**This is inverted relative to the RFC 9380 / ecgFp5-Rust convention**, which uses "first non-zero
limb is ODD". The Go reference tests `&1 == 0`. See §10.1 — we preserve the Go behaviour.

```
canonicalSqrt(x):
   (r, ok) = sqrt(x)
   if !ok: return (FP5_ZERO, false)
   return (sgn0(r) ? neg(r) : r, true)
```

Consequence: `canonicalSqrt` returns the root whose coefficient 0 is **odd** — except when
coefficient 0 is `0` for both roots, in which case it returns `neg(sqrt(x))` unconditionally
(still deterministic, because `sqrt` is; see §10.2).

### 7.11 Equality, zero test, hashing

```
equals(a,b) = all i: toCanonical(a[i]) == toCanonical(b[i])
isZero(a)   = all i: toCanonical(a[i]) == 0
```
Under the canonical-only TypeScript representation these are plain `===` comparisons over the
tuple. **Never expose an `Fp5` as a map key or use `JSON.stringify` for identity** — use `toBytes`
(§8.9) as the canonical identity, hex-encoded if a string key is needed.

---

## 8. `GF(p^5)` serialization

* **Width: 40 bytes.** Coefficient `i` occupies bytes `[8i, 8i+8)`, each written as a canonical
  8-byte little-endian `uint64`. Coefficient 0 first.
* Encode: `concat(fpToBytes(a[0]) … fpToBytes(a[4]))`.
* Decode: reject unless `length === 40`; parse 5 little-endian `uint64`s.
* **Reference validation: length only.** Per-limb canonicity is *not* checked. Our default decoder
  additionally rejects any limb ≥ p (see §5.1 rationale); `fp5FromBytesUnchecked` reduces instead.

Golden layout example — for
`a = (0x1234567890ABCDEF, 0x0FEDCBA987654321, 0x1122334455667788, 0x8877665544332211, 0xAABBCCDDEEFF0011)`
the 40 bytes are:

```
coeff 0 (0x1234567890ABCDEF) -> ef cd ab 90 78 56 34 12
coeff 1 (0x0FEDCBA987654321) -> 21 43 65 87 a9 cb ed 0f
coeff 2 (0x1122334455667788) -> 88 77 66 55 44 33 22 11
coeff 3 (0x8877665544332211) -> 11 22 33 44 55 66 77 88
coeff 4 (0xAABBCCDDEEFF0011) -> 11 00 ff ee dd cc bb aa
```
Concatenated hex string:
`efcdab907856341221436587a9cbed0f887766554433221111223344556677881100ffeeddccbbaa`

This is exactly the encoding used for the 40-byte Schnorr public key and for the 40-byte message
hash fed into signing.

---

## 9. `int/` — 128-bit helpers and the signed 161-bit recoder

### 9.1 `UInt128` — delete it

The reference's `UInt128{Hi, Lo}` with `AddUInt128`, `AddUint128AndUint64`, `SubUint128AndUint64`,
`MulUInt64`, `MulUint128AndUint64` exists solely because Go has no 128-bit integer. **In TypeScript
it has no reason to exist**: a `bigint` is exact at any width, and the only places its wraparound
semantics matter are the reductions, which §4.5 already specifies over exact integers.

**Decision: do not port `UInt128`.** Export `reduce128` and `reduceWide` and nothing else from this
area. This removes ~5 exported functions and a whole class of Hi/Lo mix-ups.

### 9.2 `Signed161` and `RecodeSigned5` — keep, but reformulate

Needed by windowed scalar multiplication on the curve (`WINDOW = 5`, digits array length
`(319 + 5)/5 = 64` for full scalars; 33 for the 161-bit half-scalars produced by GLV-style
splitting).

**Data model.** `Signed161` is three `uint64` limbs holding a two's-complement integer truncated to
161 bits: bits 0..63 in limb 0, 64..127 in limb 1, 128..160 in limb 2 (only its low 33 bits are
meaningful; bit 32 of limb 2 is the sign bit). Value range `[-2^160, 2^160)`.

**`toU192` (sign extension).** Produce a 192-bit two's-complement value: keep limbs 0 and 1;
limb 2 becomes `(limb2 & 0x1FFFFFFFF)` with bits 33..63 set to the replicated sign bit
(i.e. OR in `0xFFFFFFFE00000000` when bit 32 is set, else nothing).

**`recodeSigned5` (33 signed base-32 digits).**

```
1. sign-extend to 192 bits
2. add 2^160  (i.e. add 0x0000000100000000 to limb 2)  -> value now in [0, 2^161)
3. produce 33 digits, LSB-first, base 32, with carry propagation:
      carry = 0
      for i in 0..32:
          bb = (5-bit window i of the value) + carry
          carry = (bb > 16) ? 1 : 0
          digit[i] = bb - 32*carry
4. digit[32] -= 1     (undoes the +2^160, since 32^32 = 2^160)
```

**Guaranteed properties (verified on 53 vectors, including all-zeros, all-ones, and the reference's
own fixed vector):**
* `digit[i] ∈ [-15, 16]`
* `Σ digit[i] · 32^i` equals the original signed value **exactly**

**TypeScript reformulation (validated bit-identical against the Go output on every vector):**
work on a single `bigint` instead of limbs.

```ts
export function recodeSigned5(n: bigint): Int32Array /* length 33 */ {
  let m = n + (1n << 160n);            // n ∈ [-2^160, 2^160)
  const out = new Int32Array(33);
  let carry = 0;
  for (let i = 0; i < 33; i++) {
    const bb = Number((m >> BigInt(5 * i)) & 31n) + carry;
    carry = bb > 16 ? 1 : 0;
    out[i] = bb - (carry << 5);
  }
  out[32] -= 1;
  return out;
}
```

This is dramatically simpler than the reference's limb/accumulator bookkeeping
(`acc`/`accLen`/`j`/`cc` state machine with a `(hw - bb) >> 31` branchless sign test) and produces
identical digits. **Do not port the accumulator machine.**

**Generic width.** The reference also exposes `RecodeSignedFromLimbs(limbs, out, w)` for arbitrary
window `w`, used by the 320-bit scalar field with `w = 5`. Generalize the above to
`recodeSignedDigits(n: bigint, count: number, w: number)`; the carry rule becomes
`carry = bb > 2^(w-1) ? 1 : 0`, `digit = bb - carry·2^w`, digits in `[-(2^(w-1) - 1), 2^(w-1)]`.
The 161-bit variant is then `recodeSignedDigits(n + 2^160, 33, 5)` with the final `-1` fixup.
**Caveat:** the unsigned 320-bit scalar path calls the recoder on a non-negative value with no
`+2^160` offset and no final fixup — that difference belongs to the scalar-field spec, not here;
this module only needs to expose the primitive with the offset/fixup as explicit arguments.

---

## 10. Reference quirks: what we preserve and what we fix

### 10.1 `Sgn0` is inverted relative to the standard — **PRESERVE**
The reference tests `limb & 1 == 0` ("even"); RFC 9380 and the Rust ecgFp5 reference test
`limb & 1 == 1` ("odd"). Since `canonicalSqrt` feeds curve point decompression and the exchange's
verifier runs the Go code, we must match the Go behaviour bit-for-bit. **Preserve, and put a
prominent comment at the definition site** explaining that this is deliberate and that "fixing" it
will silently produce wrong public keys.

### 10.2 `canonicalSqrt` is not canonical when coefficient 0 is zero — **PRESERVE, DOCUMENT**
If both roots have `a0 = 0`, `sgn0` is true for both, so `canonicalSqrt` returns `neg(sqrt(x))`
rather than a lexicographically determined root. It is still deterministic (because `sqrt` is), so
interop is safe, but the function does not satisfy its name's contract. Document it; do not change it.

### 10.3 `FromCanonicalLittleEndianBytes*` does not check canonicity — **FIX (opt-in escape hatch)**
See §5.1. Strict by default, `*Unchecked` variants for compatibility.

### 10.4 Two functions with near-identical names and different validation — **FIX**
Collapse to one strict `fpFromBytes` / `fp5FromBytes` pair plus explicit unchecked variants. Do not
reproduce the `…BytesF` / `…Bytes` suffix distinction, which encodes "plonky2 vs gnark" internals
that have no meaning in our library.

### 10.5 `NonCannonicalGoldilocksField` — **FIX**
Misspelled, and overflows at `x = -2^63`. Replace with `fpFromInt(x: bigint)` doing a proper
Euclidean reduction.

### 10.6 `UInt128`, `acc192`, `addProduct{,2,3,6}`, `branchHint` — **DELETE**
Pure Go-language scaffolding (§7.2, §9.1, §4.3). None of it survives translation.

### 10.7 `Reduce96Bit` has an unchecked precondition — **FIX**
It silently produces garbage if the high word ≥ 2^32. Fold it into `reduce128` (§4.5).

### 10.8 `Sample()` uses `crypto/rand` per limb — **REDESIGN**
Do not export a `sample()` that reaches for randomness implicitly. Export
`fpFromRandomBytes(bytes: Uint8Array)` / `fp5FromRandomBytes(bytes: Uint8Array)` (rejection- or
reduction-based, documented) and let the caller supply entropy from `crypto.getRandomValues`.
This keeps the field module free of any platform capability requirement — important for Cloudflare
Workers and for testability.

### 10.9 The reference's `Legendre` recomputes the norm inline — **FIX**
Factor out `norm()` (§7.6) and use it in both `inverseOrZero` and `legendre`.

---

## 11. Cross-cutting requirements

### 11.1 Environment constraints
* BigInt literals require **ES2020+**; set `target: "ES2022"`, `module`/`moduleResolution` for
  ESNext/bundler. All targets (Bun 1.3, Node 20+, Deno, Cloudflare Workers, evergreen browsers)
  support BigInt natively.
* **Zero runtime dependencies.** This module imports nothing — not even `node:buffer`. Byte I/O uses
  `Uint8Array` and `DataView` only.
* **No side effects at module scope** beyond `const` initialisers (BigInt literals and frozen arrays).
  `package.json` must declare `"sideEffects": false` so the constant tables (§7.5) tree-shake away
  when unused.
* Every symbol is a top-level `export function` or `export const`. No default export, no barrel that
  re-exports everything eagerly into one chunk; the package `exports` map should expose
  `./crypto/field` as its own entry point so a consumer that only needs REST types never pulls in
  BigInt code.

### 11.2 Error model
Define one error class for the whole crypto layer, e.g. `class FieldError extends Error`. Throw on:
inverse of zero, division by zero, wrong byte length, non-canonical bytes in strict mode. Never
throw from `inverseOrZero`, `sqrt` (returns `null` / `{exists:false}`), `legendre`, or any arithmetic.

### 11.3 Timing / side channels — state the truth
The Go reference explicitly documents parts of this code as variable-time. In JavaScript, BigInt
arithmetic is inherently variable-time (operation cost depends on magnitude and on engine
small-value fast paths), and there is **no way to write constant-time code in pure TypeScript**.
Requirements:
* `inverseOrZero` uses the fixed addition chain (§4.7) — no data-dependent iteration count.
* `sqrt`, `legendre`, `exp` are variable-time by construction. They are only ever applied to public
  values (message hashes, public keys, curve points), never to a private key.
* The package README must carry an explicit "not side-channel hardened; do not run on untrusted
  co-tenant hardware with attacker-controlled timing observation" note. This is honest and matches
  the reference's own posture.

### 11.4 Allocation discipline
* Hoist all constants (`P`, `EPSILON`, `MASK32`, `MASK64`, `THREE`, Frobenius tables) to module scope.
* In `mul`/`square` for `GF(p^5)`, build the five accumulators as local `bigint`s and construct the
  result tuple once. Do not allocate intermediate arrays.
* Avoid `BigInt(number)` inside loops (it allocates); precompute shift amounts as `bigint` constants.
* Do not use `**` on BigInt in hot paths.

---

## 12. Cross-language test vectors — generation and use

The Go toolchain is present in this environment (`go1.24.4 darwin/arm64` at `/opt/homebrew/bin/go`).
A working generator has already been built and run; the produced corpus is at
`…/scratchpad/spec/vectors/field-vectors.json` (355 KB).

### 12.1 Where the generator lives (clean-room constraint)

The generator is Go code that **imports the reference library**. It must **not** live in
`lev7finance/lighter-ts`. Keep it in a sibling scratch/tools checkout. Only the *generated JSON*
— which is protocol data, not authored code — is committed to the TypeScript repo, under
`test/vectors/field-vectors.json`.

### 12.2 Exact commands

```bash
# 0. prerequisites
command -v go                       # -> /opt/homebrew/bin/go   (go1.24.4)
REF=/path/to/ref-poseidon-crypto    # clone of elliottech/poseidon_crypto
GEN=/path/to/vectorgen              # OUTSIDE the lighter-ts repo

# 1. one-time: module wiring (replace directive points at the local reference checkout)
mkdir -p "$GEN" && cd "$GEN"
cat > go.mod <<'EOF'
module vectorgen
go 1.23
require github.com/elliottech/poseidon_crypto v0.0.0
replace github.com/elliottech/poseidon_crypto => ../ref-poseidon-crypto
EOF
# main.go: see 12.3 for exactly what it must emit
go mod tidy

# 2. sanity-check the reference itself before trusting it
cd "$REF" && go build ./... && go test ./field/...
#   expected: ok  github.com/elliottech/poseidon_crypto/field

# 3. generate (deterministic — byte-identical on every run)
cd "$GEN" && go run . > /path/to/lighter-ts/test/vectors/field-vectors.json

# 4. verify determinism before committing
cd "$GEN" && go run . | shasum -a 256
```

### 12.3 Generator contract

* **Determinism is mandatory.** All pseudo-random inputs come from an inlined `splitmix64` stream
  with a fixed seed (`0x0DDC0FFEEBADF00D`), *not* `crypto/rand` and *not* `math/rand` (whose
  algorithm is not stable across Go releases). Re-running must produce a byte-identical file, so
  the JSON can be committed and diffed.
* **All `uint64` values are emitted as decimal *strings*.** `JSON.parse` produces `number`, which
  silently loses precision above 2^53. The TypeScript loader does `BigInt(s)`.
* **Inputs are emitted raw (possibly ≥ p); outputs are emitted canonical** (`ToCanonicalUint64`).
  This lets the TypeScript side test its "reduce on ingest" path against the Go non-canonical
  tolerance without needing to model non-canonical state.
* **Corpus composition** — each section mixes a hand-picked edge-case list with pseudo-random draws.
  The edge list must include: `0, 1, 2, 3, 7, 8`, `2^31 ± 1`, `2^32 ± 1`, `2^32 - 2`, `2^63`,
  `2^63 - 1`, `(p+1)/2`, `p-2`, `p-1`, `p`, `p+1`, `p+2`, `2^64 - 2`, `2^64 - 1`.

### 12.4 Corpus sections (current sizes)

| JSON key | rows | fields |
| --- | --- | --- |
| `constants` | — | `p`, `pHex`, `epsilon`, `twoAdicity`, `powerOfTwoGenerator`, `multiplicativeGenerator`, `fp5W`, `fp5DthRoot`, `fpBytes`, `fp5Bytes` |
| `fpBinary` | 122 | `A B Add Sub Mul AddCanonU64` |
| `fpUnary` | 122 | `A Canon Neg Square Inv IsQR Sqrt(nullable)` |
| `fpExp` | 64 | `A E R` |
| `fpReduce` | 96 | `Hi Lo R96 R128` |
| `fpMulAcc` | 64 | `A X Y R` |
| `fpSerialize` | 122 | `A LE(hex) Round` |
| `fp5Binary` | 87 | `A[5] B[5] Add[5] Sub[5] Mul[5] Div[5]` |
| `fp5Unary` | 87 | `A[5] Square Neg Double Triple Inv Frob1..Frob4 Legendre Sgn0 HasSqrt Sqrt CanonicalSqrt LEBytes` |
| `signed161Recode` | 53 | `Limbs[3] U192[3] Digits[33]` |

`fp5` fixed elements deliberately included: `ZERO`, `ONE`, `TWO`, the reference's own
`0x1234567890ABCDEF…` vector, the all-`0xFFFFFFFFFFFFFFFF` vector, a mixed canonical/non-canonical
vector, and `263` (the curve's `B` coefficient — a known non-square, so `HasSqrt = false`).
Corpus balance achieved: 55/87 elements have square roots, 32 do not.
`Div` rows where `B == 0` carry `Div = [0,0,0,0,0]` by generator convention (the Go function panics);
the TypeScript test must assert a throw for that row instead of comparing.

### 12.5 TypeScript conformance test plan

One `field.vectors.test.ts` that loads the JSON once and drives:
1. every `fpBinary` row through `add/sub/mul` (inputs reduced on ingest);
2. every `fpUnary` row through `toCanonical/neg/square/inverseOrZero/isQuadraticResidue/sqrt`,
   asserting `Sqrt === null` exactly when `IsQR` is false, and `square(sqrt(a)) === canon(a)` otherwise;
3. `fpExp`, `fpMulAcc`, `fpReduce` (both `R96` with the high word masked to 32 bits, and `R128`);
4. `fpSerialize` round-trip, plus strict-decode rejection of a hand-built non-canonical 8-byte input;
5. every `fp5Binary`/`fp5Unary` row through the full extension API, including all four Frobenius
   powers, `legendre`, `sgn0`, `sqrt`, `canonicalSqrt`, and the 40-byte codec;
6. `signed161Recode` digits **and** the reconstruction identity `Σ d_i·32^i === signedValue(limbs)`;
7. property tests (fast-check-free; hand-rolled with a seeded PRNG so there is still zero
   dependency): `mul(a, inverseOrZero(a)) === 1` for `a ≠ 0`; `sqrt(square(a))^2 === square(a)`;
   `frobenius^5 === id`; `norm(x) ∈ GF(p)`; `legendre(square(x)) === 1` for `x ≠ 0`.

Additionally, an independent-model test: re-implement `mul`, `mul5`, `frobenius`, and `legendre`
naively with `%` on BigInt (no Goldilocks-specific reduction) and assert agreement with the fast
paths over 10^4 random inputs. This catches reduction bugs that a vector file with a fixed seed
could miss.

---

## 13. Golden values to embed directly in the source as doc-tests

Base field:

| Expression | Result |
| --- | --- |
| `toCanonical(2^64 - 1)` | `4294967294` |
| `add(p-1, 1)` (canonical output) | `0` |
| `sub(0, 1)` | `18446744069414584320` |
| `mul((p+1)/2, 2)` | `1` |
| `mul(1, 4294967295)` | `4294967295` |
| `mul(3, 2^64 - 2)` | `12884901879` |
| `inverse(2)` | `9223372034707292161` |
| `inverse(3)` | `12297829379609722881` |
| `inverse(7)` | `2635249152773512046` |
| `isQuadraticResidue(7)` | `false` (7 is the multiplicative generator) |
| `sqrt(2)` | `1099494850304` |
| `sqrt(3)` | `18446462594438004737` |
| `sqrt(8)` | `2198989700608` |
| `reduce128(hi=1, lo=2147483647)` | `6442450942` |
| `reduce128(hi=3, lo=p-1)` | `12884901884` |
| `toBytes(1)` | `0100000000000000` |

Quintic extension, with
`A = (1311768467294899695, 1147797409030816545, 1234605616436508552, 9833440827789222417, 12302652060662169617)`
(= the `0x1234567890ABCDEF…` vector):

| Expression | Result |
| --- | --- |
| `square(A)` | `(2711468769317614959, 15562737284369360677, 48874032493986270, 11211402278708723253, 2864528669572451733)` |
| `inverseOrZero(A)` | `(10760985268447604442, 1770001646280707407, 826117924202660585, 45414427571889187, 8256636258983026155)` |
| `frobenius(A)` | `(1311768467294899695, 5234265561494296110, 6204816484784411482, 8858034429214283719, 17855579289599571296)` |
| `frobenius^2(A)` | `(1311768467294899695, 13803063250989569623, 15493897884983376685, 5352534261435721987, 1417711473305569785)` |
| `legendre(A)` | `1` |
| `sgn0(A)` | `false` |
| `sqrt(A).exists` | `true` |
| `sqrt(A).root` | `(8227384794290457999, 13057635167901404592, 15133905870921849524, 9153259836227416723, 3937402200536404673)` |
| `toBytes(A)` | `efcdab907856341221436587a9cbed0f887766554433221111223344556677881100ffeeddccbbaa` |
| `sqrt(fromU64(263)).exists` | `false`, and `legendre = p-1` |
| `legendre(ZERO)` | `0`; `sqrt(ZERO) = (ZERO, true)`; `inverseOrZero(ZERO) = ZERO` |

Reference-supplied vectors that must also pass (they appear in the Go test suite):
* `add(A, ALL_ONES) = (1311768471589866989, 1147797413325783839, 1234605620731475846, 9833440832084189711, 12302652064957136911)` where `ALL_ONES` is five limbs of `0xFFFFFFFFFFFFFFFF`
* `sub(A, ALL_ONES) = (1311768462999932401, 1147797404735849251, 1234605612141541258, 9833440823494255123, 12302652056367202323)`
* `mul(A, ALL_ONES) = (12801331769143413385, 14031114708135177824, 4192851210753422088, 14031114723597060086, 4193451712464626164)`
* `sgn0((7146494650688613286, 2524706331227574337, 2805008444831673606, 10342159727506097401, 5582307593199735986)) = true`
* `canonicalSqrt((17397692312497920520, 4597259071399531684, 15835726694542307225, 16979717054676631815, 12876043227925845432))`
  `= (16260118390353633405, 2204473665618140400, 10421517006653550782, 4618467884536173852, 15556190572415033139)`
  while plain `sqrt` of the same input `= (2186625679060950916, 16242270403796443921, 8025227062761033539, 13828276184878410469, 2890553496999551182)`
* `sqrt((3558249639744866495, 2615658757916804776, 14375546700029059319, 16160052538060569780, 8366525948816396307))` does not exist
* `recodeSigned5((0x1234567890abcdef, 0xfedcba0987654321, 0x0fedcba987654321))` =
  `[15,15,-13,-8,11,8,2,15,-10,3,13,4,-15,-15,13,8,5,-5,2,-13,1,-3,-13,-4,-1,16,8,6,-12,-13,-2,-15,0]`

---

## 14. Proposed module layout and public API

```
src/crypto/field/
  constants.ts   // P, EPSILON, MASK32/64, TWO_ADICITY, POWER_OF_TWO_GENERATOR, FP5_W, FP5_DTH_ROOT, FROB1..4
  fp.ts          // Fp brand + all GF(p) operations + codec
  fp5.ts         // Fp5 type + all GF(p^5) operations + codec
  index.ts       // re-exports (thin; consumers may deep-import)
src/crypto/int/
  recode.ts      // recodeSignedDigits, recodeSigned5
```

`fp.ts` public surface:
```
type Fp
P, EPSILON, TWO_ADICITY, POWER_OF_TWO_GENERATOR, MULTIPLICATIVE_GENERATOR
ZERO, ONE, TWO, NEG_ONE
fpFromU64(bigint) | fpFromInt(bigint) | fpFromNumber(number)
toCanonical is implicit; add/sub/neg/double/mul/square/mulAcc/exp/expPow2
inverse/inverseOrZero/batchInverse
isZero/equals/isQuadraticResidue/sqrt(-> Fp|null)/legendreScalar
reduce128(bigint)/reduceWide(bigint)
powers(Fp, n)
fpToBytes/fpFromBytes/fpFromBytesUnchecked
fpArrayToBytes/fpArrayFromBytes
```

`fp5.ts` public surface:
```
type Fp5
FP5_ZERO/ONE/TWO, FP5_W, FP5_DTH_ROOT
fp5FromFp/fp5FromU64/fp5FromLimbs
add/sub/neg/double/triple/scalarMul/mul/square/div
inverse/inverseOrZero/norm/legendre
frobenius/repeatedFrobenius/expPow2
sqrt(-> {root, exists})/canonicalSqrt(-> {root, exists})/sgn0
equals/isZero
fp5ToBytes/fp5FromBytes/fp5FromBytesUnchecked
```

---

## 15. Acceptance criteria for this dimension

1. All 817 vector rows in `test/vectors/field-vectors.json` pass.
2. The independent naive-model cross-check (§12.5) passes over ≥ 10^4 random inputs per operation.
3. `tsc --noEmit --strict` clean; no `any`; `Fp`/`Fp5` never widened to `bigint` in a public signature.
4. Import graph of `src/crypto/field/**` contains zero `node:` and zero npm imports.
5. The bundled size of `import { mul } from ".../field/fp"` is under 2 KB min+gzip (proves the
   Frobenius tables and sqrt machinery tree-shake away).
6. Runs identically under `bun test`, `node --test`, `deno test`, and in a Workers `wrangler dev`
   smoke test.
7. `mul` throughput ≥ 2·10^6 ops/s on Bun on Apple Silicon (sanity floor, not a hard SLA — the real
   gate is that a full Schnorr sign stays under 50 ms).
