/**
 * `src/client/write/memo.ts`.
 *
 * The memo is the one transaction field absent from the L2 hash, so nothing downstream can notice a
 * wrong one — every assertion here is about bytes.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import { bytesToHex } from "../../../src/util/bytes.js";
import {
  addressFromMemo,
  assertMemo,
  emptyMemo,
  memoFromAddress,
  memoFromHex,
  memoFromUtf8,
  toMemo,
} from "../../../src/client/write/memo.js";

const ADDRESS: `0x${string}` = `0x${"11".repeat(20)}`;

function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError");
}

describe("memoFromAddress", () => {
  test("is 20 address bytes followed by 12 zeroes", () => {
    const memo: Uint8Array = memoFromAddress(ADDRESS);
    expect(memo).toHaveLength(32);
    expect(bytesToHex(memo)).toBe("11".repeat(20) + "00".repeat(12));
  });

  test("accepts either case and produces the same bytes", () => {
    const upper: `0x${string}` = `0x${"AbCdEf".repeat(3)}${"01".repeat(11)}`.slice(
      0,
      42,
    ) as `0x${string}`;
    expect(bytesToHex(memoFromAddress(upper))).toBe(bytesToHex(memoFromAddress(upper.toLowerCase() as `0x${string}`)));
  });

  test("refuses anything that is not 0x + 40 hex digits", () => {
    expect(thrown(() => memoFromAddress(`0x${"11".repeat(19)}`)).code).toBe("L1_ADDRESS_INVALID");
    expect(thrown(() => memoFromAddress(`0x${"11".repeat(21)}`)).code).toBe("L1_ADDRESS_INVALID");
    expect(thrown(() => memoFromAddress("11".repeat(20) as `0x${string}`)).code).toBe(
      "L1_ADDRESS_INVALID",
    );
    expect(thrown(() => memoFromAddress(`0x${"zz".repeat(20)}`)).code).toBe("L1_ADDRESS_INVALID");
  });

  test("round-trips through addressFromMemo", () => {
    expect(addressFromMemo(memoFromAddress(ADDRESS))).toBe(ADDRESS);
  });

  test("addressFromMemo refuses a memo whose tail is not zero", () => {
    const memo: Uint8Array = memoFromUtf8("not an address, plainly");
    expect(thrown(() => addressFromMemo(memo)).code).toBe("L1_ADDRESS_INVALID");
  });
});

describe("toMemo", () => {
  test("copies a 32-byte array rather than aliasing it", () => {
    const source: Uint8Array = new Uint8Array(32).fill(7);
    const memo: Uint8Array = toMemo(source);
    source[0] = 9;
    expect(memo[0]).toBe(7);
  });

  test("accepts 0x + 64 hex digits", () => {
    const hex: `0x${string}` = `0x${"a1".repeat(32)}`;
    expect(bytesToHex(toMemo(hex))).toBe("a1".repeat(32));
  });

  test("refuses a bare 32-character ASCII string — the reference's overload", () => {
    // 32 characters, and simultaneously a plausible hex fragment: exactly the ambiguity that makes
    // the reference's three-way string parse a trap.
    const ambiguous: string = "0123456789abcdef0123456789abcdef";
    expect(thrown(() => toMemo(ambiguous as `0x${string}`)).code).toBe("MEMO_LENGTH_INVALID");
    // The explicit door is open.
    expect(memoFromUtf8(ambiguous)).toHaveLength(32);
  });

  test("refuses a 64-hex string without the 0x prefix", () => {
    expect(thrown(() => toMemo("a1".repeat(32) as `0x${string}`)).code).toBe("MEMO_LENGTH_INVALID");
  });

  test("refuses a byte array of the wrong length", () => {
    expect(thrown(() => toMemo(new Uint8Array(31))).code).toBe("MEMO_LENGTH_INVALID");
    expect(thrown(() => toMemo(new Uint8Array(33))).code).toBe("MEMO_LENGTH_INVALID");
  });
});

describe("re-exports and helpers", () => {
  test("memoFromHex and memoFromUtf8 are src/tx's, not a second implementation", async () => {
    const opts = await import("../../../src/tx/opts.js");
    expect(memoFromHex).toBe(opts.memoFromHex);
    expect(memoFromUtf8).toBe(opts.memoFromUtf8);
  });

  test("emptyMemo is 32 zero bytes and a fresh array each time", () => {
    const a: Uint8Array = emptyMemo();
    const b: Uint8Array = emptyMemo();
    expect(a).toHaveLength(32);
    expect([...a].every((byte: number): boolean => byte === 0)).toBe(true);
    a[0] = 1;
    expect(b[0]).toBe(0);
  });

  test("assertMemo returns the same array it was given", () => {
    const memo: Uint8Array = emptyMemo();
    expect(assertMemo(memo)).toBe(memo);
    expect(thrown(() => assertMemo(new Uint8Array(16))).code).toBe("MEMO_LENGTH_INVALID");
  });
});
