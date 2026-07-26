# 08 — Paper-Trading Engine, Residual Subsystems, and the TypeScript Project/DX Skeleton

Functional specification for `lev7finance/lighter-ts`. Clean-room: this document describes **what the
system must do** — numeric domains, formulas, state machines, wire shapes, endpoint contracts, and
project conventions. It contains no reference source code.

Scope of this dimension:

- **Part A** — the paper-trading simulation engine, plus every Python-SDK surface not claimed by
  specs 01–07 (`ApiResponse` conventions, `WSAccountAssets`, referral, RFQ, lease/LIT, staking,
  announcements, notifications, tokenlist, API tokens, account tier, maker-only keys).
- **Part B** — the TypeScript project skeleton: package metadata, tsconfig, build, test, lint,
  CI, repository layout, and documentation.

Companion specs own: `01` crypto core, `02` tx/codec, `03` transport + REST, `04` WS, `05` high-level
client/signer, `06` models, `07` nonce/endpoints. Where this spec references those, it states the
**contract** it needs, not the implementation.

---

# PART A — Paper-Trading Engine

## A0. What the paper client is, and what it is not

The paper client is a **local, deterministic, read-only trade simulator**. It pulls real order-book
state from Lighter (one-shot REST snapshot, or a live WebSocket subscription), maintains a virtual
USDC-collateralised cross-margin account, and simulates taker fills against that book. Nothing is
ever signed and nothing is ever submitted. It is the strategy-development and backtest-harness
surface of the SDK.

Constraints inherited from the reference implementation, which we keep for behavioural parity:

| Constraint | Value |
|---|---|
| Markets | Perpetuals only. Market ids `>= 2048` are spot and MUST be rejected. |
| Order types | Taker only: `MARKET` and `IOC`. No resting limit orders, no post-only, no stop/TP. |
| Margin mode | Cross margin only. Isolated margin is not simulated. |
| Book impact | Fills do **not** consume book liquidity (see A4.4). |
| Funding | Not applied by the reference. We add it as an **opt-in** extension (A10). |
| Liquidation | Executes at mark price with zero fee (see A8.3). |
| Persistence | None. State lives in the engine object for its lifetime. |

Everything the reference does that is a defect is called out inline under **DEFECT** with the
TypeScript remedy. Remedies that change numeric output are **opt-in behind a flag** so that the
default configuration remains bit-compatible with the reference and with our conformance vectors.

## A1. Numeric domain

All paper-engine arithmetic is IEEE-754 binary64 (`number` in TypeScript, `float` in the reference).
Prices and sizes arrive from the wire as **decimal strings** and are converted to `number` exactly
once, at the order-book boundary.

Rules:

1. **Do not** "upgrade" the paper engine to `BigInt` or fixed-point decimals. The reference is
   float64 and conformance vectors are generated from it; changing the numeric domain silently
   changes results. (Signing and transaction encoding are a different story — those are integer
   domains and are specified in `01`/`02`.)
2. **Operation order is normative.** Every formula in this document is written in the order the
   operations must be performed. `a * b * c` means `(a * b) * c`. Reassociating changes the last
   bits and breaks conformance.
3. String→number conversion uses the standard JS numeric parse of the full string
   (`Number(s)`), which matches Python's `float(s)` for all decimal literals Lighter emits. A
   string that does not parse to a finite number is treated as a **malformed level** (A3.4).
4. Comparisons against zero are exact (`> 0`, `<= 0`), never epsilon-based, **except** the
   position-close test which uses `|size| < 1e-12` (A5.4) and the decimal-grid test which uses
   `<= 1e-12` (A4.5).

## A2. Type model

### A2.1 `AccountTier` — fee schedule

A closed enumeration mapping a tier to `(takerFee, makerFee)` as **fractions of notional**. All
values are integer numerators over a denominator of `1_000_000`.

| Tier | taker numerator | maker numerator | taker fraction | maker fraction |
|---|---|---|---|---|
| `STANDARD` | 0 | 0 | 0 | 0 |
| `PREMIUM` | 280 | 40 | 0.000280 | 0.000040 |
| `PREMIUM_1` | 273 | 39 | 0.000273 | 0.000039 |
| `PREMIUM_2` | 266 | 38 | 0.000266 | 0.000038 |
| `PREMIUM_3` | 252 | 36 | 0.000252 | 0.000036 |
| `PREMIUM_4` | 238 | 34 | 0.000238 | 0.000034 |
| `PREMIUM_5` | 224 | 32 | 0.000224 | 0.000032 |
| `PREMIUM_6` | 210 | 30 | 0.000210 | 0.000030 |
| `PREMIUM_7` | 196 | 28 | 0.000196 | 0.000028 |

The fractions MUST be computed as `numerator / 1_000_000` at use time (or precomputed as such); do
not hardcode the decimal literals, they are exact only because the denominator is a power of ten
times a power of two — compute them.

Default tier is `STANDARD`, i.e. **zero fees**. This is why the reference test-suite sees
`total_fee == 0` for default clients even when the market detail reports a taker fee.

**DEFECT (ergonomics):** the tier fee completely overrides the per-market `taker_fee` /
`maker_fee` reported by `orderBookDetails`. A market with a bespoke fee is mis-simulated.
**Remedy:** `PaperClientOptions.feeSource` = `"tier"` (default, reference-compatible) |
`"market"` (use the market detail's fees) | `(marketConfig) => {taker, maker}`.

### A2.2 Enumerations (numeric values are normative — they are serialised in vectors)

```
PaperOrderType : MARKET = 0, IOC = 1
PaperOrderSide : BUY = 0, SELL = 1
PaperHealthStatus : HEALTHY = 0
                    PRE_LIQUIDATION = 1
                    PARTIAL_LIQUIDATION = 2   // RESERVED, never produced
                    FULL_LIQUIDATION = 3      // RESERVED, never produced
                    BANKRUPTCY = 4
```

Values 2 and 3 exist on the real exchange (TAV below MMR, then TAV below COMR) but the simulator
collapses them: liquidation runs atomically on every mark update, so a position that crosses its
liquidation price is wiped in the same tick and the intermediate states are never observable. The
constants MUST still be declared so that consumers can exhaustively switch and so that a future
richer model does not renumber.

In TypeScript these are `const` objects plus a union type, not `enum` — `enum` is not erasable and
breaks `isolatedModules`/`verbatimModuleSyntax` ergonomics and Deno's type-stripping.

### A2.3 Structures

```
PaperOrderRequest        (immutable input)
  marketId    : integer
  side        : PaperOrderSide
  baseAmount  : number            // positive, in base units
  price       : number = 0        // limit price; required (>0) for IOC, ignored for MARKET
  orderType   : PaperOrderType = MARKET

PaperFill                (immutable)
  price   : number
  size    : number
  fee     : number
  isMaker : boolean = false       // ALWAYS false in this engine

PaperOrderResult         (immutable)
  orderType   : PaperOrderType
  side        : PaperOrderSide
  marketId    : integer
  fills       : PaperFill[]
  filledSize  : number            // sum of fill.size
  avgPrice    : number            // quoteAmount / filledSize, or 0 when filledSize == 0
  totalFee    : number            // sum of fill.fee
  quoteAmount : number            // sum of (fill.size * fill.price), PRE-fee
  unfilled    : number            // baseAmount - filledSize (residual from the match walk)
  timestamp   : Date              // UTC instant the order was simulated

PaperPosition            (mutable, engine-owned; handed out only as copies)
  marketId         : integer
  size             : number = 0   // SIGNED: >0 long, <0 short
  entryQuote       : number = 0   // absolute notional basis of the open size, always >= 0
  avgEntryPrice    : number = 0   // entryQuote / |size|, 0 when flat
  markPrice        : number = 0   // last mark applied by updatePositionMetrics
  unrealizedPnl    : number = 0   // derived; refreshed by updatePositionMetrics
  realizedPnl      : number = 0   // cumulative, per market, fees NOT included
  liquidationPrice : number = 0   // derived; refreshed by updatePositionMetrics

PaperTrade               (immutable, append-only journal entry)
  marketId      : integer
  side          : PaperOrderSide
  size          : number          // always positive
  price         : number
  fee           : number
  realizedPnl   : number          // realised by THIS fill only, fee NOT deducted
  isLiquidation : boolean
  timestamp     : Date

PaperAccount             (mutable)
  initialCollateral : number      // never changes after construction
  collateral        : number      // realised cash: += realizedPnl, -= fee, (+= funding if enabled)
  positions         : Map<marketId, PaperPosition>   // entry DELETED when flat
  trades            : PaperTrade[]
  hasBeenLiquidated : boolean = false   // sticky for the session

PaperAccountHealth       (immutable snapshot)
  status                       : PaperHealthStatus
  totalAccountValue            : number
  initialMarginRequirement     : number
  maintenanceMarginRequirement : number
  marginUsage                  : number   // percent; may be +Infinity
  leverage                     : number
  hasBeenLiquidated            : boolean

MarketConfig             (immutable, derived from orderBookDetails + AccountTier)
  marketId                     : integer
  symbol                       : string
  sizeDecimals                 : integer
  priceDecimals                : integer
  defaultInitialMarginFraction : integer   // BASIS POINTS, divide by 10_000
  minInitialMarginFraction     : integer   // basis points; carried but UNUSED by the engine
  maintenanceMarginFraction    : integer   // basis points
  closeoutMarginFraction       : integer   // basis points
  takerFee                     : number    // FRACTION, from AccountTier
  makerFee                     : number    // fraction; carried but UNUSED (taker-only engine)
  minBaseAmount                : number    // carried but UNUSED — see DEFECT in A4.5
  minQuoteAmount               : number    // carried but UNUSED — see DEFECT in A4.5
  lastTradePrice               : number    // mark-price fallback
```

**Margin fractions are basis points.** `default_initial_margin_fraction = 1000` means 10 %.
`maintenance_margin_fraction = 50` means 0.5 %. Divide by `10_000`. This is the single most
error-prone constant in the engine; the type name in TypeScript SHOULD encode it
(`type BasisPoints = number` with a doc comment, or a branded type).

`hasBeenLiquidated` semantics: set `true` the first time any liquidation fires, **never cleared**.
It reads as "this session has experienced at least one liquidation", not "currently liquidating".
There is no deposit/reset API; recreating the engine is the only reset.

## A3. In-memory order book

### A3.1 Level identity

A level is `{ price: string, size: string }`. **The price string is the identity key** for delta
merges — not the parsed number.

**DEFECT (correctness):** `"3000.00"` and `"3000.0"` are distinct keys. If the venue ever changes
its price formatting mid-stream, a tombstone will fail to remove the stale level and the book
develops a phantom level, corrupting the mark price and every downstream computation.
**Remedy (default-on, it cannot change reference-vector results because the reference vectors all
use consistent formatting):** key the merge map by a **canonical numeric key** — the parsed number
rendered via a stable canonicalisation (e.g. the number's own `toString`, or a fixed-precision
render at `priceDecimals`) — while retaining the original wire string on the level for display and
for `toJSON()` round-tripping. Levels whose price does not parse are dropped at ingest.

### A3.2 Ingest shapes

Three payload shapes MUST be accepted and normalised to `{price, size}`:

| Source | Ask/bid element | price field | size field | offset |
|---|---|---|---|---|
| REST `GET /api/v1/orderBookOrders` | `SimpleOrder` | `price` | `remaining_base_amount` | none → `null` |
| WS `subscribed/order_book`, `update/order_book` | plain object | `price` | `size` | `offset` |
| `OrderBookDepth` model | `PriceLevel` | `price` | `size` | `offset` |

A plain object MUST also accept `remaining_base_amount` as an alias for `size`. A payload element
missing both `price` and a size field is a hard error ("order book levels must include price and
size data"). An unrecognised payload container type is a hard error.

### A3.3 Ordering invariants

- `asks` sorted by numeric price **ascending**; `bids` sorted by numeric price **descending**.
- Best ask = `asks[0]`, best bid = `bids[0]`; `undefined` when the side is empty.
- Zero-size levels are **filtered out** during normalisation (`size <= 0` removed). Note: the
  reference filters with `size_float > 0`, so a negative size is also dropped.
- Sorting is applied on construction, on snapshot, and after every delta merge.

### A3.4 Operations

**`applySnapshot(payload)`** — replaces both sides wholesale from the payload, sorts, sets
`offset` from the payload (`null` when the payload has none, e.g. the REST orders endpoint).

**`applyDelta(payload)`** — per side:
1. Seed a map from the current levels, keyed per A3.1.
2. For each incoming level: if its parsed size **is exactly 0**, delete the key (a tombstone for a
   key that is not present is a silent no-op). Otherwise insert/replace the key with the incoming
   level (the incoming size replaces, it does not accumulate).
3. Re-sort the resulting values, dropping any with `size <= 0`.

Then set `offset` from the payload. Note the asymmetry: the tombstone test is `size == 0` exactly,
while the post-merge filter is `size > 0`. Both are normative; `"0"`, `"0.0"`, `"0.0000"` all parse
to `0` and all delete.

**`midPrice`** — `(bestAsk.price + bestBid.price) / 2`, or `null` if either side is empty. This is
the engine's mark price (A6).

**`toJSON()`** — `{ asks: [{price,size}...], bids: [...], offset }` preserving the original wire
strings, in sorted order.

### A3.5 Cross-side sanity

**DEFECT (correctness):** a delta may insert a bid above the best ask (or an ask below the best
bid) and the reference happily keeps the crossed book — its own test suite has a delta that puts
`3000.00` on the bid side while `3000.00` is still on the ask side. A crossed book produces a mark
price that is not between the sides and, with a wide enough cross, a mark price that walks
liquidation logic into nonsense.
**Remedy (opt-in, default off for reference parity):** `PaperBookOptions.uncrossPolicy` =
`"none"` (default) | `"drop-incoming"` | `"drop-resting"` | `"throw"`. When not `"none"`, after
each merge, remove levels on the side that violates `bestBid < bestAsk`.

### A3.6 Offset / sequence integrity

**DEFECT (correctness):** `offset` is stored and never validated. A dropped or out-of-order WS
frame silently corrupts the book with no signal.
**Remedy (default-on; it is purely additive):** track the last applied offset. If an incoming
delta's offset is `<= lastOffset`, drop it as a duplicate/replay. If it is `> lastOffset + 1` (a
gap), emit an `onDesync(marketId, {expected, received})` event and, when
`PaperClientOptions.resyncOnGap` is `true` (default), trigger a REST snapshot refresh for that
market. Payloads with `offset == null` (the REST orders endpoint) bypass this check entirely.

## A4. Matching engine

### A4.1 Side selection

- `BUY` walks **asks**, ascending price (cheapest first).
- `SELL` walks **bids**, descending price (highest first).

The walk uses the book's already-sorted array; the matcher does not re-sort.

### A4.2 Per-level algorithm

For each level, in order, while `remaining > 0`:

1. Parse `levelPrice` and `levelSize`. **If parsing fails, `continue` to the next level** (skip,
   do not abort the walk).
2. If `levelPrice <= 0` or `levelSize <= 0`, `continue`.
3. If `orderType == IOC`, apply the limit gate — **and this gate `break`s, it does not `continue`**:
   - `BUY` and `levelPrice > request.price` → `break`
   - `SELL` and `levelPrice < request.price` → `break`

   Because the book is price-sorted, the first level outside the limit means every subsequent level
   is too, so `break` is correct and is normative (a `continue` here would produce different
   results on a malformed/unsorted book).
4. `fillSize = min(remaining, levelSize)`
5. Emit `PaperFill { price: levelPrice, size: fillSize, fee: fillSize * levelPrice * config.takerFee, isMaker: false }`.
   **Operation order is `(fillSize * levelPrice) * takerFee`.**
6. `remaining -= fillSize`

Return `{ fills, remaining }`. `remaining` becomes `PaperOrderResult.unfilled`.

A `MARKET` order has no price gate — it walks the entire book side until filled or exhausted. There
is **no slippage cap** on `MARKET`. (`create_market_order_max_slippage` in the live SDK is a
different code path and does not exist here.)

**DEFECT (ergonomics/safety):** an unbounded `MARKET` order against a thin book fills at
arbitrarily bad prices with no warning. **Remedy (opt-in):**
`PaperOrderRequest.maxSlippageBps?: number` — computed against the best price on the entry side at
the start of the walk; levels beyond the bound `break` the walk exactly as the IOC gate does.

### A4.3 Fees

Every fill is a **taker** fill and pays `takerFee`. `makerFee` is never used. `isMaker` is always
`false`. Fee is charged on the fill notional at the fill price, per fill (so a multi-level fill
pays a fee per level and the fees are summed, which is not the same as fee on the aggregate
notional at the average price — but is within float rounding of it; the per-fill sum is normative).

Fees are deducted from `collateral` at fill-application time (A5.5), and reported in
`PaperFill.fee`, `PaperTrade.fee`, and `PaperOrderResult.totalFee`. Fees are **not** folded into
`realizedPnl`.

### A4.4 No market impact

Simulating a fill does **not** modify the book. Two identical orders placed back-to-back against
the same book snapshot produce identical fills at identical prices. This is a deliberate
"infinite-depth replay" model that keeps the simulator a pure function of `(book, request)`.

**DEFECT (modelling):** for any strategy sized above a fraction of top-of-book, this
systematically over-reports fill quality, and it makes the simulator unable to model a strategy
that repeatedly hits the same level. **Remedy (opt-in):**
`PaperClientOptions.consumeLiquidity: boolean = false`. When `true`, each fill decrements the
matched level's size in the live book (removing the level when it reaches zero), so subsequent
orders in the same tick see depleted depth. The next snapshot/delta from the venue restores real
depth. Document loudly that enabling this diverges from the conformance vectors.

### A4.5 Validation

`validateOrder(request, config)` throws (a typed `PaperValidationError`) when:

1. `request.baseAmount <= 0` — "base amount must be positive, got {v}"
2. `baseAmount` does not sit on the size-decimal grid, tested as:
   `|round(v * 10^sizeDecimals) / 10^sizeDecimals − v| <= 1e-12` must hold.
   Message: "base amount {v} exceeds {d} size decimals for {symbol}"
3. For `IOC` only:
   - `request.price <= 0` — "IoC order requires positive price, got {v}"
   - `price` off the price-decimal grid by the same test — "price {v} exceeds {d} price decimals for {symbol}"

The rounding uses **round-half-away-from-zero** semantics in the reference (Go/Python `round` on a
float via `round(v*m)/m`). JavaScript's `Math.round` is round-half-**up** (toward +∞), which differs
for exact negative halves. Since `baseAmount > 0` is already enforced and `price > 0` is enforced
for IOC, the only inputs reaching the grid test are positive, where the two agree. Implement with
`Math.round` and add a conformance vector at a `.5` boundary to lock it.

**DEFECT (correctness):** `minBaseAmount` and `minQuoteAmount` are loaded into `MarketConfig` and
never checked. The real exchange rejects sub-minimum orders; the simulator accepts them, so a
strategy can "profitably" trade dust that would never fill in production.
**Remedy (opt-in, default off for parity):** `PaperClientOptions.enforceMinimums: boolean = false`.
When `true`, additionally reject `baseAmount < config.minBaseAmount` and, post-match,
`quoteAmount < config.minQuoteAmount`. Recommend turning it **on** in the examples and README so
users meet it early.

## A5. Position accounting

`applyFill(account, marketId, side, fillSize, fillPrice, fee, {isLiquidation}) -> realizedPnl`

`fillSize` is always positive. All state mutation for the account happens here and only here.

### A5.1 Setup

```
position    = account.positions.get(marketId) ?? new PaperPosition(marketId)   // inserted if absent
oldSize     = position.size
oldAbs      = |oldSize|
oldQuote    = position.entryQuote
delta       = (side == BUY) ? +fillSize : -fillSize
newSize     = oldSize + delta
newAbs      = |newSize|
oldSign     = sign(oldSize)      // -1 | 0 | +1, exact comparison against 0
newSign     = sign(newSize)
realizedPnl = 0
newQuote    = 0
```

### A5.2 Case analysis (evaluated in this exact order)

**Case 1 — open from flat (`oldSign == 0`):**
```
newQuote = fillSize * fillPrice
```
`realizedPnl` stays 0.

**Case 2 — flip through zero (`oldSign != newSign && newSign != 0`):**
```
realizedPnl = fullClosePnl(oldSign, oldAbs, oldQuote, fillPrice)
newQuote    = newAbs * fillPrice
```
The whole old position is realised at `fillPrice`, and the residual position is opened at
`fillPrice`. Note this means a flip is treated as close-then-open at a single price — correct for a
single fill, and correct across a multi-fill order because `applyFill` runs once per fill.

**Case 3 — exact close (`oldSign != newSign && newSign == 0`):**
```
realizedPnl = fullClosePnl(oldSign, oldAbs, oldQuote, fillPrice)
newQuote    = 0
```

**Case 4 — increase (`newAbs > oldAbs`, same sign):**
```
newQuote = oldQuote + fillSize * fillPrice
```
`realizedPnl` stays 0. Operation order: `oldQuote + (fillSize * fillPrice)`.

**Case 5 — partial reduce (else; `newAbs < oldAbs`, same sign, `oldAbs > 0`):**
```
newQuote   = oldQuote * (newAbs / oldAbs)          // pro-rata basis retained
closedSize = oldAbs - newAbs
avgEntry   = oldQuote / oldAbs
realizedPnl = (oldSign > 0)
              ? closedSize * fillPrice - closedSize * avgEntry
              : closedSize * avgEntry - closedSize * fillPrice
```
Operation order is normative: two multiplications then one subtraction, **not**
`closedSize * (fillPrice - avgEntry)`.

Where:
```
fullClosePnl(oldSign, oldAbs, oldQuote, fillPrice) =
    (oldSign > 0) ? oldAbs * fillPrice - oldQuote
                  : oldQuote - oldAbs * fillPrice
```

### A5.3 Position update

```
position.size          = newSize
position.entryQuote    = newQuote
position.avgEntryPrice = (newAbs > 0) ? newQuote / newAbs : 0
position.realizedPnl  += realizedPnl
```

`markPrice`, `unrealizedPnl`, and `liquidationPrice` are **not** touched here — they are derived
fields refreshed by `updatePositionMetrics` (A8.4).

### A5.4 Account update and journal

```
account.collateral += realizedPnl
account.collateral -= fee                       // two separate statements, in this order
account.trades.push(PaperTrade{ marketId, side, size: fillSize, price: fillPrice,
                                fee, realizedPnl, isLiquidation, timestamp: now() })
if (isLiquidation) account.hasBeenLiquidated = true
if (|newSize| < 1e-12) account.positions.delete(marketId)
```

The `1e-12` dust threshold means a residual position smaller than `1e-12` base units is discarded,
and its (tiny) entry quote is silently forgotten. This is normative.

Note that the position is **inserted into the map before** the dust check, so an `applyFill` that
opens and immediately dusts leaves no entry.

`now()` is the current UTC instant. For determinism in tests and vectors the engine MUST take a
`clock: () => Date` injectable, defaulting to `() => new Date()`.

### A5.5 Derived position math

```
unrealizedPnl(position, mark) =
    position == null || position.size == 0            -> 0
    let absSize = |position.size|
    let positionValue = absSize * mark
    position.size > 0  -> positionValue - position.entryQuote
    position.size < 0  -> position.entryQuote - positionValue
```

```
totalAccountValue(account, marks) =
    total = account.collateral
    for each (marketId, position) in account.positions:
        if marks has marketId:
            total += unrealizedPnl(position, marks[marketId])
    return total
```

**Positions whose market has no mark price contribute nothing** — neither their unrealised PnL nor
their notional. The iteration order over positions is the `Map` insertion order, which affects the
last bits of the float sum; the TypeScript implementation MUST iterate a `Map` in insertion order
(which `Map` guarantees) and MUST insert markets in the same order the reference's dict would, i.e.
first-touched order. Conformance vectors therefore fix the market-touch order.

## A6. Mark price

The engine has no oracle. Mark price per tracked market is derived, on every read, as:

```
markOf(marketId):
    mark = orderBooks[marketId].midPrice          // (bestAsk + bestBid) / 2
    if mark == null:
        cfg = marketConfigs[marketId]
        if cfg != null and cfg.lastTradePrice > 0:
            mark = cfg.lastTradePrice
    include marketId in the mark map only if mark != null AND mark > 0
```

Consequences that are normative:

- A market with an empty or one-sided book falls back to the **static** `lastTradePrice` captured
  when the market config was first fetched. That value never refreshes. A long-lived session with a
  degenerate book will mark against a stale price indefinitely.
- A market whose book is empty **and** whose `lastTradePrice` is `0` has **no mark**, so it is
  excluded from TAV, IMR, MMR, notional, liquidation checks, and metric updates — the position
  becomes invisible to risk. This is the reference behaviour and is a real hazard.
- The mark map is rebuilt from scratch on every call.

**DEFECT (performance/consistency):** the reference rebuilds the mark map **twice** inside a single
liquidation-and-metrics pass (once for the liquidation check, once for the metrics update). It is
wasteful and, worse, if a book were mutated between the two calls the pass would use inconsistent
marks. **Remedy (default-on, no behavioural change in practice):** compute the mark map once at the
top of the pass and thread it through.

**DEFECT (staleness):** `lastTradePrice` is never refreshed. **Remedy (default-on):** refresh
`MarketConfig.lastTradePrice` whenever `orderBookDetails` is re-fetched, and expose
`refreshMarketConfig(marketId)`. Additionally allow `PaperClientOptions.markPriceSource` =
`"mid"` (default) | `"lastTrade"` | `(book, config) => number | null` so users can supply an oracle
or index price.

## A7. Margin requirements

All three are cross-margin sums over **all** open positions with a known mark **and** a known
config. A position missing either is skipped entirely (contributing zero).

```
IMR  = Σ  |position.size| * mark * (config.defaultInitialMarginFraction / 10_000)
MMR  = Σ  |position.size| * mark * (config.maintenanceMarginFraction   / 10_000)
COMR = Σ  |position.size| * mark * (config.closeoutMarginFraction      / 10_000)
```

Operation order: `((|size| * mark) * (fraction / 10_000))`.

`minInitialMarginFraction` is carried on `MarketConfig` and is **never used** — the engine always
uses the *default* IMF, i.e. it does not model per-position leverage selection.

**DEFECT (modelling):** because IMF is fixed at the market default, a user who runs 50× isolated
leverage on the real exchange cannot express that here; the simulator will report a much higher
margin requirement (and a much closer liquidation price) than production.
**Remedy (opt-in):** `PaperClient.setLeverage(marketId, leverage)` storing a per-market IMF
override clamped to `[minInitialMarginFraction, 10_000]`, used by `IMR` in place of the default.
Do not change MMR/COMR — those are market-wide risk parameters.

`COMR` is computed and exposed but is **not** used by any status decision (the closeout branch is
disabled — see A8.1).

## A8. Risk, health, and liquidation

### A8.1 Health status

```
tav = totalAccountValue(account, marks)
imr = IMR(account, marks, configs)
mmr = MMR(account, marks, configs)

status =  tav < 0     -> BANKRUPTCY        (4)
          tav < imr   -> PRE_LIQUIDATION   (1)
          otherwise   -> HEALTHY           (0)
```

The real exchange's `tav < comr -> FULL_LIQUIDATION` and `tav < mmr -> PARTIAL_LIQUIDATION` rungs
are deliberately **not** evaluated. They are documented as reserved (A2.2).

```
marginUsage =  imr == 0  -> 0
               tav > 0   -> imr / tav * 100          // percent; operation order ((imr/tav)*100)
               otherwise -> +Infinity
```

Note the ordering: `imr == 0` wins even when `tav <= 0`, so a flat account that has been wiped to
negative collateral reports `0 %`, not `Infinity`. An account with an open position and `tav == 0`
exactly reports `+Infinity`.

```
totalNotional = Σ |position.size| * mark        // over positions with a known mark
leverage      = (tav > 0) ? totalNotional / tav : 0
```

`leverage` is `0` — not `Infinity` — for a non-positive TAV, even with open positions. That is
intentional in the reference and is normative.

`hasBeenLiquidated` is copied straight from the account.

`marginUsage` may be `Infinity`. It MUST be serialised as `null` in any JSON output (JSON has no
infinity) with a documented convention, or as the string `"Infinity"` — pick **`null` plus a
sibling boolean `marginUsageUnbounded: true`** for JSON transport; keep `Infinity` in the in-memory
object.

### A8.2 Liquidation price

Per market, cross-margin aware, holding **every other market's mark fixed**.

Return `0` immediately when: no position for the market, `position.size == 0`, no config, or no
mark. `0` is the sentinel for "not liquidatable / not applicable" and is used as such by the
liquidation check (A8.3).

Otherwise:

```
tav        = totalAccountValue(account, marks)        // cross, at current marks
crossMmr   = MMR(account, marks, configs)             // cross, at current marks
absSize    = |position.size|
mmFraction = config.maintenanceMarginFraction / 10_000
sign       = (position.size > 0) ? +1 : -1

denominator = absSize * (mmFraction - sign)
if denominator == 0: return 0

liq = mark + (tav - crossMmr) / denominator

if liq < 0:                                return 0
if position.size > 0 and liq >= mark:      return mark
if position.size < 0 and liq <= mark:      return mark
return liq
```

**Derivation** (stated so the implementer can verify, not copied): let `P` be the hypothetical mark
of this market and `ΔP = P − mark`. Holding all other marks fixed,

- `TAV(P)   = tav      + sign · absSize · ΔP`
- `MMR(P)   = crossMmr + mmFraction · absSize · ΔP`

Liquidation is the `P` at which `TAV(P) = MMR(P)`:

```
tav + sign·absSize·ΔP = crossMmr + mmFraction·absSize·ΔP
ΔP · absSize · (sign − mmFraction) = crossMmr − tav
ΔP = (tav − crossMmr) / (absSize · (mmFraction − sign))
```

which is exactly the formula above. For a long, `mmFraction − 1 < 0`, so a healthy account
(`tav > crossMmr`) gives a negative `ΔP` — the liquidation price is below the mark, as expected.
For a short, `mmFraction + 1 > 0`, giving a positive `ΔP` — above the mark.

The clamps mean:
- An over-collateralised long whose computed liquidation price is negative reports `0`
  ("cannot be liquidated").
- A position already past its threshold reports **exactly the current mark**, which makes the
  crossing test in A8.3 fire on the same tick.

### A8.3 Liquidation check

Two phases, and the phase split is normative:

**Phase 1 — detect (no mutation).** For every open position, compute its liquidation price using
the **pre-liquidation** account state. Skip when `liqPrice == 0` or the mark is missing. Then:
- long (`size > 0`) and `mark <= liqPrice` → mark for liquidation
- short (`size < 0`) and `mark >= liqPrice` → mark for liquidation

**Phase 2 — execute.** For each marked market id, in detection order, close the entire position at
the **current mark price**, with **fee = 0**, via `applyFill(..., isLiquidation: true)`. The close
side is `SELL` for a long, `BUY` for a short.

Return the list of liquidated market ids.

Consequences:

- **Cascade.** Because every market's liquidation price is computed against the *original* TAV,
  one market crashing can mark *several* markets for liquidation in a single pass, and all of them
  are wiped. The reference test-suite explicitly asserts this cross-margin cascade (a crash in
  market 0 liquidates a healthy position in market 1). This is a modelling artifact, not exchange
  behaviour — a real cross-margin engine liquidates incrementally and re-evaluates.
  **DEFECT (modelling). Remedy (opt-in, default off for parity):**
  `PaperClientOptions.liquidationMode` = `"cascade"` (default, reference-compatible) |
  `"incremental"` — under `"incremental"`, liquidate one position at a time (largest MMR
  contribution first), recompute health after each, and stop as soon as `tav >= mmr`.

- **Zero cost.** Liquidation executes at the mark with no fee, no penalty, and no order-book
  slippage — strictly better than reality, where a liquidation eats the book and pays a liquidation
  fee. **DEFECT (modelling). Remedy (opt-in):** `liquidationExecution` =
  `"mark"` (default) | `"book"` (walk the real book like a taker order) and
  `liquidationFeeFraction: number = 0` (populate from `PerpsOrderBookDetail.liquidation_fee` when
  the user opts in).

- **The `liqPrice == 0` skip is load-bearing.** A fully collateralised long has `liqPrice == 0`, so
  it is never liquidated even if the mark goes to zero. That is correct (it genuinely cannot be
  liquidated at any positive price), but it also means a position in a market with a missing/zero
  mark is invisible to liquidation entirely.

### A8.4 Metric refresh

`updatePositionMetrics(account, marks, configs)` — for each open position with a known mark:

```
position.markPrice        = mark
position.unrealizedPnl    = unrealizedPnl(position, mark)
position.liquidationPrice = liquidationPrice(account, marketId, marks, configs)
```

Positions with no mark keep their previous (stale) derived values. This is the reference behaviour;
a `null` would be more honest. **Remedy (default-on, additive):** additionally set
`position.markStale = true` on such positions so consumers can tell.

### A8.5 The combined pass

Every state-changing operation (order placement, REST snapshot refresh, WS snapshot, WS delta) ends
with:

```
liquidated = checkAndLiquidate(account, marks, configs)
updatePositionMetrics(account, marks, configs)
```

in that order. With the A6 remedy, `marks` is computed once and shared.

`liquidated` is discarded by the reference's callers. **Remedy (default-on, additive):** surface it
— emit a `liquidation` event carrying `{marketIds, trades}` and return it from `placeOrder` on the
result as `result.liquidations: number[]`.

## A9. `PaperClient` — public API and lifecycle

### A9.1 Construction

Inputs and validation:

| Option | Default | Validation |
|---|---|---|
| `initialCollateralUsdc` | — (required) | must be `> 0`, else throw |
| `orderBookLimit` | `100` | must be in `[1, 250]` inclusive, else throw |
| `orderApi` / `apiClient` | — | one of them; `orderApi` wins when both given |
| `wsUrl` | derived (below) | — |
| `wsPath` | `"/stream"` | — |
| `initialSnapshotTimeoutMs` | `10_000` | — |
| `accountTier` | `STANDARD` | — |
| `clock` | `() => new Date()` | injectable for determinism |

**WebSocket URL derivation** (normative, when `wsUrl` is not supplied):

1. Take the HTTP base URL from the API client's configuration (or the default endpoint profile).
2. Scheme rewrite: `https://` → `wss://`; `http://` → `ws://`; `wss://` and `ws://` pass through
   unchanged; anything else (a bare host) is prefixed with `wss://`.
3. Strip trailing `/` from the result; strip leading `/` from `wsPath`; join with a single `/`.
4. Append the JSON-encoding query parameter: if the URL already contains `?`, append
   `&encoding=json`, else `?encoding=json`.

Step 4 is mandatory — the listener rejects binary frames (A9.5), and the venue defaults to a binary
encoding without it.

### A9.2 Market tracking

**`trackMarketSnapshot(marketId)`** — snapshot mode, no socket:
1. Reject `marketId >= 2048` ("paper trading only supports perp markets").
2. Ensure the market config is loaded (fetch once, cache).
3. `refreshOrderBook(marketId)`.

**`trackMarket(marketId)`** — live mode:
1. Reject `marketId >= 2048`.
2. Ensure market config.
3. If already tracking live, return (idempotent).
4. Create an empty book for the market if absent.
5. Create a listener, register it, `start()` it. On any failure, **deregister the listener before
   rethrowing** (the reference does this; without it a failed start leaves a zombie entry that makes
   `trackMarket` a permanent no-op for that market).

`start()` resolves only after the **initial snapshot** has been applied, or rejects on timeout /
socket failure. On rejection it calls `stop()` first.

**`stopTracking(marketId)`** — deregister and stop that market's listener. Idempotent.

**`close()`** — snapshot the listener collection, clear the registry, then stop all listeners
concurrently, swallowing individual errors. Idempotent.

**`refreshOrderBook(marketId)`** — throws if the market has no config ("market {id} not tracked").
Calls `GET /api/v1/orderBookOrders?market_id&limit=orderBookLimit`, applies it as a **snapshot**,
then runs the combined pass (A8.5).

**Market config fetch** — `GET /api/v1/orderBookDetails?market_id={id}`, then find the entry in
`order_book_details` whose `market_id` equals the requested id. If none, throw ("perps order book
detail not found for market {id}"). If the found entry's `market_type != "perp"`, throw. Map:

| `MarketConfig` field | `PerpsOrderBookDetail` source |
|---|---|
| `marketId` | `market_id` |
| `symbol` | `symbol` |
| `sizeDecimals` | `size_decimals` |
| `priceDecimals` | `price_decimals` |
| `defaultInitialMarginFraction` | `default_initial_margin_fraction` |
| `minInitialMarginFraction` | `min_initial_margin_fraction` |
| `maintenanceMarginFraction` | `maintenance_margin_fraction` |
| `closeoutMarginFraction` | `closeout_margin_fraction` |
| `takerFee` | **`AccountTier.takerFee`** (NOT the detail's `taker_fee`) |
| `makerFee` | **`AccountTier.makerFee`** |
| `minBaseAmount` | `Number(min_base_amount)` |
| `minQuoteAmount` | `Number(min_quote_amount)` |
| `lastTradePrice` | `Number(last_trade_price)` |

### A9.3 Order placement

**`createPaperOrder(request) -> PaperOrderResult`**

1. Look up the market config; throw if absent ("market {id} not tracked, call trackMarket or
   trackMarketSnapshot first").
2. Look up the book; throw if absent ("no order book for market {id}").
3. `validateOrder(request, config)`.
4. `simulateMatch(request, book.asks, book.bids, config)`.
5. For each fill, in order: `applyFill(account, marketId, side, fill.size, fill.price, fill.fee)`.
   Accumulate `filledSize += fill.size`, `quoteAmount += fill.size * fill.price`,
   `totalFee += fill.fee`.
6. `avgPrice = (filledSize > 0) ? quoteAmount / filledSize : 0`.
7. Run the combined pass (A8.5).
8. Return the `PaperOrderResult`.

Note step 5 runs **before** step 7: a position can be opened and then liquidated by the same call.
The reference test-suite asserts exactly this (an order that pushes the account under water
liquidates both the new position and a pre-existing one in another market, and `createPaperOrder`
still returns a result describing the fills).

### A9.4 Read API

| Method | Returns | Notes |
|---|---|---|
| `getHealth()` | `PaperAccountHealth` | computed at call time from current marks |
| `getLiquidationPrice(marketId)` | `number` | `0` when N/A |
| `getPosition(marketId)` | `PaperPosition \| null` | **a copy** — callers must not be able to mutate engine state |
| `getAccount()` | `PaperAccount` | **deep copy**: positions cloned, trades array copied |
| `getCollateral()` | `number` | |
| `getTrades()` | `PaperTrade[]` | copy of the array (elements are immutable) |
| `getPortfolioValue()` | `number` | **throws** "no mark prices available" when positions exist but the mark map is empty |

`getPortfolioValue` is TAV. Its throw condition is `positions.size > 0 && marks.size == 0` — note
it does *not* throw when *some* positions lack marks, only when *all* marks are missing.

### A9.5 Live listener state machine

One listener per tracked market, one socket per listener.

```
                    ┌──────────┐
  start() ─────────▶│  OPENING │
                    └────┬─────┘
                         │ socket open
                    ┌────▼─────────────┐
                    │ AWAITING_CONNECT │◀── ignores every frame except "connected"
                    └────┬─────────────┘
        recv {type:"connected"}
        send {type:"subscribe", channel:"order_book/<id>"}   (once, guarded by a `subscribed` flag)
                    ┌────▼──────────────┐
                    │ AWAITING_SNAPSHOT │
                    └────┬──────────────┘
        recv {type:"subscribed/order_book"} for THIS market
        → applySnapshot, resolve the initial-snapshot promise
                    ┌────▼─────┐
                    │  STREAM  │  recv "update/order_book" → applyDelta
                    └────┬─────┘
        stop() / socket close / error
                    ┌────▼─────┐
                    │  CLOSED  │
                    └──────────┘
```

Frame handling rules, all normative:

- A **binary** frame is a hard error: "received binary websocket frame; paper client only supports
  JSON encoding (ensure ws URL includes ?encoding=json)".
- `{"type":"ping"}` → reply `{"type":"pong"}`. This works in any state and does not advance it.
- `{"type":"connected"}` → send the subscribe frame, at most once per socket.
- Frames whose `type` is not `subscribed/order_book` or `update/order_book` are **silently ignored**
  (after ping/connected handling).
- The market id is parsed from the `channel` field, which the venue emits with **either** separator:
  try the prefix `order_book:` then `order_book/`; the remainder must parse as an integer. A channel
  that does not match, or whose id differs from the listener's market, causes the frame to be
  **ignored** (not an error). The *outbound* subscribe frame always uses `/`.
- A matching frame missing an `order_book` object is a hard error ("order book websocket message
  missing order_book payload").
- `subscribed/order_book` is a full **snapshot**; `update/order_book` is a **delta**.
- The initial-snapshot promise resolves on the first snapshot. It is **rejected** if the socket
  errors, or on socket close before a snapshot arrives ("websocket closed before market {id}
  snapshot"). `start()` races it against `initialSnapshotTimeoutMs`; on any failure it calls
  `stop()` and rethrows.
- `stop()` closes the socket (swallowing errors), cancels the read loop, and clears
  socket/subscribed state. Idempotent.

**DEFECT (availability) — the big one:** there is **no reconnection**. A socket drop after the
initial snapshot silently ends the stream: the book freezes at its last state, marks stop moving,
liquidation stops firing, and nothing tells the caller. For a paper client used as a live shadow of
a production strategy this is the worst possible failure mode — it looks healthy and is wrong.
**Remedy (default-on):**
- Auto-reconnect with exponential backoff and full jitter: `min(baseDelay * 2^attempt, maxDelay)`
  with `baseDelay = 250 ms`, `maxDelay = 30 s`, jitter `[0, delay]`, `attempt` reset on a successful
  snapshot. Unbounded attempts by default; configurable `maxReconnectAttempts`.
- On reconnect: resubscribe and treat the next `subscribed/order_book` as a fresh snapshot that
  **replaces** the book (which the snapshot path already does).
- Expose a connection-state observable/event: `connecting | open | subscribed | reconnecting | closed`,
  plus `onDesync` (A3.6) and `onStale(marketId, msSinceLastMessage)`.
- Heartbeat watchdog: if no frame (of any type, including `ping`) arrives within
  `staleTimeoutMs` (default `30_000`), force-close and reconnect.

**DEFECT (efficiency):** one socket per market. Ten markets means ten sockets to the same host, ten
`connected` handshakes, ten ping/pong loops. The venue multiplexes channels on a single connection.
**Remedy (default-on):** a single shared connection per `PaperClient` (per WS URL), with a
subscription registry keyed by channel; `trackMarket` adds a subscription, `stopTracking` sends an
unsubscribe (or simply stops routing, if the venue has no unsubscribe frame) and drops the last
socket when the registry empties. This also fixes the multi-market reconnect story. The single-
socket design MUST be shared with the WS spec (`04`) rather than duplicated here.

### A9.6 Concurrency

The reference guards state with an `asyncio.Lock` **and** a re-entrant thread lock, because Python
paper clients can be touched from a thread pool. In TypeScript this is unnecessary and harmful:
the runtime is single-threaded and every state transition in the engine is synchronous once the
book is in memory.

**Design:** the core engine is **fully synchronous and pure**; only the shell does I/O.

```
createPaperEngine(opts) -> PaperEngine      // ZERO I/O, zero async
    engine.applySnapshot(marketId, payload)
    engine.applyDelta(marketId, payload)
    engine.setMarketConfig(config)
    engine.placeOrder(request)  -> PaperOrderResult    // SYNCHRONOUS
    engine.applyFunding(marketId, rate)                // A10
    engine.getHealth() / getPosition() / getAccount() / ...
    engine.snapshotState() / restoreState()            // serialisable, for persistence & replay

new PaperClient(opts) -> wraps a PaperEngine and owns the REST + WS I/O
    await client.trackMarket(id) / trackMarketSnapshot(id) / refreshOrderBook(id)
    await client.close()
    client.placeOrder(request)                          // synchronous delegate
    ...all engine readers delegated
```

This is a strict improvement: the engine becomes trivially unit-testable with no network and no
fakes, backtesting over recorded book data becomes a `for` loop, and there are no locks to reason
about. `placeOrder` being synchronous is safe precisely because nothing awaits between validation
and the combined pass.

For API-compat with the Python surface, `PaperClient.createPaperOrder` MAY be provided as an
`async` alias of `placeOrder`.

### A9.7 Serialisable state

Not in the reference; required for our use cases (Workers have no long-lived process; a Durable
Object or KV must persist between requests).

`snapshotState()` returns a plain JSON-safe object:

```
{
  version: 1,
  account: { initialCollateral, collateral, hasBeenLiquidated,
             positions: [ {marketId, size, entryQuote, avgEntryPrice, realizedPnl} ... ],
             trades:    [ {marketId, side, size, price, fee, realizedPnl, isLiquidation, timestampMs} ... ] },
  marketConfigs: [ ...MarketConfig ],
  books: { [marketId]: { asks, bids, offset } },
  accountTier: string
}
```

Derived position fields (`markPrice`, `unrealizedPnl`, `liquidationPrice`) are **omitted** — they
are recomputed on restore. `restoreState(s)` rebuilds the engine and runs the combined pass.
`version` gates forward compatibility.

## A10. Funding (new capability)

The reference does not simulate funding, which materially misprices any strategy held across a
funding interval. We add it, **opt-in**.

**Data sources** (owned by the REST spec, consumed here):
- `GET /api/v1/funding-rates` → `{ code, message?, funding_rates: [{ market_id, exchange, symbol, rate }] }`.
  `rate` is a `number`. It is the current rate; `exchange` distinguishes Lighter's own rate from
  reference-venue rates, so filter on the Lighter entry.
- `GET /api/v1/fundings?market_id&resolution&start_timestamp&end_timestamp&count_back` → historical
  funding series, for backtests.
- `GET /api/v1/positionFunding?account_index&...` → realised funding on a real account, for
  cross-checking a simulation against production.

**Model.** For a position of signed size `s` at mark `M` and funding rate `r` for one funding
interval, the cash flow to the account is:

```
fundingPayment = s * M * r          // operation order: (s * M) * r
account.collateral -= fundingPayment
```

Sign convention: `r > 0` means **longs pay shorts**. A long (`s > 0`) therefore has a positive
`fundingPayment`, which is subtracted from collateral. A short (`s < 0`) has a negative
`fundingPayment`, which increases collateral. This matches the perpetual-swap convention and must
be verified against a `positionFunding` sample before release (see Open Questions).

Funding is **not** part of `realizedPnl` and is **not** a `PaperTrade`. It gets its own journal:

```
PaperFundingEvent { marketId, size, markPrice, rate, payment, timestamp }
account.fundingEvents : PaperFundingEvent[]
account.totalFunding  : number     // running sum of payment
```

Applying funding MUST be followed by the combined pass (A8.5) — funding can push an account into
liquidation, and that is exactly the scenario users want the simulator to catch.

**API:**
```
engine.applyFunding(marketId, rate)                     // uses the current mark
engine.applyFundingAll(ratesByMarketId)
client.enableAutoFunding({ intervalMs, source })        // polls funding-rates on a timer
```
Default: **disabled**. When disabled the engine is bit-identical to the reference.

## A11. Conformance and test plan for the paper engine

The paper engine is the one subsystem with no Go reference, so its vectors come from **Python**.

**Vector generator** (`tools/gen-paper-vectors.py`, not shipped in the npm package): drives the
Python paper client through a scripted scenario using an in-process fake order API (no network) and
a frozen clock, dumping `vectors/paper/*.json` of the form:

```
{ "name": "...", "seed": {...}, "steps": [ {op, args} ... ],
  "expect": { "afterEachStep": [ {collateral, positions, health, trades} ... ] } }
```

The TypeScript suite replays each vector against `PaperEngine` and asserts. Tolerance: floats
compared with relative error `<= 1e-12` (absolute `<= 1e-12` when the expected value is `0`);
integers, strings, booleans, and enum values compared exactly.

**Scenarios that MUST be covered** (each is directly motivated by a reference behaviour above):

Accounting — open long, open short, increase, partial reduce long, partial reduce short, exact
close (position removed), flip long→short, flip short→long, dust close below `1e-12`, fee-only
collateral effect, per-market `realizedPnl` accumulation.

Matching — empty book, partial liquidity with residual `unfilled`, multi-level fill and `avgPrice`,
IOC buy stopping at the limit, IOC sell stopping at the limit, malformed level skipped mid-walk,
zero/negative price and size levels skipped, repeated identical orders producing identical fills.

Validation — zero and negative size, size off the decimal grid, IOC with zero price, IOC price off
the grid, boundary case at exactly `1e-12` off-grid.

Book — snapshot sort (asks ascending, bids descending), snapshot drops zero-size levels,
delta tombstone with `"0"`, `"0.0"`, `"0.0000"`, tombstone for an absent level is a no-op, delta
replaces size, delta inserts and preserves sorting on both sides, `midPrice` null when one side is
empty, `toJSON()` shape and offset propagation, offset from `OrderBookDepth` vs `null` from the REST
orders endpoint.

Risk — IMR/MMR/COMR at a known basis-point config, HEALTHY / PRE_LIQUIDATION / BANKRUPTCY
thresholds, `marginUsage == 0` when flat, `marginUsage == Infinity` when underwater with a position,
`leverage == 0` when TAV `<= 0`, liquidation price for a long (below mark) and a short (above mark),
clamp to `0` when over-collateralised, clamp to `mark` when already past, `0` for no position.

Liquidation — a long walked down through healthy → pre-liquidation → liquidated with the sticky
flag set; a short liquidated by an upward move; the cross-margin cascade wiping two markets in one
pass; liquidation trade recorded with `isLiquidation` and a negative `realizedPnl`; health after
liquidation reading HEALTHY with zero IMR/MMR and the sticky flag still true.

Client — snapshot-mode buy-then-sell round trip (4 trades: 2 fills each way), IOC partial fill,
cross-market health, an order triggering cross-market liquidation, liquidation triggered *by* an
order on a pre-existing position, mark-price fallback to `lastTradePrice` with an empty book,
`refreshOrderBook` updating `unrealizedPnl`, PREMIUM tier fee arithmetic, default tier is STANDARD.

Live — subscribe frame shape `{"type":"subscribe","channel":"order_book/<id>"}`, snapshot applied
and sorted, delta with tombstones and re-sorting and offset advance, `stopTracking` closing the
socket, a delta triggering liquidation, multi-market tracking with per-market metric updates,
`close()` tearing down all listeners, channel-id parsing with both `:` and `/`, binary frame
rejection, ping→pong.

New-behaviour tests (no Python counterpart, so they are ordinary unit tests, not vectors):
reconnect with backoff, offset-gap desync and resync, funding application and funding-triggered
liquidation, `snapshotState`/`restoreState` round trip, `consumeLiquidity` mode, `enforceMinimums`
mode, `incremental` liquidation mode, leverage override.

---

# PART A′ — Residual Python-SDK surfaces

Everything below is not claimed by specs 01–07. Endpoint paths, query-parameter names, form-field
names, and JSON key names are **interoperability requirements** and are reproduced exactly.

## A′1. Response envelope and `ApiResponse` conventions

### A′1.1 The `code` / `message` envelope

Almost every REST response body carries a `code: integer` and an optional `message: string`
alongside its payload. The OpenAPI document documents `code` with the example `"200"` — it mirrors
the HTTP status rather than being a 0-means-OK flag (though some fixtures use `0`).

**Rule for our SDK: never gate success on `code`.** Success is `HTTP 2xx`. `code` and `message`
are surfaced on the returned object verbatim so callers can inspect them, and are included in the
error object when the HTTP status is not 2xx.

`ResultCode { code: integer (required), message?: string }` is the bare envelope, returned by
several write endpoints and used as the `400` body for essentially every endpoint.

### A′1.2 The three-variant call pattern — and why we drop it

The generated Python client exposes **three coroutines per operation**:
`op(...)` → deserialised model; `op_with_http_info(...)` → `ApiResponse<T>`;
`op_without_preload_content(...)` → the raw streaming response. `ApiResponse<T>` is
`{ status_code: int, headers?: Map<string,string>, data: T, raw_data: bytes }`.

This triples the API surface for a need that arises in maybe 1 % of calls.

**TypeScript design:** one function per operation.

```
op(params, options?) : Promise<T>
```
where `options` may include `raw: true` to change the return to
`{ data: T, status: number, headers: Headers, response: Response }`. Overloads give this exact
types without a second exported symbol:

```
function op(params: P): Promise<T>
function op(params: P, options: { raw: true }): Promise<RawResult<T>>
```

Streaming (`without_preload_content`) is covered by handing back the `Response` in the `raw` form —
`response.body` is a `ReadableStream` on every target runtime. No third variant.

`headers` MUST be exposed as the standard `Headers` object, not a plain map, so header casing and
multi-value headers behave correctly.

### A′1.3 Error taxonomy

The generated Python hierarchy (`OpenApiException` → `ApiException` → `BadRequest`/`Unauthorized`/
`Forbidden`/`NotFound`/`ServiceException`, plus `ApiTypeError`/`ApiValueError`/`ApiKeyError`/
`ApiAttributeError`) is a deserialisation-era artifact.

**TypeScript design:** a single `LighterError` base with a discriminated `kind`:

```
type LighterErrorKind =
  | "network"        // fetch rejected: DNS, TLS, abort, offline
  | "timeout"        // our own deadline fired
  | "http"           // non-2xx response
  | "decode"         // 2xx body did not match the expected shape
  | "validation"     // caller-side input rejected before any request
  | "auth"           // missing/expired auth token, 401/403 shorthand
  | "ws"             // websocket protocol/transport failure

class LighterError extends Error {
  kind: LighterErrorKind
  status?: number            // http only
  code?: number              // envelope code
  serverMessage?: string     // envelope message
  body?: string              // raw body text, truncated to a configurable cap
  url?: string
  method?: string
  requestId?: string         // from a response header if the venue sets one
  cause?: unknown
}
```

Plus narrow type guards (`isHttpError`, `isAuthError`, …). Status-specific subclasses are
unnecessary — `kind === "http" && status === 404` reads fine and avoids seven exported classes.
Retryability is a **function** of the error (`isRetryable(err)`), not a class.

## A′2. `WSAccountAssets` — spot balance stream

WebSocket message for the account-assets channel.

**Message types:** `subscribed/account_all_assets` (snapshot) and `update/account_all_assets`
(update). Any other `type` on this decoder is an error: "invalid type {t} for WSAccountAssets".

**Wire shape:**
```
{
  "type":    "subscribed/account_all_assets" | "update/account_all_assets",
  "channel": "account_all_assets:<accountIndex>",
  "assets":  { "<symbol>": AccountAsset, ... }
}
```

`account_id` is **not a wire field** — it is **derived** by splitting `channel` on `":"` and parsing
the second segment as an integer. (The subscribe frame, by symmetry with the order-book channel,
uses `/`: `{"type":"subscribe","channel":"account_all_assets/<accountIndex>"}` — the inbound
separator is `:`.) Our decoder MUST accept both separators on inbound, exactly as the order-book
channel parser does (A9.5).

`AccountAsset` (all fields required):
```
symbol         : string
asset_id       : integer
balance        : string      // decimal string
locked_balance : string      // decimal string
margin_balance : string      // decimal string
margin_mode    : string
```

`assets` is a **map keyed by symbol**, not an array. An `update` carries only the changed symbols —
merge by symbol into the current state; it does **not** replace the map. (The reference has no
merge logic at all, it just replaces the whole message object, which loses unchanged assets. Flag
as a **DEFECT**; our stream keeps a merged snapshot and emits both the delta and the merged view.)

Unknown top-level keys are preserved in an `extra` bag rather than dropped, so a venue-side addition
does not silently vanish.

## A′3. Referral surface

Seven endpoints. `auth` here is Lighter's L2 auth token (see spec `05`); it is passed either as the
`Authorization` **header** or, on some endpoints, as an `auth` **query/form field** — the two are
not interchangeable per endpoint, so the table below is normative.

| Method | Path | Auth carrier | Inputs | Response |
|---|---|---|---|---|
| POST | `/api/v1/referral/create` | `Authorization` header (optional) + `auth` form field | form: `account_index` (int, **req**), `auth` (string) | `ReferralCode` |
| GET | `/api/v1/referral/get` | `authorization` **query** param, or `auth` query param | query: `account_index` (int, **req**), `authorization`, `auth` | `ReferralCode` |
| POST | `/api/v1/referral/update` | header + form `auth` | form: `account_index` (**req**), `new_referral_code` (string, **req**), `auth` | `RespUpdateReferralCode` |
| POST | `/api/v1/referral/kickback/update` | header + form `auth` | form: `account_index` (**req**), `kickback_percentage` (number, **req**), `auth` | `RespUpdateKickback` |
| POST | `/api/v1/referral/use` | header + form `auth` | form: `l1_address` (**req**), `referral_code` (**req**), `x` (**req**), `discord`, `telegram`, `signature`, `auth` | `ResultCode` |
| GET | `/api/v1/referral/points` | `Authorization` header (**req**) | query: `account_index` (**req**) | `ReferralPoints` |
| GET | `/api/v1/referral/userReferrals` | `Authorization` header + `auth` query | query: `l1_address` (**req**), `cursor`, `auth`, `stats_start_timestamp`, `stats_end_timestamp`, `limit` | `UserReferrals` |

Note `/referral/get` is the outlier: its auth goes in a **query parameter named `authorization`**,
not a header. Reproduce exactly.

All POSTs in this group are `application/x-www-form-urlencoded`, **not JSON**.

**Response shapes:**
```
ReferralCode           { code: int*, message?: string, referral_code: string*, remaining_usage: int* }
RespUpdateReferralCode { code: int*, message?: string, success: boolean* }
RespUpdateKickback     { code: int*, message?: string, success: boolean* }
ReferralPoints         { referrals: ReferralPointEntry[]*, user_total_points: number*,
                         user_last_week_points: number*, user_total_referral_reward_points: number*,
                         user_last_week_referral_reward_points: number*,
                         reward_point_multiplier: string* }
ReferralPointEntry     { l1_address: string*, total_points: number*, week_points: number*,
                         total_reward_points: number*, week_reward_points: number*,
                         reward_point_multiplier: string* }
UserReferrals          { code: int*, message?: string, cursor: string*, referrals: Referral[]*, used_code: string* }
Referral               { l1_address: string*, referral_code: string*, used_at: int*,
                         trade_stats: TradeStats*, tier: string* }
```
(`*` = required. `reward_point_multiplier` is a **string** while the point fields are numbers —
reproduce, do not normalise.)

**Kickback rate limit:** the monorepo's own operational script notes the kickback percentage can be
changed at most **once per day**. Our client MUST NOT retry a rejected kickback update
automatically; surface the error.

`used_at` and the `stats_*_timestamp` params are Unix **seconds** (integer). Model timestamps as
`number` at the wire boundary and expose a `Date` accessor; do not silently convert, since a
seconds/milliseconds mixup here is a classic bug.

## A′4. RFQ surface

Five endpoints, all requiring the `Authorization` header, all POSTs form-urlencoded. Note they are
tagged `account` in the OpenAPI document but are logically their own module.

| Method | Path | Inputs | Response |
|---|---|---|---|
| POST | `/api/v1/rfq/create` | form: `market_index` (int, **req**), `direction` (int, **req**), `base_amount` (string), `quote_amount` (string), `metadata` (string) | `RespCreateRFQ` |
| GET | `/api/v1/rfq/get` | query: `rfq_id` (int, **req**) | `RespGetRFQ` |
| GET | `/api/v1/rfq/list` | query: `account_index` (int), `status` (string), `cursor` (string), `limit` (int) | `RespListRFQs` |
| POST | `/api/v1/rfq/respond` | form: `rfq_id` (int, **req**), `status` (string, **req**) | `RespRespondToRFQ` |
| POST | `/api/v1/rfq/update` | form: `rfq_id` (int, **req**), `status` (string, **req**) | `RespUpdateRFQ` |

**Shapes:**
```
RFQEntry { id: int*, account_index: int*, market_index: int*, direction: int*,
           base_amount: string*, quote_amount: string*, status: string*,
           metadata: RFQMetadata*, responses: RFQResponseEntry[]*,
           created_at: int*, updated_at: int* }

RFQResponseEntry { account_index: int*, status: string*, responded_at: int*, updated_at: int* }

RFQMetadata { requested_est_price: string*, requested_max_slippage: string*,
              requested_slippage: string*, worst_price: string* }

RespCreateRFQ / RespGetRFQ / RespRespondToRFQ / RespUpdateRFQ
    = { code: int*, message?: string } & (RFQEntry fields, flattened at the top level)

RespListRFQs = { code: int*, message?: string, rfqs: RFQEntry[]*, next_cursor?: string }
```

Note the request field is `metadata: string` (a serialised blob) while the **response** field
`metadata` is a structured `RFQMetadata` object. That asymmetry is real; reproduce it.

`direction` is an integer with the same encoding as order side (`0` = buy/bid, `1` = sell/ask) —
confirm against a live sample before release (Open Question). `status` is a free-form string on the
wire; model it as a `string` union with the observed values plus `(string & {})` so an unknown
server value does not break decoding.

RFQ eligibility is gated per account: `AccountMetadata.can_rfq: boolean` and
`can_rfq_market_ids: string[]`, and per market: `MarketConfig.rfq_enabled: boolean` inside
`PerpsOrderBookDetail.market_config`.

## A′5. Lease / LIT surface

| Method | Path | Auth | Inputs | Response |
|---|---|---|---|---|
| GET | `/api/v1/leaseOptions` | none | none | `RespGetLeaseOptions` |
| GET | `/api/v1/leases` | `Authorization` header (optional) + `auth` query | query: `account_index` (int, **req**), `cursor`, `limit`, `auth` | `RespGetLeases` |
| POST | `/api/v1/litLease` | `Authorization` header | form: `tx_info` (string, **req**), `lease_amount` (string, **req**), `duration_days` (int, **req**) | `TxHash` |

```
RespGetLeaseOptions { code: int*, message?: string, options: LeaseOptionEntry[]*,
                      lit_incentives_account_index: int* }
LeaseOptionEntry    { duration_days: int*, annual_rate: number* }

RespGetLeases       { code: int*, message?: string, leases: LeaseEntry[]*, next_cursor?: string }
LeaseEntry          { id: int*, master_account_index: int*, lease_amount: int*, fee_amount: int*,
                      start: int*, end: int*, status: string*, error: string* }
```

`litLease` is the only endpoint in this group that carries a **signed transaction**: `tx_info` is
the canonical signed tx-info JSON string produced by the transaction layer (spec `02`), submitted
as a form field rather than through `sendTx`. Its response is a `TxHash`. The high-level client
therefore needs a `leaseLit({ leaseAmount, durationDays })` that signs the appropriate tx type and
posts here — it does **not** go through `/api/v1/sendTx`.

`LeaseEntry.lease_amount` and `fee_amount` are **integers** (base units), while the request's
`lease_amount` is a **string**. `start`/`end` are Unix seconds. `error` is a required field that is
an empty string on success.

## A′6. Staking surface

Staking is **not a REST surface** — it is two transaction types plus the public-pool read
endpoints.

**Transactions** (signing owned by spec `02`; listed here so nothing is missed):
- `StakeAssets(publicPoolIndex: int64, shareAmount: int64, ...)`
- `UnstakeAssets(publicPoolIndex: int64, shareAmount: int64, ...)`

Both take the standard tail: `skipNonce` (uint8), `nonce` (int64), `apiKeyIndex` (uint8),
`accountIndex` (int64). The public-pool index is a large integer (an example in the reference
material is `281474976624800`, which is `> 2^48` — it exceeds `Number.MAX_SAFE_INTEGER`? No:
`2^53 − 1 ≈ 9.0e15` and `2.8e14 < 9.0e15`, so it is representable — but pool indices are declared
`int64` and MUST be handled as `bigint` throughout the tx layer regardless).

**Reads:**
- `GET /api/v1/publicPoolsMetadata` — query: `filter` (string), `index` (int, **req**),
  `limit` (int, **req**), `account_index` (int), `Authorization` header (optional)
  → `RespPublicPoolsMetadata`
- Models involved: `PublicPoolInfo`, `PublicPoolMetadata`, `PublicPoolShare`, `PendingUnlock`,
  `SharePrice`.

The high-level client exposes `stake({ publicPoolIndex, shareAmount })` and
`unstake({ publicPoolIndex, shareAmount })`, each returning `{ txHash, txInfo, response }`.
Unstaking produces a `PendingUnlock` — surface the unlock timing from `PublicPoolInfo` rather than
leaving the caller to guess.

## A′7. Announcements

```
GET /api/v1/announcement        (singular path, plural payload)
    no parameters, no auth
    -> Announcements { code: int*, message?: string, announcements: Announcement[]* }
       Announcement  { title: string*, content: string*, created_at: int*, expired_at: int* }
```

`created_at` / `expired_at` are Unix seconds. `content` may contain markup — the SDK returns it
verbatim and does not sanitise; document that consumers rendering it in a browser must sanitise.
Provide a convenience `getActiveAnnouncements(now = Date.now()/1000)` filtering
`expired_at === 0 || expired_at > now` (confirm the "never expires" sentinel — Open Question).

## A′8. Notifications

The only notification REST endpoint is the acknowledgement:

```
POST /api/v1/notification/ack        content-type: application/x-www-form-urlencoded
    Authorization header (optional) + `auth` form field
    form: notif_id (string, req), account_index (int, req), auth (string)
    -> ResultCode
```

There is **no list-notifications endpoint**. Notifications are therefore delivered over the
WebSocket (channel naming to be confirmed — Open Question), and the REST call exists solely to mark
one as read. The SDK MUST document this asymmetry; a user looking for `listNotifications()` will
otherwise assume the SDK is incomplete.

`notif_id` is a **string**, not an integer.

## A′9. Token list

```
GET /api/v1/tokenlist        no parameters, no auth
    -> TokenList { code: int*, message?: string, tokens: Token[]* }

Token {
  symbol: string*, name: string*, logo: string*, logo_extension: string*,
  description_key: string*, gecko_id: string*, paprika_id: string*,
  market: string*, asset_type: string*, categories: string[]*,
  is_allowed_mainnet: boolean*, is_asset_allowed_mainnet: boolean*
}
```

`logo` + `logo_extension` are separate fields that must be concatenated to form a usable asset
reference. `gecko_id` / `paprika_id` are external price-oracle identifiers (CoinGecko /
CoinPaprika). This endpoint is static enough to cache aggressively; the SDK SHOULD accept a
`cacheTtlMs` and default it to something long (e.g. 1 hour) for this one endpoint only.

## A′10. API tokens (REST-auth credentials, distinct from L2 API keys)

These are bearer tokens for the REST API, **not** the Poseidon/Schnorr L2 API keys used for signing
transactions. Do not conflate the two in naming: call them `ApiToken` and `L2ApiKey` respectively.

| Method | Path | Inputs | Response |
|---|---|---|---|
| GET | `/api/v1/tokens` | `Authorization` header (optional), query `account_index` (**req**) | `RespGetApiTokens` |
| POST | `/api/v1/tokens/create` | form: `name` (**req**), `account_index` (**req**), `expiry` (int, **req**), `sub_account_access` (bool, **req**), `scopes` (string) | `RespPostApiToken` |
| POST | `/api/v1/tokens/revoke` | form: `token_id` (int, **req**), `account_index` (int, **req**) | `RespRevokeApiToken` |

```
ApiToken { token_id: int*, api_token: string*, name: string*, account_index: int*,
           expiry: int*, sub_account_access: boolean*, revoked: boolean*, scopes: string* }
RespGetApiTokens   { code*, message?, api_tokens: ApiToken[]* }
RespPostApiToken   { code*, message?, ...ApiToken fields flattened }
RespRevokeApiToken { code*, message?, token_id: int*, revoked: boolean* }
```

`api_token` is the **secret**. It MUST never be logged. The SDK's request/response logging hook
MUST have a redaction list covering `api_token`, `auth`, `authorization`, `signature`, and
`private_key`, applied before anything reaches a user-supplied logger.

`scopes` is a single string (delimiter unspecified — Open Question). `expiry` is Unix seconds.

## A′11. Account tier and maker-only keys

```
POST /api/v1/changeAccountTier   form: account_index (req), new_tier (string, req), auth
     Authorization header (optional)
     -> RespChangeAccountTier { code: int*, message?: string }

GET  /api/v1/getMakerOnlyApiKeys   Authorization header (req), query account_index (req)
     -> RespGetMakerOnlyApiKeys

POST /api/v1/setMakerOnlyApiKeys   Authorization header (req)
     content-type: application/x-www-form-urlencoded  OR  multipart/form-data
     form: account_index (int, req), api_key_indexes (STRING, req), auth
     -> RespSetMakerOnlyApiKeys { code: int*, message?: string }
```

`api_key_indexes` is a **string** carrying a list (comma-separated — confirm, Open Question), not a
JSON array and not repeated form fields. The SDK MUST accept `number[]` from the caller and
serialise it, with the exact delimiter locked by a conformance fixture.

`setMakerOnlyApiKeys` is the only endpoint in the whole surface that also accepts
`multipart/form-data`. Use `application/x-www-form-urlencoded` — it is supported everywhere and
avoids `FormData` boundary differences between runtimes.

`new_tier` values map to the `AccountTier` names in A2.1 (confirm casing — Open Question).

## A′12. Account metadata

```
POST /api/v1/setAccountMetadata      content-type: application/json    <-- the ONLY JSON POST
     Authorization header (optional)
     body: { master_account_index: int*, target_account_index: int*, api_key_index: int*,
             metadata: string*, auth?: string }
     -> ResultCode

GET  /api/v1/accountMetadata   query: by (req), value (req), cursor; Authorization header
     -> AccountMetadatas
AccountMetadata { account_index: int*, name: string*, description: string*, can_invite: boolean*,
                  referral_points_percentage: string*, created_at: int*,
                  can_rfq: boolean*, can_rfq_market_ids: string[]* }
```

Every other POST in the API is form-urlencoded. The request-builder MUST therefore be
content-type-aware per operation, not globally configured — hardcoding form encoding breaks this
endpoint and hardcoding JSON breaks everything else.

`can_rfq_market_ids` is an array of **strings** even though market ids are integers everywhere else.
Reproduce the wire type; expose a parsed `number[]` accessor.

## A′13. Funding rates (read)

```
GET /api/v1/funding-rates      no parameters, no auth      <-- note the HYPHEN, unlike every other path
    -> FundingRates { code: int*, message?: string, funding_rates: FundingRate[]* }
       FundingRate  { market_id: int*, exchange: string*, symbol: string*, rate: number* }
```

The path uses a hyphen (`funding-rates`) while `fundings`, `orderBookDetails` etc. use camelCase or
single words. A generated path helper that camelCases will get this wrong; the path table must be
literal strings.

`rate` is a JSON **number** (not a string), unlike almost every other numeric quantity in this API.
This is the input to A10.

## A′14. Endpoint profiles

Four named profiles (owned by spec `07`, restated because the paper client's WS URL derivation
depends on them):

| Name | REST base | WS URL | chain id |
|---|---|---|---|
| `mainnet` (default) | `https://mainnet.zklighter.elliot.ai` | `wss://mainnet.zklighter.elliot.ai/stream` | 304 |
| `testnet` | `https://testnet.zklighter.elliot.ai` | `wss://testnet.zklighter.elliot.ai/stream` | 300 |
| `robinhood` | `https://api.rh.lighter.xyz` | `wss://api.rh.lighter.xyz/stream` | 466324 |
| `robinhood_testnet` | `https://api.rh-testnet.lighter.xyz` | `wss://api.rh-testnet.lighter.xyz/stream` | 300 |

Base URLs are normalised by stripping trailing `/`. Note `testnet` and `robinhood_testnet` share
chain id 300 — chain id alone does not identify a profile.

Also: `GET /` → `Status { status: int*, network_id: int*, timestamp: int* }` and `GET /info` — both
outside `/api/v1`.

---

# PART B — TypeScript Project and Developer-Experience Skeleton

## B0. Observed monorepo conventions (evidence)

Everything in this section was read from `/Users/joeblau/Developer/lev7/src/monorepo`. Nothing is
assumed.

**Package manager and runtime**
- `package.json:5` — `"packageManager": "bun@1.3.0"`. Bun is pinned exactly, not ranged.
- `package.json:6-11` — workspaces are `workers/*`, `packages/*`, `contracts`, `db`.
  **`packages/` is declared but does not exist on disk** — it is the reserved slot for shared
  libraries.
- `bunfig.toml:4` — `linker = "hoisted"` with a comment explaining that flat `node_modules` is
  required because nested duplicate `viem` copies produce mutually incompatible types. A published
  library with **zero runtime dependencies** sidesteps this class of problem entirely, which is a
  concrete argument for the zero-dep constraint.

**Task runner**
- `package.json:26` — `turbo ^2.10.5` (dev dependency, root only).
- `turbo.json:23-27` — the `test` task `dependsOn: ["^build"]`, `outputs: []`.
- `turbo.json:29-32` — `lint` `dependsOn: ["^build"]`.
- `turbo.json:34-36` — `fmt` is `cache: false`.
- `package.json:13-19` — root scripts are thin `turbo run <task>` wrappers: `build`, `dev`, `test`,
  `lint`, `fmt`, `clean`, `chain`.
  So a package that ships `build` / `test` / `lint` / `fmt` / `clean` scripts is automatically
  wired into the monorepo pipeline with no turbo.json change.

**TypeScript baseline** — the plain (non-Next) workers are the house TS baseline, and
`workers/balance/tsconfig.json` and `workers/governance/tsconfig.json` are **byte-identical**:
- `:3` `"target": "ES2022"`, `:4` `"lib": ["ES2022"]`, `:5` `"module": "ES2022"`,
  `:6` `"moduleResolution": "bundler"`, `"types": ["@cloudflare/workers-types"]`,
  `:8` `"strict": true`, `:9` `"noEmit": true`, `:10` `"skipLibCheck": true`,
  `"esModuleInterop": true`, `:12` `"isolatedModules": true`, `"resolveJsonModule": true`,
  `:14` `"forceConsistentCasingInFileNames": true`.
- `db/tsconfig.json` is the same shape with `:7 "types": ["bun-types"]`.
- Notably absent everywhere: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noImplicitOverride`, `isolatedDeclarations`. `strict: true` is the
  ceiling in this house today.

**Lint and format — this is the most important finding, and it is a negative result**
- There is **no formatter anywhere in the monorepo for TypeScript**. An exhaustive search for
  `biome.json*`, `.prettierrc*`, `prettier.config*`, `dprint.json`, `.editorconfig`, `oxlint*`
  across the repo (excluding `node_modules`) returns **zero** matches.
- The only lint configuration is three `eslint.config.mjs` files — `workers/web`, `workers/admin`,
  `workers/docs` — and all three are Next-specific:
  `workers/web/eslint.config.mjs:1-3` imports `eslint/config`, `eslint-config-next/core-web-vitals`,
  and `eslint-config-next/typescript`; `:9-21` is a `globalIgnores` list of build outputs. There is
  **no** shared/base ESLint config, and nothing that would apply to a non-Next package.
- For **non-Next TypeScript packages the `lint` script is literally the typechecker**:
  `workers/balance/package.json:9` and `workers/governance/package.json:8` both define
  `"lint": "tsc --noEmit"`.
- Solidity is the exception and has real formatting: `contracts/package.json` defines
  `"fmt": "forge fmt"` and `"lint": "forge fmt --check"`.

**Test runner — also a negative result**
- A repo-wide grep for `bun:test` and `bun test` across `*.json`, `*.ts`, `*.yml`, `*.md`
  (excluding `node_modules`) returns **zero** hits.
- The only JS/TS `test` script in the monorepo is `workers/docs/package.json:13` —
  `"test": "bun run typecheck"`, where `:12 typecheck` is `fumadocs-mdx && next typegen && tsc --noEmit`.
- `contracts/package.json` has `"test": "forge test -vvv"`.
- So: **there is currently no JavaScript/TypeScript test suite anywhere in the monorepo.** The
  `turbo.json` `test` task exists and is wired, but nothing implements it. `bun:test` would be new,
  and is the obviously correct choice given Bun 1.3 is already the pinned runtime.

**Dependency versions in workers**
- `@cloudflare/workers-types: ^4`, `typescript: ^5`, `wrangler: ^4.113.0` (identical across
  `workers/balance`, `workers/governance`, `workers/web`, `workers/admin`, `workers/docs`).
- `@opennextjs/cloudflare: ^1.20.1` for the Next-on-Workers packages.

**CI conventions**
- Five workflows: `deploy.yml`, `preview.yml`, `db-check.yml`, `points.yml`, `lighter-account.yml`.
- Actions are pinned by **major tag**, not SHA: `actions/checkout@v4` (`deploy.yml:17`,
  `preview.yml:29`, `db-check.yml:34`, `points.yml:21`), `oven-sh/setup-bun@v2` (`deploy.yml:20`,
  `preview.yml:32`, `db-check.yml:37`, `points.yml:24`), `actions/setup-node@v4`,
  `cloudflare/wrangler-action@v3` (five uses in `deploy.yml`).
  (For contrast, the Go reference SDK pins actions by full SHA — the monorepo does not. **Match the
  monorepo.**)
- `bun-version: "1.3.0"` is pinned in every Bun-using workflow (`deploy.yml:22`, `preview.yml:34`,
  `db-check.yml:39`, `points.yml:26`).
- Install is always `bun install --frozen-lockfile` (`deploy.yml:31`, `preview.yml:43`,
  `db-check.yml:42`, `points.yml:29`).
- Node is set up **separately and additionally** where a Node-only build step exists, with an
  explicit comment at `deploy.yml:24` — "next build runs on Node even though Bun is the task
  runner" — and `node-version: 22` (`deploy.yml:28`, `preview.yml:40`).
- Concurrency groups are used deliberately: `deploy.yml:8-10` uses
  `group: deploy-production, cancel-in-progress: false`; `preview.yml:20-22` uses
  `group: deploy-testnet, cancel-in-progress: true`.
- Workflows carry **long explanatory comment headers** describing intent and failure modes
  (`db-check.yml:3-8`, `deploy.yml:33-39`, `preview.yml:3-13`). This is a real house style and the
  new repo's workflows should match it.
- `db-check.yml` runs only on `pull_request` with a `paths:` filter (`:10-13`).

**Direct evidence that this project is the replacement for existing scaffolding**
- `workers/lighter-signer/` exists with `wasm/lighter-signer.wasm` and `wasm/wasm_exec.js`
  checked in, and **empty `src/` and `scripts/` directories** — a Go-WASM signer stopgap that was
  started and never finished. `lighter-ts` replaces it.
- `scripts/lighter/` contains `create_lighter_account.py`, `deposit_via_intent_address.py`,
  `set_referral_code.py`, and `requirements.txt` — Python, driven by
  `.github/workflows/lighter-account.yml` which sets up **Python 3.11**
  (`lighter-account.yml:101-105`) and `pip install -r scripts/lighter/requirements.txt` (`:108`).
  These three scripts are the migration target: `register API key`, `deposit`, `referral` modes
  (`lighter-account.yml:28-33`).

**Miscellaneous**
- All monorepo packages are `"private": true`, version `0.1.0` (or `0.0.0` at root). `lighter-ts`
  will be the **first publishable package in the org**.
- `.gitignore` covers `node_modules/`, `.turbo/`, `*.tsbuildinfo`, `coverage/`, `.wrangler/`,
  `.env`/`.env.*` with `!.env.example`, `.DS_Store`.
- Only one submodule exists (`.gitmodules`: `contracts/lib/forge-std`) — the house does not use
  submodules for JS dependencies.

## B1. Package name

**Recommendation: `lighter-ts`** (unscoped), matching the repository name `lev7finance/lighter-ts`.

Rationale:
- The differentiator is "the pure-TypeScript Lighter SDK — no native binary, no WASM". That claim is
  discoverability-driven; an unscoped, literal name (`npm i lighter-ts`) maximises it. A scoped
  `@lev7/lighter` reads as an internal package and buries the pitch.
- The repo name and package name matching removes a whole category of confusion in issues, docs,
  and search.
- It costs nothing: the monorepo consumes it as a normal dependency either way.

Fallback if the name is unavailable on npm: publish as `@lev7/lighter` and keep the repo name.
Do **not** publish both — a duplicate under two names splits issues and version history.

`packageManager` field: `bun@1.3.0`, matching `monorepo/package.json:5` exactly.

## B2. `package.json`

```jsonc
{
  "name": "lighter-ts",
  "version": "0.1.0",
  "description": "Pure-TypeScript SDK for the Lighter exchange. Zero native dependencies, zero runtime dependencies. Runs on Bun, Node, Deno, Cloudflare Workers, and browsers.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/lev7finance/lighter-ts.git" },
  "homepage": "https://github.com/lev7finance/lighter-ts#readme",
  "bugs": { "url": "https://github.com/lev7finance/lighter-ts/issues" },
  "keywords": ["lighter", "zklighter", "perpetuals", "dex", "trading", "sdk",
               "poseidon", "schnorr", "typescript", "cloudflare-workers", "bun", "deno"],

  "type": "module",
  "sideEffects": false,
  "packageManager": "bun@1.3.0",
  "engines": { "node": ">=20.11.0", "bun": ">=1.1.0" },

  "exports": {
    ".":              { "types": "./dist/index.d.ts",            "default": "./dist/index.js" },
    "./crypto":       { "types": "./dist/crypto/index.d.ts",     "default": "./dist/crypto/index.js" },
    "./codec":        { "types": "./dist/codec/index.d.ts",      "default": "./dist/codec/index.js" },
    "./tx":           { "types": "./dist/tx/index.d.ts",         "default": "./dist/tx/index.js" },
    "./rest":         { "types": "./dist/rest/index.d.ts",       "default": "./dist/rest/index.js" },
    "./ws":           { "types": "./dist/ws/index.d.ts",         "default": "./dist/ws/index.js" },
    "./client":       { "types": "./dist/client/index.d.ts",     "default": "./dist/client/index.js" },
    "./paper":        { "types": "./dist/paper/index.d.ts",      "default": "./dist/paper/index.js" },
    "./models":       { "types": "./dist/models/index.d.ts",     "default": "./dist/models/index.js" },
    "./errors":       { "types": "./dist/errors.d.ts",           "default": "./dist/errors.js" },
    "./package.json": "./package.json"
  },

  "files": ["dist", "src", "README.md", "LICENSE", "CHANGELOG.md"],

  "scripts": {
    "build":        "bun run clean && tsc -p tsconfig.build.json",
    "clean":        "rm -rf dist *.tsbuildinfo",
    "lint":         "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.bundler.json --noEmit",
    "test":         "bun test",
    "test:node":    "node --experimental-strip-types test/portability/run-vectors.ts",
    "test:deno":    "deno run --allow-read test/portability/run-vectors.ts",
    "test:workerd": "bun run scripts/run-workerd-vectors.ts",
    "test:all":     "bun run test && bun run build && bun run test:node && bun run test:deno && bun run test:workerd",
    "vectors:gen":  "bun run tools/gen-vectors.ts",
    "size":         "bun run scripts/report-size.ts",
    "prepublishOnly": "bun run lint && bun run test && bun run build"
  },

  "dependencies": {},
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "@types/node": "^20",
    "typescript": "^5.7.0",
    "wrangler": "^4.113.0"
  },

  "publishConfig": { "access": "public", "provenance": true }
}
```

Notes on each decision:

- **`"dependencies": {}` is a hard constraint, enforced in CI.** A test asserts the object is empty.
  `peerDependencies` and `optionalDependencies` are likewise empty.
- **`"sideEffects": false`** is what makes every bundler tree-shake unused subpaths. It is only
  truthful because the library performs no top-level work — no module-scope `fetch`, no global
  registration, no polyfill installation. That is a design rule, not just a manifest field.
- **`exports` has no `require` condition.** ESM-only (B4).
- **No `"main"`, no `"module"`, no `"types"` top-level fields.** They are legacy fallbacks that
  bypass `exports` in old resolvers and cause dual-package hazards. `exports` alone.
- **`./package.json` is exported** because some tooling reads it and `exports` otherwise blocks it.
- **`files` includes `src`** so `declarationMap` + `sourceMap` resolve to real sources in a
  consumer's editor and debugger. It costs ~200 KB unpacked and is worth it.
- **`engines.node: ">=20.11.0"`** — 20.11 is the first Node 20 with `import.meta.dirname` and a
  stable `--experimental-strip-types` story on the 22 line; more importantly it is well past the
  point where `fetch`, `WebSocket` (22+), `crypto.subtle`, and full ESM are stable. Node 20 itself
  lacks a global `WebSocket` (it landed in 22), so the WS layer MUST accept an injected
  `WebSocket` constructor (spec `04`) and the README MUST say `ws` is needed on Node 20 — a
  **dev**/peer concern for the consumer, not a dependency of ours.
- **`prepublishOnly`** gates publishing on lint + test + build even if someone publishes locally.
- **`publishConfig.provenance: true`** plus `id-token: write` in the publish workflow gives npm
  provenance attestation, which is the right posture for a package that signs financial
  transactions.

**Scripts alignment with the monorepo:** `build`, `test`, `lint`, `clean` match the turbo task names
in `turbo.json`, so if the package is ever vendored into `monorepo/packages/`, `turbo run test`
picks it up with zero configuration. There is deliberately **no `fmt` script** — the monorepo has no
TS formatter (B0), so an empty/no-op `fmt` would be noise.

## B3. TypeScript configuration

Three configs. One is the source of truth, one is the build, one is a compatibility check.

### `tsconfig.json` — source of truth (typecheck, editor)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "nodenext",
    "moduleResolution": "nodenext",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,

    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "isolatedDeclarations": true,
    "erasableSyntaxOnly": true,

    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "tools/**/*.ts", "examples/**/*.ts"]
}
```

**`target: "ES2022"`** — matches the house baseline exactly (`workers/balance/tsconfig.json:3`).
ES2022 gives us `Array.prototype.at`, `Object.hasOwn`, class fields, top-level `await`, and
`Error.cause`, all of which are available on Bun, Node 20, Deno, workerd, and every browser we care
about. Going higher (ES2023's `findLast`, ES2024's `groupBy`) buys nothing we need and narrows
browser support.

**`lib: ["ES2022", "DOM", "DOM.Iterable"]`** — deviates from the house `["ES2022"]` because this
library must compile against `fetch`, `Response`, `Headers`, `WebSocket`, `AbortController`,
`URL`, `crypto.subtle`, `TextEncoder`, and `ReadableStream`. Those live in `DOM` in stock
TypeScript. `@cloudflare/workers-types` is a **devDependency for the workerd portability test
only** — it must NOT be in `types`, because forcing consumers into Workers types would break Node
consumers. `"types": []` is deliberate: no ambient `@types/*` leaks into the library's own
compilation, so nothing in `dist/*.d.ts` can reference a type the consumer does not have.

**`module`/`moduleResolution`: `nodenext`, NOT `bundler`.** This is a **deliberate deviation** from
the house convention (`workers/balance/tsconfig.json:6` uses `bundler`), and the justification is
specific:

> Every existing house tsconfig is for an **application** with `noEmit: true`, consumed by a
> bundler (Next/OpenNext or wrangler's esbuild). Those apps never publish `.js` to a consumer, so
> extensionless relative imports are harmless. `lighter-ts` is the **first published library** in
> the org: its emitted `.js` is loaded directly by Node's ESM loader and by Deno, both of which
> require **fully-specified** relative specifiers (`./foo.js`, not `./foo`). `bundler` resolution
> *permits* extensionless imports, so it would let us author code that typechecks perfectly and
> then fails at runtime on two of our five targets. `nodenext` makes the compiler reject the
> mistake at authoring time. It also validates the `exports` map itself — self-referential imports
> and subpath conditions are checked. Bundlers, Bun, and workerd all accept fully-specified
> specifiers, so `nodenext` is strictly safer with no downside.

Every relative import in `src/` therefore carries an explicit `.js` extension (pointing at the
emitted file, per TypeScript's normal convention).

**`isolatedDeclarations: true` — enabled from day one.** Feasibility assessment: this requires an
explicit type annotation on every exported declaration whose type TypeScript would otherwise have to
infer. For a hand-written library this is entirely achievable and is a *good* constraint — it forces
the public API surface to be written down rather than inferred, which is exactly what we want for a
protocol SDK. Concrete accommodations required:

- Every exported function needs an explicit return type. (~200 functions; a one-time cost.)
- Exported `const` objects need `as const satisfies SomeType` or an explicit annotation. The enum
  substitutes in A2.2 are written this way anyway.
- Re-exports must use `export type { X }` / `export { y }` explicitly — which
  `verbatimModuleSyntax` already forces.
- Generated model types (`src/models/`) are emitted by our own generator, which emits explicit
  annotations by construction.

The payoff: `.d.ts` emit becomes a per-file, parallelisable, non-type-checking transform, which
makes `tsc --build` fast and makes future alternative emitters (`oxc`, `swc` dts) viable. Retrofitting
`isolatedDeclarations` onto 200 files later is a miserable multi-day change; enabling it on an
empty repository costs nothing. **Enable it.**

**`erasableSyntaxOnly: true`** — forbids `enum`, `namespace`, parameter properties, and other
non-erasable TypeScript syntax. This is what makes the source runnable under Node's
`--experimental-strip-types`, Deno's native TS, and Bun's transpiler without semantic surprises.
It is also why A2.2 mandates `const` objects instead of `enum`.

**Strictness beyond the house baseline.** The house stops at `strict: true`. We add
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, and `noPropertyAccessFromIndexSignature`. Justification: this library
does byte-level protocol work and financial arithmetic where an `undefined` from an out-of-range
index is a wrong signature or a wrong balance, not a rendering glitch. `noUncheckedIndexedAccess` in
particular catches the exact class of bug that field-element and order-book-level array indexing
invites. The cost is more explicit narrowing in hot loops — acceptable, and the crypto spec should
note that hot paths may use a documented, localised non-null assertion after a bounds check.

### `tsconfig.build.json` — emit

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "removeComments": false,
    "stripInternal": true
  },
  "include": ["src/**/*.ts"]
}
```

`stripInternal` lets us mark helper exports `@internal` so they are usable across modules inside the
package but absent from the published `.d.ts`.

### `tsconfig.bundler.json` — compatibility check

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "module": "esnext", "moduleResolution": "bundler" }
}
```

Run in `lint` alongside the nodenext check. This proves the library also typechecks under the
resolution mode every consumer in the monorepo actually uses
(`workers/balance/tsconfig.json:5-6`), catching anything that accidentally depends on nodenext-only
resolution behaviour.

## B4. Build and distribution

**Ship ESM only. Do not bundle. Emit with `tsc`.**

- **ESM-only, no CJS.** All five targets are ESM-native. Node 20.11+ loads ESM natively, and
  `require(esm)` is available from Node 20.19/22.12 for the rare CJS consumer. Dual-publishing
  doubles the artifact, creates the dual-package hazard (two copies of every class, `instanceof`
  failures across the boundary — actively dangerous for a library whose errors are checked with type
  guards), and doubles the surface that has to be tested on five runtimes. Not worth it.
  If a CJS consumer appears, the answer is `await import("lighter-ts")`, documented in the README.

- **No bundler — not `bun build`, not `tsup`, not `tsdown`, not `rollup`.** Reasons, in order:
  1. Zero runtime dependencies means there is nothing to bundle *in*. A bundler's core value
     proposition does not apply.
  2. Per-file output preserves tree-shaking granularity at the module level for the consumer's
     bundler. A single concatenated file makes the consumer's tree-shaker work harder and, with
     any impure-looking construct, fail.
  3. Subpath exports map cleanly to real directories. `./paper` → `dist/paper/index.js` is a real
     file with real neighbours, not a synthesised chunk.
  4. Stack traces and source maps point at real files with no chunk-name indirection.
  5. One fewer tool, one fewer config, one fewer devDependency, one fewer thing that breaks on
     upgrade.
  `tsc` emits both `.js` and `.d.ts` in one pass; `bun build` does not emit `.d.ts` at all and would
  require `tsc` anyway.

- **`declarationMap` + `sourceMap` + shipping `src/`** so go-to-definition lands in TypeScript
  source and debugger breakpoints work.

- **Size budget.** `scripts/report-size.ts` computes gzipped size per subpath entry and fails CI on
  a regression beyond a checked-in budget file. Initial budgets (to be calibrated on first build):
  `./crypto` ≤ 24 KB gz, `./codec` + `./tx` ≤ 16 KB gz, `./rest` ≤ 20 KB gz, `./ws` ≤ 8 KB gz,
  `./paper` ≤ 12 KB gz, root barrel ≤ 60 KB gz. The root barrel re-exporting everything is a
  tree-shaking trap for consumers who use one subpath, so the README leads with **subpath imports**
  and the barrel is documented as a convenience.

## B5. Testing

### B5.1 Primary suite — `bun:test`

`bun test` is the runner. Justification: Bun 1.3.0 is already the pinned house runtime
(`monorepo/package.json:5`, every CI workflow), `bun:test` needs zero dependencies and zero config,
it runs `.ts` directly, and it is Jest-compatible enough that contributors need no ramp-up. There is
no incumbent JS test runner in the monorepo to match (B0 — zero `bun:test` hits, the only `test`
script is a typecheck), so this is a greenfield choice and Bun is the obvious one.

Layout: tests live in `test/`, mirroring `src/`. Naming `*.test.ts`.

### B5.2 Portability proof — the part that actually matters

Running the *test framework* on five runtimes is not the goal; proving the *library* behaves
identically on five runtimes is. So the portability artifact is a **framework-free vector runner**:

`test/portability/run-vectors.ts` — a plain module with **no test-framework imports**. It:
1. Loads the checked-in JSON vectors (via `fetch(new URL(...))` on a `file:` URL, or a
   runtime-detected read — a single ~15-line shim covering `Bun.file`, `node:fs`, `Deno.readTextFile`,
   and an inlined bundle for workerd).
2. Executes every vector against the built `dist/`.
3. Prints a summary and exits non-zero on any failure.

The same file runs unmodified under:
- **Bun** — `bun test/portability/run-vectors.ts`
- **Node 20/22/24** — `node --experimental-strip-types test/portability/run-vectors.ts`
  (or against `dist/` with a compiled runner on Node 20 where strip-types is unavailable)
- **Deno** — `deno run --allow-read test/portability/run-vectors.ts`
- **workerd** — `test/portability/worker.ts` wraps it in a `fetch` handler that returns
  `{ total, failures, failed: [...] }` as JSON. `scripts/run-workerd-vectors.ts` starts
  `wrangler dev` (using the house `wrangler ^4.113.0`) against a minimal `wrangler.jsonc`
  (`compatibility_date` pinned, `nodejs_compat` **off** — proving we need no Node shims), hits
  `http://127.0.0.1:<port>/`, and asserts `failures === 0`. Vectors are inlined into the worker
  bundle at build time since Workers have no filesystem.
- **Browsers** — the same worker module, loaded in a headless Chromium page as an ES module,
  reporting to the console. Optional; the workerd run already proves no Node builtins are used.

This design means **one artifact proves portability of the thing we care about**, and we do not have
to maintain a `describe/it/expect` shim across four runtimes.

For a handful of behaviours that are not expressible as vectors (reconnect backoff, abort
propagation, timeout handling), a small `test/portability/behaviour.ts` runs the same way, using
plain assertions.

### B5.3 Cross-language conformance vectors

**Principle:** every byte we put on the wire and every hash we compute is checked against the Go
reference. Vectors are **generated once, checked into the repo as JSON, and never regenerated in
CI** — CI must be hermetic and must not need a Go toolchain.

**Generator:** `tools/gen-vectors/` — a small Go program (checked in, `//go:build tools`, excluded
from the npm `files` list) that links the Go reference SDK and emits deterministic JSON. Regenerating
is a manual, reviewed step: `just vectors` (or `bun run vectors:gen` shelling out to Go), producing
a diff that a human reads. A vector diff in a PR is a **protocol change** and must be treated as
such.

**Vector directory** (`vectors/`, checked in, ~a few hundred KB):

| File | Contents | Owner spec |
|---|---|---|
| `crypto/field.json` | Goldilocks field: add/sub/mul/inv/exp edge cases, modulus boundaries, zero/one, wraparound | 01 |
| `crypto/ext5.json` | Quintic-extension arithmetic | 01 |
| `crypto/poseidon.json` | Permutation on known inputs; sponge absorb/squeeze for lengths 1..16 and rate boundaries | 01 |
| `crypto/keys.json` | Private-key → public-key derivation; key encode/decode round trips; invalid-key rejection | 01 |
| `crypto/schnorr.json` | Deterministic sign + verify for fixed (key, message) pairs; verify-fail mutations | 01 |
| `codec/tx-hash.json` | For every tx type: full field set → hash | 02 |
| `codec/tx-info.json` | For every tx type: full field set → exact canonical `tx_info` JSON **string** (byte-exact, key order included) | 02 |
| `codec/auth-token.json` | Auth-token construction for fixed (deadline, apiKeyIndex, accountIndex) | 05 |
| `rest/requests.json` | For each endpoint: params → exact method, path, query string (with parameter order), content-type, and body | 03 |
| `rest/responses.json` | Captured (redacted) response bodies → decoded object shape | 03/06 |
| `ws/frames.json` | Inbound frame → decoded event; outbound intent → exact frame JSON | 04 |
| `paper/*.json` | Paper-engine scenarios, generated from the **Python** reference (A11) | 08 |

**Comparison rules:** exact for integers, strings, booleans, byte arrays, and hashes. For paper-engine
floats: relative error `<= 1e-12`, or absolute `<= 1e-12` when expected is `0`. Vector files carry a
`generatorVersion` and the reference commit SHA in a header object so a mismatch is traceable.

**`vectors/README.md`** documents: what each file covers, how to regenerate, and the rule that a
vector change requires a linked upstream reference change.

### B5.4 Coverage and CI gates

- `bun test --coverage` with a floor (start at 80 % lines on `src/`, raise over time). Crypto,
  codec, and paper modules should be near 100 % — they are pure functions with vectors.
- CI fails on: any test failure, coverage below floor, a non-empty `dependencies` object, a size
  budget regression, or a typecheck failure under **either** resolution mode.

## B6. Lint and format

**Match the house, which means: the typechecker is the linter, and there is no formatter.**

- `"lint": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.bundler.json --noEmit"` — directly
  mirroring `workers/balance/package.json:9` (`"lint": "tsc --noEmit"`), extended with the second
  resolution mode for the reasons in B3.
- **Do not add ESLint.** The only ESLint configs in the monorepo are Next-specific
  (`eslint-config-next/core-web-vitals` + `/typescript`) and there is no shared base config to
  inherit. Introducing ESLint here would mean owning a config, a plugin set, and a version treadmill
  that nothing else in the org shares — for a package whose entire premise is having no dependencies.
- **Formatting:** no formatter exists in the monorepo for TypeScript (exhaustively verified — B0).
  The zero-friction, house-consistent answer is a short style section in `CONTRIBUTING.md`
  (2-space indent, double quotes, semicolons, trailing commas, 100-column soft wrap — matching what
  the existing worker sources actually look like) and reviewer enforcement.

  **If** the team later wants mechanical formatting, the recommendation is **Biome** — a single
  prebuilt binary, one devDependency, no plugin ecosystem, formats and lints — added as
  `"fmt": "biome format --write ."` / `"lint:style": "biome check ."` so it slots into the existing
  `turbo run fmt` task (`turbo.json:34-36`). Adopting it here would make `lighter-ts` the pilot and
  is a reasonable place to pilot it, but it is **not** required and must not block the first release.

- The compiler flags in B3 (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `isolatedDeclarations`) collectively cover most of what a lint ruleset would catch for this kind
  of code, without a plugin.

## B7. Continuous integration

Two workflows, written in house style: pinned major-version action tags, `oven-sh/setup-bun@v2` with
`bun-version: "1.3.0"`, `bun install --frozen-lockfile`, explicit concurrency groups, and a comment
header explaining intent.

### `.github/workflows/ci.yml`

Triggers: `push` to `main`, `pull_request`, `workflow_dispatch`.
Concurrency: `group: ci-${{ github.ref }}`, `cancel-in-progress: true` (a superseded PR run is
worthless — matching `preview.yml:20-22`'s reasoning).
Permissions: `contents: read`.

Jobs:

1. **`check`** (ubuntu-latest) — the fast gate.
   - `actions/checkout@v4`
   - `oven-sh/setup-bun@v2` with `bun-version: "1.3.0"`
   - `bun install --frozen-lockfile`
   - `bun run lint` (both resolution modes)
   - `bun test --coverage`
   - `bun run build`
   - assert `dependencies` is empty (a one-line script)
   - `bun run size` (budget check)
   - upload `dist/` as an artifact for the runtime matrix jobs

2. **`runtimes`** (matrix, `needs: check`) — the portability proof.
   - matrix: `{ runtime: [bun-1.3.0, bun-latest, node-20, node-22, node-24, deno-latest] }`
   - download the `dist/` artifact
   - set up the matrix runtime (`oven-sh/setup-bun@v2` / `actions/setup-node@v4` /
     `denoland/setup-deno@v2`)
   - run the vector runner against `dist/` and assert zero failures

3. **`workerd`** (`needs: check`) — the Cloudflare proof.
   - `oven-sh/setup-bun@v2` @ 1.3.0, `bun install --frozen-lockfile`
   - download `dist/`
   - `bun run test:workerd` — starts `wrangler dev` locally (workerd, `nodejs_compat` **off**),
     fetches the results endpoint, asserts `failures === 0`
   - a second run with `nodejs_compat` **on** as a smoke test, so we know both configurations work

4. **`examples`** (`needs: check`, PR-only, non-blocking on network) — typecheck every file in
   `examples/` against the built `dist/` so examples cannot rot. Does **not** execute them (they
   hit the live venue).

### `.github/workflows/publish.yml`

Triggers: `release: [published]` and `workflow_dispatch` (with a `dry_run` boolean input defaulting
to `true`, matching the safety posture of `lighter-account.yml:49-53`).
Concurrency: `group: publish`, `cancel-in-progress: false` (never cancel a half-finished publish —
matching `deploy.yml:8-10`).
Permissions: `contents: read`, `id-token: write` (required for npm provenance).

Steps: checkout → setup-bun 1.3.0 → `bun install --frozen-lockfile` → `bun run lint` →
`bun test` → `bun run build` → assert the git tag matches `package.json` version →
`npm publish --provenance --access public` (npm CLI, because Bun's publish does not yet emit
provenance attestations) with `NODE_AUTH_TOKEN` from secrets. On `dry_run`, substitute
`npm publish --dry-run` and stop.

Post-publish: a step that opens/updates a PR in the consuming monorepo bumping the `lighter-ts`
dependency — optional, and only if a bot token exists.

### `.github/dependabot.yml`

`github-actions` ecosystem, weekly. **Not** `npm` — there are no runtime dependencies and the four
devDependencies are pinned by major and reviewed manually.

## B8. Repository layout

```
lighter-ts/
├── .github/
│   ├── workflows/ci.yml                    CI: check, runtime matrix, workerd, examples
│   ├── workflows/publish.yml               npm publish with provenance on release
│   └── dependabot.yml                      github-actions updates only
├── src/
│   ├── index.ts                            Root barrel; re-exports the public API of every subpath
│   ├── errors.ts                           LighterError + LighterErrorKind + type guards (A′1.3)
│   ├── version.ts                          SDK version constant, injected into the User-Agent
│   │
│   ├── crypto/                             [spec 01]
│   │   ├── index.ts                        Public crypto surface
│   │   ├── field.ts                        Goldilocks base-field arithmetic over BigInt
│   │   ├── ext5.ts                         Quintic extension field arithmetic
│   │   ├── poseidon-constants.ts           Round constants and MDS data (protocol constants)
│   │   ├── poseidon.ts                     Poseidon permutation + sponge
│   │   ├── hash.ts                         Domain-separated hashing helpers used by tx hashing
│   │   ├── schnorr.ts                      Schnorr signature generation and verification
│   │   ├── keys.ts                         Key parse/derive/encode; API-key material
│   │   └── random.ts                       CSPRNG wrapper over crypto.getRandomValues
│   │
│   ├── codec/                              [spec 02]
│   │   ├── index.ts                        Public codec surface
│   │   ├── bytes.ts                        Byte-order helpers, hex encode/decode, buffer utilities
│   │   ├── packing.ts                      Integer packing/unpacking into field elements
│   │   ├── tx-types.ts                     Transaction type constants and attribute keys
│   │   ├── tx-hash.ts                      Per-tx-type hash-element ordering
│   │   └── tx-info.ts                      Canonical tx_info JSON serialisation (byte-exact)
│   │
│   ├── tx/                                 [spec 02] one module per transaction type
│   │   ├── index.ts                        Barrel + the TxBuilder union
│   │   ├── create-order.ts                 CreateOrder construction and validation
│   │   ├── cancel-order.ts                 CancelOrder
│   │   ├── cancel-all-orders.ts            CancelAllOrders
│   │   ├── modify-order.ts                 ModifyOrder
│   │   ├── create-grouped-orders.ts        Grouped orders (IOC + attached SL/TP)
│   │   ├── transfer.ts                     Transfer between accounts
│   │   ├── withdraw.ts                     Withdraw
│   │   ├── change-pub-key.ts               ChangePubKey (API-key registration)
│   │   ├── create-sub-account.ts           CreateSubAccount
│   │   ├── update-leverage.ts              UpdateLeverage
│   │   ├── update-margin.ts                UpdateMargin
│   │   ├── update-account-config.ts        UpdateAccountConfig (UTA toggle, etc.)
│   │   ├── update-account-asset-config.ts  Per-asset margin config
│   │   ├── public-pool.ts                  CreatePublicPool / UpdatePublicPool
│   │   ├── shares.ts                       MintShares / BurnShares
│   │   ├── stake.ts                        StakeAssets / UnstakeAssets            [A′6]
│   │   └── approve-integrator.ts           ApproveIntegrator
│   │
│   ├── transport/                          [spec 03]
│   │   ├── index.ts                        Transport barrel
│   │   ├── http.ts                         fetch wrapper: timeouts, abort, User-Agent, redaction
│   │   ├── retry.ts                        Retry policy: which errors, backoff, jitter, budget
│   │   ├── query.ts                        Query-string building with normative parameter order
│   │   ├── form.ts                         application/x-www-form-urlencoded body building [A′3]
│   │   └── url.ts                          Base-URL normalisation and path joining
│   │
│   ├── rest/                               [spec 03] one module per OpenAPI tag
│   │   ├── index.ts                        Barrel; assembles the RestClient facade
│   │   ├── root.ts                         GET /, GET /info                        [A′14]
│   │   ├── account.ts                      /account, /accountLimits, /apikeys, /pnl, /liquidations…
│   │   ├── order.ts                        /orderBook*, /trades, /recentTrades, /export, stats
│   │   ├── transaction.ts                  /sendTx, /sendTxBatch, /nextNonce, /tx*, histories
│   │   ├── block.ts                        /block, /blocks, /currentHeight
│   │   ├── candlestick.ts                  /candles, /fundings
│   │   ├── funding.ts                      GET /api/v1/funding-rates               [A′13]
│   │   ├── info.ts                         /systemConfig, /layer1BasicInfo, /withdrawalDelay…
│   │   ├── bridge.ts                       /deposit/*, /fastbridge/*, /fastwithdraw*, intent addr
│   │   ├── referral.ts                     7 referral endpoints                     [A′3]
│   │   ├── rfq.ts                          5 RFQ endpoints                          [A′4]
│   │   ├── lease.ts                        /leases, /leaseOptions, /litLease        [A′5]
│   │   ├── announcement.ts                 GET /api/v1/announcement                 [A′7]
│   │   ├── notification.ts                 POST /api/v1/notification/ack            [A′8]
│   │   ├── tokenlist.ts                    GET /api/v1/tokenlist                    [A′9]
│   │   └── api-tokens.ts                   /tokens, /tokens/create, /tokens/revoke  [A′10]
│   │
│   ├── ws/                                 [spec 04]
│   │   ├── index.ts                        WS barrel
│   │   ├── socket.ts                       Connection lifecycle, injectable WebSocket ctor
│   │   ├── reconnect.ts                    Exponential backoff with full jitter    [A9.5 remedy]
│   │   ├── channels.ts                     Channel name build/parse (both ':' and '/')
│   │   ├── frames.ts                       Inbound frame decode, outbound frame encode
│   │   ├── order-book-stream.ts            order_book channel → book state
│   │   ├── account-stream.ts               account_all channel → account state
│   │   └── account-assets-stream.ts        account_all_assets channel               [A′2]
│   │
│   ├── client/                             [spec 05/07]
│   │   ├── index.ts                        Client barrel
│   │   ├── endpoints.ts                    The four endpoint profiles + custom      [A′14]
│   │   ├── config.ts                       Client configuration resolution and defaults
│   │   ├── auth.ts                         L2 auth-token creation, caching, expiry
│   │   ├── nonce.ts                        Nonce manager: fetch, cache, increment, skip-nonce
│   │   ├── signer-client.ts                Sign-and-send: one method per tx type
│   │   └── lighter-client.ts               Top-level facade: rest + ws + signer
│   │
│   ├── paper/                              [THIS SPEC — Part A]
│   │   ├── index.ts                        Public paper surface
│   │   ├── types.ts                        Enums, fee tiers, all paper structures   [A2]
│   │   ├── book.ts                         InMemoryOrderBook: normalise, sort, snapshot, delta [A3]
│   │   ├── matching.ts                     simulateMatch + validateOrder            [A4]
│   │   ├── accounting.ts                   applyFill, unrealised PnL, TAV, copies   [A5]
│   │   ├── risk.ts                         IMR/MMR/COMR, health, liq price, liquidate [A7,A8]
│   │   ├── funding.ts                      Opt-in funding application and journal   [A10]
│   │   ├── engine.ts                       Synchronous, I/O-free PaperEngine + state snapshot [A9.6,A9.7]
│   │   ├── client.ts                       PaperClient: REST/WS shell over the engine [A9]
│   │   └── live.ts                         Order-book listener over the shared ws/ socket [A9.5]
│   │
│   ├── models/                             [spec 06] generated from openapi.json
│   │   ├── index.ts                        Barrel of every model type
│   │   ├── common.ts                       ResultCode, envelope helpers, cursor types [A′1.1]
│   │   ├── account.ts                      Account, DetailedAccount, AccountPosition, AccountAsset…
│   │   ├── order.ts                        Order, SimpleOrder, PriceLevel, OrderBook*, Trade…
│   │   ├── market.ts                       PerpsOrderBookDetail, SpotOrderBookDetail, MarketConfig
│   │   ├── transaction.ts                  Tx, EnrichedTx, RespSendTx*, NextNonce, TxHash
│   │   ├── referral.ts                     ReferralCode, Referral, ReferralPoints…   [A′3]
│   │   ├── rfq.ts                          RFQEntry, RFQMetadata, RFQResponseEntry…  [A′4]
│   │   ├── lease.ts                        LeaseEntry, LeaseOptionEntry…             [A′5]
│   │   ├── pool.ts                         PublicPoolInfo, PublicPoolShare, PendingUnlock [A′6]
│   │   ├── misc.ts                         Announcement, Token, ApiToken, FundingRate… [A′7-A′13]
│   │   └── ws.ts                           WS message types incl. WSAccountAssets     [A′2]
│   │
│   └── util/
│       ├── decimal.ts                      Decimal-string ↔ number/bigint at fixed scale
│       ├── assert.ts                       Invariant helpers that throw LighterError
│       ├── json.ts                         Stable-key JSON stringify for canonical serialisation
│       ├── time.ts                         Unix seconds/millis conversion, injectable clock
│       └── redact.ts                       Secret redaction for logging                [A′10]
│
├── test/
│   ├── <mirrors src/>/*.test.ts            Unit tests, bun:test
│   ├── vectors/*.test.ts                   Vector replay per category
│   └── portability/
│       ├── run-vectors.ts                  Framework-free vector runner (all runtimes)
│       ├── behaviour.ts                    Framework-free behavioural checks
│       ├── worker.ts                       fetch handler wrapping the runner, for workerd
│       └── wrangler.jsonc                  Minimal worker config, nodejs_compat off
│
├── vectors/                                Checked-in conformance vectors + README
│   ├── crypto/  codec/  rest/  ws/  paper/
│   └── README.md
│
├── tools/
│   ├── gen-vectors/                        Go generator against the reference SDK (not published)
│   ├── gen-paper-vectors.py                Python generator for paper-engine vectors
│   └── gen-models.ts                       openapi.json → src/models/*.ts
│
├── scripts/
│   ├── run-workerd-vectors.ts              Boots wrangler dev, asserts zero failures
│   ├── report-size.ts                      Per-subpath gzipped size vs budget
│   └── check-no-deps.ts                    Asserts dependencies/peerDependencies are empty
│
├── examples/                               Mirrors the Python SDK's examples/ (B9)
├── docs/                                   Per-module documentation (B9)
├── package.json  tsconfig.json  tsconfig.build.json  tsconfig.bundler.json
├── bunfig.toml                             Test config only; no linker override needed (zero deps)
├── .gitignore  .npmignore-not-used         (files[] in package.json is the allowlist)
├── README.md  CHANGELOG.md  CONTRIBUTING.md  LICENSE  SECURITY.md
```

## B9. Documentation

### `README.md` — structure, in this order

1. **One-line pitch + badges.** "Pure-TypeScript SDK for Lighter. No native binaries, no WASM, no
   FFI, zero runtime dependencies." Badges: npm version, CI status, gzipped size, runtimes
   (Bun · Node · Deno · Workers · Browser).
2. **Why this exists.** A short, honest comparison table: the official Python SDK ships a
   platform-specific compiled Go shared library and calls it through `ctypes`; the official Go SDK
   is Go. Neither runs on Cloudflare Workers, in a browser, or on an ARM machine without a matching
   prebuilt binary. This one is TypeScript all the way down and runs everywhere.
3. **Install** — `bun add lighter-ts` / `npm i lighter-ts` / `deno add npm:lighter-ts`, plus the
   Node-20 `WebSocket` note.
4. **60-second quickstart** — read-only: fetch order books and stream a market. No keys required.
5. **Signing quickstart** — create and send an order. With a prominent safety note about key
   handling.
6. **Runtime support matrix** — a table of Bun / Node 20/22/24 / Deno / Workers / Browser against
   REST / WS / Signing / Paper, with any caveat spelled out in the cell.
7. **Module map** — one line per subpath export and a link to its doc page.
8. **Conformance** — what the vectors cover and how to verify against the Go reference. This is a
   trust-building section for a library that signs money-moving transactions; it belongs above the
   fold-ish, not in an appendix.
9. **Security** — key handling, what is never logged, the redaction list, and a link to
   `SECURITY.md`.
10. **Contributing / License.**

The README must **not** be an API reference. Per-symbol documentation lives in TSDoc comments and
`docs/`.

### `docs/`

One page per module, each with: purpose, the protocol facts it encodes, the public API, worked
examples, and the known deviations from the reference SDKs.

```
docs/getting-started.md      Install, configure, first request, first signed tx
docs/runtimes.md             Per-runtime setup, caveats, WebSocket injection, Workers deployment
docs/crypto.md               Field, Poseidon, Schnorr; what is verified by which vectors
docs/transactions.md         Every tx type: fields, units, constraints, worked examples
docs/rest.md                 Endpoint catalogue, auth model, pagination/cursors, error handling
docs/websocket.md            Channels, frame shapes, reconnection, backpressure, ordering guarantees
docs/paper-trading.md        The full Part-A model: formulas, limitations, opt-in flags, migration
                             notes for anyone porting from the Python paper client
docs/errors.md               LighterError taxonomy, retryability, worked recovery patterns
docs/conformance.md          Vector categories, regeneration procedure, tolerance rules
docs/migrating-from-python.md  Symbol-by-symbol mapping from lighter-sdk (Python) to lighter-ts
```

`docs/migrating-from-python.md` is high-leverage: the monorepo's own `scripts/lighter/*.py`
(`create_lighter_account.py`, `deposit_via_intent_address.py`, `set_referral_code.py`) plus
`.github/workflows/lighter-account.yml` are the first migration, and the mapping table doubles as
that migration's checklist.

### `examples/`

Mirror the Python SDK's `examples/` directory one-for-one, so anyone arriving from the Python SDK
finds the file they already know. Every example is a standalone `.ts` file, runnable with
`bun examples/<name>.ts`, typechecked in CI, and never executed in CI.

Direct one-to-one ports (Python name → TypeScript name, same behaviour):

```
system-setup.ts                       get-info.ts
create-market-order-eth-buy.ts        create-market-order-eth-sell.ts
create-market-order-quote-amount.ts   create-market-order-max-slippage.ts
create-market-order-async-client.ts   create-order-skip-nonce.ts
create-modify-cancel-order-http.ts    create-modify-cancel-order-ws.ts
create-modify-cancel-skip-nonce.ts    cancel-all-orders-single-market.ts
create-grouped-ioc-with-attached-sl-tp.ts  create-grouped-ioc-with-integrator.ts
create-grouped-orders-client-order-index.ts  create-position-tied-sl-tp.ts
create-with-multiple-keys.ts          get-set-maker-only-api-keys.ts
self-trade-create-modify-order.ts     self-trade-grouped-orders.ts
send-batch-tx-http.ts                 send-batch-tx-ws.ts
transfer.ts                           transfer-same-master-account.ts
sub-account-create.ts                 sub-account-transfer-usdc.ts
sub-account-transfer-eth.ts           withdraw-normal.ts
withdraw-fast.ts                      enable-uta.ts
disable-uta.ts                        enable-eth-as-margin.ts
disable-eth-as-margin.ts              add-eth-margin.ts
margin-eth-20x-cross-http.ts          margin-eth-50x-isolate-ws.ts
margin-eth-add-collateral-http.ts     margin-eth-remove-collateral-ws.ts
public-pool-info.ts                   public-pool-create-modify.ts
public-pool-deposit.ts                public-pool-withdraw.ts
stake-and-unstake.ts                  spot-get-order-books.ts
spot-get-account-assets-http.ts       spot-get-account-assets-ws.ts
spot-self-transfer-perp-spot.ts       spot-self-transfer-spot-perp.ts
ws.ts                                 ws-async.ts  (collapse: TS has one async model)
paper-trading-snapshot.ts             paper-trading-live.ts
paper-trading-health.ts
examples/read-only-auth/*             examples/integrator/*
```

New examples with no Python counterpart, each demonstrating a differentiator:

```
workers/order-book-worker.ts     A Cloudflare Worker streaming a book into a Durable Object
workers/signer-worker.ts         Signing and submitting an order from inside a Worker
browser/index.html               Signing in the browser, no bundler, plain <script type=module>
deno/quickstart.ts               `deno run npm:lighter-ts` with no install step
paper-trading-backtest.ts        Replaying recorded book data through PaperEngine offline
paper-trading-funding.ts         The opt-in funding model and a funding-triggered liquidation
paper-trading-persist.ts         snapshotState / restoreState across a Worker request boundary
```

Each example file opens with a comment block stating what it does, what credentials it needs, and
whether it moves real funds — matching the tone of the Python examples and of the monorepo's own
workflow headers.

---

## Deviations from the reference, consolidated

Behaviour that differs from the Python/Go SDKs, and whether it is on by default.

| # | Area | Reference behaviour | Our behaviour | Default |
|---|---|---|---|---|
| 1 | Book delta keying | Keyed by raw price string | Keyed by canonical numeric price, wire string retained | **on** |
| 2 | Book offset | Stored, never checked | Gap/replay detection + resync | **on** |
| 3 | Crossed book | Silently kept | `uncrossPolicy` option | off |
| 4 | Mark map | Rebuilt twice per pass | Computed once per pass | **on** |
| 5 | `lastTradePrice` | Frozen at first fetch | Refreshed on config refresh; `markPriceSource` hook | **on** |
| 6 | Fees | Always from `AccountTier` | `feeSource` option (`tier`/`market`/fn) | tier |
| 7 | Order minimums | Never checked | `enforceMinimums` option | off |
| 8 | Market impact | None | `consumeLiquidity` option | off |
| 9 | Market slippage | Unbounded | `maxSlippageBps` per request | unset |
| 10 | Leverage | Always market default IMF | `setLeverage` per-market override | unset |
| 11 | Liquidation | Cascade, at mark, zero fee | `liquidationMode`, `liquidationExecution`, `liquidationFeeFraction` | cascade/mark/0 |
| 12 | Liquidated markets | Discarded by callers | Returned + `liquidation` event | **on** |
| 13 | Stale marks | Silent | `position.markStale` flag | **on** |
| 14 | Funding | Not simulated | Opt-in funding model + journal | off |
| 15 | Concurrency | asyncio.Lock + RLock | Synchronous pure engine, no locks | **on** |
| 16 | Persistence | None | `snapshotState` / `restoreState` | **on** (additive) |
| 17 | WS reconnect | None | Backoff + resubscribe + resnapshot + watchdog | **on** |
| 18 | WS sockets | One per market | One shared socket, multiplexed channels | **on** |
| 19 | Account-assets update | Replaces whole message | Merges by symbol, emits delta + merged view | **on** |
| 20 | API call variants | 3 per operation | 1 per operation, `{raw:true}` option | **on** |
| 21 | Error classes | 9 exception classes | 1 class, discriminated `kind` | **on** |
| 22 | Signer | Compiled Go `.so` via ctypes / WASM | Pure TypeScript | **on** |

Items 1, 2, 4, 5, 12, 13, 15–22 are additive or strictly-correcting and cannot change any
conformance-vector result. Items 3, 6–11, 14 change numeric output and are therefore off by default;
enabling any of them is documented as leaving the reference-parity envelope.

## Risks

1. **Paper-engine vectors depend on Python, not Go.** The paper client exists only in the Python
   SDK, so its vectors are generated from a reference we are less confident about and which has no
   upstream test-vector culture. Mitigation: generate vectors from a pinned Python SDK commit,
   record the commit in the vector header, and hand-derive the expected values for the ~15 most
   important scenarios so we are not purely trusting the generator.
2. **Float bit-exactness across languages.** Python and JavaScript both use IEEE-754 binary64 and
   both round correctly on the four basic operations, so identical operation orders give identical
   results. The risk is a subtle reassociation during translation. Mitigation: the operation order
   is written out explicitly in this spec, and the vector tolerance (relative 1e-12) is tight enough
   to catch a reassociation in a long sum but loose enough not to be flaky.
3. **`isolatedDeclarations` friction.** It will slow early development while the team learns to
   annotate exports. Mitigation: it is far cheaper now than later; if it genuinely blocks, it can be
   disabled with a single flag flip and the annotations remain valuable.
4. **`nodenext` deviates from the house `bundler` convention.** A contributor moving between repos
   will forget the `.js` extensions. Mitigation: the compiler errors immediately and the message is
   clear; documented in `CONTRIBUTING.md`.
5. **Node 20 has no global `WebSocket`.** The WS layer must accept an injected constructor, and the
   README must say so, or Node-20 users hit a confusing runtime error. Mitigation: a clear error
   message when `WebSocket` is absent and no constructor was injected, naming the fix.
6. **The zero-dependency constraint is only as strong as its enforcement.** A single convenience
   dependency added in a hurry destroys the differentiator. Mitigation: `scripts/check-no-deps.ts`
   runs in CI and fails the build.
7. **Cascade liquidation is not exchange behaviour.** Users will report it as a bug. Mitigation:
   document it prominently in `docs/paper-trading.md`, and ship the `incremental` mode early.
8. **No formatter means style drift.** With multiple contributors and no mechanical enforcement,
   diffs get noisy. Mitigation: the `CONTRIBUTING.md` style section, and revisit Biome after the
   first release.
9. **Vectors are only as good as the generator's coverage.** A tx type or endpoint with no vector is
   unverified. Mitigation: a CI check that asserts every exported tx type and every REST operation
   appears in at least one vector file.
10. **Publishing under an unscoped name.** If `lighter-ts` is taken on npm the whole naming section
    changes late. Mitigation: check availability before the first unit lands; the fallback is
    already specified.

## Open questions

1. **Funding sign convention.** Is `FundingRate.rate > 0` "longs pay shorts"? Must be confirmed
   against a real `positionFunding` sample before A10 ships. Also: what is the funding interval
   (1h / 8h) and is `rate` per-interval or annualised?
2. **`rate` and `funding_clamp_small` / `funding_clamp_big` / `base_interest_rate`** appear on
   `PerpsOrderBookDetail` as strings. Do they participate in the funding computation, and how?
3. **RFQ `direction` encoding.** Confirmed as an integer; is `0` = buy and `1` = sell, matching
   order side? Needs a live sample.
4. **RFQ `status` value set.** What are the valid strings for create/respond/update, and what is the
   state machine between them?
5. **`api_key_indexes` delimiter** on `setMakerOnlyApiKeys` — comma, space, or JSON array in a
   string? Needs a live request capture.
6. **`ApiToken.scopes` format** — delimiter and the valid scope vocabulary.
7. **`changeAccountTier.new_tier` values** — exact strings and casing (`"PREMIUM_3"`? `"premium3"`?)
   and their relationship to the `AccountTier` fee table in A2.1.
8. **Announcement expiry sentinel** — is `expired_at == 0` "never expires", or is it always set?
9. **Notification WS channel** — what is the channel name, what is the message shape, and is
   `notif_id` present on it?
10. **`code` semantics** — the OpenAPI example is `"200"` but generated fixtures use `0`. Is there
    any endpoint where a 2xx HTTP response carries a failure `code`? If so the "never gate on code"
    rule in A′1.1 needs an exception list.
11. **WS unsubscribe frame** — does the venue support unsubscribing from a channel on a live socket,
    or must a client drop the connection? This determines the shared-socket design in A9.5.
12. **npm name availability** for `lighter-ts`.
13. **License** — the Python reference is marked "NoLicense" and the Go reference ships an Apache-2.0
    text. Our clean-room implementation is our own work; MIT is proposed. Needs a decision.
14. **`min_initial_margin_fraction`** — is it a floor on user-selected leverage (my assumption in
    A7's remedy), or something else?
15. **Spot market-id boundary** — the paper client rejects `market_id >= 2048`. Is 2048 a hard
    protocol constant or a current-configuration artifact? If the latter, derive it from
    `systemConfig` rather than hardcoding.
