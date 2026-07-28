# Lighter WebSocket fixtures

The committed files are raw protocol evidence from a completed capture run.

- Host: `testnet.zklighter.elliot.ai`
- UTC start: `2026-07-28T22:20:09.123Z`
- Script version: `2`
- Egress IP: `99.35.221.133`

Every frame has `dir`, monotonic `tMs`, wall-clock `wallMs`, and verbatim wire
text in `raw`. The only permitted wire mutation is auth-token redaction.

`capture.json` is the pre-existing legacy aggregate and intentionally retains
the original blocked-mainnet result for compatibility with downstream replay
tests. The structured files listed above are the canonical live evidence.

Re-capture from a permitted jurisdiction:

```sh
bun run scripts/capture-ws-fixtures.ts --host testnet.zklighter.elliot.ai --market 1 --account 8
bun run scripts/capture-ws-fixtures.ts --verify
```
