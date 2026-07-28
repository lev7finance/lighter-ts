/**
 * `src/tx/l1/hex16.ts` — the sixteen-digit uint64 text format every L1 template uses.
 *
 * Two things are pinned here. The table, including the values the reference's misleading name
 * (`hex10`) would break; and the deliberate divergence from `src/tx/field-encode.ts`, which maps the
 * same `-1` to a different, equally correct answer.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import { toField } from "../../../src/tx/field-encode.js";
import { hex16 } from "../../../src/tx/l1/hex16.js";

describe("hex16", () => {
  const table: readonly (readonly [bigint, string])[] = [
    [0n, "0x0000000000000000"],
    [1n, "0x0000000000000001"],
    [42n, "0x000000000000002a"],
    [254n, "0x00000000000000fe"],
    [304n, "0x0000000000000130"],
    [-1n, "0xffffffffffffffff"],
    [140737488355327n, "0x00007fffffffffff"],
    [281474976710654n, "0x0000fffffffffffe"],
    [281474976710655n, "0x0000ffffffffffff"],
    [9223372036854775807n, "0x7fffffffffffffff"],
    [-9223372036854775808n, "0x8000000000000000"],
  ];

  for (const [input, expected] of table) {
    test(`${input.toString()} -> ${expected}`, () => {
      const out: string = hex16(input);
      expect(out).toBe(expected);
      expect(out.length).toBe(18);
      expect(out.startsWith("0x")).toBe(true);
      expect(out).toBe(out.toLowerCase());
    });
  }

  test("sixteen digits, never ten", () => {
    // The reference calls this `hex10`. A ten-digit pad would truncate every one of these.
    expect(hex16(0n).length - 2).toBe(16);
    expect(hex16(281474976710654n)).toBe("0x0000fffffffffffe");
  });

  test("accepts number and bigint identically", () => {
    expect(hex16(42)).toBe(hex16(42n));
    expect(hex16(-1)).toBe(hex16(-1n));
    expect(hex16(0)).toBe(hex16(0n));
  });

  test("rejects a non-integral number rather than truncating it", () => {
    expect(() => hex16(1.5)).toThrow(LighterValidationError);
  });

  test("rejects values outside [-2^63, 2^64) instead of silently wrapping", () => {
    expect(() => hex16(-9223372036854775809n)).toThrow(LighterValidationError);
    expect(() => hex16(18446744073709551616n)).toThrow(LighterValidationError);
    // The edges themselves are inside the domain.
    expect(hex16(18446744073709551615n)).toBe("0xffffffffffffffff");
  });

  test("the message format and the hash field encoder disagree on -1, deliberately", () => {
    // `hex16` reinterprets as uint64 and stops. `toField` reinterprets and then reduces mod p.
    expect(hex16(-1n)).toBe("0xffffffffffffffff");
    expect(toField(-1n).toString()).toBe("4294967294");
    expect(hex16(-1n)).not.toBe(`0x${toField(-1n).toString(16).padStart(16, "0")}`);
    // They agree on every value the reduction leaves alone.
    expect(hex16(304n)).toBe(`0x${toField(304n).toString(16).padStart(16, "0")}`);
  });
});
