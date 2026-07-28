/**
 * `batch()` — several transactions submitted as **one** request, on one API key, with consecutive
 * nonces.
 *
 * ```ts
 * const receipts = await batch(account, (b) => {
 *   b.tx.cancelOrder({ marketIndex: i16(1), index: i64(oldId) });
 *   b.tx.createOrder({ …replacement });
 * });
 * ```
 *
 * The rule this exists to enforce is `spec/07-high-level-client.md` §5.3: *all transactions in a
 * batch share one `apiKeyIndex` and carry consecutive nonces*. Documentation cannot enforce it,
 * because the natural way to write a batch by hand — build a few transactions, push them into an
 * array — has nothing stopping one of them from being signed by a different key. So the callback
 * receives a {@link BatchContext} whose builders are the only way in, and the run of nonces is
 * allocated by `submitBatch` from a single key in one pass (`./submit.ts`, `leaseConsecutive`),
 * which abandons the batch **before anything is signed** if another caller interleaves on that key.
 *
 * ## The lease, and why it is taken and returned before the callback runs
 *
 * A lease owns its key's mutex, and that mutex is **not reentrant**: holding one across
 * `sendBatch()` — which must itself allocate `N` slots on the same key — deadlocks the key for the
 * life of the client. So the lease taken here is a *pin*: it resolves which key this batch belongs
 * to, returns its slot immediately (nothing has been signed, so the slot is definitively unused),
 * and the key travels on as `preferKey`. The release is in a `finally` regardless, because
 * `release()` is idempotent and the one thing that must never happen is a path that skips it.
 *
 * ## What is not enforced here
 *
 * Batch size, emptiness and the wire encoding all belong to `submitBatch`. Re-checking them here
 * would be a second copy of a bound that is already stated once.
 *
 * No Node built-ins, no module-level mutable state, no timers.
 */

import { LighterConfigError } from "../errors.js";
import type { SignedTx, UnsignedTx } from "../tx/build.js";
import type { RawTxSurface } from "./account.js";
import type { NonceLease, NonceSource } from "./nonce/types.js";
import type { TxReceipt } from "./receipt.js";
import type { PrepareOpts, SendOpts } from "./submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* The seam                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What {@link batch} and `sequence()` need from an account. {@link LighterAccount} satisfies it
 * structurally, and so does a plain object in a test — neither function ever touches a transport
 * directly.
 *
 * Shared with `./sequence.ts`, which imports it from here: this unit owns five files and none of
 * them is a `types.ts`, so the vocabulary lives in the first file that needs it
 * (`docs/decisions.md` D8, one owner per path).
 */
export interface AccountContext {
  /** The signing account, for diagnostics. */
  readonly accountIndex: bigint;
  /** The twenty raw builders, already bound to this account. */
  readonly tx: RawTxSurface;
  /** Where nonces come from. The pin is taken here and returned here. */
  readonly nonces: NonceSource;
  /** Stamp, validate, hash and sign — everything except the network. */
  prepare(tx: UnsignedTx, opts?: PrepareOpts): Promise<SignedTx>;
  /** Sign and submit one transaction. */
  send(tx: UnsignedTx | SignedTx, opts?: SendOpts): Promise<TxReceipt>;
  /** Sign and submit several as one request: one key, consecutive nonces, no interleaving. */
  sendBatch(txs: readonly (UnsignedTx | SignedTx)[], opts?: SendOpts): Promise<TxReceipt[]>;
}

/* ---------------------------------------------------------------------------------------------- */
/* The batch context                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the callback is handed.
 *
 * {@link tx} is the account's own twenty builders with one difference: every call is **queued** as
 * well as returned. That is the structural guarantee — a transaction built through `b.tx` is in the
 * batch by construction, and there is no way to build one through this context that lands anywhere
 * else.
 */
export interface BatchContext {
  /** The twenty builders. Each call queues the transaction it returns. */
  readonly tx: RawTxSurface;
  /** The API key every transaction in this batch will be signed with. */
  readonly apiKeyIndex: number;
  /** How many transactions are queued so far. */
  readonly size: number;
  /**
   * Queue a transaction built elsewhere — a bracket from `./brackets.ts`, or one carried in from a
   * caller's own helper. Returns it, so it reads as a pass-through.
   */
  add<T extends UnsignedTx>(tx: T): T;
  /** The queued transactions so far, in order. A copy; mutating it changes nothing. */
  queued(): readonly UnsignedTx[];
}

/** Per-call options for {@link batch}. */
export interface BatchOptions {
  /**
   * Pin the batch to a particular key rather than letting the pool choose.
   *
   * The batch is on *one* key either way; this only decides which.
   */
  readonly preferKey?: number;
  /** Passed through to `sendBatch`: channel, timeout, signal, price protection. */
  readonly send?: Omit<SendOpts, "nonce" | "apiKeyIndex" | "preferKey">;
}

/* ---------------------------------------------------------------------------------------------- */
/* batch                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Run `fn`, collecting every transaction it builds, and submit them as one `sendTxBatch`.
 *
 * The callback may be synchronous or asynchronous. It is run **inside** the `try` whose `finally`
 * releases the pin, so a callback that throws cannot leak the lease — a lease held forever
 * deadlocks its key for the life of the client.
 *
 * @returns one receipt per transaction, in submission order.
 * @throws {LighterConfigError} when the callback queued nothing; an empty batch is almost always a
 * control-flow bug in the callback rather than an intent to submit nothing.
 * @throws {LighterNonceError} `LEASE_EXHAUSTED` when consecutive slots cannot be obtained on one
 * key — the normal answer from the `server` strategy, which re-reads a counter the sequencer has
 * not advanced yet.
 */
export async function batch(
  ctx: AccountContext,
  fn: (b: BatchContext) => Promise<void> | void,
  opts?: BatchOptions,
): Promise<TxReceipt[]> {
  const lease: NonceLease = await ctx.nonces.lease(opts?.preferKey);
  const apiKeyIndex: number = lease.apiKeyIndex;
  try {
    // The pin's own slot is not used: `sendBatch` allocates the whole run of `N`. Returning it now
    // is what keeps the key's non-reentrant mutex free for that allocation — see the module header.
    lease.rollback();
    lease.release();

    const queue: UnsignedTx[] = [];
    const context: BatchContext = createBatchContext(ctx.tx, apiKeyIndex, queue);
    await fn(context);

    if (queue.length === 0) {
      throw new LighterConfigError(
        "batch() collected no transactions. Build them through the context it hands you — " +
          "`b.tx.createOrder(…)` — or `b.add(tx)` for one built elsewhere",
      );
    }
    return await ctx.sendBatch(queue, { ...opts?.send, preferKey: apiKeyIndex });
  } finally {
    // Idempotent, and unconditional: the guarantee is that no path can skip it.
    lease.release();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** One raw builder, seen generically. */
type Builder = (...args: never[]) => UnsignedTx;

/**
 * The account's builders, wrapped so each call is queued.
 *
 * A `Proxy` cannot be used: `RawTxSurface` is a frozen object, and a `get` trap that returned a
 * function other than the frozen own property violates the proxy invariants and throws at run time.
 * So the surface is copied key by key, and a non-function property is a construction bug rather
 * than something to pass through silently.
 */
function createBatchContext(
  surface: RawTxSurface,
  apiKeyIndex: number,
  queue: UnsignedTx[],
): BatchContext {
  const wrapped: Record<string, Builder> = {};
  const source: Record<string, unknown> = surface as unknown as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    const builder: unknown = source[name];
    if (typeof builder !== "function") {
      throw new LighterConfigError(
        `the raw transaction surface exposes a non-function property ${JSON.stringify(name)}; ` +
          "a batch cannot queue it",
      );
    }
    const fn: Builder = builder as Builder;
    wrapped[name] = (...args: never[]): UnsignedTx => {
      const tx: UnsignedTx = fn(...args);
      queue.push(tx);
      return tx;
    };
  }

  const context: BatchContext = {
    tx: wrapped as unknown as RawTxSurface,
    apiKeyIndex,
    get size(): number {
      return queue.length;
    },
    add<T extends UnsignedTx>(tx: T): T {
      queue.push(tx);
      return tx;
    },
    queued(): readonly UnsignedTx[] {
      return Object.freeze([...queue]);
    },
  };
  return context;
}
