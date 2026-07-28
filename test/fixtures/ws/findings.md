# WebSocket findings

Each question below mirrors `docs/spec/06-websocket.md` §15. A claim is only marked
**answered** when a committed raw frame or close observation supports it.

## 1. sendtx acknowledgement envelope

**Unanswered.** This evidence-only run submits no transaction.

## 2. account update replacement semantics

**Answered for envelope completeness.** `channels/account_all.json` frame 2 is the full subscribed snapshot and frame 3 is the first live update. The update omits snapshot keys `daily_trades_count`, `daily_volume`, `monthly_trades_count`, `monthly_volume`, `total_trades_count`, `total_volume`, `weekly_trades_count`, `weekly_volume` and sends null for `assets`. Therefore an `update/account_all` envelope is partial and must not replace the whole account snapshot. This evidence does not by itself distinguish “unchanged” from “clear” for individual null-valued fields.

## 3. subscription survival after auth expiry

**Unanswered.** No deliberately short-lived valid auth token was supplied.

## 4. channels requiring auth

**Answered.** All fourteen ambiguous/account families have a response in their corresponding `channels/<family>.json`; the exact subscribe and response frames show which succeed without auth and which return a refusal.

## 5. WebSocket error envelope

**Answered.** Exact shape from `channels/account_market.json` frame 2:

```json
{"error":{"code":20001,"message":"invalid param : auth field is required: account_market:1:1"}}
```

## 6. market_stats/all fan-out

**Answered.** `channels/market_stats.json` second probe, frame 2, is the first fan-out frame; the probe's observation records the total frame count.

## 7. snapshot type names

**Unanswered.** A valid subscription snapshot/update was not captured for: account_tx, account_all_orders, account_orders, account_market, rfq.

## 8. unsubscribe acknowledgement

**Answered.** The known-subscription unsubscribe is `errors.json` frame 21; subsequent non-keepalive response frames are 22.

## 9. unsolicited pong

**Answered.** Unsolicited pongs at `keepalive.json` frames 10, 15, 20 received no Invalid Type response during 180103 ms.

## 10. server ping interval

**Answered.** No application-level `{"type":"ping"}` frame arrived during 360102 ms. The socket remained open by sending maintenance `{"type":"pong"}` frames at `keepalive.json` answerPings.session frame indices 10, 15, 20, 29, 35, 43, 53. The observed server-ping cadence is therefore “none within six minutes,” not an inferred interval.

## 11. encoding negotiation

**Answered.** Compare `handshake.json` encoded frame 2 and defaultEncoding frame 2; binary-frame observations are recorded separately.

## 12. server close codes

**Answered for idle timeout.** `keepalive.json` silent.session.close records code 1000, reason `read tcp 172.31.84.115:8888->172.31.81.91:8060: i/o timeout`, elapsed 120600 ms.

## 13. timestamp units

**Answered for height only.** `channels/height.json` frame 2 contains timestamp `1785276589124` (milliseconds by magnitude). PositionFunding still needs account funding activity.

## 14. order-book depth

**Answered.** `orderbook-chain.json` snapshot frame 2 has 43 asks/58 bids; REST has 45 asks/57 bids. The chain records 500 updates and 0 gaps.

## 15. account_orders inbound key

**Unanswered.** No account_orders data frame with an inbound channel key exists.
