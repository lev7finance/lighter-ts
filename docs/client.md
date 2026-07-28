# `lighter-ts/client`

The stateful layer: one client per endpoint, one account per signing identity, market and asset
metadata, nonce leasing, order math, and a decimal trading tier over the raw codec.

```ts
import { LighterClient } from "lighter-ts/client";

const lighter = await LighterClient.connect({ endpoint: "mainnet" });
const account = lighter.account({ accountIndex: 12345n, keys: { 0: API_KEY_PRIVATE_KEY } });
```

Both constructors perform **no I/O**: no fetch, no timer, no `crypto.getRandomValues`. A client and
an account can both be built at module scope in a Worker's global phase and reused per request; the
nonce source fetches its first counter lazily, on the first transaction. `LighterClient.connect()` is
`new LighterClient(...)` plus `await markets.load()`, for scripts.

There is no module-level mutable state anywhere. N clients for N accounts or chains coexist without
interference — which the reference's process-global signer registry and package-global chain id make
impossible.

---

## Two numeric tiers

This is the single most common way to lose money with an exchange SDK, so the two tiers are kept
visibly apart and never blended.

| | `account.tx.*` | `marketHandle(...).*` |
| --- | --- | --- |
| takes | `bigint`, width-branded | decimal **strings** |
| units | protocol units, 1:1 with the wire | human units for the market |
| conversion | none | cached market decimals, explicit rounding policy |
| synchronous | yes — build, then sign and send | no, it may need the book |
| reports | what you passed | the exact integers it used, on every call |

### The raw tier

Twenty builders on `account.tx`, one per transaction type. They take protocol integers and nothing
else, and the widths are branded so a bare `number` cannot land where an `int64` belongs:

```ts
import { i16, i64, OrderTimeInForce, OrderType, u32, u8 } from "lighter-ts/tx";

const tx = account.tx.createOrder({
  marketIndex: i16(0),
  clientOrderIndex: i64(1n),
  baseAmount: i64(100_000n),      // base units at the market's size precision
  price: u32(250_000),            // price ticks at the market's price precision
  isAsk: u8(0),
  orderType: u8(OrderType.Limit),
  timeInForce: u8(OrderTimeInForce.GoodTillTime),
  reduceOnly: u8(0),
  triggerPrice: u32(0),
  orderExpiry: i64(BigInt(Date.now() + 86_400_000)),
});
```

`i16()`, `u8()`, `u32()`, `i64()` and `u64()` check **width** and nothing else. Every domain rule —
that an account index is at most `2^48 − 2`, that a market index is in the perps or spot family, that
`255` is a valid API key index for `L2CancelAllOrders` and nothing else — belongs to the
per-transaction validators, which run inside the builder. `NilApiKeyIndex = 255`,
`NilMarketIndex = 255` and `NilStrategyIndex = 8` all sit inside their widths, so no width check can
distinguish them from ordinary values and none tries.

### The decimal tier

```ts
import { marketHandle, restBookSource } from "lighter-ts/client";

const eth = marketHandle(
  {
    chainId: lighter.chainId,
    account,
    markets: lighter.markets,
    books: restBookSource(lighter.rest),
  },
  "ETH",
);

const receipt = await eth.buy({ size: "0.10", maxSlippage: "0.5%" });
console.log(receipt.applied.baseAmount, receipt.applied.price);   // the exact integers signed
```

Everything monetary is a decimal string: `size`, `notional`, `price`, `trigger`, `maxSlippage`
(`"0.005"`, `"0.5%"` and `"50bps"` are the same exact rational). Conversion uses the market's cached
`supported_size_decimals`, `supported_price_decimals` and `supported_quote_decimals`, and the whole
computation is integer or rational — no float touches a price.

**Every human-tier method reports `applied`**: the exact `baseAmount`, `price`, `triggerPrice` and
`orderExpiry` integers it derived and signed. A conversion the caller cannot see is a conversion they
cannot audit, and all four of the reference's arithmetic hazards are invisible at the call site.
`{ dryRun: true }` returns the signed transaction without sending it.

The surface: `buy`, `sell`, `limit`, `postOnly`, `modify`, `cancel`, `cancelAll`, `takeProfit`,
`stopLoss`, `bracket` (OTOCO), `positionBracket` (OCO), `oto`, `setLeverage`, `addMargin`,
`removeMargin`.

### `number` is for timestamps and counts only

Not for money, not for sizes, not for prices, and not for leverage. `setLeverage` takes a leverage
input and converts it to an integer margin fraction; it does not take a fractional `number`.
`mapCandle` returns decimal strings for OHLC and volumes.

The reference's four arithmetic hazards, each now a regression test:

1. **Python's `round()` is banker's rounding; `Math.round` is half-up.** `round(2500.5)` is `2500` in
   Python and `2501` in JavaScript. They agree on odd halves and disagree on even ones, so the
   mistranslation survives casual testing. Nothing here rounds to nearest.
2. **`int(quote_amount * 1e6)` loses money.** `8.2 * 1e6` is `8199999.999999999`, truncated to
   `8199999`. A user asking to spend 8.2 USDC gets an order for 8.199999.
3. **`int(price.replace(".", ""))` is correct only by accident** — it works because the API pads to
   the market's decimals. `"2500.1"` would become `25001`, off by 100×.
4. **Return types diverge by branch** in the reference: an exact `Fraction` when sizing by quote
   amount, a lossy `float` when sizing by base amount.

---

## Rounding direction, per side

The normative rule: **rounding never loosens slippage protection.**

`rounding: "exact"` is the default everywhere and simply refuses a price the market cannot represent
— usually that means the wrong market rather than a rounding question. `rounding: "conservative"`
rounds the way that cannot cost the caller money:

| side | the price is | conservative rounds |
| --- | --- | --- |
| **buy** | a maximum — the most they will pay | **down** |
| **sell** | a minimum — the least they will accept | **up** |

For a market order's slippage bound, the same invariant, as exact integer arithmetic over
`s = num/den`:

```
buy  (isAsk = false):  acceptable = floor( ideal × (den + num) / den )
sell (isAsk = true ):  acceptable = ceil ( ideal × (den − num) / den )
```

There is deliberately no way to ask for the opposite direction on a price a human typed. The
market-order bound does offer `mode: "aggressive"`, which swaps the two directions to trade a
marginally worse price for fill probability at the boundary tick; it is never the default and it is
at most one tick from the exact bound.

The invariant is implemented by `roundingFor` in `src/client/math/slippage.ts` and
`priceRoundingMode` in `src/client/brackets.ts`. A seeded property-test corpus asserts that the
conservative bound is never more permissive than the exact rational bound on either side.

`checkDepth` (default `false`) chooses between two market-order semantics. `false` matches the
reference's `create_market_order_limited_slippage`: the cap is computed from the best price and a
thin book simply fills less. `true` walks the book and refuses the order with `EXCESSIVE_SLIPPAGE` or
`INSUFFICIENT_DEPTH` if the achievable average is worse than the bound. A `notional` order always
walks the book, because the base size cannot be computed without it.

Quote sizing is dimensionally correct only when `priceDecimals + sizeDecimals === quoteDecimals`.
`MarketInfo.quoteSizingSupported` records whether it holds, and the math layer refuses a
quote-sized order on a market where it does not, rather than emitting one off by a power of ten.

---

## Nonces

A nonce is per `(account, apiKey)`. Three strategies:

| `nonces` | behaviour |
| --- | --- |
| `"optimistic"` | fetch once, then count locally; resync only when told to |
| `"server"` | ask `GET /api/v1/nextNonce`, paced |
| `"manual"` | you supply them |

Take a slot with `lease()`, which resolves once the key's mutex is held, and hold it across signing
*and* submission. `account.send(unsignedTx)` does that for you and is the ordinary path.
`account.prepare()` **spends** the nonce: you now hold a signed transaction carrying it, and the SDK
cannot know whether you will send it.

### The rule the reference gets wrong

```
accepted      -> commit()                  the slot is consumed
rejected      -> rollback()                the slot returns to the pool
invalid-nonce -> resync(key), NO rollback  our counter is wrong in an unknown direction
indeterminate -> nothing at all            the transaction may already be in flight
```

**A network timeout is `indeterminate`, and a timeout must not roll back.** The request may have been
written before the socket died; the transaction may still land. Rolling back after a timeout hands
the same nonce out twice, and the second transaction is rejected as a duplicate — or worse, the first
one lands later and both are valid. When in doubt, do nothing.

`account.send()` applies the table for you. The classifier reads either a thrown value or a parsed
response body, because the two failure channels are independent: a `sendTx` can fail by rejecting
*or* by resolving with a non-200 `code`.

| input | outcome |
| --- | --- |
| `LighterTimeoutError`, `LighterTransportError`, anything named `AbortError`/`TimeoutError` | `indeterminate` |
| a `LighterError` of kind `ws` | `indeterminate` — the frame may already be on the wire |
| `LighterApiError` with a listed invalid-nonce code | `invalid-nonce` |
| any other `LighterApiError` | `rejected` — the server made a decision |
| `LighterBlockedError` | `rejected` — the CDN answered; the origin never saw it |
| local validation / math / signature / config errors | `rejected` — nothing was sent |
| anything unrecognised | `indeterminate` |

The list of API codes read as `invalid-nonce` is **empty, deliberately**. No capture has produced a
numeric code for "your nonce is not the one I expected", and the one thing that must not happen is
matching on message text — `message` carries trailing whitespace and is not stable. An invented code
that happened to match some *other* failure would turn ordinary rejections into resyncs, which is
strictly worse than never resyncing.

The consequence today: an `invalid nonce` from the server is classified as a plain `rejected` and the
slot rolls back rather than triggering a hard resync. The resync path exists and is wired to the
`invalid-nonce` outcome; only the code that selects it is unknown. The classifier factory
(`createOutcomeClassifier`) lives in `src/client/nonce/types.ts` but is **not currently part of the
published export surface**, so there is no supported way to supply the code from outside the package
yet. If you observe one, please report it.

`rollback()` is not a plain decrement. It decrements only when the lease still holds the highest
issued nonce for its key; rolling back a middle slot would hand a live nonce out twice, so any other
case forces a resync on that key's next use instead.

Always `release()`, via `finally` or `using`. `resync()` does not take the key's mutex, so it is safe
to call while holding a lease on the same key.

```ts
const src = account.nonces;
using lease = await src.lease();          // Symbol.dispose where the runtime has it
// sign with exactly lease.apiKeyIndex and lease.nonce
```

Pipelined (out-of-order) allocation is opt-in. A pipelined lease sets `skipNonce`, and the
transaction must then carry L2 attribute type `4` set to `1`.

`snapshot()` / `restore()` round-trip the whole state as JSON — for a Durable Object that hibernates,
or a Worker that wants to hand state to its successor. The snapshot is stamped with the account
index and checked on restore, because a nonce is meaningless, and dangerous, outside its
`(account, key)` pair.

---

## Submission and receipts

```ts
const receipt = await account.send(tx, { timeoutMs: 15_000 });
const result = await receipt.wait();
```

`send` builds, validates, hashes, signs, submits and classifies. `sendBatch` submits several as one
request: one API key, consecutive nonces, no interleaving — unsigned transactions get their nonces
from a single run of leases on one key, and already-signed ones are checked for that property and
refused if they do not have it.

`TxReceipt` carries `txHash`, `txType`, the exact `txInfo` document that went on the wire, the
`nonce` and `apiKeyIndex` it was signed with, `predictedExecutionTimeMs`, and
`volumeQuotaRemaining` as a `bigint` (it is an `int64`).

`receipt.wait()` polls `GET /api/v1/tx?by=hash`, seeding the first delay from
`predictedExecutionTimeMs` and doubling up to a 5 s cap. "Not found" is not a failure — it is the
expected answer before execution — so it polls through; any other API error propagates immediately.
**A `LighterTimeoutError` from `wait()` says nothing about the transaction's fate.** It may still
land.

`account.via(channel)` returns the same account over a different transport. It shares the nonce
source, the keys and the transports **by reference** — a view, not a copy — precisely so two views
can never allocate the same nonce.

Choose the transport with `submit: 'http'` or `'ws'` on the account, or `channel` per call. On
Cloudflare Workers outside a Durable Object, prefer HTTP: a socket cannot be held across requests, so
`'ws'` means one socket per submission. See [ws.md](ws.md#cloudflare-workers).

---

## Markets and assets

`lighter.markets` is a `MarketRegistry`. It is loaded on demand and never by the constructor.

```ts
lighter.markets.get("ETH");                       // by symbol
lighter.markets.get(0);                           // by index
lighter.markets.get({ symbol: "ETH", type: "perp" });
lighter.markets.list({ type: "perp" });
```

A bare symbol listed on both the perp and the spot book is ambiguous and throws; the object form or
the market id disambiguates. `tryGet` returns `undefined` instead of throwing.

`MarketRegistry.fromSnapshot(SNAP)` lets a Worker boot with **zero** metadata round trips, and the
client attaches its own transport to whatever registry it is given, so a snapshot-seeded registry can
still revalidate later. `toSnapshot()` produces the snapshot.

Market metadata is cached; **account state is not**. `account.state()` hits `GET /api/v1/account`
every time. Balances, positions and available collateral are the three things that must never be
served stale: a cached collateral figure is how an SDK talks a caller into an order that liquidates
them.

Every monetary field on `MarketInfo` is a decimal string verbatim from the wire, and `createdAt` is
epoch milliseconds *held in a string* — it looks like a number field and is not.

---

## Leverage

`setLeverage` takes a leverage input and converts it to an initial margin fraction with
`imf = ceil(10_000 / leverage)`, so the account is never *more* levered than the number the caller
typed. The reference floors, which turns leverage 3 into an effective 3.0003×. The deviation is
returned exactly, as a rational, on `LeverageApplied.effectiveLeverage`, along with `clamped`.

Exceeding the market's maximum throws `LighterValidationError` with code `IMF_TOO_LOW`, and the
message names the market's own limit.

---

## Auth tokens for authenticated reads

```ts
import { createAuthToken, generateAuthTokenSchedule } from "lighter-ts/client";
```

The token is `"<deadline>:<accountIndex>:<apiKeyIndex>:" + hex(schnorrSign(hash))`, where the hash is
`hashToQuinticExtension` over the UTF-8 message packed 8 bytes per element. `generateAuthTokenSchedule`
mirrors the reference's 6-hour-aligned boundaries with an 8-hour expiry, so validity windows overlap
and a lookup by the current aligned timestamp always finds a live token. `lookupToken` does that
lookup.

`READ_ONLY_API_KEY_INDEX` is the slot conventionally used for read-only tokens.

---

## Lifecycle

`close()` on the client is idempotent and never rejects: it closes the socket if one was ever built,
detaches the transaction dispatcher, and stops the registry's refresh timer. **Nothing is left
scheduled** — a Durable Object cannot hibernate with a live timer, and a Node process will not exit
with one.

`account.close()` exists for symmetry and for `await using`. It does **not** close the client's
socket: two accounts on one client would otherwise close each other's transport.

Both carry `Symbol.asyncDispose` where the runtime supports it.
