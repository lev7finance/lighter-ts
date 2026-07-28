# 07 — High-Level Client, Signer Client, Nonce Management, End-User Workflows

**Status:** functional specification for a clean-room TypeScript reimplementation.
**Scope of this document:** everything above the wire codec — the user-facing transaction surface, the
client-side arithmetic performed on the user's behalf, nonce allocation, the transaction lifecycle
(build → validate → hash → sign → serialize → submit → confirm), multi-key/multi-account handling,
API-key registration, auth tokens, market-metadata bootstrapping, and the acceptance surface defined
by the reference example scripts.

**Out of scope (owned by sibling specs):** field arithmetic / Poseidon2 / Schnorr internals (crypto spec),
per-tx-type hash field orders and JSON key names (codec spec), full REST endpoint catalogue and response
models (REST spec), WebSocket channel/subscription semantics (WS spec). Where this document states a
protocol detail it is because the client layer *must* produce it exactly; the authoritative definition
lives in the referenced sibling spec.

---

## 1. Domain model and vocabulary

### 1.1 Identity triple

Every signed transaction is authorised by the triple **(chainId, accountIndex, apiKeyIndex)** plus a
**nonce** that is scoped to `(accountIndex, apiKeyIndex)`.

| Concept | Type | Domain | Notes |
|---|---|---|---|
| `chainId` | uint32 | see §1.2 | Folded into every tx hash — wrong value ⇒ signature rejected |
| `accountIndex` | int64 | `-1 … 281474976710654` (`2^48 − 2`) | Master accounts `0 … 140737488355327` (`2^47 − 1`); sub-accounts / public pools `140737488355328 … 2^48−2` |
| `apiKeyIndex` | uint8 | `0 … 254`; `255` = "nil / unspecified" | Index `0` is used by the web app; SDK users should use ≥ 1. Index `253` is the convention for read-only token generation. Maker-only restriction lists require indexes ≥ 4 |
| `nonce` | int64 | `≥ 0` | Per `(account, apiKey)` counter maintained by the sequencer |

An **API key** is a Schnorr keypair over the ecgFp5 curve: private key = 32-byte scalar (little-endian
hex), public key = 40-byte quintic-extension element (little-endian hex). Both are exchanged as
`0x`-prefixed lowercase hex. The server stores/returns the public key **without** the `0x` prefix, so
comparisons must normalise.

### 1.2 Endpoint profiles (must be reproduced exactly)

| Profile | REST base | WebSocket | chainId |
|---|---|---|---|
| `mainnet` | `https://mainnet.zklighter.elliot.ai` | `wss://mainnet.zklighter.elliot.ai/stream` | `304` |
| `testnet` | `https://testnet.zklighter.elliot.ai` | `wss://testnet.zklighter.elliot.ai/stream` | `300` |
| `robinhood` | `https://api.rh.lighter.xyz` | `wss://api.rh.lighter.xyz/stream` | `466324` |
| `robinhood_testnet` | `https://api.rh-testnet.lighter.xyz` | `wss://api.rh-testnet.lighter.xyz/stream` | `300` |

Base URLs are normalised by stripping trailing `/`. Default profile is `mainnet`.

The Python reference *infers* chainId by substring-matching the base URL
(`"mainnet.zklighter"→304`, `"testnet.zklighter"→300`, `"api.rh.lighter"→466324`,
`"api.rh-testnet.lighter"→300`, otherwise `304`). **This is a defect** — a proxy, a vanity domain, or a
mainnet URL served under a testnet-looking host silently produces signatures for the wrong chain. The
TypeScript SDK must never infer chainId from a string; it comes from the named profile or is supplied
explicitly, and supplying a custom `apiUrl` without a `chainId` is a construction-time error.

### 1.3 Transaction type codes

Client-issued L2 types (uint8, submitted as the `tx_type` field):

| Code | Transaction |
|---|---|
| 8 | ChangePubKey |
| 9 | CreateSubAccount |
| 10 | CreatePublicPool |
| 11 | UpdatePublicPool |
| 12 | Transfer |
| 13 | Withdraw |
| 14 | CreateOrder |
| 15 | CancelOrder |
| 16 | CancelAllOrders |
| 17 | ModifyOrder |
| 18 | MintShares |
| 19 | BurnShares |
| 20 | UpdateLeverage |
| 28 | CreateGroupedOrders |
| 29 | UpdateMargin |
| 35 | StakeAssets |
| 36 | UnstakeAssets |
| 41 | UpdateAccountConfig |
| 42 | UpdateAccountAssetConfig |
| 45 | ApproveIntegrator |

(Types 1–7 are L1-originated, 21–27 are sequencer-internal, 30–34/37/38/40/43/44 are L1/admin — a client
never signs them.)

### 1.4 Enumerations

```
OrderType:            LIMIT=0  MARKET=1  STOP_LOSS=2  STOP_LOSS_LIMIT=3
                      TAKE_PROFIT=4  TAKE_PROFIT_LIMIT=5  TWAP=6
TimeInForce:          IMMEDIATE_OR_CANCEL=0  GOOD_TILL_TIME=1  POST_ONLY=2
CancelAllTimeInForce: IMMEDIATE=0  SCHEDULED=1  ABORT=2
GroupingType:         ONE_TRIGGERS_THE_OTHER=1  ONE_CANCELS_THE_OTHER=2
                      ONE_TRIGGERS_A_ONE_CANCELS_THE_OTHER=3
MarginMode:           CROSS=0  ISOLATED=1
MarginDirection:      REMOVE_COLLATERAL=0  ADD_COLLATERAL=1
AssetMarginMode:      DISABLED=0  ENABLED=1
AccountTradingMode:   SIMPLE=0  UNIFIED(UTA)=1
RouteType:            PERP=0  SPOT=1
SelfTradeBehavior:    EXPIRE_MAKER=0  EXPIRE_TAKER=1  EXPIRE_BOTH=2  REDUCE=3
SelfTradeEquality:    ACCOUNT_INDEX=0  MASTER_ACCOUNT_INDEX=1
PublicPoolStatus:     ACTIVE=0  FROZEN=1
```

### 1.5 Sentinels and magic defaults

| Name | Value | Meaning |
|---|---|---|
| `NIL_API_KEY_INDEX` | `255` | "let the SDK choose" (client-side); also the nil marker in-protocol |
| `DEFAULT_NONCE` | `-1` | "let the SDK / signer fetch the next nonce" |
| `SKIP_NONCE_OFF / ON` | `0 / 1` | Attribute 4; see §5.5 |
| `NIL_TRIGGER_PRICE` | `0` | |
| `NIL_ORDER_EXPIRY` | `0` | Also the correct expiry for IOC orders |
| `DEFAULT_28_DAY_ORDER_EXPIRY` | `-1` | Sentinel; expanded to `now_ms + 28 days` (`2_419_200_000` ms) |
| `DEFAULT_10_MIN_AUTH_EXPIRY` | `-1` | Sentinel; expanded to `600` seconds |
| `NIL_MARKET_INDEX` | `255` | cancel-all across all markets |
| `NIL_CLIENT_ORDER_INDEX` | `0` | server assigns |
| `NIL_ORDER_BASE_AMOUNT` | `0` | "whole position" for reduce-only / position-tied orders |
| `DEFAULT_TX_EXPIRY` | `600_000 − 1_000 = 599_000` ms | `expiredAt = now_ms + 599_000` when unset. The 1 s haircut exists to absorb ms-vs-s rounding at the sequencer |

### 1.6 Numeric ticks and ranges (protocol constants)

```
FeeTick                 = 1_000_000      (integrator fees; value/1e6 = fraction)
MarginFractionTick      = 10_000         (IMF; 10_000 = 1× leverage, 500 = 20×)
ShareTick               = 10_000         (min operator share rate)
OneUSDC                 = 1_000_000
OneLIT                  = 100_000_000
InitialPoolShareValue   = 1_000          (0.001 USDC per share)

MinApiKeyIndex=0        MaxApiKeyIndex=254        NilApiKeyIndex=255
MinPerpsMarketIndex=0   MaxPerpsMarketIndex=254   NilMarketIndex=255
MinSpotMarketIndex=2048 MaxSpotMarketIndex=4094
MinClientOrderIndex=1   MaxClientOrderIndex=2^48−1   NilClientOrderIndex=0
MinOrderIndex=2^48      MaxOrderIndex=2^60−1         NilOrderIndex=0
MinOrderBaseAmount=1    MaxOrderBaseAmount=2^48−1    NilOrderBaseAmount=0
MinOrderPrice=1         MaxOrderPrice=2^32−1         NilOrderPrice=0
MinOrderTriggerPrice=1  MaxOrderTriggerPrice=2^32−1  NilOrderTriggerPrice=0
MinOrderExpiry=1        MaxOrderExpiry=2^63−1        NilOrderExpiry=0
MinOrderExpiryPeriod    = 5 min          MaxOrderExpiryPeriod    = 30 days
MinOrderCancelAllPeriod = 5 min          MaxOrderCancelAllPeriod = 15 days
MaxGroupedOrderCount    = 3
MaxTimestamp            = 2^48−1
MinTransferAmount=1     MaxTransferAmount=2^60−1
MinWithdrawalAmount=1   MaxWithdrawalAmount=2^60−1
MinInitialTotalShares   = 1_000_000          (1,000 USDC of shares)
MaxInitialTotalShares   = 1_000_000_000_000  (1e9 USDC of shares)
MinPoolSharesToMintOrBurn = 1   MaxPoolSharesToMintOrBurn = 2^60−1
NbAttributesPerTx       = 4      (hard cap on L2 tx attributes)
```

### 1.7 Assets and ticker scales

The reference hard-codes an asset-id → decimal-scale table:

| assetId | symbol | scale (10^d) |
|---|---|---|
| 1 | ETH | 1e8 |
| 2 | LIT | 1e8 |
| 3 | USDC | 1e6 |
| 5 | LINK | 1e8 |
| 6 | UNI | 1e8 |
| 7 | AAVE | 1e8 |
| 8 | SKY | 1e8 |
| 9 | LDO | 1e8 |

`assetId 4` is absent. Protocol constants: `NativeAssetIndex = 1`, `USDCAssetIndex = 3`,
`MinAssetIndex = 1`, `MaxAssetIndex = 2^6 − 2 = 62`, `NilAssetIndex = 0`.

**Do not hard-code this table.** `GET /api/v1/assetDetails` returns `decimals` per asset. The TypeScript
SDK ships the table only as a *fallback seed* for offline use and prefers the fetched value; a mismatch
between the seed and the server must produce a warning, not a silent wrong scale. (A new asset listed
server-side would otherwise throw "Unsupported asset id" in the reference.)

---

## 2. The reference `SignerClient` surface — complete inventory

The reference exposes each transaction in **two** flavours plus, for some, human-unit convenience
wrappers:

* `sign_*` — synchronous. Builds, validates, hashes, signs, serialises. Returns
  `(txType, txInfoJson, txHash, error)`. Used for WS submission and batching.
* `await <verb>` — asynchronous. Calls the matching `sign_*`, then POSTs it. Returns
  `(parsedTx | txInfoJson, RespSendTx, error)`. Wrapped by the nonce/api-key decorator (§4.3).
* Convenience wrappers (`create_market_order`, `create_tp_order`, …) that fix some parameters.

Below, every method is listed with its parameters, defaults, units, and return value. **Units column is
normative**: `int` means a protocol integer already scaled; `human` means a decimal quantity the SDK
scales for the caller.

### 2.1 Construction & lifecycle

| Method | Parameters | Returns |
|---|---|---|
| constructor | `url`, `accountIndex: int64`, `apiPrivateKeys: Map<apiKeyIndex, hexPrivateKey>`, `nonceManagementType = OPTIMISTIC`, `chainId?: int` | client |
| `create_api_key()` | — | `(privateKeyHex0x, publicKeyHex0x, error)` — pure local keygen |
| `check_client()` | — | `error | null`; verifies every configured key against the server |
| `close()` | — | releases the HTTP session |
| `are_keys_equal(a, b)` | two hex strings | bool, `0x`-insensitive |

Constructor behaviour to reproduce:
1. Strip a leading `0x` from every private key (mutating the caller's map in the reference — do **not** do that).
2. Reject an empty key map.
3. Perform **no network I/O** — nonces are fetched lazily. (This is explicitly documented and relied on
   by `create_market_order_async_client.py`.)
4. Register one signer context per `(accountIndex, apiKeyIndex)`.

### 2.2 Order transactions

**`sign_create_order` / `create_order`**

| Param | Type | Default | Units |
|---|---|---|---|
| `market_index` | int16 | — | market id (perp 0–254, spot 2048–4094) |
| `client_order_index` | int64 | — | `0` = server-assigned; else `1 … 2^48−1` |
| `base_amount` | int64 | — | int, `size × 10^supported_size_decimals` |
| `price` | uint32 | — | int, `price × 10^supported_price_decimals` |
| `is_ask` | bool/uint8 | — | `1` = sell |
| `order_type` | uint8 | — | see §1.4 |
| `time_in_force` | uint8 | — | see §1.4 |
| `reduce_only` | bool | `false` | spot markets must use `0` |
| `trigger_price` | uint32 | `0` | int, same scale as price |
| `order_expiry` | int64 | `-1` | ms epoch; `-1`→`now+28d`; `0` = nil |
| `integrator_account_index` | int64 | `0` | attribute 1 |
| `integrator_taker_fee` | uint32 | `0` | attribute 2, `/1e6` |
| `integrator_maker_fee` | uint32 | `0` | attribute 3, `/1e6` |
| `self_trade_behavior_mode` | uint8 | `0` | attribute 6 |
| `self_trade_equality_mode` | uint8 | `0` | attribute 7 |
| `skip_nonce` | 0/1 | `0` | attribute 4 |
| `nonce` | int64 | `-1` | |
| `api_key_index` | uint8 | `255` | |

Returns `(CreateOrder, RespSendTx, null)` or `(null, null, errorString)`.

**`sign_create_grouped_orders` / `create_grouped_orders`** — `grouping_type: uint8`,
`orders: OrderReq[]` (1–3, all same market, perps only), plus the same integrator / self-trade /
nonce parameters at the **group** level (a single value applies to the whole batch).
Each `OrderReq` carries `{marketIndex, clientOrderIndex, baseAmount, price, isAsk, type, timeInForce,
reduceOnly, triggerPrice, orderExpiry}`.

**`sign_cancel_order` / `cancel_order`** — `market_index: int16`, `order_index: int64` (either a client
order index `1…2^48−1` or an exchange order index `2^48…2^60−1`).

**`sign_cancel_all_orders` / `cancel_all_orders`** — `time_in_force: uint8`, `timestamp_ms: int64`,
`cancel_all_market_index: int16 = 255` (attribute 5).

**`sign_modify_order` / `modify_order`** — `market_index`, `order_index`, `base_amount`, `price`,
`trigger_price = 0`, plus integrator + self-trade + nonce params.

**Convenience order wrappers** (all delegate to `create_order`):

| Wrapper | Fixed parameters |
|---|---|
| `create_market_order(market_index, client_order_index, base_amount, avg_execution_price, is_ask, reduce_only=false, …)` | `price = avg_execution_price`, `type=MARKET`, `tif=IOC`, `order_expiry=0` |
| `create_tp_order(…, trigger_price, price, is_ask, reduce_only=false, …)` | `type=TAKE_PROFIT`, `tif=IOC`, `order_expiry=-1` |
| `create_tp_limit_order(…)` | `type=TAKE_PROFIT_LIMIT`, `tif=GTT`, `order_expiry=-1` |
| `create_sl_order(…)` | `type=STOP_LOSS`, `tif=IOC`, `order_expiry=-1` |
| `create_sl_limit_order(…)` | `type=STOP_LOSS_LIMIT`, `tif=GTT`, `order_expiry=-1` |
| `create_market_order_limited_slippage(…, base_amount, max_slippage, …)` | §3.3 |
| `create_market_order_if_slippage(…, base_amount, max_slippage, …)` | §3.4 |
| `create_market_order_quote_amount(…, quote_amount, max_slippage, …)` | §3.5 |

Note: the TP/SL wrappers do **not** expose the self-trade parameters, and there is no `create_limit_order`
in the reference — callers use `create_order` with `type=LIMIT` directly. The TS SDK adds an explicit
`limit()` (see §9).

### 2.3 Account & margin transactions

| Method | Parameters | Client-side conversion |
|---|---|---|
| `sign_update_leverage(market_index, fraction, margin_mode, …)` | `fraction: uint16` raw IMF | none |
| `update_leverage(market_index, margin_mode, leverage, …)` | **note the parameter order differs** | `imf = int(10000 / leverage)` (§3.6) |
| `sign_update_margin(market_index, usdc_amount:int, direction, …)` | micro-USDC | none |
| `update_margin(market_index, usdc_amount:human, direction, …)` | USDC | `× 1e6` |
| `sign_update_account_config / update_account_config(account_trading_mode, …)` | `0` Simple, `1` UTA | none |
| `sign_update_account_asset_config / update_account_asset_config(asset_index:int16, asset_margin_mode, …)` | | none |
| `sign_create_sub_account / create_sub_account(…)` | no business params | none |

### 2.4 Value movement

| Method | Parameters | Conversion |
|---|---|---|
| `sign_withdraw(asset_index, route_type, amount:int, …)` | int in asset units | none |
| `withdraw(asset_id, route_type, amount:human, …)` | | `× ASSET_SCALE[asset_id]`; throws on unknown asset |
| `sign_transfer(eth_private_key, to_account_index, asset_id, route_from, route_to, usdc_amount:int, fee:int, memo, …)` | | attaches L1 sig |
| `sign_transfer_same_master_account(…same minus eth key…)` | | no L1 sig |
| `transfer(eth_private_key, to_account_index, asset_id, route_from, route_to, amount:human, fee:int, memo, …)` | | `× ASSET_SCALE` |
| `transfer_same_master_account(…)` | | `× ASSET_SCALE` |

`memo` is **exactly 32 bytes**, accepted in three forms: 64 hex chars, 66 chars with `0x` prefix, or a
32-character raw ASCII string. Anything else is an error. The memo is inside both the L2 hash and the L1
signature body — for fast withdrawals it encodes the destination L1 address (20 address bytes followed by
12 zero bytes), which is how the recipient is authenticated.

`fee` is a micro-USDC integer obtained from `GET /api/v1/transferFeeInfo` and passed through unchanged.
Transfers between sub-accounts of the same master are free for all assets.

Route semantics: USDC may move `perp↔spot` in any combination, including self-transfers
(`to_account_index == own index`) used to shuffle funds between one's own perp and spot balances.
Non-USDC spot assets require `route_from == route_to == SPOT`.

### 2.5 Public pools, staking, shares

| Method | Parameters | Units |
|---|---|---|
| `create_public_pool(operator_fee, initial_total_shares, min_operator_share_rate, …)` | `operator_fee/1e6` (100000 = 10%); shares (1_000_000 = 1000 USDC); rate `/1e4` (100 = 1%) |
| `update_public_pool(public_pool_index, status, operator_fee, min_operator_share_rate, …)` | `status` 0=active 1=frozen; **operator fee may only decrease** |
| `mint_shares(public_pool_index, share_amount, …)` | deposit |
| `burn_shares(public_pool_index, share_amount, …)` | withdraw |
| `stake_assets(staking_pool_index, share_amount, …)` | LIT staking |
| `unstake_assets(staking_pool_index, share_amount, …)` | |

After `create_public_pool`, the new pool's account index is **not** in the send response — it is read out
of the transaction receipt: poll `GET /api/v1/tx?by=hash&value=<txHash>` and read field `a` of the JSON
in `event_info`. The reference retries once per second up to 10 times.

### 2.6 Integrator approval

`approve_integrator(integrator_account_index, max_perps_taker_fee, max_perps_maker_fee,
max_spot_taker_fee, max_spot_maker_fee, approval_expiry, skip_nonce=0, nonce=-1, api_key_index=255,
eth_private_key=None)`.

* Fees are `/1e6` (1000 = 0.1%), each bounded by `FeeTick`; the per-venue caps are in
  `GET /api/v1/systemConfig` (`max_integrator_perps_taker_fee`, …).
* `approval_expiry` is a millisecond epoch; `0` **revokes** the approval.
* The L1 signature is **required only when the integrator is a third party charging non-zero fees**.
  It is *not* required when (a) all four fee caps are `0` (zero-fee approval or revocation) or
  (b) the integrator account is under the same master account (there is a dedicated
  `sign_approve_integrator_same_master_account` for this).
* Unlike other txs, the reference validates the Schnorr signature locally before returning (also done for
  ChangePubKey).

### 2.7 Key management and auth

| Method | Parameters | Returns |
|---|---|---|
| `sign_change_api_key / change_api_key(eth_private_key, new_pubkey, …)` | `new_pubkey` = 40-byte hex | requires L1 signature; see §7 |
| `create_auth_token_with_expiry(deadline = -1, *, timestamp = None, api_key_index = 255)` | `deadline` seconds; `-1`→600 s | `(token, error)` |
| `check_client()` | — | compares each local pubkey to `GET /api/v1/apikeys` |

### 2.8 Raw submission

| Method | Request | Response |
|---|---|---|
| `send_tx(tx_type, tx_info)` | `POST /api/v1/sendTx` | `RespSendTx` |
| `send_tx_batch(tx_types[], tx_infos[])` | `POST /api/v1/sendTxBatch` | `RespSendTxBatch` |

Guards in the reference: `tx_info` must start with `{` (a string-sniff used as an error channel — replace
with a typed error); batch arrays must be non-empty and equal length.

---

## 3. Client-side arithmetic (exact, normative)

All of these are computations the SDK performs *for* the user. Getting the rounding direction wrong loses
money. Every formula below is stated over integers/rationals; the TypeScript implementation must use
`BigInt` throughout and **must never** route a monetary quantity through IEEE-754 `number`.

### 3.1 Human decimal → protocol integer

Given a decimal quantity `q` (as a string such as `"1.234567"`) and decimal exponent `d`:

```
scaled(q, d)  =  numerator(q) × 10^(d − exponent(q))       when d ≥ exponent(q)
              =  numerator(q) / 10^(exponent(q) − d)       otherwise, with an explicit rounding mode
```

where `q = numerator × 10^-exponent` is obtained by lexical parsing (split on `.`, no floating point).
When the value is not exactly representable at `d` decimals the caller's `RoundingMode` decides:
`EXACT` (default for explicit prices — throws), `FLOOR`, `CEIL`, `HALF_EVEN`, or the semantic aliases
`CONSERVATIVE` / `AGGRESSIVE` (§3.2).

> **Reference defect — must not be reproduced.** The Python SDK computes `int(amount * 1e6)` and
> `int(amount * ASSET_SCALE)` using binary floating point followed by truncation-toward-zero. For a value
> such as `1.234567` USDC or `0.4` ETH the product may land one ULP below the true value and truncate to
> `1234566` / one satoshi short. It is a silent, systematic, always-downward error on every transfer,
> withdrawal, margin update and quote-sized market order. The TypeScript SDK parses decimal strings
> exactly.

### 3.2 Rounding direction semantics

| Field | Buy (`is_ask = 0`) | Sell (`is_ask = 1`) | Rationale |
|---|---|---|---|
| Limit price | `FLOOR` | `CEIL` | never pay more / never accept less than asked |
| Market-order price bound | `FLOOR` | `CEIL` | tighten the slippage cap rather than loosen it |
| Base size | `FLOOR` | `FLOOR` | never trade more than the user asked for |
| Quote amount | `FLOOR` | `FLOOR` | never spend more |
| Fee/margin amounts | `CEIL` when paying, `FLOOR` when receiving | | |

`CONSERVATIVE` is the alias for the table above; `AGGRESSIVE` inverts price rounding (better fill
probability, marginally worse price). Default is `CONSERVATIVE`.

### 3.3 Best price from the book

`bestPrice(marketId, isAsk)` fetches `GET /api/v1/orderBookOrders?market_id=…&limit=1` and takes
`bids[0].price` when **selling** (`isAsk = 1`) and `asks[0].price` when **buying**. The result is the
integer price at the market's price scale.

> **Reference defect.** The reference converts the price string to an integer by *deleting the decimal
> point* (`"4050.00" → 405000`). This is only correct when the server's string happens to carry exactly
> `supported_price_decimals` fractional digits. A response of `"4050"` or `"4050.0"` yields `4050` or
> `40500` — a 100× or 10× price error. The TypeScript SDK parses with the market's known
> `supported_price_decimals` (§3.1) and rejects strings whose scale disagrees.

### 3.4 Book walk — potential execution price

`potentialExecutionPrice(book, amount, isAsk, amountIsBase)` walks the **opposing** side of the book —
`bids` when `isAsk = 1`, `asks` when `isAsk = 0` — in book order (best first), maintaining
`matchedQuote` and `matchedBase` as exact rationals:

```
for each level (priceInt, remainingBaseInt):
    if amountIsBase and matchedBase  == amount: stop
    if !amountIsBase and matchedQuote == amount: stop
    capacity = amountIsBase ? (amount − matchedBase)
                            : (amount − matchedQuote) / priceInt      # exact rational
    take        = min(capacity, remainingBaseInt)
    matchedQuote += priceInt × take
    matchedBase  += take

avgPrice = matchedQuote / matchedBase                                 # exact rational
filled   = amountIsBase ? matchedBase : matchedQuote
return (avgPrice, filled)
```

The reference uses depth `100` for the fetch. `filled < amount` means the visible book cannot absorb the
order at any price — that is a distinct condition from "too much slippage" and must be reported
separately (`INSUFFICIENT_DEPTH`).

**Edge cases the reference gets wrong and TS must handle:** an empty book (division by zero), a book that
is thinner than requested but where the loop still exits normally, and levels whose `remaining_base_amount`
string is decimal-point-stripped (same defect as §3.3).

Implement this as a **pure function over a book snapshot**, not as a method that fetches. The same
function then serves both the REST path and a WS-maintained book.

### 3.5 Slippage bound (market-order price cap)

Given `idealPrice` (integer, from §3.3) and a maximum slippage fraction `s`:

```
acceptablePrice = idealPrice × (1 + s × (isAsk ? −1 : +1))
```

Exact integer form with `s = num/den` (`s` supplied as a decimal string or basis points, never a float):

```
buy  : acceptablePrice = floor( idealPrice × (den + num) / den )     # CONSERVATIVE
sell : acceptablePrice = ceil ( idealPrice × (den − num) / den )     # CONSERVATIVE
```

`AGGRESSIVE` swaps `floor`↔`ceil`. The reference applies Python's `round()`, i.e. **banker's rounding**
(half-to-even), which is neither conservative nor aggressive and is a surprising default for money.

The clamped price must satisfy `1 ≤ acceptablePrice ≤ 2^32 − 1`; a sell whose bound rounds to `0` must
error rather than emit `NilOrderPrice`.

### 3.6 Quote amount → base amount

`create_market_order_quote_amount(marketId, clientOrderIndex, quoteAmount, maxSlippage, isAsk, …)`:

1. `quoteInt = scaled(quoteAmount, supported_quote_decimals)` (the reference hard-codes `1e6`).
2. Fetch the book to depth 100; `idealPrice = bestPrice(...)` unless the caller supplied one.
3. `acceptablePrice` per §3.5.
4. `(avgPrice, filledQuote) = potentialExecutionPrice(book, quoteInt, isAsk, amountIsBase=false)`.
5. **Reject** with `EXCESSIVE_SLIPPAGE` if `isAsk && avgPrice < acceptablePrice` or
   `!isAsk && avgPrice > acceptablePrice`.
6. **Reject** with `INSUFFICIENT_DEPTH` if `filledQuote < quoteInt`.
7. `baseInt = floor(quoteInt / avgPrice)` (exact rational division, then floor — the reference's `int()`
   truncates toward zero which coincides for positive values).
8. Submit `create_order(baseAmount = baseInt, price = acceptablePrice, type = MARKET, tif = IOC,
   orderExpiry = 0)`.

**Cross-scale invariant.** Step 7 is only dimensionally correct because
`priceInt × baseInt` is denominated in `10^-supported_quote_decimals` quote units, i.e.

```
supported_price_decimals + supported_size_decimals == supported_quote_decimals
```

(e.g. ETH-PERP: price 2 dp + size 4 dp = 6 dp = micro-USDC; `405000 × 1000 = 405_000_000` micro-USDC =
$405 = 0.1 ETH × $4050). The TypeScript SDK must **assert this invariant** when it loads market metadata
and refuse to compute quote-sized orders for any market where it does not hold, rather than silently
emitting an order off by a power of ten.

Additionally, `baseInt` must be checked against the market's `min_base_amount` and the resulting notional
against `min_quote_amount` / `order_quote_limit` before signing.

### 3.7 Slippage-gated variants

* `create_market_order_limited_slippage` — no book walk. Computes `acceptablePrice` from the best price
  and submits a MARKET/IOC order capped at that price. The order simply fills less if the book is thin.
* `create_market_order_if_slippage` — walks the book for the given `baseAmount`; rejects with
  `EXCESSIVE_SLIPPAGE` if the achievable average is worse than the bound, and with `INSUFFICIENT_DEPTH`
  if `filledBase < baseAmount`; otherwise submits capped at `acceptablePrice`. Note the reference applies
  the rounding *after* the comparison here but *before* it in the quote-amount variant — an inconsistency
  worth eliminating by always comparing against the rounded bound.

### 3.8 Leverage ↔ initial margin fraction

```
initialMarginFraction (imf)  ∈ [1, 10_000],  MarginFractionTick = 10_000
leverage = 10_000 / imf
```

The reference computes `imf = int(10_000 / leverage)` — truncation toward zero. For `leverage = 3` this
gives `imf = 3333`, i.e. an effective **3.0003×** — slightly *more* leverage than requested. For
`leverage = 7`, `imf = 1428` → 7.003×.

**TypeScript behaviour:** `imf = ceil(10_000 / leverage)` so the account never ends up more levered than
requested, and the result is clamped into `[market.min_initial_margin_fraction, 10_000]` with an error if
the requested leverage exceeds the market maximum. Both `{ leverage }` and `{ initialMarginFraction }`
are accepted (exactly one of them), and the effective leverage actually applied is returned to the caller
so the deviation is never invisible. Document the deviation from the reference explicitly.

### 3.9 Margin / collateral amounts

`update_margin(marketId, usdcAmount, direction)` scales `usdcAmount` by `1e6`; `direction` is
`ADD_COLLATERAL = 1` / `REMOVE_COLLATERAL = 0`. Only meaningful for an **open isolated-margin position**.
The raw `sign_update_margin` takes micro-USDC directly — another unit split the TS SDK collapses (§9).

### 3.10 Expiries and timestamps

* `expiredAt` (tx-level deadline): `now_ms + 599_000` when unset. Range `[0, 2^48 − 1]`.
* `orderExpiry`: `-1` → `now_ms + 2_419_200_000`; `0` → nil. When non-nil it must lie within
  `[now + 5 min, now + 30 days]` server-side.
* Cancel-all `SCHEDULED`: `timestamp_ms` must be within `[now + 5 min, now + 15 days]`; `IMMEDIATE` and
  `ABORT` require `timestamp_ms == 0`.
* Auth token deadline: unix **seconds**, `deadline = expirySeconds + timestamp` where `timestamp`
  defaults to `now`. Maximum accepted lifetime is 8 hours.
* All clock reads go through an injectable `now()` so tests are deterministic and Workers can use a
  synced clock.

---

## 4. Nonce management

### 4.1 Model

A nonce is scoped to `(accountIndex, apiKeyIndex)` and must be strictly increasing and gapless per key
unless `skipNonce` is set. `GET /api/v1/nextNonce?account_index=…&api_key_index=…` returns
`{code, message?, nonce}` — the value the sequencer expects **next**.

Because throughput on a single key is bounded by nonce ordering, the SDK spreads load across the
configured API keys. This is the core reason for multi-key support.

### 4.2 Strategies

**Optimistic (default).** Keeps a local counter per key.
* Lazy init: on first use of a key, `counter[k] = serverNextNonce(k) − 1`.
* Allocate: `counter[k] += 1; return counter[k]` — so the first allocated nonce equals the server's
  expected nonce.
* On failure: `counter[k] -= 1` (return the slot to the pool).
* On an "invalid nonce" error: hard resync — `counter[k] = serverNextNonce(k) − 1`.

**Server (a.k.a. API).** Every allocation re-queries `nextNonce` and uses the returned value verbatim.
Correct but adds a round trip per tx, and the same key must not be reused faster than the sequencer can
advance — the reference documents "wait at least 350 ms before reusing the same api key", and notes that
`predicted_execution_time_ms` from the send response gives a tighter bound.

**Manual / none.** Refuses to allocate; the caller supplies both `nonce` and `apiKeyIndex`. Used with
`skipNonce`.

### 4.3 Allocation and dispatch protocol (reproduce exactly)

The reference wraps every async transaction method in a decorator with this logic:

1. Read the effective `apiKeyIndex` (default `255`) and `nonce` (default `-1`) from the call.
2. **If `NOT (apiKeyIndex == 255 AND nonce == -1)`** → *caller-managed mode*: invoke the signer directly
   with the given values; the nonce manager is not consulted, no counters move. A `BadRequest` is caught
   and converted into `(null, null, message)`.
3. **Else** → *managed mode*:
   a. `apiKeyIndex = pool.rotate()` — selected **outside** any lock so concurrent calls fan out across keys.
   b. Acquire the per-key mutex.
   c. `nonce = await allocate(apiKeyIndex)`.
   d. Sign + submit **while still holding the mutex**, so transactions on the same key reach the sequencer
      in nonce order.
   e. If the send returned no response with an error, or a response whose `code != 200`, call
      `acknowledgeFailure(apiKeyIndex)` (optimistic: decrement).
   f. If a `BadRequest` was raised: when the message contains `"invalid nonce"` do a hard resync,
      otherwise `acknowledgeFailure`. Return `(null, null, message)`.

`rotate()` is round-robin: `current = (current + 1) mod keyCount`, returning `keys[current]`. With a
single key it is the identity. Note the pre-increment: the very first rotation returns `keys[1]`, not
`keys[0]`, when more than one key is configured — harmless but worth matching only if we care about
identical key-usage traces (we do not; TS should start at `keys[0]`).

The counter is a plain integer under an async mutex — safe only because the mutex is held across the
network round trip. This serialises per-key throughput at one transaction per RTT.

### 4.4 Explicit sequencing across calls

Callers who need `create → modify → cancel` to arrive in that order pin the key:

```
(key, nonce) = pool.next()          # rotates, picks a key
create(..., nonce, key)
(key, nonce) = pool.next(key)       # SAME key, next nonce
modify(..., nonce, key)
(key, nonce) = pool.next(key)
cancel(..., nonce, key)
```

`pool.next(key)` advances the counter for that specific key without rotating. This pattern is also
mandatory for batches (§5.3) — all transactions in a batch must share one API key with consecutive nonces.

### 4.5 Skip-nonce mode

`skipNonce = 1` sets L2 attribute type `4` to value `1`. It tells the sequencer that this transaction's
nonce need not be the immediately-next one: the client claims a specific slot out of order. Example usage
from the reference: base nonce `22` with an interval of `3` → transactions signed with nonces `22`, `25`,
`28`, all with `skipNonce = 1`, dispatched independently.

Because the attribute participates in the transaction hash, a skip-nonce transaction and an otherwise
identical non-skip transaction have **different hashes and different signatures**. Combine `skipNonce`
with the manual nonce strategy.

### 4.6 TypeScript design

```ts
interface NonceSource {
  lease(preferKey?: number): Promise<NonceLease>;   // rotates unless preferKey given
  resync(apiKeyIndex: number): Promise<void>;
}
interface NonceLease {
  readonly apiKeyIndex: number;
  readonly nonce: bigint;
  commit(): void;        // tx accepted
  rollback(): void;      // tx rejected — return the slot
  release(): void;       // always, via try/finally or `using`
}
```

* `OptimisticNonceSource`, `ServerNonceSource`, `ManualNonceSource` implement it.
* The lease **owns the per-key mutex** and releases it on `release()`; `Symbol.dispose` makes
  `using lease = await nonces.lease()` correct-by-construction.
* An opt-in `pipelined: true` mode allocates N leases up front, sends concurrently, and marks skipped
  slots by setting `skipNonce` on each transaction — trading strict ordering for throughput. This is the
  one correct use of `skipNonce` in an automated client.
* Nonce state is per-`(account, key)` and lives in the client instance, never in a module-level global.
  On Cloudflare Workers, where an isolate may be recycled between requests, the SDK exposes
  `nonces.snapshot()` / `NonceSource.restore(snapshot)` so state can be parked in Durable Object storage;
  the default behaviour on a cold isolate is a lazy `nextNonce` fetch, which is always safe.
* Failure classification is explicit: `INVALID_NONCE` → resync; every other 4xx → rollback; network
  timeout → **do not roll back** (the transaction may still land). The reference conflates the last two,
  which can cause a nonce collision after a timeout.

---

## 5. Transaction lifecycle

### 5.1 Pipeline

```
  request (typed, protocol integers)
       │
       ├─▶ resolve options ──► accountIndex, apiKeyIndex, expiredAt, nonce, attributes
       │
       ├─▶ build          ──► TxInfo struct (per-type field set)
       │
       ├─▶ validate       ──► range + semantic rules (§5.4); throws before any I/O
       │
       ├─▶ hash           ──► Poseidon2 over Goldilocks elements, chainId + txType first;
       │                      attributes folded in (§5.5); → 40-byte little-endian digest
       │
       ├─▶ sign           ──► Schnorr(ecgFp5) with the api private key → 80-byte signature
       │                      (optionally verified locally — the reference does this for
       │                       ChangePubKey and ApproveIntegrator)
       │
       ├─▶ [L1 sign]      ──► for ChangePubKey / cross-owner Transfer / fee-bearing
       │                      ApproveIntegrator: EIP-191 personal_sign over a templated
       │                      message; result stored in the `L1Sig` field (§7)
       │
       ├─▶ serialize      ──► JSON string; `txHash` = hex of the digest, retained locally
       │
       └─▶ submit         ──► HTTP or WS (§5.2) ──► confirm (§5.6)
```

The digest computed locally is *the* transaction hash: if the server derived a different one the
signature would not verify, so a successful submission always echoes the same `tx_hash`. This is a free
end-to-end integrity check and the SDK must assert it.

### 5.2 Submission formats

**HTTP single** — `POST /api/v1/sendTx`, `Content-Type: application/x-www-form-urlencoded`:

| field | value |
|---|---|
| `tx_type` | decimal string of the uint8 type code |
| `tx_info` | the serialized transaction JSON, as a string |
| `price_protection` | optional |

Response `RespSendTx`:
```
{ code: int, message?: string, tx_hash: string,
  predicted_execution_time_ms: int, volume_quota_remaining: int }
```

**HTTP batch** — `POST /api/v1/sendTxBatch`, same content type:

| field | value |
|---|---|
| `tx_types` | JSON array of ints, **encoded as a string** (e.g. `"[14,15]"`) |
| `tx_infos` | JSON array of tx_info **strings**, encoded as a string |

Response `RespSendTxBatch`: identical to `RespSendTx` except `tx_hash` is a `string[]`.

**WebSocket single** — send on the `/stream` connection:
```json
{ "type": "jsonapi/sendtx",
  "data": { "id": "<client correlation id, optional>",
            "tx_type": 14,
            "tx_info": { …parsed transaction object… } } }
```

**WebSocket batch**:
```json
{ "type": "jsonapi/sendtxbatch",
  "data": { "id": "<optional>",
            "tx_types": "[14,15]",
            "tx_infos":  "[\"{…}\",\"{…}\"]" } }
```

Note the asymmetry, which is protocol-mandated and must be reproduced exactly: the single-tx WS form
nests `tx_info` as a **parsed object**, while the batch form passes **JSON-encoded strings** for both
fields — matching the HTTP form encoding.

`code == 200` means accepted-for-sequencing, not executed. Any other code, or a non-2xx HTTP status,
carries a `message` that the reference reduces to its last line before returning.

### 5.3 Batching rules

* All transactions in a batch share one `apiKeyIndex` and carry consecutive nonces.
* Arrays must be non-empty and of equal length.
* The batch executes back-to-back with no interleaving of other transactions.
* Practical uses in the reference: place a two-sided quote atomically; cancel-and-replace as one unit.

### 5.4 Validation performed before signing

The client validates locally so a malformed transaction never consumes a nonce. Rules the TS SDK must
enforce (from the reference validators):

*Common:* `accountIndex ∈ [−1, 2^48−2]`, `apiKeyIndex ∈ [0, 254]`, `nonce ≥ 0`,
`expiredAt ∈ [0, 2^48−1]`, at most `4` attributes.

*Attributes:* fees require an integrator index to be present; self-trade modes may **not** be combined
with non-zero integrator fees; `SelfTradeBehavior.REDUCE` may **not** be combined with
`SelfTradeEquality.MASTER_ACCOUNT_INDEX`; `cancelAllMarketIndex` may only be non-nil for an
**immediate** cancel-all.

*CreateOrder:* market index must be a valid perp (`0…254`) or spot (`2048…4094`) index;
`clientOrderIndex` either nil or in `[1, 2^48−1]`; `baseAmount` nil only when `reduceOnly = 1`;
`price ∈ [1, 2^32−1]`; `isAsk ∈ {0,1}`; `reduceOnly` forbidden on spot; and per order type —

| Type | timeInForce | orderExpiry | triggerPrice |
|---|---|---|---|
| MARKET | must be IOC | must be nil | must be nil |
| LIMIT | any | nil iff IOC, non-nil otherwise | must be nil |
| STOP_LOSS / TAKE_PROFIT | must be IOC | non-nil | non-nil; perps only |
| STOP_LOSS_LIMIT / TAKE_PROFIT_LIMIT | any | non-nil | non-nil; perps only |
| TWAP | must be GTT | non-nil | must be nil |

*ModifyOrder:* index may be a client order index or an exchange order index; `baseAmount` may be nil
(unchanged/whole position); price/trigger ranges as above.

*CancelAllOrders:* `IMMEDIATE` ⇒ `time == 0`; `SCHEDULED` ⇒ `time ∈ [1, 2^63−1]` (and server-side within
5 min…15 days); `ABORT` ⇒ `time == 0`.

*CreateGroupedOrders:* 1–3 orders; **all** orders share the first order's market index, which must be a
**perp** market; client order indexes unique within the group; then per grouping type —

| Grouping | Count | Constraints |
|---|---|---|
| `ONE_CANCELS_THE_OTHER` | 2 | equal base amounts; same direction; both reduce-only; identical (non-nil) expiries; one is an SL family order and one a TP family order |
| `ONE_TRIGGERS_THE_OTHER` | 2 | child base amount must be nil; opposite directions; if the parent expiry is non-nil it must equal the child's; parent must be MARKET or LIMIT; child must be SL/TP family |
| `ONE_TRIGGERS_A_ONE_CANCELS_THE_OTHER` | 3 | both children have nil base amount; both children opposite in direction to the parent; children share an expiry; if the parent expiry is non-nil it equals the children's; parent MARKET/LIMIT; children are one SL + one TP |

*ChangePubKey:* the public key must be exactly 40 bytes.

### 5.5 L2 tx attributes

Attributes are an optional sparse map `type → value`, at most `NbAttributesPerTx = 4` entries:

| Type | Name | Bytes | Range | Nil |
|---|---|---|---|---|
| 1 | integratorAccountIndex | 6 | `0 … 2^48−2` | `0` |
| 2 | integratorTakerFee | 4 | `0 … 1_000_000` | `0` |
| 3 | integratorMakerFee | 4 | `0 … 1_000_000` | `0` |
| 4 | skipTxNonce | 1 | `1` | `0` |
| 5 | cancelAllMarketIndex | 2 | `0 … 255` | `255` |
| 6 | selfTradeBehaviorMode | 1 | `0 … 3` | `0` |
| 7 | selfTradeEqualityMode | 1 | `0 … 1` | `0` |

A value equal to its nil value is *not* an attribute — the entry is omitted. When the resulting map is
empty, the transaction hash is the base hash unchanged; otherwise the attribute types (non-nil,
ascending, zero-padded to 4 slots) and their values are hashed as `[type₀,value₀,…,type₃,value₃]` and the
result is folded into the base hash. Details in the codec spec; what matters here is that **setting an
attribute changes the signature**, so `skipNonce` / integrator fees / self-trade modes are not "free"
metadata.

### 5.6 Confirmation

`tx_hash` from the response (or the locally computed digest, which is identical) is polled with
`GET /api/v1/tx?by=hash&value=<hash>`. The response carries `event_info` (a JSON string) from which
transaction-specific results are read — e.g. the new pool's account index after `CreatePublicPool`.

`predicted_execution_time_ms` in the send response is the sequencer's estimate; it is the right input for
adaptive polling intervals and for pacing reuse of the same API key.

---

## 6. Multi-key and multi-account

The reference registers one signer context per `(accountIndex, apiKeyIndex)` in a **process-global map**
with a "most recently created wins" default pointer, and the shared library additionally stores `chainId`
in a package-level variable overwritten by every `CreateClient` call. Consequences: two clients on
different chains in one process corrupt each other, and the default-client lookup is order-dependent.
**The TypeScript SDK has no module-level mutable state.** Everything hangs off an explicitly constructed
client object; N clients for N accounts/chains coexist without interference.

Model:

* `LighterClient` — endpoint, chainId, transports, market registry, read-only APIs. No keys.
* `LighterAccount` — one `accountIndex` plus a `Map<apiKeyIndex, ApiKeySigner>`, a `NonceSource`, and the
  full transaction surface. Created from a client: `client.account({ accountIndex, keys })`.
* A single L1 address may own several accounts (`GET /api/v1/accountsByL1Address` returns `sub_accounts`);
  the **master** account is the one with the smallest index. Registering keys for a public pool is the
  same flow with the pool's account index.

`check_client()` equivalent: for each configured key, fetch `GET /api/v1/apikeys?account_index=…`
(returns `api_keys: [{account_index, api_key_index, nonce, public_key, transaction_time}]`) and compare
`public_key` against the locally derived public key, `0x`-insensitively. The reference caches the whole
account's key set, and on mismatch **invalidates and refetches once** before declaring failure — because
a key rotation may have just landed. It also proactively invalidates the cache whenever a ChangePubKey is
*signed*. Reproduce both behaviours.

---

## 7. API key registration (ChangePubKey) and L1 signatures

### 7.1 Flow

1. Generate a new API keypair locally (pure computation, no I/O).
2. Construct a `LighterAccount` **with the new private key** at the target `apiKeyIndex`.
3. Build a ChangePubKey transaction carrying the new 40-byte public key, and sign it with **that same new
   key** (the key authorises its own registration at the L2 layer).
4. Obtain the L1 authorisation: the SDK produces a **message to sign**, the L1 owner signs it with the
   Ethereum key that owns the account, and the 65-byte signature is attached to the transaction as
   `L1Sig` before submission.
5. Submit; wait ~5–10 s for the sequencer; then verify with the `apikeys` check.

The reference performs step 4 by exposing `messageToSign` from the signer, signing it with
`eth_account`, injecting `L1Sig` into the parsed tx JSON, and re-serialising.

### 7.2 Message templates (byte-exact; `\n` are real newlines)

A helper renders every numeric field as **`0x` + 16 lowercase hex digits, left zero-padded**
(e.g. nonce `42` → `0x000000000000002a`).

**ChangePubKey**
```
Register Lighter Account

pubkey: 0x{pubKeyHex40Bytes}
nonce: {hex16(nonce)}
account index: {hex16(accountIndex)}
api key index: {hex16(apiKeyIndex)}
Only sign this message for a trusted client!
```

**Transfer** (arguments in this exact order)
```
Transfer

nonce: {hex16(nonce)}
from: {hex16(fromAccountIndex)} (route {hex16(fromRouteType)})
api key: {hex16(apiKeyIndex)}
to: {hex16(toAccountIndex)} (route {hex16(toRouteType)})
asset: {hex16(assetIndex)}
amount: {hex16(amount)}
fee: {hex16(usdcFee)}
chainId: {hex16(chainId)}
memo: {memoHex64NoPrefix}
Only sign this message for a trusted client!
```

**ApproveIntegrator**
```
Approve Integrator

nonce: {hex16(nonce)}
account index: {hex16(accountIndex)}
api key index: {hex16(apiKeyIndex)}
integrator account index: {hex16(integratorAccountIndex)}
max perps taker fee: {hex16(maxPerpsTakerFee)}
max perps maker fee: {hex16(maxPerpsMakerFee)}
max spot taker fee: {hex16(maxSpotTakerFee)}
max spot maker fee: {hex16(maxSpotMakerFee)}
approval expiry: {hex16(approvalExpiry)}
chainId: {hex16(chainId)}
Only sign this message for a trusted client!
```

(There is also a `Create Lighter Sub Account` template with a single `master account index:` field, used
by the web front-end rather than the SDK.)

### 7.3 The signature itself

EIP-191 "personal sign": `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`, signed
with secp256k1 ECDSA; serialised as `0x` + `r(32) || s(32) || v(1)` with `v ∈ {27, 28}`. Verification
recovers the address (normalising `v ≥ 27` down to `{0,1}`) and compares it to the account's `l1_address`.

### 7.4 TypeScript design: pluggable L1 signer, zero required dependencies

Requiring an Ethereum library for a flow that 95 % of users (traders) never touch is wrong. Therefore:

```ts
interface L1Signer {
  getAddress(): Promise<`0x${string}`>;
  signMessage(message: string): Promise<`0x${string}`>;   // EIP-191 personal_sign
}
```

* Any wallet works: viem/ethers accounts, `window.ethereum`, a KMS/HSM, a hardware wallet, a remote
  signing service. The core package never imports any of them.
* A **built-in** implementation ships behind the `./l1` subpath export: pure-TypeScript `keccak256` and
  secp256k1 (BigInt modular arithmetic, RFC-6979 deterministic `k`), constructed as
  `privateKeyL1Signer(hexKey)`. Tree-shaking keeps it out of trading-only bundles, and the constraint of
  zero runtime npm dependencies is preserved.
* Methods that may require L1 authorisation take an optional `l1Signer`. If omitted **and** the flow
  requires it, the SDK throws `L1SignatureRequiredError` carrying `{ message, template }` so an
  application can route the message to a wallet and resume via
  `account.submitWithL1Signature(prepared, signature)`.
* `approveIntegrator` and `transfer` auto-detect whether L1 is required (zero fees / revocation / same
  master account ⇒ not required) and say so on the prepared transaction.

### 7.5 Read-only auth tokens

`createAuthToken({ expirySeconds = 600, timestamp = now, apiKeyIndex })` produces:

```
message   = "{deadlineUnixSeconds}:{accountIndex}:{apiKeyIndex}"      (deadline = timestamp + expiry)
digest    = Poseidon2(field elements decoded from the UTF-8 bytes of message)  → little-endian bytes
signature = Schnorr(digest, apiPrivateKey)                            → lowercase hex, no 0x
token     = "{message}:{signature}"
```

The token is passed as the `Authorization` header or as an `auth` query/form parameter, depending on the
endpoint. Maximum server-accepted lifetime is 8 hours; the reference shared library defaults an
unspecified deadline to `now + 7 h`, while the Python client defaults to `now + 10 min`.

**Pre-generation workflow** (the `read-only-auth` example set): dedicate API key index `253` to read-only
access; generate one token per 6-hour boundary (`floor(now / 21600) × 21600`) with an 8-hour lifetime, so
consecutive tokens overlap by 2 hours; store them keyed by `accountIndex → timestamp → token`; at runtime
look up the token for the current aligned boundary. Rotating key 253 invalidates every pre-generated
token at once. The TS SDK should ship this as a first-class helper (`generateAuthTokenSchedule`) because
it is the only way to do read-only access without holding a private key at runtime — exactly the
Cloudflare-Workers-friendly pattern.

Separately, the REST API has **server-side API tokens** (a different mechanism):
`POST /api/v1/tokens/create` (`name`, `account_index`, `expiry`, `sub_account_access`, `scopes`),
`GET /api/v1/tokens?account_index=…`, `POST /api/v1/tokens/revoke` (`token_id`, `account_index`).
Also account-scoped maker-only restrictions: `POST /api/v1/setMakerOnlyApiKeys`
(`account_index`, `api_key_indexes` as a JSON-array string, `auth`) — indexes must be ≥ 4, may be cleared
with `[]`, and the endpoint is rate-limited to **once per hour** — and `GET /api/v1/getMakerOnlyApiKeys`.

---

## 8. Configuration and market metadata bootstrapping

### 8.1 What must be known before trading correctly

| Datum | Source | Needed for |
|---|---|---|
| `market_id`, `symbol`, `market_type` | `/api/v1/orderBooks`, `/api/v1/orderBookDetails` | symbol → id resolution |
| `supported_price_decimals`, `supported_size_decimals`, `supported_quote_decimals` | orderBookDetails | every human↔integer conversion (§3.1) and the cross-scale invariant (§3.6) |
| `min_base_amount`, `min_quote_amount`, `order_quote_limit` | orderBookDetails | pre-flight rejection |
| `taker_fee`, `maker_fee`, `is_taker_fee_enabled`, `is_maker_fee_enabled`, `liquidation_fee` | orderBookDetails | cost estimation |
| `status`, `market_config.{market_margin_mode, force_reduce_only, trading_hours, hidden, rfq_enabled, liquidation_mode, insurance_fund_account_index}` | orderBookDetails | tradability checks |
| `default_initial_margin_fraction`, `min_initial_margin_fraction`, `maintenance_margin_fraction`, `closeout_margin_fraction`, `quote_multiplier` | orderBookDetails (perps) | leverage clamping (§3.8), risk |
| `last_trade_price`, `open_interest`, daily stats | orderBookDetails | sizing helpers |
| `base_asset_id`, `quote_asset_id` | orderBookDetails (spot) | spot inventory tracking |
| asset `decimals`, `min_transfer_amount`, `min_withdrawal_amount`, `price_decimals`, `margin_mode` | `/api/v1/assetDetails` | transfer/withdraw scaling (§1.7) |
| `liquidity_pool_index`, `staking_pool_index`, `funding_fee_rebate_account_index`, cooldown/lockup periods, `max_integrator_*_fee`, `market_maker_incentive_account_index` | `/api/v1/systemConfig` | pools, staking, integrator caps |
| account `index`, `account_trading_mode`, `l1_address`, positions, assets, `available_balance`, `collateral` | `/api/v1/account`, `/api/v1/accountsByL1Address` | account selection, risk |
| transfer fee | `/api/v1/transferFeeInfo` (auth) | transfers |
| fast-withdraw pool | `/api/v1/fastwithdraw/info` (auth) → `to_account_index`, `withdraw_limit`, `max_withdrawal_amount` | fast withdrawals |

### 8.2 Caching strategy

* Market and asset metadata is **quasi-static**. Fetch once, cache in the client, refresh on an explicit
  call or a configurable TTL (default 5 minutes, refreshed in the background, never blocking an order).
* Provide `MarketRegistry.fromSnapshot(json)` / `registry.toSnapshot()` so a Cloudflare Worker can embed a
  build-time snapshot and boot with **zero** metadata round trips, then optionally revalidate out of band.
  This is the single most important cold-start optimisation for the target runtime.
* API-key public keys are cached per account with explicit invalidation (§6).
* Nothing else is cached. Order books, balances and nonces are never served stale.
* A market lookup that misses the registry throws `UnknownMarketError` rather than falling back to a
  guessed scale — there is no safe default for decimals.

---

## 9. Recommended TypeScript design

### 9.1 Layering

```
  ┌──────────────────────────────────────────────────────────────────┐
  │ L6  facade      market handles, human units, batch builder,      │  "./"
  │                 order lifecycle helpers                          │
  ├──────────────────────────────────────────────────────────────────┤
  │ L5  client      LighterClient (read) / LighterAccount (write)    │  "./"
  ├──────────────────────────────────────────────────────────────────┤
  │ L4  nonce       NonceSource, KeyPool, leases                     │  "./nonce"
  ├──────────────────────────────────────────────────────────────────┤
  │ L3  transport   HttpTransport (fetch), WsTransport (WebSocket),  │  "./transport", "./ws"
  │                 RestClient, retry/backoff, error mapping         │
  ├──────────────────────────────────────────────────────────────────┤
  │ L2  signer      ApiKeySigner (Schnorr), L1Signer interface,      │  "./signer", "./l1"
  │                 built-in secp256k1+keccak personal_sign          │
  ├──────────────────────────────────────────────────────────────────┤
  │ L1  codec       build / validate / hash / serialize per tx type  │  "./codec"
  ├──────────────────────────────────────────────────────────────────┤
  │ L0  primitives  Goldilocks, gFp5, Poseidon2, ecgFp5 (internal)   │
  └──────────────────────────────────────────────────────────────────┘
```

Rules:
* **L0–L2 are synchronous and pure.** Signing performs no I/O and no clock reads except through the
  injected `now()`. This makes offline signing, hardware-signer delegation, and golden-vector tests trivial.
* **L3 is the only layer that touches the network.** It is defined by two small interfaces
  (`Fetcher`, `WebSocketFactory`) so Bun / Node / Deno / Workers / browsers all work unmodified, and so
  tests inject fakes.
* **L4 is the only layer with mutable state** besides caches.
* Every layer is independently importable via the exports map; `sideEffects: false`.

### 9.2 Construction: synchronous, no I/O

```ts
// Synchronous. No network, no promises, safe at module scope in a Worker.
const lighter = new LighterClient({
  endpoint: 'mainnet',                       // or { apiUrl, wsUrl, chainId }
  markets: MarketRegistry.fromSnapshot(SNAP),// optional, avoids cold-start fetch
  fetch: globalThis.fetch,                   // optional override
  WebSocket: globalThis.WebSocket,           // optional override
  now: () => Date.now(),                     // optional, for tests
  defaultTxExpiryMs: 599_000,
  retry: { attempts: 3, baseDelayMs: 50 },
});

const account = lighter.account({
  accountIndex: 65n,
  keys: { 3: '0x…', 4: '0x…', 5: '0x…' },    // apiKeyIndex → private key
  nonces: 'optimistic',                      // 'optimistic' | 'server' | 'manual'
});
```

Anything requiring the network is an explicit `await`:
```ts
await lighter.markets.load();      // idempotent; no-op if a snapshot was injected and fresh
await account.verifyKeys();        // the check_client equivalent
```
A convenience `await LighterClient.connect(config)` does both and is the one-liner for scripts.

**Rejected alternative:** async factory-only construction (`await LighterClient.create()`). It forces
every consumer into an async boundary and is hostile to Workers' module-scope initialisation.

### 9.3 Two tiers, cleanly separated

This is the central ergonomic decision, and it is where both reference SDKs fail: they mix raw and human
units within one namespace, so `update_leverage` takes a leverage while `sign_update_leverage` takes a
margin fraction, and `update_margin` takes float USDC while `sign_update_margin` takes micro-USDC —
identical-looking calls with 10⁶× different meanings.

**Raw tier** — `account.tx.*`. Every numeric field is a `bigint` in protocol units. 1:1 with the wire
format. No conversion, no rounding, no metadata required, no surprises.

```ts
const signed = account.tx.createOrder({
  marketIndex: 0, clientOrderIndex: 123n, baseAmount: 1000n, price: 405000n,
  isAsk: true, orderType: OrderType.Limit, timeInForce: TimeInForce.GoodTillTime,
});                                    // synchronous, returns { txType, txInfo, txHash, sign() }
const receipt = await account.send(signed);
```

**Human tier** — `account.market(id | symbol).*`. Accepts decimal strings, converts using the cached
market decimals under an explicit rounding policy, and **returns the exact integers it used** so the
conversion is never invisible.

```ts
const eth = account.market('ETH');                    // or account.market(0)

await eth.buy({ size: '0.1', maxSlippage: '0.5%' });   // market IOC, bound computed per §3.5
await eth.sell({ notional: '700 USDC', maxSlippage: '10bps' });   // quote-sized, §3.6
await eth.limit({ side: 'buy', size: '0.1', price: '4050.25',
                  timeInForce: 'GTT', clientOrderId: 123n });
await eth.modify({ orderId: 123n, size: '0.11', price: '4100' });
await eth.cancel(123n);
await eth.cancelAll();                                 // this market only
await account.cancelAllMarkets();
await eth.setLeverage({ leverage: 20, marginMode: 'cross' });   // → { imf: 500, effectiveLeverage: 20 }
await eth.addMargin('10.5');
await eth.removeMargin('5');
await eth.bracket({ entry: { side: 'sell', size: '0.1', type: 'IOC', price: '2500' },
                    takeProfit: { trigger: '1500', limit: '1550' },
                    stopLoss:   { trigger: '5000', limit: '5050' } });  // → OTOCO group
```

Every human-tier call returns `{ ...receipt, applied: { baseAmount, price, triggerPrice, … } }`.
A `dryRun: true` option returns the fully built + signed transaction without submitting.

### 9.4 Errors: typed, never tuples

Replace `(tx, response, errString)` with exceptions from a discriminated hierarchy, plus `try*` variants
for callers who prefer results:

```
LighterError
├── LighterConfigError          bad endpoint/chainId/keys, unknown market
├── LighterValidationError      local pre-flight failure; carries { field, rule, value }
├── LighterMathError            EXCESSIVE_SLIPPAGE, INSUFFICIENT_DEPTH, NOT_REPRESENTABLE
├── LighterSignatureError       local Schnorr verify failed, L1SignatureRequiredError
├── LighterNonceError           INVALID_NONCE, lease exhausted
├── LighterTransportError       network/timeout/abort; carries `retryable`
└── LighterApiError             server rejection; carries { code, message, httpStatus, txHash? }
```

`const r = await eth.tryBuy({...})` → `{ ok: true, value } | { ok: false, error }`.
Every async method accepts `{ signal?: AbortSignal, timeoutMs?: number }`.

### 9.5 Batching with a type-enforced key lease

```ts
await account.batch(async (b) => {
  b.add(b.tx.createOrder({ … }));   // b.tx allocates consecutive nonces on ONE leased key
  b.add(b.tx.cancelOrder({ … }));
});                                  // submits once; lease released in finally
```
The batch context owns the lease, so "all transactions share one API key with consecutive nonces" is
structurally guaranteed rather than documented.

### 9.6 Submission channel is a policy, not an API split

The reference forces the user to pick a *different method* for WS vs HTTP (`create_order` vs
`sign_create_order` + manual WS framing). Instead:

```ts
const account = lighter.account({ …, submit: 'http' });   // default
account.via('ws').market('ETH').buy({ size: '0.1' });     // same surface, WS transport
```
`account.prepare(...)` returns the signed transaction for callers who want to route it themselves.

### 9.7 Receipts and confirmation

```ts
interface TxReceipt {
  txHash: `0x${string}`; txType: number; txInfo: string;
  nonce: bigint; apiKeyIndex: number;
  predictedExecutionTimeMs: number; volumeQuotaRemaining: bigint;
  wait(opts?): Promise<TxResult>;      // polls /api/v1/tx, backing off from predictedExecutionTimeMs
}
```
`wait()` also surfaces the decoded `event_info`, which is how `createPublicPool().wait()` can return the
new pool's account index directly instead of making users poll and parse JSON by hand.

### 9.8 Pure order math, exposed

`potentialExecutionPrice`, `slippageBound`, `quoteToBase`, `leverageToImf`, `scaleDecimal` are exported as
pure functions over a `BookSnapshot`. They work against a REST snapshot or a WS-maintained book, are
trivially unit-testable with golden vectors, and let users implement their own execution logic without
re-deriving the arithmetic.

### 9.9 Runtime portability checklist

* `globalThis.fetch`, `globalThis.WebSocket`, `BigInt`, `TextEncoder` only. No `Buffer`, no `node:crypto`,
  no `process`, no dynamic `require`.
* Randomness for key generation via `crypto.getRandomValues`. Deterministic signing (RFC-6979-style) so
  no entropy is required at signing time — important on Workers.
* No top-level await, no module-level mutable state, no timers left running after `close()`.
* `Symbol.asyncDispose` on client/account so `await using` cleans up sockets.
* Every hot path allocation-conscious: signing must not be the bottleneck at market-making rates.

---

## 10. Acceptance surface — inventory of reference example scripts

Every script below must have a TypeScript equivalent (as a runnable example and, where deterministic, as
a test). Grouped by capability.

### A. Setup & bootstrap
| Script | What it does |
|---|---|
| `utils.py` | shared harness: load `api_key_config.json`, build client + WS, ping/subscribe/send-tx helpers |
| `system_setup.py` | resolve account from an L1 address, generate N API keys, register each via ChangePubKey with an L1 signature, verify, persist config |
| `get_info.py` | smoke-test the read-only API surface (account, apikeys, candles, fundings, order books, trades, funding rates) |
| `spot_get_order_books.py` | enumerate order books + asset details; print decimals, asset ids — the metadata a trader needs |

### B. Market orders
| Script | What it does |
|---|---|
| `create_market_order_eth_buy.py` | market buy 0.1 ETH with an explicit worst-price bound |
| `create_market_order_eth_sell.py` | market sell, same shape |
| `create_market_order_max_slippage.py` | `create_market_order_if_slippage` — reject if the book walk exceeds 1 % |
| `create_market_order_quote_amount.py` | set 7× leverage, then buy a $700 notional with 0.1 % max slippage |
| `create_market_order_async_client.py` | construct the client inside a coroutine (proves no I/O in the constructor) |
| `create_order_skip_nonce.py` | market order with an explicit nonce and `skip_nonce=1` |

### C. Order lifecycle
| Script | What it does |
|---|---|
| `create_modify_cancel_order_http.py` | create → modify → cancel, pinning one API key so nonces stay ordered |
| `create_modify_cancel_order_ws.py` | same flow, transactions framed and sent over WebSocket |
| `create_modify_cancel_skip_nonce.py` | same flow with the no-op nonce manager and manually spaced nonces (22/25/28) |
| `cancel_all_orders_single_market.py` | immediate cancel-all scoped to one market, then across all markets |
| `create_with_multiple_keys.py` | 20 orders fanned across the configured key pool, then a global cancel-all |

### D. Grouped / conditional orders
| Script | What it does |
|---|---|
| `create_grouped_ioc_with_attached_sl_tp.py` | OTOCO: IOC entry plus attached TP-limit and SL-limit children |
| `create_grouped_ioc_with_integrator.py` | the same OTOCO carrying integrator account + maker/taker fees |
| `create_grouped_orders_cliend_order_index.py` | OTOCO with explicit unique client order indexes per leg |
| `create_position_tied_sl_tp.py` | OCO of two reduce-only children with nil base amount — covers the whole position and tracks it |

### E. Self-trade prevention
| Script | What it does |
|---|---|
| `self_trade_create_modify_order.py` | rest a post-only bid, then cross it with EXPIRE_BOTH + MASTER_ACCOUNT equality |
| `self_trade_grouped_orders.py` | group-level self-trade behaviour/equality on an OTOCO |

### F. Batching
| Script | What it does |
|---|---|
| `send_batch_tx_http.py` | three successive 2-tx batches (two-sided quote, cancel+replace, double cancel) over HTTP |
| `send_batch_tx_ws.py` | the identical sequence over WebSocket |

### G. Leverage & isolated margin
| Script | What it does |
|---|---|
| `margin_eth_20x_cross_http.py` | 20× cross on ETH via the human-unit path |
| `margin_eth_50x_isolate_ws.py` | 50× isolated by signing with a raw margin fraction and sending over WS |
| `margin_eth_add_collateral_http.py` | add $10.5 collateral to an isolated ETH position |
| `margin_eth_remove_collateral_ws.py` | remove $5 collateral, raw micro-USDC, over WS |

### H. Account configuration / UTA / margin assets
| Script | What it does |
|---|---|
| `enable_uta.py` / `disable_uta.py` | set account trading mode 1 / 0 |
| `enable_eth_as_margin.py` / `disable_eth_as_margin.py` | toggle ETH as margin collateral |
| `add_eth_margin.py` | full sequence: enable UTA, enable ETH as margin, self-transfer ETH spot→perp, poll until the account state reflects it |

### I. Transfers & withdrawals
| Script | What it does |
|---|---|
| `transfer.py` | cross-owner USDC transfer with an L1 signature and a fee from `transferFeeInfo` |
| `transfer_same_master_account.py` | same-master transfer, no L1 signature |
| `sub_account_create.py` | create a sub-account |
| `sub_account_transfer_eth.py` | move ETH spot→spot to a sub-account (fee 0) |
| `sub_account_transfer_usdc.py` | move USDC perp→spot to a sub-account |
| `spot_self_transfer_perp_spot.py` | self-transfer USDC perp→spot, then change leverage |
| `spot_self_transfer_spot_perp.py` | the reverse direction |
| `withdraw_normal.py` | L2 withdraw of USDC/ETH (no fee, no limit) |
| `withdraw_fast.py` | auth token → fast-withdraw pool info → transfer fee → memo = 20-byte L1 address + 12 zero bytes → signed transfer → `POST /api/v1/fastwithdraw` with `tx_info` + `to_address` |

### J. Public pools & staking
| Script | What it does |
|---|---|
| `public_pool_create_modify.py` | create a pool (10 % operator fee, 1000 USDC of shares, 1 % min operator share), poll the tx receipt for the new account index, then lower the fee |
| `public_pool_deposit.py` | mint shares into a pool |
| `public_pool_withdraw.py` | burn shares |
| `public_pool_info.py` | enumerate the account's pool shares, compute share price, value and PnL |
| `stake_and_unstake.py` | stake then unstake LIT shares |

### K. Integrator
| Script | What it does |
|---|---|
| `integrator/approve.py` | approve a third-party integrator with fee caps and a 90-day expiry (L1 signature required) |
| `integrator/approve_same_master_account.py` | approve a same-master integrator (no L1 signature) |
| `integrator/approve_zero_fees.py` | zero-fee approval (no L1 signature) |
| `integrator/revoke.py` | revoke by approving with zero fees and expiry 0 |
| `integrator/create_market_order.py` | market order carrying integrator index + maker/taker fees |
| `integrator/create_modify_order.py` | create → modify (halving the integrator fees) → cancel |

### L. Auth & access control
| Script | What it does |
|---|---|
| `read-only-auth/setup.py` | register API key 253 on every account of an L1 address and emit a config file |
| `read-only-auth/generate.py` | pre-generate 4 tokens/day for N days at 6-hour boundaries with 8-hour lifetimes |
| `read-only-auth/get_auth_token.py` | look up the token for the current 6-hour boundary |
| `get_set_maker_only_api_keys.py` | set/read/clear the maker-only API key index list (≥ 4, once per hour) |

### M. Spot data
| Script | What it does |
|---|---|
| `spot_get_account_assets_http.py` | perp totals (total / available / cross / isolated) and per-asset spot balances |
| `spot_get_account_assets_ws.py` | the same via `account_all_assets/{index}` with an auth token, handling ping/pong |

### N. Streaming
| Script | What it does |
|---|---|
| `ws.py` | synchronous WS client subscribing to `order_book/{id}` and `account_all/{id}` with incremental book merging |
| `ws_async.py` | the async variant of the same |

### O. Paper trading (simulation, no keys)
| Script | What it does |
|---|---|
| `paper_trading_snapshot.py` | simulate fills against a one-time book snapshot; report fills, fees, collateral, trade log |
| `paper_trading_live.py` | simulate against a live WS-maintained book |
| `paper_trading_health.py` | two cross-margin scenarios across ETH + BTC; report account value, initial/maintenance margin, margin usage, leverage, per-market liquidation prices |

The paper-trading client is a separate simulation surface layered on the same order math (§9.8) and the
same market metadata; it is a good forcing function for keeping that math pure and reusable.

---

## 11. Defects in the reference SDKs — do not reproduce

| # | Defect | Impact | Fix |
|---|---|---|---|
| 1 | `int(amount * 1e6)` float scaling in `withdraw`, `transfer`, `update_margin`, quote-sized orders | silent systematic under-transfer, loses dust on every call | exact decimal-string → BigInt (§3.1) |
| 2 | `int(price_string.replace(".", ""))` | 10×/100× price error whenever the server's decimal count differs from the market's | parse with `supported_price_decimals` (§3.3) |
| 3 | `int(10_000 / leverage)` floors, and is never clamped | more leverage than requested; can exceed the market's minimum IMF | `ceil`, clamp, return effective leverage (§3.8) |
| 4 | Banker's rounding on the slippage bound | surprising, neither safe nor aggressive | explicit rounding modes (§3.2, §3.5) |
| 5 | chainId inferred by URL substring matching | signs for the wrong chain behind a proxy or vanity domain | named profile or explicit chainId (§1.2) |
| 6 | `update_leverage(market, marginMode, leverage)` vs `sign_update_leverage(market, fraction, marginMode)` — different order **and** unit; same for `update_margin` | trivially confusable, 10⁴/10⁶× errors | one raw tier + one human tier (§9.3) |
| 7 | Process-global signer registry, "last created wins" default, package-global `chainId` in the shared library | two clients in one process corrupt each other | no module-level mutable state (§6) |
| 8 | Errors returned as `(None, None, str)` with only the last line of the message retained | untyped, unactionable, loses server codes | typed error hierarchy (§9.4) |
| 9 | `send_tx` raises if `tx_info[0] != "{"` | string-sniffing used as an error channel | typed prepared-transaction objects |
| 10 | Book walk divides by zero on an empty book | crash instead of a domain error | `INSUFFICIENT_DEPTH` / `NO_LIQUIDITY` (§3.4) |
| 11 | `SignerClient.create_api_key` declared `@staticmethod` yet takes `self` | uncallable | plain function |
| 12 | `stake_and_unstake.py` passes `public_pool_index=` to a method whose parameter is `staking_pool_index` | the example does not run | correct naming, compiler-enforced |
| 13 | Hard-coded asset → decimals table; unknown asset raises | breaks on every new listing | prefer `assetDetails`, seed table as fallback (§1.7) |
| 14 | Quote-sized orders assume `price_dec + size_dec == 6` without checking | wrong-magnitude order on a market that violates it | assert the invariant at metadata load (§3.6) |
| 15 | Nonce rollback on network timeout | the tx may still land ⇒ nonce collision | classify timeouts separately (§4.6) |
| 16 | Blocking HTTP inside an async library for the sync nonce path | event-loop stalls | single async path |
| 17 | The signer ships as a per-platform compiled `.so`/`.dylib`/`.dll` loaded by ctypes; the nonce fallback path inside it does its own blocking HTTP | no Workers/Deno/browser support, opaque, unauditable | pure TypeScript, no I/O in the signer (§9.1) |

---

## 12. Test and acceptance criteria for this dimension

1. **Golden vectors.** For each transaction type: fixed inputs (chainId, account, key, nonce, expiredAt,
   attributes) → expected tx hash, expected signature, expected serialized JSON. Generated once from the
   reference implementation's *outputs* (not its source) and frozen.
2. **Arithmetic property tests.** `scaleDecimal` round-trips; slippage bounds are monotone in `s` and
   never cross the mid; `quoteToBase` never produces a notional above the requested quote;
   `leverageToImf` never yields more leverage than requested.
3. **Nonce concurrency tests.** 100 concurrent orders over 5 keys produce 100 distinct
   `(key, nonce)` pairs with no gaps per key; an injected failure rolls back exactly one slot; an injected
   "invalid nonce" triggers exactly one resync; an injected timeout does **not** roll back.
4. **Lifecycle tests against a fake transport.** Assert exact request shapes for `sendTx` /
   `sendTxBatch` over both HTTP and WS, including the object-vs-string asymmetry of §5.2.
5. **Validation tests.** Every rule in §5.4 has a rejecting case; grouped-order combinations are
   exhaustively enumerated for all three grouping types.
6. **Runtime matrix.** The full example suite runs unmodified under Bun 1.3, Node 20/22, Deno, and
   `workerd`; a browser build imports without touching any Node built-in.
7. **Example parity.** Each of the ~63 scripts in §10 has a TypeScript counterpart; the parity table is
   checked into the repository and CI fails when a row is missing.
8. **Bundle budget.** The trading-only entry point (no `./l1`) stays under a fixed byte budget with zero
   runtime dependencies; `./l1` is proven absent from the trading bundle by a tree-shaking test.

---

## 13. Open questions

1. **`supported_quote_decimals` vs the `price_dec + size_dec == 6` invariant** — is the invariant
   guaranteed by the exchange for every market (including spot pairs with a non-USDC quote), or only
   incidental for current listings? Needs confirmation before quote-sized orders are enabled generally.
2. **`price_protection`** on `sendTx` — accepted values and semantics are undocumented in the reference;
   nothing sets it.
3. **Auth token maximum lifetime** — the read-only documentation says 8 hours, the Python client defaults
   to 10 minutes, the shared library defaults to 7 hours. Which bound does the server actually enforce?
4. **`skipNonce` slot semantics** — how far ahead of the expected nonce may a claimed slot be, and are
   skipped slots reclaimable or permanently burned? This determines whether pipelined mode is safe.
5. **Same-master detection for transfers** — the reference relies on the caller choosing between
   `transfer` and `transfer_same_master_account`. Can the SDK derive it from account indexes alone
   (shared master prefix) or must it consult `accountsByL1Address`?
6. **Batch atomicity** — are batched transactions all-or-nothing, or merely contiguous? The response
   returns one hash per transaction, implying independent acceptance.
7. **`cancel_all_market_index` for spot** — the attribute range covers `0…255` (perp indexes only). Is
   scoping a cancel-all to a spot market supported at all?
8. **TWAP orders (type 6)** — validated by the codec but never exercised by any example or convenience
   wrapper. What additional parameters (duration, slice count) does the sequencer expect?
9. **`volume_quota_remaining`** — units and the consequence of exhaustion (throttling? rejection?).
10. **Robinhood profiles** — do they expose the same endpoint set and market universe, or a restricted
    subset that changes the bootstrap requirements?
