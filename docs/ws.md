# `lighter-ts/ws`

One socket, many subscriptions, kept alive across reconnects.

```ts
import { channels, LighterWsClient } from "lighter-ts/ws";

const ws = new LighterWsClient({ network: "mainnet" });
const book = ws.subscribe(channels.orderBook(0));

for await (const event of book) {
  switch (event.kind) {
    case "snapshot": /* full state */ break;
    case "update":   /* delta */ break;
    case "reset":    /* resubscribed; the next snapshot replaces everything */ break;
    case "error":    /* server-side channel error */ break;
  }
}
```

Construction is inert: no socket is opened, no timer is scheduled, and no global is read. The first
`connect()` — or the first `subscribe()` with `autoConnect` on, which is the default — starts the
machine. `LighterClient` exposes the same client as `lighter.ws`, built on first access.

> **The payload shapes in this layer are not verified against live traffic.** The handshake, the
> keepalive and the channel naming are; the per-channel body types are modelled from the reference
> client and the published examples. The capture that would confirm them was refused at the upgrade
> with API code `20558` (restricted jurisdiction), so `test/fixtures/ws/capture.json` is empty. Treat
> the payload types as best-effort and open an issue if a field disagrees with what you receive.

---

## The protocol

Connect to `wss://<host>/stream`. The server opens with an unsolicited `{"type":"connected"}`;
subscribe only after it arrives. The client waits `handshakeTimeoutMs` (default 3 000) for the
greeting and then subscribes anyway rather than hanging forever.

```
->  (upgrade)
<-  {"type":"connected"}
->  {"type":"subscribe","channel":"order_book/0"}
<-  {"type":"subscribed/order_book","channel":"order_book:0", …}
<-  {"type":"update/order_book","channel":"order_book:0", …}
```

Note the asymmetry: the outbound channel key uses a slash (`order_book/0`) and the server echoes it
back with a colon (`order_book:0`). `normaliseChannelKey` reconciles the two, and `Subscription.key`
is always the canonical slash form.

### Keepalive is application-level JSON

The server sends `{"type":"ping"}` and expects `{"type":"pong"}`. **This is not an RFC 6455 control
frame**, and that is exactly why this package needs no `ws` dependency: the WHATWG `WebSocket` API
exposes no way to send a protocol-level ping in a browser, in Cloudflare Workers, in Deno or in Bun.
A JSON heartbeat works identically everywhere.

The client sends `pong` and never `ping`. It answers the server's ping, and it also uses `pong` as
idle filler — the server closes a connection that has sent nothing for two minutes, and `pong` is
the one type it provably accepts from a stateless client. (The Python reference's helper is named
`ws_ping` and sends `pong`; the name is wrong, the behaviour is right.)

Two timers, both configurable, neither a repeating interval — a Durable Object cannot hibernate while
a repeating timer is live:

| knob | default | what it measures |
| --- | --- | --- |
| `keepAliveMs` | 45 000 | idle **outbound**: send a `pong` if nothing has been written |
| `stalenessTimeoutMs` | 90 000 | idle **inbound**: no frame in this long means the socket is dead, even if it never fired `close` |

A socket killed by the staleness watchdog reports close code `1006`, which is what a genuine abnormal
closure reports and is the honest answer: from the client's side the two are indistinguishable.

### When the upgrade fails

A refused upgrade carries no payload. The browser and Workers APIs surface it as `1006` with
`"Expected 101 status code"`, which names nothing — and from a restricted jurisdiction the real cause
is API code `20558`, which mentions neither the socket nor the code you are looking at.

So the layer probes: on a failed upgrade it issues a plain HTTPS `GET` against the same URL
(`upgradeProbeUrl`) and interprets the body (`diagnoseUpgradeFailure`). A geo-block then surfaces as
a geo-block instead of as a mysterious 1006. See [rest.md](rest.md#code-20558--geo-restriction).

---

## Channels

22 factories on the `channels` object, each returning a typed `ChannelSpec`:

| public | authenticated |
| --- | --- |
| `orderBook(m)` · `ticker(m)` · `trades(m)` | `accountAll(a)` · `accountMarket(m, a)` |
| `marketStats(m \| "all")` · `spotMarketStats(m \| "all")` | `accountStats(a)` · `accountTxs(a)` |
| `candles(m, r)` · `markPriceCandles(m, r)` | `accountOrders(a)` · `accountMarketOrders(m, a)` |
| `height()` | `accountTrades(a)` · `accountPositions(a)` |
| | `accountAssets(a)` · `accountSpotAvgEntry(a)` |
| | `poolData(a)` · `poolInfo(a)` · `notifications(a)` · `rfq()` |

A spec records whether the channel *requires* auth and whether it *accepts* it; several account
channels accept a token without requiring one. Supply a token source once, on the client:

```ts
const ws = new LighterWsClient({
  network: "mainnet",
  auth: async ({ accountIndex }) => tokenFor(accountIndex),
});
```

The provider is called fresh on every subscribe **and every resubscribe**, so a token that expires
during a long-lived connection is replaced at reconnect rather than replayed.

Naming quirks worth knowing before you go looking for a bug: the trade channel family is singular
(`trade`) while the payload key is plural (`trades`), liquidations arrive in a separate
`liquidation_trades` array, and `market_stats/all` fans out per-market echoes that
`resolveRouteKey` routes back to the single `all` subscription.

Spot market indices start at 2048.

---

## Subscriptions

```ts
subscribe<S, U>(spec: ChannelSpec<S, U>, opts?: SubscribeOptions): Subscription<S, U>
```

Legal in every state except `closed`. The entry goes into the desired-subscriptions table
immediately and the wire frame is emitted the next time the socket is ready, so you never have to
sequence `connect()` before `subscribe()`.

A subscription is an `AsyncIterable` **or** a callback target, never both:

```ts
for await (const e of sub) { … }        // one consumer
const off = sub.on((e) => { … });       // or one consumer, this way
```

A second consumer throws a `TypeError` naming the conflict rather than silently splitting the stream.
Unregistering releases the slot. `await sub.snapshot()` resolves with the first snapshot delivered
after the (re)subscribe currently in flight; a `reset` re-arms it, so after a resync it waits for the
*next* snapshot rather than handing back one that is stale by definition.

`sub.close()` is idempotent and never rejects. Where the runtime supports explicit resource
management, subscriptions and the client also carry `Symbol.dispose` / `Symbol.asyncDispose`.

### Event shape

```ts
type ChannelEvent<S, U> =
  | { kind: "snapshot"; data: S; raw: unknown; receivedAt: number }
  | { kind: "update";   data: U; raw: unknown; receivedAt: number }
  | { kind: "reset";    reason: "reconnect" | "gap" | "crossed" | "auth-refresh" | "resubscribe" }
  | { kind: "error";    code: number; message: string; fatal: boolean };
```

`raw` is the undecoded frame. It is there so an unmodelled field is never lost: this layer's types
are best-effort (see the warning above), and `raw` is the escape hatch that keeps that honest.

**A `reset` invalidates everything you have accumulated for that channel.** Drop your state and wait
for the next snapshot. That is the whole contract, and it is why resets are events rather than
silent.

### Unknown message types are forwarded, never fatal

The reference client raises on a message type it does not recognise, so a new server-side type takes
the client down. Here an unknown type is routed if it can be, reported as a diagnostic if it cannot,
and never throws. A callback or a tap that throws is reported as a `consumer-error` diagnostic and
the read loop keeps running.

---

## Ordering, offsets and resync-on-gap

`order_book` is the only channel with true delta semantics, and its frames carry the sequencing you
need:

| field | meaning |
| --- | --- |
| `nonce` | the sequence number **after** this message has been applied |
| `begin_nonce` | the sequence number this message expects to be applied **on top of** |
| `offset` | the stream offset, duplicated at the envelope and payload level |
| `last_updated_at` | epoch **microseconds**, not milliseconds |

`begin_nonce` is absent on a snapshot, because a snapshot has no predecessor — and that absence is
load-bearing: it is how an `update/order_book` frame that is really a snapshot gets reclassified.
(The published example is mislabelled.)

The rule is: if `begin_nonce !== yourCurrentNonce`, you have missed a message. Do not attempt to
repair the book. Discard it, resubscribe, and rebuild from the next snapshot. A dropped delta that is
quietly applied desynchronises the book silently and permanently, which is the reference client's
most consequential defect.

Maintain the book **sorted and price-indexed**. Snapshots arrive sorted, but updates *append* new
price levels to the end, so after the first new level `bids[0]` is no longer the best bid. Compare
prices as exact decimals, never as floats.

> **Status of the built-in maintainer.** `src/ws/orderbook.ts` implements all of this — offset
> tracking, gap and crossed-book faults, a sorted price-indexed book, and a `watchOrderBook` async
> iterable. It is **not currently reachable from the published surface**: the `./ws` barrel does not
> re-export it and there is no `lighter-ts/ws/orderbook` entry in the `exports` map. Until it is
> exported, apply the rules above to the raw `channels.orderBook(m)` stream yourself.

---

## Reconnection and backpressure

Reconnection is on by default with exponential backoff and automatic resubscribe of everything in
the desired table. `reconnect: false` disables it; otherwise pass `BackoffOptions`.

`classifyCloseCode` sorts a close code into `client-initiated`, `drain`, `network`, `policy`,
`server-error`, `stale` or `protocol`, and the classification decides whether to retry at all and how
hard. A policy close is not retried the way a network blip is.

Nothing is queued across a disconnect. A frame written to a socket that then dies is not a delivered
frame, so the client does not pretend otherwise; the layer that wants redelivery — the desired
subscription table — replays from the `ready` hook instead.

### Overflow

Each subscription owns a ring buffer, `queueLimit` frames deep (default 1 024). When a consumer falls
behind, the policy decides what gives:

| policy | behaviour |
| --- | --- |
| `drop-oldest` | default; keep the newest frames |
| `drop-newest` | keep the oldest |
| `coalesce` | collapse to the latest state where the channel's semantics allow it |
| `resubscribe` | tear the channel down and rebuild from a fresh snapshot |
| `error` | fail the subscription |

The default is resolved per family, because a dropped `order_book` delta breaks the sequence while a
dropped `ticker` is merely a stale quote. `LighterWsOverflowError` carries what was lost.

### Limits

| knob | default | what it caps |
| --- | --- | --- |
| `maxSubscriptions` | 500 | subscriptions on one socket |
| `maxInflight` | 40 | frames awaiting a reply |
| `outboundPerMinute` | 200 | non-`tx` outbound frames per 60 s |
| `subscribeTimeoutMs` | 15 000 | wait for a `subscribed/*` ack before one retry |

Exceeding a limit, or a latched server-side rate-limit code (23001/23002/23003), throws
`LighterWsRateLimitError` from `subscribe()`.

---

## Submitting transactions over the socket

The transaction half is deliberately separate from the subscription half: it is a different
capability with different failure modes, a market-data consumer never needs it, and attaching it
registers an inbound frame tap.

```ts
const dispatcher = lighter.wsTx;                       // or createTxDispatcher(wsClient)
```

It writes `jsonapi/sendtx` and `jsonapi/sendtxbatch` frames on the `tx` lane, correlates the acks by
tapping inbound frames before channel routing, and fails every pending ack when the socket goes away.
Batches are capped at `MAX_TX_BATCH_SIZE` (15). A `readOnly: true` client refuses `tx`-lane frames
synchronously, before anything reaches the wire (`LighterWsReadOnlyError`).

`jsonapi/sendtx` and `jsonapi/sendtxbatch` disagree about field typing on the wire, mandatorily, so
the dispatcher picks a matching strategy per connection rather than assuming one shape.

---

## Cloudflare Workers

**An outbound WebSocket cannot be held across requests outside a Durable Object** (risk R12). A
plain Worker's isolate does not survive between requests, so a socket opened in one request handler
is not available in the next. Submitting over the socket there means one connect-per-submission,
which is strictly worse than HTTP. **Prefer HTTP submission unless the code runs inside a Durable
Object.**

Inside a Durable Object the picture is different and the client is designed for it:

- construction opens nothing and reads no global, so a DO can build it in its constructor;
- there is **no repeating-interval timer** anywhere in this layer — every timer is a one-shot,
  because a Durable Object cannot hibernate while a repeating timer is live;
- `close()` leaves nothing scheduled.

Node 20 has no global `WebSocket`; pass one in (`WebSocket` on `LighterWsOptions` or on
`LighterClient`). Everywhere else the global is used, read lazily inside `connect()` rather than at
import.
