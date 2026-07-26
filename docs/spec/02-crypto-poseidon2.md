# 02 — Poseidon2 over Goldilocks (plonky2 variant): functional specification

Status: normative. Everything marked **MUST** is an interoperability requirement — the Lighter
sequencer will reject a transaction whose hash differs by a single bit.

Scope: the algebraic hash used by every Lighter L2 transaction signature, by the auth-token
signature, and by the Schnorr challenge derivation inside ECgFp5. This document specifies the
permutation, the sponge on top of it, the exact constants, the output encodings, and the
TypeScript design. It does **not** specify Fp5 arithmetic, the ECgFp5 curve, Schnorr, or the
per-transaction field orders — those are separate dimensions. It does specify the *contract*
at the boundary with them.

Everything below has been verified empirically against the Go reference at both
`poseidon_crypto v0.0.15` (the version `lighter-go` pins) and `v0.0.18` (the checkout in
`scratchpad/ref-poseidon-crypto`). All stated vectors were produced by executing the reference.

---

## 1. Which variant Lighter actually uses

The reference crypto library ships **two** Poseidon2-over-Goldilocks packages:

| Package | Field representation | Used by |
|---|---|---|
| `hash/poseidon2_goldilocks_plonky2` | raw `uint64`, lazily reduced (a value may be ≥ p and still legal) | **all** `types/txtypes/*.go` transaction hashing, `signature/schnorr` |
| `hash/poseidon2_goldilocks` | gnark Montgomery `Element` | only `types/tx_request.go` → `ConstructAuthToken`, and as a *discarded* argument |

**Finding: the two packages compute the same function.** Same width, same S-box, same round
counts, same round constants, same diagonal, same sponge. They differ only in internal integer
representation and in micro-optimisation. This was verified by 20 000 randomised cross-checks of
`HashToQuinticExtension` over inputs of length 0–29 — zero mismatches — and is asserted by the
reference's own `TestLongRunningCompare`.

**Therefore: implement exactly one Poseidon2 in TypeScript.** It serves the transaction hashes,
the auth token, and the Schnorr challenge.

Two further findings about the reference's shape that we deliberately do **not** reproduce:

1. `lighter-go`'s `Signer.Sign(message []byte, hFunc hash.Hash)` takes a hash function argument
   and **never uses it**. Every one of the ~24 call sites constructs a `poseidon2.NewPoseidon2()`
   digest object purely to satisfy the signature; `keyManager.Sign` ignores it entirely. Our
   `sign()` MUST NOT take a hash parameter.
2. The `hash.Hash`-shaped streaming digest wrapper (`Write`/`Sum`/`Reset`) exists in both
   packages and is used by nothing in the SDK. We do not port it. Streaming makes no sense for a
   no-padding sponge whose absorb order is defined over field elements, not bytes.

Version note: between v0.0.15 and v0.0.18 the reference restructured `Permute` into a fused form
(round constants folded into the linear layer; the 5th external constant row deferred into the
final partial round). **The function is unchanged** — both versions produce byte-identical output
on the full KAT corpus in §11. Our spec states the algorithm in the simple, unfused form; that
form is normative and verified against both versions.

---

## 2. The base field

Goldilocks: `p = 2^64 − 2^32 + 1 = 0xFFFFFFFF00000001 = 18446744069414584321`.

- `ε = 2^32 − 1 = 4294967295`, so `2^64 ≡ ε (mod p)`.
- Two-adicity 32; multiplicative generator of the 2^32-order subgroup: `7277203076849721926`.
  (Neither is used by Poseidon2; listed for the Fp5/curve dimension.)

**Element representation, normative for our implementation:** a `bigint` in canonical range
`[0, p)`. The Go reference permits a *lazy* representation where a raw `uint64` `x` denotes
`x mod p` (so values in `[p, 2^64)` are legal alternate encodings of `[0, 2^32−1)`). Every Go
arithmetic primitive is congruence-preserving, so a fully-reducing implementation is
**functionally identical**. The only consequence is that raw Go test literals may be
non-canonical: **always compare after `ToCanonicalUint64()`**.

### 2.1 Integer → field mapping (normative, easy to get wrong)

Transaction encoders feed Go integers of mixed signedness into `g.GoldilocksField(v)`. In Go this
is a **two's-complement bit reinterpretation into `uint64`**, followed by lazy reduction mod p.
Concretely, `int64(-1)` becomes `2^64 − 1`, whose canonical form is `2^32 − 2 = 4294967294`.
Verified: `H([int64(-1)]) == H([uint64(2^64−1)]) == H([2^32−2])`, all three giving
`[14065920794586377789, 17573526630236453210, 2280055636822158534, 17138839371660093638, 11715847482454823372]`.

TypeScript MUST expose this as an explicit helper and MUST NOT rely on `%` alone, because
`(-1n) % p` is `-1n` in JS:

```
fromI64(x)  ≡  BigInt.asUintN(64, x) % p          // two's-complement, then reduce
fromU64(x)  ≡  x % p                              // x already in [0, 2^64)
fp(x)       ≡  ((x % p) + p) % p                  // general, sign-safe
```

`MinAccountIndex` in the reference is `-1`, so this path is reachable. Any transaction-codec unit
MUST route signed values through `fromI64`.

### 2.2 Byte packing

- Field element → 8 bytes, **little-endian**, canonical value.
- Field element ← 8 bytes, little-endian. The reference's *gnark-side* loader rejects chunks ≥ p;
  the *plonky2-side* loader accepts anything and reduces lazily. Our loader MUST reduce and MAY
  additionally offer a strict mode that throws on ≥ p (needed by public-key / signature parsing,
  not by hashing).
- Byte string → element array (used only by the auth token): split into 8-byte little-endian
  chunks; **the final short chunk is right-padded with zero bytes to 8**. So `"abc"` → one element
  `0x0000000000636261`. Chunks ≥ p are an error in the reference. This packing belongs to the
  auth-token dimension but is stated here because it is a hash-input rule.

---

## 3. The permutation

### 3.1 Parameters

| Parameter | Value |
|---|---|
| state width `t` | **12** field elements |
| S-box | `x ↦ x^7` (degree `d = 7`) |
| full rounds `R_F` | **8** (4 before the partial rounds, 4 after) |
| partial rounds `R_P` | **22** |
| total permutation rounds | 8 full + 22 partial, plus one pre-round external matrix application |
| rate | 8 |
| capacity | 4 |
| default output | 4 |

Round numbers were generated by the standard `poseidon2_round_numbers_128` script targeting
128-bit security.

### 3.2 Round schedule (NORMATIVE)

`S` is the 12-element state. `EC[r]` is external round-constant row `r` (12 elements),
`IC[r]` is internal round constant `r` (1 element). `M_E` is the external (MDS) linear layer,
`M_I` the internal linear layer. `SBOX_FULL` applies `x^7` to all 12 lanes.

```
permute(S):
    S ← M_E(S)                                  # pre-round external layer, NO round constants

    for r = 0 .. 3:                             # first half of the full rounds
        S ← S + EC[r]                           # lane-wise, all 12 lanes
        S ← SBOX_FULL(S)
        S ← M_E(S)

    for r = 0 .. 21:                            # partial rounds
        S[0] ← S[0] + IC[r]                     # lane 0 only
        S[0] ← S[0]^7                           # lane 0 only
        S ← M_I(S)

    for r = 4 .. 7:                             # second half of the full rounds
        S ← S + EC[r]
        S ← SBOX_FULL(S)
        S ← M_E(S)
```

Note the ordering inside each full round is **add-constants → S-box → linear layer**, and the
permutation *begins* with a bare `M_E` and *ends* with an `M_E`. Getting the pre-round `M_E`
wrong is the single most common Poseidon2 implementation bug.

(For readers who later diff against `poseidon_crypto ≥ v0.0.16`: that code fuses `+EC[r]` into the
tail of `M_E`, and defers `EC[4]` into the final partial round's linear layer, producing the
sequence `M_E+EC0, S, M_E+EC1, S, …, M_E, partial…+EC4, S, M_E+EC5, …`. Algebraically identical
to the above; do not treat it as a different function.)

### 3.3 External linear layer `M_E` (NORMATIVE)

`M_E` is the block matrix over the three 4-lane chunks:

```
        ⎡ 2·M4   M4    M4  ⎤
M_E  =  ⎢  M4   2·M4   M4  ⎥          with   M4 = circ(2, 3, 1, 1)
        ⎣  M4    M4   2·M4 ⎦
```

`M4` written out (`y = M4·x` on a 4-lane chunk `x0..x3`):

```
y0 = 2·x0 + 3·x1 + 1·x2 + 1·x3
y1 = 1·x0 + 2·x1 + 3·x2 + 1·x3
y2 = 1·x0 + 1·x1 + 2·x2 + 3·x3
y3 = 3·x0 + 1·x1 + 1·x2 + 2·x3
```

(Row `i` is `(2,3,1,1)` rotated right by `i`. This is the Plonky3 `MDSMat4`, **not** the
`[[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]` matrix that appears in some Poseidon2 papers. Using
the wrong `M4` produces a plausible-looking but wrong hash.)

Application procedure (two passes, no matrix multiply):

```
M_E(S):
    for chunk in {0..3}, {4..7}, {8..11}:
        apply M4 in place to that chunk         # yields y
    for k = 0 .. 3:
        σ[k] = y[k] + y[k+4] + y[k+8]
    for i = 0 .. 11:
        S[i] = y[i] + σ[i mod 4]
```

All arithmetic mod p. An efficient no-temporaries formulation of the `M4` step:
with `t = x0+x1+x2+x3`, `y0 = t + x0 + 2·x1`, `y1 = t + x1 + 2·x2`, `y2 = t + x2 + 2·x3`,
`y3 = t + x3 + 2·x0`.

### 3.4 Internal linear layer `M_I` (NORMATIVE)

`M_I = J + diag(D)` where `J` is the all-ones 12×12 matrix and `D` is the fixed diagonal below:

```
M_I(S):
    σ = Σ_{i=0..11} S[i]
    for i = 0 .. 11:
        S[i] = S[i]·D[i] + σ
```

All arithmetic mod p. Note carefully: it is `S[i]·D[i] + σ`, i.e. `D` already encodes the
"diagonal minus one" convention. Do not subtract 1 from `D`.

---

## 4. Constants (NORMATIVE — exact values)

Provenance: `EXTERNAL_CONSTANTS` and `INTERNAL_CONSTANTS` were generated randomly by the
reference authors for `R_F = 8` and `R_P = 22`. `MATRIX_DIAG_12_U64` is taken verbatim from the
Plonky3 Goldilocks Poseidon2 implementation. All 130 values are canonical (`< p`); this is
asserted by the reference's own `TestConstantsAreInTheField` and re-verified here.

SHA-256 of the canonical JSON dump (`{"diag":[…],"external":[[…]…],"internal":[…]}`, decimal
strings, separators `,`/`:`, sorted keys):
`229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db`

Pin this digest in the generated constants module; the codegen script MUST fail if a fresh dump
does not match, so an upstream constant rotation cannot land silently.

### 4.1 External round constants `EC` — 8 rows × 12 lanes (row-major)

```
r0: 15492826721047263190, 11728330187201910315,  8836021247773420868, 16777404051263952451,
     5510875212538051896,  6173089941271892285,  2927757366422211339, 10340958981325008808,
     8541987352684552425,  9739599543776434497, 15073950188101532019, 12084856431752384512
r1:  4584713381960671270,  8807052963476652830,    54136601502601741,  4872702333905478703,
     5551030319979516287, 12889366755535460989, 16329242193178844328,   412018088475211848,
    10505784623379650541,  9758812378619434837,  7421979329386275117,   375240370024755551
r2:  3331431125640721931, 15684937309956309981,   578521833432107983, 14379242000670861838,
    17922409828154900976,  8153494278429192257, 15904673920630731971, 11217863998460634216,
     3301540195510742136,  9937973023749922003,  3059102938155026419,  1895288289490976132
r3:  5580912693628927540, 10064804080494788323,  9582481583369602410, 10186259561546797986,
      247426333829703916, 13193193905461376067,  6386232593701758044, 17954717245501896472,
     1531720443376282699,  2455761864255501970, 11234429217864304495,  4746959618548874102
r4: 13571697342473846203, 17477857865056504753, 15963032953523553760, 16033593225279635898,
    14252634232868282405,  8219748254835277737,  7459165569491914711, 15855939513193752003,
    16788866461340278896,  7102224659693946577,  3024718005636976471, 13695468978618890430
r5:  8214202050877825436,  2670727992739346204, 16259532062589659211, 11869922396257088411,
     3179482916972760137, 13525476046633427808,  3217337278042947412, 14494689598654046340,
    15837379330312175383,  8029037639801151344,  2153456285263517937,  8301106462311849241
r6: 13294194396455217955, 17394768489610594315, 12847609130464867455, 14015739446356528640,
     5879251655839607853,  9747000124977436185,  8950393546890284269, 10765765936405694368,
    14695323910334139959, 16366254691123000864, 15292774414889043182, 10910394433429313384
r7: 17253424460214596184,  3442854447664030446,  3005570425335613727, 10859158614900201063,
     9763230642109343539,  6647722546511515039,   909012944955815706, 18101204076790399111,
    11588128829349125809, 15863878496612806566,  5201119062417750399,   176665553780565743
```

Rows 0–3 are consumed by the first full-round half in order; rows 4–7 by the second half in order.

### 4.2 Internal round constants `IC` — 22 values, consumed in order

```
11921381764981422944, 10318423381711320787,  8291411502347000766,   229948027109387563,
 9152521390190983261,  7129306032690285515, 15395989607365232011,  8641397269074305925,
17256848792241043600,  6046475228902245682, 12041608676381094092, 12785542378683951657,
14546032085337914034,  3304199118235116851, 16499627707072547655, 10386478025625759321,
13475579315436919170, 16042710511297532028,  1411266850385657080,  9024840976168649958,
14047056970978379368,   838728605080212101
```

### 4.3 Internal diagonal `D` — 12 values (lane-indexed)

Decimal (normative) with the reference's hex spelling for cross-checking:

```
[ 0] 14102670999874605824   0xc3b6c08e23ba9300
[ 1] 15585654191999307702   0xd84b5de94a324fb6
[ 2]   940187017142450255   0x0d0c371c5b35b84f
[ 3]  8747386241522630711   0x7964f570e7188037
[ 4]  6750641561540124747   0x5daf18bbd996604b
[ 5]  7440998025584530007   0x6743bc47b9595257
[ 6]  6136358134615751536   0x5528b9362c59bb70
[ 7] 12413576830284969611   0xac45e25b7127b68b
[ 8] 11675438539028694709   0xa2077d7dfbb606b5
[ 9] 17580553691069642926   0xf3faac6faee378ae
[10]   892707462476851331   0x0c6388b51545e883
[11] 15167485180850043744   0xd27dbb6944917b60
```

### 4.4 Where the constants live in TypeScript

They MUST live in a **generated** module, never hand-typed:

`src/crypto/poseidon2/constants.generated.ts`

```ts
// GENERATED — do not edit. Source: poseidon_crypto v0.0.15
//   hash/poseidon2_goldilocks_plonky2/config.go
// Regenerate: bun run gen:poseidon2-constants
// Digest: 229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db

export const WIDTH = 12 as const;
export const RATE = 8 as const;
export const CAPACITY = 4 as const;
export const OUT = 4 as const;
export const SBOX_DEGREE = 7 as const;
export const ROUNDS_F = 8 as const;
export const ROUNDS_F_HALF = 4 as const;
export const ROUNDS_P = 22 as const;

/** 8 rows × 12 lanes, flattened row-major: index r*12 + i. */
export const EXTERNAL_ROUND_CONSTANTS: readonly bigint[] = Object.freeze([
  15492826721047263190n, /* … 96 entries … */
]);
export const INTERNAL_ROUND_CONSTANTS: readonly bigint[] = Object.freeze([ /* 22 */ ]);
export const INTERNAL_DIAGONAL: readonly bigint[] = Object.freeze([ /* 12 */ ]);
export const CONSTANTS_DIGEST = "229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db";
```

Design requirements:

- **Flatten** the 8×12 external table to a single 96-entry array. A nested array costs an extra
  pointer dereference per lane per round and buys nothing; the row base is `r * 12`.
- **`bigint` literals with the `n` suffix**, not strings parsed at load. Literals are parsed once
  by the engine; `BigInt("…")` × 130 runs on every cold start including every Cloudflare Worker
  isolate spin-up.
- `Object.freeze` at module scope so accidental mutation throws in strict mode. Do not deep-freeze
  per call.
- Do **not** put the constants behind a getter/factory. They must be statically analysable so the
  bundler can keep them in one chunk and so V8 can treat the array as a constant.
- The module has **zero imports**. It is pure data, so a consumer that only wants, say, the width
  constants does not pull in the permutation.

### 4.5 Extraction

Two independent extractors (Go runtime dump + `config.go` text scrape), diffed against each other
and against the pinned digest, then fed to a TypeScript codegen. Full procedure in §10.4–§10.5.

The invariant that matters: **the TypeScript author never opens a Go file.** Constants arrive as
JSON from `conformance/`, and the codegen turns JSON into the generated module.

---

## 5. The sponge / hash construction

### 5.1 Core routine: `hashNToM(input, m)`

State: 12 elements, **initialised to all zeros** (no IV, no capacity tag, no length encoding).

```
hashNToM(input, m):                        # m ≥ 1
    S ← [0] * 12
    i ← 0
    while i < len(input):
        n ← min(8, len(input) − i)
        for j = 0 .. n−1:
            S[j] ← input[i+j]              # OVERWRITE, not add/xor
        permute(S)
        i ← i + 8
    out ← []
    loop:
        for k = 0 .. 7:
            out.append(S[k])
            if len(out) == m: return out
        permute(S)
```

Properties that MUST be reproduced exactly:

- **Overwrite absorption, not additive.** The rate lanes are *assigned*, never XORed or added.
- **Capacity lanes 8–11 are never written by absorption.** They only evolve through the
  permutation. They start at zero.
- **On a short final block, rate lanes beyond the input length keep whatever the previous
  permutation left there.** They are *not* re-zeroed. E.g. for a 9-element input, block 2 writes
  only `S[0]`; `S[1..7]` carry the previous permutation output. This is not padding — it is the
  absence of padding.
- **Empty input performs zero permutations.** `hashNToM([], m)` returns `m` values read out of the
  all-zero state, so `hashToQuinticExtension([])` is the Fp5 zero and `hashNoPad([])` is
  `[0,0,0,0]`. Confirmed against the reference.
- **`m` may exceed the rate.** After emitting 8 values the state is permuted again and the next
  group of 8 is emitted. Only `m ∈ {4, 5, 12}` occur in practice; the general form must still be
  right because our KAT corpus exercises `m = 12`.
- **`m ≤ 0` is an error.** The reference loops forever on `m = 0` (its length check is
  post-append). TypeScript MUST throw a `RangeError`.

### 5.2 Derived entry points

All of these are thin wrappers; the whole SDK uses only these four shapes.

| Function | Definition | Used by |
|---|---|---|
| `hashToQuinticExtension(input) → Fp5` | `hashNToM(input, 5)`, lanes → coefficients `c0..c4` | every `*.Hash()` tx method, attribute hashing, auth token, Schnorr challenge |
| `hashNoPad(input) → HashOut` | `hashNToM(input, 4)` | grouped-orders per-order hash |
| `hashTwoToOne(a, b) → HashOut` | `hashNToM([a0,a1,a2,a3,b0,b1,b2,b3], 4)` — exactly 8 elements, one permutation | building block for `hashNToOne` |
| `hashNToOne(list) → HashOut` | if `len == 1` return `list[0]`; else **left fold**: `acc = hashTwoToOne(list[0], list[1])`, then `acc = hashTwoToOne(acc, list[i])` for `i = 2 …` | grouped-orders aggregation |
| `permute(state)` | raw permutation, exported for tests/benchmarks | tests only |

`hashNToOne` is a **sequential left fold, not a Merkle tree**. `hashNToOne([])` is undefined in the
reference (index panic); TypeScript MUST throw.

`EMPTY_HASH_OUT` is `[0n, 0n, 0n, 0n]`.

### 5.3 Output → Fp5 (`HashToQuinticExtension`) — NORMATIVE

`Fp5 = Fp[X]/(X^5 − 3)`, i.e. the quintic extension with `W = 3` and `z^5 = 3`. An element is the
coefficient vector `(c0, c1, c2, c3, c4)` meaning `c0 + c1·z + c2·z² + c3·z³ + c4·z⁴`.

The derivation is a **direct, order-preserving copy of the first five state lanes**:

```
hashToQuinticExtension(input):
    h = hashNToM(input, 5)          # h = [S0, S1, S2, S3, S4] after absorption
    return Fp5(c0 = h[0], c1 = h[1], c2 = h[2], c3 = h[3], c4 = h[4])
```

- lane 0 → constant coefficient `c0`
- lane 1 → `c1` (coefficient of `z`)
- lane 2 → `c2` (`z²`)
- lane 3 → `c3` (`z³`)
- lane 4 → `c4` (`z⁴`)

No reordering, no reversal, no extra permutation. The 5 values come from a single squeeze of the
rate (5 ≤ 8), so exactly `ceil(len(input)/8)` permutations run in total (zero for empty input).

`HashOut` (4 elements) is likewise lanes 0–3 in order.

### 5.4 Serialisation

- `Fp5` → **40 bytes**: `c0..c4`, each as canonical `uint64` little-endian, concatenated in that
  order. This is `HashLength` and `PubKeyLength` in `lighter-go`.
- `HashOut` → **32 bytes**: lanes 0–3, canonical `uint64` little-endian each.
- Both are the *canonical* value: a lazily-represented element MUST be reduced before writing.

The 40-byte little-endian Fp5 encoding is what `TxInfo.Hash()` returns and what gets fed to the
Schnorr signer.

---

## 6. Domain separation

**There is none.** No domain tag, no length prefix, no padding byte, no capacity IV, no
personalisation string. The state starts at twelve zeros for every call, from every caller
(transactions, attributes, auth tokens, Schnorr challenges).

Consequences we MUST document in the public API doc-comments (and MUST NOT "fix", since fixing
breaks interoperability):

1. **Trailing zeros are invisible for inputs of ≤ 8 elements.** Verified:
   `H([1]) == H([1,0]) == H([1,0,0,0,0,0,0,0])`
   `= [7431367281668178651, 8673656104435309403, 8585099438262764970, 14879537960188007193, 3557489100365386970]`.
   Because absorption overwrites a zero-initialised state, appending zeros to a short input
   changes nothing. Likewise `H([0]) == H([0,0])`.
2. **`H([])` is the zero Fp5 element**, a distinguished value that no non-empty input maps to only
   by luck. Callers must never hash a variable-length list without a fixed-arity schema.
3. **Cross-context collisions are prevented only by the caller's field layout.** Lighter relies on
   every transaction hash beginning with `(lighterChainId, txType, …)` at fixed positions and on
   every tx type having a fixed element count. That discipline lives in the tx-codec dimension; the
   hash layer provides no help. Our tx-codec unit MUST assert fixed arity per tx type in tests.
4. Two *different* Lighter constructions feed into the same unsalted hash: attribute hashing
   (`[type, value] × NbAttributesPerTx`) and the tx-hash aggregation
   (`[txHash c0..c4, attrHash c0..c4]`, 10 elements). Both are fixed-arity, so they are safe, but
   the safety is structural, not cryptographic.

---

## 7. TypeScript design

### 7.1 Module layout

The base field is **owned by dimension 01** (`src/crypto/field/`). Poseidon2 consumes it and MUST
NOT define a second copy of `P` or of the field ops.

```
src/crypto/field/constants.ts               # (dim 01) P, EPSILON, FP5_W, …
src/crypto/field/fp.ts                      # (dim 01) Fp type + ops + codec
src/crypto/field/fp5.ts                     # (dim 01) Fp5 type + ops + codec

src/crypto/poseidon2/constants.generated.ts # pure data, zero imports
src/crypto/poseidon2/permutation.ts         # permute(state); imports P + constants only
src/crypto/poseidon2/index.ts               # sponge + public API
```

Runtime imports from the poseidon2 subtree are limited to: `P` from `field/constants.ts`, and
`fpFromU64`/`fpFromInt` at the API boundary. Everything else is `import type`. The permutation
deliberately does **not** call `fp.mul`/`fp.add` — it inlines `% P` so that the deferred-reduction
bounds argument in §7.4 stays local and auditable, and so the hot loop has no cross-module call.

Package `exports` map entries (ESM only, no CJS, no default export):

```jsonc
{
  "./crypto/poseidon2": { "types": "./dist/crypto/poseidon2/index.d.ts",
                          "import": "./dist/crypto/poseidon2/index.js" }
}
```

`"sideEffects": false` in `package.json`. No top-level `await`, no `process`, no `Buffer`, no
`node:` imports anywhere in this subtree — it must load unchanged in a Cloudflare Worker isolate
and in a browser.

### 7.2 Types

`Fp` and `Fp5` come from dimension 01 as **type-only** imports (erased at build time, so no
runtime coupling and no tree-shaking penalty):

```ts
import type { Fp } from "../field/fp.js";
import type { Fp5 } from "../field/fp5.js";   // readonly [Fp, Fp, Fp, Fp, Fp]

/** Fixed-arity mutable state. A tuple, not Fp[], so strict index access is safe. */
export type State = [Fp,Fp,Fp,Fp,Fp,Fp,Fp,Fp,Fp,Fp,Fp,Fp];

/** 4-element digest. Poseidon2 owns this type. */
export type HashOut = readonly [Fp, Fp, Fp, Fp];
```

If dimension 01's `Fp5` is a branded/opaque type rather than a bare tuple, poseidon2 MUST use its
constructor (`fp5.from(c0,c1,c2,c3,c4)` or equivalent) rather than casting; that is the one place a
value import from `fp5.ts` is acceptable.

With `noUncheckedIndexedAccess: true` (which we want), `Fp[]` indexing yields `Fp | undefined` and
litters the hot loop with `!`. The 12-tuple `State` type removes that entirely for indices 0–11.
Use `Array<Fp>` only at the API boundary for variable-length input.

### 7.3 Permutation implementation shape

Requirements:

- **One flat function, fully unrolled where it matters.** Do not build per-round closures, do not
  allocate a fresh array per round, do not `map`/`reduce` inside rounds. The permutation runs
  8 + 22 rounds; per-round allocation would dominate.
- **In-place on the caller's `State`.** `permute(s: State): void`.
- **Scratch allocation: at most one 12-tuple per `hashNToM` call**, not per round. Do not use a
  module-level scratch buffer: it is a reentrancy hazard the moment anyone calls the hash from
  inside a `Proxy`/getter, and the allocation is ~50 ns against a ~35 µs permutation. Allocate the
  state inside `hashNToM`, reuse it across all blocks and squeezes of that call.
- **Never `BigUint64Array` / `BigInt64Array` for the state.** Intermediate sums in `M_E` reach
  ~2^70 and would silently wrap. Typed arrays are also slower here than a plain tuple because every
  read boxes a fresh `BigInt`.
- Loop over lanes with literal-bounded `for (let i = 0; i < 12; i++)`; V8/JSC unroll these fine.
  Hand-unrolling the S-box into three groups of four (as the reference does) is a Go/CPU-pipeline
  optimisation with no measurable JS benefit — skip it, keep the loop readable.

Reference algorithm, expressed for TypeScript (this is the shape to implement, not a port):

```
S-box:      x2 = (x*x) % p ; x3 = (x2*x) % p ; x4 = (x2*x2) % p ; return (x3*x4) % p
            # 4 multiplications for x^7; x^7 = x^3 · x^4
external:   per chunk c ∈ {0,4,8}:  t = s[c]+s[c+1]+s[c+2]+s[c+3]  (unreduced)
                                     s[c]   = t + s[c]   + 2*s[c+1]
                                     s[c+1] = t + s[c+1] + 2*s[c+2]
                                     s[c+2] = t + s[c+2] + 2*s[c+3]
                                     s[c+3] = t + s[c+3] + 2*s[c]
            then for k ∈ 0..3: q = s[k]+s[k+4]+s[k+8]
                               s[k]=(s[k]+q)%p ; s[k+4]=(s[k+4]+q)%p ; s[k+8]=(s[k+8]+q)%p
internal:   q = Σ s[i]                       (unreduced, < 2^68)
            for i: s[i] = (s[i]*D[i] + q) % p
```

Note the `M4` step deliberately leaves values **unreduced** and defers the single `%` to the
column-sum step. This is safe and measurably faster (see §7.5).

### 7.4 Correctness under BigInt — the rules

1. **All field values are `bigint`. Never `number`.** A `number` cannot represent a Goldilocks
   element. Reject `number` at the API boundary rather than coercing; a `number`-typed price that
   silently loses precision is the worst possible failure mode for a trading SDK.
2. **`%` in JS is remainder, not modulo.** `(-1n) % p === -1n`. Every place a subtraction or a
   signed input can occur MUST use `((x % p) + p) % p`. Inside the permutation there are no
   subtractions, so plain `% p` is correct there.
3. **Reduction discipline / bound proof.** Entering `M_E` all lanes are `< p < 2^64`.
   Each `M4` output has coefficient sum 7, so `y_i < 7·2^64 < 2^67`; the column step adds three
   such, so before reduction values are `< 4·7·2^64 < 2^70`. In `M_I`, `q < 12·2^64 < 2^68` and
   `s[i]·D[i] < 2^128`, so `s[i]·D[i] + q < 2^128 + 2^68`. BigInt is arbitrary precision so none of
   this can overflow — the bound analysis exists only to justify *skipping* intermediate `%`
   operations, and to document that a future port to a 64-bit-limb representation must reduce more
   often. State this in a comment; do not leave it implicit.
4. **Post-condition:** `permute` returns with all 12 lanes canonical in `[0, p)`. Assert this in
   debug builds (a `DEV`-gated check stripped by the bundler), not in production.
5. **Absorption reduces inputs.** `hashNToM` MUST apply `x % p` (or `fp(x)` for possibly-negative)
   to each absorbed element, so callers passing a lazily-represented or over-range value get the
   same answer as Go. Verified against the reference's `TestHashNToHashNoPadLarge`, which feeds
   `p+1, p+2, p+3, 2^64−1, 2^64−2`.
6. **Comparisons and equality on field elements** must be done on canonical values. Never compare
   serialized bytes of unreduced values.
7. **`tsconfig` target ≥ ES2020** (BigInt literals). Recommend ES2022. `strict: true`,
   `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.

### 7.5 Performance — measured, not guessed

Measured on this machine (Node 24 / Bun 1.3, single 12-lane permutation, 20 000 iterations):

| Strategy | Node | Bun |
|---|---|---|
| naive `% p` everywhere | 27 500 perm/s | 23 000 perm/s |
| **deferred reduction (§7.3 shape)** | **31 300 perm/s** | **23 800 perm/s** |
| hand-rolled Goldilocks reduce (hi/lo split, shifts, masks) | 14 100 perm/s | 8 400 perm/s |

**Do not hand-roll the Goldilocks reduction.** The classic `x_hi·ε` trick that makes Go fast is
*2–3× slower* in JS: each shift/mask/compare allocates a new `BigInt`, whereas the engine's `%`
on a ≤128-bit value is a single intrinsic. This is the opposite of the intuition you get from
reading the Go source, and it is the main place a naive port wastes effort.

Budget check: a transaction hash is 2–5 permutations ⇒ well under 0.2 ms. The Schnorr signature
(≈320 ECgFp5 point operations) dominates by two orders of magnitude. Poseidon2 is **not** the hot
path; prefer clarity and auditability over micro-optimisation. Do not introduce WASM "for speed".

### 7.6 Public API (final shape)

```ts
// src/crypto/poseidon2/index.ts
export { WIDTH, RATE, CAPACITY, OUT, ROUNDS_F, ROUNDS_P } from "./constants.generated.js";
export { permute } from "./permutation.js";

export function hashNToM(input: readonly Fp[], m: number): Fp[];
export function hashNoPad(input: readonly Fp[]): HashOut;
export function hashTwoToOne(a: HashOut, b: HashOut): HashOut;
export function hashNToOne(inputs: readonly HashOut[]): HashOut;
export function hashToQuinticExtension(input: readonly Fp[]): Fp5;

export const EMPTY_HASH_OUT: HashOut;
export function hashOutToLeBytes(h: HashOut): Uint8Array;      // 32
export function hashOutFromLeBytes(b: Uint8Array): HashOut;    // throws unless len 32
export function fp5ToLeBytes(e: Fp5): Uint8Array;              // 40
export function fp5FromLeBytes(b: Uint8Array): Fp5;            // throws unless len 40
```

Deliberately **not** exposed (dead weight in the reference): the `hash.Hash` streaming digest,
`HashPair`/`HashPairBytes`, `HashNToMNoPadBytes`, `ToLittleEndianBytesArray`, and any
`newPoseidon2()` factory. If a byte-oriented entry point is ever needed, it is
`bytes → Fp[]` (§2.2) followed by the element API — one composition, not a second sponge.

Naming: the reference's `…NoPad` suffix is noise (there is no padded variant). Drop it. Keep
`hashToQuinticExtension` verbatim — it is the name every downstream reader will grep for.

---

## 8. Contract with adjacent dimensions

- **Fp5 / ECgFp5 / Schnorr:** consume `hashToQuinticExtension`. The Schnorr challenge is
  `e = Fp5→scalar( hashToQuinticExtension([ r.c0..r.c4, m.c0..m.c4 ]) )` — a 10-element input,
  `r` first then the message hash, each in `c0..c4` order. Signature bytes are
  `s (40 LE) || e (40 LE)`, 80 bytes total.
- **Transaction codec:** consumes `hashToQuinticExtension`, `hashNoPad`, `hashNToOne`; must route
  all integers through `fromI64`/`fromU64` (§2.1) and must guarantee fixed arity per tx type (§6).
- **Auth token:** packs the ASCII string `"<unixDeadline>:<accountIndex>:<apiKeyIndex>"` via the
  8-byte-LE zero-padded chunking of §2.2, then `hashToQuinticExtension`, then 40-byte LE, then
  Schnorr-sign; the token is `"<message>:<hexSignature>"`.

---

## 9. Test plan

All KAT tests are table-driven off `conformance/vectors/poseidon2.json` (§10.1), mapping decimal
strings → `BigInt`. Do not hand-copy vectors into test files except the anchors in §11, which exist
so the first implementation can be bootstrapped before the corpus is extended.

1. **Constants gate.** Generated module's `CONSTANTS_DIGEST` matches the recomputed digest; CI
   regenerates and diffs.
2. **Permutation KATs** — all 23 `permutations` cases, including the all-zero state (§11.1).
3. **`hashNToMNoPad` KATs** — all `numOutputs ∈ {1,4,5,8}` cases, **plus the added
   `numOutputs = 12` cases** (§10.2 item 1), which are the only coverage of the multi-squeeze path.
4. **`hashToQuinticExtension` KATs** — all 45 cases (input lengths 0–24, covering every block
   boundary and short-final-block shape), asserting both the 5 limbs and `outputLeBytesHex`.
5. **Non-canonical input KAT**: `[p+1, p+2, p+3, 2^64−1, 2^64−2] → [14216040864787980138,
   17275303675000904868, 11831395338463193314, 281267649235863375]` (m = 4).
6. **Signed input KAT**: `fromI64(-1n)` path, §2.1 vector.
7. **Documented-collision tests** (§6.1) asserted as *expected behaviour*, with a comment saying
   why they must not be "fixed".
8. **Error cases**: `m ≤ 0` throws; `hashNToOne([])` throws; `hashOutFromLeBytes` on wrong length
   throws.
9. **Property test** vs. a deliberately-naive second implementation in the test file (explicit
   12×12 matrix multiply built from §3.3/§3.4, `% p` after every operation) over 10 000 random
   inputs. This catches deferred-reduction bounds mistakes.
10. **Runtime matrix**: the same test file must pass under `bun test`, `node --test`,
    `deno test`, and in `workerd` (via `vitest --environment miniflare` or `wrangler dev`
    smoke). No `node:` imports means this should be free; assert it in CI so it stays free.
11. **Allocation guard** (optional, Node only): `hashToQuinticExtension` of a 16-element input must
    not allocate more than one `State`.

---

## 10. Producing the KAT corpus from the Go reference

### 10.1 What already exists — do not rebuild it

`conformance/oracle` is committed and working (pins `poseidon_crypto v0.0.15`), and
`conformance/vectors/poseidon2.json` is already generated with this schema:

```jsonc
{
  "width": 12,
  "permutations":            [ { "input": ["…×12"], "output": ["…×12"] } ],          // 23 cases
  "hashToQuinticExtension":  [ { "input": ["…"], "output": ["…×5"],
                                 "outputLeBytesHex": "<80 hex chars>" } ],           // 45 cases
  "hashNoPad":               [ { "input": ["…"], "output": ["…×4"] } ],              // 17 cases
  "hashNToMNoPad":           [ { "input": ["…"], "numOutputs": 4, "output": ["…"] } ]// 16 cases
}
```

All values are canonical **decimal strings** (JSON numbers cannot hold `uint64`; `JSON.parse`
would silently corrupt them). Inputs are deterministic (splitmix64-seeded, no clock, no RNG), so
the file is byte-stable across runs. Input lengths cover 0–24 for `hashToQuinticExtension` and
0–16 for `hashNoPad`. **Wave-1 units consume this file as-is.**

### 10.2 Gaps the corpus must be extended with

Audited against this spec; four things are missing and each covers a distinct code path:

1. **Multi-squeeze.** `numOutputs ∈ {1,4,5,8}` only. `numOutputs == 8` returns at the end of the
   first squeeze group *without* an extra permutation, so the "permute between output groups"
   branch (§5.1) is **completely untested**. Add `numOutputs = 12` for input lengths
   `{0, 1, 8, 9, 12}`. Anchor vector for length 0:
   `[0,0,0,0,0,0,0,0, 7182099517097165596, 9311216678150108034, 8831900494918587432, 10774846510254277933]`.
2. **`hashNToOne` / `hashTwoToOne`.** Absent entirely, yet grouped-orders transactions depend on
   the left-fold. Add a `hashNToOne` section with fold chains of length 1, 2, 3 and 5, and an
   explicit `hashTwoToOne` section. Anchors in §11.3.
3. **Non-canonical inputs.** Every current input is `< p`. Add the reference's own case
   `[p+1, p+2, p+3, 2^64−1, 2^64−2] → [14216040864787980138, 17275303675000904868,
   11831395338463193314, 281267649235863375]` (`numOutputs = 4`), plus the signed case
   `int64(-1) ≡ 2^64−1 ≡ 2^32−2` (§2.1). These pin the input-reduction rule.
4. **Round constants.** Not dumped anywhere. Add a `constants` section (or a separate
   `poseidon2-constants.json`) carrying `external` (8×12), `internal` (22) and `diag` (12) as
   canonical decimal strings, emitted through `.ToCanonicalUint64()`. This is what the TS codegen
   consumes; the TypeScript author must never open `config.go`.

### 10.3 Extending the oracle

Add to `conformance/oracle/main.go` (or a new file in the same package) alongside the existing
generators. New code we own; it calls only the reference's exported API. Emission rules:

- Every value through `.ToCanonicalUint64()`, formatted as a decimal string.
- Deterministic input generation only — reuse the existing splitmix64 helper. No `crypto/rand`.
- Import `p2 "github.com/elliottech/poseidon_crypto/hash/poseidon2_goldilocks_plonky2"` and read
  `p2.EXTERNAL_CONSTANTS`, `p2.INTERNAL_CONSTANTS`, `p2.MATRIX_DIAG_12_U64` for the constants
  section.

```bash
cd conformance/oracle
go build -o oracle .
./oracle -out ../vectors      # regenerates all six vector files
```

Commit the regenerated `conformance/vectors/poseidon2.json` and record its SHA-256 in the test
file; regeneration MUST be a deliberate, reviewed change.

### 10.4 Constants extraction — two independent paths, diffed

**(a) Authoritative:** the `constants` section of the oracle output (§10.2 item 4).

**(b) Cross-check, no Go toolchain:** text extraction straight out of `config.go`.

```bash
python3 conformance/scripts/extract_poseidon2_constants.py \
  "$(go env GOMODCACHE)/github.com/elliottech/poseidon_crypto@v0.0.15/hash/poseidon2_goldilocks_plonky2/config.go" \
  > conformance/vectors/poseidon2-constants.textdump.json
```

Extractor behaviour (verified to reproduce the runtime dump exactly, byte for byte): for each of
the three identifiers, take the balanced `{ … }` literal that follows the first `=` after the
identifier; for `EXTERNAL_CONSTANTS` take every innermost `{ … }` group as one row; scan each group
for integer tokens matching `0x[0-9a-fA-F]+|\d+` and parse with base auto-detection; assert 8 rows
× 12, 22 internal, 12 diagonal, and every value in `[0, p)`.

The codegen (§10.5) MUST fail the build if (a) and (b) disagree, or if either disagrees with the
pinned digest.

### 10.5 Codegen into TypeScript

`scripts/gen-poseidon2-constants.ts` reads the constants from the vectors directory, recomputes
the SHA-256 of the canonical serialisation
(`{"diag":[…],"external":[[…]…],"internal":[…]}`, decimal strings, separators `,` and `:`,
sorted keys), compares it with the pinned
`229f61cd639b9e9163636f80112c4705794211e786f6e3548d270f324fcf01db`, and emits
`src/crypto/poseidon2/constants.generated.ts`. Wired as `bun run gen:poseidon2-constants` and
gated in CI by a "generated file is up to date" diff.

### 10.6 Cross-checks already performed (record, do not redo)

- **Version stability.** The full corpus generated against `poseidon_crypto v0.0.15` and against
  `v0.0.18` is **identical**. The fused restructuring in ≥ v0.0.16 is not a functional change.
  Re-run this if the pin is ever bumped:
  ```bash
  cd conformance/oracle
  go mod edit -require=github.com/elliottech/poseidon_crypto@v0.0.18 && go run . -out /tmp/v18
  go mod edit -require=github.com/elliottech/poseidon_crypto@v0.0.15 && go run . -out /tmp/v15
  diff /tmp/v15/poseidon2.json /tmp/v18/poseidon2.json && echo "algorithm stable"
  ```
- **Cross-variant equivalence.** `HashToQuinticExtension` through
  `poseidon2_goldilocks_plonky2` vs `poseidon2_goldilocks` over 20 000 random cases of length
  0–29: **zero mismatches**. This is the justification for shipping one TS implementation (§1).
- **Independent re-derivation.** A from-scratch BigInt implementation written directly from §3 of
  this document (pre-round `M_E`, 4 full / 22 partial / 4 full, `M4 = circ(2,3,1,1)`,
  `M_I = J + diag(D)`) reproduces **43/43** oracle vectors plus all six of the reference's own
  published test vectors. The algorithm statement in §3 is therefore known to be complete and
  sufficient — an implementer needs nothing beyond it and the constants.

---

## 11. Known-answer vectors (verified against the reference)

All values decimal, canonical.

### 11.1 Permutation

Input (12) → output (12):

```
in : 5417613058500526590, 2481548824842427254, 6473243198879784792, 1720313757066167274,
     2806320291675974571, 7407976414706455446, 1105257841424046885, 7613435757403328049,
     3376066686066811538, 5888575799323675710, 6689309723188675948, 2468250420241012720
out: 5364184781011389007, 15309475861242939136, 5983386513087443499, 886942118604446276,
     14903657885227062600, 7742650891575941298, 1962182278500985790, 10213480816595178755,
     3510799061817443836, 4610029967627506430, 7566382334276534836, 2288460879362380348
```

All-zero state (this one pins the pre-round `M_E` and the constant schedule better than any
random vector):

```
in : 0 ×12
out: 7182099517097165596, 9311216678150108034, 8831900494918587432, 10774846510254277933,
     10601329242472021962, 5629867288322699978, 140799316430260029, 16680789625189310103,
     16589856342819292996, 4940126994627441183, 14089387953811494999, 8340711910841427341
```

### 11.2 `hashToQuinticExtension`

```
[]                          → [0, 0, 0, 0, 0]
                              le = 00…00 (40 zero bytes)

[0]  ==  [0,0]              → [7182099517097165596, 9311216678150108034, 8831900494918587432,
                               10774846510254277933, 10601329242472021962]
                              le = 1cc3145a75f1ab638273d45f3c163881281438ebb436917a
                                   2d451041d0f18795ca7f811cc77c1f93

[1] == [1,0] == [1,0×7]     → [7431367281668178651, 8673656104435309403, 8585099438262764970,
                               14879537960188007193, 3557489100365386970]
                              le = dbc24a6b2b8521675bdbc3a045045f78aac50e0b74662477
                                   1953f28af0bc7eceda549a077dbd5e31

[1,0,0,0,0,0,0,0,0] (9)     → [16509144642551511704, 5035801721567466424, 10903240033183598926,
                               10438563394226104476, 12343252793228303366]

[1,2,3,4,5,6,7,8]           → [11038414124778337341, 8720117733692872911, 15275222608080276643,
                               7761745982584972927, 16684206033038683486]

[1,2,3,4,5,6,7,8,9]         → [16227062849557806322, 8564777786625489032, 190117969290264605,
                               5916077271953608790, 8021020590423921751]

[p−1]                       → [17791554998484592198, 9316899395245393780, 4536337535846521524,
                               15488847945248843725, 4359446757619424829]

[fromI64(-1)] == [2^64−1] == [2^32−2]
                            → [14065920794586377789, 17573526630236453210, 2280055636822158534,
                               17138839371660093638, 11715847482454823372]

Reference's own vector:
[3451004116618606032, 11263134342958518251, 10957204882857370932, 5369763041201481933,
 7695734348563036858, 1393419330378128434, 7387917082382606332]
                            → [17992684813643984528, 5243896189906434327, 7705560276311184368,
                               2785244775876017560, 14449776097783372302]
```

### 11.3 `hashNoPad` / `hashNToOne`

```
a = hashNoPad([1..10])   = [11021345796096752149, 14367143748476486211,
                            14953195743508369291, 8411704593359980238]
b = hashNoPad([11..20])  = [13234480767043302742, 645518054121777836,
                            3547385345478547725, 15981773718732258424]
hashNToOne([a,b])        = [2559625810909264946, 10464785083568490430,
                            17783947683985685462, 7831027536943772873]
hashNToOne([a,b,c])      = [6358531824164924378, 12861483381811927130,
                            3888384269753278731, 11154275966265341638]     where c = hashNToOne([a,b])
hashNToOne([x])          = x
EMPTY_HASH_OUT           = [0,0,0,0]
```

### 11.4 `hashNToM` with `m = 12` (exercises the second squeeze)

```
in (len 0)  → [0,0,0,0,0,0,0,0,
               7182099517097165596, 9311216678150108034, 8831900494918587432, 10774846510254277933]
```

Note how the first 8 outputs come from the untouched zero state and the last 4 come *after* a
permutation — this vector alone pins the squeeze loop.

Reference's 12-in/12-out vector:

```
in : 2963773914414780088, 8389525300242074234, 3700959901615818008, 6116199383751757212,
     3418607418699599889, 8793277256263635044, 448623437464918480, 1857310021116627925,
     6145634616307237342, 1548353948794474539, 2318110128254703527, 8347759953730634762
out: 3627923032009111551, 1460752551327577353, 1084214837491058067, 1841622875286057462,
     3996252440506437984, 1276718204392552803, 8564515621134952155, 9252927025993202701,
     1147435538714642916, 16407277821156164797, 11997661877740155273, 12485021000320141292
```

### 11.5 Additional reference vectors (m = 4)

```
hashNoPad([11295517158488612626, 10669470463693797151, 17232114065640264171, 4175927072186299193,
           13985285184240204531, 7901017084268693144, 4326299618263946178, 14787024750292535041,
           894520636503353046, 12556655399058578835, 3097737892474696200, 7515335668060050861])
  = [15396602476382546759, 12422280135166335470, 8165681190607828974, 3475588160239961712]

hashNoPad([p+1, p+2, p+3, 2^64−1, 2^64−2])
  = [14216040864787980138, 17275303675000904868, 11831395338463193314, 281267649235863375]

hashTwoToOne([3777312593917610528, 6858608920877200812, 5269611035257552853, 10607733449481270434],
             [10355703322562521155, 1039917189921776884, 10844249567941924238, 14291130953945924124])
  = [1453933811752520343, 16186418140372484281, 9207215809524681813, 10182182911172027974]
```

---

## 12. Deviations from the reference, and why

| Reference behaviour | Our design | Rationale |
|---|---|---|
| Two parallel Poseidon2 packages | one implementation | proven functionally identical |
| `Sign(msg, hFunc hash.Hash)` with the hash argument ignored | `sign(msg)` | dead parameter, ~24 misleading call sites |
| `hash.Hash` streaming digest, `HashPair`, `HashPairBytes`, `HashNToMNoPadBytes` | omitted | unused by the SDK; a byte API on a padding-free sponge is a footgun |
| Lazy non-canonical `uint64` representation | always canonical `bigint` | congruence-preserving, removes a whole class of comparison bugs |
| `…NoPad` naming | dropped | there is no padded variant to disambiguate from |
| Hand-rolled hi/lo Goldilocks reduction | plain `% p` with bounded deferral | measured 2–3× *faster* in JS (§7.5) |
| `numOutputs == 0` hangs forever | `RangeError` | reachable via a caller bug |
| `HashNToOne([])` panics on index | `TypeError` | same |
| Nested `[8][12]` constant tables | flat 96-entry array | one indirection fewer per lane per round |
| Constants hand-written in source | generated + digest-pinned | upstream rotation must not land silently |

---

## 13. Risks

- **Silent field-order divergence.** This layer can be 100 % correct and every transaction still be
  rejected if the tx codec orders or types a single element differently. The KAT corpus in §10 must
  eventually be extended to *end-to-end* `TxInfo.Hash()` vectors driven through `lighter-go`, not
  just the primitive.
- **Constant rotation upstream.** `lighter-go` pins `poseidon_crypto v0.0.15`; the sequencer runs
  whatever it runs. The digest gate detects a change at build time but cannot detect one deployed
  server-side. Mitigate with a live conformance check (sign a known payload, ask the API to
  validate) in the integration test tier.
- **BigInt performance in Workers.** 31 k permutations/s is ample for a client SDK but Workers have
  a 10 ms CPU budget on the free tier; the Schnorr scalar multiplication, not this, is what needs
  measuring against that budget.
- **`noUncheckedIndexedAccess` friction.** If the team disables it for convenience, the `State`
  tuple type stops paying for itself and off-by-one lane bugs become silent. Keep it on.
- **Cross-dimension file ownership.** `src/crypto/field/**` belongs to dimension 01. If the
  poseidon2 units land first they must not create a competing `src/crypto/goldilocks.ts`. If
  dimension 01's `Fp5` turns out to be branded rather than a bare tuple, §7.2's structural
  assumption needs the constructor path instead — a small, mechanical fix, but it must be caught in
  review rather than papered over with a cast.
- **Untested multi-squeeze path.** Until §10.2 item 1 lands, `numOutputs > 8` is unexercised by the
  corpus. It is not reachable from any current Lighter call site (`m` is only ever 4 or 5), so this
  is latent rather than live — but it is exactly the kind of gap that bites when a future tx type
  needs a wider digest.
