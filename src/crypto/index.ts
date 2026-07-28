/**
 * The `lighter-ts/crypto` subpath: everything needed to derive a public key, sign a hashed message,
 * and verify a signature — plus the layers underneath, which are exported because they are what the
 * conformance vectors pin and what anyone auditing this package will want to reach directly.
 *
 * ```ts
 * import { ApiKey, verify } from "lighter-ts/crypto";
 *
 * const key = ApiKey.fromPrivateKey("0x…80 hex characters…");
 * const sig = key.sign(hashedMessage);            // 80 bytes, synchronous
 * verify(key.publicKeyBytes, hashedMessage, sig); // true
 * ```
 *
 * The layers, bottom to top:
 *
 * | Module | What it is |
 * | --- | --- |
 * | `field/constants`, `field/fp` | the Goldilocks base field `p = 2^64 - 2^32 + 1` |
 * | `field/fp5` | the quintic extension `GF(p^5)` and the 40-byte codec |
 * | `field/recode` | signed-digit recoding for windowed multiplication |
 * | `poseidon2` | the permutation, the sponge, and `hashToQuinticExtension` |
 * | `scalar` | `Z/nZ`: private keys, both halves of a signature, the nonce and the challenge |
 * | `point`, `scalarmul` | the ECgFp5 group law, codec, and `[s]P` / `[s]G` / `[s]G (+) [e]P` |
 * | `nonce` | the hedged-deterministic signing nonce |
 * | `schnorr`, `key` | sign, verify, and `ApiKey` |
 *
 * **Importing this module does nothing.** No network call, no timer, no mutated global, and no
 * randomness — `globalThis.crypto` is resolved per call, never at module scope, because Cloudflare
 * Workers forbids randomness in the isolate's global scope (`docs/protocol-notes.md` §5.1). The one
 * memoised table, the generator's window, is built on first use rather than at load.
 *
 * Two things this surface deliberately does not have. `verify` takes no options at all — the
 * neutral public key is a universal forgery and its rejection is unconditional, with no opt-out
 * flag (`docs/decisions.md` D1). And there is no strict variant of the sign/verify path: the parsers
 * there reduce, because a strict one rejects signatures the sequencer accepts (D3). `fp5FromBytes`
 * and `scalarFromBytes` reduce; `fp5FromBytesStrict` and `scalarFromBytesStrict` reject, and
 * nothing on the signing path calls them.
 *
 * This is the only barrel this unit owns. The root barrel and the `exports` map belong to the
 * integration unit.
 */

export * from "./field/constants.js";
export * from "./field/fp.js";
export * from "./field/fp5.js";
export * from "./field/recode.js";
export * from "./poseidon2/index.js";
export * from "./scalar.js";
export * from "./point.js";
export * from "./scalarmul.js";
export * from "./nonce.js";
export * from "./schnorr.js";
export * from "./key.js";
