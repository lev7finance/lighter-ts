import { describe, expect, test } from "bun:test";

import { LighterConfigError } from "../../src/errors.js";
import { BackoffController, classifyCloseCode } from "../../src/ws/backoff.js";
import type { CloseClassification } from "../../src/ws/backoff.js";

/** The reference formula from the issue, restated independently of the implementation. */
function expectedDelay(r: number, attempt: number, minDelayMs: number, base = 250, max = 30_000): number {
  return Math.max(minDelayMs, r * Math.min(max, base * 2 ** Math.min(attempt, 31)));
}

const NETWORK: CloseClassification = classifyCloseCode(1006);

describe("classifyCloseCode", () => {
  test("1000 is terminal only when we initiated it", () => {
    const ours = classifyCloseCode(1000, { clientInitiated: true });
    expect(ours.cls).toBe("client-initiated");
    expect(ours.reconnect).toBe(false);
    expect(ours.minDelayMs).toBe(0);
    expect(ours.diagnostic).toBeUndefined();

    const theirs = classifyCloseCode(1000);
    expect(theirs.cls).toBe("drain");
    expect(theirs.reconnect).toBe(true);
    expect(theirs.minDelayMs).toBe(0);
    expect(theirs.diagnostic).toBe("drain");

    // Explicitly false is the same as absent.
    expect(classifyCloseCode(1000, { clientInitiated: false }).cls).toBe("drain");
  });

  test("clientInitiated does not make our own 4000/4001 terminal", () => {
    // The staleness watchdog and the protocol guard both close the socket themselves; if
    // `clientInitiated` short-circuited on code alone, a half-open socket would never recover.
    for (const code of [4000, 4001]) {
      const c = classifyCloseCode(code, { clientInitiated: true });
      expect(c.reconnect).toBe(true);
    }
  });

  test("1001 Going Away drains with a one-second floor", () => {
    const c = classifyCloseCode(1001);
    expect(c.cls).toBe("drain");
    expect(c.reconnect).toBe(true);
    expect(c.minDelayMs).toBe(1000);
    expect(c.diagnostic).toBe("drain");
  });

  test("1006 is a plain network reconnect", () => {
    expect(classifyCloseCode(1006)).toEqual({
      code: 1006,
      cls: "network",
      reconnect: true,
      minDelayMs: 0,
    });
  });

  test("1008 raises the floor and flags auth only once it repeats", () => {
    for (const n of [undefined, 0, 1]) {
      const c = n === undefined ? classifyCloseCode(1008) : classifyCloseCode(1008, { consecutivePolicyCloses: n });
      expect(c.cls).toBe("policy");
      expect(c.reconnect).toBe(true);
      expect(c.minDelayMs).toBe(0);
      expect(c.diagnostic).toBeUndefined();
    }
    for (const n of [2, 3, 17]) {
      const c = classifyCloseCode(1008, { consecutivePolicyCloses: n });
      expect(c.cls).toBe("policy");
      expect(c.minDelayMs).toBe(5000);
      expect(c.diagnostic).toBe("auth-suspect");
    }
  });

  test("1011, 1012 and 1013 are server errors", () => {
    for (const code of [1011, 1012, 1013]) {
      const c = classifyCloseCode(code);
      expect(c.cls).toBe("server-error");
      expect(c.reconnect).toBe(true);
      expect(c.minDelayMs).toBe(0);
    }
  });

  test("our own codes classify as stale and protocol", () => {
    expect(classifyCloseCode(4000).cls).toBe("stale");
    expect(classifyCloseCode(4001).cls).toBe("protocol");
    expect(classifyCloseCode(4000).reconnect).toBe(true);
    expect(classifyCloseCode(4001).reconnect).toBe(true);
  });

  test("unknown codes reconnect as network rather than stalling the client", () => {
    for (const code of [0, 1002, 1003, 1005, 1007, 1009, 1010, 1015, 3000, 4002, 4999, 65_535, -1, 1.5, NaN]) {
      const c = classifyCloseCode(code);
      expect(c.cls).toBe("network");
      expect(c.reconnect).toBe(true);
      expect(c.minDelayMs).toBe(0);
    }
  });

  test("every classification echoes the code and is frozen", () => {
    for (const code of [1000, 1001, 1006, 1008, 1011, 4000, 4001, 9999]) {
      const c = classifyCloseCode(code);
      expect(c.code).toBe(code);
      expect(Object.isFrozen(c)).toBe(true);
    }
  });
});

describe("BackoffController delay schedule", () => {
  test("attempts 0..40 match max(minDelayMs, r * min(30000, 250 * 2 ** min(n, 31)))", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const b = new BackoffController({ random: () => r });
      for (let attempt = 0; attempt <= 40; attempt += 1) {
        expect(b.attempt).toBe(attempt);
        const delay = b.nextDelayMs(NETWORK);
        expect(delay).toBe(expectedDelay(r, attempt, 0));
        expect(Number.isFinite(delay as number)).toBe(true);
        expect(delay as number).toBeGreaterThanOrEqual(0);
        expect(Number.isNaN(delay as number)).toBe(false);
      }
      expect(b.attempt).toBe(41);
    }
  });

  test("full jitter really is full: r = 0 yields 0", () => {
    // A test asserting delay >= cap/2 would be asserting equal jitter, which is the wrong algorithm.
    const b = new BackoffController({ random: () => 0 });
    for (let i = 0; i < 10; i += 1) expect(b.nextDelayMs(NETWORK)).toBe(0);
  });

  test("the cap saturates at maxDelayMs and never overflows after a long outage", () => {
    const b = new BackoffController({ random: () => 1 });
    let last = 0;
    for (let i = 0; i <= 2000; i += 1) {
      last = b.nextDelayMs(NETWORK) as number;
      expect(Number.isFinite(last)).toBe(true);
      expect(last).toBeLessThanOrEqual(30_000);
    }
    expect(last).toBe(30_000);
  });

  test("class floors survive a jitter of zero", () => {
    const b = new BackoffController({ random: () => 0 });
    expect(b.nextDelayMs(classifyCloseCode(1001))).toBe(1000);
    expect(b.nextDelayMs(classifyCloseCode(1008, { consecutivePolicyCloses: 2 }))).toBe(5000);
  });

  test("a floor does not shorten a larger jittered delay", () => {
    const b = new BackoffController({ random: () => 1, baseDelayMs: 4000 });
    // attempt 0: cap 4000, jitter 1 -> 4000, above the 1000 ms drain floor.
    expect(b.nextDelayMs(classifyCloseCode(1001))).toBe(4000);
  });

  test("a terminal classification returns null and consumes no attempt", () => {
    const b = new BackoffController({ random: () => 0.5 });
    b.nextDelayMs(NETWORK);
    expect(b.attempt).toBe(1);
    expect(b.nextDelayMs(classifyCloseCode(1000, { clientInitiated: true }))).toBeNull();
    expect(b.attempt).toBe(1);
  });

  test("maxAttempts exhaustion returns null", () => {
    const b = new BackoffController({ random: () => 0.5, maxAttempts: 3 });
    expect(b.nextDelayMs(NETWORK)).not.toBeNull();
    expect(b.nextDelayMs(NETWORK)).not.toBeNull();
    expect(b.nextDelayMs(NETWORK)).not.toBeNull();
    expect(b.attempt).toBe(3);
    expect(b.nextDelayMs(NETWORK)).toBeNull();
    expect(b.nextDelayMs(NETWORK)).toBeNull();
    expect(b.attempt).toBe(3);

    b.reset();
    expect(b.nextDelayMs(NETWORK)).not.toBeNull();
  });

  test("maxAttempts 0 never reconnects", () => {
    const b = new BackoffController({ maxAttempts: 0 });
    expect(b.nextDelayMs(NETWORK)).toBeNull();
  });

  test("a misbehaving jitter source cannot produce NaN, Infinity or a negative", () => {
    for (const bad of [NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2, 1e308]) {
      const b = new BackoffController({ random: () => bad });
      const d = b.nextDelayMs(NETWORK) as number;
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  test("custom base and max are honoured", () => {
    const b = new BackoffController({ random: () => 1, baseDelayMs: 100, maxDelayMs: 500 });
    expect(b.nextDelayMs(NETWORK)).toBe(100);
    expect(b.nextDelayMs(NETWORK)).toBe(200);
    expect(b.nextDelayMs(NETWORK)).toBe(400);
    expect(b.nextDelayMs(NETWORK)).toBe(500);
    expect(b.nextDelayMs(NETWORK)).toBe(500);
  });

  test("defaults are 250 / 30000 / unlimited", () => {
    const b = new BackoffController({ random: () => 1 });
    expect(b.nextDelayMs(NETWORK)).toBe(250);
    expect(b.nextDelayMs(NETWORK)).toBe(500);
    for (let i = 0; i < 5000; i += 1) expect(b.nextDelayMs(NETWORK)).not.toBeNull();
  });

  test("rejects unusable options", () => {
    expect(() => new BackoffController({ baseDelayMs: 0 })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ baseDelayMs: -1 })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ maxDelayMs: Number.POSITIVE_INFINITY })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ stableAfterMs: -1 })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ maxAttempts: -1 })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ maxAttempts: NaN })).toThrow(LighterConfigError);
    expect(() => new BackoffController({ random: 1 as unknown as () => number })).toThrow(LighterConfigError);
    // Infinity is the documented "unlimited" value for maxAttempts and must be accepted.
    expect(() => new BackoffController({ maxAttempts: Number.POSITIVE_INFINITY })).not.toThrow();
  });
});

describe("BackoffController stability reset", () => {
  const STABLE = 30_000;

  test("a connection one ms short of stable does not reset the counter", () => {
    const b = new BackoffController({ random: () => 0.5 });
    b.nextDelayMs(NETWORK);
    b.nextDelayMs(NETWORK);
    expect(b.attempt).toBe(2);

    b.noteOpen(1_000_000);
    b.noteClose(1_000_000 + STABLE - 1);
    expect(b.attempt).toBe(2);
  });

  test("a connection open for exactly stableAfterMs resets to 0", () => {
    const b = new BackoffController({ random: () => 0.5 });
    b.nextDelayMs(NETWORK);
    b.nextDelayMs(NETWORK);
    b.noteOpen(1_000_000);
    b.noteClose(1_000_000 + STABLE);
    expect(b.attempt).toBe(0);
  });

  test("open alone never resets — this is what stops a crash loop reconnecting at full speed", () => {
    const b = new BackoffController({ random: () => 1 });
    let t = 0;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const d = b.nextDelayMs(NETWORK) as number;
      delays.push(d);
      t += d;
      b.noteOpen(t);
      t += 5; // dies 5 ms later, far short of stable
      b.noteClose(t);
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000]);
  });

  test("a close without a preceding open never resets", () => {
    const b = new BackoffController({ random: () => 0.5, stableAfterMs: 0 });
    b.nextDelayMs(NETWORK);
    b.noteClose(999_999_999);
    expect(b.attempt).toBe(1);
  });

  test("a second close after one open does not reset twice", () => {
    const b = new BackoffController({ random: () => 0.5 });
    b.nextDelayMs(NETWORK);
    b.noteOpen(0);
    b.noteClose(10); // too short
    expect(b.attempt).toBe(1);
    b.noteClose(10_000_000); // no open in between — must not reset
    expect(b.attempt).toBe(1);
  });

  test("stableAfterMs 0 resets on any close after an open", () => {
    const b = new BackoffController({ random: () => 0.5, stableAfterMs: 0 });
    b.nextDelayMs(NETWORK);
    b.noteOpen(5);
    b.noteClose(5);
    expect(b.attempt).toBe(0);
  });

  test("reset clears both the counter and the open interval", () => {
    const b = new BackoffController({ random: () => 0.5 });
    b.nextDelayMs(NETWORK);
    b.noteOpen(0);
    b.reset();
    expect(b.attempt).toBe(0);
    b.nextDelayMs(NETWORK);
    b.noteClose(1_000_000);
    expect(b.attempt).toBe(1);
  });
});
