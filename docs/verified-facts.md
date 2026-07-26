# Verified facts (measured, not inferred)

Everything here was established by running code or hitting the live API on 2026-07-25, not by
reading the reference SDKs. Where this document disagrees with a dimension spec, this wins.

## Toolchain

| Tool | Version | Note |
| --- | --- | --- |
| Go | 1.24.4 darwin/arm64 | reference builds clean; conformance oracle works |
| Bun | 1.3.0 | monorepo's package manager |
| Node | 24.10.0 | |
| Deno | present | |

## Conformance oracle — BUILT AND WORKING

`conformance/oracle` in the target repo is committed and runs. It pins upstream
`lighter-go v1.0.7` and `poseidon_crypto v0.0.15` from the module proxy (no local path
dependency), and emits six deterministic vector files into `conformance/vectors/`:

`goldilocks.json`, `gfp5.json`, `poseidon2.json`, `curve.json`, `schnorr.json`, `tx.json`

Verified properties:
- Byte-stable across runs (splitmix64 seed, no clock, no RNG).
- All 16 Schnorr signature vectors verify; all 3 tampered variants are rejected.
- All 20 curve points round-trip through encode/decode.
- 9 end-to-end transaction hashes with signatures (create_order × 6 variants, cancel_order × 3)
  plus 6 attribute-aggregation cases.

**Implementation units must not re-derive this.** Wave 1 consumes these vectors.

### The non-canonical field representation trap

The Go `GoldilocksField` is a raw `uint64` in **non-canonical** form. `AddF`/`SubF`/`MulF`
reduce only into `[0, 2^64)`; the value may sit one `ORDER` above the true residue.
`ToCanonicalUint64` applies the final conditional subtraction, and serialization always calls it.
`FromCanonicalLittleEndianBytesF` does **no** range validation — a limb `>= ORDER` decodes to a
non-canonical element rather than erroring.

Proof this matters: the reference encodes the curve generator as
`[18446744069414584325, 0, 0, 0, 0]`. That first limb is `ORDER + 4`. Canonically it is `4`.

Decision already taken and baked into the vectors: **lighter-ts reduces fully on every operation,
and all expected values in the vectors are canonical.** The divergence is documented with worked
examples under `nonCanonicalNotes` in `goldilocks.json`. Do not implement the non-canonical
representation — it is a 64-bit-hardware optimization with no analogue under `BigInt`.

### Signature nonce

Production Schnorr signing samples `k` randomly (`SchnorrSignHashedMessage`). The reference also
exposes an explicit-`k` entry point (`SchnorrSignHashedMessage2`), which the oracle uses to make
vectors reproducible. **The TypeScript signer must expose the same seam**: caller-supplied nonce
for tests, `crypto.getRandomValues` by default.

## Only one Poseidon2 is needed — proven by execution

`poseidon_crypto` ships two Poseidon2 implementations and the reference SDK uses **both**:

| Path | Import | Element type |
| --- | --- | --- |
| Transaction hashing (`types/txtypes/*.go`) | `hash/poseidon2_goldilocks_plonky2` | plain `uint64` |
| Auth tokens (`types/tx_request.go:10`) | `hash/poseidon2_goldilocks` | gnark Montgomery |

Reading the source, this looks like two hash implementations are required. **They are not.** Ran
both over the same input:

```
gnark   HashToQuinticExtension -> 3ac676d8a705f5f893591455c5aca1447a8c77a28dc0fd6641a1d7aafb6740580cddc5a667faadbd
plonky2 HashToQuinticExtension -> 3ac676d8a705f5f893591455c5aca1447a8c77a28dc0fd6641a1d7aafb6740580cddc5a667faadbd
SAME? true
```

The variants differ in internal field representation, not in the function computed. **Implement one
Poseidon2.** Any issue that asks for a second is wrong.

## Read-only auth token construction — fully pinned

Needed for authenticated REST reads. From `lighter-go/types/tx_request.go:155`:

```
message   = "<deadlineUnixSeconds>:<accountIndex>:<apiKeyIndex>"
elements  = pack(utf8(message))      // 8 bytes per element, little-endian, final chunk zero-padded
msgHash   = HashToQuinticExtension(elements).toLittleEndianBytes()    // 40 bytes
signature = schnorrSign(msgHash)                                      // 80 bytes
token     = message + ":" + hex(signature)
```

Three vectors are in `conformance/vectors/tx.json` under `authTokens`, including one at the index
maximums where the message spans four field elements rather than two.

Note the packing helper (`ArrayFromCanonicalLittleEndianBytes`, the gnark path) **validates** each
8-byte chunk against the modulus and returns an error rather than reducing — unlike the plonky2
decoder, which validates nothing. It can never trigger for this message format (ASCII digits and
colons cannot produce a chunk anywhere near `p`), but the check is real and should be kept.

Operationally, `examples/read-only-auth/` pre-generates tokens on **6-hour aligned boundaries**
with an 8-hour expiry, so tokens overlap and a lookup by current aligned timestamp always finds a
valid one.

## Chain IDs (from `examples/utils.py:40`)

| Network | Lighter chain ID | Base URL |
| --- | --- | --- |
| mainnet | **304** | `https://mainnet.zklighter.elliot.ai` |
| testnet | **300** | (default when host is not mainnet) |
| rh | **466324** | `api.rh.lighter...` |

The chain ID is an input to **every** transaction hash. It is not discoverable from
`/systemConfig` — it must be configured.

## Live REST API — probed

Base: `https://mainnet.zklighter.elliot.ai/api/v1`. 76 distinct endpoint paths exist in the
Python client. 12 of 13 probed public endpoints returned 200 with real data.

| Endpoint | Status | Size |
| --- | --- | --- |
| `/orderBooks` | 200 | 109 KB |
| `/systemConfig` | 200 | 407 B |
| `/exchangeStats` | 200 | 40 KB |
| `/candles?market_id&resolution&start_timestamp&end_timestamp&count_back` | 200 | 3.2 KB |
| `/recentTrades?market_id&limit` | 200 | 4.5 KB |
| `/orderBookOrders?market_id&limit` | 200 | 2.3 KB |
| `/funding-rates?market_id&resolution&...` | 200 | 49 KB |
| `/layer1BasicInfo` | 200 | 398 B |
| `/nextNonce?account_index&api_key_index` | 200 | 22 B |
| `/account?by=index&value=1` | 200 | 1 KB |
| `/tokenlist` | 200 | 67 KB |
| `/announcement` | 200 | 35 KB |
| `/currentHeight` | 403 | Cloudflare interstitial, not a real 403 |

Notes that affect design:
- **Cloudflare sits in front of the API.** A request without a browser-like `User-Agent` gets a
  403 HTML interstitial on some paths. The SDK must send an explicit `User-Agent` and must treat a
  non-JSON body as a transport error rather than attempting to parse it.
- **Every response carries a numeric `code` field** (`200` on success) *in addition to* the HTTP
  status. The error model must check both — HTTP 200 with a non-200 body `code` is possible.
- `/orderBooks` returns **227 markets**, each with `supported_size_decimals`,
  `supported_price_decimals`, `supported_quote_decimals`, `min_base_amount`, `min_quote_amount`,
  `market_type` (`perp` | spot), and string-encoded decimal fields. These decimals drive all
  client-side price/amount scaling — the trading facade cannot compute a market order without
  them.
- Monetary and size fields arrive as **decimal strings**, not numbers. Never parse them through
  `Number` — precision loss is silent and financial.

Captured sample responses (for shape-fixture use):
`scratchpad/api-probe/*.json`

## There is no reachable OpenAPI document — decided, not assumed

The Python client references `/api/v1/swagger/doc.json`. Probed directly:

| URL | Result |
| --- | --- |
| `https://mainnet.zklighter.elliot.ai/api/v1/swagger/doc.json` | 403, empty body |
| `https://mainnet.zklighter.elliot.ai/swagger/doc.json` | 403, empty body |

Same `User-Agent` that gets 200 on `/orderBooks`, so this is a deliberate block, not bot
detection. `/openapi.json` and `/swagger.json` are also 403.

**Consequence:** "generate types from the live OpenAPI spec at build time" is not an available
strategy. The REST types must come from the Python SDK's `lighter/models/*.py` (which *were*
OpenAPI-generated, so they are faithful) plus the probed live responses, and be checked in.
Any architecture proposal that depends on fetching a spec at build time is wrong.

## L1 context (from `/layer1BasicInfo`)

- L1 chain id `1` (Ethereum mainnet)
- `ZkLighterContract` `0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7`
- `USDCContract` `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`

## L1 signing should be injected, not implemented

Four flows need an Ethereum `personal_sign` (EIP-191): register API key
(`change_pub_key`), `transfer`, `approve_integrator`, `create_sub_account`. Exact message bodies
and EIP-191 hashes are pinned in `conformance/vectors/tx.json` under `l1Messages`.

Implementing that in-house means shipping keccak256 **and** secp256k1 in pure TypeScript — a large
amount of hand-rolled cryptography, on the zero-dependency budget, for a signature the SDK cannot
produce anyway without custody of an L1 private key.

Measured context: **the consuming monorepo already depends on `viem ^2.55.4`**
(`monorepo/workers/web/package.json:47`), and there is a Turnkey API credentials file at
`lev7/lev7-testnet-turnkey-api-credentials-*.json` — so L1 keys are held by a wallet/custody layer,
not by this SDK.

**Therefore:** the SDK should define a narrow `L1Signer` interface
(`signMessage(message: string) => Promise<Hex>`) and let the caller plug in viem, ethers, Turnkey,
or a browser wallet. The SDK owns *building the exact message string* — which is the part that is
easy to get wrong and is now vector-pinned — and owns none of the secp256k1.

This keeps the zero-dependency claim honest and removes the single largest chunk of avoidable
cryptographic risk. Any proposal to hand-roll secp256k1 should be rejected unless it comes with a
specific reason the injected-signer seam fails.

## The reference's order-sizing math has four hazards — all reproduced

These were found by reading `lighter-python/lighter/signer_client.py` and then **executing** the
arithmetic. Every one of them silently changes an order's price or size. A literal TypeScript port
would inherit two of them and introduce a third.

### 1. Python `round()` is banker's rounding; JavaScript `Math.round()` is not

`signer_client.py:839,897,956` compute
`acceptable_execution_price = round(ideal_price * (1 + max_slippage * ±1))`.

Python rounds half-to-even. JavaScript rounds half-up (toward `+Infinity`). Measured:

| value | Python `round` | JS `Math.round` |
| --- | --- | --- |
| `2500.5` | **2500** | **2501** |
| `2.5` | **2** | **3** |
| `1.5` | 2 | 2 |
| `3.5` | 4 | 4 |

They agree on odd halves and disagree on even ones, so this survives casual testing and shows up as
a one-tick price difference in production. `Math.round` is not a valid translation of `round`.

### 2. `int(quote_amount * 1e6)` truncates a float error into a real loss

`signer_client.py:832`. Measured: `8.2 * 1e6 = 8199999.999999999`, and `int()` truncates toward
zero, giving `8199999` instead of `8200000`. The user asked to spend 8.2 USDC and the order is
built for 8.199999. This is a bug in the reference, not a convention to preserve — scale decimal
input exactly (string/BigInt), never through binary floating point.

### 3. `int(price_string.replace(".", ""))` is correct only by accident

`signer_client.py:794,804,805`. Stripping the decimal point converts `"2500.123"` to `2500123`,
which is right *only* because the API pads to the market's `supported_price_decimals`. Measured
failure mode: `"2500.1"` becomes `25001` — off by 100×. It is one API formatting change away from
placing orders at 1% of the intended price. Scale by the market's declared decimals instead.

### 4. `potential_execution_price` changes type depending on the branch

`signer_client.py:813`. When sizing by base amount, `matched_size` is an `int` and the division
yields a **float**; when sizing by quote amount it is a `Fraction` and the division yields an exact
**Fraction**. So the same function returns exact rational arithmetic on one path and lossy binary
floating point on the other. Use one exact representation on both paths.

**Consequence for the SDK:** all price/size arithmetic is integer/rational end to end — no
`number`, no `Math.round`. Rounding direction is stated explicitly per call site (a buy's
acceptable price rounds *up*, a sell's rounds *down*, so slippage protection is never loosened by
rounding), and these four cases become regression tests.

## The reference WebSocket client is 172 lines and not production-viable

Read in full: `lighter-python/lighter/ws_client.py`. It is a demo, not a client. Listing the gaps
because each one is a requirement for ours, and because it explains why "port the Python client" is
the wrong instruction for this layer.

**Protocol facts worth keeping** (these are real and we must match them):
- Connect to `wss://<host>/stream`. The server opens with `{"type":"connected"}`; the client
  subscribes only *after* receiving it (`ws_client.py:47,75`).
- Subscribe shape: `{"type":"subscribe","channel":"order_book/<market_id>"}` and
  `{"type":"subscribe","channel":"account_all/<account_id>"}` (`:78,83`).
- Reply shapes are `subscribed/<channel>` then `update/<channel>`; the channel field comes back as
  `"<name>:<id>"` and the id is parsed by splitting on `:` (`:100,106`).
- **Keepalive is application-level JSON**, not WebSocket control frames: the server sends
  `{"type":"ping"}` and expects `{"type":"pong"}` (`:57`). This is good news — protocol-level
  ping/pong is not exposed by the browser or Cloudflare Workers `WebSocket` API, but a JSON
  heartbeat works identically on every runtime. No `ws` package needed.

**Defects we must not reproduce:**

1. **The book becomes unsorted.** The snapshot arrives sorted, but `update_orders` **appends** new
   price levels to the end of the array (`:131`). After the first update introducing a new level,
   `bids[0]` is no longer the best bid. Any consumer reading the top of book gets a wrong answer.
2. **No sequence or offset tracking, and therefore no gap detection** (`:105-137`). If a single
   delta is dropped, the book diverges from the exchange silently and permanently. For a trading
   SDK this is the most serious defect in the file.
3. **O(n·m) per message.** For each incoming level it linearly scans the whole book
   (`:119-131`), then does a full filter pass over it again (`:135`). Needs a price-indexed
   sorted structure.
4. **`float()` used to test size** (`:128,136`). Same floating-point-money hazard as the REST path.
   Compare decimal strings or scaled integers.
5. **Any unrecognized message type raises** (`:151`). A new server-side message type takes the
   client down. Must be ignored-with-warning instead.
6. **`on_error` and `on_close` raise; there is no reconnect, no backoff, no resubscribe**
   (`:154-158`). One dropped connection ends the session.
7. **Only two channels are handled** — order book and account. Everything else the server can send
   is unhandled (and therefore fatal, per 5).

**Consequences for our design:** offset/sequence tracking with an explicit resync-on-gap path, a
sorted price-indexed book, exact decimal comparison, reconnect with backoff and automatic
resubscribe, forward-compatible handling of unknown message types, and the full channel set. These
become their own issues rather than being folded into "port the WS client".

## REST error model — measured against the live API

Neither reference SDK documents the error codes. The Go client defines exactly one
(`client/http/http_types.go:4`, `CodeOK = 200`) and Python's `lighter/errors.py` is two lines
declaring a single `ValidationError`. Everything below was obtained by making real failing requests.

Errors arrive as HTTP 4xx with a JSON body `{"code": <int>, "message": <string>}`:

| Request | HTTP | Body |
| --- | --- | --- |
| `/orderBookOrders?market_id=99999&limit=5` | 400 | `{"code":20001,"message":"invalid param "}` |
| `/orderBookOrders` (required arg missing) | 400 | `{"code":20001,"message":"invalid param "}` |
| `/candles?...&resolution=NOPE` | 400 | `{"code":20001,"message":"invalid param "}` |
| `/account?by=index&value=999999999999` | 400 | `{"code":29404,"message":"not found"}` |
| `/thisDoesNotExist` | **403** | **HTML** (Cloudflare, never reaches the API) |

Observations that constrain the transport layer:

1. **Two independent failure channels.** The HTTP status and the body `code` are separate. Success
   responses also carry `"code": 200` in the body. Both must be checked — treating HTTP 200 as
   success is not sufficient.
2. **A non-JSON body is a normal occurrence, not an impossibility.** Unknown paths and some blocked
   requests return a Cloudflare HTML interstitial with a 403. Calling `response.json()`
   unconditionally throws a `SyntaxError` that tells the caller nothing. The transport must detect
   a non-JSON content type and raise a distinct, actionable transport error.
3. **`message` has trailing whitespace** (`"invalid param "`). Do not match on message text; match
   on `code`. Trim before display.
4. **Codes are grouped**: `2xxxx` observed, with `20001` for validation and `29404` mirroring HTTP
   404 semantics inside a 400 response.

Since no authoritative code list exists in either reference, the SDK should expose the raw numeric
`code` alongside a small set of named, discoverable error classes, and must not assume the observed
codes are exhaustive — unknown codes need to surface intact rather than being flattened into a
generic error.

## External review agents — verified working headless

| Agent | Invocation |
| --- | --- |
| grok | `grok -p "<prompt>" --output-format plain` |
| codex | `codex exec --skip-git-repo-check "<prompt>"` |
| kimi | `kimi -p "<prompt>"` (also available as MCP tool `mcp__kimi__ask_kimi`) |

## Monorepo conventions (consumer)

`/Users/joeblau/Developer/lev7/src/monorepo` — Bun 1.3.0 workspaces + Turbo, deployed to
Cloudflare Workers via `@opennextjs/cloudflare`. Lint is **eslint** (`eslint.config.mjs`); there is
no biome/prettier at root. `bunfig.toml` sets `linker = "hoisted"`.

The web worker already calls Lighter directly by URL
(`workers/web/src/lib/candles.ts`, `workers/web/src/lib/market-limits.ts`) — those are the first
call sites this SDK should be able to replace, and they run **on Cloudflare Workers**. That is the
concrete reason the SDK must not depend on Node built-ins.
