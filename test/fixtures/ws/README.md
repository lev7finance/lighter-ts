# Lighter WebSocket fixtures

The committed run was blocked before WebSocket upgrade; it is evidence of the blocker, not protocol fixtures.

- Host: `mainnet.zklighter.elliot.ai`
- UTC start: `2026-07-28T21:52:53.472Z`
- Script version: `2`
- Egress IP: `99.35.221.133`

Every frame has `dir`, monotonic `tMs`, wall-clock `wallMs`, and verbatim wire
text in `raw`. The only permitted wire mutation is auth-token redaction.

Re-capture from a permitted jurisdiction:

```sh
bun run scripts/capture-ws-fixtures.ts --host mainnet.zklighter.elliot.ai --market 1 --account 1
bun run scripts/capture-ws-fixtures.ts --verify
```
