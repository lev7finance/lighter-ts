#!/usr/bin/env python3
"""The unit ledger: one owner per file, checked rather than asserted.

Cuts applied per docs/decisions.md D10: no src/l1-signer, no src/paper,
no models/generated.ts long tail, no ws/pool.ts, no 1:1 example parity.
Wave 0 added per D9. crypto/sha256.ts dropped per D2 (Poseidon2 PRF instead).
"""

import json

U = []


def unit(key, title, wave, labels, files, deps, risk="medium", intent=""):
    U.append({
        "key": key, "title": title, "wave": wave, "labels": labels,
        "files": files, "dependsOn": deps, "risk": risk, "intent": intent,
    })


# ---------------------------------------------------------------- wave 0: evidence
unit("w0-ws-live-capture", "Capture real WebSocket traffic before the WS layer is designed", 0,
     ["websocket", "testing"], ["scripts/capture-ws-fixtures.ts", "test/fixtures/ws/"], [], "medium",
     "Raw socket script, no SDK. Record real frames for every channel: subscribe/ack shapes, "
     "channel-key format, snapshot vs update payloads, keepalive timing, close codes, truncation. "
     "The WS units are designed FROM these fixtures, so this must land first.")

unit("w0-rest-golden-fixtures", "Capture live REST responses as golden fixtures", 0,
     ["rest", "testing"], ["scripts/refresh-fixtures.ts", "test/fixtures/rest/"], [], "low",
     "Commit real responses for the core read endpoints. Must include /withdrawalDelay (returns "
     "no `code` field at all) and an unauthenticated call to an authed endpoint (reveals the "
     "auth query-param/header split). These are evidence for the model layer, not a test of it.")

unit("w0-worker-sign-benchmark", "Gate: full sign() and verify() CPU time on a deployed Worker", 0,
     ["infra", "crypto", "testing"], ["test/portability/worker.ts", "test/portability/wrangler.jsonc",
                                      "scripts/run-workerd-vectors.ts"], [], "high",
     "docs/decisions.md D4. Desktop numbers are 19-35 ns/mul across Bun/Node/Deno, 15-25x better "
     "than the feared threshold, but that is extrapolated from a hot loop on Apple Silicon. This "
     "measures a COMPLETE signature on a deployed Worker via cloudflare.cpu_time_ms at p50/p99. "
     "Not wrangler dev, not extrapolation. Blocks wave 2.")

unit("w0-openapi-snapshot", "Vendor and pin the OpenAPI snapshot", 0,
     ["rest", "infra"], ["spec/openapi.snapshot.json", "spec/README.md"], [], "low",
     "spec/openapi.snapshot.json does not exist in this repo. Copy it from the Python SDK, pin its "
     "digest, and document in spec/README.md why it must never be authoritative: it is unversioned, "
     "demonstrably wrong in places, and there is no live endpoint to refresh from (all /swagger and "
     "/openapi paths return 403).")

unit("w0-ua-probe", "Probe the CDN's User-Agent behaviour from workerd", 0,
     ["transport", "testing"], ["scripts/probe-user-agent.ts"], [], "medium",
     "docs/decisions.md D5. Two measured documents contradicted each other and both were right for "
     "their own runtime. The existing evidence is curl-based and says nothing about what workerd's "
     "DEFAULT User-Agent does against the CDN. Hit /orderBooks from workerd with no override and "
     "record the result. If it 403s, the SDK fails in its primary deployment target.")

# ---------------------------------------------------------------- wave 1: foundation + crypto
unit("repo-scaffold", "Scaffold the package: tsconfigs, bunfig, licence, CI skeleton", 1,
     ["infra"], ["tsconfig.json", "tsconfig.build.json", "tsconfig.bundler.json",
                 "tsconfig.examples.json", "bunfig.toml", "LICENSE", "CONTRIBUTING.md",
                 "SECURITY.md", ".github/dependabot.yml", "scripts/check-no-deps.ts"], [], "low",
     "Everything except package.json and the CI workflow files, which belong to the final "
     "integration unit so leaf units never contend for them.")

unit("errors-and-redaction", "Error hierarchy and secret redaction", 1,
     ["infra"], ["src/errors.ts", "src/util/redact.ts", "src/version.ts"], ["repo-scaffold"], "low",
     "One LighterError hierarchy with structural type guards, never tuples. Must carry the raw "
     "numeric API code intact -- neither reference SDK documents the code set, so unknown codes "
     "must survive rather than being flattened. Redaction covers private keys and auth tokens in "
     "both log output and error messages.")

unit("util-primitives", "Byte, JSON and exact-decimal primitives", 1,
     ["infra"], ["src/util/bytes.ts", "src/util/json.ts", "src/util/decimal.ts"],
     ["errors-and-redaction"], "medium",
     "No Buffer, no btoa, no Node built-ins. decimal.ts is load-bearing for money: exact decimal "
     "<-> bigint with explicit rounding modes. See docs/protocol-notes.md section 9 for the four "
     "float hazards in the reference that these must not reproduce.")

unit("config-endpoints", "Endpoint profiles and injectable runtime config", 1,
     ["infra"], ["src/config/endpoints.ts", "src/config/config.ts", "src/config/index.ts"],
     ["util-primitives"], "low",
     "Chain ID is bound to the profile (mainnet 304, testnet 300) and is an input to every "
     "transaction hash -- it is not discoverable from /systemConfig. fetch, WebSocket and now() are "
     "injectable so tests need no network and Workers can supply its own globals.")

unit("crypto-field", "GF(p) base field arithmetic", 1,
     ["crypto"], ["src/crypto/field/constants.ts", "src/crypto/field/fp.ts"],
     ["errors-and-redaction"], "high",
     "p = 2^64 - 2^32 + 1. Canonical bigint throughout. Use plain (a*b) % P -- measured 2.5-4x "
     "faster than hand-folded reduction on every engine (bench/README.md), which inverts the Go "
     "intuition. Pinned by conformance/vectors/goldilocks.json including nonCanonicalNotes.")

unit("crypto-fp5", "GF(p^5) quintic extension arithmetic", 1,
     ["crypto"], ["src/crypto/field/fp5.ts"], ["crypto-field"], "high",
     "GF(p)[X]/(X^5 - 3). Pinned by conformance/vectors/gfp5.json, 46 cases x 18 operations. "
     "Legendre returns a field element (1, p-1, or 0), not a boolean. sqrt(0) returns (0, true) -- "
     "a zero guard breaks vector case 0. Reject negative repeated-Frobenius counts.")

unit("poseidon2-constants", "Generate the Poseidon2 constants module from vectors", 1,
     ["crypto", "infra"], ["scripts/gen-poseidon2-constants.ts",
                           "src/crypto/poseidon2/constants.generated.ts"], ["repo-scaffold"], "low",
     "All 130 constants are already dumped mechanically into conformance/vectors/poseidon2.json "
     "under `constants`. Generate the module from that file and pin its digest. Do not transcribe "
     "by hand: a one-digit slip is wrong for every input and traceable to nothing.")

unit("poseidon2-permutation", "Poseidon2 permutation", 1,
     ["crypto"], ["src/crypto/poseidon2/permutation.ts"],
     ["crypto-field", "poseidon2-constants"], "high",
     "Width 12, x^7, 4 full / 22 partial / 4 full, and a linear layer BEFORE round 0. The 4-lane "
     "external step reads original inputs -- snapshot each chunk before writing or the permutation "
     "is silently wrong. Internal layer is sum + state[i]*diag[i] over all 12 lanes, diagonal used "
     "raw, lane 0 not special-cased. See docs/protocol-notes.md section 2.")

unit("poseidon2-sponge", "Poseidon2 sponge and hash wrappers", 1,
     ["crypto"], ["src/crypto/poseidon2/index.ts"], ["poseidon2-permutation", "crypto-fp5"], "high",
     "hashToQuinticExtension, hashNoPad, hashNToOne, hashTwoToOne, hashNToMNoPad. hashTwoToOne "
     "builds an 8-element input with capacity lanes zero, not a 12-lane compression. Guard "
     "hashNToMNoPad against non-positive output counts -- the reference loops forever. Only ONE "
     "Poseidon2 is needed despite the reference importing two variants.")

unit("crypto-scalar", "Scalar field Z/nZ and its 40-byte codec", 1,
     ["crypto"], ["src/crypto/scalar.ts", "src/crypto/field/recode.ts"], ["crypto-field"], "high",
     "The decoder REDUCES and never rejects. CRITICAL: JavaScript % follows the sign of the "
     "dividend, so every subtraction and the signature equation need modN(x) = ((x % n) + n) % n. "
     "Getting this wrong makes signing fail while every other layer is correct. "
     "See docs/protocol-notes.md section 5.0.")

unit("crypto-point", "ECgFp5 point arithmetic and codec", 1,
     ["crypto"], ["src/crypto/point.ts"], ["crypto-fp5"], "high",
     "Prime order, cofactor 1. Pinned by conformance/vectors/curve.json. Note encode() returns "
     "non-canonical limbs in the reference (generator encodes as ORDER+4, canonically 4) -- we "
     "canonicalize and the bytes agree.")

unit("crypto-scalarmul", "Scalar multiplication", 1,
     ["crypto"], ["src/crypto/scalarmul.ts"], ["crypto-point", "crypto-scalar"], "high",
     "Windowed, branchless table lookup, [s]P and [s]G + [e]P. Signing is fixed-base [k]G, so a "
     "precomputed comb table on G is the pre-authorized fallback if the wave-0 Worker gate fails "
     "(docs/decisions.md D4) -- structure the code so it can be added without a rewrite.")

unit("crypto-nonce", "Hedged-deterministic signing nonce -- SECURITY GATED", 1,
     ["crypto", "testing"], ["src/crypto/nonce.ts"], ["poseidon2-sponge", "crypto-scalar"], "high",
     "docs/decisions.md D2. Derive k from private key + message hash mixed with fresh randomness, "
     "using Poseidon2 (NOT a hand-rolled SHA-256). A broken derivation passes every signature "
     "conformance test, because verification cannot see where k came from, and leaks the key on the "
     "second signature. This unit does not merge without: fixed (sk,msg,entropy)->k vectors "
     "including all-zero entropy, same-key/different-message, different-key/same-message, k in "
     "[1,n), and a nonce-reuse test that actually recovers the private key. "
     "Never call crypto.getRandomValues at module scope -- Workers forbids it.")

unit("crypto-schnorr-key", "Schnorr sign/verify and the ApiKey type", 1,
     ["crypto"], ["src/crypto/schnorr.ts", "src/crypto/key.ts", "src/crypto/index.ts"],
     ["crypto-scalarmul", "poseidon2-sponge", "crypto-nonce"], "high",
     "80-byte signature: s then e, each 40 bytes LE. REJECT the neutral public key unconditionally, "
     "with no opt-out flag -- it is a universal forgery (docs/decisions.md D1). Sign/verify/key "
     "import use REDUCING parsers; fp5FromBytes reduces, fp5FromBytesStrict rejects (D3). "
     "The `malleable` vectors in schnorr.json are part of this unit's gate.")

# ---------------------------------------------------------------- wave 2: transaction codec
unit("tx-constants", "Protocol constants, enums and branded integer types", 2,
     ["codec"], ["src/tx/constants.ts", "src/tx/enums.ts", "src/tx/brands.ts"],
     ["errors-and-redaction"], "low",
     "Every bound and tick from the reference, reproduced exactly -- these are protocol values. "
     "Branded U8/U16/I16/U32/I64/U64 with smart constructors so an int64 cannot be passed where a "
     "uint32 belongs.")

unit("tx-field-encode", "Protocol integer to field element encoding", 2,
     ["codec"], ["src/tx/field-encode.ts"], ["tx-constants", "crypto-field"], "high",
     "Negative values sign-extend to 64 bits then reduce: -1 becomes 4294967294, NOT p-1. The "
     "lo/hi split is per-FIELD not per-width -- exactly four sites (Transfer.Amount, "
     "Transfer.USDCFee, Withdraw.Amount, UpdateMargin.USDCAmount). BaseAmount and OrderExpiry both "
     "exceed 32 bits and are NOT split. UpdateMargin uses an ARITHMETIC shift and negative values "
     "are reachable. See docs/protocol-notes.md section 3.")

unit("tx-attributes", "Transaction attribute registry and hash aggregation", 2,
     ["codec"], ["src/tx/attributes.ts"], ["tx-field-encode", "poseidon2-sponge"], "high",
     "Nonzero types ascending, padded to 4, each contributing TWO elements (type, value) including "
     "padding zeros. Empty set returns the tx hash directly as 40 LE bytes; otherwise concatenate "
     "the two 5-element hashes and re-hash. Pinned by tx.json attributeHashes.")

unit("tx-schema-engine", "Declarative schema vocabulary, generic hasher and JSON emitter", 2,
     ["codec"], ["src/tx/schema.ts", "src/tx/hash.ts", "src/tx/serialize.ts"],
     ["tx-attributes"], "high",
     "One data-driven table drives hashing AND serialization so a new transaction type is one entry, "
     "not three code sites. serialize.ts is hand-rolled because JSON.stringify cannot emit bigint.")

unit("tx-schemas-orders", "Order transaction schemas and types", 2,
     ["codec"], ["src/tx/schemas/orders.ts", "src/tx/types/orders.ts", "src/tx/grouped-hash.ts"],
     ["tx-schema-engine"], "medium",
     "Codes 14, 15, 16, 17, 28. Grouped orders fold leg hashes pairwise SEEDED WITH LEG 0 -- the "
     "reference initializes an empty accumulator and then never uses it. Each leg contributes "
     "exactly 10 elements.")

unit("tx-schemas-account", "Account, pool and staking transaction schemas", 2,
     ["codec"], ["src/tx/schemas/account.ts", "src/tx/types/account.ts"],
     ["tx-schema-engine"], "medium",
     "Codes 8, 9, 10, 11, 12, 13, 18, 19, 20, 29, 35, 36, 41, 42, 45. change_pub_key appends the "
     "40-byte public key as five field elements after the header.")

unit("tx-validate-orders", "Order validation", 2,
     ["codec"], ["src/tx/validate/orders.ts"], ["tx-schemas-orders"], "medium",
     "Every rule from the reference with the exact error per violation. Spot markets cannot be "
     "reduce-only; stop/take-profit require perps, a trigger price and an expiry.")

unit("tx-validate-grouped", "Grouped order validation", 2,
     ["codec"], ["src/tx/validate/grouped.ts"], ["tx-validate-orders"], "medium",
     "OTO and OCO take exactly 2 legs, OTOCO exactly 3, each with distinct rules on side, nil-ness "
     "of size, reduce-only, and expiry agreement. See docs/protocol-notes.md section 4.")

unit("tx-validate-account", "Account transaction validation", 2,
     ["codec"], ["src/tx/validate/account.ts"], ["tx-schemas-account"], "medium",
     "Public pool and staking pool indices must sit in the sub-account range (>= 2^47). The "
     "per-market cancel-all attribute is only legal with ImmediateCancelAll. UpdateMargin has no "
     "lower bound, so negative amounts are valid input.")

unit("tx-l1-templates", "L1 EIP-191 message templates", 2,
     ["codec"], ["src/tx/l1/hex16.ts", "src/tx/l1/templates.ts", "src/tx/l1/eip191.ts",
                 "src/tx/l1/signer.ts", "src/tx/l1/attach.ts", "src/tx/l1/index.ts"],
     ["tx-constants", "tx-schemas-account"], "medium",
     "FOUR flows, not three: change_pub_key, transfer, approve_integrator, create_sub_account. "
     "Every numeric argument renders as 0x plus exactly 16 zero-padded lowercase hex digits. "
     "Pinned byte-for-byte by tx.json l1Messages. This unit builds the MESSAGE and defines the "
     "injected L1Signer interface -- it ships no secp256k1 (docs/decisions.md D6).")

unit("tx-pipeline-builders", "Transaction builders and the sign/submit pipeline", 2,
     ["codec"], ["src/tx/opts.ts", "src/tx/build.ts", "src/tx/pipeline.ts", "src/tx/index.ts"],
     ["tx-validate-orders", "tx-validate-grouped", "tx-validate-account", "crypto-schnorr-key"],
     "high",
     "20 pure builders plus txHash / signTx / toTxInfo / txSubmission. Default expiredAt is "
     "now + 599_000 ms. This is where the whole stack meets the 38 end-to-end vectors in tx.json.")

# ---------------------------------------------------------------- wave 3: transport
unit("rest-models-core", "Core REST models", 3,
     ["rest"], ["src/models/common.ts", "src/models/market.ts", "src/models/order.ts",
                "src/models/account.ts", "src/models/transaction.ts"],
     ["config-endpoints", "w0-rest-golden-fixtures"], "medium",
     "Hand-authored, from the captured fixtures and the vendored snapshot. Monetary and size fields "
     "stay decimal strings -- never number (docs/decisions.md D7). The long-tail generated models "
     "are cut from v1 (D10); expose raw typed route access for the tail instead.")

unit("rest-models-aux", "Referral, RFQ, lease, pool and misc models", 3,
     ["rest"], ["src/models/referral.ts", "src/models/rfq.ts", "src/models/lease.ts",
                "src/models/pool.ts", "src/models/misc.ts"], ["rest-models-core"], "low",
     "The remaining hand-authored surfaces. Same string-money rule.")

unit("rest-routes", "Route table: all operations as data", 3,
     ["rest"], ["src/rest/route-types.ts", "src/rest/routes.ts"],
     ["rest-models-core", "rest-models-aux", "w0-openapi-snapshot"], "medium",
     "Every operation as a phantom-typed RouteDef so the client facade is derived rather than "
     "hand-maintained. 76 endpoint paths exist in the Python client.")

unit("rest-transport", "fetch-based transport: auth, retry, timeout, error classification", 3,
     ["transport", "rest"], ["src/rest/transport.ts"],
     ["rest-routes", "errors-and-redaction", "w0-ua-probe"], "high",
     "Success rule: an error is `code` present and not 200, OR HTTP not 2xx. A MISSING code is "
     "success -- /withdrawalDelay returns {\"seconds\":...} with no code. Non-JSON bodies are "
     "normal (Cloudflare HTML interstitials) and must raise a distinct transport error rather than "
     "a SyntaxError. Auth goes in the `auth` query param or the Authorization header; prefer the "
     "header. User-Agent is runtime-conditional per docs/decisions.md D5.")

unit("rest-client-facade", "Grouped REST client and pagination", 3,
     ["rest"], ["src/rest/client.ts", "src/rest/paginate.ts", "src/rest/candles.ts",
                "src/rest/index.ts"], ["rest-transport"], "medium",
     "Grouped facade over the route table, cursor normalisation with async iterators, and the "
     "single-letter candle key mapping.")

unit("ws-backoff-ratelimit", "Reconnect backoff and rate limiting", 3,
     ["websocket"], ["src/ws/backoff.ts", "src/ws/ratelimit.ts"], ["util-primitives"], "low",
     "Full-jitter exponential backoff with close-code classification, token bucket, inflight "
     "semaphore. The reference client has no reconnect at all -- on_error and on_close both raise.")

unit("ws-protocol-codec", "WS envelope discrimination and frame builders", 3,
     ["websocket"], ["src/ws/protocol.ts", "src/ws/errors.ts"],
     ["util-primitives", "w0-ws-live-capture"], "medium",
     "Server opens with {\"type\":\"connected\"}; subscribe only after. Keepalive is "
     "application-level JSON ping/pong, not control frames -- which is why no `ws` package is "
     "needed and this works identically in browsers and Workers. Unknown message types are ignored "
     "with a warning, never fatal.")

unit("ws-mock-harness", "In-process WebSocket mock for deterministic tests", 3,
     ["websocket", "testing"], ["test/ws-harness.ts"],
     ["ws-protocol-codec", "w0-ws-live-capture"], "medium",
     "Replays captured fixtures, and can inject gaps, close codes, latency and malformed frames. "
     "Every other WS unit tests against this rather than the network.")

unit("ws-transport", "Socket lifecycle, keepalive and reconnect", 3,
     ["websocket"], ["src/ws/transport.ts"], ["ws-protocol-codec", "ws-backoff-ratelimit"], "high",
     "Uses the global WebSocket -- no `ws` package -- so it runs in browsers, Workers, Bun, Deno "
     "and Node 22+. Node 20 lacks a global WebSocket, so accept an injected constructor. "
     "Staleness watchdog plus automatic resubscribe after reconnect.")

unit("ws-channel-registry", "Typed channel registry and payload types", 3,
     ["websocket"], ["src/ws/types.ts", "src/ws/channels.ts", "src/ws/account-assets-stream.ts"],
     ["ws-protocol-codec"], "medium",
     "Every channel as a typed ChannelSpec, with payload interfaces derived from the wave-0 "
     "capture rather than from prose.")

unit("ws-subscription", "Subscription object with bounded queue and overflow policy", 3,
     ["websocket"], ["src/ws/subscription.ts"], ["ws-channel-registry"], "medium",
     "AsyncIterable plus callback over one implementation. Bounded queue with an explicit overflow "
     "policy -- a slow consumer must not grow memory without bound.")

unit("ws-client", "LighterWsClient", 3,
     ["websocket"], ["src/ws/client.ts", "src/ws/index.ts"],
     ["ws-transport", "ws-subscription", "ws-mock-harness"], "high",
     "Ties transport, registry and subscriptions together. Resubscribe-on-reconnect is this unit's "
     "responsibility and is the thing most likely to be silently wrong.")

unit("ws-send-tx", "Correlated transaction submission over WebSocket", 3,
     ["websocket"], ["src/ws/send-tx.ts"], ["ws-client"], "medium",
     "jsonapi/sendtx and sendtxbatch with request/response correlation, timeouts, and correlation "
     "cleanup on reconnect.")

unit("ws-orderbook", "Order book state with gap detection", 3,
     ["websocket"], ["src/ws/orderbook.ts"], ["ws-client"], "high",
     "Snapshot then deltas, price-indexed and SORTED -- the reference appends new levels to the "
     "end, so its book stops being sorted after the first update and bids[0] is no longer the best "
     "bid. Track sequence/offset and resync on gap; the reference has no gap detection at all. "
     "Compare sizes exactly, never through float. See docs/protocol-notes.md section 10.")

# ---------------------------------------------------------------- wave 4: stateful client
unit("client-market-registry", "Market, asset and system-config registry", 4,
     ["client"], ["src/client/markets.ts", "src/client/assets.ts", "src/client/system-config.ts"],
     ["rest-client-facade"], "medium",
     "The client cannot size an order without per-market decimals. 227 markets, each with "
     "supported_size_decimals / supported_price_decimals / supported_quote_decimals. Snapshot and "
     "refresh policy included.")

unit("client-nonce", "Nonce management", 4,
     ["client"], ["src/client/nonce/types.ts", "src/client/nonce/optimistic.ts",
                  "src/client/nonce/server.ts", "src/client/nonce/manual.ts",
                  "src/client/nonce/key-pool.ts", "src/client/nonce/index.ts"],
     ["rest-client-facade"], "high",
     "Lease-based allocation per (account, api key). A network timeout must NOT roll back the "
     "lease -- the transaction may have landed. Per-key mutex: JS is single-threaded but await "
     "yields, so a promise-chain lock is still required. Multi-key rotation included.")

unit("client-order-math", "Order sizing, slippage and leverage arithmetic", 4,
     ["client"], ["src/client/math/book.ts", "src/client/math/slippage.ts",
                  "src/client/math/quote.ts", "src/client/math/leverage.ts",
                  "src/client/math/index.ts"], ["client-market-registry"], "high",
     "Integer/rational end to end. No number, no Math.round. Rounding direction is explicit per "
     "call site: a buy's acceptable price rounds UP, a sell's rounds DOWN, so rounding never "
     "loosens slippage protection. The reference's four float hazards "
     "(docs/protocol-notes.md section 9) become regression tests.")

unit("client-core", "LighterClient core: submit, receipts, account state", 4,
     ["client"], ["src/client/lighter-client.ts", "src/client/account.ts",
                  "src/client/receipt.ts", "src/client/submit.ts"],
     ["tx-pipeline-builders", "client-nonce", "client-market-registry", "ws-send-tx"], "high",
     "Build -> validate -> hash -> sign -> serialize -> submit over HTTP or WS -> confirm. "
     "Submission is idempotent-aware given the nonce lease semantics.")

unit("client-write-surface", "Transfers, withdrawals, margin, pools, staking, integrator", 4,
     ["client"], ["src/client/write/transfer.ts", "src/client/write/withdraw.ts",
                  "src/client/write/account-config.ts", "src/client/write/margin.ts",
                  "src/client/write/pools.ts", "src/client/write/staking.ts",
                  "src/client/write/integrator.ts", "src/client/write/memo.ts",
                  "src/client/write/fast-withdraw.ts"],
     ["client-core", "tx-l1-templates"], "medium",
     "The non-order write methods. The four L1-signed flows take an injected L1Signer.")

unit("client-keys-auth", "API key management and auth tokens", 4,
     ["client"], ["src/client/keys.ts", "src/client/auth-token.ts", "src/client/auth-schedule.ts"],
     ["client-core"], "medium",
     "Auth token = \"<deadline>:<accountIndex>:<apiKeyIndex>:<hexSignature>\", where the message "
     "text is packed 8 bytes per field element little-endian with the final chunk zero-padded. "
     "Pinned by tx.json authTokens. The scheduler mirrors the reference's 6-hour aligned "
     "boundaries with 8-hour expiry so windows overlap.")

unit("client-trading-facade", "Trading facade: market handles, brackets, batches", 4,
     ["client"], ["src/client/market-handle.ts", "src/client/brackets.ts", "src/client/batch.ts",
                  "src/client/sequence.ts", "src/client/index.ts"],
     ["client-order-math", "client-write-surface", "client-keys-auth"], "medium",
     "The ergonomic surface most users touch. setLeverage takes a decimal string or exact "
     "numerator/denominator, never a fractional number (docs/decisions.md D7).")

# ---------------------------------------------------------------- wave 5: integration
unit("public-api-barrel", "Public API barrel, package.json, exports map and CI", 5,
     ["infra"], ["src/index.ts", "package.json", ".github/workflows/ci.yml",
                 ".github/workflows/publish.yml", "size-budget.json", "scripts/report-size.ts"],
     ["client-trading-facade", "rest-client-facade", "ws-client"], "medium",
     "This unit owns EVERY shared file: the root barrel, package.json, both workflows, and the "
     "size budget (docs/decisions.md D8). No leaf unit edits them -- that is what keeps the waves "
     "parallel-safe. Zero runtime dependencies, asserted in CI.")

unit("portability-harness", "Prove it runs on Bun, Node, Deno and workerd", 5,
     ["testing", "infra"], ["test/portability/run-vectors.ts", "test/portability/behaviour.ts"],
     ["public-api-barrel", "w0-worker-sign-benchmark"], "medium",
     "The same vector suite executed under every target runtime. This is what makes the "
     "'runs anywhere' claim testable rather than aspirational.")

unit("docs-and-readme", "README and per-module documentation", 5,
     ["docs"], ["README.md", "CHANGELOG.md", "docs/rest.md", "docs/ws.md", "docs/crypto.md",
                "docs/client.md"], ["public-api-barrel"], "low",
     "README must state the supported deployment tier explicitly: paid-tier Workers; free-tier "
     "signing is not supported (docs/decisions.md D4). Document the injected L1Signer seam with a "
     "worked viem adapter.")

unit("examples-acceptance", "Acceptance examples: read, sign, submit, stream, L1", 5,
     ["examples"], ["examples/"], ["public-api-barrel"], "low",
     "A small acceptance set rather than one-for-one parity with the ~63 Python examples "
     "(docs/decisions.md D10). Each example is typechecked against dist/ in CI.")

# ---------------------------------------------------------------- validate + emit
def main():
    seen = {}
    dupes = []
    for u in U:
        for f in u["files"]:
            if f in seen:
                dupes.append((f, seen[f], u["key"]))
            seen[f] = u["key"]

    keys = {u["key"] for u in U}
    bad_deps = [(u["key"], d) for u in U for d in u["dependsOn"] if d not in keys]

    print(f"units: {len(U)}   owned paths: {len(seen)}")
    print(f"by wave: { {w: sum(1 for u in U if u['wave']==w) for w in sorted({u['wave'] for u in U})} }")

    if dupes:
        print("\nFILE OWNERSHIP COLLISIONS:")
        for f, a, b in dupes:
            print(f"  {f}  claimed by {a} AND {b}")
    else:
        print("ownership: no path claimed twice")

    if bad_deps:
        print("\nUNKNOWN DEPENDENCIES:")
        for k, d in bad_deps:
            print(f"  {k} -> {d}")
    else:
        print("dependencies: all resolve")

    # cycle check
    import collections
    indeg = collections.Counter()
    adj = collections.defaultdict(list)
    for u in U:
        indeg[u["key"]] += 0
        for d in u["dependsOn"]:
            adj[d].append(u["key"])
            indeg[u["key"]] += 1
    q = [k for k, v in indeg.items() if v == 0]
    order = []
    while q:
        n = q.pop()
        order.append(n)
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    print(f"cycles: {'NONE' if len(order)==len(U) else 'CYCLE DETECTED'}")

    if not dupes and not bad_deps and len(order) == len(U):
        json.dump({"units": U}, open("ledger.json", "w"), indent=1)
        print("\nwrote ledger.json")
    else:
        raise SystemExit("ledger invalid — not writing")


if __name__ == "__main__":
    main()
