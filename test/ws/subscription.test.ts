/**
 * `Subscription` — bounded queue, five overflow policies, one consumer.
 *
 * The interesting assertions here are the ones about *loss*: which events survive a full queue,
 * which are discarded, and whether the discard was reported. A silent drop is the failure this file
 * exists to catch, so every policy test asserts the exact resulting queue contents **and** the exact
 * diagnostics, not just one of the two.
 *
 * Queue contents are read by calling `controller.finish()` (a graceful finish keeps whatever is
 * queued) and then draining the iterator to completion — that is the only honest way to observe the
 * queue, since the subscription deliberately exposes no length.
 *
 * No network, no timers, no clock: `deliver()` is driven by hand and every decision the code makes
 * is a function of queue occupancy alone.
 */

import { describe, expect, test } from "bun:test";

import { LighterWsOverflowError, createSubscription } from "../../src/ws/subscription.js";
import type {
  ChannelEvent,
  OverflowPolicy,
  SubscriptionController,
  SubscriptionDiagnostic,
  SubscriptionHost,
} from "../../src/ws/subscription.js";

/* -------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                       */
/* -------------------------------------------------------------------------------------------- */

interface Snap {
  readonly snap: string;
}
interface Upd {
  readonly seq: number;
}

type Ev = ChannelEvent<Snap, Upd>;

const KEY = "order_book/0";

function upd(seq: number): Ev {
  return { kind: "update", data: { seq }, raw: { seq }, receivedAt: seq };
}
function snap(name: string): Ev {
  return { kind: "snapshot", data: { snap: name }, raw: { name }, receivedAt: 1 };
}
function reset(reason: "reconnect" | "gap" | "crossed" | "auth-refresh" | "resubscribe"): Ev {
  return { kind: "reset", reason };
}
function errEvent(code = 30004, fatal = false): Ev {
  return { kind: "error", code, message: "Failed to fetch", fatal };
}

interface Recorder {
  readonly host: SubscriptionHost;
  readonly diags: SubscriptionDiagnostic[];
  readonly resubscribes: string[];
  readonly closes: string[];
}

function recorder(over: Partial<SubscriptionHost> = {}): Recorder {
  const diags: SubscriptionDiagnostic[] = [];
  const resubscribes: string[] = [];
  const closes: string[] = [];
  const host: SubscriptionHost = {
    requestResubscribe(key) {
      resubscribes.push(key);
    },
    requestClose(key) {
      closes.push(key);
    },
    diagnostic(d) {
      diags.push(d);
    },
    now() {
      return 0;
    },
    ...over,
  };
  return { host, diags, resubscribes, closes };
}

function make(
  policy: OverflowPolicy,
  queueLimit?: number,
  extra: { signal?: AbortSignal; host?: SubscriptionHost } = {},
): { ctrl: SubscriptionController<Snap, Upd>; rec: Recorder } {
  const rec = recorder();
  const init: {
    key: string;
    host: SubscriptionHost;
    overflow: OverflowPolicy;
    queueLimit?: number;
    signal?: AbortSignal;
  } = { key: KEY, host: extra.host ?? rec.host, overflow: policy };
  if (queueLimit !== undefined) init.queueLimit = queueLimit;
  if (extra.signal !== undefined) init.signal = extra.signal;
  return { ctrl: createSubscription<Snap, Upd>(init), rec };
}

/** Everything still queued, in order. Ends the subscription, so call it last. */
async function drain(ctrl: SubscriptionController<Snap, Upd>): Promise<Ev[]> {
  ctrl.finish();
  const out: Ev[] = [];
  for await (const e of ctrl.subscription) out.push(e);
  return out;
}

/** Flush the microtask queue (the `on()` drain loop advances one event per microtask). */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function dropped(rec: Recorder): number {
  let total = 0;
  for (const d of rec.diags) if (d.kind === "dropped") total += d.count;
  return total;
}

function kinds(events: readonly Ev[]): string[] {
  return events.map((e) => (e.kind === "update" ? `update:${String(e.data.seq)}` : e.kind));
}

/* -------------------------------------------------------------------------------------------- */
/* Shape and identity                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe("basics", () => {
  test("starts pending with the given key and moves through the lifecycle", async () => {
    const { ctrl } = make("drop-oldest");
    expect(ctrl.subscription.key).toBe(KEY);
    expect(ctrl.subscription.state).toBe("pending");
    ctrl.setState("active");
    expect(ctrl.subscription.state).toBe("active");
    await ctrl.subscription.close();
    expect(ctrl.subscription.state).toBe("closed");
    // setState after close is ignored — closed is terminal.
    ctrl.setState("active");
    expect(ctrl.subscription.state).toBe("closed");
  });

  test("rejects an unknown policy and a nonsense queueLimit", () => {
    const rec = recorder();
    expect(() =>
      createSubscription<Snap, Upd>({
        key: KEY,
        host: rec.host,
        overflow: "nope" as OverflowPolicy,
      }),
    ).toThrow(/unknown overflow policy/);
    expect(() =>
      createSubscription<Snap, Upd>({
        key: KEY,
        host: rec.host,
        overflow: "drop-oldest",
        queueLimit: 0,
      }),
    ).toThrow(/queueLimit/);
    expect(() =>
      createSubscription<Snap, Upd>({ key: "", host: rec.host, overflow: "drop-oldest" }),
    ).toThrow(/non-empty string/);
  });

  test("iteration yields events in delivery order", async () => {
    const { ctrl } = make("drop-oldest", 8);
    ctrl.deliver(snap("a"));
    ctrl.deliver(upd(1));
    ctrl.deliver(reset("gap"));
    ctrl.deliver(upd(2));
    expect(kinds(await drain(ctrl))).toEqual(["snapshot", "update:1", "reset", "update:2"]);
  });

  test("payloads and raw frames pass through by identity — nothing is coerced", async () => {
    const { ctrl } = make("drop-oldest", 4);
    const raw = { price: "1234.567890123456789", id: "9007199254740993" };
    const data = { seq: 7 };
    ctrl.deliver({ kind: "update", data, raw, receivedAt: 42 });
    const [only] = await drain(ctrl);
    expect(only?.kind).toBe("update");
    if (only?.kind !== "update") throw new Error("unreachable");
    expect(only.data).toBe(data);
    expect(only.raw).toBe(raw);
    expect(only.receivedAt).toBe(42);
  });

  test("events delivered after close are ignored", async () => {
    const { ctrl } = make("drop-oldest", 4);
    await ctrl.subscription.close();
    ctrl.deliver(upd(1));
    const out: Ev[] = [];
    for await (const e of ctrl.subscription) out.push(e);
    expect(out).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* One consumer                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe("consumption is exclusive", () => {
  test("a second concurrent iterator throws TypeError", () => {
    const { ctrl } = make("drop-oldest", 4);
    void ctrl.subscription[Symbol.asyncIterator]();
    expect(() => ctrl.subscription[Symbol.asyncIterator]()).toThrow(TypeError);
    expect(() => ctrl.subscription[Symbol.asyncIterator]()).toThrow(/already being iterated/);
  });

  test("on() after iteration begins throws TypeError", () => {
    const { ctrl } = make("drop-oldest", 4);
    void ctrl.subscription[Symbol.asyncIterator]();
    expect(() =>
      ctrl.subscription.on(() => {
        /* unreachable */
      }),
    ).toThrow(/while the subscription is being iterated/);
  });

  test("iteration after on() throws TypeError, and a second on() throws too", () => {
    const { ctrl } = make("drop-oldest", 4);
    ctrl.subscription.on(() => {
      /* keeps the slot */
    });
    expect(() => ctrl.subscription[Symbol.asyncIterator]()).toThrow(TypeError);
    expect(() => ctrl.subscription[Symbol.asyncIterator]()).toThrow(/on\(\) callback is registered/);
    expect(() =>
      ctrl.subscription.on(() => {
        /* unreachable */
      }),
    ).toThrow(/callback is already registered/);
  });

  test("unregistering a callback releases the slot", async () => {
    const { ctrl } = make("drop-oldest", 4);
    const off = ctrl.subscription.on(() => {
      /* nothing */
    });
    off();
    await tick();
    expect(() => ctrl.subscription[Symbol.asyncIterator]()).not.toThrow();
  });

  test("breaking out of a for-await releases the slot without closing", async () => {
    const { ctrl } = make("drop-oldest", 4);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    for await (const e of ctrl.subscription) {
      expect(e.kind).toBe("update");
      break;
    }
    expect(ctrl.subscription.state).toBe("pending");
    // The slot is free again and the untouched event is still queued.
    expect(kinds(await drain(ctrl))).toEqual(["update:2"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Backpressure                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe("bounded queue", () => {
  test("100 000 events against no consumer stay inside the limit and are fully accounted for", async () => {
    const { ctrl, rec } = make("drop-oldest");
    for (let i = 0; i < 100_000; i++) ctrl.deliver(upd(i));
    const queued = await drain(ctrl);
    expect(queued.length).toBe(1024);
    expect(dropped(rec)).toBe(100_000 - 1024);
    // The survivors are the newest 1024, still in order.
    expect(queued[0]).toEqual(upd(100_000 - 1024));
    expect(queued[1023]).toEqual(upd(99_999));
    // One overflow episode: the queue never drained below the limit.
    expect(rec.diags.filter((d) => d.kind === "overflow").length).toBe(1);
  });

  test("an overflow episode re-arms once a consumer catches up", async () => {
    const { ctrl, rec } = make("drop-oldest", 2);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3)); // overflow #1
    const it = ctrl.subscription[Symbol.asyncIterator]();
    await it.next();
    await it.next(); // queue empty again
    ctrl.deliver(upd(4));
    ctrl.deliver(upd(5));
    ctrl.deliver(upd(6)); // overflow #2
    expect(rec.diags.filter((d) => d.kind === "overflow").length).toBe(2);
  });
});

describe("overflow policies", () => {
  test("drop-oldest evicts the oldest data event and reports one drop", async () => {
    const { ctrl, rec } = make("drop-oldest", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3));
    ctrl.deliver(upd(4));
    expect(kinds(await drain(ctrl))).toEqual(["update:2", "update:3", "update:4"]);
    expect(rec.diags).toEqual([
      { kind: "overflow", key: KEY, policy: "drop-oldest", queueLimit: 3 },
      { kind: "dropped", key: KEY, count: 1, policy: "drop-oldest" },
    ]);
  });

  test("drop-newest discards the incoming event", async () => {
    const { ctrl, rec } = make("drop-newest", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3));
    ctrl.deliver(upd(4));
    expect(kinds(await drain(ctrl))).toEqual(["update:1", "update:2", "update:3"]);
    expect(rec.diags).toEqual([
      { kind: "overflow", key: KEY, policy: "drop-newest", queueLimit: 3 },
      { kind: "dropped", key: KEY, count: 1, policy: "drop-newest" },
    ]);
  });

  test("coalesce collapses to the single newest data event", async () => {
    const { ctrl, rec } = make("coalesce", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3));
    ctrl.deliver(upd(4));
    expect(kinds(await drain(ctrl))).toEqual(["update:4"]);
    expect(rec.diags).toEqual([
      { kind: "overflow", key: KEY, policy: "coalesce", queueLimit: 3 },
      { kind: "dropped", key: KEY, count: 3, policy: "coalesce" },
    ]);
  });

  test("coalesce keeps control events and their order", async () => {
    const { ctrl } = make("coalesce", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(reset("gap"));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3)); // full -> collapse
    expect(kinds(await drain(ctrl))).toEqual(["reset", "update:3"]);
  });

  test("resubscribe clears data, queues one reset, and asks the host exactly once", async () => {
    const { ctrl, rec } = make("resubscribe", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3));
    ctrl.deliver(upd(4));
    expect(rec.resubscribes).toEqual([KEY]);
    expect(kinds(await drain(ctrl))).toEqual(["reset"]);
    expect(rec.diags).toEqual([
      { kind: "overflow", key: KEY, policy: "resubscribe", queueLimit: 3 },
      // three cleared from the queue plus the incoming one
      { kind: "dropped", key: KEY, count: 4, policy: "resubscribe" },
    ]);
  });

  test("error closes the subscription and carries the drop count", async () => {
    const { ctrl, rec } = make("error", 3);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    ctrl.deliver(upd(3));
    ctrl.deliver(upd(4)); // overflow -> finish(err)
    expect(ctrl.subscription.state).toBe("closed");
    expect(rec.diags).toEqual([
      { kind: "overflow", key: KEY, policy: "error", queueLimit: 3 },
    ]);
    let caught: unknown;
    try {
      for await (const _e of ctrl.subscription) {
        throw new Error("should not yield");
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LighterWsOverflowError);
    expect((caught as LighterWsOverflowError).dropped).toBe(4);
    expect((caught as LighterWsOverflowError).channel).toBe(KEY);
    expect((caught as LighterWsOverflowError).wsKind).toBe("overflow");
  });

  test("resubscribe fires again only after the next snapshot", async () => {
    const { ctrl, rec } = make("resubscribe", 2);
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    for (let i = 3; i < 20; i++) ctrl.deliver(upd(i)); // overflow, then suppressed
    expect(rec.resubscribes).toEqual([KEY]);

    // Drain the queued reset so the queue has room, then let the resync land.
    const it = ctrl.subscription[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.kind).toBe("reset");
    ctrl.deliver(snap("resynced"));
    expect(rec.resubscribes).toEqual([KEY]);

    // A fresh overflow after the snapshot fires again.
    ctrl.deliver(upd(30));
    ctrl.deliver(upd(31));
    expect(rec.resubscribes).toEqual([KEY, KEY]);
  });

  test("a host that throws from requestResubscribe does not throw out of deliver()", () => {
    const rec = recorder({
      requestResubscribe() {
        throw new Error("host exploded");
      },
    });
    const { ctrl } = make("resubscribe", 2, { host: rec.host });
    ctrl.deliver(upd(1));
    ctrl.deliver(upd(2));
    expect(() => {
      ctrl.deliver(upd(3));
    }).not.toThrow();
    expect(rec.diags.some((d) => d.kind === "consumer-error")).toBe(true);
  });

  test("a host that throws from diagnostic() does not throw out of deliver()", () => {
    const host: SubscriptionHost = {
      requestResubscribe() {
        /* nothing */
      },
      requestClose() {
        /* nothing */
      },
      diagnostic() {
        throw new Error("sink exploded");
      },
      now() {
        return 0;
      },
    };
    const { ctrl } = make("drop-oldest", 1, { host });
    expect(() => {
      ctrl.deliver(upd(1));
      ctrl.deliver(upd(2));
    }).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Control events survive everything                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("control events are never dropped", () => {
  const policies: OverflowPolicy[] = [
    "drop-oldest",
    "drop-newest",
    "coalesce",
    "resubscribe",
    "error",
  ];

  for (const policy of policies) {
    test(`${policy}: a reset arriving at a full queue survives`, async () => {
      const { ctrl, rec } = make(policy, 3);
      ctrl.deliver(upd(1));
      ctrl.deliver(upd(2));
      ctrl.deliver(upd(3));
      ctrl.deliver(reset("reconnect"));
      expect(ctrl.subscription.state).toBe("pending"); // even `error` does not fire on a control event
      const out = await drain(ctrl);
      expect(kinds(out)).toEqual(["update:2", "update:3", "reset"]);
      expect(dropped(rec)).toBe(1); // the evicted data event, reported
    });

    test(`${policy}: an error event arriving at a full queue survives`, async () => {
      const { ctrl } = make(policy, 2);
      ctrl.deliver(upd(1));
      ctrl.deliver(upd(2));
      ctrl.deliver(errEvent(30012, true));
      const out = await drain(ctrl);
      expect(kinds(out)).toEqual(["update:2", "error"]);
    });
  }

  test("a queue holding only control events grows rather than losing one", async () => {
    const { ctrl, rec } = make("drop-oldest", 2);
    ctrl.deliver(reset("gap"));
    ctrl.deliver(reset("crossed"));
    ctrl.deliver(reset("reconnect"));
    ctrl.deliver(errEvent());
    expect(kinds(await drain(ctrl))).toEqual(["reset", "reset", "reset", "error"]);
    expect(dropped(rec)).toBe(0); // nothing was lost, so nothing is reported
  });

  test("a data event meeting an all-control full queue is discarded whatever the policy says", async () => {
    const { ctrl, rec } = make("coalesce", 2);
    ctrl.deliver(reset("gap"));
    ctrl.deliver(reset("crossed"));
    ctrl.deliver(upd(1));
    expect(kinds(await drain(ctrl))).toEqual(["reset", "reset"]);
    expect(dropped(rec)).toBe(1);
    expect(rec.diags.filter((d) => d.kind === "overflow").length).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Callback delivery                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe("on()", () => {
  test("drains the same queue and keeps going after a throwing callback", async () => {
    const { ctrl, rec } = make("drop-oldest", 8);
    const seen: string[] = [];
    ctrl.subscription.on((e) => {
      if (e.kind === "update" && e.data.seq === 2) throw new Error("consumer exploded");
      seen.push(e.kind === "update" ? `update:${String(e.data.seq)}` : e.kind);
    });
    expect(() => {
      ctrl.deliver(upd(1));
      ctrl.deliver(upd(2));
      ctrl.deliver(upd(3));
      ctrl.deliver(reset("gap"));
    }).not.toThrow();
    await tick();
    expect(seen).toEqual(["update:1", "update:3", "reset"]);
    const consumerErrors = rec.diags.filter((d) => d.kind === "consumer-error");
    expect(consumerErrors.length).toBe(1);
    expect((consumerErrors[0] as { error: Error }).error.message).toBe("consumer exploded");
  });

  test("a slow callback consumer is still subject to the policy", async () => {
    const { ctrl, rec } = make("drop-oldest", 4);
    const seen: number[] = [];
    ctrl.subscription.on((e) => {
      if (e.kind === "update") seen.push(e.data.seq);
    });
    // Delivered synchronously: the drain loop never gets a turn, so the queue fills.
    for (let i = 0; i < 20; i++) ctrl.deliver(upd(i));
    await tick();
    expect(dropped(rec)).toBe(20 - 4 - 1); // one went straight to the waiting loop
    expect(seen.length).toBe(5);
  });

  test("unregistering mid-flight does not lose the in-flight event", async () => {
    const { ctrl } = make("drop-oldest", 8);
    const seen: number[] = [];
    const off = ctrl.subscription.on((e) => {
      if (e.kind === "update") seen.push(e.data.seq);
    });
    ctrl.deliver(upd(1)); // handed straight to the waiting drain loop
    off(); // ...and unregistered before it resumes
    await tick();
    expect(seen).toEqual([]);
    expect(kinds(await drain(ctrl))).toEqual(["update:1"]);
  });

  test("a callback consumer stops when the subscription is closed", async () => {
    const { ctrl } = make("drop-oldest", 8);
    const seen: string[] = [];
    ctrl.subscription.on((e) => seen.push(e.kind));
    ctrl.deliver(upd(1));
    await tick();
    await ctrl.subscription.close();
    ctrl.deliver(upd(2));
    await tick();
    expect(seen).toEqual(["update"]);
    expect(ctrl.subscription.state).toBe("closed");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* snapshot()                                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe("snapshot()", () => {
  test("resolves with the first snapshot after arming, without consuming it", async () => {
    const { ctrl } = make("drop-oldest", 8);
    const armed = ctrl.subscription.snapshot();
    ctrl.deliver(snap("first"));
    ctrl.deliver(upd(1));
    expect(await armed).toEqual({ snap: "first" });
    // A later call sees the same snapshot, and the iterator still gets both events.
    expect(await ctrl.subscription.snapshot()).toEqual({ snap: "first" });
    expect(kinds(await drain(ctrl))).toEqual(["snapshot", "update:1"]);
  });

  test("re-arms after a reset", async () => {
    const { ctrl } = make("drop-oldest", 8);
    ctrl.deliver(snap("first"));
    expect(await ctrl.subscription.snapshot()).toEqual({ snap: "first" });
    ctrl.deliver(reset("reconnect"));

    let settled = false;
    const pending = ctrl.subscription.snapshot().then((s) => {
      settled = true;
      return s;
    });
    await tick();
    expect(settled).toBe(false); // the pre-reset snapshot is stale and must not be handed back
    ctrl.deliver(snap("second"));
    expect(await pending).toEqual({ snap: "second" });
  });

  test("resolves even when the snapshot event itself is dropped by the policy", async () => {
    const { ctrl, rec } = make("drop-newest", 1);
    ctrl.deliver(upd(1)); // queue full
    const armed = ctrl.subscription.snapshot();
    ctrl.deliver(snap("late")); // discarded from the queue...
    expect(await armed).toEqual({ snap: "late" }); // ...but the tap still saw it
    expect(dropped(rec)).toBe(1);
    expect(kinds(await drain(ctrl))).toEqual(["update:1"]);
  });

  test("rejects when finish(err) is called, and after close()", async () => {
    const { ctrl } = make("drop-oldest", 8);
    const pending = ctrl.subscription.snapshot();
    const boom = new Error("socket died");
    ctrl.finish(boom);
    await expect(pending).rejects.toThrow("socket died");
    await expect(ctrl.subscription.snapshot()).rejects.toThrow("socket died");

    const second = make("drop-oldest", 8);
    const p2 = second.ctrl.subscription.snapshot();
    await second.ctrl.subscription.close();
    await expect(p2).rejects.toThrow(/is closed/);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Lifecycle                                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe("close and abort", () => {
  test("close() is idempotent, asks the host once, and ends iteration cleanly", async () => {
    const { ctrl, rec } = make("drop-oldest", 8);
    const it = ctrl.subscription[Symbol.asyncIterator]();
    const inflight = it.next();
    await ctrl.subscription.close();
    await ctrl.subscription.close();
    await ctrl.subscription.close();
    expect(rec.closes).toEqual([KEY]);
    expect(ctrl.subscription.state).toBe("closed");
    const r = await inflight;
    expect(r.done).toBe(true);
    expect(r.value).toBeUndefined();
    expect((await it.next()).done).toBe(true);
  });

  test("close() delivers what is already queued before ending", async () => {
    const { ctrl } = make("drop-oldest", 8);
    ctrl.deliver(upd(1));
    ctrl.deliver(reset("gap"));
    await ctrl.subscription.close();
    const out: Ev[] = [];
    for await (const e of ctrl.subscription) out.push(e);
    expect(kinds(out)).toEqual(["update:1", "reset"]);
  });

  test("close() never rejects when the host fails", async () => {
    const rec = recorder({
      requestClose() {
        return Promise.reject(new Error("send failed"));
      },
    });
    const { ctrl } = make("drop-oldest", 8, { host: rec.host });
    await ctrl.subscription.close();
    expect(ctrl.subscription.state).toBe("closed");
    expect(rec.diags.some((d) => d.kind === "consumer-error")).toBe(true);
  });

  test("close() never rejects when the host throws synchronously", async () => {
    const rec = recorder({
      requestClose() {
        throw new Error("not connected");
      },
    });
    const { ctrl } = make("drop-oldest", 8, { host: rec.host });
    await ctrl.subscription.close();
    expect(ctrl.subscription.state).toBe("closed");
  });

  test("abort behaves exactly like close()", async () => {
    const ac = new AbortController();
    const { ctrl, rec } = make("drop-oldest", 8, { signal: ac.signal });
    ctrl.deliver(upd(1));
    ac.abort();
    await tick();
    expect(ctrl.subscription.state).toBe("closed");
    expect(rec.closes).toEqual([KEY]);
    const out: Ev[] = [];
    for await (const e of ctrl.subscription) out.push(e);
    expect(kinds(out)).toEqual(["update:1"]);
    // Aborting again changes nothing.
    ac.abort();
    await tick();
    expect(rec.closes).toEqual([KEY]);
  });

  test("an already-aborted signal closes on the next microtask", async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctrl, rec } = make("drop-oldest", 8, { signal: ac.signal });
    expect(ctrl.subscription.state).toBe("pending"); // not during construction
    await tick();
    expect(ctrl.subscription.state).toBe("closed");
    expect(rec.closes).toEqual([KEY]);
  });

  test("finish() is idempotent and the first error wins", async () => {
    const { ctrl } = make("drop-oldest", 8);
    ctrl.finish(new Error("first"));
    ctrl.finish(new Error("second"));
    await expect(ctrl.subscription.snapshot()).rejects.toThrow("first");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Disposal on runtimes that lack the symbols                                                     */
/* -------------------------------------------------------------------------------------------- */

describe("explicit resource management", () => {
  test("dispose methods are attached where the symbols exist", async () => {
    const { ctrl, rec } = make("drop-oldest", 8);
    const sub = ctrl.subscription as unknown as Record<symbol, () => unknown>;
    const d = (Symbol as { dispose?: symbol }).dispose;
    const ad = (Symbol as { asyncDispose?: symbol }).asyncDispose;
    if (d !== undefined) {
      expect(typeof sub[d]).toBe("function");
      sub[d]?.();
      expect(ctrl.subscription.state).toBe("closed");
      expect(rec.closes).toEqual([KEY]);
    }
    if (ad !== undefined) {
      const other = make("drop-oldest", 8);
      const asyncSub = other.ctrl.subscription as unknown as Record<symbol, () => Promise<void>>;
      expect(typeof asyncSub[ad]).toBe("function");
      await asyncSub[ad]?.();
      expect(other.ctrl.subscription.state).toBe("closed");
    }
  });

  test("the source never writes a computed Symbol.dispose member, nor mutates global Symbol", async () => {
    const src = await Bun.file(
      new URL("../../src/ws/subscription.ts", import.meta.url).pathname,
    ).text();
    // Comments legitimately name the shapes being avoided; only the code is being checked.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // A class body containing `[Symbol.dispose]() {}` throws at import time on Node 20.
    expect(code).not.toMatch(/\[\s*Symbol\.(async)?[Dd]ispose\s*\]\s*\(/);
    // `Symbol.dispose ??= ...` is an import side effect and the package ships sideEffects:false.
    expect(code).not.toMatch(/Symbol\.(async)?[Dd]ispose\s*(\?\?|\|\|)?=[^=]/);
    expect(code).toMatch(/Object\.defineProperty\(SubscriptionImpl\.prototype/);
  });

  test("imports and constructs on a runtime with no Symbol.dispose", async () => {
    const modulePath = new URL("../../src/ws/subscription.ts", import.meta.url).pathname;
    const script = `
      const Real = globalThis.Symbol;
      const Fake = function Symbol(d) { return Real(d); };
      for (const k of Reflect.ownKeys(Real)) {
        if (k === "dispose" || k === "asyncDispose" || k === "name" || k === "length") continue;
        try { Object.defineProperty(Fake, k, Object.getOwnPropertyDescriptor(Real, k)); } catch {}
      }
      globalThis.Symbol = Fake;
      if (typeof globalThis.Symbol.dispose !== "undefined") { console.log("SETUP-FAILED"); process.exit(2); }
      const m = await import(${JSON.stringify(modulePath)});
      const host = { requestResubscribe(){}, requestClose(){}, diagnostic(){}, now(){ return 0 } };
      const c = m.createSubscription({ key: ${JSON.stringify(KEY)}, host, overflow: "drop-oldest" });
      c.deliver({ kind: "update", data: { seq: 1 }, raw: {}, receivedAt: 1 });
      console.log("OK:" + c.subscription.state + ":" + typeof c.subscription[Real.asyncIterator]);
    `;
    const proc = Bun.spawnSync(["bun", "-e", script]);
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    expect(`${stdout}${stderr}`).toContain("OK:pending:function");
    expect(proc.exitCode).toBe(0);
  });
});
