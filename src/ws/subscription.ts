/**
 * `Subscription` — the object a caller holds after `client.subscribe(channels.orderBook(0))`, and
 * the only place in this package where an unbounded producer meets a consumer that may be
 * arbitrarily slow.
 *
 * A market-data socket pushes hundreds of frames a second. A consumer that awaits a database write
 * per frame does not. Something has to give, and the choice of *what* gives is the whole design of
 * this file: an unbounded queue is a memory leak in a long-lived Worker or Durable Object, and the
 * wrong eviction rule silently corrupts an order book. The reference Python client has no
 * equivalent at all — it invokes a user callback inline on the read loop, so a slow consumer stalls
 * the socket and a throwing one kills it (`docs/protocol-notes.md` §10.2,
 * `docs/spec/06-websocket.md` §12.1).
 *
 * ## One buffer, one delivery path
 *
 * `docs/ARCHITECTURE.md` ADR-7 (and `docs/spec/06-websocket.md` §13.5) describe a dual API where
 * callbacks are invoked *before* enqueueing and are therefore never subject to the overflow policy.
 * **`docs/decisions.md` D10 cuts that**, and decisions outrank the architecture. So:
 *
 * - the bounded queue is the single source of events;
 * - `for await (const e of sub)` drains it;
 * - `on(cb)` is sugar — it starts an internal drain loop over the *same* queue;
 * - iteration and `on()` are mutually exclusive, which removes the unspecified
 *   broadcast-versus-work-stealing question entirely;
 * - `snapshot()` resolves from a tap read at {@link SubscriptionController.deliver} time, so it
 *   never consumes an event the iterator would otherwise see.
 *
 * The dual design has a failure mode this one cannot have: a callback-only consumer never touches
 * the queue, so the queue fills and the policy fires even though the consumer is keeping up. Do not
 * "optimise" this back into a push-before-enqueue path.
 *
 * ## Control events are sacred
 *
 * `{ kind: "reset" }` is the only signal that all delta-derived state is void. A consumer that
 * misses one keeps quoting off an order book it believes is synced — the worst bug this file could
 * have. `reset` and `error` are therefore exempt from every overflow policy: when the queue is full
 * and a control event arrives, a *data* event is evicted to make room, and if the queue somehow
 * holds nothing but control events the queue grows past its limit rather than dropping one.
 *
 * ## State owned here (D8)
 *
 * One bounded queue and one set of iterator/callback/snapshot resolvers per instance, living
 * exactly as long as the `Subscription`. Nothing at module scope, no timers, no I/O, no clock read.
 * Side-effect free at import.
 *
 * This module deliberately imports nothing from `./client.js` or `./transport.js`: the client
 * depends on the subscription, never the reverse. Everything the owner must supply arrives through
 * {@link SubscriptionHost}.
 */

import { LighterConfigError } from "../errors.js";
import { LighterWsError, LighterWsOverflowError } from "./errors.js";

export { LighterWsOverflowError };

/* -------------------------------------------------------------------------------------------- */
/* Public shapes                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * What happens when a full queue meets another data event.
 *
 * The per-family default is chosen by the client (`docs/spec/06-websocket.md` §13.6 — `resubscribe`
 * for `order_book`, `coalesce` for whole-state channels, `drop-oldest` for append-only histories);
 * this module never guesses, the policy is always passed explicitly.
 */
export type OverflowPolicy = "drop-oldest" | "drop-newest" | "coalesce" | "resubscribe" | "error";

/**
 * One delivered event.
 *
 * `data` is the decoded payload from the channel's `parseSnapshot`/`parseUpdate`, `raw` is the frame
 * it came from, untouched — nothing here coerces a payload value. Prices and sizes are decimal
 * strings and ids can exceed `Number.MAX_SAFE_INTEGER` (D7, `docs/protocol-notes.md` §8.4), so a
 * numeric conversion anywhere on this path would be lossy.
 */
export type ChannelEvent<S, U> =
  | { kind: "snapshot"; data: S; raw: unknown; receivedAt: number }
  | { kind: "update"; data: U; raw: unknown; receivedAt: number }
  | { kind: "reset"; reason: "reconnect" | "gap" | "crossed" | "auth-refresh" | "resubscribe" }
  | { kind: "error"; code: number; message: string; fatal: boolean };

/**
 * The caller-facing half of a subscription.
 *
 * Consume it with `for await (const e of sub)` **or** with `sub.on(cb)` — never both, and never two
 * of either. The second attempt throws a `TypeError` naming the conflict rather than silently
 * splitting the stream between two consumers.
 *
 * When the host runtime supports explicit resource management, instances also carry
 * `[Symbol.dispose]` and `[Symbol.asyncDispose]` (both close the subscription), attached at runtime
 * — see the note at the bottom of this file for why they are not declared here.
 */
export interface Subscription<S, U> extends AsyncIterable<ChannelEvent<S, U>> {
  /** Canonical outbound slash-form key, e.g. `"order_book/0"`. */
  readonly key: string;
  /** `"pending"` until the server acknowledges, then `"active"`, then `"closed"` — terminal. */
  readonly state: "pending" | "active" | "closed";
  /**
   * Resolves with the first snapshot delivered after the (re)subscribe currently in flight.
   *
   * Read from a tap at delivery time, so awaiting it does not steal the event from the iterator. A
   * `reset` re-arms it: after a resync, `snapshot()` waits for the *next* snapshot rather than
   * handing back the pre-reset one, which is stale by definition.
   */
  snapshot(): Promise<S>;
  /**
   * Callback delivery. Drains the same queue as the iterator; returns an unregister function.
   *
   * Unregistering releases the consumption slot — a later `on()` or `for await` is then allowed.
   * The callback is invoked from an internal drain loop, never synchronously from the socket read
   * loop, and a callback that throws is reported as a `consumer-error` diagnostic without
   * interrupting delivery.
   */
  on(cb: (e: ChannelEvent<S, U>) => void): () => void;
  /** Idempotent, never rejects. Ends iteration cleanly after any already-queued events. */
  close(): Promise<void>;
}

/**
 * Everything the owner (`LighterWsClient`) must provide. Keeps this file free of client imports.
 *
 * Every method may throw without consequence: the calls are wrapped, and a failure surfaces as a
 * `consumer-error` diagnostic rather than escaping into the socket read loop.
 */
export interface SubscriptionHost {
  /**
   * Overflow policy `"resubscribe"`: unsubscribe and resubscribe this channel. Must be idempotent.
   *
   * Called at most once per overflow episode — see the storm note on {@link createSubscription}.
   */
  requestResubscribe(key: string): void;
  /** `close()`: drop the desired-table entry and emit an unsubscribe frame if connected. */
  requestClose(key: string): void | Promise<void>;
  /** Report loss and consumer failures. Must not throw; if it does, the throw is swallowed here. */
  diagnostic(d: SubscriptionDiagnostic): void;
  /**
   * Injectable clock, in ms.
   *
   * Part of the host contract because the client stamps `ChannelEvent.receivedAt` with it and tests
   * build one host object for both halves. This module itself never reads a clock — every decision
   * here is made from queue occupancy alone, which is what keeps it deterministic under test and
   * hibernation-safe in a Durable Object.
   */
  now(): number;
}

/**
 * What was lost, and why.
 *
 * `count` is always incremental — the number of events discarded by the single `deliver()` call
 * that produced the diagnostic — so summing every `dropped` gives the exact total. "No diagnostic"
 * means "nothing was lost"; silent data loss is not a state this module can reach.
 *
 * `overflow` is emitted once per overflow *episode*: on the first discard after the queue fills,
 * and again only after a consumer has drained it back below the limit. It says "the policy is now
 * in effect"; the `dropped` stream says how much it cost.
 */
export type SubscriptionDiagnostic =
  | { kind: "dropped"; key: string; count: number; policy: OverflowPolicy }
  | { kind: "overflow"; key: string; policy: OverflowPolicy; queueLimit: number }
  | { kind: "consumer-error"; key: string; error: unknown };

/** The owner-facing half. The client keeps the controller; the caller gets `controller.subscription`. */
export interface SubscriptionController<S, U> {
  readonly subscription: Subscription<S, U>;
  /**
   * Push one decoded event.
   *
   * **MUST NOT throw, ever** — it is called from the socket read loop, and an exception there takes
   * the connection down with it (defect 6 of the reference client). Every path inside is wrapped;
   * anything unexpected becomes a `consumer-error` diagnostic.
   */
  deliver(event: ChannelEvent<S, U>): void;
  /** `"pending"` → `"active"` when the client sees `subscribed/<family>`. Ignored once closed. */
  setState(state: "pending" | "active"): void;
  /** Terminate iteration, reject pending `snapshot()` waiters, state → `"closed"`. Idempotent. */
  finish(err?: Error): void;
}

/* -------------------------------------------------------------------------------------------- */
/* Internals                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** Default queue capacity (`docs/spec/06-websocket.md` §13.4, `queueLimit`). */
const DEFAULT_QUEUE_LIMIT = 1024;

/** Slots allocated up front. 500 subscriptions × 1024 pre-allocated slots is memory nobody asked for. */
const INITIAL_CAPACITY = 8;

const POLICIES: readonly OverflowPolicy[] = [
  "drop-oldest",
  "drop-newest",
  "coalesce",
  "resubscribe",
  "error",
];

/**
 * Control events carry no payload and cannot be reconstructed from a later frame, which is exactly
 * why no policy may discard one.
 */
function isControlEvent<S, U>(e: ChannelEvent<S, U>): boolean {
  return e.kind === "reset" || e.kind === "error";
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

interface Resolver<T> {
  resolve(value: T): void;
  reject(reason: unknown): void;
}

type Consumption = "none" | "iterator" | "callback";

class SubscriptionImpl<S, U> implements Subscription<S, U> {
  readonly key: string;

  readonly #host: SubscriptionHost;
  readonly #policy: OverflowPolicy;
  readonly #limit: number;

  /** Ring storage. Grows on demand up to `#limit`; `#head` is an index, never `shift()` (O(n)). */
  #ring: (ChannelEvent<S, U> | undefined)[];
  #head = 0;
  #count = 0;

  #state: "pending" | "active" | "closed" = "pending";
  #finished = false;
  #finishError: Error | undefined;

  #mode: Consumption = "none";
  #callbackToken: object | undefined;
  #pending: Resolver<IteratorResult<ChannelEvent<S, U>, undefined>> | undefined;

  #snapshotBox: { value: S } | undefined;
  #snapshotWaiters: Resolver<S>[] = [];

  #droppedTotal = 0;
  #overflowReported = false;
  #resubscribeRequested = false;

  #closePromise: Promise<void> | undefined;
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;

  constructor(init: {
    key: string;
    host: SubscriptionHost;
    overflow: OverflowPolicy;
    queueLimit?: number;
    signal?: AbortSignal;
  }) {
    if (typeof init.key !== "string" || init.key.length === 0) {
      throw new LighterConfigError("subscription key must be a non-empty string", {
        code: "SUBSCRIPTION_OPTION",
      });
    }
    if (!POLICIES.includes(init.overflow)) {
      throw new LighterConfigError(
        `unknown overflow policy ${String(init.overflow)}; expected one of ${POLICIES.join(", ")}`,
        { code: "SUBSCRIPTION_OPTION" },
      );
    }
    const limit = init.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new LighterConfigError("queueLimit must be an integer >= 1", {
        code: "SUBSCRIPTION_OPTION",
      });
    }

    this.key = init.key;
    this.#host = init.host;
    this.#policy = init.overflow;
    this.#limit = limit;
    this.#ring = new Array<ChannelEvent<S, U> | undefined>(
      Math.min(limit, INITIAL_CAPACITY),
    ).fill(undefined);

    if (init.signal !== undefined) {
      this.#signal = init.signal;
      const onAbort = (): void => {
        void this.close();
      };
      this.#onAbort = onAbort;
      init.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  get state(): "pending" | "active" | "closed" {
    return this.#state;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Ring mechanics                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  /** Is the queue at its configured limit? May be false while the ring itself is short. */
  get #full(): boolean {
    return this.#count >= this.#limit;
  }

  #at(i: number): ChannelEvent<S, U> | undefined {
    return this.#ring[(this.#head + i) % this.#ring.length];
  }

  #set(i: number, e: ChannelEvent<S, U> | undefined): void {
    this.#ring[(this.#head + i) % this.#ring.length] = e;
  }

  #grow(next: number): void {
    const out = new Array<ChannelEvent<S, U> | undefined>(next).fill(undefined);
    for (let i = 0; i < this.#count; i++) out[i] = this.#at(i);
    this.#ring = out;
    this.#head = 0;
  }

  /** Append. The caller has already established that there is room (or that growth is warranted). */
  #push(e: ChannelEvent<S, U>): void {
    if (this.#count === this.#ring.length) {
      this.#grow(Math.max(INITIAL_CAPACITY, this.#ring.length * 2));
    }
    this.#set(this.#count, e);
    this.#count++;
  }

  /** Put an event back at the front — used only when a drain loop is unregistered mid-await. */
  #unshift(e: ChannelEvent<S, U>): void {
    if (this.#count === this.#ring.length) {
      this.#grow(Math.max(INITIAL_CAPACITY, this.#ring.length * 2));
    }
    this.#head = (this.#head - 1 + this.#ring.length) % this.#ring.length;
    this.#ring[this.#head] = e;
    this.#count++;
  }

  /** Consumer-facing take. Re-arms the overflow episode once the queue is back under its limit. */
  #take(): ChannelEvent<S, U> | undefined {
    if (this.#count === 0) return undefined;
    const idx = this.#head;
    const e = this.#ring[idx];
    this.#ring[idx] = undefined;
    this.#head = (this.#head + 1) % this.#ring.length;
    this.#count--;
    if (!this.#full) this.#overflowReported = false;
    return e;
  }

  /** Evict the oldest data event, skipping control events. `false` if the queue holds none. */
  #evictOldestData(): boolean {
    for (let i = 0; i < this.#count; i++) {
      const e = this.#at(i);
      if (e === undefined || isControlEvent(e)) continue;
      for (let j = i; j < this.#count - 1; j++) this.#set(j, this.#at(j + 1));
      this.#set(this.#count - 1, undefined);
      this.#count--;
      return true;
    }
    return false;
  }

  /** Remove every data event, keeping control events in their original order. Returns how many went. */
  #clearData(): number {
    let write = 0;
    let removed = 0;
    for (let i = 0; i < this.#count; i++) {
      const e = this.#at(i);
      if (e !== undefined && isControlEvent(e)) {
        this.#set(write, e);
        write++;
      } else {
        removed++;
      }
    }
    for (let i = write; i < this.#count; i++) this.#set(i, undefined);
    this.#count = write;
    return removed;
  }

  #hasData(): boolean {
    for (let i = 0; i < this.#count; i++) {
      const e = this.#at(i);
      if (e !== undefined && !isControlEvent(e)) return true;
    }
    return false;
  }

  #clearQueue(): void {
    this.#ring = new Array<ChannelEvent<S, U> | undefined>(
      Math.min(this.#limit, INITIAL_CAPACITY),
    ).fill(undefined);
    this.#head = 0;
    this.#count = 0;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Diagnostics                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  /** Every host callback goes through here. A throwing diagnostic sink must not become our problem. */
  #diag(d: SubscriptionDiagnostic): void {
    try {
      this.#host.diagnostic(d);
    } catch {
      /* a diagnostic sink that throws is reported nowhere: there is nowhere left to report it. */
    }
  }

  #reportDropped(count: number): void {
    if (count <= 0) return;
    this.#droppedTotal += count;
    this.#diag({ kind: "dropped", key: this.key, count, policy: this.#policy });
  }

  #reportOverflowOnce(): void {
    if (this.#overflowReported) return;
    this.#overflowReported = true;
    this.#diag({
      kind: "overflow",
      key: this.key,
      policy: this.#policy,
      queueLimit: this.#limit,
    });
  }

  #reportConsumerError(error: unknown): void {
    this.#diag({ kind: "consumer-error", key: this.key, error });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Delivery                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /** Never throws. See {@link SubscriptionController.deliver}. */
  deliver(event: ChannelEvent<S, U>): void {
    try {
      this.#deliver(event);
    } catch (err) {
      this.#reportConsumerError(err);
    }
  }

  #deliver(event: ChannelEvent<S, U>): void {
    if (this.#finished) return;

    // The snapshot tap is read before anything queue-related, so `snapshot()` resolves even when
    // the very same event is about to be dropped by the policy — and so that a `reset` re-arms it
    // whether or not a consumer ever drains.
    if (event.kind === "snapshot") {
      this.#snapshotBox = { value: event.data };
      this.#resubscribeRequested = false;
      const waiters = this.#snapshotWaiters;
      if (waiters.length > 0) {
        this.#snapshotWaiters = [];
        for (const w of waiters) w.resolve(event.data);
      }
    } else if (event.kind === "reset") {
      this.#snapshotBox = undefined;
    }

    // Hand-off: a waiting consumer means the queue is empty, so this bypasses it entirely. The
    // resolver is a promise resolution, never a synchronous re-entry into the read loop.
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      pending.resolve({ value: event, done: false });
      return;
    }

    if (!this.#full) {
      this.#push(event);
      return;
    }

    if (isControlEvent(event)) {
      // Never dropped, never coalesced, under any policy. Make room by evicting a data event; if
      // there is no data event to evict, exceed the limit rather than lose the control signal.
      if (this.#evictOldestData()) {
        this.#reportOverflowOnce();
        this.#reportDropped(1);
      }
      this.#push(event);
      return;
    }

    this.#overflow(event);
  }

  #overflow(event: ChannelEvent<S, U>): void {
    this.#reportOverflowOnce();

    // A queue full of nothing but control events has nothing the policy could evict, so the
    // incoming data event is discarded regardless of what the policy says.
    if (!this.#hasData()) {
      this.#reportDropped(1);
      return;
    }

    switch (this.#policy) {
      case "drop-oldest": {
        this.#evictOldestData();
        this.#push(event);
        this.#reportDropped(1);
        return;
      }
      case "drop-newest": {
        this.#reportDropped(1);
        return;
      }
      case "coalesce": {
        // Collapse to at most one pending data event: the newest. Control events keep their order,
        // and the incoming event lands after them, which is also its true temporal position.
        const removed = this.#clearData();
        this.#push(event);
        this.#reportDropped(removed);
        return;
      }
      case "resubscribe": {
        if (this.#resubscribeRequested) {
          // Suppressed until the next snapshot: firing again would emit unsubscribe/subscribe pairs
          // at frame rate, tripping server codes 30003 (Already Subscribed) and 30009 (Too Many
          // Websocket Messages!). Queueing another `reset` per frame would be just as bad, since
          // control events cannot be dropped — so behave as `drop-newest` until the resync lands.
          this.#reportDropped(1);
          return;
        }
        const removed = this.#clearData();
        this.#push({ kind: "reset", reason: "resubscribe" });
        this.#reportDropped(removed + 1);
        this.#resubscribeRequested = true;
        this.#host.requestResubscribe(this.key);
        return;
      }
      case "error": {
        const lost = this.#count + 1;
        this.finish(
          new LighterWsOverflowError(
            `subscription ${this.key} overflowed its ${this.#limit}-event queue`,
            { dropped: this.#droppedTotal + lost, channel: this.key },
          ),
        );
        return;
      }
    }
  }

  setState(state: "pending" | "active"): void {
    if (this.#state === "closed") return;
    this.#state = state;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Consumption                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  #closedError(): LighterWsError {
    return new LighterWsError(`subscription ${this.key} is closed`, {
      wsKind: "closed",
      channel: this.key,
    });
  }

  /** The single pull path, shared by the iterator and the `on()` drain loop. */
  #pull(): Promise<IteratorResult<ChannelEvent<S, U>, undefined>> {
    const queued = this.#take();
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
    if (this.#finished) {
      if (this.#finishError !== undefined) return Promise.reject(this.#finishError);
      return Promise.resolve({ value: undefined, done: true });
    }
    if (this.#pending !== undefined) {
      return Promise.reject(
        new TypeError(
          `subscription ${this.key}: concurrent next() on one subscription; await the previous result first`,
        ),
      );
    }
    return new Promise<IteratorResult<ChannelEvent<S, U>, undefined>>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<ChannelEvent<S, U>, undefined> {
    if (this.#mode === "iterator") {
      throw new TypeError(
        `subscription ${this.key}: already being iterated; one subscription has one consumer`,
      );
    }
    if (this.#mode === "callback") {
      throw new TypeError(
        `subscription ${this.key}: cannot iterate while an on() callback is registered; unregister it first`,
      );
    }
    this.#mode = "iterator";
    const release = (): void => {
      if (this.#mode === "iterator") this.#mode = "none";
    };
    return {
      next: (): Promise<IteratorResult<ChannelEvent<S, U>, undefined>> => this.#pull(),
      return: (): Promise<IteratorResult<ChannelEvent<S, U>, undefined>> => {
        // `break` out of a `for await` releases the consumption slot but does **not** close the
        // subscription: closing is an explicit act (`close()`, `signal.abort()`, disposal).
        release();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (e?: unknown): Promise<IteratorResult<ChannelEvent<S, U>, undefined>> => {
        release();
        return Promise.reject(e);
      },
    };
  }

  on(cb: (e: ChannelEvent<S, U>) => void): () => void {
    if (typeof cb !== "function") {
      throw new TypeError(`subscription ${this.key}: on() expects a function`);
    }
    if (this.#mode === "iterator") {
      throw new TypeError(
        `subscription ${this.key}: cannot register on() while the subscription is being iterated`,
      );
    }
    if (this.#mode === "callback") {
      throw new TypeError(
        `subscription ${this.key}: a callback is already registered; one subscription has one consumer`,
      );
    }
    this.#mode = "callback";
    const token = {};
    this.#callbackToken = token;
    void this.#drain(cb, token);
    return (): void => {
      if (this.#callbackToken !== token) return;
      this.#callbackToken = undefined;
      this.#mode = "none";
      const pending = this.#pending;
      if (pending !== undefined) {
        this.#pending = undefined;
        pending.resolve({ value: undefined, done: true });
      }
    };
  }

  async #drain(cb: (e: ChannelEvent<S, U>) => void, token: object): Promise<void> {
    while (this.#callbackToken === token) {
      let result: IteratorResult<ChannelEvent<S, U>, undefined>;
      try {
        result = await this.#pull();
      } catch {
        // `finish(err)` — the subscription died. A callback consumer sees `state === "closed"`, and
        // the failure was already announced through the diagnostic stream that preceded it.
        return;
      }
      if (result.done === true) return;
      if (this.#callbackToken !== token) {
        // Unregistered while this pull was in flight: give the event back rather than lose it.
        this.#unshift(result.value);
        return;
      }
      try {
        cb(result.value);
      } catch (err) {
        this.#reportConsumerError(err);
      }
    }
  }

  snapshot(): Promise<S> {
    const box = this.#snapshotBox;
    if (box !== undefined) return Promise.resolve(box.value);
    if (this.#finished) return Promise.reject(this.#finishError ?? this.#closedError());
    return new Promise<S>((resolve, reject) => {
      this.#snapshotWaiters.push({ resolve, reject });
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Lifecycle                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#startClose();
    return this.#closePromise;
  }

  /**
   * `state` becomes `"closed"` synchronously; the returned promise settles when the host has done
   * whatever it does about the unsubscribe frame. It never rejects — a host failure is a
   * diagnostic, not something the caller of `close()` can act on.
   */
  #startClose(): Promise<void> {
    let settled: Promise<void> = Promise.resolve();
    try {
      const r = this.#host.requestClose(this.key);
      if (isThenable(r)) {
        settled = Promise.resolve(r).then(
          () => undefined,
          (err: unknown) => {
            this.#reportConsumerError(err);
          },
        );
      }
    } catch (err) {
      this.#reportConsumerError(err);
    }
    this.finish();
    return settled;
  }

  finish(err?: Error): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#state = "closed";
    if (err !== undefined) this.#finishError = err;

    const signal = this.#signal;
    const onAbort = this.#onAbort;
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    this.#signal = undefined;
    this.#onAbort = undefined;

    const waiters = this.#snapshotWaiters;
    this.#snapshotWaiters = [];
    if (waiters.length > 0) {
      const reason = err ?? this.#closedError();
      for (const w of waiters) w.reject(reason);
    }

    const pending = this.#pending;
    this.#pending = undefined;
    if (err !== undefined) {
      // A failed subscription's queue is stale by construction — an overflow means the tail of the
      // stream is already incoherent. Drop it and surface the error on the next pull.
      this.#clearQueue();
      if (pending !== undefined) pending.reject(err);
      return;
    }
    // Graceful: anything already queued still gets delivered, then `done: true`. A pending pull
    // implies an empty queue, so there is nothing left to hand it.
    if (pending !== undefined) pending.resolve({ value: undefined, done: true });
  }

  /**
   * Backing methods for `Symbol.dispose` / `Symbol.asyncDispose`.
   *
   * They live in the class body because the disposal methods are attached from module scope with
   * `Object.defineProperty` (see below) and a function defined out there cannot touch `#` fields.
   */
  disposeSync(): void {
    void this.close();
  }

  disposeAsync(): Promise<void> {
    return this.close();
  }
}

/*
 * Explicit resource management, attached defensively.
 *
 * `Symbol.dispose` and `Symbol.asyncDispose` are `undefined` on Node 20 and on older Safari. A class
 * body containing a computed `[Symbol.dispose]()` member throws
 * `TypeError: Cannot convert undefined to a property key` at **import** time there, which takes the
 * whole package down on a runtime we advertise support for. So the symbols are read defensively and
 * the methods attached only when they exist.
 *
 * Note what is *not* done here: `Symbol.dispose ??= Symbol(...)`. Mutating a global at module scope
 * is an import side effect, and this package ships `"sideEffects": false`. Defining a property on
 * our own class is not observable outside this module.
 *
 * The methods are absent from the {@link Subscription} interface on purpose — declaring them would
 * promise a capability that does not exist on every supported runtime. On a runtime that has them,
 * `using sub = ...` works; elsewhere, call `close()`.
 */
const disposeSym: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
if (typeof disposeSym === "symbol") {
  Object.defineProperty(SubscriptionImpl.prototype, disposeSym, {
    value: function dispose(this: SubscriptionImpl<unknown, unknown>): void {
      this.disposeSync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

const asyncDisposeSym: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
if (typeof asyncDisposeSym === "symbol") {
  Object.defineProperty(SubscriptionImpl.prototype, asyncDisposeSym, {
    value: function asyncDispose(this: SubscriptionImpl<unknown, unknown>): Promise<void> {
      return this.disposeAsync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Construction                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Build one subscription and the controller half its owner drives.
 *
 * The caller gets `controller.subscription`; the client keeps the controller and is the only thing
 * that may `deliver`, `setState` or `finish`.
 *
 * `overflow` is always explicit — the per-family default belongs to the client, which is the only
 * layer that knows whether this key is an order book (a dropped delta breaks the chain, so
 * `resubscribe`) or a ticker (each message is complete state, so `coalesce`).
 *
 * An already-aborted `signal` closes the subscription on the next microtask rather than during
 * construction, so the client can finish registering it before `requestClose` arrives.
 */
export function createSubscription<S, U>(init: {
  key: string;
  host: SubscriptionHost;
  overflow: OverflowPolicy;
  queueLimit?: number;
  signal?: AbortSignal;
}): SubscriptionController<S, U> {
  const impl = new SubscriptionImpl<S, U>(init);

  if (init.signal?.aborted === true) {
    queueMicrotask(() => {
      void impl.close();
    });
  }

  return {
    subscription: impl,
    deliver: (event: ChannelEvent<S, U>): void => {
      impl.deliver(event);
    },
    setState: (state: "pending" | "active"): void => {
      impl.setState(state);
    },
    finish: (err?: Error): void => {
      impl.finish(err);
    },
  };
}
