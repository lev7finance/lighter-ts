/**
 * `src/tx/opts.ts` — the shared transaction options, the clock seam, and the memo constructors.
 *
 * The two properties worth defending here are both about the clock, because both are invisible in a
 * passing hash test:
 *
 * 1. **The default expiry is `now() + 599_000` milliseconds.** `600_000` is off by a second in a
 *    direction that only shows up under clock skew; seconds instead of milliseconds produces a
 *    timestamp in 1970 that the sequencer rejects with an error naming the field but not the unit.
 * 2. **The clock is not read when `expiredAt` is supplied.** Asserted with a throwing stub, because
 *    a spurious `Date.now()` on the build path is exactly what makes a vector unreproducible, and it
 *    would not fail any hash test that supplies its own `expiredAt`.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import { bytesToHex, utf8ToBytes } from "../../src/util/bytes.js";
import { type I64, i64, u8 } from "../../src/tx/brands.js";
import { MEMO_LENGTH } from "../../src/tx/constants.js";
import {
  DEFAULT_TX_EXPIRY_MS,
  IOC_EXPIRY,
  NO_CLIENT_ORDER_INDEX,
  type ResolvedTransactOpts,
  type TransactOpts,
  expiryIn,
  memoFromHex,
  memoFromUtf8,
  resolveOpts,
} from "../../src/tx/opts.js";

/** A clock that must never be called. Any read is a bug, not a slow test. */
const FORBIDDEN_CLOCK = (): number => {
  throw new Error("the clock was read when it should not have been");
};

/** The base options every case here starts from. */
const BASE: TransactOpts = {
  accountIndex: i64(1),
  apiKeyIndex: u8(0),
  nonce: i64(42),
};

function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but nothing was thrown");
}

describe("DEFAULT_TX_EXPIRY_MS", () => {
  test("is ten minutes minus one second, in milliseconds", () => {
    expect(DEFAULT_TX_EXPIRY_MS).toBe(599_000);
    // Guarding the two ways this is habitually written wrong.
    expect(DEFAULT_TX_EXPIRY_MS).not.toBe(600_000);
    expect(DEFAULT_TX_EXPIRY_MS).not.toBe(599);
  });
});

describe("resolveOpts", () => {
  test("defaults expiredAt to now() + 599_000 through the injected clock", () => {
    const o: ResolvedTransactOpts = resolveOpts({ ...BASE, now: () => 1_700_000_000_000 });
    expect(o.expiredAt).toBe(1_700_000_599_000n as I64);
  });

  test("reads the clock exactly once", () => {
    let reads: number = 0;
    resolveOpts({
      ...BASE,
      now: (): number => {
        reads += 1;
        return 1_700_000_000_000;
      },
    });
    expect(reads).toBe(1);
  });

  test("never reads the clock when expiredAt is supplied", () => {
    const o: ResolvedTransactOpts = resolveOpts({
      ...BASE,
      expiredAt: i64(1_893_456_000_000n),
      now: FORBIDDEN_CLOCK,
    });
    expect(o.expiredAt).toBe(1_893_456_000_000n as I64);
  });

  test("treats expiredAt = 0n as a value, not an absence", () => {
    const o: ResolvedTransactOpts = resolveOpts({ ...BASE, expiredAt: i64(0), now: FORBIDDEN_CLOCK });
    expect(o.expiredAt).toBe(0n as I64);
  });

  test("falls back to Date.now when no clock is injected", () => {
    const before: number = Date.now();
    const o: ResolvedTransactOpts = resolveOpts(BASE);
    const after: number = Date.now();
    expect(o.expiredAt).toBeGreaterThanOrEqual(BigInt(before) + BigInt(DEFAULT_TX_EXPIRY_MS));
    expect(o.expiredAt).toBeLessThanOrEqual(BigInt(after) + BigInt(DEFAULT_TX_EXPIRY_MS));
  });

  test("rejects a clock that does not return a safe integer", () => {
    expect(thrown(() => resolveOpts({ ...BASE, now: () => 1.5 })).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => resolveOpts({ ...BASE, now: () => Number.NaN })).code).toBe(
      "UNSAFE_INTEGER",
    );
  });

  test("passes the identity fields through untouched", () => {
    const o: ResolvedTransactOpts = resolveOpts({
      accountIndex: i64(-1),
      apiKeyIndex: u8(255),
      nonce: i64(0),
      expiredAt: i64(1n),
    });
    expect(o.accountIndex).toBe(-1n as I64);
    expect(o.apiKeyIndex).toBe(u8(255));
    expect(o.nonce).toBe(0n as I64);
  });

  test("strict defaults to true and only an explicit false turns it off", () => {
    expect(resolveOpts({ ...BASE, expiredAt: i64(1n) }).strict).toBe(true);
    expect(resolveOpts({ ...BASE, expiredAt: i64(1n), strict: true }).strict).toBe(true);
    expect(resolveOpts({ ...BASE, expiredAt: i64(1n), strict: false }).strict).toBe(false);
  });
});

describe("resolveOpts — attributes", () => {
  const withAttrs = (attributes: TransactOpts["attributes"]): ResolvedTransactOpts =>
    resolveOpts({ ...BASE, expiredAt: i64(1n), attributes });

  test("an absent map becomes an empty one, which hashes and serialises identically", () => {
    expect(withAttrs(undefined).attributes).toEqual({});
  });

  test("drops entries whose value equals the registry nil value", () => {
    // Type 2's nil is 0, so `{1: 7, 2: 0}` carries one live attribute.
    expect(withAttrs({ 1: 7, 2: 0 }).attributes).toEqual({ 1: 7 });
  });

  test("keeps `{5: 0}` — type 5 nils at 255, not 0", () => {
    expect(withAttrs({ 5: 0 }).attributes).toEqual({ 5: 0 });
    expect(withAttrs({ 5: 255 }).attributes).toEqual({});
  });

  test("emits surviving keys in ascending numeric order", () => {
    expect(Object.keys(withAttrs({ 3: 1, 1: 2, 2: 3 }).attributes)).toEqual(["1", "2", "3"]);
  });

  test("validates the raw map, so a nil entry cannot smuggle a fifth attribute past the count", () => {
    // Five entries, one of them nil-valued. Dropping first would leave four and pass.
    expect(thrown(() => withAttrs({ 1: 1, 2: 1, 3: 1, 4: 1, 6: 0 })).code).toBe(
      "TOO_MANY_ATTRIBUTES",
    );
  });

  test("rejects an unknown attribute type", () => {
    expect(
      thrown(() => withAttrs({ 9: 1 } as unknown as TransactOpts["attributes"])).code,
    ).toBe("ATTRIBUTE_TYPE_INVALID");
  });

  test("rejects integrator fees without an integrator index", () => {
    expect(thrown(() => withAttrs({ 2: 250 })).code).toBe("INTEGRATOR_REQUIRED_FOR_FEES");
  });
});

describe("expiryIn", () => {
  const CLOCK = (): number => 1_700_000_000_000;

  test("adds days, hours and minutes", () => {
    expect(expiryIn({ minutes: 1 }, CLOCK)).toBe(1_700_000_060_000n as I64);
    expect(expiryIn({ hours: 2 }, CLOCK)).toBe(1_700_007_200_000n as I64);
    expect(expiryIn({ days: 1 }, CLOCK)).toBe(1_700_086_400_000n as I64);
    expect(expiryIn({ days: 1, hours: 2, minutes: 3 }, CLOCK)).toBe(1_700_093_780_000n as I64);
  });

  test("an empty duration is simply now", () => {
    expect(expiryIn({}, CLOCK)).toBe(1_700_000_000_000n as I64);
  });

  test("rejects a duration that is not a whole number of milliseconds", () => {
    expect(thrown(() => expiryIn({ minutes: 0.0000001 }, CLOCK)).code).toBe("UNSAFE_INTEGER");
  });

  test("defaults to Date.now", () => {
    const before: number = Date.now();
    const value: I64 = expiryIn({ minutes: 1 });
    expect(value).toBeGreaterThanOrEqual(BigInt(before) + 60_000n);
  });
});

describe("sentinels", () => {
  test("IOC_EXPIRY and NO_CLIENT_ORDER_INDEX are both the nil value, 0", () => {
    expect(IOC_EXPIRY).toBe(0n as I64);
    expect(NO_CLIENT_ORDER_INDEX).toBe(0n as I64);
  });
});

describe("memoFromHex", () => {
  const HEX32: string = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

  test("accepts a bare or 0x-prefixed 64-digit string", () => {
    expect(bytesToHex(memoFromHex(HEX32))).toBe(HEX32);
    expect(bytesToHex(memoFromHex(`0x${HEX32}`))).toBe(HEX32);
    expect(memoFromHex(HEX32)).toHaveLength(MEMO_LENGTH);
  });

  test("rejects any other length", () => {
    expect(thrown(() => memoFromHex("")).code).toBe("MEMO_LENGTH_INVALID");
    expect(thrown(() => memoFromHex(HEX32.slice(2))).code).toBe("MEMO_LENGTH_INVALID");
    expect(thrown(() => memoFromHex(`${HEX32}00`)).code).toBe("MEMO_LENGTH_INVALID");
  });

  test("rejects non-hex characters", () => {
    expect(() => memoFromHex("zz".repeat(32))).toThrow();
  });
});

describe("memoFromUtf8", () => {
  test("encodes and zero-pads to 32 bytes", () => {
    const memo: Uint8Array = memoFromUtf8("hello");
    expect(memo).toHaveLength(MEMO_LENGTH);
    expect(bytesToHex(memo.subarray(0, 5))).toBe(bytesToHex(utf8ToBytes("hello")));
    expect([...memo.subarray(5)].every((b) => b === 0)).toBe(true);
  });

  test("an empty memo is 32 zeros", () => {
    expect([...memoFromUtf8("")].every((b) => b === 0)).toBe(true);
  });

  test("the limit is 32 bytes, not 32 characters", () => {
    // 8 four-byte code points fit exactly; 9 do not.
    expect(memoFromUtf8("😀".repeat(8))).toHaveLength(MEMO_LENGTH);
    expect(thrown(() => memoFromUtf8("😀".repeat(9))).code).toBe("MEMO_LENGTH_INVALID");
    expect(thrown(() => memoFromUtf8("a".repeat(33))).code).toBe("MEMO_LENGTH_INVALID");
  });
});
