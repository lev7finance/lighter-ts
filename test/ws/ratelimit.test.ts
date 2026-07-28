import { describe, expect, test } from "bun:test";

import { LighterConfigError, LighterValidationError } from "../../src/errors.js";
import { InflightSemaphore, TokenBucket } from "../../src/ws/ratelimit.js";

/** A hand-cranked clock. Nothing in these tests touches real time. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const CAPACITY = 200;
const INTERVAL = 60_000;

function bucket(c: { now: () => number }, capacity = CAPACITY, refillIntervalMs = INTERVAL): TokenBucket {
  return new TokenBucket({ capacity, refillIntervalMs, now: c.now });
}

describe("TokenBucket", () => {
  test("starts full and drains to exactly capacity takes", () => {
    const c = clock();
    const b = bucket(c);
    expect(b.available).toBe(200);
    for (let i = 0; i < 200; i += 1) expect(b.tryTake(1)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
    expect(b.available).toBe(0);
  });

  test("refills continuously, not in steps", () => {
    const c = clock();
    const b = bucket(c);
    for (let i = 0; i < 200; i += 1) b.tryTake(1);

    // Half a window returns exactly half the capacity.
    c.advance(INTERVAL / 2);
    expect(Math.abs(b.available - 100)).toBeLessThan(1e-9);

    // And a single millisecond returns a fraction, rather than nothing — a stepped refill would
    // starve the resubscribe burst that follows every reconnect.
    const b2 = bucket(clock());
    expect(b2.tryTake(200)).toBe(true);
    expect(b2.available).toBe(0);
  });

  test("one millisecond of elapsed time credits a fractional token", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    c.advance(1);
    expect(b.available).toBeGreaterThan(0);
    expect(Math.abs(b.available - 200 / 60_000)).toBeLessThan(1e-12);
  });

  test("never accrues past capacity", () => {
    const c = clock();
    const b = bucket(c);
    c.advance(INTERVAL * 10);
    expect(b.available).toBe(200);
    b.tryTake(1);
    c.advance(INTERVAL * 10);
    expect(b.available).toBe(200);
  });

  test("msUntilAvailable is 0 exactly when a take would succeed", () => {
    const c = clock();
    const b = bucket(c);
    expect(b.msUntilAvailable()).toBe(0);
    expect(b.msUntilAvailable(200)).toBe(0);
    b.tryTake(200);
    expect(b.msUntilAvailable()).toBeGreaterThan(0);
    expect(b.tryTake()).toBe(false);

    // Waiting exactly the reported time makes the take succeed.
    const wait = b.msUntilAvailable(5);
    expect(Math.abs(wait - 5 * (INTERVAL / CAPACITY))).toBeLessThan(1e-9);
    c.advance(wait);
    expect(b.tryTake(5)).toBe(true);
  });

  test("a request larger than capacity is never satisfiable", () => {
    const c = clock();
    const b = bucket(c);
    expect(b.tryTake(201)).toBe(false);
    expect(b.available).toBe(200); // refused takes consume nothing
    expect(b.msUntilAvailable(201)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a failed take leaves the balance untouched", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(199);
    expect(b.tryTake(2)).toBe(false);
    expect(b.available).toBe(1);
    expect(b.tryTake(1)).toBe(true);
  });

  test("rejects nonsensical amounts", () => {
    const b = bucket(clock());
    for (const bad of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
      expect(() => b.tryTake(bad)).toThrow(LighterValidationError);
      expect(() => b.msUntilAvailable(bad)).toThrow(LighterValidationError);
    }
  });

  test("rejects unusable construction", () => {
    expect(() => new TokenBucket({ capacity: 0, refillIntervalMs: 1 })).toThrow(LighterConfigError);
    expect(() => new TokenBucket({ capacity: 1, refillIntervalMs: 0 })).toThrow(LighterConfigError);
    expect(() => new TokenBucket({ capacity: NaN, refillIntervalMs: 1 })).toThrow(LighterConfigError);
    expect(
      () => new TokenBucket({ capacity: 1, refillIntervalMs: 1, now: 0 as unknown as () => number }),
    ).toThrow(LighterConfigError);
  });

  test("a clock that runs backwards credits nothing rather than debiting", () => {
    const c = clock(1_000_000);
    const b = bucket(c);
    b.tryTake(100);
    c.set(0);
    expect(b.available).toBe(100);
    c.advance(INTERVAL / 2);
    expect(Math.abs(b.available - 200)).toBeLessThan(1e-9);
  });
});

describe("TokenBucket.throttle", () => {
  test("halves the refill for the window, then restores it — with no timer", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    b.throttle(0.5, 60_000);

    // Half rate for the whole window: 100 tokens instead of 200.
    c.advance(60_000);
    expect(Math.abs(b.available - 100)).toBeLessThan(1e-9);

    // Restored afterwards, with nothing having run at the boundary.
    b.tryTake(100);
    c.advance(30_000);
    expect(Math.abs(b.available - 100)).toBeLessThan(1e-9);
  });

  test("a span straddling the window boundary is integrated piecewise", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    b.throttle(0.5, 30_000);
    // 30 s throttled (50 tokens) + 30 s full (100 tokens) evaluated in one read.
    c.advance(60_000);
    expect(Math.abs(b.available - 150)).toBeLessThan(1e-9);
  });

  test("throttle(0, …) stops refill entirely for the window", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    b.throttle(0, 10_000);
    c.advance(10_000);
    expect(b.available).toBe(0);
    expect(b.msUntilAvailable(1)).toBeGreaterThan(0);
    c.advance(INTERVAL / 2);
    expect(Math.abs(b.available - 100)).toBeLessThan(1e-9);
  });

  test("msUntilAvailable accounts for the throttle, including its expiry", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);

    // Fully stopped for 10 s: the deficit can only accrue after the window ends.
    b.throttle(0, 10_000);
    const wait = b.msUntilAvailable(10);
    expect(Math.abs(wait - (10_000 + 10 * (INTERVAL / CAPACITY)))).toBeLessThan(1e-9);
    c.advance(wait);
    expect(b.tryTake(10)).toBe(true);

    // Reduced but non-zero: satisfiable inside the window at the reduced rate.
    const c2 = clock();
    const b2 = bucket(c2);
    b2.tryTake(200);
    b2.throttle(0.5, 60_000);
    const wait2 = b2.msUntilAvailable(1);
    expect(Math.abs(wait2 - 2 * (INTERVAL / CAPACITY))).toBeLessThan(1e-9);
    c2.advance(wait2);
    expect(b2.tryTake(1)).toBe(true);
  });

  test("re-throttling banks the old window first and replaces it", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    b.throttle(0.5, 60_000);
    c.advance(30_000); // 50 tokens at half rate
    b.throttle(0.5, 60_000); // replaces the window, starting now
    expect(Math.abs(b.available - 50)).toBeLessThan(1e-9);
    c.advance(60_000); // another 100 at half rate, capped at 200
    expect(Math.abs(b.available - 150)).toBeLessThan(1e-9);
  });

  test("rejects a factor outside [0, 1] and a negative duration", () => {
    const b = bucket(clock());
    for (const bad of [-0.1, 1.1, NaN, Number.POSITIVE_INFINITY]) {
      expect(() => b.throttle(bad, 1000)).toThrow(LighterValidationError);
    }
    expect(() => b.throttle(0.5, -1)).toThrow(LighterValidationError);
    expect(() => b.throttle(0.5, NaN)).toThrow(LighterValidationError);
    expect(() => b.throttle(1, 0)).not.toThrow();
  });
});

describe("TokenBucket.setRefillRate", () => {
  test("banks tokens at the old rate, then applies the new one", () => {
    const c = clock();
    const b = bucket(c);
    b.tryTake(200);
    c.advance(30_000); // 100 at the old rate
    b.setRefillRate(400, 60_000);
    expect(Math.abs(b.available - 100)).toBeLessThan(1e-9);
    expect(b.capacity).toBe(400);
    expect(b.refillIntervalMs).toBe(60_000);
    c.advance(30_000); // 200 at the new rate
    expect(Math.abs(b.available - 300)).toBeLessThan(1e-9);
  });

  test("shrinking the capacity clamps the balance immediately", () => {
    const c = clock();
    const b = bucket(c);
    expect(b.available).toBe(200);
    b.setRefillRate(50, 60_000);
    expect(b.available).toBe(50);
    expect(b.tryTake(50)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
  });

  test("rejects unusable rates", () => {
    const b = bucket(clock());
    expect(() => b.setRefillRate(0, 1000)).toThrow(LighterConfigError);
    expect(() => b.setRefillRate(10, 0)).toThrow(LighterConfigError);
  });
});

describe("InflightSemaphore", () => {
  test("defaults to 40 — headroom under the documented 50", () => {
    const s = new InflightSemaphore();
    expect(s.max).toBe(40);
    expect(s.inflight).toBe(0);
    for (let i = 0; i < 40; i += 1) expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    expect(s.inflight).toBe(40);
  });

  test("release frees exactly one slot and never goes negative", () => {
    const s = new InflightSemaphore(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    s.release();
    expect(s.inflight).toBe(1);
    expect(s.tryAcquire()).toBe(true);
    s.release();
    s.release();
    s.release();
    expect(s.inflight).toBe(0);
  });

  test("resize never yields a max below 1", () => {
    const s = new InflightSemaphore(2);
    s.resize(0);
    expect(s.max).toBe(1);
    s.resize(-100);
    expect(s.max).toBe(1);
    s.resize(0.9);
    expect(s.max).toBe(1);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
  });

  test("resize does not revoke slots already acquired", () => {
    const s = new InflightSemaphore(40);
    for (let i = 0; i < 40; i += 1) s.tryAcquire();
    s.resize(Math.floor(40 * 0.75)); // the documented 30010 response: shrink by 25 %
    expect(s.max).toBe(30);
    expect(s.inflight).toBe(40); // their replies are still coming
    expect(s.tryAcquire()).toBe(false);
    for (let i = 0; i < 11; i += 1) s.release();
    expect(s.inflight).toBe(29);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
  });

  test("resize floors a fractional ceiling", () => {
    const s = new InflightSemaphore(10);
    s.resize(7.5);
    expect(s.max).toBe(7);
  });

  test("releaseAll drops every slot but leaves the ceiling", () => {
    const s = new InflightSemaphore(5);
    s.tryAcquire();
    s.tryAcquire();
    s.releaseAll();
    expect(s.inflight).toBe(0);
    expect(s.max).toBe(5);
    for (let i = 0; i < 5; i += 1) expect(s.tryAcquire()).toBe(true);
  });

  test("rejects a non-numeric ceiling", () => {
    expect(() => new InflightSemaphore(NaN)).toThrow(LighterConfigError);
    expect(() => new InflightSemaphore("40" as unknown as number)).toThrow(LighterConfigError);
  });
});
