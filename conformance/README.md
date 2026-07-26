# Conformance vectors

`lighter-ts` is an independent TypeScript implementation of the Lighter protocol. It shares no
code with the reference SDKs — but it must produce byte-identical output, or the sequencer will
reject every transaction it signs.

This directory is how we prove that.

## How it works

`oracle/` is a small Go program that depends on the published reference modules
(`github.com/elliottech/lighter-go`, `github.com/elliottech/poseidon_crypto`). It feeds
**deterministic** inputs through the reference and records the outputs as JSON in `vectors/`.

The TypeScript implementation is written from the specification, never from the Go source. The
conformance suite then replays these vectors against it. Divergence anywhere — a field
multiplication, a Poseidon round constant, a hash element ordering, a signature byte — fails the
build.

The oracle is a build-time fixture generator. Nothing in `src/` imports it, and it is not
published to npm.

## Regenerating

```sh
cd conformance/oracle
go run . -out ../vectors
```

Generation is seeded (`splitmix64`, fixed seed) and uses no wall-clock or RNG, so re-running
produces byte-identical files. A dirty `git status` after regeneration means the reference
version changed — inspect the diff before accepting it.

## What each file pins

| File              | Layer                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `goldilocks.json` | Base field `p = 2^64 - 2^32 + 1`: add/sub/mul/square/exp/sqrt, LE encoding    |
| `gfp5.json`       | Quintic extension `GF(p^5)`: arithmetic, Frobenius, Legendre, sqrt, 40-byte encoding |
| `poseidon2.json`  | Poseidon2 permutation, `HashToQuinticExtension`, `HashNoPad`, `HashNToMNoPad` |
| `curve.json`      | ECgFp5 scalar multiplication, point add/double, encode/decode, scalar reduction |
| `schnorr.json`    | Key derivation, signing (pinned nonce), verification, and rejection cases     |
| `tx.json`         | End-to-end transaction message hashes, attribute aggregation, signatures      |

`tx.json` is the one that matters most: it exercises every layer at once, exactly as production
signing does. Alongside the transaction hashes it also carries the L1 (EIP-191) message bodies and
the read-only auth tokens.

## There is only one Poseidon2, despite appearances

`poseidon_crypto` ships two Poseidon2 implementations, and the reference SDK uses **both**:
transaction hashing goes through `hash/poseidon2_goldilocks_plonky2`, while auth-token construction
goes through `hash/poseidon2_goldilocks` (`lighter-go/types/tx_request.go`). They take different
element types — plonky2 uses a plain `uint64`, gnark uses Montgomery form.

Checked by running both over the same input: **they produce byte-identical output.** The difference
is internal representation, not the function computed. `lighter-ts` therefore implements one
Poseidon2 and uses it everywhere. This is worth stating explicitly because reading the reference
naturally suggests two are required.

## Canonical vs non-canonical field values

The Go reference stores a field element as a raw `uint64` in **non-canonical** form — arithmetic
reduces into `[0, 2^64)` and the stored value may sit one `ORDER` above the true residue.
`ToCanonicalUint64` applies the final conditional subtraction, and all serialization paths call it.
Notably, `FromCanonicalLittleEndianBytesF` performs **no** range validation, so a limb `>= ORDER`
decodes to a non-canonical element rather than an error.

That representation is a hardware-64-bit optimization with no analogue in a `BigInt`
implementation. `lighter-ts` reduces fully on every operation, so **every expected value in these
vectors is canonical**. The divergence is recorded explicitly under `nonCanonicalNotes` in
`goldilocks.json`, with worked examples, so it stays a documented decision rather than a latent bug.

Concretely: the reference encodes the curve generator with a limb of `18446744069414584325`
(`ORDER + 4`). Canonically that is `4`. `lighter-ts` produces `4`, and both serialize to the same
bytes.

## Signature determinism

The reference samples the Schnorr nonce `k` at random, so its signatures are not reproducible by
construction. The oracle uses the reference's explicit-`k` entry point to pin the nonce, which makes
the signature vectors exact.

`lighter-ts` keeps that same seam — a caller-supplied `k` for tests — but its **default is
hedged-deterministic**, deriving `k` from the private key and the message hash mixed with fresh
randomness, rather than depending on the RNG alone.

This is a deliberate improvement on the reference, and it is free: `k` never appears on the wire,
only `(s, e)` do, so any correctly-derived nonce produces a signature the sequencer accepts. The
verifier cannot tell the difference. What changes is the failure mode — under pure randomness, a
weak or repeating RNG leaks the private key outright after two signatures, and that failure is
silent. Deriving from the key and message removes that cliff while the hedge preserves protection
against fault attacks.

One runtime note this interacts with: Cloudflare Workers forbids `crypto.getRandomValues` at module
scope. Nonce generation must therefore happen per-call, never during module initialization.
