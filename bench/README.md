# Benchmarks

## `field.bench.ts` — is BigInt fast enough for Cloudflare Workers?

The architecture flags BigInt throughput as a **design-invalidating** risk: if base-field
arithmetic is too slow, the whole "pure TypeScript, runs anywhere" premise fails and the SDK needs
WASM after all. One Schnorr signature is roughly one ECgFp5 scalar multiplication, which is on the
order of **85,000 base-field multiplications**.

This benchmark answers it before any of the crypto is written, and compares three reduction
strategies for `GF(2^64 - 2^32 + 1)`:

| Strategy | What it does |
| --- | --- |
| `mulPlain` | `(a * b) % P` |
| `mulFold` | Goldilocks-specific hi/lo folding, mirroring the Go reference's shape |
| `mulFoldMod` | the same folding, finished with `%` instead of conditional subtractions |

Run it:

```sh
bun run bench/field.bench.ts
node --experimental-strip-types bench/field.bench.ts
deno run bench/field.bench.ts
```

All three strategies are checked against each other over 20,000 random pairs before timing, so a
fast-but-wrong result cannot masquerade as a win.

### Result

Measured 2026-07-25, Apple Silicon, 2,000,000 iterations after a 200,000-iteration warmup:

| Runtime | `mulPlain` | `mulFold` | `mulFoldMod` | Best, per signature |
| --- | --- | --- | --- | --- |
| Bun 1.3.0 | **34.6 ns** | 139.5 ns | 113.5 ns | **~2.9 ms** |
| Node 24.10 | **28.0 ns** | 76.2 ns | 72.7 ns | **~2.4 ms** |
| Deno 2.9.0 | **19.0 ns** | 61.0 ns | 55.9 ns | **~1.6 ms** |

Two conclusions, both of which change the plan:

**1. The risk is closed.** A signature costs single-digit milliseconds. That fits inside the
Cloudflare Workers free-tier 10 ms CPU budget, with the paid tier having room to spare. BigInt is
viable; no WASM fallback is needed.

**2. The clever reduction is the slow one.** Hand-folded Goldilocks reduction is **2.5–4× slower
than plain `%`** on every runtime tested. That is the opposite of the intuition carried over from
Go, where the fold avoids a hardware division. V8 and JavaScriptCore implement BigInt remainder for
small operands well enough that the extra BigInt allocations in the folding path — each
intermediate is a heap object — cost more than the division saves.

So: **use `(a * b) % P` everywhere**, not just inside the hash. The simpler code is also the faster
code, and it removes an entire class of off-by-one fixup bugs from the highest-risk module in the
SDK.

Numbers are per-runtime and hardware-dependent; the ordering was stable across all three engines,
which is what the decision rests on. Re-run before revisiting the reduction strategy.
