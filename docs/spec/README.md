# Dimension specifications

Eight specifications produced by reading the reference implementations
(`elliottech/lighter-go`, `lighter-python`, `poseidon_crypto`) and describing **what the protocol
is** — wire formats, byte orders, field orders, numeric domains, algorithms stated mathematically.
No Go or Python source is reproduced. Protocol-mandated values are interoperability requirements
and are stated exactly.

| File | Covers |
| --- | --- |
| `01-crypto-field.md` | Goldilocks base field and the GF(p⁵) extension |
| `02-crypto-poseidon2.md` | Poseidon2 permutation, sponge, hash wrappers |
| `03-crypto-curve-schnorr.md` | ECgFp5 curve arithmetic and the Schnorr scheme |
| `04-tx-types.md` | Every transaction type: fields, hashing, validation, JSON |
| `05-rest-api.md` | REST endpoint catalogue and models |
| `06-websocket.md` | WebSocket protocol, channels, order-book reconciliation |
| `07-high-level-client.md` | Signer client, nonce management, order math |
| `08-extras-and-dx.md` | Paper engine, remaining surfaces, packaging |

## Precedence

These are **research output, not decisions**. They disagree with each other in places, and review
found several claims that were wrong. Read in this order, higher wins:

1. `docs/decisions.md` — ratified, resolves the conflicts
2. `docs/protocol-notes.md` — verified by execution
3. `conformance/vectors/` — the machine-checkable contract
4. these files
5. `docs/ARCHITECTURE.md` — superseded in the places its header lists

Known corrections already found in these files, so you do not rediscover them:

- `01` prefers a compare-and-subtract reduction chain; **measured backwards**, plain `%` is
  2.5–4× faster (`bench/README.md`, decision D4).
- `01` and `03` disagree with each other on decoder strictness; **D3** settles it —
  `sign`/`verify` reduce, strict is opt-in.
- `03` §7.3's implementation sketch of the 4-lane external step is order-dependent and wrong as
  printed; snapshot the chunk before writing.
- `03` ships an `allowNeutralPublicKey` escape hatch; **D1** removes it — it is a universal forgery.
- `01` §4.2 teaches a Euclidean signed→field map; the protocol sign-extends instead, so `-1`
  becomes `4294967294`, not `p-1`. `02` §2.1 has it right.

When a spec and a vector disagree, the vector wins and the spec is wrong.
