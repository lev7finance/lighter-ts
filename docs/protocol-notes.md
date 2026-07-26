# Protocol notes

Things about the Lighter protocol that are true, non-obvious, and expensive to rediscover.

Everything here was established by **running** the reference implementation or the live API, not by
reading and inferring. Where a claim came from a spec that turned out to be wrong, the correction is
recorded rather than the original.

`lighter-ts` is written independently of the reference SDKs. This document is the shared
understanding of what the protocol requires; `conformance/vectors/` is the machine-checkable
version of it.

---

## 1. Field elements are canonical here, and were not there

The Go reference stores a Goldilocks element as a raw `uint64` in **non-canonical** form.
`AddF`/`SubF`/`MulF` reduce only into `[0, 2^64)`; the stored value may sit one `ORDER` above the
true residue. `ToCanonicalUint64` applies the final conditional subtraction, and every
serialization path calls it. The decoder, `FromCanonicalLittleEndianBytesF`, performs **no** range
validation at all — a limb `>= ORDER` decodes to a non-canonical element rather than an error.

Proof it is observable, and that it reaches the key path rather than some internal corner —
measured directly:

```
GENERATOR_WEIERSTRASS.Encode()   raw=[ORDER+4, ORDER, ORDER, ORDER, ORDER]   canonical=[4, 0, 0, 0, 0]
SchnorrPkFromSk(1)               raw=[ORDER+4, ORDER, ORDER, ORDER, ORDER]   canonical=[4, 0, 0, 0, 0]
```

Public-key derivation itself returns limbs above the modulus. Both views serialize to the same
bytes, because serialization canonicalizes.

**Decision:** `lighter-ts` reduces fully on every operation. All expected values in
`conformance/vectors/` are canonical. This is safe because every value that escapes the field layer
— bytes, equality, point encoding, signatures — passes through canonicalization in the reference
too. The divergence is documented with worked examples under `nonCanonicalNotes` in
`goldilocks.json`.

The partially-reduced representation is a 64-bit-hardware optimization with no analogue under
`BigInt`. Do not reimplement it.

---

## 2. There is one Poseidon2, not two

`poseidon_crypto` ships two implementations and the reference SDK uses **both**:

| Path | Import | Element type |
| --- | --- | --- |
| Transaction hashing (`types/txtypes/*.go`) | `hash/poseidon2_goldilocks_plonky2` | plain `uint64` |
| Auth tokens (`types/tx_request.go:10`) | `hash/poseidon2_goldilocks` | gnark Montgomery |

Reading the source, this looks like two hash implementations are required. Running both over the
same input shows byte-identical output. They differ in internal field representation, not in the
function computed.

**Implement one Poseidon2 and use it everywhere.**

### 2.1 Parameters

Width 12, rate 8, output 4, S-box degree 7, 8 full rounds (4 before + 4 after) and 22 partial
rounds. All 130 constants — the 8×12 external, the 22 internal, and the 12-element internal
diagonal — are dumped mechanically into `conformance/vectors/poseidon2.json` under `constants`.
Generate the TypeScript constants module from that file. Do not transcribe them; a one-digit slip
produces a hash that is wrong for every input and traceable to nothing.

### 2.2 There is a linear layer *before* the first round

The permutation applies the external linear layer once before round 0, then the rounds. Omitting
that pre-round layer is a classic Poseidon2 mistake and yields a completely wrong hash.

### 2.3 The external layer's 4-lane step is order-dependent

Within each 4-lane chunk the outputs are defined in terms of the **original** inputs — notably
`y3 = t + x3 + 2*x0` needs `x0` before it is overwritten. Writing the four assignments in place, in
order, silently computes a different permutation.

```
for each chunk c in {0, 4, 8}:
    x0, x1, x2, x3 = s[c], s[c+1], s[c+2], s[c+3]   # snapshot BEFORE any write
    ... compute all four outputs from the snapshot ...
```

### 2.4 The internal layer is `sum + state[i] * diag[i]`

`MulAccF(self, x, y)` computes `self + x*y`. So the internal linear layer is
`state[i] = sum + state[i] * MATRIX_DIAG_12[i]`, where `sum` is over **all 12** lanes.

Use the diagonal values raw. Do not subtract one from them, and do not special-case lane 0 — lane 0
uses `diag[0]` on its post-S-box value like every other lane.

### 2.5 `hashTwoToOne` is an 8-lane input, not a 12-lane compression

It builds an 8-element input, leaving the four capacity lanes zero going into the permutation.
Implementing it as a permutation over 12 populated lanes is wrong.

Also: the reference never calls `HashNToOne` with more than two elements. In practice it *is*
`hashTwoToOne`.

### 2.6 `HashNToMNoPad` with `numOutputs <= 0` never terminates

Its length check is performed *after* appending, so zero or negative output counts loop forever.
Guard the argument.

---

## 3. Turning protocol integers into field elements

### 3.1 Negative values sign-extend, then reduce

A negative protocol integer is sign-extended to 64 bits and then reduced mod `p`. So
`AccountIndex = -1` (which is legal — it is `MinAccountIndex`) becomes **`4294967294`**, i.e.
`2^32 - 2`. It does **not** become `p - 1`.

Both are plausible-looking field elements and only one is right:

```ts
const e = BigInt.asUintN(64, BigInt(v));
return e >= P ? e - P : e;   // a single conditional subtraction is exact here
```

Pinned by `cancel_all_orders/negative_account_index` in `tx.json`.

### 3.2 The lo/hi split is per-field, not per-width

Some values are absorbed as **two** field elements, low half then high half. This is **not** a rule
about width — it is hard-coded at exactly four sites:

| Transaction | Field | Type | Split |
| --- | --- | --- | --- |
| `L2Transfer` | `Amount` | int64 | `u64(v) & 0xFFFFFFFF`, then `u64(v) >>> 32` (logical) |
| `L2Transfer` | `USDCFee` | int64 | same |
| `L2Withdraw` | `Amount` | uint64 | `v & 0xFFFFFFFF`, then `v >>> 32` (logical) |
| `L2UpdateMargin` | `USDCAmount` | int64 | `v & 0xFFFFFFFF`, then `v >> 32` (**arithmetic**) |

Every other field is absorbed as a single element — **including fields that exceed 32 bits**.
`BaseAmount` reaches `2^48 - 1` and `OrderExpiry` is a millisecond timestamp, and neither is split.
Deriving the split from a value's magnitude produces wrong hashes for large orders.

`L2UpdateMargin.USDCAmount` is the only split field where a negative value survives validation —
the validator checks `!= 0` and an upper bound but has **no lower bound**, confirmed by the
reference accepting `-1` and `-2^32`. Its arithmetic shift is therefore reachable, and the order of
operations matters:

```ts
const lo = fromI64(x & 0xffff_ffffn);
const hi = fromI64(x >> 32n);   // arithmetic shift, while x is STILL SIGNED
```

Normalizing to unsigned first and then shifting gives a different high half — for `x = -1` it
yields `4294967295` where the reference produces `4294967294`. Pinned by the three
`update_margin/negative_*` vectors.

### 3.3 Transaction hash shape

```
elements = [chainId, txType, nonce, expiredAt, ...type-specific fields...]
txHash   = hashToQuinticExtension(elements)
result   = attributes.aggregate(txHash)
```

`aggregate` returns `txHash` as 40 little-endian bytes when the attribute set is empty. Otherwise it
hashes the attributes, concatenates the two 5-element hashes into a 10-element input, and hashes
again.

Attribute normalization: nonzero types in ascending order, padded with zeros to 4 entries, each
contributing **two** elements (type, value) — *including* the padding zeros.

---

## 4. Grouped orders

Per-leg hashes are folded pairwise. The accumulator is initialized to an empty hash but that value
is **dead**: index 0 assigns the leg hash directly rather than folding into the empty accumulator.
Folding from empty produces a different result.

```
acc = legHash(orders[0])
for i in 1..n-1:  acc = hashTwoToOne(acc, legHash(orders[i]))
```

Each leg contributes exactly 10 elements: market index, client order index, base amount, price,
is-ask, type, time-in-force, reduce-only, trigger price, order expiry.

Legality is per grouping type, and the reference validator enforces it strictly:

| Type | Legs | Rules |
| --- | --- | --- |
| **OTO** (1) | exactly 2 | child size must be nil; opposite sides; expiries agree if the parent's is set |
| **OCO** (2) | exactly 2 | equal sizes; same side; both reduce-only; identical expiry; one stop-loss and one take-profit |
| **OTOCO** (3) | exactly 3 | both children nil-sized and opposite the parent; children share an expiry; one stop-loss, one take-profit |

Parent legs must be limit or market orders; child legs must be stop-loss or take-profit variants.

---

## 5. Signing

### 5.0 JavaScript `%` returns negative values — this will break signing

The signature equation is `s = (k − e·sk) mod n`. In Go this is a scalar-field subtraction that
adds `n` back on underflow. In JavaScript, `%` follows the sign of the dividend:

```js
(-1n) % n === -1n     // not n - 1
```

`k − e·sk` is negative for roughly half of all signatures, so a literal `(k - e * sk) % N` produces
a negative scalar. Serializing that through shifts or `BigInt.asUintN(320, …)` yields a different,
invalid scalar — and every field, hash and curve operation can be perfectly correct while signing
still fails.

```ts
const modN = (x: bigint): bigint => { const r = x % N; return r < 0n ? r + N : r; };
s = modN(k - modN(e * sk));
```

Use `modN` in **every** scalar constructor, subtraction, nonce parser, and private-key reduction.
This is the single most likely way to get a correct-looking implementation that cannot sign.

### 5.1 The nonce is ours to choose

The reference samples the Schnorr nonce `k` at random. `lighter-ts` defaults to
**hedged-deterministic**: derived from the private key and message hash, mixed with fresh
randomness.

This is free in compatibility terms — `k` never appears on the wire, only `(s, e)` do, so any
correctly-derived nonce yields a signature the sequencer accepts and a verifier cannot distinguish.
What changes is the failure mode. Under pure randomness a weak or repeating RNG leaks the private
key outright after two signatures, silently.

An explicit-`k` seam stays available; the conformance vectors depend on it.

**Cloudflare Workers forbids `crypto.getRandomValues` at module scope.** Nonce generation must be
per-call, never at module initialization.

Deriving the nonce needs a PRF. **Use Poseidon2** — already implemented, already vector-pinned, and
synchronous. Do not hand-roll SHA-256 and HMAC for this: `crypto.subtle.digest` is async and
signing is synchronous, so a WebCrypto route forces an async signing API, and a hand-written
SHA-256 adds a second unvalidated primitive whose failure is invisible.

That invisibility is the real hazard: **a broken nonce derivation passes every signature
conformance test.** Verification only reconstructs `R` and the challenge; it cannot observe where
`k` came from. A nonce generator that is constant, biased, endian-swapped, or accidentally
independent of the message produces signatures that verify perfectly and leak the private key on
the second one. So the nonce derivation needs its own tests: fixed `(sk, msg, entropy) → k`
vectors including all-zero entropy, same-key/different-message and different-key/same-message
cases, an assertion that `k ∈ [1, n)`, and an explicit nonce-reuse regression demonstrating key
recovery so the risk stays visible.

### 5.2 Signature and key encodings

Signature is 80 bytes: `s` as 40 little-endian bytes, then `e` as 40 little-endian bytes. Public
keys are 40 bytes. Message hashes are 40 bytes (one `GF(p^5)` element).

### 5.2.1 Parsers reduce; they do not reject

The reference's `SigFromBytes` parses both halves with the **reducing** scalar decoder, and
`Fp5.FromCanonicalLittleEndianBytes` checks length only — it loads five raw limbs without comparing
against `p`.

So the reference **accepts** non-canonical public keys, message hashes, and signatures. Verified:
signatures with `s + n`, `e + n`, or both re-encoded into the raw bytes all still validate
(`conformance/vectors/schnorr.json`, `malleable`).

This makes strictness a real interop decision, not a style preference — a strict parser rejects
signatures the sequencer accepts. Split it:

- **Internal arithmetic** — always canonical.
- **Parsers on the `sign`/`verify` path** — check length exactly, then reduce.
- **Strict parsers** — available, but explicit opt-in.
- **Encoders** — always canonical.

Canonical *arithmetic* is observationally identical to the reference. Canonical *parsing* is not.

### 5.2.2 The neutral public key is a universal forgery — reject it

`Decode(0)` deliberately succeeds and returns the neutral point, and the reference's verification
does not reject it. For that public key anyone can forge: pick `s`, compute `R = [s]G`, set
`e = H(encode(R) ‖ m)`.

Reject the neutral public key in `verify`, with **no** opt-out flag. An `allowNeutralPublicKey`
option turns a known universal forgery into a supported configuration. If bug-for-bug reference
behaviour is ever needed for diagnostics, it belongs in a test-only function named to say so.

### 5.3 L1 signatures are injected, not implemented

Four flows need an Ethereum `personal_sign` (EIP-191): registering an API key (`change_pub_key`),
`transfer`, `approve_integrator`, and `create_sub_account`.

The SDK builds the exact message string — which is the part that is easy to get wrong, and is
pinned in `tx.json` under `l1Messages` — and takes the signature from an injected `L1Signer`. It
does not ship secp256k1 or keccak256.

Message formatting is unforgiving: every numeric argument renders as `0x` followed by exactly 16
zero-padded lowercase hex digits, and the transfer memo is the raw 32-byte field hex-encoded.

---

## 6. Auth tokens (authenticated reads)

```
message   = "<deadlineUnixSeconds>:<accountIndex>:<apiKeyIndex>"
elements  = pack(utf8(message))   // 8 bytes per element, little-endian, final chunk zero-padded
msgHash   = hashToQuinticExtension(elements).toLittleEndianBytes()
token     = message + ":" + hex(schnorrSign(msgHash))
```

The packing helper validates each 8-byte chunk against the modulus and errors rather than reducing.
It cannot trigger for this message format — ASCII digits and colons never produce a chunk near `p` —
but keep the check.

The reference pre-generates tokens on 6-hour aligned boundaries with an 8-hour expiry, so validity
windows overlap and a lookup by current aligned timestamp always finds a live token.

---

## 7. Chain IDs

| Network | Chain ID | Base URL |
| --- | --- | --- |
| mainnet | **304** | `https://mainnet.zklighter.elliot.ai` |
| testnet | **300** | |
| rh | **466324** | |

The chain ID is an input to **every** transaction hash and is **not** discoverable from
`/systemConfig`. It must be configured.

---

## 8. REST

### 8.1 Two independent failure channels, and the envelope is not universal

Errors arrive as HTTP 4xx with `{"code": <int>, "message": <string>}`. Most success responses
**also** carry `"code": 200` in the body. Both the HTTP status and the body code must be checked —
treating HTTP 200 as success is not sufficient.

But **some endpoints return no `code` field at all**. Measured:

```
GET /withdrawalDelay?account_index=1   ->   {"seconds":1542}
```

So the rule cannot be "success requires `code === 200`" either — that would reject a perfectly good
response. The correct rule is: a response is an error if `code` is **present and not 200**, or if
the HTTP status is not 2xx. A missing `code` is success.

### 8.1.1 Authentication is passed one of two ways

Discovered from the error text on an unauthenticated call:

```
GET /transferFeeInfo?account_index=1
{"code":20001,"message":"invalid param : auth query param and Authorization header are empty"}
```

The auth token goes in either the **`auth` query parameter** or the **`Authorization` header**.
Neither reference SDK documents this. Prefer the header; the query parameter puts a bearer credential
into URLs, access logs, and referrers.

Observed: `20001` for invalid/missing parameters, `29404` for not-found (inside an HTTP 400).
Neither reference SDK documents any of these — Go defines only `CodeOK = 200` and Python's
`errors.py` is two lines. Surface the raw numeric code; do not assume the observed set is complete.

`message` has trailing whitespace (`"invalid param "`). Match on `code`, never on message text.

### 8.2 A non-JSON body is normal

Cloudflare sits in front of the API. Unknown paths and some blocked requests return an HTML
interstitial with HTTP 403 that never reaches the API. Calling `.json()` unconditionally throws a
`SyntaxError` that tells the caller nothing. Detect the content type and raise a distinct transport
error.

Requests must send an explicit browser-like `User-Agent`; some paths 403 without one.

### 8.3 There is no reachable OpenAPI document

`/api/v1/swagger/doc.json`, `/swagger/doc.json`, `/openapi.json` and `/swagger.json` all return 403
with the same `User-Agent` that gets 200 on `/orderBooks`. Generating types from a spec at build
time is not an available strategy.

### 8.4 Money arrives as decimal strings

`/orderBooks` returns 227 markets, each with `supported_size_decimals`, `supported_price_decimals`
and `supported_quote_decimals`. Monetary and size fields are decimal **strings**. Never parse them
through `Number` — the precision loss is silent and financial.

---

## 9. Order sizing arithmetic — four hazards in the reference

Found by reading `lighter-python/lighter/signer_client.py` and then executing the arithmetic.

1. **`round()` is not `Math.round()`.** Python rounds half-to-even; JavaScript rounds half-up.
   `round(2500.5)` is `2500` in Python and `2501` in JavaScript. They agree on odd halves and
   disagree on even ones, so it survives casual testing.
2. **`int(quote_amount * 1e6)` loses money.** `8.2 * 1e6` is `8199999.999999999`, truncated to
   `8199999`. A user asking to spend 8.2 USDC gets an order for 8.199999.
3. **`int(price.replace(".", ""))` is correct only by accident.** It works because the API pads to
   the market's decimals. `"2500.1"` would become `25001` — off by 100×.
4. **Return types diverge by branch.** `potential_execution_price` is an exact `Fraction` when
   sizing by quote amount and a lossy `float` when sizing by base amount.

**Consequence:** all price and size arithmetic is integer/rational end to end. No `number`, no
`Math.round`. Rounding direction is stated per call site — a buy's acceptable price rounds up, a
sell's rounds down — so rounding never loosens slippage protection.

---

## 10. WebSocket

### 10.1 Protocol

Connect to `wss://<host>/stream`. The server opens with `{"type":"connected"}`; subscribe only
after receiving it. Subscribe with `{"type":"subscribe","channel":"order_book/<market_id>"}`.
Replies are `subscribed/<channel>` then `update/<channel>`, with the channel echoed as
`"<name>:<id>"`.

Keepalive is **application-level JSON**: the server sends `{"type":"ping"}` and expects
`{"type":"pong"}`. This matters — protocol-level ping/pong frames are not exposed by the browser or
Cloudflare Workers `WebSocket` API, but a JSON heartbeat works identically everywhere, so no `ws`
package is needed.

### 10.2 The reference client is a demo

`lighter-python/lighter/ws_client.py` is 172 lines and not production-viable. Its defects are our
requirements:

- **The book becomes unsorted.** Snapshots arrive sorted, but updates *append* new price levels to
  the end. After the first new level, `bids[0]` is no longer the best bid.
- **No sequence tracking and no gap detection.** A dropped delta desynchronizes the book silently
  and permanently.
- **O(n·m) per message** — a linear scan of the whole book per incoming level, then a full filter
  pass.
- **`float()` used to test sizes** — the same floating-point-money hazard.
- **Unknown message types raise**, so a new server-side message type takes the client down.
- **No reconnect, no backoff, no resubscribe** — `on_error` and `on_close` both raise.
- **Only two channels are handled.**

So: offset tracking with an explicit resync-on-gap path, a sorted price-indexed book, exact decimal
comparison, reconnect with backoff and automatic resubscribe, forward-compatible handling of
unknown messages, and the full channel set.

---

## 11. Odds and ends found in the reference

- `Legendre` returns a base-field element, not a signed value: `1` for a non-zero square,
  `p - 1` for a non-square, `0` for zero.
- `Sqrt(0)` returns `(0, true)` — zero *is* a square. So does `CanonicalSqrt(0)`.
- `RepeatedFrobenius` with a negative count is a latent reference bug: the guards let it through and
  the loop does not execute. Reject non-positive counts.
- `FromNonCanonicalBigInt` genuinely reduces (`Mod`) despite the name — it is not a limb re-split
  no-op, and there is no reference bug here.
- The scalar field is **not** in Montgomery form at rest. `Mul` converts in and out, cancelling the
  factors, and yields the plain product mod `n`.
- Public pool and staking pool indices must sit in the sub-account range (`>= 2^47`).
- The per-market cancel-all attribute is only valid alongside `ImmediateCancelAll`.
