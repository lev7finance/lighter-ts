# 06 — WebSocket Protocol

Functional specification for the WebSocket half of `@lev7/lighter` (clean-room TypeScript reimplementation of
the Lighter exchange SDK).

This document describes **what the wire protocol is** and **what the TypeScript client must do**. It contains no
translated source from the Go or Python SDKs.

---

## 0. Source provenance and confidence markers

Every protocol claim below carries a marker. Anything not marked `[REF]` or `[DOC]` is a design decision or an
inference and **must be validated against a live server before it is depended on**.

| Marker | Meaning |
|---|---|
| `[REF]` | Directly observable in the reference SDK source or its test fixtures (Python `lighter/ws_client.py`, `lighter/paper_client/live.py`, `lighter/endpoint_profiles.py`, `examples/utils.py`, `test/paper_client/test_live.py`). Highest confidence — the reference client demonstrably interoperates. |
| `[DOC]` | Stated in the public Lighter API documentation (`apidocs.lighter.xyz/docs/websocket-reference`, `/docs/rate-limits`, `/docs/data-structures-constants-and-errors`), retrieved 2026-07-25. |
| `[INFER]` | Deduced from the above; plausible but unverified. Treat as an open question. |
| `[DESIGN]` | Our decision. Not a protocol fact. |

The Go SDK contains **no WebSocket code at all** — it is a signing/tx-construction library only (`client/http/README.md`
explicitly scopes WebSocket operations out). The only reference implementation of this protocol is the Python
`WsClient`, which covers **three** of the twenty-two channels. Everything beyond `order_book`, `account_all`, and
`account_all_assets` is `[DOC]`-sourced and needs a live conformance run.

---

## 1. Endpoints and connection handshake

### 1.1 Endpoint URLs `[REF]`

The WebSocket endpoint is the REST host with scheme `wss:` and path `/stream`.

| Profile | REST base | WS URL | chain id |
|---|---|---|---|
| `mainnet` | `https://mainnet.zklighter.elliot.ai` | `wss://mainnet.zklighter.elliot.ai/stream` | 304 |
| `testnet` | `https://testnet.zklighter.elliot.ai` | `wss://testnet.zklighter.elliot.ai/stream` | 300 |
| `robinhood` | `https://api.rh.lighter.xyz` | `wss://api.rh.lighter.xyz/stream` | 466324 |
| `robinhood_testnet` | `https://api.rh-testnet.lighter.xyz` | `wss://api.rh-testnet.lighter.xyz/stream` | 300 |

Derivation rule for a custom host: `wss://` + host + `/stream`, with any trailing slash on the base stripped
before joining. `[REF]`

### 1.2 Query parameters

| Param | Value | Effect |
|---|---|---|
| `readonly` | `true` | Connect in read-only mode — the socket will not accept `jsonapi/sendtx*` frames. Used to isolate market-data consumers from the tx path. `[DOC]` |
| `encoding` | `json` | Referenced defensively by the reference paper client, which raises if it ever receives a **binary** frame and tells the caller to add `?encoding=json`. Implies the server may support a non-JSON encoding. Unverified whether the param is actually honoured. `[INFER]` |

**Design rule `[DESIGN]`:** always send `?encoding=json` unless the caller explicitly opts into another encoding, and
treat any inbound binary frame as a protocol error (close + reconnect), never as data.

### 1.3 Handshake

1. Standard RFC 6455 upgrade over TLS. **No subprotocol is negotiated.** No `Authorization` header, no cookie, no
   query-string credential. `[REF]`
2. Immediately after the upgrade completes the server pushes a single unsolicited frame:
   ```json
   {"type": "connected"}
   ```
   `[REF]` (the reference client keys its entire subscription flow off this message; the reference test server
   sends exactly this and nothing else). No session id, no server version, no heartbeat interval is advertised.
3. The client may then send `subscribe` frames.

**Is waiting for `connected` mandatory?** Unknown `[INFER]`. The reference client always waits. The public docs never
mention the message and show `wscat` usage that implies you can subscribe right away.

**Design rule `[DESIGN]`:** wait for `connected` with a `handshakeTimeoutMs` budget (default **3000 ms**). If the
budget expires, proceed to subscribe anyway and emit a `warn`-level diagnostic. This is correct under both server
behaviours and never deadlocks.

### 1.4 Authentication is *not* part of the handshake `[REF]`

There is no connection-level login. Authentication is **per-subscription** (§7). A single socket may carry
unauthenticated public channels and authenticated private channels for multiple accounts simultaneously, subject to
the "500 unique accounts per connection" limit (§10.3).

---

## 2. Framing and the message envelope

### 2.1 Framing

- All application frames are **UTF-8 text frames containing a single JSON object**. `[REF]`
- No frame batching, no newline-delimited multi-message frames, no length prefix.
- Binary frames are not part of the protocol (see §1.2).

### 2.2 Envelope

Every message in both directions has a discriminant string field `type`. `[REF]`

**Client → server types:**

| `type` | Purpose | §
|---|---|---|
| `subscribe` | Join a channel | §5 |
| `unsubscribe` | Leave a channel | §5 |
| `pong` | Reply to a server ping, or unsolicited keepalive | §9 |
| `jsonapi/sendtx` | Submit one signed transaction | §8 |
| `jsonapi/sendtxbatch` | Submit up to 15 signed transactions atomically-ordered | §8 |

**Server → client types:**

| `type` | Purpose |
|---|---|
| `connected` | Post-handshake greeting `[REF]` |
| `ping` | Server liveness probe; client must answer `pong` `[REF]` |
| `subscribed/<channel-family>` | Initial state for a subscription `[REF]` |
| `update/<channel-family>` | Subsequent state for a subscription `[REF]` |
| `unsubscribed/<channel-family>` | Unsubscribe acknowledgement `[INFER]` — shape undocumented |
| `error` (or an object carrying `code`/`message`) | Protocol/rate-limit/auth failure. Exact envelope **undocumented** `[INFER]`; the numeric code space is documented (§11) |
| `jsonapi/sendtx` reply | Ack for a tx submission; correlation and exact shape `[INFER]` (§8) |

`<channel-family>` is the channel name with **no index suffix** — e.g. `order_book`, `account_all_assets`,
`mark_price_candle`. The index lives in the sibling `channel` field. `[REF]`

### 2.3 The two channel-key spellings — a protocol wart `[REF]` `[DOC]`

This is the single most important interop hazard in the protocol.

- **Outbound** (`subscribe` / `unsubscribe`), the key uses **slash** separators: `order_book/0`,
  `candle/0/1m`, `account_orders/3/1234`.
- **Inbound**, the `channel` field of `subscribed/*` and `update/*` messages uses **colon** separators:
  `order_book:0`, `candle:0:1m`, `account_all_assets:1234`.

The reference client parses inbound keys by splitting on `:` and taking index 1; the reference paper client defends
against *both* spellings because the server has been observed emitting each. `[REF]`

Worse, the spelling is **not uniform across channels** `[DOC]`:

| Channel | Documented inbound `channel` value | Problem |
|---|---|---|
| `order_book` | `order_book:{MARKET_INDEX}` | colon — normal |
| `account_market` | `account_market/{MARKET_ID}/{ACCOUNT_ID}` | **slash**, not colon |
| `account_orders` | `account_orders:{MARKET_INDEX}` | **account id is missing entirely**; the account is carried in a sibling `account` field |
| `height` | `height` | no index at all |
| `rfq` | `rfq` | no index at all |

**Design rule `[DESIGN]` — routing must never depend on exact string equality of the inbound `channel`:**

1. Normalise the inbound `channel` by replacing every `:` with `/` → `normKey`.
2. Look up `normKey` in the table of active subscription keys. If hit, route.
3. On miss, derive a *family* from `type` (strip the `subscribed/` or `update/` prefix) and reconstruct a candidate
   key from the family plus whichever discriminating fields the body carries (`account`, `account_id`, `market_id`,
   `market_index`, `resolution`). If exactly one active subscription of that family matches, route to it.
4. On miss with exactly one active subscription of that family, route to it (unambiguous).
5. Otherwise emit an `unroutable` diagnostic and drop. **Never throw.** (The reference client throws on any
   unrecognised message, which kills the read loop — see §12.1.)

---

## 3. Numeric domains and JSON typing rules

These rules apply to every channel payload and are a source of silent corruption if ignored.

### 3.1 Prices and sizes are decimal **strings** `[REF]` `[DOC]`

`{"price": "2064.54", "size": "0.3285"}` — never JSON numbers. Trailing-zero formatting is **not** guaranteed
stable (`"1"` and `"1.0000"` both appear in documented examples for balances). Therefore:

- **Never** use the raw string as a map key without canonicalisation.
- **Never** parse with `parseFloat` for comparison, ordering, or equality. `2064.54` is not exactly representable
  in binary64, and the reference paper client's float-keyed sort is a latent precision bug (§12.2).

### 3.2 Canonical decimal form `[DESIGN]`

Define `toScaled(s: string, decimals = 18): bigint` — an exact, allocation-light string→BigInt conversion:

```
1. Trim. Accept optional leading '-'.
2. Split on the single '.'. intPart = left (may be empty → "0"), fracPart = right (may be absent → "").
3. Reject if either part contains a non-digit, or if there is more than one '.', or if fracPart.length > decimals.
4. Right-pad fracPart with '0' to exactly `decimals` characters.
5. value = BigInt(intPart + fracPart), negated if the sign was '-'.
```

`decimals = 18` covers every documented Lighter field with room to spare and makes all prices/sizes/balances
directly comparable as BigInt. Zero detection is `toScaled(s) === 0n`, which correctly classifies `"0"`,
`"0.0000"`, and `"0.00000000"` as removals.

Order-book maps are keyed by `toScaled(price)` (a BigInt primitive — `Map`/`Set` compare BigInt keys by numeric
value, so `2064540000000000000n` from `"2064.54"` and from `"2064.5400"` are the same key). The original string is
retained alongside for display fidelity.

### 3.3 Integers that can exceed `Number.MAX_SAFE_INTEGER`

Several id fields are JSON numbers large enough to be at risk. The server helpfully ships **string duplicates** for
the worst offenders `[DOC]`:

| Numeric field | String twin |
|---|---|
| `trade_id` | `trade_id_str` |
| `ask_id`, `bid_id` | `ask_id_str`, `bid_id_str` |
| `ask_client_id`, `bid_client_id` | `ask_client_id_str`, `bid_client_id_str` |
| `order_index`, `client_order_index` | `order_id`, `client_order_id` |
| `parent_order_index` | `parent_order_id` |

**Design rule `[DESIGN]`:** the typed models expose the `*_str` form as the canonical identity (typed `string`, or
`bigint` on request) and mark the numeric twin `@deprecated lossy`.

Fields with **no** string twin and no bound: `nonce`, `begin_nonce`, `offset`, `transaction_time`,
`last_updated_at`. Observed magnitudes (`nonce` ≈ 9.18e9, `transaction_time` ≈ 1.77e15) are inside binary64's exact
integer range today, but `transaction_time` (microseconds) is only ~5.7× below `2^53`.

**Design rule `[DESIGN]`:** provide `parseFrameJson(text, bigIntFields)` — a pre-parse pass that rewrites integer
literals **longer than 15 digits** appearing as the value of a listed key into JSON strings, then calls
`JSON.parse`. A `JSON.parse` reviver cannot fix this (the precision is already gone by the time the reviver runs),
so the pre-pass is the only correct approach. Default `bigIntFields` = `{nonce, begin_nonce, offset,
transaction_time, last_updated_at, trade_id, ask_id, bid_id, ask_client_id, bid_client_id, order_index,
client_order_index}`. The pass is skipped entirely (single `indexOf` guard) when a frame contains no 16+-digit run,
so the common case costs one scan.

### 3.4 Timestamps

Inconsistent units across channels `[DOC]` — this is a genuine wire fact, not our confusion:

| Field | Unit |
|---|---|
| top-level `timestamp` on `market_stats`, `spot_market_stats`, `account_all_assets`, `candle`, `ticker`, `order_book` | **milliseconds** (e.g. `1774884082326`) |
| `last_updated_at`, `transaction_time` | **microseconds** (e.g. `1774884082309144`) |
| `funding_timestamp`, candle `t` | **milliseconds** |
| `timestamp` inside `Trade` | **milliseconds** (`1773854156654`) |
| `timestamp` inside `PositionFunding` / `height` message | **seconds** in some documented examples (`1700000000`), ms in others (`1773850000000`) — genuinely inconsistent |
| notification `created_at` / `updated_at` | **RFC 3339 string** (`"2024-01-15T10:30:00Z"`) |

**Design rule `[DESIGN]`:** never auto-normalise. Model each field at its documented unit with the unit in the type
name (`timestampMs`, `lastUpdatedAtUs`). Where the unit is ambiguous, expose the raw number and provide
`inferEpochUnit(n)` (a heuristic: `< 1e11` → s, `< 1e14` → ms, else µs) as an explicit opt-in helper.

---

## 4. Connection lifecycle state machine `[DESIGN]`

```
                  ┌─────────┐
        connect() │  IDLE   │
             ────►└────┬────┘
                       │ open socket
                       ▼
                 ┌───────────┐  ws error / close
                 │CONNECTING ├──────────────────┐
                 └─────┬─────┘                  │
        socket 'open'  │                        ▼
                       ▼                  ┌───────────┐
                ┌─────────────┐  give up   │RECONNECT  │
                │ HANDSHAKING ├───────────►│  WAIT     │
                └──────┬──────┘            └─────┬─────┘
   'connected' OR      │                         │ backoff elapsed
   handshake timeout   ▼                         │
                ┌────────────┐                   │
                │   READY    │◄──────────────────┘
                └──────┬─────┘
       resubscribe all │  (fresh auth tokens, order-book maintainers reset)
                       ▼
                ┌────────────┐   close()/fatal    ┌────────┐
                │   OPEN     ├───────────────────►│ CLOSED │
                └──────┬─────┘                    └────────┘
                       │ socket close / stale watchdog / fatal protocol error
                       └────────────► RECONNECT WAIT
```

Invariants:

- `subscribe()` is legal in **any** state except `CLOSED`; the subscription is registered in the desired-state table
  and the wire frame is emitted the next time the socket reaches `READY`.
- Transitioning out of `OPEN` marks every order-book maintainer `stale` and emits `{kind:'reset', reason:'reconnect'}`
  on every subscription, **before** any post-reconnect snapshot arrives. Consumers must be able to see a `reset`
  and know that all prior delta-derived state is void.
- `CLOSED` is terminal. Calling `connect()` on a closed client throws.

---

## 5. Subscribe / unsubscribe

### 5.1 Subscribe frame `[REF]` `[DOC]`

```json
{"type": "subscribe", "channel": "<slash-form-key>"}
```

With authentication (§7):

```json
{"type": "subscribe", "channel": "<slash-form-key>", "auth": "<AUTH_TOKEN>"}
```

The `auth` key is **omitted entirely** when no token is supplied — it is not sent as `null` or `""`. `[REF]`

### 5.2 Unsubscribe frame `[DOC]`

```json
{"type": "unsubscribe", "channel": "<slash-form-key>"}
```

The ack shape is undocumented `[INFER]`. Error code 30002 (`"Not Subscribed to "`) is returned if the channel was
not subscribed; 30003 (`"Already Subscribed to "`) if you subscribe twice. `[DOC]`

### 5.3 Response sequence per subscription `[REF]`

1. Server replies `{"type": "subscribed/<family>", "channel": "<colon-form-key>", ...payload}` carrying the **full
   current state** of the channel.
2. Server then streams `{"type": "update/<family>", "channel": "<colon-form-key>", ...payload}` frames.

For `order_book` the `update/*` payload is a **true delta** (§6). For most other channels `update/*` carries a
partial or complete refresh of the same shape as the snapshot — see the per-channel notes in §6.

**Wart `[DOC]`:** the published example for the *order book snapshot* is labelled "Subscribed" but shows
`"type": "update/order_book"`. The reference client and the reference test fixtures both prove the snapshot type is
`subscribed/order_book`. Treat the doc example as a typo; **the client must accept both** and classify by
`type` prefix (`subscribed/` ⇒ snapshot) — with a fallback rule that an `update/order_book` whose `begin_nonce` is
absent or whose payload is the first message on a fresh subscription is treated as a snapshot. `[DESIGN]`

### 5.4 Idempotency

Re-subscribing to an already-active channel yields error 30003 rather than a fresh snapshot. `[DOC]` To force a
resync the client must `unsubscribe` then `subscribe`. `[DESIGN]` The gap-recovery path (§6.5) depends on this.

---

## 6. Channel registry

Notation: `{M}` = market index (integer; perp markets are low indices, spot markets start at **2048** `[REF]`),
`{A}` = account index, `{R}` = candle resolution.

### 6.1 Complete channel table

| # | Family | Subscribe key (slash) | Inbound `channel` (as documented) | Auth | Snapshot type | Update type | Source |
|---|---|---|---|---|---|---|---|
| 1 | Order book | `order_book/{M}` | `order_book:{M}` | no | `subscribed/order_book` | `update/order_book` | `[REF]` |
| 2 | Ticker / BBO | `ticker/{M}` | `ticker:{M}` | no | `subscribed/ticker` `[INFER]` | `update/ticker` | `[DOC]` |
| 3 | Market stats | `market_stats/{M}` or `market_stats/all` | `market_stats:{M}` | no | `subscribed/market_stats` `[INFER]` | `update/market_stats` | `[DOC]` |
| 4 | Spot market stats | `spot_market_stats/{M}` or `/all` | `spot_market_stats:{M}` | no | `subscribed/spot_market_stats` `[INFER]` | `update/spot_market_stats` | `[DOC]` |
| 5 | Trades | `trade/{M}` | `trade:{M}` | no | `subscribed/trade` `[INFER]` | `update/trade` | `[DOC]` |
| 6 | Candles | `candle/{M}/{R}` | `candle:{M}:{R}` | no | `subscribed/candle` | `update/candle` | `[DOC]` |
| 7 | Mark-price candles | `mark_price_candle/{M}/{R}` | `mark_price_candle:{M}:{R}` | no | `subscribed/mark_price_candle` | `update/mark_price_candle` | `[DOC]` |
| 8 | Block height | `height` | `height` | no | `subscribed/height` `[INFER]` | `update/height` | `[DOC]` |
| 9 | Account all | `account_all/{A}` | `account_all:{A}` | no* | `subscribed/account_all` | `update/account_all` | `[REF]` |
| 10 | Account market | `account_market/{M}/{A}` | `account_market/{M}/{A}` | **yes** | `subscribed/account_market` `[INFER]` | `update/account_market` | `[DOC]` |
| 11 | Account stats | `user_stats/{A}` | `user_stats:{A}` | no* | `subscribed/user_stats` `[INFER]` | `update/user_stats` | `[DOC]` |
| 12 | Account txs | `account_tx/{A}` | `account_tx:{A}` | **yes** | `subscribed/account_tx` `[INFER]` | `update/account_tx` | `[DOC]` |
| 13 | Account all orders | `account_all_orders/{A}` | `account_all_orders:{A}` | **yes** | `subscribed/account_all_orders` `[INFER]` | `update/account_all_orders` | `[DOC]` |
| 14 | Account orders (per market) | `account_orders/{M}/{A}` | `account_orders:{M}` ⚠ | **yes** | `subscribed/account_orders` `[INFER]` | `update/account_orders` | `[DOC]` |
| 15 | Account all trades | `account_all_trades/{A}` | `account_all_trades:{A}` | no* | `subscribed/account_all_trades` | `update/account_all_trades` | `[DOC]` |
| 16 | Account all positions | `account_all_positions/{A}` | `account_all_positions:{A}` | no* | `subscribed/account_all_positions` | `update/account_all_positions` | `[DOC]` |
| 17 | Account all assets | `account_all_assets/{A}` | `account_all_assets:{A}` | **yes** | `subscribed/account_all_assets` | `update/account_all_assets` | `[REF]` |
| 18 | Spot avg entry prices | `account_spot_avg_entry_prices/{A}` | `account_spot_avg_entry_prices:{A}` | **yes** | `subscribed/account_spot_avg_entry_prices` | `update/…` `[INFER]` | `[DOC]` |
| 19 | Pool data | `pool_data/{A}` | `pool_data:{A}` | **yes** | `subscribed/pool_data` | `update/pool_data` `[INFER]` | `[DOC]` |
| 20 | Pool info | `pool_info/{A}` | `pool_info:{A}` | **yes** | `subscribed/pool_info` | `update/pool_info` `[INFER]` | `[DOC]` |
| 21 | Notifications | `notification/{A}` | `notification:{A}` | **yes** | `subscribed/notification` | `update/notification` | `[DOC]` |
| 22 | RFQ | `rfq` | `rfq` | **yes** | `subscribed/rfq` `[INFER]` | `update/rfq` | `[DOC]` |

\* The published subscribe examples for `account_all`, `user_stats`, `account_all_trades`, and
`account_all_positions` omit `auth`, and the reference `WsClient` subscribes to `account_all` with no token and
works `[REF]`. These channels appear to expose only data that is public per-account-index. **Design rule
`[DESIGN]`:** always attach a token when the caller has configured one, for every `account_*`/`user_stats`/`pool_*`/
`notification`/`rfq` channel — the server ignores a superfluous `auth`, and this survives the server tightening its
policy. There is no candle-family channel that requires auth.

**No dedicated funding channel exists.** `[DOC]` Funding data is delivered inside other channels:
`market_stats.current_funding_rate` / `.funding_rate` / `.funding_timestamp` (live rate),
`account_all.funding_histories` and `pool_data.funding_histories` (realised payments),
`account_all_positions.last_funding_round` / `.last_funding_discount`, `account_market.funding_history`.
Historical funding is REST-only (`GET /api/v1/fundings`, `/api/v1/funding-rates`, `/api/v1/positionFunding`).

Candle resolutions `[DOC]`: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `12h`, `1d`. Same set for `mark_price_candle`.

### 6.2 Payload shapes

Field names below are the exact JSON keys. Types are the wire types (`STR` = decimal string, `INT` = JSON integer,
`F64` = JSON float).

#### 6.2.1 `order_book` `[REF]` `[DOC]`

Snapshot **and** delta share one shape:

```
{
  type:            "subscribed/order_book" | "update/order_book"
  channel:         "order_book:{M}"
  offset:          INT              // duplicated at top level and inside order_book
  last_updated_at: INT (µs)         // duplicated
  timestamp:       INT (ms)
  order_book: {
    code:            INT            // 0 on success
    asks:            [{ price: STR, size: STR }]
    bids:            [{ price: STR, size: STR }]
    offset:          INT
    nonce:           INT            // sequence number AFTER this message is applied
    begin_nonce:     INT            // sequence number this message expects to be applied ON TOP OF
    last_updated_at: INT (µs)
  }
}
```

Semantics:
- Snapshot: `asks`/`bids` are the **complete** book for that side (documented examples show one side empty when
  there is genuinely no liquidity, not as an "unchanged" marker).
- Delta: `asks`/`bids` contain **only changed price levels**. A level with `size` numerically zero is a
  **tombstone** — remove that price. `[REF]` (the reference fixtures use `"0"`, `"0.0"`, and `"0.0000"`
  interchangeably, which is why §3.2's exact zero test matters).
- Levels are **not** guaranteed sorted in the payload. `[REF]`
- `nonce` / `begin_nonce` form the continuity chain (§6.3). `offset` is a coarser, monotonically non-decreasing
  version counter that the reference paper client tracks but never validates.

#### 6.2.2 `ticker` (BBO) `[DOC]`

```
{ type:"update/ticker", channel:"ticker:{M}", last_updated_at:INT(µs), nonce:INT, timestamp:INT(ms),
  ticker: { s: STR /*symbol*/, a:{price:STR,size:STR}, b:{price:STR,size:STR}, last_updated_at:INT(µs) } }
```
Complete replacement each time. No delta semantics.

#### 6.2.3 `market_stats` `[DOC]`

```
{ type:"update/market_stats", channel:"market_stats:{M}", timestamp:INT(ms),
  market_stats: {
    symbol:STR, market_id:INT,
    index_price:STR, mark_price:STR, mid_price:STR, best_ask_price:STR, best_bid_price:STR,
    open_interest:STR, open_interest_limit:STR,
    funding_clamp_small:STR, funding_clamp_big:STR,
    last_trade_price:STR,
    current_funding_rate:STR, funding_rate:STR, funding_timestamp:INT(ms),
    daily_base_token_volume:F64, daily_quote_token_volume:F64,
    daily_price_low:F64, daily_price_high:F64, daily_price_change:F64,
    base_interest_rate:STR } }
```
Note the type inconsistency: prices are strings, daily aggregates are floats. `[DOC]`

`market_stats/all` `[DOC]`: subscribing with the literal token `all` streams every market. Whether the server emits
one message per market (each with its own `market_stats:{M}` channel) or a single map is **undocumented**
`[INFER]` — the client must accept both and fan out.

#### 6.2.4 `spot_market_stats` `[DOC]`

```
{ type:"update/spot_market_stats", channel:"spot_market_stats:{M}", timestamp:INT(ms),
  spot_market_stats: { symbol:STR /*"ETH/USDC"*/, market_id:INT, index_price:STR, mid_price:STR,
    last_trade_price:STR, daily_base_token_volume:F64, daily_quote_token_volume:F64,
    daily_price_low:F64, daily_price_high:F64, daily_price_change:F64 } }
```
No mark price, no funding, no open interest — spot markets have none.

#### 6.2.5 `trade` `[DOC]`

```
{ type:"update/trade", channel:"trade:{M}", nonce:INT,
  trades: [Trade], liquidation_trades: [Trade] }
```
`Trade`:
```
trade_id:INT, trade_id_str:STR, tx_hash:STR, type:"trade", market_id:INT,
size:STR, price:STR, usd_amount:STR,
ask_id:INT, ask_id_str:STR, bid_id:INT, bid_id_str:STR,
ask_client_id:INT, ask_client_id_str:STR, bid_client_id:INT, bid_client_id_str:STR,
ask_account_id:INT, bid_account_id:INT, is_maker_ask:BOOL,
block_height:INT, timestamp:INT(ms), transaction_time:INT(µs),
taker_position_size_before:STR, taker_entry_quote_before:STR, taker_initial_margin_fraction_before:INT,
maker_position_size_before:STR, maker_entry_quote_before:STR, maker_initial_margin_fraction_before:INT,
taker_fee:INT, maker_fee:INT
```
Append-only. `liquidation_trades` is a **separate array**, not a flag on `Trade` — consumers that only read `trades`
will silently miss liquidations. `nonce` here is a book nonce, not a trade counter `[INFER]`.

Trade direction: derive from `is_maker_ask` — `false` means the **taker** was the seller, i.e. the aggressor sold.

#### 6.2.6 `candle` / `mark_price_candle` `[DOC]`

```
{ type:"subscribed/candle"|"update/candle", channel:"candle:{M}:{R}", timestamp:INT(ms),
  candles: [ { t:INT(ms bucket start), o:F64, h:F64, l:F64, c:F64, v:F64 /*base vol*/, V:F64 /*quote vol*/, i:INT } ] }
```
`mark_price_candle` replaces `v`/`V`/`i` with `sc:INT` (sample count):
```
candles: [ { t:INT, o:F64, h:F64, l:F64, c:F64, sc:INT } ]
```
Upsert semantics: a candle in an `update/` is a **replacement for the bucket with the same `t`**, and the newest
bucket is repeatedly re-sent as it forms. `[INFER]` (documented examples show the same `t` with growing `v`/`i`).
The `i` field is an incrementing per-market index used to detect missed candle updates `[INFER]`.

**Field-name hazard:** `v` (lowercase, base volume) and `V` (uppercase, quote volume) differ only by case. Any
case-insensitive JSON handling corrupts this.

#### 6.2.7 `height` `[DOC]`

```
{ type:"update/height", channel:"height", height:INT, timestamp:INT }
```

#### 6.2.8 `account_all` `[REF]` `[DOC]`

The fattest channel. Snapshot and update share the shape; `update/` messages carry **only the sub-objects that
changed** `[INFER]` (the reference client simply replaces its whole cached message, which is wrong if updates are
partial — see §12.1).

```
{ type:"subscribed/account_all"|"update/account_all", channel:"account_all:{A}", account:INT,
  assets:            { "{ASSET_ID}": AccountAsset },
  positions:         { "{MARKET_INDEX}": Position },
  funding_histories: { "{MARKET_INDEX}": PositionFunding },
  trades:            { "{MARKET_INDEX}": Trade },
  shares:            PoolShare,
  daily_trades_count:INT,   daily_volume:NUM,
  weekly_trades_count:INT,  weekly_volume:NUM,
  monthly_trades_count:INT, monthly_volume:NUM,
  total_trades_count:INT,   total_volume:NUM }
```
`AccountAsset`: `{ symbol:STR, asset_id:INT, balance:STR, locked_balance:STR }`
`Position`: `{ market_id:INT, symbol:STR, initial_margin_fraction:STR, open_order_count:INT,
pending_order_count:INT, position_tied_order_count:INT, sign:INT (+1 long / −1 short), position:STR,
avg_entry_price:STR, position_value:STR, unrealized_pnl:STR, realized_pnl:STR, liquidation_price:STR,
total_funding_paid_out:STR, margin_mode:INT (0 cross, 1 isolated), allocated_margin:STR }`
`PositionFunding`: `{ timestamp:INT, market_id:INT, funding_id:INT, change:STR, rate:STR, position_size:STR,
position_side:"long"|"short", discount:STR? }`
`PoolShare`: `{ public_pool_index:INT, shares_amount:INT, entry_usdc:STR, principal_amount:STR?,
entry_timestamp:INT? }`

**Availability:** `position.size` is `position` (a string) and its sign is in a *separate* `sign` field — the
string is unsigned. Multiply on read.

#### 6.2.9 `account_all_assets` `[REF]` `[DOC]`

```
{ type:"subscribed/account_all_assets"|"update/account_all_assets",
  channel:"account_all_assets:{A}", timestamp:INT(ms),
  assets: { "{ASSET_ID}": { symbol:STR, asset_id:INT, balance:STR, locked_balance:STR } } }
```
Available balance = `balance − locked_balance` (compute with §3.2 BigInts, not floats). `[REF]`
The account index is **only** recoverable from the `channel` string — there is no `account` field. `[REF]`
Known asset ids `[REF]`: 1 = ETH, 2 = LIT, 3 = USDC, 5 = LINK, 6 = UNI, 7 = AAVE, 8 = SKY, 9 = LDO.

#### 6.2.10 `account_all_positions` `[DOC]`

```
{ type:"…/account_all_positions", channel:"account_all_positions:{A}",
  positions: { "{MARKET_INDEX}": Position },
  shares: [PoolShare],
  last_funding_round:    { "{MARKET_INDEX}": STR },
  last_funding_discount: { "{MARKET_INDEX}": STR } }
```
Note `shares` is an **array** here but an **object** in `account_all`. `[DOC]` Model both.

#### 6.2.11 `account_all_orders` / `account_orders` `[DOC]`

```
{ type:"…/account_all_orders", channel:"account_all_orders:{A}",
  orders: { "{MARKET_INDEX}": [Order] } }

{ type:"…/account_orders", channel:"account_orders:{M}", account:INT, nonce:INT,
  orders: { "{MARKET_INDEX}": [Order] } }
```
`Order`:
```
order_index:INT, client_order_index:INT, order_id:STR, client_order_id:STR,
market_index:INT, owner_account_index:INT,
initial_base_amount:STR, price:STR, nonce:INT, remaining_base_amount:STR, is_ask:BOOL,
base_size:INT, base_price:INT,                       // raw integer ticks
filled_base_amount:STR, filled_quote_amount:STR,
side:"buy"|"sell", type:"limit"|…, time_in_force:"good-till-time"|…, reduce_only:BOOL,
trigger_price:STR, order_expiry:INT(ms), status:"open"|…, trigger_status:"na"|…, trigger_time:INT,
parent_order_index:INT, parent_order_id:STR,
to_trigger_order_id_0:STR, to_trigger_order_id_1:STR, to_cancel_order_id_0:STR,
integrator_fee_collector_index:STR, integrator_taker_fee:STR, integrator_maker_fee:STR,
block_height:INT, timestamp:INT, created_at:INT(ms), updated_at:INT(ms), transaction_time:INT(µs)
```
Update semantics `[INFER]`: an `update/` carries only the orders whose state changed; an order that reaches a
terminal `status` is delivered once with that status and then never again. Consumers must expire terminal orders
themselves. **This must be confirmed on a live socket** — if instead the server sends the full open-order set each
time, the correct client behaviour is full replacement, and getting this wrong leaks phantom orders.

#### 6.2.12 `account_market` `[DOC]`

```
{ type:"…/account_market", channel:"account_market/{M}/{A}", account:INT,
  assets:[AccountAsset], orders:[Order], position:[Position], trades:[Trade],
  funding_history: PositionFunding }
```
Note the singular key `position` holding an **array**, and `funding_history` (singular) holding a single object,
versus `funding_histories` (plural map) elsewhere. `[DOC]`

#### 6.2.13 `account_all_trades` `[DOC]`

Snapshot and update have **different shapes** — a real wart:
```
subscribed: { channel:"account_all_trades:{A}", trades:[Trade],
              total_volume:F64, monthly_volume:F64, weekly_volume:F64, daily_volume:F64,
              type:"subscribed/account_all_trades" }
update:     { channel:"account_all_trades:{A}", trades:{ "{MARKET_INDEX}":[Trade] },
              type:"update/account_all_trades" }
```
`trades` is a flat array in the snapshot and a market-keyed map in updates. The volume aggregates appear only in
the snapshot.

#### 6.2.14 `user_stats` (Account Stats) `[DOC]`

```
{ type:"update/user_stats", channel:"user_stats:{A}", timestamp:INT(ms),
  stats: { collateral:STR, portfolio_value:STR, leverage:STR, available_balance:STR,
           margin_usage:STR, buying_power:STR,
           account_trading_mode:INT,
           cross_stats: {same six fields}, total_stats: {same six fields} } }
```

#### 6.2.15 `account_tx` `[DOC]`

```
{ type:"update/account_tx", channel:"account_tx:{A}", txs:[ Tx ] }
```
`Tx`:
```
hash:STR, type:INT (tx type constant), info:STR (JSON-encoded tx body), event_info:STR (JSON-encoded),
status:INT (0 failed, 1 pending, 2 executed, 3 pending-final), transaction_index:INT,
l1_address:STR, account_index:INT, nonce:INT, expire_at:INT(ms), block_height:INT,
queued_at:INT(ms), executed_at:INT(ms), sequence_index:INT, parent_hash:STR,
api_key_index:INT, transaction_time:INT(µs)
```
**`info` and `event_info` are strings containing JSON**, not objects. `[DOC]` Double-decode required. The inner
`info` uses PascalCase keys (`AccountIndex`, `ApiKeyIndex`, `MarketIndex`, `Index`, `ExpiredAt`, `Nonce`, `Sig`)
while the outer envelope is snake_case. `event_info` uses cryptic single/double-letter keys (`a`, `i`, `u`, `ae`).

This channel is the WS equivalent of `GET /api/v1/accountTxs` and is how a client observes the fate of a
transaction it submitted (§8.4).

#### 6.2.16 `notification` `[DOC]`

```
{ type:"update/notification", channel:"notification:{A}",
  notifs: [ { id:STR, created_at:RFC3339, updated_at:RFC3339, kind:STR, account_index:INT,
              content: {…kind-specific…}, ack:BOOL, acked_at:RFC3339|null } ] }
```
Observed `kind` values `[DOC]`: `"liquidation"`, `"deleverage"`.
- `liquidation` content: `{ id, is_ask:BOOL, usdc_amount:STR, size:STR, market_index:INT, price:STR,
  timestamp:INT(s), avg_price:STR }`
- `deleverage` content: `{ id, usdc_amount:STR, size:STR, market_index:INT, settlement_price:STR, timestamp:INT(s) }`

`content` is polymorphic on `kind` — model as a discriminated union with an `unknown`-carrying default arm so a new
server-side kind never breaks parsing. Acknowledgement is **REST-only**: `POST /api/v1/notification/ack`.

#### 6.2.17 `pool_info` / `pool_data` `[DOC]`

```
pool_info: { channel:"pool_info:{A}", type:"subscribed/pool_info",
  pool_info:{ status:INT, operator_fee:STR, min_operator_share_rate:STR,
    total_shares:INT, operator_shares:INT, annual_percentage_yield:F64, sharpe_ratio:F64,
    daily_returns:[{timestamp:INT, daily_return:F64}],
    share_prices:[{timestamp:INT, share_price:F64}],
    strategies:[{collateral:STR}] } }

pool_data: { channel:"pool_data:{A}", type:"subscribed/pool_data", account:INT,
  trades:{ "{M}":[Trade] }, orders:{ "{M}":[Order] }, positions:{ "{M}":[Position] },
  shares:[PoolShare], funding_histories:{ "{M}":[PositionFunding] } }
```
Note `positions` here maps to an **array** per market, unlike `account_all` where it maps to a single object.

#### 6.2.18 `account_spot_avg_entry_prices` `[DOC]`

```
{ type:"subscribed/account_spot_avg_entry_prices", channel:"account_spot_avg_entry_prices:{A}",
  timestamp:INT(ms),
  avg_entry_prices: { "{ASSET_INDEX}": { asset_id:INT, avg_entry_price:STR, asset_size:STR,
                                         last_trade_id:INT } } }
```

#### 6.2.19 `rfq` `[DOC]`

```
{ type:"update/rfq", channel:"rfq",
  rfqs: [ { id:INT, account_index:INT, market_index:INT, direction:INT (+1/−1),
            base_amount:STR, quote_amount:STR, status:"opened"|…,
            metadata:OBJECT, responses:ARRAY, created_at:INT(ms), updated_at:INT(ms) } ] }
```

---

## 6.3 Order-book reconciliation — the exact algorithm

This is the only channel with true delta semantics and the only one where getting it wrong produces silently wrong
prices. Specified normatively.

### 6.3.1 State

```
OrderBookState = {
  marketIndex: number
  status:   'empty' | 'synced' | 'stale'
  bids:     Map<bigint /* toScaled(price,18) */, { price: string, size: string, sizeScaled: bigint }>
  asks:     Map<bigint, { … }>
  nonce:      bigint        // sequence AFTER the last applied message
  offset:     bigint
  lastUpdatedAtUs: bigint
  sortedBidsDirty / sortedAsksDirty: boolean
}
```

### 6.3.2 Applying a snapshot (`subscribed/order_book`)

```
clear(bids); clear(asks)
for side in (asks, bids):
    for level in msg.order_book[side]:
        s = toScaled(level.size, 18)
        if s > 0n: side.set(toScaled(level.price, 18), {price: level.price, size: level.size, sizeScaled: s})
        // levels with size 0 in a snapshot are dropped, not stored
nonce  = BigInt(msg.order_book.nonce)
offset = BigInt(msg.order_book.offset)
status = 'synced'
emit RESET(reason='snapshot'), then emit BOOK
```

### 6.3.3 Applying a delta (`update/order_book`)

```
b = BigInt(msg.order_book.begin_nonce)
n = BigInt(msg.order_book.nonce)

// 1. continuity gate — evaluated BEFORE any mutation
if status != 'synced':            return { ok:false, reason:'not-synced' }   // drop, awaiting snapshot
if n <= nonce:                    return { ok:false, reason:'stale' }        // duplicate/replay, drop silently
if b != nonce:                    status = 'stale'; return { ok:false, reason:'gap', expected: nonce, got: b }

// 2. mutate — only reached when b == nonce
for side in (asks, bids):
    for level in msg.order_book[side]:
        k = toScaled(level.price, 18)
        s = toScaled(level.size, 18)
        if s == 0n: side.delete(k)                       // tombstone
        else:       side.set(k, {price, size, sizeScaled: s})

nonce  = n
offset = BigInt(msg.order_book.offset)
lastUpdatedAtUs = BigInt(msg.order_book.last_updated_at)

// 3. sanity gate — a crossed book means we mis-applied or missed something
if bestBid() != undefined && bestAsk() != undefined && bestBid().priceScaled >= bestAsk().priceScaled:
    status = 'stale'; return { ok:false, reason:'crossed' }

return { ok:true }
```

The continuity rule is stated by Lighter as: *"this channel sends a complete snapshot on subscription, but only
state changes after that. To verify the continuity of the data, you can check that `begin_nonce` on the current
update matches the `nonce` (i.e. `last_nonce`) of the previous update."* `[DOC]`

Notes:
- `offset` is **not** usable as the continuity key. It is a coarser version counter (the reference paper client
  stores it and never checks it). Use `nonce`/`begin_nonce`. `[DESIGN]`
- The `nonce` in the snapshot is the anchor: the first delta after a snapshot must have
  `begin_nonce == snapshot.order_book.nonce`.
- Zero-size levels in a *snapshot* are dropped rather than stored, so a subsequent tombstone for that price is a
  harmless no-op `delete`.

### 6.3.4 Sorted views

`bids` descending by `priceScaled`, `asks` ascending. Maintain lazily: mark dirty on mutation, materialise on read,
memoise. Deltas are small (tens of levels), reads are frequent, so a sorted array rebuilt per *changed batch* is
cheaper than per-level binary-search splices only above ~1000 levels — measure before optimising. `topOfBook()`
is maintained incrementally and never triggers a full sort.

### 6.3.5 Gap detection and recovery `[DESIGN]`

Gap sources, in order of likelihood:
1. **Server-side drop** under load → `begin_nonce > nonce`.
2. **Client-side backpressure drop** — the consumer did not drain fast enough and the client discarded a delta.
   The client must *never* silently drop an order-book delta (§14.4).
3. **Reconnect** — a new socket restarts the chain; the old `nonce` is meaningless.
4. **Crossed book** — implies a mis-applied or missed delta even when nonces look contiguous.

Recovery algorithm (identical for all four sources):

```
1. Set status = 'stale'. Emit { kind:'reset', reason: 'gap' | 'reconnect' | 'crossed' }.
2. Discard every subsequent update/order_book for this market until a fresh snapshot arrives.
3. Send { type:'unsubscribe', channel:'order_book/{M}' }.
4. Send { type:'subscribe',   channel:'order_book/{M}' }  (after a small delay, default 100 ms, to let the
   unsubscribe be processed and to avoid error 30003).
5. On the next subscribed/order_book, run §6.3.2 and set status='synced'.
6. If N (default 5) consecutive gaps occur inside a rolling window (default 60 s), escalate to a full socket
   reconnect — a persistently gapping subscription usually indicates the connection, not the channel.
```

**Do not attempt to seed the book from REST.** `GET /api/v1/orderBookOrders` returns levels with no `nonce`, so
there is no way to splice a REST snapshot into the WS delta chain without a race. WS resubscription is the only
sound recovery path. `[DESIGN]`

Callers must be able to observe staleness. `OrderBookState.status` is public and every `reset` event is delivered
on the subscription stream, so a trading strategy can halt quoting the instant the book goes stale rather than
quoting off a divergent book.

---

## 7. Authentication over WebSocket

### 7.1 Where the token goes `[REF]`

Only in the `subscribe` frame, as the string field `auth`. There is no login frame, no header, no query param, no
re-auth frame. A token is bound to the subscription, not to the connection.

```json
{"type":"subscribe","channel":"account_all_assets/1234","auth":"1753468800:1234:0:9f3a…"}
```

### 7.2 Token construction `[REF]`

The auth token is not a JWT. It is a colon-joined tuple:

```
token = "{deadlineUnixSeconds}:{accountIndex}:{apiKeyIndex}:{signatureHexLowercase}"
```

where the signed message is the **prefix without the signature**:

```
message = "{deadlineUnixSeconds}:{accountIndex}:{apiKeyIndex}"
```

The message string is converted to Goldilocks field elements by canonical little-endian byte packing, hashed to a
quintic extension element with the project's Poseidon2 instance, serialised little-endian, and signed with the
Schnorr-over-Poseidon2 API key. Full details are in the crypto/signing spec — this document only fixes the **string
layout** and the fact that the same token string is used verbatim for both authenticated REST calls and WS
`subscribe` frames.

### 7.3 Expiry `[REF]`

- Default deadline used by the reference client: **now + 10 minutes**.
- Documented maximum: **8 hours**. `[DOC]`
- The deadline is absolute Unix **seconds**, embedded in the token, so the server can reject without state.

### 7.4 Failure modes

| Condition | Expected server behaviour |
|---|---|
| `auth` missing on a channel that requires it | Subscribe rejected; error code in the 30000–30012 band (most likely 30012 `"Failed to subscribe"`) `[INFER]` |
| `auth` present but expired | Subscribe rejected `[INFER]` |
| `auth` signature invalid | 21120 `"invalid signature"` `[DOC]` |
| `auth` references an unknown API key index | 21109 `"api key not found"` / 21110 `"invalid api key index"` `[DOC]` |
| Token expires *while subscribed* | **Undocumented and untested.** Two possibilities: (a) the stream continues because the token was only checked at subscribe time, or (b) the server drops the subscription. `[INFER]` |

**Design rule `[DESIGN]` — assume the worst.** The client holds an `AuthTokenProvider` (`() => string |
Promise<string>`), calls it fresh for **every** subscribe and **every** resubscribe-after-reconnect, and runs a
`authRefreshMs` timer (default: `min(tokenLifetime/2, 5 min)`) that proactively unsubscribes and resubscribes
authenticated channels with a new token. The provider is the integration point for the read-only pre-generated
token scheme (tokens minted on 6-hour boundaries with 8-hour validity, giving 2 h of overlap `[REF]`), so a browser
or Worker can stream private channels without ever holding an API private key.

The unsubscribe/resubscribe refresh cycle causes a snapshot re-delivery on the refreshed channel. For order books
that is a `reset`; for account channels it is a harmless full-state refresh. Refresh is therefore scheduled with
jitter so that N channels do not all resync in the same tick.

---

## 8. Sending transactions over WebSocket

### 8.1 Single transaction `[REF]` `[DOC]`

```json
{
  "type": "jsonapi/sendtx",
  "data": {
    "id": "<optional client correlation id, string>",
    "tx_type": 14,
    "tx_info": { /* the signed tx body, as a JSON OBJECT */ }
  }
}
```

### 8.2 Batch `[REF]` `[DOC]`

```json
{
  "type": "jsonapi/sendtxbatch",
  "data": {
    "id": "<optional client correlation id, string>",
    "tx_types": "[14,15]",
    "tx_infos": "[{…},{…}]"
  }
}
```

**The asymmetry is real and mandatory** `[REF]`: in `jsonapi/sendtx`, `tx_info` is an **embedded JSON object**; in
`jsonapi/sendtxbatch`, `tx_types` and `tx_infos` are **JSON-encoded strings** containing arrays. This mirrors the
REST endpoints, which are `application/x-www-form-urlencoded` and therefore stringify everything. It is accidental
complexity leaking from the form-encoded REST shape into a JSON transport. The TypeScript client hides it entirely:
callers pass typed values, the codec emits the correct spelling per envelope.

Batch constraints `[DOC]` `[REF]`:
- Maximum **15** transactions per batch.
- All transactions in a batch must be signed by the **same API key index**, with strictly consecutive nonces, so
  the server can order them deterministically. The nonce manager must be asked to advance the nonce *without*
  rotating the key for every tx after the first in a batch.

### 8.3 Correlation and acknowledgement

`data.id` is documented in the reference only as "optional, helps id the response" `[REF]`. The ack shape is **not
published**. The REST equivalents return:

```
RespSendTx      { code:INT, message:STR?, tx_hash:STR,   predicted_execution_time_ms:INT, volume_quota_remaining:INT }
RespSendTxBatch { code:INT, message:STR?, tx_hash:[STR], predicted_execution_time_ms:INT, volume_quota_remaining:INT }
```
`code == 200` means accepted into the mempool `[DOC]`. Note `RespSendTxBatch.tx_hash` is an **array** despite the
singular key name.

**Working assumption `[INFER]`:** the WS ack is one frame carrying the same fields plus the echoed `id`, wrapped in
the standard envelope (`type: "jsonapi/sendtx"`). **Must be captured from a live socket before release.**

**Design rule `[DESIGN]` — do not bet the client on the echo.** The tx dispatcher implements two matching
strategies and picks automatically:
1. **By id** (preferred): the client always generates an id (`tx-<counter>-<random>`), registers a pending promise,
   and resolves on an ack whose `id` matches.
2. **FIFO fallback**: if the first ack observed on a connection carries no recognisable `id`, the dispatcher
   permanently switches that connection to FIFO matching — acks resolve pending tx promises in submission order.
   This is sound because the client serialises tx frames on the wire.

Every pending tx has a timeout (`sendTxTimeoutMs`, default **10 000 ms**) and rejects with `LighterWsTimeoutError`
carrying the locally-computed tx hash so the caller can still poll `GET /api/v1/tx?by=hash`.

### 8.4 The signed hash is authoritative `[REF]`

The signing step yields the transaction hash locally. If the server computed a different hash the signature would
not verify, so the server's returned hash is always identical to the locally computed one. Practical consequences:

- The client can return the tx hash **synchronously from signing**, before the ack arrives.
- A timed-out or dropped ack does **not** mean the tx failed. Recovery is `GET /api/v1/tx?by=hash` or the
  `account_tx/{A}` channel (§6.2.15), which is the reason that channel exists.

**Design rule `[DESIGN]`:** `sendTx()` returns `{ txHash, ack: Promise<SendTxAck> }` so callers can choose whether
to await confirmation, and `sendTxAndWait()` additionally correlates against a live `account_tx` subscription to
resolve on *execution* (`status === 2`) rather than *acceptance*.

### 8.5 Read-only sockets

A socket opened with `?readonly=true` must reject tx frames. The client tracks the flag and throws
`LighterWsReadOnlyError` client-side rather than emitting a frame that will be rejected. `[DESIGN]`

### 8.6 Rate limiting of tx frames `[DOC]`

`sendTx` / `sendTxBatch` are **excluded** from the 200-messages-per-minute WS budget and from the 50-inflight
limit; they count against the REST request limits instead. So the client's outbound token bucket (§10.3) must have
a separate lane for tx frames.

---

## 9. Keepalive, ping/pong, and close

### 9.1 Server-initiated application ping `[REF]`

```
server → {"type":"ping"}
client → {"type":"pong"}
```

This is an **application-level** JSON ping, not an RFC 6455 control frame. The reference client answers immediately
and unconditionally. There is no `id`/nonce to echo. Interval is not advertised.

Note: the reference SDK's helper for this is misleadingly named `ws_ping` but sends `{"type":"pong"}` `[REF]` —
harmless, but do not copy the naming.

### 9.2 Client keepalive obligation `[DOC]`

*"Clients are responsible for keeping the connection alive by sending at least one frame every 2 minutes. If the
server receives no frames from a client within the 2-minute window, it will close the connection."* Either a
WebSocket ping control frame or any application message satisfies this.

**The portability problem `[DESIGN]`:** the WHATWG `WebSocket` API exposed in browsers, Cloudflare Workers, Deno,
and Bun provides **no way to send a ping control frame**. Only Node's `ws` package does, and we have banned it.
Therefore the client must satisfy the 2-minute rule with an application frame.

Which frame is safe? Not `subscribe` (returns 30003 on an active channel). Not an invented type (risks 30001
`"Invalid Type"`). The one type the server provably accepts from a client and that carries no state is **`pong`**.

**Keepalive policy `[DESIGN]`:**
- Every server `ping` is answered with `pong` immediately; this alone satisfies the obligation whenever the server
  is probing.
- A timer tracks time since the **last outbound frame**. If it reaches `keepAliveMs` (default **45 000 ms**, well
  inside the 120 s window with room for two missed attempts), send an unsolicited `{"type":"pong"}`.
- Configurable via `keepAlive: { intervalMs, frame: () => object | null }` so an integrator can substitute a
  different filler if the server later rejects unsolicited pongs.

### 9.3 Inbound staleness watchdog `[DESIGN]`

Independently, a timer tracks time since the **last inbound frame**. If it exceeds `stalenessTimeoutMs` (default
**90 000 ms**) the socket is presumed dead — half-open TCP connections are common on mobile and behind NAT and do
not surface as a `close` event. The client force-closes with code `4000` and enters the reconnect path. Any active
subscription that produces no traffic on its own (e.g. an illiquid order book) is still covered because server
pings keep arriving.

### 9.4 Close codes `[DESIGN]` `[INFER]`

Lighter does not document close codes. The client classifies as follows:

| Code | Class | Reconnect? |
|---|---|---|
| 1000 Normal | If initiated by us → terminal. If by server → treat as a deploy-time drain | yes, unless client-initiated |
| 1001 Going Away | Server restart / deploy | yes, immediately (jittered short backoff) |
| 1006 Abnormal | Network failure, no close frame | yes |
| 1008 Policy Violation | Likely auth or rate-limit enforcement | yes, but with the backoff floor raised and an `auth` diagnostic emitted |
| 1011 Internal Error | Server fault | yes |
| 1012/1013 Restart / Try Again Later | yes, honour `retry-after` semantics if present | yes |
| 4000 (ours) | Staleness watchdog | yes |
| 4001 (ours) | Fatal protocol error (binary frame, unparseable JSON storm) | yes |

The docs explicitly warn: *"deployments without downtime may disconnect your connection, so implementing proper
reconnection logic along with ping/pong mechanisms is recommended."* `[DOC]` Server-initiated disconnects are a
**normal, expected, frequent** event, not an error condition. The client must not surface them as errors by
default.

### 9.5 Reference client's reconnect policy `[REF]`

There isn't one. The Python `WsClient` raises an exception from `on_close` and from `on_error`, and its read loop
terminates when the socket closes. `PaperOrderBookListener` likewise propagates and stops. **Reconnection,
resubscription, and gap recovery are entirely absent from the reference implementation.** This is the single
largest functional gap we are closing.

---

## 10. Reconnect, resubscribe, backoff, and limits

### 10.1 Backoff `[DESIGN]`

Exponential with **full jitter**:

```
attempt n (0-based):  cap = min(maxDelayMs, baseDelayMs * 2^n)
                      delay = random() * cap        // full jitter
```
Defaults: `baseDelayMs = 250`, `maxDelayMs = 30_000`, unlimited attempts. Full jitter (not equal jitter, not
decorrelated) because many Workers isolates reconnecting after a Lighter deploy is exactly the thundering-herd
case it is designed for.

The attempt counter resets to 0 after the connection has been continuously `OPEN` for `stableAfterMs`
(default **30 000 ms**) — not on `open`, which would let a crash-loop reconnect at full speed forever.

Special cases: `1001 Going Away` starts at attempt 0 but with `baseDelayMs` raised to 1000 (a deploy takes seconds,
hammering it is pointless). Repeated `1008` raises the floor to 5000 and emits an `auth-suspect` diagnostic.

### 10.2 Resubscribe `[DESIGN]`

The client keeps a **desired-subscription table** keyed by canonical slash-form channel key. On reaching `READY`:

1. Emit `{kind:'reset', reason:'reconnect'}` on every subscription; mark every order-book maintainer `stale`.
2. For each desired subscription, resolve a **fresh** auth token if the channel is authenticated (the old token may
   have expired during the outage).
3. Emit subscribe frames, paced by the outbound token bucket (§10.3) so a 400-channel client does not immediately
   trip 30009.
4. Await `subscribed/*` per channel with a `subscribeTimeoutMs` (default 15 000 ms). A channel that fails to
   confirm is retried once, then reported via `{kind:'error'}` on its stream and left in `pending`.

Unsubscribing while disconnected removes the entry from the desired table; no frame is sent.

### 10.3 Server limits the client must respect `[DOC]`

Per IP address:

| Limit | Value |
|---|---|
| Concurrent connections | 255 |
| New connections per minute | 255 |
| Subscriptions per connection | 500 |
| Unique accounts per connection | 500 |
| Client messages per minute | 200 (excludes `sendTx`/`sendTxBatch`) |
| Inflight messages | 50 (excludes tx submissions) |

Violations surface as 23000–23004 and 30009/30010 (§11). REST and WS limits interact: being rate-limited on one
affects the other. `[DOC]`

**Design rules `[DESIGN]`:**
- An outbound **token bucket** of 200 tokens / 60 s (refilled continuously, not in steps) gates every non-tx frame.
  `subscribe`, `unsubscribe`, and keepalive `pong` all draw from it. Tx frames use a separate unlimited lane
  (they're governed by REST limits) but are still serialised.
- A semaphore of `maxInflight` (default 40, headroom under the documented 50) gates frames awaiting a reply.
- `LighterWsClient` **refuses** to exceed 500 subscriptions on one socket and throws a typed error pointing at
  `LighterWsPool`.
- `LighterWsPool` shards subscriptions across N sockets by a stable hash of the channel key, keeping all
  subscriptions for a given account on the same socket (so the unique-accounts limit is respected) and all order
  books for a market on the same socket (so a maintainer never spans connections).

---

## 11. Error codes

The WS error envelope is undocumented `[INFER]`; the code space is documented `[DOC]`. The client parses any
inbound object that carries a numeric `code` outside the success range, or `type === "error"`, as an error, and
routes it to the subscription named by `channel` if present, otherwise to the client-level `error` event.

**WebSocket band (30000–30012)** `[DOC]`

| Code | Message |
|---|---|
| 30000 | Invalid Json |
| 30001 | Invalid Type |
| 30002 | Not Subscribed to _ |
| 30003 | Already Subscribed to _ |
| 30004 | Failed to fetch _ |
| 30005 | Invalid Channel |
| 30006 | Operation isn't supported _ |
| 30007 | Invalid Data |
| 30008 | Invalid account type |
| 30009 | Too Many Websocket Messages! |
| 30010 | Too Many Inflight Messages! |
| 30011 | Failed to connect |
| 30012 | Failed to subscribe |

**Rate-limit band (23000–23004)** `[DOC]`

| Code | Message |
|---|---|
| 23000 | Too Many Requests! |
| 23001 | Too Many Subscriptions! |
| 23002 | Too Many Different Accounts! |
| 23003 | Too Many Connections! |
| 23004 | Too Many L2 Withdrawal Requests! |

**Auth/key band (selected)** `[DOC]`: 21109 api key not found · 21110 invalid api key index · 21120 invalid
signature · 61005 api token not found or does not belong to this account · 61006 api token has already been
revoked.

**Client handling `[DESIGN]`:**

| Code | Action |
|---|---|
| 30003 | Treat as success — we already have that subscription (idempotent resubscribe race) |
| 30002 | Treat unsubscribe as success |
| 30009 / 23000 | Tighten the token bucket (halve the refill rate for 60 s), do **not** disconnect |
| 30010 | Reduce `maxInflight` by 25 %, retry after 1 s |
| 23001 / 23002 / 23003 | Fatal for this socket: reject further subscribes with a typed error naming the limit |
| 21109 / 21110 / 21120 / 30012 on an authed channel | Invalidate the cached token, ask the provider for a fresh one, retry **once**; then surface `LighterWsAuthError` on that subscription |
| 30000 / 30001 / 30005 / 30007 | Bug in our codec — log loudly with the offending frame, do not retry |

---

## 12. What the reference implementations get wrong

Recorded so we don't reproduce it.

### 12.1 `lighter/ws_client.py`

1. **No continuity checking whatsoever.** `nonce`/`begin_nonce` are never read. A dropped delta produces a silently
   divergent book with no signal. This is a correctness bug for anything that trades off the book.
2. **The delta merge is O(new × existing) and buggy.** It iterates a *copy* of the existing side while mutating the
   original, decides "is this a new price" against that stale copy, and then does a second full filter pass. For a
   500-level book with a 40-level delta that is 20 000 string comparisons per message, several thousand times a
   second.
3. **The book is never sorted.** New prices are appended in arrival order, so `asks[0]` is not the best ask. Any
   consumer computing a mid price from index 0 is wrong.
4. **Price identity is string equality** on the raw wire string. `"2064.50"` and `"2064.5"` become two levels.
5. **Size comparison uses `float()`**, so a size that should compare equal to zero can miss the tombstone path.
6. **Any unrecognised message type raises**, killing the read loop — including `error` frames, any
   `subscribed/*` for a channel family it doesn't know, and the `unsubscribed/*` ack.
7. **`on_close` and `on_error` raise.** No reconnect, no resubscribe, no backoff (§9.5).
8. **Account state is replaced wholesale** by each `update/account_all` message. If updates are partial (§6.2.8),
   this discards positions and assets that simply didn't change in that frame.
9. **Only 3 of 22 channels are supported**, and the constructor hard-codes two of them into named callbacks.
   Subscribing to a trade stream requires bypassing the client entirely.
10. **No client-side keepalive.** It only answers server pings. A subscription-only client that the server stops
    probing gets disconnected at the 2-minute mark.
11. **Sync and async paths are duplicated** with divergent behaviour (the sync path never handles `connected` in
    `on_message_async`'s delegation cleanly).

### 12.2 `lighter/paper_client/`

12. Tracks `offset` but never validates it, and never looks at `nonce` — same class of bug as (1).
13. Sorts and compares levels by `float(price)` — precision loss on prices with more than ~15 significant digits,
    and non-deterministic tie ordering.
14. Opens **one WebSocket connection per market**, which burns the 255-connections-per-IP budget at 255 markets
    and multiplies handshake cost. The protocol multiplexes; the client should too.

### 12.3 Ergonomics we are deliberately changing

15. `WsClient` takes `on_order_book_update` / `on_account_update` as constructor args, so you cannot add a
    subscription after construction. Ours has `subscribe()` at any time.
16. Sending a tx over WS in the reference means hand-assembling the envelope in userland (`examples/utils.py` is
    not part of the shipped package) and doing a blocking `recv()` that steals whatever frame arrives next —
    including an unrelated order-book update. Ours correlates properly.
17. The reference exposes `tx_info` as a JSON **string** from the signer and then re-parses it to embed in the
    single-tx envelope, while passing it straight through as a string in the batch envelope. Our signer returns a
    typed object and the WS codec serialises per envelope.

---

## 13. TypeScript design

### 13.1 Module layout

```
src/ws/
  index.ts          — public barrel (re-exports; no side effects)
  transport.ts      — WebSocketLike adapter, connect/close, backoff, keepalive, staleness watchdog
  backoff.ts        — full-jitter exponential backoff (pure, testable)
  ratelimit.ts      — token bucket + inflight semaphore (pure)
  protocol.ts       — envelope discrimination, channel-key codec, error classification
  json.ts           — parseFrameJson (big-int-safe pre-pass), stringifyFrame
  decimal.ts        — toScaled / fromScaled / normaliseDecimal (pure, exact, no float)
  channels.ts       — the typed channel registry (§13.3)
  types.ts          — payload interfaces for every channel
  subscription.ts   — Subscription: AsyncIterable + callback, bounded queue, overflow policy
  client.ts         — LighterWsClient
  send-tx.ts        — tx dispatcher, correlation, ack matching
  orderbook.ts      — OrderBookState + watchOrderBook
  pool.ts           — LighterWsPool (sharding across sockets)
```

Every file is side-effect-free at import. `package.json` `exports` map exposes `./ws` separately from `./rest` and
`./signer` so a market-data-only Worker bundles neither the signer nor the REST models.

### 13.2 Runtime-agnostic transport

No `ws` package, no `node:` imports. The client resolves a WebSocket constructor in this order: explicit
`options.WebSocket` → `globalThis.WebSocket` → throw a typed error naming the runtimes that need a polyfill.
Node 20 ships a global `WebSocket` behind `--experimental-websocket`; Node 22+ has it unflagged; Bun, Deno,
Workers, and browsers all have it. Node 20 users pass `{ WebSocket: (await import('undici')).WebSocket }`.

```ts
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(t: 'open',    cb: () => void): void;
  addEventListener(t: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(t: 'error',   cb: (e: unknown) => void): void;
  addEventListener(t: 'close',   cb: (e: { code: number; reason: string }) => void): void;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;
```

Cloudflare Workers note: a Worker cannot hold an outbound WebSocket open across requests unless it runs in a
Durable Object. The docs for this package must say so plainly, and `LighterWsClient` must work when constructed
inside a DO's constructor and driven by DO alarms. All timers use `setTimeout`/`clearTimeout` only (no
`setInterval`, no `unref`), so DO hibernation semantics are respected.

### 13.3 The channel registry

One decisive API. Channels are values, not strings, so the type of what you receive is derived from what you
subscribed to.

```ts
export interface ChannelSpec<Snapshot, Update> {
  readonly family: string;            // "order_book"
  readonly key: string;               // "order_book/0"   (slash form, outbound)
  readonly requiresAuth: boolean;
  readonly accountIndex?: number;     // for pool sharding + unique-account accounting
  readonly marketIndex?: number;
  parseSnapshot(raw: unknown): Snapshot;
  parseUpdate(raw: unknown): Update;
}

export const channels = {
  orderBook:      (market: number)                       => ChannelSpec<OrderBookMessage, OrderBookMessage>,
  ticker:         (market: number)                       => ChannelSpec<TickerMessage, TickerMessage>,
  trades:         (market: number)                       => ChannelSpec<TradeMessage, TradeMessage>,
  marketStats:    (market: number | 'all')               => ChannelSpec<MarketStatsMessage, MarketStatsMessage>,
  spotMarketStats:(market: number | 'all')               => ChannelSpec<SpotMarketStatsMessage, …>,
  candles:        (market: number, r: CandleResolution)  => ChannelSpec<CandleMessage, CandleMessage>,
  markPriceCandles:(market: number, r: CandleResolution) => ChannelSpec<MarkPriceCandleMessage, …>,
  height:         ()                                     => ChannelSpec<HeightMessage, HeightMessage>,
  accountAll:            (account: number)               => ChannelSpec<AccountAllMessage, AccountAllMessage>,
  accountMarket:         (market: number, account: number) => ChannelSpec<AccountMarketMessage, …>,
  accountStats:          (account: number)               => ChannelSpec<UserStatsMessage, UserStatsMessage>,
  accountTxs:            (account: number)               => ChannelSpec<AccountTxMessage, AccountTxMessage>,
  accountOrders:         (account: number)               => ChannelSpec<AccountAllOrdersMessage, …>,
  accountMarketOrders:   (market: number, account: number) => ChannelSpec<AccountOrdersMessage, …>,
  accountTrades:         (account: number)               => ChannelSpec<AccountAllTradesSnapshot, AccountAllTradesUpdate>,
  accountPositions:      (account: number)               => ChannelSpec<AccountAllPositionsMessage, …>,
  accountAssets:         (account: number)               => ChannelSpec<AccountAssetsMessage, AccountAssetsMessage>,
  accountSpotAvgEntry:   (account: number)               => ChannelSpec<SpotAvgEntryMessage, …>,
  poolData:              (account: number)               => ChannelSpec<PoolDataMessage, PoolDataMessage>,
  poolInfo:              (account: number)               => ChannelSpec<PoolInfoMessage, PoolInfoMessage>,
  notifications:         (account: number)               => ChannelSpec<NotificationMessage, NotificationMessage>,
  rfq:                   ()                              => ChannelSpec<RfqMessage, RfqMessage>,
} as const;

export type CandleResolution = '1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'12h'|'1d';
```

Note `accountAllTrades` is the one channel whose snapshot and update types genuinely differ (§6.2.13); the generic
`ChannelSpec<S, U>` exists precisely so that asymmetry is expressible rather than papered over.

### 13.4 Client

```ts
export interface LighterWsOptions {
  network?: 'mainnet' | 'testnet' | 'robinhood' | 'robinhood_testnet';
  url?: string;                          // overrides network
  readOnly?: boolean;                    // appends ?readonly=true and blocks tx frames
  auth?: AuthTokenProvider;
  WebSocket?: WebSocketConstructor;
  autoConnect?: boolean;                 // default true on first subscribe()
  handshakeTimeoutMs?: number;           // 3_000
  subscribeTimeoutMs?: number;           // 15_000
  sendTxTimeoutMs?: number;              // 10_000
  keepAliveMs?: number;                  // 45_000
  stalenessTimeoutMs?: number;           // 90_000
  reconnect?: false | { baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; stableAfterMs?: number };
  maxSubscriptions?: number;             // 500
  maxInflight?: number;                  // 40
  outboundPerMinute?: number;            // 200
  defaultOverflow?: OverflowPolicy;      // 'drop-oldest'
  queueLimit?: number;                   // 1_024
  clock?: () => number;                  // injectable for tests
  onDiagnostic?: (d: Diagnostic) => void;
}

export type AuthTokenProvider =
  (ctx: { accountIndex?: number; channel: string }) => string | Promise<string>;

export class LighterWsClient {
  constructor(options?: LighterWsOptions);

  readonly state: 'idle'|'connecting'|'handshaking'|'open'|'reconnecting'|'closed';
  readonly url: string;

  connect(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;

  subscribe<S, U>(spec: ChannelSpec<S, U>, opts?: SubscribeOptions): Subscription<S, U>;

  sendTx(txType: number, txInfo: object, opts?: { id?: string; timeoutMs?: number }):
    Promise<{ txHash: string; ack: Promise<SendTxAck> }>;
  sendTxBatch(txTypes: number[], txInfos: object[], opts?: { id?: string; timeoutMs?: number }):
    Promise<{ txHashes: string[]; ack: Promise<SendTxBatchAck> }>;

  on(event: 'open'|'close'|'reconnect'|'error'|'diagnostic', cb: (e: never) => void): () => void;
}

export interface SubscribeOptions {
  overflow?: OverflowPolicy;
  queueLimit?: number;
  signal?: AbortSignal;
}
export type OverflowPolicy = 'drop-oldest' | 'drop-newest' | 'coalesce' | 'resubscribe' | 'error';
```

### 13.5 Subscription — one object, both consumption styles

```ts
export type ChannelEvent<S, U> =
  | { kind: 'snapshot'; data: S; raw: unknown; receivedAt: number }
  | { kind: 'update';   data: U; raw: unknown; receivedAt: number }
  | { kind: 'reset';    reason: 'reconnect'|'gap'|'crossed'|'auth-refresh'|'resubscribe' }
  | { kind: 'error';    code: number; message: string; fatal: boolean };

export interface Subscription<S, U> extends AsyncIterable<ChannelEvent<S, U>>, Disposable {
  readonly key: string;
  readonly state: 'pending'|'active'|'closed';
  /** Resolves with the first snapshot after the (re)subscribe currently in flight. */
  snapshot(): Promise<S>;
  /** Callback style. Returns an unsubscribe-the-callback function; does not close the subscription. */
  on(cb: (e: ChannelEvent<S, U>) => void): () => void;
  close(): Promise<void>;
  [Symbol.dispose](): void;
}
```

Why both: an `AsyncIterable` gives natural backpressure and `for await` ergonomics but cannot express "I want the
latest, drop the rest". A callback gives push semantics but no backpressure. Shipping one and telling users to
adapt is the mistake most exchange SDKs make. Both share one buffer; if a callback is registered, events are also
pushed to it synchronously *before* being enqueued for iterators, so a callback consumer is never subject to the
queue's overflow policy.

`await using sub = client.subscribe(...)` works via `Symbol.dispose`.

### 13.6 Backpressure

Each subscription owns a bounded ring buffer (`queueLimit`, default 1024 events). The overflow policy is per
subscription, and the **default differs by channel semantics**:

| Channel class | Default policy | Rationale |
|---|---|---|
| `order_book` | `resubscribe` | A dropped delta breaks the chain. Overflow must force a resync, not a silent hole. |
| `candle`, `ticker`, `market_stats`, `user_stats`, `account_all_assets`, `account_all_positions` | `coalesce` | Each message is a complete state; only the newest matters. Coalesce collapses the queue to one pending event. |
| `trade`, `account_tx`, `notification`, `account_all_trades` | `drop-oldest` + a `dropped` diagnostic carrying the count | Append-only histories; losing the oldest is recoverable via REST. |
| everything else | `drop-oldest` | — |

`'error'` closes the subscription with a typed overflow error; available for callers who want to fail loudly.
Dropped-event counts are always reported through `onDiagnostic` so silent data loss is impossible.

### 13.7 Order-book maintainer

```ts
export interface OrderBookLevel {
  readonly price: string;        // as delivered
  readonly size: string;
  readonly priceScaled: bigint;  // toScaled(price, 18)
  readonly sizeScaled: bigint;
}

export class OrderBookState {
  readonly marketIndex: number;
  readonly status: 'empty' | 'synced' | 'stale';
  readonly nonce: bigint;
  readonly offset: bigint;
  readonly lastUpdatedAtUs: bigint;

  get bids(): readonly OrderBookLevel[];   // descending
  get asks(): readonly OrderBookLevel[];   // ascending
  bestBid(): OrderBookLevel | undefined;
  bestAsk(): OrderBookLevel | undefined;
  midScaled(): bigint | undefined;
  spreadScaled(): bigint | undefined;
  /** Cumulative base size available up to and including `limitPriceScaled`. */
  depth(side: 'bid'|'ask', limitPriceScaled: bigint): bigint;
  /** Volume-weighted average fill price for a market order of `baseSize`, or undefined if the book is too thin. */
  vwap(side: 'bid'|'ask', baseSizeScaled: bigint): bigint | undefined;

  applySnapshot(msg: OrderBookMessage): void;
  applyUpdate(msg: OrderBookMessage): ApplyResult;
  toJSON(): { bids: {price:string;size:string}[]; asks: …; nonce: string; offset: string; status: string };
}

export type ApplyResult =
  | { ok: true }
  | { ok: false; reason: 'gap'; expected: bigint; got: bigint }
  | { ok: false; reason: 'stale' | 'not-synced' | 'crossed' };

export interface OrderBookWatcherOptions {
  maxGapsPerMinute?: number;      // 5 → escalate to full reconnect
  resubscribeDelayMs?: number;    // 100
  onGap?: (info: { marketIndex: number; expected: bigint; got: bigint }) => void;
}

export interface OrderBookWatcher extends AsyncIterable<OrderBookState>, Disposable {
  readonly book: OrderBookState;
  on(cb: (book: OrderBookState) => void): () => void;
  close(): Promise<void>;
}

export function watchOrderBook(
  client: LighterWsClient,
  marketIndex: number,
  options?: OrderBookWatcherOptions,
): OrderBookWatcher;
```

`watchOrderBook` owns the full recovery loop of §6.3.5 — the caller never sees a gap unless it asks. The
`AsyncIterable` yields the **same mutable `OrderBookState` instance** after each successfully applied message
(explicitly documented) so a hot loop allocates nothing; `toJSON()` / `snapshotOf(book)` produce immutable copies
for callers that need them.

### 13.8 Errors

```ts
export class LighterWsError            extends Error { readonly code?: number }
export class LighterWsAuthError        extends LighterWsError {}
export class LighterWsRateLimitError   extends LighterWsError { readonly limit: string }
export class LighterWsTimeoutError     extends LighterWsError { readonly txHash?: string }
export class LighterWsReadOnlyError    extends LighterWsError {}
export class LighterWsOverflowError    extends LighterWsError { readonly dropped: number }
export class LighterWsClosedError      extends LighterWsError { readonly wsCode: number }
```

### 13.9 Worked usage

```ts
import { LighterWsClient, channels, watchOrderBook } from '@lev7/lighter/ws';

const ws = new LighterWsClient({ network: 'mainnet' });

// Push style
const trades = ws.subscribe(channels.trades(0));
trades.on(e => { if (e.kind === 'update') for (const t of e.data.trades) console.log(t.price); });

// Pull style with backpressure
for await (const e of ws.subscribe(channels.candles(0, '1m'))) {
  if (e.kind !== 'reset') console.log(e.data.candles.at(-1));
}

// Order book with gap recovery handled for you
await using book = watchOrderBook(ws, 0);
for await (const b of book) {
  if (b.status !== 'synced') continue;      // never quote off a stale book
  console.log(b.bestBid()?.price, b.bestAsk()?.price);
}

// Private channel with a token provider
const authed = new LighterWsClient({
  network: 'mainnet',
  auth: async () => signer.createAuthToken({ ttlSeconds: 600 }),
});
authed.subscribe(channels.accountAssets(1234)).on(e => { /* … */ });

// Transaction over the same socket
const { txHash, ack } = await authed.sendTx(TxType.CreateOrder, txInfo);
console.log('submitted', txHash, 'accepted:', (await ack).code === 200);
```

---

## 14. Test plan

1. **Mock server harness** — an in-process WS server (Bun's `Bun.serve` for local runs, plus a pure in-memory
   `WebSocketLike` double so the same suites run under Workers' `vitest-pool-workers` and in a browser). It must be
   able to: emit `connected`, emit `ping`, emit snapshots/deltas with scripted nonces, inject gaps, inject
   duplicates, inject out-of-order frames, close with arbitrary codes, and stall.
2. **Order-book conformance** — a golden fixture of (snapshot, deltas…) with the expected final book, replayed with
   deltas dropped at every position to assert exactly one `gap` per drop and a correct book after recovery.
3. **Decimal exactness** — property test: `fromScaled(toScaled(s)) === normaliseDecimal(s)` for generated decimals;
   assert `toScaled` never touches `Number`.
4. **Big-int JSON pre-pass** — assert 16–19 digit ids round-trip losslessly and that frames without long integers
   take the fast path.
5. **Reconnect** — simulated closes at 1000/1001/1006/1008/1011; assert backoff distribution is bounded by the
   full-jitter formula, that `stableAfterMs` resets the counter, and that every subscription is re-established with
   a **freshly minted** auth token.
6. **Rate limiting** — assert ≤200 non-tx frames in any 60 s window while resubscribing 500 channels; assert tx
   frames bypass the bucket.
7. **Backpressure** — a slow `for await` consumer against a fast producer: assert the configured policy, assert the
   drop counter is reported, assert an order-book subscription resubscribes rather than dropping.
8. **Keepalive** — assert an outbound frame within `keepAliveMs` of the last one under total server silence, and
   that the staleness watchdog fires at `stalenessTimeoutMs`.
9. **Live conformance run** (manual, gated, testnet) — subscribe to all 22 channels, capture one snapshot and one
   update per channel to `fixtures/live/*.json`, and diff against the modelled types. This is what closes the
   `[INFER]` items in §15.
10. **Runtime matrix** — the full suite on Bun 1.3, Node 22, Node 20 + `undici` WebSocket, Deno, and
    `workerd` (in a Durable Object).

---

## 15. Open questions to resolve against a live server

Ordered by blast radius.

1. **`jsonapi/sendtx` ack envelope.** Exact `type`, whether `data.id` is echoed, whether `code`/`tx_hash` sit at
   the top level or under `data`. Blocks correct tx correlation; the FIFO fallback (§8.3) is our hedge.
2. **Are `update/account_*` messages partial or full?** Determines whether the account-state helpers merge or
   replace. Getting it wrong leaks phantom orders/positions. Affects `account_all`, `account_all_orders`,
   `account_orders`, `account_all_positions`, `account_market`.
3. **Does an in-flight subscription survive its auth token's expiry?** Determines whether the proactive refresh
   cycle (§7.4) is required or merely defensive.
4. **Which channels genuinely require `auth`?** The docs' subscribe examples for `account_all`, `user_stats`,
   `account_all_trades`, `account_all_positions` omit it and the reference client proves `account_all` works
   without — but this may be a docs omission rather than a policy.
5. **The WS error envelope.** Is it `{"type":"error","code":…,"message":…,"channel":…}`? Is `channel` present?
   Blocks precise per-subscription error routing.
6. **`market_stats/all` fan-out shape** — one frame per market, or one frame with a map?
7. **Snapshot type name for the channels where only `update/*` is documented** (`ticker`, `market_stats`,
   `spot_market_stats`, `trade`, `height`, `user_stats`, `account_tx`, `account_all_orders`, `account_orders`,
   `account_market`, `rfq`). Do they emit `subscribed/*` at all, or only `update/*`?
8. **`unsubscribed/*` ack shape**, and whether unsubscribe is even acknowledged.
9. **Does the server accept an unsolicited `{"type":"pong"}`** as a keepalive filler, or does it answer 30001?
   Fallback if not: send a `subscribe` to `height` and immediately `unsubscribe` (2 tokens/45 s from the bucket).
10. **Server ping interval** — needed to tune `stalenessTimeoutMs` below the point where a healthy but quiet
    connection is falsely reaped.
11. **Is `?encoding=json` honoured**, and what is the alternative encoding? If a compact binary encoding exists it
    could materially cut Worker CPU on order-book streams.
12. **Close codes actually used by Lighter**, particularly what a rate-limit disconnect and a deploy drain look
    like.
13. **Timestamp units for `PositionFunding.timestamp` and `height.timestamp`** — documented examples show both
    seconds and milliseconds.
14. **Order-book depth**: does `order_book/{M}` deliver the full book or a truncated top-N? If truncated, the
    tombstone/eviction semantics at the truncation boundary change the reconciliation rules materially.
15. **`account_orders` inbound `channel` really omits the account index** — confirm, since it forces the
    body-field routing fallback (§2.3 step 3).
