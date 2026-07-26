/**
 * `build → hash → sign → serialise`, as four separable functions.
 *
 * The Go reference conflates all four into one `Construct*Tx` function, duplicated twenty times. It
 * is duplicated because the four stages have different dependencies: hashing needs no key, signing
 * needs no schema, and serialisation needs neither a chain id nor a clock. Splitting them buys three
 * concrete things:
 *
 * - **An air-gapped signer.** {@link txHash} runs on the machine that has the market data;
 *   `ApiKey.sign` runs on the machine that has the key. Nothing has to cross except 40 bytes.
 * - **Vector replay.** All 38 `txHashes` rows of `conformance/vectors/tx.json` are reproduced by
 *   `txHashHex(build…(row.fields, opts), 304)` with no key present at all, and their signatures by
 *   {@link signTx} with the row's pinned `k`.
 * - **A hash the caller can log.** {@link txHashHex} is the `txHash` the API echoes back, so a
 *   submission can be correlated before the response arrives.
 *
 * ## Four things that are easy to get wrong here
 *
 * **`chainId` is an explicit argument on every function that hashes.** It is never inferred from a
 * base URL and is not discoverable from `/systemConfig` (`docs/protocol-notes.md` §7). It is the
 * *first* element of every transaction hash, so a wrong one produces a perfectly valid signature over
 * a transaction for a different chain, which the sequencer discards without a useful error.
 *
 * **{@link signTx} is synchronous and must stay that way.** Everything on the path — Poseidon2, the
 * curve, the nonce derivation — is synchronous on every runtime, and `crypto.subtle.digest` is
 * deliberately not used (`docs/decisions.md` D2). Returning a `Promise` would break that guarantee
 * for every caller, so the value is checked at run time as well as at compile time.
 *
 * **{@link signTx} exposes `k`.** Without a pass-through to `ApiKey.sign`'s `SignOptions` the
 * conformance signatures cannot be replayed at all: the oracle pins the nonce and the default here is
 * hedged-deterministic. An explicit `k` is for vectors and for callers with their own derivation; it
 * is never a default, and reusing one across two messages recovers the private key.
 *
 * **The hash covers `Nonce` and `ExpiredAt` but not `Sig`, `L1Sig` or `Memo`.** So a transaction may
 * be hashed before it is signed, which is the whole point, and {@link toTxInfo} therefore demands a
 * signed transaction while {@link txHash} does not.
 *
 * ## `tx_info` is not vector-pinned
 *
 * Every row of the current `tx.json` carries `"txInfoJson": ""` — the oracle does not emit the JSON.
 * The gate for {@link toTxInfo} is the hand-authored golden strings in `test/tx/pipeline.test.ts`,
 * derived from `spec/04-tx-types.md` §9.2, plus the live-testnet round trip. Treat changes to the
 * emitter as protocol changes, not as fixture updates.
 */

import { LighterSignatureError } from "../errors.js";
import type { ApiKey, SignOptions } from "../crypto/key.js";
import type { SignedTx, UnsignedTx } from "./build.js";
import { SIGNATURE_LENGTH } from "./constants.js";
import { hashTx, hashTxHex } from "./hash.js";
import { type TxSchema, type TxSchemaRegistry, createTxSchemaRegistry, requireTxSchema } from "./schema.js";
import { ACCOUNT_TX_SCHEMA_LIST } from "./schemas/account.js";
import { ORDER_SCHEMAS } from "./schemas/orders.js";
import { serializeTx } from "./serialize.js";

/**
 * `txType → schema` for all twenty constructible types.
 *
 * A pure fold over two frozen lists, evaluated once at module load. It holds no mutable state and
 * nothing registers into it at run time, so a schema is reachable because someone imported its
 * module — never because a side effect happened to run in the right order.
 */
export const TX_SCHEMAS: TxSchemaRegistry = createTxSchemaRegistry([
  ...ACCOUNT_TX_SCHEMA_LIST,
  ...ORDER_SCHEMAS,
]);

/**
 * The schema for a transaction, resolved from its `type` discriminant.
 *
 * @throws {LighterValidationError} `SCHEMA_TX_TYPE_UNKNOWN` for a code this SDK cannot construct —
 * which for a hand-assembled object means "this is not a transaction", not "this type does not
 * exist".
 */
function schemaOf(tx: UnsignedTx): TxSchema {
  return requireTxSchema(TX_SCHEMAS, tx.type);
}

/**
 * The 40 bytes a transaction is signed over.
 *
 * ```
 * elements = [chainId, txType, Nonce, ExpiredAt, ...schema.hashOrder]
 * result   = aggregate(hashToQuinticExtension(elements), tx.attributes)
 * ```
 *
 * The aggregation step runs unconditionally, including for transactions with no attributes at all —
 * where it serialises the hash and stops rather than re-hashing (`spec/04-tx-types.md` §6.6).
 *
 * @param chainId mainnet `304`, testnet `300`, rh `466324`. Never inferred.
 * @throws {LighterValidationError} for an unknown transaction type or a malformed field.
 */
export function txHash(tx: UnsignedTx, chainId: number): Uint8Array {
  return hashTx(schemaOf(tx), tx, chainId);
}

/**
 * {@link txHash} as lowercase hex: exactly 80 characters, **no `0x` prefix**.
 *
 * This is the reference's `SignedHash` and the `txHash` the API returns in its response body, so the
 * absent prefix is interop rather than style — the two are compared as strings. It is never part of
 * `tx_info`.
 */
export function txHashHex(tx: UnsignedTx, chainId: number): string {
  return hashTxHex(schemaOf(tx), tx, chainId);
}

/**
 * Attach a Schnorr signature over {@link txHash}, returning a new frozen transaction.
 *
 * **Synchronous.** The returned value is the transaction, not a `Promise` of one; the check below is
 * a runtime guard for the same property the type signature states, because an accidental `async` on
 * the signing path would otherwise be caught only by whichever caller first awaited nothing.
 *
 * ```ts
 * const signed = signTx(unsigned, apiKey, CHAIN_ID.mainnet);                 // hedged nonce
 * const pinned = signTx(unsigned, apiKey, 304, { nonce: kFromVector });      // vectors only
 * ```
 *
 * @param opts passed through to `ApiKey.sign`. `{ nonce }` accepts `'hedged'` (the default),
 * `'random'`, or an explicit `k` — the seam every conformance signature is replayed through.
 * @throws {LighterSignatureError} if the signer returns anything other than 80 bytes, or returns a
 * `Promise`.
 * @throws {LighterValidationError} for an unknown transaction type or a malformed field.
 */
export function signTx<T extends UnsignedTx>(
  tx: T,
  key: ApiKey,
  chainId: number,
  opts?: SignOptions,
): T & { sig: Uint8Array } {
  const message: Uint8Array = txHash(tx, chainId);
  const sig: Uint8Array = key.sign(message, opts);
  if (sig instanceof Promise) {
    throw new LighterSignatureError(
      "signTx: the signer returned a Promise; signing must be synchronous on every runtime",
    );
  }
  if (!(sig instanceof Uint8Array) || sig.length !== SIGNATURE_LENGTH) {
    throw new LighterSignatureError(
      `signTx: expected a ${String(SIGNATURE_LENGTH)}-byte signature from the signer`,
    );
  }
  // `Object.freeze`'s declared signature erases the generic, so the cast is on the spread and the
  // freeze is applied to the value in place — same object, same mutability guarantee as a builder's.
  const signed: T & { sig: Uint8Array } = { ...tx, sig } as T & { sig: Uint8Array };
  Object.freeze(signed);
  return signed;
}

/**
 * The `tx_info` document: the exact JSON string `POST /api/v1/sendTx` carries.
 *
 * Schema-driven and hand-written — the built-in JSON stringifier is unusable here, because it throws
 * on `bigint` and because any round trip through it silently rounds `Index`, `ShareAmount`, `Amount`,
 * `USDCFee`, `USDCAmount`, `OrderExpiry`, `Time` and `Nonce`. A rounded field is not a rejected
 * transaction; it is a *different* transaction carrying a signature over the original.
 *
 * Always starts with `{`, which the reference uses as its sanity gate on submission. `SignedHash` is
 * never present.
 *
 * @throws {LighterValidationError} `FIELD_MISSING` when a declared key is absent — nothing in the
 * protocol uses `omitempty`, so an unsigned transaction, or one still missing its `L1Sig`, is an
 * error here rather than a document with a missing key.
 */
export function toTxInfo(tx: SignedTx): string {
  return serializeTx(schemaOf(tx), tx);
}

/** The three values `POST /api/v1/sendTx` needs, plus the hash the caller keeps. */
export interface TxSubmission {
  /** The numeric `tx_type` code — `tx.type`, which is also hash element 1. */
  readonly txType: number;
  /** The `tx_info` document. Always starts with `{`. */
  readonly txInfo: string;
  /** 80 lowercase hex characters, no `0x`. Returned out of band; never inside `txInfo`. */
  readonly txHash: string;
}

/**
 * Everything the submission endpoint needs, in one call.
 *
 * The hash is recomputed here rather than carried on the transaction, so it cannot describe a
 * different chain id than the one this submission is for.
 *
 * @throws {LighterSignatureError} if the emitted document does not start with `{` — impossible
 * through {@link serializeTx}, and checked because the reference gates on exactly that and a
 * violation would be rejected remotely with no local signal.
 * @throws {LighterValidationError} as {@link toTxInfo}.
 */
export function txSubmission(tx: SignedTx, chainId: number): TxSubmission {
  const txInfo: string = toTxInfo(tx);
  if (!txInfo.startsWith("{")) {
    throw new LighterSignatureError("txSubmission: tx_info must be a JSON object starting with '{'");
  }
  return { txType: tx.type, txInfo, txHash: txHashHex(tx, chainId) };
}
