# Spec 04 — Transaction Types, Hashing, Validation, and JSON Wire Format

Status: normative functional specification for the clean-room TypeScript Lighter SDK
(`lev7finance/lighter-ts`). Everything here describes *observable protocol behaviour* that the
sequencer enforces. Where the reference implementations have accidental complexity, that is called
out explicitly under **[DEFECT]** and a better TypeScript design is proposed.

Companion specs (referenced, not duplicated here):
- `01`/`02` — Goldilocks field, Poseidon2 permutation, gFp5 quintic extension, Schnorr/ECgFp5 signer.
- `05` — REST transport & endpoint contracts.
- `06` — WebSocket.

---

## 0. Scope and the one-sentence summary

A Lighter L2 transaction is:

1. a **struct of small integers** (plus, for two tx types, a 40-byte public key or a 32-byte memo),
2. hashed by **absorbing an ordered list of Goldilocks field elements into Poseidon2**, squeezing 5
   field elements (a gFp5 element), optionally re-hashed together with an *attributes* hash,
   and serialised to **40 little-endian bytes**,
3. **Schnorr-signed over ECgFp5** with the API key, producing **80 bytes**,
4. serialised to **JSON with Go-style PascalCase keys**, and
5. submitted as a form-encoded `(tx_type, tx_info)` pair.

Interoperability therefore hinges on three things being byte-exact: **the ordered element list**,
**the integer→field-element reinterpretation rule**, and **the JSON encoding of `[]byte` / `[32]byte`**.

---

## 1. Numeric domain: how a protocol integer becomes a field element

### 1.1 The field

Goldilocks prime `p = 2^64 − 2^32 + 1 = 0xFFFFFFFF00000001 = 18446744069414584321`.

The reference stores field elements as raw `uint64` in *non-canonical* form: any `uint64` is an
acceptable representative, and canonicalisation is a single conditional subtraction
(`x >= p ? x − p : x`). This is sound because `2p > 2^64`, so every `uint64` is `< 2p`.

### 1.2 THE RULE (normative)

> For a protocol scalar `v` of declared width `W` and signedness `S`, the absorbed field element is
> **`BigInt.asUintN(64, BigInt(v)) mod p`** — i.e. sign-extend `v` to 64 bits, reinterpret the
> two's-complement bit pattern as an unsigned 64-bit integer, then reduce mod `p`.

This matters because several fields have negative sentinels:

| value | width | two's-complement u64 | canonical field element |
|---|---|---|---|
| `AccountIndex = -1` (`MinAccountIndex`) | int64 | `0xFFFFFFFFFFFFFFFF` | `0x00000000FFFFFFFE` = **4294967294** |
| `MarketIndex = -1` (int16, sign-extends) | int16 | `0xFFFFFFFFFFFFFFFF` | **4294967294** |

Note this is **not** `p − 1`. Any TS implementation that maps `-1 → p−1` will produce a different
tx hash and an invalid signature. Implement as: `const e = BigInt.asUintN(64, BigInt(v)); return e >= P ? e - P : e;`

### 1.3 64-bit value splitting

Three tx types split a 64-bit amount into two field elements (low 32 / high 32) rather than absorbing
it as one element. The three call sites are **not identical**:

| tx | field | declared type | low element | high element |
|---|---|---|---|---|
| `L2Withdraw` | `Amount` | `uint64` | `Amount & 0xFFFFFFFF` | `Amount >>> 32` (logical) |
| `L2Transfer` | `Amount`, `USDCFee` | `int64` | `u64(v) & 0xFFFFFFFF` | `u64(v) >>> 32` (logical, on the reinterpreted bit pattern) |
| `L2UpdateMargin` | `USDCAmount` | `int64` | `(v & 0xFFFFFFFF)` as int64 | `v >> 32` **arithmetic**, then §1.2 reinterpretation |

For non-negative values all three coincide. They diverge only for negative inputs.
`L2UpdateMargin.USDCAmount` is the only one where a negative value survives validation
(`Validate` rejects only `== 0` and `> MaxTransferAmount`), so the arithmetic-shift branch is reachable.

**[DEFECT]** The three-way divergence is accidental. **TS design:** implement one helper
`splitU64(v: bigint): [bigint, bigint]` using the logical rule, and one
`splitI64Arithmetic(v: bigint): [bigint, bigint]` used *only* by `L2UpdateMargin`, with a comment
pointing at this spec. Do not "unify" them.

### 1.4 40-byte public key → 5 field elements

`L2ChangePubKey.PubKey` is 40 bytes. It is parsed as a gFp5 element: 5 limbs, limb `i` =
little-endian `uint64` of `bytes[8i .. 8i+8)`. **No canonical-range check is performed on the limbs**
in the reference (`FromCanonicalLittleEndianBytesF` is a raw `binary.LittleEndian.Uint64`), so limbs
`>= p` are accepted and reduced lazily. Length must be exactly 40 or `ErrPubKeyInvalid`.

### 1.5 Hash output → bytes

A gFp5 element serialises to **40 bytes**: for `i` in `0..4`, canonicalise limb `i` and write it
little-endian at offset `8i`. This 40-byte string is:
- the message passed to the Schnorr signer, and
- the value hex-encoded (lowercase, **no `0x` prefix**, 80 hex chars) as the *transaction hash*.

---

## 2. The Poseidon2 sponge contract used by tx hashing

Only the structural contract is specified here; constants live in spec `01`.

```
WIDTH = 12, RATE = 8, OUT = 4, D = 7, ROUNDS_F = 8, ROUNDS_P = 22
```

`hashNToM(input: Field[], numOutputs): Field[]`:
- state = 12 zero elements
- for each block start `i` stepping by `RATE`: overwrite `state[j] = input[i+j]` for
  `j in 0..min(RATE, len-i)`, then permute.
  **The rate lanes are NOT zeroed between blocks.** A short final block leaves the unwritten rate
  lanes holding the previous permutation's output. There is **no padding**.
- squeeze: repeatedly emit `state[0..RATE)`, permuting between squeezes, until `numOutputs` collected.
- **Empty input ⇒ zero permutations ⇒ output is all zeros.**

Derived entry points:
- `hashToQuinticExtension(input) -> gFp5` = `hashNToM(input, 5)`
- `hashNoPad(input) -> HashOut(4)` = `hashNToM(input, 4)`
- `hashTwoToOne(a, b)` = `hashNoPad([a0,a1,a2,a3,b0,b1,b2,b3])` (exactly one full block)
- `hashNToOne(list)` = `list.length === 1 ? list[0] : list.slice(1).reduce(hashTwoToOne, list[0])`
  (left fold)

---

## 3. Transaction type codes

Complete table from the sequencer-shared constant block. "SDK" = this SDK can construct/sign it.

| Code | Name | Layer | SDK |
|---:|---|---|---|
| 0 | `Empty` | — | no |
| 1 | `L1Deposit` | L1 | no |
| 2 | `L1ChangePubKey` | L1 | no |
| 3 | `L1CreateMarket` | L1 | no |
| 4 | `L1UpdateMarket` | L1 | no |
| 5 | `L1CancelAllOrders` | L1 | no |
| 6 | `L1Withdraw` | L1 | no |
| 7 | `L1CreateOrder` | L1 | no |
| **8** | **`L2ChangePubKey`** | L2 | **yes** |
| **9** | **`L2CreateSubAccount`** | L2 | **yes** |
| **10** | **`L2CreatePublicPool`** | L2 | **yes** |
| **11** | **`L2UpdatePublicPool`** | L2 | **yes** |
| **12** | **`L2Transfer`** | L2 | **yes** |
| **13** | **`L2Withdraw`** | L2 | **yes** |
| **14** | **`L2CreateOrder`** | L2 | **yes** |
| **15** | **`L2CancelOrder`** | L2 | **yes** |
| **16** | **`L2CancelAllOrders`** | L2 | **yes** |
| **17** | **`L2ModifyOrder`** | L2 | **yes** |
| **18** | **`L2MintShares`** | L2 | **yes** |
| **19** | **`L2BurnShares`** | L2 | **yes** |
| **20** | **`L2UpdateLeverage`** | L2 | **yes** |
| 21 | `InternalClaimOrder` | internal | no |
| 22 | `InternalCancelOrder` | internal | no |
| 23 | `InternalDeleverage` | internal | no |
| 24 | `InternalExitPosition` | internal | no |
| 25 | `InternalCancelAllOrders` | internal | no |
| 26 | `InternalLiquidatePosition` | internal | no |
| 27 | `InternalCreateOrder` | internal | no |
| **28** | **`L2CreateGroupedOrders`** | L2 | **yes** |
| **29** | **`L2UpdateMargin`** | L2 | **yes** |
| 30 | `L1BurnShares` | L1 | no |
| 31 | `L1RegisterAsset` | L1 | no |
| 32 | `L1UpdateAsset` | L1 | no |
| 33 | `L2CreateStakingPool` | L2 | no (no struct exists) |
| 34 | *(reserved — `L2UpdateStakingPool`, commented out upstream)* | — | no |
| **35** | **`L2StakeAssets`** | L2 | **yes** |
| **36** | **`L2UnstakeAssets`** | L2 | **yes** |
| 37 | `L1UnstakeAssets` | L1 | no |
| 38 | `L1SetSystemConfig` | L1 | no |
| 39 | *(unassigned)* | — | — |
| 40 | `L2ForceBurnShares` | L2 | no |
| **41** | **`L2UpdateAccountConfig`** | L2 | **yes** |
| **42** | **`L2UpdateAccountAssetConfig`** | L2 | **yes** |
| 43 | `L2StrategyTransfer` | L2 | no |
| 44 | `L2UpdateMarketConfig` | L2 | no |
| **45** | **`L2ApproveIntegrator`** | L2 | **yes** |

**20 constructible types.** Codes 33, 40, 43, 44 must still exist in the TS enum (they appear in
`tx_type` fields of REST/WS responses) but have no builder.

The tx-type code is absorbed as the **second** field element of every L2 hash, immediately after the
chain id.

---

## 4. Chain ids

`lighterChainId` is a `uint32` absorbed as the **first** element of every tx hash.

| Environment | id |
|---|---:|
| mainnet (`mainnet.zklighter…`) | **304** |
| testnet (`testnet.zklighter…`, `api.rh-testnet.lighter…`) | **300** |
| `api.rh.lighter…` | **466324** |
| fallback used by the Python SDK | 304 |

**TS design:** do not host-sniff. Chain id is a required, explicit constructor argument with named
presets (`CHAIN_ID.mainnet`, `CHAIN_ID.testnet`). Host-sniffing is a silent-wrong-signature hazard.

---

## 5. Shared field vocabulary

Every constructible L2 tx carries these, with identical semantics:

| Field | Type | JSON key | In hash? | Meaning |
|---|---|---|---|---|
| account index | `int64` | `AccountIndex` (or `FromAccountIndex` on Transfer/Withdraw) | yes, position 5 | signing account. Range `[-1, 2^48−2]`. |
| api key index | `uint8` | `ApiKeyIndex` | yes, position 6 | which of the account's API keys signs. `[0, 254]`; `255` = `NilApiKeyIndex`, accepted **only** by `L2CancelAllOrders`. |
| `Nonce` | `int64` | `Nonce` | yes, position 3 | per-(account, apiKey) sequence number. `>= 0`. |
| `ExpiredAt` | `int64` | `ExpiredAt` | yes, position 4 | tx deadline, **Unix milliseconds**. `[0, 2^48−1]`. |
| `Sig` | 80 bytes | `Sig` | **no** | Schnorr signature `S(40 LE) ‖ E(40 LE)`. JSON: **base64**. |
| `SignedHash` | string | *(omitted, `json:"-"`)* | no | lowercase hex of the 40-byte message hash, **no `0x`**. Returned out-of-band. |
| `L1Sig` | string | `L1Sig` | **no** | 0x-prefixed 65-byte EIP-191 signature. Only on `L2ChangePubKey`, `L2Transfer`, `L2ApproveIntegrator`. |
| attributes | map | `L2TxAttributes` | via aggregation (§6) | see §6. |

**Universal hash prefix.** Every L2 tx hash begins with exactly these four elements, in this order:

```
[0] chainId          (uint32)
[1] txType           (uint8 code from §3)
[2] Nonce            (int64)
[3] ExpiredAt        (int64)
```

followed by `[4] accountIndex`, `[5] apiKeyIndex`, then type-specific elements.

**Default `ExpiredAt`** in the reference: `now + 10 minutes − 1 second`, in milliseconds.
**TS design:** expose `expiredAt` as required-with-default and document the unit as ms.

---

## 6. `L2TxAttributes` — the optional side-channel

An optional, sparse map `attributeType(uint8) -> value(int)`. It exists so new per-tx knobs can be
added without a new tx type. `NbAttributesPerTx = 4` — **at most 4 entries**.

### 6.1 Attribute registry

| Type | Name | ByteSize¹ | Min | Max | Nil value | Range error |
|---:|---|---:|---:|---:|---:|---|
| 1 | `IntegratorAccountIndex` | 6 | 0 | 281474976710654 | 0 | `ErrIntegratorAccountIndexInvalidRange` |
| 2 | `IntegratorTakerFee` | 4 | 0 | 1000000 (`FeeTick`) | 0 | `ErrIntegratorFeeInvalidRange` |
| 3 | `IntegratorMakerFee` | 4 | 0 | 1000000 | 0 | `ErrIntegratorFeeInvalidRange` |
| 4 | `SkipTxNonce` | 1 | 1 | 1 | 0 | `ErrNonceSkipAttributeInvalid` |
| 5 | `CancelAllMarketIndex` | 2 | 0 | 255 | 255 | `ErrCancelAllMarketIndexInvalidRange` |
| 6 | `SelfTradeBehaviorMode` | 1 | 0 | 3 | 0 | `ErrSelfTradeBehaviorModeInvalidRange` |
| 7 | `SelfTradeEqualityMode` | 1 | 0 | 1 | 0 | `ErrSelfTradeEqualityModeInvalidRange` |

`MaxAttributeType = 7`. Type `0` is reserved as the padding sentinel.

¹ `ByteSize` is the sequencer's packed-encoding width. It is **never used by the SDK** — do not port
it. (Keeping it would be cargo-culting.)

Semantics:
- **1/2/3 — integrator fees.** A referrer account index plus the taker/maker fee (in millionths,
  `FeeTick = 1e6` = 100%) that the integrator collects.
- **4 — SkipTxNonce.** `1` means "do not consume/validate the account nonce for this tx" (fire-and-forget
  ordering). Only the value `1` is legal; absence/`0` means normal nonce handling.
- **5 — CancelAllMarketIndex.** Scopes a `L2CancelAllOrders` to a single perps market. `255` = all markets.
- **6/7 — self-trade policy.** Behaviour mode and the equality predicate used to detect self-trades.

### 6.2 Attribute validation (runs FIRST in every tx's `Validate`)

1. If the map is absent/empty → OK, return.
2. If `size > 4` → `ErrTooManyAttributes` ("Too many attributes, should not be larger than 4").
3. For each `(type, value)`:
   - unknown `type` → `ErrInvalidAttributeType` wrapped with the offending type
     (message: `"Attribute type is invalid: <type>"`).
   - `value < Min || value > Max` → the registry's range error for that type.
4. Compute `isNil[t] = (present ? value : NilValue) === NilValue` for `t in 1..7`.
5. `hasFees = !isNil[2] || !isNil[3]`; `hasIntegratorIndex = !isNil[1]`.
   If `hasFees && !hasIntegratorIndex` → `ErrIntegratorAccountIndexRequiredForNonZeroFees`.
6. `hasSelfTradeSpec = !isNil[6] || !isNil[7]`.
   If `hasSelfTradeSpec && hasFees` → `ErrSelfTradeSpecificationNotAllowedWithNonZeroFees`.
7. If `raw[7] === 1` (MasterAccountIndex equality) **and** `raw[6] === 3` (Reduce behaviour)
   → `ErrReduceModeNotAllowedWithMasterAccountIndexEqualityMode`.
   (Raw map lookup: a missing key reads as `0`, so this only fires when both are explicitly set.)

### 6.3 Emptiness

`isEmpty()` ⇔ **every present entry equals its Nil value**. An absent map is empty. A map like
`{6: 0}` is *empty* for hashing purposes but is still emitted in JSON — the sequencer performs the
same normalisation, so this is safe, but the TS implementation must reproduce both behaviours.

### 6.4 Normalised type vector

```
slots = [0, 0, 0, 0]                      // length NbAttributesPerTx = 4
i = 0
for each (type, value) in map:
    if value === NilValue(type): continue
    slots[i++] = type
sort ascending only slots[0..i)           // trailing zeros stay at the end
```

### 6.5 Attribute hash

Absorb exactly **8** elements — for each of the 4 slots, the type then the value
(`value = 0` when `type === 0`):

```
[ t0, v0, t1, v1, t2, v2, t3, v3 ]  ->  hashToQuinticExtension  ->  gFp5 (5 limbs)
```

Exactly one sponge block. `vk = map[tk]` (guaranteed non-nil by §6.4).

### 6.6 `AggregateTxHash` — the trailing step of EVERY tx hash

```
aggregate(txHash: gFp5) -> Uint8Array(40):
    if attributes.isEmpty():
        return txHash.toLittleEndianBytes()               // 40 bytes
    attrHash = attributesHash()                            // §6.5
    combined = [ txHash[0..5), attrHash[0..5) ]            // 10 elements
    return hashToQuinticExtension(combined).toLittleEndianBytes()
```

`combined` is 10 elements ⇒ two sponge blocks (8 + 2), exercising the no-padding partial-block rule
from §2. **This step is mandatory and is the last thing every `hash()` does.**

### 6.7 Constructing the map from user options

The public option object is a struct of optionals; it becomes a map only if at least one is set,
otherwise it is **absent** (JSON `null`):

| option | attribute type | reference includes it when |
|---|---:|---|
| `integratorAccountIndex` | 1 | `!= 0` (FFI layer) / always if provided (Go API) |
| `integratorTakerFee` | 2 | `!= 0` (FFI) |
| `integratorMakerFee` | 3 | `!= 0` (FFI) |
| `skipNonce` | 4 | `=== 1` |
| `cancelAllMarketIndex` | 5 | `!= 255` |
| `selfTradeBehaviorMode` | 6 | `!= 0` |
| `selfTradeEqualityMode` | 7 | `!= 0` |

**[DEFECT]** The Go public API and the FFI shim disagree: the FFI drops nil-valued options, the Go
API keeps them (emitting e.g. `{"2":0}` into JSON while the hash ignores it). **TS design:** always
drop entries whose value equals the registry Nil value at construction time. This makes JSON and
hash agree, is a strict subset of accepted behaviour, and removes a class of "why did my JSON change"
bugs.

---

## 7. Transaction catalogue

Notation for the **Hash** column: an ordered list; `chainId` and `txType` are literal elements,
everything else is a field name. `lo32/hi32` per §1.3. `gFp5(PubKey)` expands to 5 elements.

Notation for **JSON**: keys in Go declaration order (order is informational — JSON objects are
unordered — but reproducing it makes golden-file diffs trivial).

Every type's `Validate()` starts with attribute validation (§6.2) and ends with:
```
Nonce < 0                          -> ErrNonceTooLow
ExpiredAt < 0 || > 281474976710655 -> ErrExpiredAtInvalid
```

---

### 7.1 `L2ChangePubKey` — code 8

Registers/rotates the ECgFp5 public key for `(AccountIndex, ApiKeyIndex)`. Requires an L1 signature
from the account's Ethereum owner (§10.1).

| Field | Type | Range / sentinel | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^48−2]` | account |
| `ApiKeyIndex` | uint8 | `[0, 254]` | slot to (re)key |
| `PubKey` | 40 bytes | exactly 40 | new gFp5 public key, little-endian limbs |
| `L1Sig` | string | 0x + 130 hex | EIP-191 signature over §10.1 template |
| `ExpiredAt`, `Nonce`, `Sig` | | | §5 |

**Hash (11 elements):**
`chainId, 8, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, gFp5(PubKey)[0..5)` → `aggregate`

**JSON keys (order):** `AccountIndex, ApiKeyIndex, PubKey, L1Sig, ExpiredAt, Nonce, Sig, L2TxAttributes`
- `PubKey` → **base64** of the 40 bytes (56 chars, `==` padded).

**Validate:**
| condition | error |
|---|---|
| `AccountIndex < -1` | `ErrFromAccountIndexTooLow` |
| `AccountIndex > 281474976710654` | `ErrFromAccountIndexTooHigh` |
| `ApiKeyIndex < 0` | `ErrApiKeyIndexTooLow` |
| `ApiKeyIndex > 254` | `ErrApiKeyIndexTooHigh` |
| `Nonce < 0` | `ErrNonceTooLow` |
| `ExpiredAt` out of `[0, 2^48−1]` | `ErrExpiredAtInvalid` |
| `PubKey.length !== 40` | `ErrPubKeyInvalid` |

Note: this type uses the *From*-flavoured account errors despite the field being named `AccountIndex`.
Reproduce exactly.

**Extra client-side check (reference):** after signing, the Go client re-verifies its own Schnorr
signature against its own public key and fails the call on mismatch. **TS design:** keep this as an
opt-in `verifyAfterSign` flag (default on for ChangePubKey only — it is the one tx where a bad
signature bricks the key slot).

---

### 7.2 `L2CreateSubAccount` — code 9

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 140737488355327]` (**master** range) | master account creating the sub-account |
| `ApiKeyIndex` | uint8 | `[0, 254]` | |

**Hash (6):** `chainId, 9, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** `< -1` → `ErrFromAccountIndexTooLow`; `> MaxMasterAccountIndex` → `ErrFromAccountIndexTooHigh`;
api key bounds; nonce; expiredAt.

---

### 7.3 `L2CreatePublicPool` — code 10

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^47−1]` (master) | pool operator |
| `ApiKeyIndex` | uint8 | `[0, 254]` | |
| `OperatorFee` | int64 | `[0, 1000000]` | operator cut, millionths |
| `InitialTotalShares` | int64 | `> 0`, `<= 1000000000000` | initial share supply |
| `MinOperatorShareRate` | uint16 | `<= 10000` (`ShareTick`) | min fraction of shares the operator must hold, basis points |

**Hash (9):** `chainId, 10, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, OperatorFee, InitialTotalShares, MinOperatorShareRate` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, OperatorFee, InitialTotalShares, MinOperatorShareRate, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:**
| condition | error |
|---|---|
| account `< -1` / `> MaxMasterAccountIndex` | `ErrFromAccountIndexTooLow` / `TooHigh` |
| api key out of `[0,254]` | `ErrApiKeyIndexTooLow` / `TooHigh` |
| `OperatorFee < 0 \|\| > 1000000` | `ErrInvalidPoolOperatorFee` |
| `InitialTotalShares <= 0` | `ErrPoolInitialTotalSharesTooLow` |
| `InitialTotalShares > 1000000000000` | `ErrPoolInitialTotalSharesTooHigh` |
| `MinOperatorShareRate > 10000` | `ErrPoolMinOperatorShareRateTooHigh` |

**[DEFECT]** The low bound is `<= 0`, **not** `< MinInitialTotalShares (1_000_000)`, even though the
error message says "should be larger than 1000000". The sequencer may still reject. Reproduce the
*check* exactly (client-side laxness is safe); consider emitting a warning.

---

### 7.4 `L2UpdatePublicPool` — code 11

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^48−2]` | operator |
| `PublicPoolIndex` | int64 | `[-1, 2^48−2]` | the pool account |
| `Status` | uint8 | `{0, 1}` | 0 = closed/paused, 1 = open |
| `OperatorFee` | int64 | `[0, 1000000]` | |
| `MinOperatorShareRate` | uint16 | `<= 10000` | |

**Hash (10):** `chainId, 11, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, PublicPoolIndex, Status, OperatorFee, MinOperatorShareRate` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, PublicPoolIndex, Status, OperatorFee, MinOperatorShareRate, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account bounds (`ErrFromAccountIndex*`); api key; pool index bounds →
`ErrPublicPoolIndexTooLow`/`TooHigh`; `Status ∉ {0,1}` → `ErrInvalidPoolStatus`;
fee → `ErrInvalidPoolOperatorFee`; share rate → `ErrPoolMinOperatorShareRateTooHigh`; nonce; expiredAt.

---

### 7.5 `L2Transfer` — code 12

Moves an asset between accounts and/or between the perps and spot routes. Requires an L1 signature
when the destination is not under the same master account (§10.2).

| Field | Type | Range | Meaning |
|---|---|---|---|
| `FromAccountIndex` | int64 | `[-1, 2^48−2]` | source |
| `ApiKeyIndex` | uint8 | `[0, 254]` | |
| `ToAccountIndex` | int64 | `[-1, 2^48−2]` | destination |
| `AssetIndex` | int16 | `[1, 62]` | asset id |
| `FromRouteType` | uint8 | `{0 perps, 1 spot}` | source route |
| `ToRouteType` | uint8 | `{0 perps, 1 spot}` | destination route |
| `Amount` | int64 | `[1, 2^60−1]` | in the asset's smallest unit |
| `USDCFee` | int64 | `[0, 2^60−1]` | transfer fee, USDC micro-units |
| `Memo` | 32 bytes | exact | free-form; **not hashed**, only L1-signed |

**Hash (14):**
`chainId, 12, Nonce, ExpiredAt, FromAccountIndex, ApiKeyIndex, ToAccountIndex, AssetIndex, FromRouteType, ToRouteType, lo32(Amount), hi32(Amount), lo32(USDCFee), hi32(USDCFee)` → `aggregate`

**`Memo` is deliberately absent from the L2 hash.** It is bound only by the L1 signature.

**JSON:** `FromAccountIndex, ApiKeyIndex, ToAccountIndex, AssetIndex, FromRouteType, ToRouteType, Amount, USDCFee, Memo, ExpiredAt, Nonce, Sig, L1Sig, L2TxAttributes`
- `Memo` is a Go `[32]byte` **array**, which Go's `encoding/json` renders as a **JSON array of 32
  numbers** — `"Memo":[0,0,…,0]` — *not* base64, *not* hex. This is the single most surprising
  encoding in the protocol. See §9.2.

**Validate:**
| condition | error |
|---|---|
| `FromAccountIndex` `< -1` / `> max` | `ErrFromAccountIndexTooLow` / `TooHigh` |
| api key bounds | `ErrApiKeyIndexTooLow` / `TooHigh` |
| `ToAccountIndex` `< -1` / `> max` | `ErrToAccountIndexTooLow` / `TooHigh` |
| `AssetIndex < 1` | `ErrAssetIndexTooLow` |
| `AssetIndex > 62` | `ErrAssetIndexTooHigh` |
| `FromRouteType ∉ {0,1}` | `ErrRouteTypeInvalid` |
| `ToRouteType ∉ {0,1}` | `ErrRouteTypeInvalid` |
| `Amount <= 0` | `ErrTransferAmountTooLow` |
| `Amount > 2^60−1` | `ErrTransferAmountTooHigh` |
| `USDCFee < 0` | `ErrTransferFeeNegative` |
| `USDCFee > 2^60−1` | `ErrTransferFeeTooHigh` |
| nonce / expiredAt | as §7 |

**Memo input formats accepted by the reference FFI:** a 66-char `0x`-prefixed hex string, a 64-char
bare hex string, or a 32-character ASCII string (bytes taken verbatim). Anything else errors.
**TS design:** accept `Uint8Array(32)` or a `0x`-prefixed 64-hex string only; provide
`memoFromUtf8(s)` that pads/validates ≤32 bytes. The "exactly 32 ASCII chars" path is a trap.

**[DEFECT]** The Python SDK does `int(amount * ASSET_TO_TICKER_SCALE[asset_id])` with float maths,
silently losing precision for large amounts. **TS design:** amounts are `bigint` in base units at the
API boundary; provide a separate, explicitly-decimal helper (`parseUnits(str, decimals): bigint`)
that never goes through IEEE-754.

---

### 7.6 `L2Withdraw` — code 13

| Field | Type | Range | Meaning |
|---|---|---|---|
| `FromAccountIndex` | int64 | `[-1, 2^48−2]` | |
| `ApiKeyIndex` | uint8 | `[0, 254]` | |
| `AssetIndex` | int16 | `[1, 62]` | |
| `RouteType` | uint8 | `{0, 1}` | |
| `Amount` | **uint64** | `[1, 2^60−1]` | smallest units |

**Hash (10):** `chainId, 13, Nonce, ExpiredAt, FromAccountIndex, ApiKeyIndex, AssetIndex, RouteType, lo32(Amount), hi32(Amount)` → `aggregate`

**JSON:** `FromAccountIndex, ApiKeyIndex, AssetIndex, RouteType, Amount, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account/apikey bounds; `AssetIndex` bounds; `RouteType ∉ {0,1}` → `ErrRouteTypeInvalid`;
`Amount === 0` → `ErrWithdrawalAmountTooLow`; `Amount > 2^60−1` → `ErrWithdrawalAmountTooHigh`; nonce; expiredAt.

---

### 7.7 `OrderInfo` — the shared order payload

Used inline by `L2CreateOrder` and as array elements by `L2CreateGroupedOrders`.

| Field | Type | Range / sentinel | Meaning |
|---|---|---|---|
| `MarketIndex` | int16 | perps `[0, 254]` **or** spot `[2048, 4094]`; `255` = Nil | market |
| `ClientOrderIndex` | int64 | `0` (nil) or `[1, 2^48−1]` | caller-chosen id |
| `BaseAmount` | int64 | `0` (nil) or `[1, 2^48−1]` | size in base units |
| `Price` | uint32 | `[1, 2^32−1]`; `0` = Nil (rejected) | limit price in price ticks |
| `IsAsk` | uint8 | `{0 bid/buy, 1 ask/sell}` | side |
| `Type` | uint8 | `[0, 6]` for API orders | see §8.1 |
| `TimeInForce` | uint8 | `{0 IOC, 1 GTT, 2 PostOnly}` | |
| `ReduceOnly` | uint8 | `{0, 1}`; must be `0` on spot markets | |
| `TriggerPrice` | uint32 | `0` (nil) or `[1, 2^32−1]` | trigger for SL/TP |
| `OrderExpiry` | int64 | `0` (nil) or `[1, 2^63−1]` | Unix ms |

JSON keys, in order: `MarketIndex, ClientOrderIndex, BaseAmount, Price, IsAsk, Type, TimeInForce, ReduceOnly, TriggerPrice, OrderExpiry`.

**`OrderExpiry = -1` sentinel:** the FFI/WASM shims translate `-1` into `now + 28 days` (ms) before
validation. This is a *shim* convention, not protocol.
**TS design:** expose `orderExpiry: bigint | 'ioc' | { days: number }` or simply require an absolute
ms timestamp, and provide `expiryIn({days:28})`. Do not smuggle `-1`.

---

### 7.8 `L2CreateOrder` — code 14

Fields: `AccountIndex`, `ApiKeyIndex`, all of `OrderInfo` (flattened), `ExpiredAt`, `Nonce`, `Sig`, attributes.

**Hash (16):**
`chainId, 14, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, ClientOrderIndex, BaseAmount, Price, IsAsk, Type, TimeInForce, ReduceOnly, TriggerPrice, OrderExpiry` → `aggregate`

(16 elements ⇒ exactly two full sponge blocks.)

**JSON:** `AccountIndex, ApiKeyIndex, MarketIndex, ClientOrderIndex, BaseAmount, Price, IsAsk, Type, TimeInForce, ReduceOnly, TriggerPrice, OrderExpiry, ExpiredAt, Nonce, Sig, L2TxAttributes`
— the `OrderInfo` fields are **flattened** into the parent object (Go embedded-struct promotion).

**Validate — exact order and errors:**

```
0.  attributes                                                       -> §6.2 errors
1.  AccountIndex < -1                                                -> ErrAccountIndexTooLow
2.  AccountIndex > 281474976710654                                   -> ErrAccountIndexTooHigh
3.  ApiKeyIndex < 0                                                  -> ErrApiKeyIndexTooLow
4.  ApiKeyIndex > 254                                                -> ErrApiKeyIndexTooHigh
5.  isSpot  = 2048 <= MarketIndex <= 4094
    isPerps = 0    <= MarketIndex <= 254
    !isSpot && !isPerps                                              -> ErrInvalidMarketIndex
6.  ClientOrderIndex != 0 && < 1                                     -> ErrClientOrderIndexTooLow
7.  ClientOrderIndex != 0 && > 281474976710655                       -> ErrClientOrderIndexTooHigh
8.  ReduceOnly != 1 && BaseAmount == 0                               -> ErrBaseAmountTooLow
9.  BaseAmount != 0 && BaseAmount < 1                                -> ErrBaseAmountTooLow
10. BaseAmount > 281474976710655                                     -> ErrBaseAmountTooHigh
11. Price < 1                                                        -> ErrPriceTooLow
12. Price > 4294967295                                               -> ErrPriceTooHigh
13. IsAsk ∉ {0,1}                                                    -> ErrIsAskInvalid
14. TimeInForce ∉ {0,1,2}                                            -> ErrOrderTimeInForceInvalid
15. ReduceOnly ∉ {0,1}  ||  (isSpot && ReduceOnly == 1)              -> ErrOrderReduceOnlyInvalid
16. OrderExpiry != 0 && (OrderExpiry < 1 || > 9223372036854775807)   -> ErrOrderExpiryInvalid
17. per-Type matrix (below)
18. TriggerPrice != 0 && (TriggerPrice < 1 || > 4294967295)          -> ErrOrderTriggerPriceInvalid
19. Nonce < 0                                                        -> ErrNonceTooLow
20. ExpiredAt < 0 || > 281474976710655                               -> ErrExpiredAtInvalid
```

**Order-type matrix (step 17).** Evaluated as a switch on `Type`; first failing clause wins.

| `Type` | required | forbidden | error on violation |
|---|---|---|---|
| 1 `Market` | `TimeInForce == 0 (IOC)` | `OrderExpiry != 0`; `TriggerPrice != 0` | `ErrOrderTimeInForceInvalid` / `ErrOrderExpiryInvalid` / `ErrOrderTriggerPriceInvalid` |
| 0 `Limit` | if `TIF == IOC` then `OrderExpiry == 0`; if `TIF != IOC` then `OrderExpiry != 0` | `TriggerPrice != 0` | `ErrOrderTriggerPriceInvalid` / `ErrOrderExpiryInvalid` |
| 2 `StopLoss`, 4 `TakeProfit` | `isPerps`; `TIF == IOC`; `TriggerPrice != 0`; `OrderExpiry != 0` | — | `ErrOrderTypeInvalid` / `ErrOrderTimeInForceInvalid` / `ErrOrderTriggerPriceInvalid` / `ErrOrderExpiryInvalid` |
| 3 `StopLossLimit`, 5 `TakeProfitLimit` | `isPerps`; `TriggerPrice != 0`; `OrderExpiry != 0` | — | same set (no TIF constraint) |
| 6 `TWAP` | `TIF == GoodTillTime (1)`; `OrderExpiry != 0` | `TriggerPrice != 0` | `ErrOrderTimeInForceInvalid` / `ErrOrderTriggerPriceInvalid` / `ErrOrderExpiryInvalid` |
| 7, 8, ≥9 | — | always | `ErrOrderTypeInvalid` (internal-only types are rejected) |

---

### 7.9 `L2CancelOrder` — code 15

| Field | Type | Range | Meaning |
|---|---|---|---|
| `MarketIndex` | int16 | perps `[0,254]` or spot `[2048,4094]` | |
| `Index` | int64 | `[1, 2^60−1]` | **either** a ClientOrderIndex (`[1, 2^48−1]`) **or** an OrderIndex (`[2^48, 2^60−1]`) — disambiguated by magnitude |

**Hash (8):** `chainId, 15, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, Index` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, MarketIndex, Index, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account/apikey; market index (`ErrInvalidMarketIndex`);
`Index < 1` → `ErrOrderIndexTooLow`; `Index > 1152921504606846975` → `ErrOrderIndexTooHigh`;
nonce; expiredAt.

(The reference writes the bound as `Index < MinClientOrderIndex && Index < MinOrderIndex`, which
collapses to `Index < 1`; and `Index > MaxClientOrderIndex && Index > MaxOrderIndex`, which collapses
to `Index > 2^60−1`. Implement the collapsed form.)

---

### 7.10 `L2CancelAllOrders` — code 16

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^48−2]` | |
| `ApiKeyIndex` | uint8 | `[0, 254]` **or `255`** | `255` = cancel across all API keys |
| `TimeInForce` | uint8 | `{0 Immediate, 1 Scheduled, 2 AbortScheduled}` | |
| `Time` | int64 | see below | scheduled deadline, Unix ms |

**Hash (8):** `chainId, 16, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, TimeInForce, Time` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, TimeInForce, Time, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate (order matters — the attribute cross-check runs before the TIF switch):**
```
account bounds                                          -> ErrAccountIndexTooLow / TooHigh
ApiKeyIndex < 0                                         -> ErrApiKeyIndexTooLow
ApiKeyIndex > 254 && ApiKeyIndex != 255                 -> ErrApiKeyIndexTooHigh
Nonce < 0                                               -> ErrNonceTooLow
ExpiredAt out of [0, 2^48-1]                            -> ErrExpiredAtInvalid
attr[5] present && TimeInForce != 0 && attr[5] != 255   -> ErrCancelAllMarketIndexCantBeScheduled
switch TimeInForce:
  0 Immediate : Time != 0                               -> ErrCancelAllTimeisNotNill
  1 Scheduled : Time < 1 || Time > 9223372036854775807  -> ErrCancelAllTimeIsNotInRange
  2 Abort     : Time != 0                               -> ErrCancelAllTimeisNotNill
  default     :                                         -> ErrInvalidCancelAllTimeInForce
```

Per-market cancel-all is expressed via attribute type 5 (§6.1), **not** a struct field.
`MinOrderCancelAllPeriod = 300000 ms` / `MaxOrderCancelAllPeriod = 1296000000 ms` are advisory
sequencer-side bounds; the SDK does not enforce them.

---

### 7.11 `L2ModifyOrder` — code 17

| Field | Type | Range | Meaning |
|---|---|---|---|
| `MarketIndex` | int16 | perps or spot | |
| `Index` | int64 | `[1, 2^60−1]` | client-order-index or order-index |
| `BaseAmount` | int64 | `0` (nil, = leave unchanged) or `[1, 2^48−1]` | new size |
| `Price` | uint32 | `[1, 2^32−1]` | new price |
| `TriggerPrice` | uint32 | `0` or `[1, 2^32−1]` | new trigger |

**Hash (11):** `chainId, 17, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, Index, BaseAmount, Price, TriggerPrice` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, MarketIndex, Index, BaseAmount, Price, TriggerPrice, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account/apikey; market index; `Index < 1` → **`ErrClientOrderIndexTooLow`**,
`Index > 2^60−1` → **`ErrClientOrderIndexTooHigh`** (note: different error identity than
`L2CancelOrder` for the identical predicate — reproduce it);
`BaseAmount != 0 && < 1` → `ErrBaseAmountTooLow`; `BaseAmount > 2^48−1` → `ErrBaseAmountTooHigh`;
`Price < 1` → `ErrPriceTooLow`; `Price > 2^32−1` → `ErrPriceTooHigh`;
trigger price → `ErrOrderTriggerPriceInvalid`; nonce; expiredAt.

---

### 7.12 `L2CreateGroupedOrders` — code 28

See §8 for full grouping semantics.

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^48−2]` | |
| `ApiKeyIndex` | uint8 | `[0, 254]` | |
| `GroupingType` | uint8 | `{1 OTO, 2 OCO, 3 OTOCO}` | `0` is rejected |
| `Orders` | `OrderInfo[]` | length `[1, 3]` structurally, `{2,3}` after grouping validation | |

**Hash (11):**
```
chainId, 28, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, GroupingType,
aggregatedOrderHash[0], aggregatedOrderHash[1], aggregatedOrderHash[2], aggregatedOrderHash[3]
   -> aggregate
```

`aggregatedOrderHash` is a 4-element `HashOut` built as:

```
leaf(o) = hashNoPad([ o.MarketIndex, o.ClientOrderIndex, o.BaseAmount, o.Price, o.IsAsk,
                      o.Type, o.TimeInForce, o.ReduceOnly, o.TriggerPrice, o.OrderExpiry ])
          // 10 elements -> 2 sponge blocks (8 + 2, no padding, rate lanes 2..7 carry over)

acc = leaf(orders[0])
for i in 1..n-1:  acc = hashTwoToOne(acc, leaf(orders[i]))   // left fold
aggregatedOrderHash = acc
```

The leaf element order is **identical** to the order-specific tail of `L2CreateOrder`'s hash.

**JSON:** `AccountIndex, ApiKeyIndex, GroupingType, Orders, ExpiredAt, Nonce, Sig, L2TxAttributes`,
where `Orders` is an array of `OrderInfo` objects (§7.7).

---

### 7.13 `L2UpdateMargin` — code 29

Adds/removes isolated margin for a perps position.

| Field | Type | Range | Meaning |
|---|---|---|---|
| `MarketIndex` | int16 | `[0, 254]` (**perps only**) | |
| `USDCAmount` | int64 | `!= 0`, `<= 2^60−1` | USDC micro-units |
| `Direction` | uint8 | `{0 Remove, 1 Add}` | |

**Hash (10):** `chainId, 29, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, lo32(USDCAmount), hi32Arithmetic(USDCAmount), Direction` → `aggregate`

**Note the element order:** `Direction` comes **after** the amount limbs.

**JSON:** `AccountIndex, ApiKeyIndex, MarketIndex, USDCAmount, Direction, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; `MarketIndex < 0 || > 254` →
`ErrInvalidMarketIndex`; `USDCAmount === 0` → `ErrTransferAmountTooLow`;
`USDCAmount > 2^60−1` → `ErrTransferAmountTooHigh`; `Direction ∉ {0,1}` →
`ErrInvalidUpdateMarginDirection`; nonce; expiredAt.

**[DEFECT]** Negative `USDCAmount` passes validation and takes the arithmetic-shift path (§1.3).
**TS design:** reject `USDCAmount <= 0` with a distinct `LighterValidationError` (code
`TRANSFER_AMOUNT_TOO_LOW`), but keep the arithmetic-shift implementation so an escape hatch
(`allowNegativeMargin: true`) still produces byte-identical hashes.

---

### 7.14 `L2MintShares` — code 18 / `L2BurnShares` — code 19

Structurally identical; only the tx-type code and two error identities differ.

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountIndex` | int64 | `[-1, 2^48−2]` | investor |
| `PublicPoolIndex` | int64 | `[140737488355328, 281474976710654]` (**sub-account range**) | pool |
| `ShareAmount` | int64 | `[1, 2^60−1]` | shares to mint / burn |

**Hash (8):** `chainId, {18|19}, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, PublicPoolIndex, ShareAmount` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, PublicPoolIndex, ShareAmount, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; pool index (`ErrPublicPoolIndexTooLow` /
`TooHigh`); amount:
- mint → `ErrPoolMintShareAmountTooLow` / `ErrPoolMintShareAmountTooHigh`
- burn → `ErrPoolBurnShareAmountTooLow` / `ErrPoolBurnShareAmountTooHigh`

then nonce, expiredAt.

---

### 7.15 `L2StakeAssets` — code 35 / `L2UnstakeAssets` — code 36

| Field | Type | Range | Meaning |
|---|---|---|---|
| `StakingPoolIndex` | int64 | `[2^47, 2^48−2]` | staking pool account |
| `ShareAmount` | int64 | `[1, 2^60−1]` | |

**Hash (8):** `chainId, {35|36}, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, StakingPoolIndex, ShareAmount` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, StakingPoolIndex, ShareAmount, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; then:
- stake → pool index errors `ErrStakingPoolIndexTooLow` / `ErrStakingPoolIndexTooHigh`;
  amount errors `ErrPoolStakeAssetsAmountTooLow` / `TooHigh`
- unstake → pool index errors **`ErrPublicPoolIndexTooLow` / `TooHigh`** (copy-paste in the
  reference — reproduce); amount errors `ErrPoolUnstakeAssetsAmountTooLow` / `TooHigh`

then nonce, expiredAt.

---

### 7.16 `L2UpdateLeverage` — code 20

| Field | Type | Range | Meaning |
|---|---|---|---|
| `MarketIndex` | int16 | anything **except 255** | market |
| `InitialMarginFraction` | uint16 | `[1, 10000]` | IMF in basis points; leverage = 10000 / IMF |
| `MarginMode` | uint8 | `{0 Cross, 1 Isolated}` | |

**Hash (9):** `chainId, 20, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, InitialMarginFraction, MarginMode` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, MarketIndex, InitialMarginFraction, MarginMode, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; `MarketIndex === 255` →
`ErrInvalidMarketIndex`; `MarginMode ∉ {0,1}` → `ErrInvalidMarginMode`;
`InitialMarginFraction <= 0` → `ErrInitialMarginFractionTooLow`;
`InitialMarginFraction > 10000` → `ErrInitialMarginFractionTooHigh`; nonce; expiredAt.

**[DEFECT]** The market-index check is only `!= NilMarketIndex` — negative and out-of-range indices
pass. **TS design:** additionally validate the perps range and surface a distinct warning-level error
behind a strict flag (default: strict on, with `{ lenientMarketIndex: true }` to match the reference
byte-for-byte).

---

### 7.17 `L2UpdateAccountConfig` — code 41

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AccountTradingMode` | uint8 | `{0, 1}` | `1` = Unified Trading Account (UTA) enabled, `0` = standard |

**Hash (7):** `chainId, 41, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, AccountTradingMode` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, AccountTradingMode, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; `AccountTradingMode ∉ {0,1}` →
`ErrInvalidAccountTradingMode`; nonce; expiredAt.

---

### 7.18 `L2UpdateAccountAssetConfig` — code 42

| Field | Type | Range | Meaning |
|---|---|---|---|
| `AssetIndex` | int16 | `[1, 62]` | asset |
| `AssetMarginMode` | uint8 | `{0 MarginDisabled, 1 MarginEnabled}` | use this asset as margin |

**Hash (8):** `chainId, 42, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, AssetIndex, AssetMarginMode` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, AssetIndex, AssetMarginMode, ExpiredAt, Nonce, Sig, L2TxAttributes`

**Validate:** account (`ErrFromAccountIndex*`); apikey; `AssetIndex < 1` → `ErrAssetIndexTooLow`;
`> 62` → `ErrAssetIndexTooHigh`; `AssetMarginMode ∉ {0,1}` → **`ErrInvalidMarginMode`**
(*not* `ErrInvalidAssetMarginMode`, which exists but is unused — reproduce); nonce; expiredAt.

---

### 7.19 `L2ApproveIntegrator` — code 45

Authorises an integrator account to charge fees on this account's trades, up to explicit caps.
Optionally L1-signed (§10.3) — required when approving an integrator outside the same master account.

| Field | Type | Range | Meaning |
|---|---|---|---|
| `IntegratorAccountIndex` | int64 | `[-1, 2^48−2]` | integrator |
| `MaxPerpsTakerFee` | uint32 | `<= 1000000` | millionths |
| `MaxPerpsMakerFee` | uint32 | `<= 1000000` | |
| `MaxSpotTakerFee` | uint32 | `<= 1000000` | |
| `MaxSpotMakerFee` | uint32 | `<= 1000000` | |
| `ApprovalExpiry` | int64 | `[0, 2^48−1]`; `0` = revocation | Unix ms |

**Hash (12):**
`chainId, 45, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, IntegratorAccountIndex, MaxPerpsTakerFee, MaxPerpsMakerFee, MaxSpotTakerFee, MaxSpotMakerFee, ApprovalExpiry` → `aggregate`

**JSON:** `AccountIndex, ApiKeyIndex, IntegratorAccountIndex, MaxPerpsTakerFee, MaxPerpsMakerFee, MaxSpotTakerFee, MaxSpotMakerFee, ApprovalExpiry, ExpiredAt, Nonce, Sig, L1Sig, L2TxAttributes`

**Validate:**
```
account bounds                                   -> ErrAccountIndexTooLow / TooHigh
apikey bounds                                    -> ErrApiKeyIndexTooLow / TooHigh
IntegratorAccountIndex < -1                      -> ErrIntegratorAccountIndexTooLow
IntegratorAccountIndex > 281474976710654         -> ErrIntegratorAccountIndexTooHigh
any of the four fees > 1000000                   -> ErrFeeTooHigh
ApprovalExpiry == 0 && any fee != 0              -> ErrApprovalExpiryZeroOnRevocation
ApprovalExpiry < 0 || > 281474976710655          -> ErrApprovalExpiryInvalid
Nonce < 0                                        -> ErrNonceTooLow
ExpiredAt out of [0, 2^48-1]                     -> ErrExpiredAtInvalid
```

---

## 8. Grouped orders in depth

### 8.1 Grouping types

| Value | Name | Orders | Shape |
|---:|---|---:|---|
| 0 | *(base sentinel)* | — | **always rejected** (`ErrGroupingTypeInvalid`) |
| 1 | `OneTriggersTheOther` (OTO) | exactly **2** | `[parent, child]` — child activates when parent fills |
| 2 | `OneCancelsTheOther` (OCO) | exactly **2** | `[sibling, sibling]` — one filling cancels the other |
| 3 | `OneTriggersAOneCancelsTheOther` (OTOCO) | exactly **3** | `[parent, sibling, sibling]` |

`MaxGroupedOrderCount = 3`.

### 8.2 Common (pre-grouping) validation

```
attributes                                          -> §6.2
AccountIndex bounds                                 -> ErrAccountIndexTooLow / TooHigh
ApiKeyIndex bounds                                  -> ErrApiKeyIndexTooLow / TooHigh
Orders.length == 0 || > 3                           -> ErrOrderGroupSizeInvalid
Orders[0].MarketIndex outside perps [0,254]         -> ErrInvalidMarketIndex   (perps only!)
for each order:
    MarketIndex != Orders[0].MarketIndex            -> ErrMarketIndexMismatch
    ClientOrderIndex != 0:
        < 1                                         -> ErrClientOrderIndexTooLow
        > 281474976710655                           -> ErrClientOrderIndexTooHigh
        already seen in this group                  -> ErrClientOrderIndexDuplicate
    ReduceOnly != 1 && BaseAmount == 0              -> ErrBaseAmountTooLow
    BaseAmount != 0 && < 1                          -> ErrBaseAmountTooLow
    BaseAmount > 281474976710655                    -> ErrBaseAmountTooHigh
    Price < 1                                       -> ErrPriceTooLow
    Price > 4294967295                              -> ErrPriceTooHigh
    IsAsk ∉ {0,1}                                   -> ErrIsAskInvalid
    TimeInForce ∉ {0,1,2}                           -> ErrOrderTimeInForceInvalid
    ReduceOnly ∉ {0,1}                              -> ErrOrderReduceOnlyInvalid
    OrderExpiry != 0 && out of [1, 2^63-1]          -> ErrOrderExpiryInvalid
    TriggerPrice != 0 && out of [1, 2^32-1]         -> ErrOrderTriggerPriceInvalid
Nonce < 0                                           -> ErrNonceTooLow
ExpiredAt out of [0, 2^48-1]                        -> ErrExpiredAtInvalid
switch GroupingType -> §8.3 / §8.4 / §8.5, default  -> ErrGroupingTypeInvalid
```

Note: grouped orders are **perps-only** (the market-index gate uses the perps range only), and
`ReduceOnly` on a spot market is impossible by construction.

### 8.3 Parent-order rules (`Orders[0]` for OTO / OTOCO)

Only `Limit (0)` and `Market (1)` may be parents; anything else → `ErrOrderTypeInvalid`.

- `Market`: `TIF must be IOC` (`ErrOrderTimeInForceInvalid`), `OrderExpiry must be 0`
  (`ErrOrderExpiryInvalid`), `TriggerPrice must be 0` (`ErrOrderTriggerPriceInvalid`).
- `Limit`: `TriggerPrice must be 0`; if `TIF == IOC` then `OrderExpiry must be 0`; if `TIF != IOC`
  then `OrderExpiry must be non-zero`.

### 8.4 Child-order rules

Only `StopLoss (2)`, `TakeProfit (4)`, `StopLossLimit (3)`, `TakeProfitLimit (5)` may be children;
anything else → `ErrOrderTypeInvalid`.

- `StopLoss` / `TakeProfit` (market-style triggers): `TIF must be IOC`; `TriggerPrice != 0`;
  `OrderExpiry != 0`.
- `StopLossLimit` / `TakeProfitLimit`: `TriggerPrice != 0`; `OrderExpiry != 0` (no TIF constraint).

**Sibling pair rule** (used by OCO and by OTOCO's tail pair): exactly 2 orders, each a valid child,
and the pair must contain **one stop-loss-family** (`2` or `3`) **and one take-profit-family**
(`4` or `5`) order — otherwise `ErrOrderTypeInvalid`.

### 8.5 Per-grouping rules

**OCO (2)** — `Orders.length must be 2` else `ErrOrderGroupSizeInvalid`, then:
1. `Orders[0].BaseAmount === Orders[1].BaseAmount` else `ErrBaseAmountsNotEqual`
2. `Orders[0].IsAsk === Orders[1].IsAsk` (same direction) else `ErrIsAskInvalid`
3. both `ReduceOnly === 1` else `ErrOrderReduceOnlyInvalid`
4. `Orders[0].OrderExpiry === Orders[1].OrderExpiry` else `ErrOrderExpiryInvalid`
5. sibling-pair rule (§8.4)

*(A position-tied SL/TP pair is expressed as OCO with `BaseAmount = 0` on both legs and
`ReduceOnly = 1`: the pair then closes whatever the position is at trigger time.)*

**OTO (1)** — `Orders.length must be 2`, then:
1. `Orders[1].BaseAmount === 0` else `ErrBaseAmountNotNil` (child size follows the parent's fill)
2. `Orders[0].IsAsk !== Orders[1].IsAsk` (opposite direction) else `ErrIsAskInvalid`
3. if `Orders[0].OrderExpiry !== 0` then it must equal `Orders[1].OrderExpiry`, else `ErrOrderExpiryInvalid`
4. parent rules on `Orders[0]` (§8.3)
5. child rules on `Orders[1]` (§8.4)

**OTOCO (3)** — `Orders.length must be 3`, then:
1. `Orders[1].BaseAmount === 0 && Orders[2].BaseAmount === 0` else `ErrBaseAmountNotNil`
2. `Orders[0].IsAsk !== Orders[1].IsAsk && Orders[0].IsAsk !== Orders[2].IsAsk` else `ErrIsAskInvalid`
3. `Orders[1].OrderExpiry === Orders[2].OrderExpiry` else `ErrOrderExpiryInvalid`
4. if `Orders[0].OrderExpiry !== 0` then it must equal `Orders[1].OrderExpiry`, else `ErrOrderExpiryInvalid`
5. parent rules on `Orders[0]`
6. sibling-pair rule on `Orders[1..3)`

### 8.6 Invariant the reference only documents in a comment

> If the primary (parent) order is `ReduceOnly`, **all** child orders must be `ReduceOnly` too,
> otherwise the sequencer's `CancelPositionTiedAccountOrders` flow breaks.

This is **not enforced** by the reference validator. **TS design:** enforce it (new error
`ErrChildReduceOnlyMismatch`), behind the same strict-mode flag as the other tightenings.

---

## 9. JSON wire format

### 9.1 The submission envelope

```
POST /api/v1/sendTx
Content-Type: application/x-www-form-urlencoded
Body fields:
  tx_type          decimal integer, the §3 code
  tx_info          the JSON document described below, as a string
  price_protection optional
```

```
POST /api/v1/sendTxBatch
Body fields:
  tx_types   JSON array of integers, e.g. "[14,15]"
  tx_infos   JSON array of JSON *strings*, e.g. "[\"{...}\",\"{...}\"]"
```

The `tx_info` string must start with `{` — the reference uses that as a sanity gate.
`SignedHash` is **never** part of `tx_info`; it is returned to the caller separately as `txHash`.

### 9.2 Encoding rules (these ARE the interop surface)

These follow Go's `encoding/json` defaults applied to untagged structs. Reproduce exactly:

| Source shape | JSON encoding | Example |
|---|---|---|
| any integer field | JSON **number** in decimal (never a string) | `"BaseAmount":1000` |
| `int64` / `uint64` | JSON number — may exceed `2^53` | `"Index":1152921504606846975` |
| `[]byte` slice (`Sig`, `PubKey`) | **base64, standard alphabet, padded** | `"Sig":"…108 chars…"` (80 bytes), `"PubKey":"…56 chars…"` (40 bytes) |
| `[32]byte` **array** (`Memo`) | **JSON array of 32 numbers** | `"Memo":[0,0,…,0]` |
| `string` (`L1Sig`) | JSON string, `0x`-prefixed lowercase hex, 132 chars total | `"L1Sig":"0x…"` |
| embedded struct pointer (`*OrderInfo`) | **flattened** into the parent object | — |
| embedded named map (`L2TxAttributes`) | own key `"L2TxAttributes"`, object with **decimal-string keys**, integer values | `"L2TxAttributes":{"1":42,"4":1}` |
| absent attribute map | `"L2TxAttributes":null` | |
| `json:"-"` field (`SignedHash`) | **omitted entirely** | |

Attribute-map key ordering in the reference is lexicographic on the decimal string. Since all keys
are single digits `1..7`, lexicographic == numeric. **TS design:** emit numerically-ascending keys;
this is byte-identical for the legal key set.

Nothing uses `omitempty`. Every declared key is always present, including zero values and `null`.

### 9.3 The 64-bit number hazard

`Index`, `ShareAmount`, `Amount`, `USDCFee`, `USDCAmount`, `OrderExpiry`, `Time`, and `Nonce` can
exceed `Number.MAX_SAFE_INTEGER`. `JSON.stringify(BigInt)` throws, and `JSON.parse` of a large
number silently loses precision.

**TS design (normative):** do not use `JSON.stringify` on the tx object. Emit `tx_info` with a
**hand-rolled serialiser driven by the field schema**, which:
- writes `bigint` fields via `.toString(10)` **without quotes**,
- writes byte slices as base64 (via a dependency-free encoder — see below),
- writes `Memo` as a bracketed number list,
- writes keys in the declared order.

This is ~60 lines, removes the reviver/replacer footgun entirely, and gives byte-stable golden files.

For **parsing** server responses containing 64-bit ids, use a `JSON.parse` reviver only where the
schema says the field is 64-bit, or (preferred) parse those fields out of the raw text. Details in
spec `05`.

### 9.4 Base64 without dependencies

- Node 20+/Bun/Deno/browsers: `btoa(String.fromCharCode(...bytes))` works for the ≤80-byte payloads
  here, but is fragile for large inputs.
- Preferred portable primitive: a 20-line table-driven encoder over
  `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/` with `=` padding.
  Deterministic, works identically on every target, no `Buffer`, no `btoa`.

---

## 10. L1-signed message templates (EIP-191 `personal_sign`)

Three tx types carry an Ethereum signature that binds the L2 action to an L1 address. The signature
is over a **plain UTF-8 string** built from a `printf`-style template, signed with EIP-191
`personal_sign`.

### 10.1 Number formatting: `hex10` (the zero-padded uint64 form)

Every numeric argument in every template is formatted by one function. Despite its name (`hex10` in
the reference), it produces **16 hex digits**:

```
hex10(v: bigint /* interpreted as uint64 */): string
    u   = BigInt.asUintN(64, v)                  // two's-complement reinterpretation
    hex = u.toString(16)                         // lowercase, no leading zeros; 0 -> "0"
    return "0x" + hex.padStart(16, "0")          // total length 18
```

Examples: `0 → "0x0000000000000000"`, `42 → "0x000000000000002a"`,
`-1 → "0xffffffffffffffff"`, `304 → "0x0000000000000130"`.

Every `%s` in every template below is a `hex10(...)` **except** where noted (pubkey hex, memo hex).

### 10.2 The templates (exact, `\n` = LF)

**Change public key** — `L2ChangePubKey`:

```
Register Lighter Account\n\npubkey: 0x%s\nnonce: %s\naccount index: %s\napi key index: %s\nOnly sign this message for a trusted client!
```

Arguments, in order:
1. `PubKey` as **lowercase hex, 80 chars, no `0x`** (the template supplies the `0x`)
2. `hex10(Nonce)`
3. `hex10(AccountIndex)`
4. `hex10(ApiKeyIndex)`

**Transfer** — `L2Transfer`:

```
Transfer\n\nnonce: %s\nfrom: %s (route %s)\napi key: %s\nto: %s (route %s)\nasset: %s\namount: %s\nfee: %s\nchainId: %s\nmemo: %s\nOnly sign this message for a trusted client!
```

Arguments, in order:
1. `hex10(Nonce)`
2. `hex10(FromAccountIndex)`
3. `hex10(FromRouteType)`
4. `hex10(ApiKeyIndex)`
5. `hex10(ToAccountIndex)`
6. `hex10(ToRouteType)`
7. `hex10(AssetIndex)`
8. `hex10(Amount)`
9. `hex10(USDCFee)`
10. `hex10(chainId)`
11. `Memo` as **lowercase hex, 64 chars, no `0x` prefix**

**Approve integrator** — `L2ApproveIntegrator`:

```
Approve Integrator\n\nnonce: %s\naccount index: %s\napi key index: %s\nintegrator account index: %s\nmax perps taker fee: %s\nmax perps maker fee: %s\nmax spot taker fee: %s\nmax spot maker fee: %s\napproval expiry: %s\nchainId: %s\nOnly sign this message for a trusted client!
```

Arguments, in order: `hex10` of `Nonce, AccountIndex, ApiKeyIndex, IntegratorAccountIndex,
MaxPerpsTakerFee, MaxPerpsMakerFee, MaxSpotTakerFee, MaxSpotMakerFee, ApprovalExpiry, chainId`.

**Create sub-account** — declared but **not wired to any tx** in the reference SDK (the L2
`CreateSubAccount` tx carries no `L1Sig` field). Included for completeness / future use:

```
Create Lighter Sub Account\n\nmaster account index: %s\nOnly sign this message for a trusted client!
```
Argument: `hex10(masterAccountIndex)`.

**Airdrop allocation** — declared, not used by any tx type; belongs to an off-chain claim flow:

```
Airdrop Allocation\n\nallocations: %s\nchainId: %s\nOnly sign this message for a trusted client!
```
Arguments: `allocations` (an opaque string, **not** `hex10`), `hex10(chainId)`.

**TS design:** ship all five templates as data (`L1_TEMPLATES`) with a typed argument tuple per
template, so a template change is one edit.

### 10.3 The EIP-191 flow

```
messageBytes = UTF8(templateString)
prefixed     = UTF8("\x19Ethereum Signed Message:\n" + messageBytes.length.toString(10)) ‖ messageBytes
digest       = keccak256(prefixed)                                      // 32 bytes
(r, s, recid)= secp256k1_ecdsa_sign_recoverable(digest, l1PrivateKey)   // canonical low-s
signature    = r(32 BE) ‖ s(32 BE) ‖ (recid + 27)                       // 65 bytes
L1Sig        = "0x" + hex(signature)                                    // 132 chars
```

Note `messageBytes.length` is the **byte** length, not the character count. All template strings are
pure ASCII, so they coincide — but a UTF-8-aware implementation is still required if a memo ever
carries non-ASCII (it cannot: memo is hex in the template).

**Verification / address recovery** (needed for `getL1Address(tx)` helpers): decode the 65 bytes,
normalise `v >= 27 → v − 27`, ecrecover the public key from `digest`, then
`address = "0x" + hex(keccak256(uncompressedPubKey[1..65]))[24..64]`, EIP-55 checksummed.

### 10.4 How TypeScript signs this without ethers/web3

The constraint is zero runtime dependencies. Two mechanisms, both shipped:

**(A) Injected signer — the default and recommended path.**

```ts
export interface EthPersonalSigner {
  /** EIP-191 personal_sign over a UTF-8 string. Returns 0x-prefixed 65-byte hex. */
  signMessage(message: string): Promise<`0x${string}`>;
  /** Optional; used only by getL1Address() sanity checks. */
  getAddress?(): Promise<`0x${string}`>;
}
```

This is satisfied verbatim by `viem`'s `WalletClient.signMessage({ message })` (string overload),
`ethers`' `Signer.signMessage`, an EIP-1193 provider via
`provider.request({ method: 'personal_sign', params: [hexUtf8(msg), address] })`, a hardware wallet,
a KMS, or a Cloudflare Worker binding. **No crypto ships in the core bundle for this path.** The core
package's `signTransfer` etc. take `{ l1Signer: EthPersonalSigner }` and never see a private key.

**(B) Built-in signer — optional subpath export `lighter-ts/l1-signer`.**

Minimum viable requirement is exactly two primitives, both implementable in pure TS/BigInt:

1. **keccak-256** (Keccak-f[1600], padding byte `0x01` — *not* SHA3's `0x06`). ~140 lines using
   `BigInt` lanes, or ~200 lines using paired `Uint32Array` lanes (≈8× faster; prefer this).
   Not available from `crypto.subtle` on any runtime — it must be hand-written.
2. **secp256k1 ECDSA with public-key recovery**. Requirements:
   - curve arithmetic over `p = 2^256 − 2^32 − 977` using `BigInt`,
   - Jacobian point add/double + windowed scalar multiply,
   - **RFC 6979** deterministic `k` via HMAC-SHA256 — `crypto.subtle.sign('HMAC', …)` supplies
     SHA-256 on every target, which makes the signer **async** (fine; the whole API is async),
   - low-`s` normalisation (`s > n/2 → s = n − s`, flip recid bit 0),
   - recovery id = `(Ry & 1) | (Rx >= n ? 2 : 0)`.
   ~350 lines.

Security posture to document: the built-in signer is **not constant-time** (BigInt is inherently
variable-time). It is acceptable for server-side keys under an attacker model without local timing
side channels, and unacceptable for shared/multi-tenant hosts. The docs must say this, and the
default export must be the injected-signer path.

`crypto.subtle` cannot help with secp256k1: WebCrypto's ECDSA supports only P-256/P-384/P-521.

**Decision: both, with (A) as the documented default and (B) behind a separate entry point so it is
tree-shaken away for the 90% of users who only place orders (no L1 signature needed at all).**

---

## 11. Constants (protocol values — reproduce exactly)

### 11.1 Order types

| Name | Value |
|---|---:|
| `LimitOrder` | 0 |
| `MarketOrder` | 1 |
| `StopLossOrder` | 2 |
| `StopLossLimitOrder` | 3 |
| `TakeProfitOrder` | 4 |
| `TakeProfitLimitOrder` | 5 |
| `TWAPOrder` | 6 |
| `TWAPSubOrder` (internal) | 7 |
| `LiquidationOrder` (internal) | 8 |
| `ApiMaxOrderType` | 6 |

### 11.2 Time in force (orders)

| Name | Value |
|---|---:|
| `ImmediateOrCancel` | 0 |
| `GoodTillTime` | 1 |
| `PostOnly` | 2 |

### 11.3 Time in force (cancel-all)

| Name | Value |
|---|---:|
| `ImmediateCancelAll` | 0 |
| `ScheduledCancelAll` | 1 |
| `AbortScheduledCancelAll` | 2 |

### 11.4 Grouping types

| Name | Value |
|---|---:|
| `GroupingType` (base sentinel, invalid) | 0 |
| `OneTriggersTheOther` | 1 |
| `OneCancelsTheOther` | 2 |
| `OneTriggersAOneCancelsTheOther` | 3 |

### 11.5 Margin & routing

| Name | Value |
|---|---:|
| `AssetMarginMode_Disabled` | 0 |
| `AssetMarginMode_Enabled` / `AssetMarginMode_Max` | 1 |
| `AccountAssetMarginMode_MarginDisabled` | 0 |
| `AccountAssetMarginMode_MarginEnabled` | 1 |
| `AssetRouteType_Perps` | 0 |
| `AssetRouteType_Spot` | 1 |
| `CrossMargin` | 0 |
| `IsolatedMargin` | 1 |
| `RemoveFromIsolatedMargin` | 0 |
| `AddToIsolatedMargin` | 1 |

### 11.6 Self-trade

| Name | Value |
|---|---:|
| `SelfTradeBehaviorExpireMaker` | 0 |
| `SelfTradeBehaviorExpireTaker` | 1 |
| `SelfTradeBehaviorCancelBoth` | 2 |
| `SelfTradeBehaviorReduce` | 3 |
| `SelfTradeEqualityAccountIndex` | 0 |
| `SelfTradeEqualityMasterAccountIndex` | 1 |

*(The Python SDK names value 2 `SELF_TRADE_BEHAVIOR_EXPIRE_BOTH`; the Go/protocol name is
`CancelBoth`. Use the protocol name and alias the Python one in a deprecation shim if needed.)*

### 11.7 Scales and ticks

| Name | Value |
|---|---:|
| `OneUSDC` | 1000000 |
| `OneLIT` | 100000000 |
| `FeeTick` | 1000000 |
| `MarginFractionTick` | 10000 |
| `ShareTick` | 10000 |
| `InitialPoolShareValue` | 1000 |

### 11.8 Index domains

| Name | Value |
|---|---:|
| `MinAccountIndex` | −1 |
| `MaxAccountIndex` | 281474976710654 (`2^48 − 2`) |
| `MaxMasterAccountIndex` | 140737488355327 (`2^47 − 1`) |
| `MinSubAccountIndex` | 140737488355328 (`2^47`) |
| `TreasuryAccountIndex` | 0 |
| `InsuranceFundOperatorAccountIndex` | 1 |
| `MinApiKeyIndex` | 0 |
| `MaxApiKeyIndex` | 254 |
| `NilApiKeyIndex` | 255 |
| `MinMarketIndex` | 0 |
| `MinPerpsMarketIndex` | 0 |
| `MaxPerpsMarketIndex` | 254 |
| `NilMarketIndex` | 255 |
| `MinSpotMarketIndex` | 2048 (`2^11`) |
| `MaxSpotMarketIndex` | 4094 (`2^12 − 2`) |
| `NilAssetIndex` | 0 |
| `MinAssetIndex` | 1 |
| `MaxAssetIndex` | 62 (`2^6 − 2`) |
| `NativeAssetIndex` | 1 |
| `USDCAssetIndex` | 3 |
| `DefaultStrategyIndex` / `MinStrategyIndex` | 0 |
| `MaxStrategyIndex` | 7 |
| `NilStrategyIndex` | 8 |
| `NilIntegratorIndex` | 0 |
| `NilIntegratorTakerFee` | 0 |
| `NilIntegratorMakerFee` | 0 |

### 11.9 Order domains

| Name | Value |
|---|---:|
| `MinNonce` | 0 |
| `MinOrderNonce` | 0 |
| `MaxOrderNonce` | 281474976710655 (`2^48 − 1`) |
| `NilClientOrderIndex` | 0 |
| `MinClientOrderIndex` | 1 |
| `MaxClientOrderIndex` | 281474976710655 (`2^48 − 1`) |
| `NilOrderIndex` | 0 |
| `MinOrderIndex` | 281474976710656 (`2^48`) |
| `MaxOrderIndex` | 1152921504606846975 (`2^60 − 1`) |
| `NilOrderBaseAmount` | 0 |
| `MinOrderBaseAmount` | 1 |
| `MaxOrderBaseAmount` | 281474976710655 (`2^48 − 1`) |
| `NilOrderPrice` | 0 |
| `MinOrderPrice` | 1 |
| `MaxOrderPrice` | 4294967295 (`2^32 − 1`) |
| `NilOrderTriggerPrice` | 0 |
| `MinOrderTriggerPrice` | 1 |
| `MaxOrderTriggerPrice` | 4294967295 |
| `NilOrderExpiry` | 0 |
| `MinOrderExpiry` | 1 |
| `MaxOrderExpiry` | 9223372036854775807 (`2^63 − 1`) |
| `MinOrderExpiryPeriod` | 300000 ms (5 min) |
| `MaxOrderExpiryPeriod` | 2592000000 ms (30 days) |
| `MinOrderCancelAllPeriod` | 300000 ms (5 min) |
| `MaxOrderCancelAllPeriod` | 1296000000 ms (15 days) |
| `MaxGroupedOrderCount` | 3 |
| `MaxTimestamp` | 281474976710655 (`2^48 − 1`) |

### 11.10 Value / share domains

| Name | Value |
|---|---:|
| `MaxExchangeUSDC` | 1152921504606846975 (`2^60 − 1`) |
| `MinTransferAmount` | 1 |
| `MaxTransferAmount` | 1152921504606846975 |
| `MinWithdrawalAmount` | 1 |
| `MaxWithdrawalAmount` | 1152921504606846975 |
| `MaxInvestedPublicPoolCount` | 16 |
| `MinInitialTotalShares` | 1000000 |
| `MaxInitialTotalShares` | 1000000000000 |
| `MaxPoolShares` | 1152921504606846975 |
| `MaxBurntShareUSDCValue` | 1152921504606846975 |
| `MaxPoolEntryUSDC` | 72057594037927935 (`2^56 − 1`) |
| `MinPoolSharesToMintOrBurn` | 1 |
| `MaxPoolSharesToMintOrBurn` | 1152921504606846975 |
| `MinInitialTotalStakingShares` | 10000000000 |
| `MaxInitialTotalStakingShares` | 100000000000000 |
| `MinStakingSharesToMintOrBurn` | 1 |
| `MaxStakingSharesToMintOrBurn` | 1152921504606846975 |
| `MaxStakingPoolShares` | 1152921504606846975 |

### 11.11 Sizes

| Name | Value |
|---|---:|
| `NbAttributesPerTx` | 4 |
| `MaxAttributeType` | 7 |
| `SignatureLength` (Schnorr) | 80 bytes |
| `L1SignatureLength` (secp256k1) | 65 bytes |
| `PubKeyLength` | 40 bytes |
| `HashLength` | 40 bytes |
| private key length | 40 bytes |

### 11.12 Asset ids observed in the Python SDK (informational only)

`ETH=1, LIT=2, USDC=3, LINK=5, UNI=6, AAVE=7, SKY=8, LDO=9`, with ticker scales
`USDC=1e6`, everything else `1e8`. These are **registry data, not protocol constants** —
the TS SDK must read them from `/api/v1/…` metadata and must not hard-code the mapping
beyond `NativeAssetIndex = 1` / `USDCAssetIndex = 3`.

---

## 12. Error catalogue

Every validation failure in the reference is a distinct sentinel error with a fixed message string.
The TS SDK MUST expose stable machine-readable codes; the human message should match the reference
wherever it is quoted in user-facing tooling.

**TS design:**

```ts
export class LighterValidationError extends Error {
  readonly code: LighterErrorCode;   // e.g. 'ORDER_PRICE_TOO_LOW'
  readonly field?: string;           // 'Price'
  readonly txType?: TxTypeCode;
  readonly bound?: bigint;           // the violated bound, for message interpolation
}
```

Complete code list (code ⇄ reference sentinel ⇄ message):

| Code | Reference sentinel | Message |
|---|---|---|
| `ASSET_INDEX_TOO_LOW` | `ErrAssetIndexTooLow` | `AssetIndex should not be less than 1` |
| `ASSET_INDEX_TOO_HIGH` | `ErrAssetIndexTooHigh` | `AssetIndex should not be larger than 62` |
| `ROUTE_TYPE_INVALID` | `ErrRouteTypeInvalid` | `RouteType is invalid` |
| `ACCOUNT_INDEX_TOO_LOW` | `ErrAccountIndexTooLow` | `AccountIndex should not be less than -1` |
| `ACCOUNT_INDEX_TOO_HIGH` | `ErrAccountIndexTooHigh` | `AccountIndex should not be larger than 281474976710654` |
| `FROM_ACCOUNT_INDEX_TOO_LOW` | `ErrFromAccountIndexTooLow` | `FromAccountIndex should not be less than -1` |
| `FROM_ACCOUNT_INDEX_TOO_HIGH` | `ErrFromAccountIndexTooHigh` | `FromAccountIndex should not be larger than 281474976710654` |
| `TO_ACCOUNT_INDEX_TOO_LOW` | `ErrToAccountIndexTooLow` | `ToAccountIndex should not be less than -1` |
| `TO_ACCOUNT_INDEX_TOO_HIGH` | `ErrToAccountIndexTooHigh` | `ToAccountIndex should not be larger than 281474976710654` |
| `API_KEY_INDEX_TOO_LOW` | `ErrApiKeyIndexTooLow` | `ApiKeyIndex should not be less than 0` |
| `API_KEY_INDEX_TOO_HIGH` | `ErrApiKeyIndexTooHigh` | `ApiKeyIndex should not be larger than 254` |
| `NONCE_TOO_LOW` | `ErrNonceTooLow` | `AccountNonce should not be less than 0` |
| `EXPIRED_AT_INVALID` | `ErrExpiredAtInvalid` | `ExpiredAt is invalid` |
| `CANCEL_ALL_TIF_INVALID` | `ErrInvalidCancelAllTimeInForce` | `CancelAllTimeInForce is invalid` |
| `CANCEL_ALL_TIME_NOT_NIL` | `ErrCancelAllTimeisNotNill` | `CancelAllTime should be nil` |
| `CANCEL_ALL_TIME_OUT_OF_RANGE` | `ErrCancelAllTimeIsNotInRange` | `CancelAllTime should be larger than 0 and not larger than 9223372036854775807` |
| `CANCEL_ALL_MARKET_CANT_BE_SCHEDULED` | `ErrCancelAllMarketIndexCantBeScheduled` | `Cancel all for market index can't be scheduled, TimeInforce must be ImmediateCancelAll` |
| `ORDER_REDUCE_ONLY_INVALID` | `ErrOrderReduceOnlyInvalid` | `ReduceOnly is invalid` |
| `ORDER_TRIGGER_PRICE_INVALID` | `ErrOrderTriggerPriceInvalid` | `TriggerPrice is invalid` |
| `ORDER_EXPIRY_INVALID` | `ErrOrderExpiryInvalid` | `OrderExpiry is invalid` |
| `PUBKEY_INVALID` | `ErrPubKeyInvalid` | `PubKey is invalid` |
| `PUBLIC_POOL_INDEX_TOO_LOW` | `ErrPublicPoolIndexTooLow` | `PublicPoolIndex should not be less than -1` |
| `PUBLIC_POOL_INDEX_TOO_HIGH` | `ErrPublicPoolIndexTooHigh` | `PublicPoolIndex should not be larger than 281474976710654` |
| `POOL_OPERATOR_FEE_INVALID` | `ErrInvalidPoolOperatorFee` | `PoolOperatorFee should be larger than 0 and not larger than 1000000` |
| `POOL_STATUS_INVALID` | `ErrInvalidPoolStatus` | `PoolStatus should be either 0 or 1` |
| `POOL_INITIAL_SHARES_TOO_LOW` | `ErrPoolInitialTotalSharesTooLow` | `PoolInitialTotalShares should be larger than 1000000` |
| `POOL_INITIAL_SHARES_TOO_HIGH` | `ErrPoolInitialTotalSharesTooHigh` | `PoolInitialTotalShares should not be larger than 1000000000000` |
| `POOL_MIN_OPERATOR_SHARE_RATE_TOO_LOW` | `ErrPoolMinOperatorShareRateTooLow` | `PoolMinOperatorShareRate should be larger than 0` |
| `POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH` | `ErrPoolMinOperatorShareRateTooHigh` | `PoolMinOperatorShareRate should not be larger than 10000` |
| `POOL_MINT_AMOUNT_TOO_LOW` | `ErrPoolMintShareAmountTooLow` | `PoolMintShareAmount should be larger than 1` |
| `POOL_MINT_AMOUNT_TOO_HIGH` | `ErrPoolMintShareAmountTooHigh` | `PoolMintShareAmount should not be larger than 1152921504606846975` |
| `POOL_BURN_AMOUNT_TOO_LOW` | `ErrPoolBurnShareAmountTooLow` | `PoolBurnShareAmount should be larger than 1` |
| `POOL_BURN_AMOUNT_TOO_HIGH` | `ErrPoolBurnShareAmountTooHigh` | `PoolBurnShareAmount should not be larger than 1152921504606846975` |
| `STAKING_POOL_INDEX_TOO_LOW` | `ErrStakingPoolIndexTooLow` | `StakingPoolIndex should not be less than 140737488355328` |
| `STAKING_POOL_INDEX_TOO_HIGH` | `ErrStakingPoolIndexTooHigh` | `StakingPoolIndex should not be larger than 281474976710654` |
| `STAKE_AMOUNT_TOO_LOW` | `ErrPoolStakeAssetsAmountTooLow` | `StakeAssetsAmount should be larger than 1` |
| `STAKE_AMOUNT_TOO_HIGH` | `ErrPoolStakeAssetsAmountTooHigh` | `StakeAssetsAmount should not be larger than 1152921504606846975` |
| `UNSTAKE_AMOUNT_TOO_LOW` | `ErrPoolUnstakeAssetsAmountTooLow` | `UnstakeAssetsAmount should be larger than 1` |
| `UNSTAKE_AMOUNT_TOO_HIGH` | `ErrPoolUnstakeAssetsAmountTooHigh` | `UnstakeAssetsAmount should not be larger than 1152921504606846975` |
| `WITHDRAWAL_AMOUNT_TOO_LOW` | `ErrWithdrawalAmountTooLow` | `WithdrawalAmount should be larger than 1` |
| `WITHDRAWAL_AMOUNT_TOO_HIGH` | `ErrWithdrawalAmountTooHigh` | `WithdrawalAmount should not be larger than 1152921504606846975` |
| `TRANSFER_AMOUNT_TOO_LOW` | `ErrTransferAmountTooLow` | `TransferAmount should be larger than 1` |
| `TRANSFER_AMOUNT_TOO_HIGH` | `ErrTransferAmountTooHigh` | `TransferAmount should not be larger than 1152921504606846975` |
| `TRANSFER_FEE_NEGATIVE` | `ErrTransferFeeNegative` | `TransferFee should not be negative` |
| `TRANSFER_FEE_TOO_HIGH` | `ErrTransferFeeTooHigh` | `TransferFee should not be larger than 1152921504606846975` |
| `MARKET_INDEX_INVALID` | `ErrInvalidMarketIndex` | `MarketIndex is not valid` |
| `MARKET_INDEX_MISMATCH` | `ErrMarketIndexMismatch` | `MarketIndex should match the market index of the order` |
| `MARKET_INDEX_TOO_LOW` | `ErrMarketIndexTooLow` | `MarketIndex should not be less than 0` |
| `MARKET_INDEX_TOO_HIGH` | `ErrMarketIndexTooHigh` | `MarketIndex should not be larger than 4094` |
| `IMF_TOO_LOW` | `ErrInitialMarginFractionTooLow` | `InitialMarginFraction should not be less than 0` |
| `IMF_TOO_HIGH` | `ErrInitialMarginFractionTooHigh` | `InitialMarginFraction should not be larger than 10000` |
| `CLIENT_ORDER_INDEX_TOO_LOW` | `ErrClientOrderIndexTooLow` | `ClientOrderIndex should not be less than 1` |
| `CLIENT_ORDER_INDEX_TOO_HIGH` | `ErrClientOrderIndexTooHigh` | `ClientOrderIndex should not be larger than 281474976710655` |
| `CLIENT_ORDER_INDEX_NOT_NIL` | `ErrClientOrderIndexNotNil` | `ClientOrderIndex should be nil` |
| `CLIENT_ORDER_INDEX_DUPLICATE` | `ErrClientOrderIndexDuplicate` | `ClientOrderIndex should be unique within the group` |
| `ORDER_INDEX_TOO_LOW` | `ErrOrderIndexTooLow` | `OrderIndex should not be less than 281474976710656` |
| `ORDER_INDEX_TOO_HIGH` | `ErrOrderIndexTooHigh` | `OrderIndex should not be larger than 1152921504606846975` |
| `BASE_AMOUNT_TOO_LOW` | `ErrBaseAmountTooLow` | `BaseAmount should not be less than 1` |
| `BASE_AMOUNT_TOO_HIGH` | `ErrBaseAmountTooHigh` | `BaseAmount should not be larger than 281474976710655` |
| `BASE_AMOUNTS_NOT_EQUAL` | `ErrBaseAmountsNotEqual` | `BaseAmounts should be equal` |
| `BASE_AMOUNT_NOT_NIL` | `ErrBaseAmountNotNil` | `BaseAmount should be nil` |
| `PRICE_TOO_LOW` | `ErrPriceTooLow` | `OrderPrice should not be less than 1` |
| `PRICE_TOO_HIGH` | `ErrPriceTooHigh` | `OrderPrice should not be larger than 4294967295` |
| `IS_ASK_INVALID` | `ErrIsAskInvalid` | `IsAsk should be 0 or 1` |
| `ORDER_TYPE_INVALID` | `ErrOrderTypeInvalid` | `OrderType is not valid` |
| `ORDER_TIF_INVALID` | `ErrOrderTimeInForceInvalid` | `OrderTimeInForce is not valid` |
| `GROUPING_TYPE_INVALID` | `ErrGroupingTypeInvalid` | `GroupingType is not valid` |
| `ORDER_GROUP_SIZE_INVALID` | `ErrOrderGroupSizeInvalid` | `OrderGroupSize is not valid` |
| `SIGNATURE_INVALID` | `ErrInvalidSignature` | `TxSignature is invalid` |
| `MARGIN_MODE_INVALID` | `ErrInvalidMarginMode` | `MarginMode is not valid` |
| `CANCEL_MODE_INVALID` | `ErrCancelModeInvalid` | `CancelMode is not valid` |
| `UPDATE_MARGIN_DIRECTION_INVALID` | `ErrInvalidUpdateMarginDirection` | `Margin movement direction is not valid` |
| `ACCOUNT_MUST_BE_TREASURY` | `ErrAccountIndexMustBeTreasury` | `AccountIndex must be the treasury account index 0` |
| `ACCOUNT_MUST_BE_INSURANCE_OPERATOR` | `ErrAccountIndexMustBtInsuranceFundOperator` | `AccountIndex must be the insurance fund operator account index 1` |
| `STRATEGY_INDEX_INVALID` | `ErrInvalidStrategyIndex` | `StrategyIndex is not valid` |
| `ACCOUNT_TRADING_MODE_INVALID` | `ErrInvalidAccountTradingMode` | `AccountTradingMode is invalid` |
| `ASSET_MARGIN_MODE_INVALID` | `ErrInvalidAssetMarginMode` | `AssetMarginMode is invalid` *(declared, unused)* |
| `TOO_MANY_ATTRIBUTES` | `ErrTooManyAttributes` | `Too many attributes, should not be larger than 4` |
| `ATTRIBUTE_TYPE_INVALID` | `ErrInvalidAttributeType` | `Attribute type is invalid: <type>` |
| `ATTRIBUTE_VALUE_OUT_OF_RANGE` | `ErrAttributeValueOutOfRange` | `Attribute value is out of range` *(declared, unused — per-type errors are returned instead)* |
| `APPROVAL_EXPIRY_INVALID` | `ErrApprovalExpiryInvalid` | `ApprovalExpiry is invalid` |
| `APPROVAL_EXPIRY_ZERO_ON_REVOCATION` | `ErrApprovalExpiryZeroOnRevocation` | `ApprovalExpiry should be zero when revoking integrator approval` |
| `INTEGRATOR_ACCOUNT_INDEX_TOO_LOW` | `ErrIntegratorAccountIndexTooLow` | `IntegratorAccountIndex should not be less than -1` |
| `INTEGRATOR_ACCOUNT_INDEX_TOO_HIGH` | `ErrIntegratorAccountIndexTooHigh` | `IntegratorAccountIndex should not be larger than 281474976710654` |
| `FEE_TOO_HIGH` | `ErrFeeTooHigh` | `MarketFee should not be larger than 1000000` |
| `INTEGRATOR_ACCOUNT_INDEX_RANGE` | `ErrIntegratorAccountIndexInvalidRange` | `IntegratorAccountIndex is in invalid range` |
| `INTEGRATOR_FEE_RANGE` | `ErrIntegratorFeeInvalidRange` | `Integrator fees are in invalid range` |
| `INTEGRATOR_REQUIRED_FOR_FEES` | `ErrIntegratorAccountIndexRequiredForNonZeroFees` | `IntegratorAccountIndex should be non-zero when integrator taker fee or maker fee is non-zero` |
| `NONCE_SKIP_ATTRIBUTE_INVALID` | `ErrNonceSkipAttributeInvalid` | `Nonce skip attribute is invalid` |
| `CANCEL_ALL_MARKET_INDEX_RANGE` | `ErrCancelAllMarketIndexInvalidRange` | `Cancel all for market index attribute is in invalid range` |
| `SELF_TRADE_SPEC_WITH_FEES` | `ErrSelfTradeSpecificationNotAllowedWithNonZeroFees` | `Self-trade specification isn't allowed with integrator fees` |
| `SELF_TRADE_REDUCE_WITH_MAI` | `ErrReduceModeNotAllowedWithMasterAccountIndexEqualityMode` | `Reduce self-trade behavior mode isn't allowed with master account index equality mode` |
| `SELF_TRADE_EQUALITY_MODE_RANGE` | `ErrSelfTradeEqualityModeInvalidRange` | `SelfTradeEqualityMode is in invalid range` |
| `SELF_TRADE_BEHAVIOR_MODE_RANGE` | `ErrSelfTradeBehaviorModeInvalidRange` | `SelfTradeBehaviorMode is in invalid range` |

New codes introduced by this SDK (strict mode only): `CHILD_REDUCE_ONLY_MISMATCH`,
`MARKET_INDEX_NOT_PERPS`, `MEMO_LENGTH_INVALID`, `NEGATIVE_MARGIN_AMOUNT`.

---

## 13. TypeScript design

### 13.1 Branded numeric types

The failure mode this prevents: passing a `uint32` price where an `int64` amount is expected, or a
`number` where a `bigint` is required. Structural typing would happily accept both.

```ts
declare const brand: unique symbol;
type Brand<T, K extends string> = T & { readonly [brand]: K };

export type U8   = Brand<number, 'u8'>;
export type U16  = Brand<number, 'u16'>;
export type I16  = Brand<number, 'i16'>;
export type U32  = Brand<number, 'u32'>;
export type I64  = Brand<bigint, 'i64'>;
export type U64  = Brand<bigint, 'u64'>;
```

**Rule:** every protocol field declared `int64`/`uint64` is `bigint` in TS; everything ≤32 bits is
`number`. This is mechanical (no per-field judgement) and correct — `Index`, `ShareAmount`, `Amount`,
`USDCFee`, `USDCAmount`, `OrderExpiry`, `Time`, and `Nonce` all exceed `2^53`.

Smart constructors validate at the boundary and are the only way to mint a branded value:

```ts
export const u8  = (v: number): U8  => (assertRange(v, 0, 255, 'u8'), v as U8);
export const i64 = (v: bigint | number): I64 => (assertI64(v), BigInt(v) as I64);
```

The **public** API accepts `number | bigint` for 64-bit fields and coerces once, throwing
`LighterValidationError('UNSAFE_INTEGER')` on a non-integer or unsafe `number`. Internals only ever
see branded values.

### 13.2 Discriminated union

```ts
export type LighterTx =
  | { type: TxType.L2CreateOrder;        /* … */ }
  | { type: TxType.L2CancelOrder;        /* … */ }
  | … ;                                  // 20 members
```

Discriminant is the numeric `TxType` enum member, so `tx.type` doubles as the wire `tx_type` value
and as the second hash element. No string↔number mapping table.

### 13.3 The one table that drives everything

The reference requires **three** edits per new tx type (a struct, a `Hash` method, a `Validate`
method) plus a fourth in the client and a fifth in the FFI shim. Five code sites is why the
reference has copy-paste error identities (§7.11, §7.15).

**Design: one declarative schema per tx type; the hasher, the JSON serialiser, the TS type, and the
validator projection are all derived.**

```ts
type Enc =
  | { k: 'int' }                       // absorb one element (§1.2), JSON number
  | { k: 'splitU64' }                  // absorb two elements (lo, hi) logical
  | { k: 'splitI64Arith' }             // absorb two elements, arithmetic hi shift
  | { k: 'gfp5' }                      // 40 bytes -> 5 elements; JSON base64
  | { k: 'bytesB64'; len: number }     // JSON base64 only, never hashed
  | { k: 'byteArray'; len: number }    // JSON number-array only, never hashed
  | { k: 'hexString' }                 // JSON 0x-hex string, never hashed
  | { k: 'orders' };                   // OrderInfo[]: leaf-hash fold -> 4 elements

interface FieldSpec {
  name: string;                        // TS property name
  json: string;                        // wire key, PascalCase
  enc: Enc;
  ts: 'u8'|'u16'|'i16'|'u32'|'i64'|'u64'|'bytes'|'string'|'orders';
}

interface TxSchema {
  txType: TxType;
  fields: readonly FieldSpec[];        // JSON emission order
  hashOrder: readonly string[];        // field names; the universal prefix is implicit
  validate(tx: never, ctx: ValidateCtx): void;
}
```

Then:

```ts
hash(tx, chainId) =
  aggregate(
    hashToQuinticExtension([
      f(chainId), f(schema.txType), f(tx.nonce), f(tx.expiredAt),
      ...schema.hashOrder.flatMap(n => encodeHash(schema.field(n), tx[n]))
    ]),
    tx.attributes)

toTxInfo(tx) =
  '{' + schema.fields.map(f => `"${f.json}":${encodeJson(f, tx[f.name])}`).join(',') +
        `,"L2TxAttributes":${encodeAttrs(tx.attributes)}` + '}'
```

Adding a tx type = **one schema entry + one `validate` function**. The union member type can be
derived from the schema with a mapped type, so it cannot drift.

Note the universal prefix (`chainId, txType, Nonce, ExpiredAt`) is *not* in `hashOrder` — it is
emitted by the hasher, and `Nonce`/`ExpiredAt` appear again in `fields` for JSON. This mismatch
between hash order and JSON order is exactly why the two projections must be separate lists rather
than one ordered list. `Sig`, `L1Sig`, and `Memo` appear only in `fields`.

### 13.4 Immutable builder, explicit pipeline

```ts
const unsigned = buildCreateOrder({ marketIndex, clientOrderIndex, … }, opts); // pure, validates
const hash     = txHash(unsigned, chainId);            // Uint8Array(40)
const signed   = await sign(unsigned, apiKey);         // attaches Sig
const body     = toTxInfo(signed);                     // string
```

Every stage is separately testable and separately exportable. Users who need an air-gapped signer
can call `txHash` on one machine and `sign` on another. The reference conflates build/validate/hash/
sign into one 20×-duplicated `Construct*Tx` function; this design has one.

### 13.5 Tree-shaking layout

```
lighter-ts                    -> re-exports the client
lighter-ts/tx                 -> schemas, builders, hashing, serialisation (no network)
lighter-ts/crypto             -> Goldilocks, Poseidon2, gFp5, Schnorr
lighter-ts/l1-signer          -> keccak256 + secp256k1 (opt-in, ~15 kB)
lighter-ts/constants          -> §11 tables only
```

A bot that only places and cancels orders pulls `tx` + `crypto`; `l1-signer` never enters the bundle.
All modules are side-effect-free (`"sideEffects": false`) and ESM-only with an explicit `exports` map.

### 13.6 Cross-runtime notes

- No `Buffer`, no `node:crypto`, no `process`. Base64 and hex are hand-rolled (§9.4).
- `crypto.subtle` is used only for HMAC-SHA256 inside the optional L1 signer, and for
  `crypto.getRandomValues` in key generation. Both exist on Bun, Node 20+, Deno, Workers, browsers.
- `BigInt` literals require `target: ES2020+`. Set `"target": "ES2022"`, `"lib": ["ES2022"]`.
- Cloudflare Workers: all of the above is available in the default (non-`nodejs_compat`) runtime.
- Bun: `bun build --target=browser` must not pull polyfills; verify with a bundle-size test in CI.

---

## 14. Conformance and test vectors

The reference tests use randomly generated keys and assert only structural properties — they contain
**no golden hashes**. That is not good enough for a clean-room reimplementation.

Required conformance suite:

1. **Field-element reinterpretation.** Table test over `{0, 1, −1, 254, 255, 2^31, 2^32−1, 2^32,
   2^47, 2^48−2, 2^48−1, 2^60−1, 2^63−1, −2^63}` for each of `i16/u16/u32/i64/u64`, asserting the
   canonical field element.
2. **Sponge edge cases.** `hashNToM([], 5)` → all zeros; 8-element input (exactly one block);
   9-element input (partial second block, verifying rate-lane carry-over); 10-element (the grouped-
   order leaf shape); 16-element (the create-order shape).
3. **Attribute normalisation.** Every combination of ≤4 attributes: assert the normalised type
   vector, the 8-element absorb list, `isEmpty`, and the aggregate branch taken.
4. **Per-tx golden vectors.** For all 20 types, with fixed chain id 304, fixed account/apikey/nonce/
   expiredAt, and a fixed private key: assert the exact 40-byte hash (hex), the exact 80-byte
   signature (base64), and the exact `tx_info` string. Generate these once from the reference binary
   (running it as a black box is permitted — reading its source to reimplement is not) and freeze
   them as JSON fixtures.
5. **Attribute cross-product for one tx type.** `L2CreateOrder` × `{no attrs, skipNonce,
   integrator triple, cancel-all-market, self-trade pair}` — 5 more golden hashes.
6. **Grouped orders.** OCO/OTO/OTOCO golden hashes, plus one 3-order group verifying the left-fold
   order (swap two orders → different hash).
7. **Validation matrix.** For every rule in §7 and §8, one input that trips it, asserting the exact
   error code. Roughly 150 cases; generate the table from the spec so drift is impossible.
8. **L1 templates.** Golden strings for all three wired templates including `hex10` edge cases
   (`0`, `−1`, `2^48−2`), plus the EIP-191 digest and a known-key signature.
9. **JSON encoding.** Assert base64 for `Sig`/`PubKey`, the 32-number array for `Memo`,
   `"L2TxAttributes":null` when absent, and no `SignedHash` key.
10. **Round-trip against a live testnet.** A tagged integration test that signs one order per tx
    family against chain 300 and asserts the server-returned `tx_hash` equals the locally computed
    one. This is the only end-to-end proof that the reimplementation is correct.

---

## 15. Summary of deviations from the reference (all deliberate)

| # | Reference behaviour | This SDK |
|---|---|---|
| 1 | Attribute options with nil values still land in JSON | dropped at construction; JSON and hash always agree |
| 2 | `OrderExpiry = -1` sentinel expanded in the FFI shim | no sentinel; absolute ms or `expiryIn({days})` helper |
| 3 | Chain id inferred from the URL string | explicit, required argument |
| 4 | Float multiplication for decimal scaling | integer/`bigint` only; `parseUnits` helper |
| 5 | `L2CreatePublicPool` accepts `InitialTotalShares` below the documented minimum | strict mode enforces `MinInitialTotalShares` |
| 6 | `L2UpdateLeverage` accepts any `MarketIndex != 255` | strict mode enforces the perps range |
| 7 | `L2UpdateMargin` accepts negative amounts | strict mode rejects; escape hatch preserves byte-exact hashing |
| 8 | Parent/child `ReduceOnly` consistency only in a comment | enforced in strict mode |
| 9 | Three code sites (five with client + shim) per tx type | one schema entry + one validator |
| 10 | Compiled Go `.so` loaded via `ctypes` (Python) / WASM blob (JS) | pure TypeScript, zero native code |
| 11 | Signing requires a private key in process | injected `EthPersonalSigner` is the default for L1 |
| 12 | Errors are opaque strings | typed `LighterValidationError` with stable codes |
