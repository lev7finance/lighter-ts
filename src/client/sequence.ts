/**
 * `sequence()` — several **separate** submissions that must arrive in order, on one API key.
 *
 * ```ts
 * const orderId = await sequence(account, async (s) => {
 *   const created = await s.send(s.tx.createOrder({ … }));
 *   await s.send(s.tx.modifyOrder({ … }));
 *   await s.send(s.tx.cancelOrder({ … }));
 *   return created.txHash;
 * });
 * ```
 *
 * ## How this differs from `batch()`
 *
 * `batch()` is *one request*: the transactions are signed together and handed to `sendTxBatch`, and
 * the sequencer executes them back to back with nothing interleaved. `sequence()` is *N requests*,
 * each awaited, each with a receipt the caller can read before deciding what to send next — a
 * `create` whose order id decides the `modify` cannot be batched, because the id does not exist yet
 * when the batch is built.
 *
 * What `sequence()` supplies is the property `batch()` gets for free: **one key, no rotation**. A
 * nonce is scoped to `(account, apiKey)` and is only ordered within that pair, so three submissions
 * that must arrive in order must ride one key. The default optimistic pool rotates across keys to
 * pipeline throughput, which is right for unrelated sends and wrong for a dependent run — so this
 * pins the key for the duration and passes it as `preferKey` on every submission inside.
 *
 * ## The pin is a lease, taken once and released in `finally`
 *
 * Exactly as in `./batch.ts`: a lease owns its key's non-reentrant mutex, so holding it across the
 * callback would deadlock the first `s.send()` inside. The lease resolves *which* key, returns its
 * slot immediately — nothing has been signed, so the slot is definitively unused — and the release
 * is unconditional. Interleaved traffic on **other** keys never disturbs the run, because every send
 * inside names this one.
 *
 * Ordering across the run is the caller's `await`, not a queue here: `s.send()` resolves only once
 * the sequencer has accepted, and the nonce it carried was allocated under that key's mutex.
 *
 * No Node built-ins, no module-level mutable state, no timers.
 */

import { LighterConfigError } from "../errors.js";
import type { SignedTx, UnsignedTx } from "../tx/build.js";
import type { RawTxSurface } from "./account.js";
import type { AccountContext } from "./batch.js";
import type { NonceLease } from "./nonce/types.js";
import type { TxReceipt } from "./receipt.js";
import type { PrepareOpts, SendOpts } from "./submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* The sequence context                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the callback is handed.
 *
 * {@link send} is the account's `send()` with the key pinned. A caller who reaches around it and
 * uses the account directly gets the pool's ordinary rotation — which is exactly what they asked
 * for by not using this context.
 */
export interface SequenceContext {
  /** The twenty raw builders, unchanged: a sequence does not queue, it submits as it goes. */
  readonly tx: RawTxSurface;
  /** The API key every submission in this sequence rides. */
  readonly apiKeyIndex: number;
  /** How many submissions this context has made. */
  readonly sent: number;
  /** Sign and submit, on the pinned key. `preferKey` in the caller's options is ignored. */
  send(tx: UnsignedTx | SignedTx, opts?: SequenceSendOpts): Promise<TxReceipt>;
  /** Stamp, validate, hash and sign on the pinned key, without submitting. */
  prepare(tx: UnsignedTx, opts?: SequencePrepareOpts): Promise<SignedTx>;
}

/**
 * `SendOpts` minus the three fields the sequence owns.
 *
 * `preferKey` is the pin. `nonce` and `apiKeyIndex` together select caller-managed mode, which
 * bypasses the nonce source entirely — that is a legitimate thing to want, and it is not something
 * to do *inside* a construct whose whole purpose is to manage the sequence for you.
 */
export type SequenceSendOpts = Omit<SendOpts, "nonce" | "apiKeyIndex" | "preferKey">;

/** {@link SequenceSendOpts} for the prepare-only path. */
export type SequencePrepareOpts = Omit<PrepareOpts, "nonce" | "apiKeyIndex" | "preferKey">;

/** Per-call options for {@link sequence}. */
export interface SequenceOptions {
  /** Pin to a particular key rather than letting the pool choose. The run is on one key either way. */
  readonly preferKey?: number;
}

/* ---------------------------------------------------------------------------------------------- */
/* sequence                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Run `fn` with one API key pinned for the duration, and return whatever it returns.
 *
 * The callback's own value is passed through unchanged — a sequence is a scope, not a collection —
 * so `create → modify → cancel` can return the order id, a receipt, or nothing at all.
 *
 * @throws whatever the callback throws, after releasing the pin.
 * @throws {LighterConfigError} if the account's nonce source hands back a key index that is not a
 * number, which would mean the pin is not pinning anything.
 */
export async function sequence<T>(
  ctx: AccountContext,
  fn: (s: SequenceContext) => Promise<T> | T,
  opts?: SequenceOptions,
): Promise<T> {
  const lease: NonceLease = await ctx.nonces.lease(opts?.preferKey);
  const apiKeyIndex: number = lease.apiKeyIndex;
  if (!Number.isInteger(apiKeyIndex)) {
    lease.rollback();
    lease.release();
    throw new LighterConfigError(
      `the nonce source leased api key index ${String(apiKeyIndex)}, which is not an integer; a ` +
        "sequence cannot pin to it",
    );
  }
  try {
    // The pin's own slot is not used by the sequence: every `s.send()` allocates its own, under
    // this key's mutex. Returning it now is what keeps that mutex free — see the module header.
    lease.rollback();
    lease.release();
    return await fn(createSequenceContext(ctx, apiKeyIndex));
  } finally {
    // Idempotent, and unconditional: a lease that is never released deadlocks its key for good.
    lease.release();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function createSequenceContext(ctx: AccountContext, apiKeyIndex: number): SequenceContext {
  let sent: number = 0;
  return {
    tx: ctx.tx,
    apiKeyIndex,
    get sent(): number {
      return sent;
    },
    async send(tx: UnsignedTx | SignedTx, opts?: SequenceSendOpts): Promise<TxReceipt> {
      sent += 1;
      return ctx.send(tx, { ...opts, preferKey: apiKeyIndex });
    },
    prepare(tx: UnsignedTx, opts?: SequencePrepareOpts): Promise<SignedTx> {
      return ctx.prepare(tx, { ...opts, preferKey: apiKeyIndex });
    },
  };
}
