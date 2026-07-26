/**
 * Nonce allocation, assembled.
 *
 * This is the **module** barrel for `src/client/nonce/` — it re-exports the five files beside it
 * and adds the one factory. It is not the `./client` barrel: a unit exports from its own module
 * files only (`docs/decisions.md` D8).
 *
 * The submit path this unit is built for:
 *
 * ```ts
 * const nonces = createNonceSource("optimistic", { accountIndex, keys: [0, 1, 2], client });
 * const classify = createOutcomeClassifier();
 *
 * using lease = await nonces.lease();          // rotates a key, takes its mutex
 * try {
 *   const tx = sign({ ...order, apiKeyIndex: lease.apiKeyIndex, nonce: lease.nonce });
 *   const res = await client.transaction.sendTx({ tx_type, tx_info: tx });
 *   switch (classify(res)) {
 *     case "accepted":      lease.commit();  break;
 *     case "rejected":      lease.rollback(); break;
 *     case "invalid-nonce": await nonces.resync(lease.apiKeyIndex); break;
 *     case "indeterminate": break;           // burn the slot: it may well have landed
 *   }
 * } catch (e) {
 *   if (classify(e) === "rejected") lease.rollback();
 *   throw e;
 * }
 * // `using` releases the mutex here, on both paths.
 * ```
 *
 * Sign and submit happen **inside** the lease. Releasing after allocation would let two
 * transactions on one key reach the sequencer out of nonce order, which is a rejection for every
 * transaction after the first.
 */

import { LighterConfigError } from "../../errors.js";
import { ManualNonceSource } from "./manual.js";
import { OptimisticNonceSource } from "./optimistic.js";
import { ServerNonceSource } from "./server.js";
import type { NonceSource, NonceSourceKind, NonceSourceOptions } from "./types.js";

export { KeyPool } from "./key-pool.js";

export { ManualNonceSource } from "./manual.js";
export type { ManualNonceSourceOptions } from "./manual.js";

export { OptimisticNonceSource } from "./optimistic.js";
export type { OptimisticNonceSourceOptions } from "./optimistic.js";

export { DEFAULT_PACE_MS, MAX_PACE_MS, ServerNonceSource } from "./server.js";
export type { ServerNonceSourceOptions } from "./server.js";

export {
  classifyOutcome,
  createLease,
  createOutcomeClassifier,
  INVALID_NONCE_API_CODES,
  readNextNonce,
} from "./types.js";
export type {
  ClassifyOptions,
  LeaseSpec,
  NextNonceClient,
  NextNonceResponse,
  NonceKeySnapshot,
  NonceLease,
  NonceOutcome,
  NonceSnapshot,
  NonceSource,
  NonceSourceKind,
  NonceSourceOptions,
} from "./types.js";

/**
 * Build a nonce source.
 *
 * `"optimistic"` is the default strategy — one local counter per key, one `nextNonce` per key for
 * the lifetime of the source. `"server"` re-queries every time and paces key reuse. `"manual"`
 * refuses to allocate and is what `skipNonce` requires.
 *
 * Nothing here performs I/O: construction is a few objects and a frozen key list, so a source is
 * cheap enough to build per request in a serverless handler and safe to build at module scope in
 * one that is not.
 *
 * @throws {LighterConfigError} when a strategy that needs `GET /api/v1/nextNonce` is built without
 * a client, or when the kind is not one of the three.
 */
export function createNonceSource(kind: NonceSourceKind, deps: NonceSourceOptions): NonceSource {
  switch (kind) {
    case "optimistic": {
      const client = requireClient(deps, kind);
      return new OptimisticNonceSource({
        accountIndex: deps.accountIndex,
        client,
        ...(deps.pool !== undefined ? { pool: deps.pool } : {}),
        ...(deps.keys !== undefined ? { keys: deps.keys } : {}),
        ...(deps.pipelined !== undefined ? { pipelined: deps.pipelined } : {}),
      });
    }
    case "server": {
      const client = requireClient(deps, kind);
      return new ServerNonceSource({
        accountIndex: deps.accountIndex,
        client,
        ...(deps.pool !== undefined ? { pool: deps.pool } : {}),
        ...(deps.keys !== undefined ? { keys: deps.keys } : {}),
        ...(deps.defaultPaceMs !== undefined ? { defaultPaceMs: deps.defaultPaceMs } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      });
    }
    case "manual":
      return new ManualNonceSource({ accountIndex: deps.accountIndex });
    default: {
      // `kind` is `never` here; the guard exists for callers coming from untyped configuration.
      throw new LighterConfigError(`unknown nonce strategy "${String(kind)}"`);
    }
  }
}

function requireClient(
  deps: NonceSourceOptions,
  kind: NonceSourceKind,
): NonNullable<NonceSourceOptions["client"]> {
  if (deps.client === undefined) {
    throw new LighterConfigError(
      `the "${kind}" nonce strategy needs a client to reach GET /api/v1/nextNonce`,
    );
  }
  return deps.client;
}
