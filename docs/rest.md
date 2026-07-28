# `lighter-ts/rest`

78 typed operations over `https://<host>/api/v1`, a transport that classifies every response, and
cursor pagination.

```ts
import { LighterRestClient } from "lighter-ts/rest";

const rest = new LighterRestClient({ endpoint: "mainnet" });
const books = await rest.order.orderBooks({ filter: "perp" });
```

Or skip the facade. It references all 78 routes, so importing it defeats per-route tree-shaking —
an accepted trade for the ergonomics, but the untraded path stays available:

```ts
import { request, routes } from "lighter-ts/rest";

const books = await request(routes.orderBooks, { filter: "perp" }, { endpoint: "mainnet" });
```

Platform surface: `fetch`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal`, `setTimeout`.
No Node built-ins, nothing read from a global at module scope, no timers or randomness at import
time.

---

## The success rule

> A response succeeded **iff** the HTTP status is 2xx **and** (`code` is absent **or**
> `code === 200`).

Both halves matter, and each one alone is wrong.

Errors arrive as HTTP 4xx with `{"code": <int>, "message": <string>}`. Most success responses *also*
carry `"code": 200` in the body, so treating HTTP 200 as sufficient misses a body-level failure. But
requiring `code === 200` is equally wrong, because some endpoints carry no `code` field at all.
Measured:

```
GET /withdrawalDelay?account_index=1   ->   {"seconds":1542}
```

A missing `code` is success. That response is perfectly good, and a client that insists on
`code === 200` rejects it.

The predicate lives in exactly one function so nobody re-derives it:

```ts
import { isSuccess } from "lighter-ts/rest";

isSuccess(200, undefined); // true  — /withdrawalDelay
isSuccess(200, 200);       // true
isSuccess(200, 20001);     // false — 2xx with a body-level failure
isSuccess(400, 20558);     // false
```

Classification order, applied by `classifyResponse`:

1. body is not JSON → `LighterBlockedError`, carrying the raw body;
2. status not 2xx with a JSON body → `LighterApiError`, specialised to `LighterGeoRestrictedError`
   for code `20558` and `LighterAuthError` for HTTP 401 or code `20013`;
3. status 2xx with `code` present and not 200 → `LighterApiError`;
4. otherwise → the parsed body.

---

## A non-JSON body is normal

**CloudFront** sits in front of the API — not Cloudflare; the response headers say so
(`Server: CloudFront`, `X-Amz-Cf-Id`, `Via: … cloudfront.net`). Some paths are answered by the CDN
before they reach the API at all: `/api/v1/currentHeight` returns HTTP 403 with an HTML body and
`X-Cache: FunctionGeneratedResponse from cloudfront`.

Calling `.json()` unconditionally on that throws a `SyntaxError` that tells the caller nothing. The
transport detects the content type first and raises `LighterBlockedError` with the raw body attached.
**No `SyntaxError` ever escapes this layer.**

`x-amz-cf-id` is the one response header worth keeping — it is what a support ticket gets answered
from, and it is the only identifier on an interstitial that never reached the API. It is exposed as
`REQUEST_ID_HEADER` and carried on the error.

---

## Authentication

The auth token goes in **either** the `auth` query parameter **or** the `Authorization` header.
Neither reference SDK documents this; it was discovered from the error text on an unauthenticated
call:

```
GET /transferFeeInfo?account_index=1
{"code":20001,"message":"invalid param : auth query param and Authorization header are empty"}
```

**Use the header.** It is the default (`authIn: "header"`) and there is rarely a reason to change it:
the query parameter puts a bearer credential into the URL, and therefore into browser history,
server access logs, referrer headers and any proxy in between. `authIn: "query"` exists for
environments that strip `Authorization`, and for nothing else.

```ts
const rest = new LighterRestClient({
  endpoint: "mainnet",
  auth: async () => currentToken(),   // a constant string also works
});
```

Each route declares its own policy: 38 need no credential, 16 accept one optionally, 24 require one.
A route that requires a credential with none configured throws `LighterConfigError` before any
request is made. One 401 or code-`20013` response replays exactly once, after re-invoking the
`AuthProvider` — the clock-skew and expired-in-flight case.

Tokens are built by `lighter-ts/client`: see `createAuthToken` and `generateAuthTokenSchedule`. The
reference pre-generates tokens on 6-hour-aligned boundaries with an 8-hour expiry, so validity windows
overlap and a lookup by the current aligned timestamp always finds a live one.

### `User-Agent` is environment-conditional

On server runtimes the SDK sends a configurable browser-like `User-Agent`, because some paths return
a 403 HTML interstitial from the CDN without one. In a browser it sends none, and you must not add
one: `User-Agent` is a forbidden header name that the fetch spec drops silently, and adding custom
headers can push a simple request into a CORS preflight that then fails. The SDK detects the
environment rather than the runtime name; `userAgent` in the config is ignored in browser-like
environments.

---

## Errors

Check errors with the **structural type guards**, never with `instanceof`. Class identity does not
survive a bundler that duplicates a chunk, and it does not cross a realm boundary (a Worker, an
iframe, a `vm` context). The guards key on shape:

```ts
import {
  ERR_RESTRICTED_JURISDICTION,
  hasCode,
  isLighterApiError,
  isLighterError,
  isRetryable,
} from "lighter-ts/errors";

try {
  await rest.transaction.sendTx({ tx_type: 14, tx_info: info });
} catch (e) {
  if (hasCode(e, ERR_RESTRICTED_JURISDICTION)) return blockedByJurisdiction(e);
  if (isLighterApiError(e)) return apiRefused(e.code, e.message);
  if (isLighterError(e) && isRetryable(e)) return retryLater();
  throw e;
}
```

| class | `kind` | when |
| --- | --- | --- |
| `LighterApiError` | `http` | the API was reached and refused |
| `LighterGeoRestrictedError` | `http` | code `20558`, a subclass of the above |
| `LighterAuthError` | `auth` | HTTP 401, or code `20013` |
| `LighterBlockedError` | `blocked` | an intermediary answered instead of the API, with a non-JSON body |
| `LighterTimeoutError` | `timeout` | the per-request budget elapsed |
| `LighterTransportError` | `network` | `fetch` rejected, or the caller aborted |
| `LighterConfigError` | `config` | the route needs a credential and none is configured |

**Match on the numeric `code`, never on `message` text.** The observed messages carry trailing
whitespace (`"invalid param "`), and nothing about them is stable.

Codes observed in the wild, exported as named constants. This is not the complete set — Go defines
only `CodeOK = 200` and Python's `errors.py` is two lines, so there is no authoritative list. Surface
the raw number and do not assume the set below is exhaustive.

| constant | code | meaning |
| --- | --- | --- |
| `RESULT_OK` | 200 | success |
| `ERR_INVALID_PARAM` | 20001 | invalid or missing parameter |
| `ERR_INVALID_AUTH` | 20013 | bad or expired auth token |
| `ERR_RESTRICTED_JURISDICTION` | 20558 | see below |
| `ERR_ACCOUNT_NOT_FOUND` | 21100 | |
| `ERR_TX_NOT_FOUND` | 21500 | |
| `ERR_INVALID_MARKET_INDEX` | 21602 | |
| `ERR_TIME_RANGE_EXCEEDED` | 22403 | |
| `ERR_NOT_FOUND` | 29404 | **inside an HTTP 400**, never a 404 |

### Code 20558 — geo-restriction

The single most confusing failure this SDK can hand you, and the reason it gets its own class.

```json
{"code": 20558,
 "message": "You are accessing Lighter from a restricted jurisdiction. For more information, see the https://lighter.xyz/terms"}
```

It arrives as **HTTP 400**, which makes it look like a validation error, and the failure is
bafflingly partial. Measured from a restricted location:

| endpoint | result |
| --- | --- |
| `/api/v1/orderBooks` | 200 — public reads are allowed |
| `/api/v1/nextNonce` | 200 |
| `/api/v1/candles`, `/recentTrades`, `/orderBookOrders` | 200 |
| `/api/v1/sendTx` | **400, code 20558** |
| `/stream` (WebSocket) | **400, code 20558** — the upgrade never happens |

So every read succeeds and every write fails with what looks like a parameter error, while the
WebSocket fails with a bare `Expected 101 status code` that mentions nothing about jurisdiction. The
SDK never flattens this into a generic validation error: `LighterGeoRestrictedError` carries the
message verbatim, and `isLighterGeoRestrictedError(e)` or `hasCode(e, 20558)` identifies it.

It also means anything requiring live writes or a live socket cannot run in CI from an arbitrary
location. That is a jurisdiction, not flakiness.

### Retries

`GET` is retried on rate limiting and origin failures only — never any other 4xx, and never a
non-`GET`. Backoff is **full-jittered** exponential (`random() * min(cap, base * 2^attempt)`), because
the failures being backed off are usually correlated across callers and spreading uniformly over the
whole window is what actually de-synchronises a herd. A `Retry-After` hint wins over the computed
delay but is clamped to `capMs`: an unbounded server hint must not stall a trading client for
minutes. Both RFC forms of the header are parsed; an unparseable one falls back to the computed
delay.

Defaults: `retry: { attempts: 2, baseMs: 200, capMs: 5_000 }`,
`timeoutMs: { readMs: 10_000, writeMs: 30_000 }`.

---

## Money arrives as decimal strings

Monetary and size fields are decimal **strings** on the wire, and the models keep them that way.
**Never put one through `Number`.** The precision loss is silent and financial: `8.2 * 1e6` is
`8199999.999999999`, and truncating that gives a user who asked to spend 8.2 USDC an order for
8.199999.

Fields that look numeric and are not: `MarketInfo.createdAt` is epoch milliseconds **held in a
string**; `minBaseAmount`, `minQuoteAmount`, `orderQuoteLimit`, `takerFee`, `makerFee` and
`liquidationFee` are all decimal strings verbatim from the wire.

`number` appears only for timestamps, counts and market indices, and only where the safe-integer
range is provably sufficient. `mapCandle` returns decimal strings for OHLC and volumes; it does not
return `number`. `expandExponent` is there because some values arrive in exponent notation and a
decimal string must be normalised without ever becoming a float.

Scaling exponents come from the market: `supported_size_decimals`, `supported_price_decimals` and
`supported_quote_decimals` on `/orderBooks`. Converting a decimal string to the integer the protocol
signs is the job of `lighter-ts/client` — see [client.md](client.md#two-numeric-tiers).

---

## Routes and groups

78 operations in 13 groups, each exposed as a method on `LighterRestClient` with typed parameters and
a typed response.

| group | ops | what is in it |
| --- | --- | --- |
| `account` | 26 | accounts, limits, metadata, API keys, PnL, position funding, leases, liquidations, public-pool metadata, RFQ, session tokens |
| `order` | 12 | order books and book details, book orders, recent trades, active and inactive orders, exchange stats and metrics, export |
| `transaction` | 12 | `sendTx`, `sendTxBatch`, `nextNonce`, transaction lookups, block transactions, deposit / transfer / withdraw history |
| `bridge` | 6 | deposit networks and latest deposits, intent addresses, fast bridge and fast withdraw |
| `referral` | 6 | referral codes, points, kickbacks, use |
| `info` | 5 | `systemConfig`, `withdrawalDelay`, `transferFeeInfo`, layer-1 basic info, synthetic spot info |
| `block` | 3 | `block`, `blocks`, `currentHeight` |
| `candlestick` | 2 | `candles`, `fundings` |
| `root` | 2 | `GET /` and `GET /info`, at the origin root, not under `/api/v1` |
| `announcement`, `funding`, `notification`, `tokenlist` | 1 each | announcements, funding rates, notification ack, token list |

Two operations (`root`) sit at the origin root rather than under `/api/v1`. That is why `restBase` in
an endpoint profile is an **origin** with no path: baking `/api/v1` into the base would make those
two unreachable.

`request()` also accepts a route definition that is not in the table, which is the escape hatch for
anything the catalogue has not caught up with. There is no reachable OpenAPI document to generate
from — `/api/v1/swagger/doc.json`, `/swagger/doc.json`, `/openapi.json` and `/swagger.json` all
return 403 with the same `User-Agent` that gets 200 on `/orderBooks` — so the route table is
hand-authored and the raw path stays open.

### Raw responses

```ts
const res = await rest.request(routes.orderBooks, { filter: "perp" }, { raw: true });
```

`raw: true` returns the untouched `Response` and does not read the body. Use it for streaming, for
inspecting headers, or when you want to classify the response yourself.

---

## Pagination

Cursor-based. Two generators, both driving `request()` under the hood:

```ts
import { paginate, paginateItems } from "lighter-ts/rest";

const params = { by: "account_index", value: "1", limit: 100 } as const;

for await (const page of paginate(rest, routes.accountTxs, params)) {
  // one response per page
}

for await (const tx of paginateItems(rest, routes.accountTxs, params)) {
  // one item at a time, pages flattened
}
```

`nextCursor(page)` extracts the cursor from a response if you want to drive the loop yourself. Both
generators stop at `DEFAULT_MAX_PAGES` (1000) unless told otherwise — an unbounded cursor loop
against a server that keeps returning the same cursor is an infinite request storm, and the cap is
there to make that a bounded failure instead.

Pass `{ signal }` to cancel mid-iteration. Per-call options are shallow-merged over the client's
config, so `{ signal }` alone leaves timeouts and retries in place.

---

## Chain ID is never inferred from a URL

The chain id is the first element of every transaction hash and is **not discoverable from any
endpoint** — `/systemConfig` does not carry it.

| network | chain id | REST origin |
| --- | --- | --- |
| mainnet | 304 | `https://mainnet.zklighter.elliot.ai` |
| testnet | 300 | `https://testnet.zklighter.elliot.ai` |
| robinhood | 466324 | `https://api.rh.lighter.xyz` |
| robinhood_testnet | 300 | `https://api.rh-testnet.lighter.xyz` |

`testnet` and `robinhood_testnet` genuinely share chain id 300. That is an upstream fact, so a chain
id does not identify a profile and there is no reverse lookup.

The Python reference substring-matches the base URL to guess the chain, which signs for the wrong
chain behind a proxy or a vanity domain — a perfectly formed signature over a hash the sequencer will
never reproduce, and a rejection that mentions neither chain nor host. Here it comes from the named
profile, or from an explicit `chainId` on a custom one. **A custom endpoint without an explicit
`chainId` throws at construction.**
