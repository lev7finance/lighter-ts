import { describe, expect, test } from "bun:test";

import {
  LighterConfigError,
  LighterNonceError,
  LighterValidationError,
} from "../../../src/errors.js";
import { KeyPool } from "../../../src/client/nonce/key-pool.js";

/** Resolve after `n` microtask turns, so a "did not resolve" assertion is not just impatience. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe("KeyPool construction", () => {
  test("rejects an empty pool", () => {
    expect(() => new KeyPool([])).toThrow(LighterConfigError);
  });

  test("rejects a duplicate index", () => {
    expect(() => new KeyPool([0, 1, 0])).toThrow(LighterConfigError);
  });

  test("rejects a non-integer index", () => {
    expect(() => new KeyPool([1.5])).toThrow(LighterConfigError);
    expect(() => new KeyPool([Number.NaN])).toThrow(LighterConfigError);
  });

  test("rejects an index outside [0, 254]", () => {
    expect(() => new KeyPool([-1])).toThrow(LighterValidationError);
    expect(() => new KeyPool([300])).toThrow(LighterValidationError);
    try {
      new KeyPool([-1]);
    } catch (e: unknown) {
      expect((e as LighterValidationError).code).toBe("API_KEY_INDEX_TOO_LOW");
    }
    try {
      new KeyPool([300]);
    } catch (e: unknown) {
      expect((e as LighterValidationError).code).toBe("API_KEY_INDEX_TOO_HIGH");
    }
  });

  test("255 is the nil sentinel, never a signing key", () => {
    expect(() => new KeyPool([255])).toThrow(LighterValidationError);
    expect(() => new KeyPool([254])).not.toThrow();
  });

  test("keys are frozen and copied, so later mutation of the argument is not observed", () => {
    const source = [0, 1];
    const pool = new KeyPool(source);
    source.push(2);
    expect(pool.keys).toEqual([0, 1]);
    expect(Object.isFrozen(pool.keys)).toBe(true);
    expect(pool.size).toBe(2);
  });
});

describe("KeyPool.rotate", () => {
  test("starts at keys[0] — not keys[1], as the reference does", () => {
    const pool = new KeyPool([7, 8, 9]);
    expect(pool.rotate()).toBe(7);
    expect(pool.rotate()).toBe(8);
    expect(pool.rotate()).toBe(9);
    expect(pool.rotate()).toBe(7);
  });

  test("is the identity for a single key", () => {
    const pool = new KeyPool([3]);
    for (let i = 0; i < 5; i += 1) expect(pool.rotate()).toBe(3);
  });

  test("has() reflects membership", () => {
    const pool = new KeyPool([0, 4]);
    expect(pool.has(0)).toBe(true);
    expect(pool.has(4)).toBe(true);
    expect(pool.has(1)).toBe(false);
  });
});

describe("KeyPool.acquire", () => {
  test("rejects a key that is not in the pool", async () => {
    const pool = new KeyPool([0]);
    await expect(pool.acquire(1)).rejects.toThrow(LighterNonceError);
    await pool.acquire(1).catch((e: unknown) => {
      expect((e as LighterNonceError).code).toBe("KEY_UNKNOWN");
    });
  });

  test("serialises one key and leaves the others free", async () => {
    const pool = new KeyPool([3, 4]);
    const releaseThree = await pool.acquire(3);

    let secondHeld = false;
    const queued = pool.acquire(3).then((r: () => void) => {
      secondHeld = true;
      return r;
    });

    // A different key is unaffected: it resolves while key 3 is still held.
    const releaseFour = await pool.acquire(4);
    expect(releaseFour).toBeInstanceOf(Function);

    await ticks(10);
    expect(secondHeld).toBe(false);

    releaseThree();
    const releaseSecond = await queued;
    expect(secondHeld).toBe(true);
    releaseSecond();
    releaseFour();
  });

  test("is FIFO — waiters run in the order they asked", async () => {
    const pool = new KeyPool([0]);
    const order: number[] = [];
    const first = await pool.acquire(0);

    const waiters = [1, 2, 3].map(async (n: number): Promise<void> => {
      const release = await pool.acquire(0);
      order.push(n);
      release();
    });

    await ticks(5);
    expect(order).toEqual([]);
    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  test("release is idempotent and does not hand the lock to two waiters", async () => {
    const pool = new KeyPool([0]);
    const release = await pool.acquire(0);
    release();
    release();
    release();

    const order: string[] = [];
    const a = pool.acquire(0).then((r: () => void) => {
      order.push("a");
      return r;
    });
    const b = pool.acquire(0).then((r: () => void) => {
      order.push("b");
      return r;
    });
    const releaseA = await a;
    await ticks(5);
    expect(order).toEqual(["a"]);
    releaseA();
    const releaseB = await b;
    expect(order).toEqual(["a", "b"]);
    releaseB();
  });

  test("isLocked clears once the last holder releases", async () => {
    const pool = new KeyPool([0]);
    expect(pool.isLocked(0)).toBe(false);
    const release = await pool.acquire(0);
    expect(pool.isLocked(0)).toBe(true);
    release();
    expect(pool.isLocked(0)).toBe(false);
  });

  test("two pools do not share a lock", async () => {
    const a = new KeyPool([0]);
    const b = new KeyPool([0]);
    const releaseA = await a.acquire(0);
    const releaseB = await b.acquire(0);
    expect(releaseB).toBeInstanceOf(Function);
    releaseA();
    releaseB();
  });
});
