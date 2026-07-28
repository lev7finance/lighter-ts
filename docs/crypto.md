# `lighter-ts/crypto`

Everything needed to derive a public key, sign a hashed message, and verify a signature — plus the
layers underneath, which are exported because they are what the conformance vectors pin and what
anyone auditing this package will want to reach directly.

```ts
import { ApiKey, verify } from "lighter-ts/crypto";

const key = ApiKey.fromPrivateKey("0x…80 hex characters…");
const sig = key.sign(hashedMessage);            // 80 bytes, synchronous, on every runtime
verify(key.publicKeyBytes, hashedMessage, sig); // true
```

Signing is synchronous everywhere. Nothing on the path is async, so the signature is available in
the same tick, and no part of the SDK is forced into an async API to accommodate it.

Importing this module evaluates nothing: no network call, no timer, no mutated global, and no
randomness. `globalThis.crypto` is resolved per call, never at module scope, because Cloudflare
Workers forbid randomness in the isolate's global phase. The one memoised table — the generator's
window for scalar multiplication — is built on first use.

---

## The stack

| layer | what it is | pinned by |
| --- | --- | --- |
| base field | Goldilocks `p = 2^64 − 2^32 + 1`: add, sub, mul, square, exp, sqrt, 8-byte LE codec | `conformance/vectors/goldilocks.json` |
| extension field | `GF(p^5) = GF(p)[X]/(X^5 − 3)`: arithmetic, Frobenius, Legendre, sqrt, 40-byte codec | `gfp5.json` |
| hash | Poseidon2 permutation and sponge, `hashToQuinticExtension`, `hashNoPad`, `hashNToM` | `poseidon2.json` |
| scalar field | `Z/nZ`: private keys, both halves of a signature, the nonce and the challenge | `curve.json` (`scalarReduction`), `schnorr.json` |
| group | ECgFp5 point add/double, encode/decode, `[s]P`, `[s]G`, `[s]G ⊕ [e]P` | `curve.json` |
| signature | key derivation, sign, verify | `schnorr.json` |
| everything at once | transaction hashes and signatures, auth tokens, EIP-191 message bodies | `tx.json` |

`tx.json` is the file that matters most: it exercises every layer in the same order production
signing does.

### Sizes

| thing | bytes |
| --- | --- |
| private key | 40 (one scalar, five 64-bit limbs, little-endian) |
| public key | 40 (one `GF(p^5)` element) |
| hashed message | 40 (one `GF(p^5)` element) |
| signature | 80 — `s` as 40 LE bytes, then `e` as 40 LE bytes |

`ApiKey` exposes `privateKeyBytes`, `publicKeyBytes`, `privateKeyHex` and `publicKeyHex`. The byte
accessors return a fresh copy per read, so mutating the result changes nothing. The hex accessors are
`0x`-prefixed and lowercase, which is the form the server string-compares against.

---

## Three things that look like bugs and are not

Each of these has been "fixed" by someone reading the code, and each fix produces output the
exchange does not recognise, with no error anywhere in the stack.

### 1. `sgn0` tests whether coefficient 0 is **even**

```ts
export function fp5Sgn0(a: Fp5): boolean {
  return (a[0] & 1n) === 0n;
}
```

This is **inverted** relative to RFC 9380 and the Rust ecgFp5 reference, both of which define the
sign as "first non-zero limb is odd". It is not a transcription slip. The Go reference tests
`limb & 1 == 0`, and the exchange runs the Go verifier.

It feeds `fp5CanonicalSqrt`, which feeds curve point decompression, which feeds public-key
derivation. Flipping it silently produces public keys the sequencer has never seen. `fp5Sgn0(0)` is
`true`, pinned by case 0 of `gfp5.json`.

The reference writes it as a five-iteration "first non-zero limb" loop. That loop provably collapses
to the single test above: at `i = 0` the empty prefix is all-zero, so the term is exactly "c0 even";
if c0 is even the disjunction is already true, and if c0 is odd then c0 is non-zero and no later term
can fire.

### 2. `POWER_OF_TWO_GENERATOR = 7277203076849721926` is not `7^((p−1)/2^32)`

That expression evaluates to `1753635133440165772`. The constant is inherited verbatim from plonky2
and cannot be re-derived from the modulus.

It decides *which of the two* square roots Tonelli–Shanks returns. That choice propagates into
`GF(p^5)` square roots, then into point decompression, then into public-key derivation. gnark seeds
from `15733474329512464024` and returns the other root for some inputs; it is not a substitute.
Substituting the derived value produces square roots that are individually valid and collectively the
wrong branch.

The sibling constant `FP5_DTH_ROOT = 1041288259238279555` is `3^((p−1)/5)`, the fifth root of unity
driving Frobenius. The four Frobenius tables satisfy `FROBk[i] === FP5_DTH_ROOT^(k·i) mod p`, and the
tests re-derive them from that identity, so a transcription slip there cannot survive.

### 3. Poseidon2 has no padding, no domain separation and no length encoding

The state starts at twelve zeros for every call from every caller. Absorption **assigns** into the
rate lanes (`S[j] = input[i+j]`, never `+=`, never `^=`), the four capacity lanes are never written
by absorption at all, and a short final block leaves the untouched rate lanes holding whatever the
previous permutation put there.

Four consequences, all of them expected behaviour and all asserted by the tests:

1. **`H([1]) === H([1, 0])`**, and so on for trailing zeros up to the rate of eight.
2. **`H([]) === 0`.** An empty input performs zero permutations; the result is read straight out of
   the all-zero state. `hashToQuinticExtension([])` is the `GF(p^5)` zero and `hashNoPad([])` is
   `[0,0,0,0]`.
3. **A short final block does not re-zero the rest of the rate.** For a nine-element input the second
   block writes `S[0]` only. Re-zeroing `S[1..7]` is padding by another name and changes the hash for
   every input whose length is not a multiple of eight.
4. **There is one Poseidon2, not two.** `poseidon_crypto` ships two implementations and the reference
   SDK uses both — plonky2 for transaction hashing, gnark for auth tokens. Run over the same input
   they produce byte-identical output; they differ in internal field representation, not in the
   function computed.

Collision resistance for transactions comes entirely from the caller's fixed-arity element layout,
which lives in the transaction codec. Adding a length prefix or a capacity tag here would make every
hash this SDK produces incompatible with the sequencer.

Two further permutation details, both classic Poseidon2 mistakes: the external linear layer is
applied **once before round 0**, and within each 4-lane chunk the four outputs are defined in terms
of the *original* inputs — `y3 = t + x3 + 2·x0` needs `x0` before it is overwritten. Snapshot the
chunk before writing any of it.

---

## The signing nonce

`k` is **hedged-deterministic by default**: derived with Poseidon2 from the private key and the
message hash, mixed with fresh randomness.

```ts
key.sign(hashedMessage);                        // hedged (default)
key.sign(hashedMessage, { nonce: "random" });   // 64 CSPRNG bytes reduced mod n
key.sign(hashedMessage, { nonce: 0x1234n });    // explicit k, for vectors
```

This is free in compatibility terms: `k` never appears on the wire — only `(s, e)` do — so any
correctly derived nonce yields a signature the sequencer accepts and a verifier cannot distinguish.
What changes is the failure mode. Under pure randomness a weak or repeating RNG leaks the private key
outright after two signatures, silently. Deriving from the key and the message removes that cliff,
and the hedge preserves protection against fault attacks.

Poseidon2 rather than HMAC-SHA-256, which would have kept the nonce and the challenge on different
primitives: a hand-written synchronous SHA-256 is roughly 150 lines of unvalidated cryptography on
the signing path, and WebCrypto cannot substitute because `crypto.subtle.digest` is async while
signing is synchronous. Poseidon2 is already implemented and already vector-pinned.

An explicit `k` is reduced mod `n` rather than range-checked, matching every other scalar entry
point. Zero is the one value that cannot be used: `k = 0` publishes `R = O` and `s = −e·sk`, which is
the private key up to a known factor.

**A broken nonce derivation passes every signature conformance test.** Verification only reconstructs
`R` and the challenge; it cannot observe where `k` came from. A nonce that is constant, biased,
endian-swapped, or accidentally independent of the message verifies perfectly and leaks the key on
the second signature. So the nonce carries its own test gate, separate from the signature vectors:
fixed `(sk, msg, entropy) → k` cases including all-zero entropy, same-key/different-message and
different-key/same-message, an assertion that `k ∈ [1, n)`, and an explicit nonce-reuse test that
recovers the private key from two signatures so the failure mode stays visible.

The entropy draw is per call, never at module scope — Cloudflare Workers forbid
`crypto.getRandomValues` in the isolate's global phase.

---

## `verify()` rejects the neutral public key, with no opt-out

```ts
verify(publicKey: Uint8Array, hashedMessage: Uint8Array, signature: Uint8Array): boolean
```

`verify` takes **no options at all**. There is no `allowNeutralPublicKey` flag, it is not covered by
any general "strict" mode, and it must never exist.

`Decode(0)` deliberately succeeds in the reference and returns the neutral point, and the reference's
verification does not reject the result. For that public key anyone can forge a signature over any
message: pick `s`, compute `R = [s]G`, set `e = H(encode(R) ‖ m)`. This is a live universal forgery,
not a theoretical one. An option to permit it would turn a known forgery into a supported
configuration.

Nothing is lost by rejecting it: no legitimate account holds the neutral key.

---

## Parsers on the signing path reduce; strict parsing is opt-in

The reference **accepts** non-canonical input. `SigFromBytes` parses both halves with the reducing
scalar decoder, and `Fp5.FromCanonicalLittleEndianBytes` checks length only — it loads five raw limbs
without comparing against `p`. Verified: signatures with `s + n`, `e + n`, or both re-encoded into the
raw bytes all still validate (`schnorr.json`, the `malleable` cases).

So a strict parser rejects signatures the sequencer accepts. That is an interop bug, not extra
safety. The split:

| path | behaviour |
| --- | --- |
| `sign`, `verify`, key import | exact length check, then **reduce** |
| explicit decode API | strict — `fp5FromBytesStrict`, `scalarFromBytesStrict` reject non-canonical input |
| all encoders | always canonical |
| internal arithmetic | always canonical |

The names are inverted from the obvious convention on purpose. `fp5FromBytes` *reduces* — reference
semantics, the interoperable default — and `fp5FromBytesStrict` rejects. Naming the reducing variant
`…Unchecked` would make the correct choice look like the unsafe one and guarantee that someone wires
`verify` to the wrong parser. Nothing on the sign/verify path calls the strict variants.

### Canonical field elements

The Go reference stores a Goldilocks element as a raw `uint64` in **non-canonical** form: arithmetic
reduces into `[0, 2^64)` and the stored value may sit one `ORDER` above the true residue. It is
observable on the key path — `GENERATOR_WEIERSTRASS.Encode()` and `SchnorrPkFromSk(1)` both return
limbs above the modulus — and both views serialize to the same bytes, because every serialization path
canonicalizes.

`lighter-ts` reduces fully on every operation, and every expected value in the vectors is canonical.
The partially reduced representation is a 64-bit-hardware optimisation with no analogue under
`BigInt`; do not reimplement it. The divergence is recorded with worked examples under
`nonCanonicalNotes` in `goldilocks.json`.

Related, and measured: **plain `(a * b) % P` beats hand-folded Goldilocks reduction by 2.5–4× on
every engine tested.** The Go intuition inverts under `BigInt`, where each folding intermediate is a
heap allocation. `%` is used everywhere, including inside Poseidon2. Numbers are in
[`bench/README.md`](../bench/README.md); re-run before revisiting the strategy.

---

## The one arithmetic trap

JavaScript's `%` follows the sign of the dividend, so `(-1n) % n === -1n`, not `n - 1`. The signature
equation is `s = (k − e·sk) mod n`, and `k − e·sk` is negative for roughly half of all signatures.

```ts
const modN = (x: bigint): bigint => { const r = x % N; return r < 0n ? r + N : r; };
s = modN(k - modN(e * sk));
```

Every field, hash and curve operation can be perfectly correct while signing still fails on this
alone, because serializing a negative scalar through shifts or `BigInt.asUintN(320, …)` yields a
different, invalid value. `modN` is used in every scalar constructor, subtraction, nonce parser and
private-key reduction.

---

## What is not claimed

**No constant-time execution.** Constant-time is not achievable in portable TypeScript and this
package does not claim it. `BigInt` operations allocate, their cost tracks operand magnitude, there is
no way to pin a value to a fixed width, and the engine is free to specialise on observed values.

What *is* guaranteed on the scalar-multiplication path is narrower and worth stating precisely: **no
secret-dependent control flow, no secret-dependent loop counts, and no secret-dependent memory
indexing.** The window lookup touches all sixteen table entries in the same order every time and
selects arithmetically; the loop always runs 64 digits with no early exit and no sizing from the
scalar's bit length. That is meaningful against coarse remote timing. It is **not** a defence against
a co-resident attacker observing cache lines, nor against `BigInt` allocation side channels.

The reference is inconsistent here — it masks the in-loop lookup but reads the top digit with a
variable-time one, leaking the top five bits of the secret scalar. That is not reproduced: every
digit including the top uses the branchless lookup. `mulAddG`, which sees only public data, uses the
variable-time path throughout.

**No key-memory wiping.** A `bigint` cannot be zeroed: the engine owns the allocation, it may be
copied by the garbage collector, and there is no portable way to overwrite it. `privateKeyBytes`
returns a fresh copy you *can* zero, but the scalar behind it stays until it is collected.

Treat a private key used in a shared or hostile runtime as exposed to a local attacker. There is no
injection seam for the L2 API key — unlike L1 signatures, this package does the L2 signing itself and
therefore holds the key — so if that exposure is unacceptable, the mitigation is to isolate the
process, not to configure the SDK differently.
