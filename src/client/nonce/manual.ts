/**
 * The strategy that refuses to allocate.
 *
 * Manual mode is what `skipNonce` requires: the caller claims specific slots out of order (base
 * nonce `22`, interval `3`, so `22`, `25`, `28`, each carrying L2 attribute type `4` set to `1`)
 * and no counter could describe that. It is also the mode a caller selects when nonces come from
 * somewhere else entirely — another process, a database, a hardware wallet's own sequence.
 *
 * The rule this exists to enforce is from `docs/spec/07-high-level-client.md` §4.3:
 * **caller-managed mode bypasses the manager entirely.** The sentinels are
 * `NIL_API_KEY_INDEX = 255` and `DEFAULT_NONCE = -1`, and the manager engages only when *both* are
 * at their sentinel. If the caller supplied either explicitly, no counter moves, no lease is taken,
 * and no rollback happens. Half-engaging — taking a lease for a nonce the caller chose — is a
 * corruption source, so `lease()` here does not quietly return something plausible. It throws.
 */

import { LighterNonceError } from "../../errors.js";
import { assertSnapshot, requireAccountIndex } from "./optimistic.js";
import type { NonceLease, NonceSnapshot, NonceSource } from "./types.js";

/** What {@link ManualNonceSource} is constructed with. No client: it makes no network call, ever. */
export interface ManualNonceSourceOptions {
  /** The account this source is attached to. Only used to stamp and check snapshots. */
  readonly accountIndex: number;
}

export class ManualNonceSource implements NonceSource {
  readonly kind: "manual" = "manual";
  readonly accountIndex: number;

  constructor(options: ManualNonceSourceOptions) {
    this.accountIndex = requireAccountIndex(options.accountIndex);
  }

  /**
   * Always rejects with {@link LighterNonceError} `"LEASE_EXHAUSTED"`.
   *
   * Rejects rather than throwing synchronously, so a caller using `.catch()` sees the failure in
   * the same place a caller using `await` does.
   */
  async lease(): Promise<NonceLease> {
    throw new LighterNonceError(
      "LEASE_EXHAUSTED",
      "the manual nonce strategy does not allocate; supply both nonce and apiKeyIndex explicitly",
    );
  }

  /** No-op: there is no counter to resync. */
  async resync(): Promise<void> {
    /* nothing is cached, so nothing can be stale */
  }

  /** Always empty, and still stamped, so it round-trips through storage like the others. */
  snapshot(): NonceSnapshot {
    return { version: 1, kind: this.kind, accountIndex: this.accountIndex, keys: [] };
  }

  /** Validates the envelope and keeps nothing — a manual source has no state to restore. */
  restore(s: NonceSnapshot): void {
    assertSnapshot(s, this.kind, this.accountIndex);
  }
}
