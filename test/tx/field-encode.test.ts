import { describe, expect, test } from "bun:test";

import { P } from "../../src/crypto/field/constants.js";
import { LighterValidationError, isLighterError } from "../../src/errors.js";
import { i16, i64, u16, u32, u64 } from "../../src/tx/brands.js";
import {
  pubKeyToFieldElements,
  splitI64Arith,
  splitU64,
  toField,
} from "../../src/tx/field-encode.js";
import { hexToBytes } from "../../src/util/bytes.js";

/** Capture the thrown value so `code` can be inspected, not just the class. */
function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(LighterValidationError);
    expect(isLighterError(e)).toBe(true);
    return e as LighterValidationError;
  }
  throw new Error("expected a throw, got a value");
}

/** Every element that leaves this module must be a canonical residue. */
function expectCanonical(v: bigint): void {
  expect(v >= 0n).toBe(true);
  expect(v < P).toBe(true);
}

/** Widen a readonly tuple to a plain array so `toEqual` compares values, not brands. */
function pair(t: readonly [bigint, bigint]): bigint[] {
  return [t[0], t[1]];
}

describe("toField — the sign-extension rule", () => {
  test("-1 becomes 4294967294, NOT p - 1", () => {
    // THE TRAP (docs/protocol-notes.md §3.1, spec/04 §1.2). A negative protocol integer
    // sign-extends to 64 bits and *then* reduces: 0xFFFFFFFFFFFFFFFF - p = 2^32 - 2.
    // Euclidean reduction would give p - 1 = 18446744069414584320, which is a perfectly
    // plausible-looking field element and produces a different hash for every transaction
    // carrying a negative field. Pinned by tx.json -> cancel_all_orders/negative_account_index,
    // whose AccountIndex is "-1" (MinAccountIndex, a legal value).
    expect<bigint>(toField(-1n)).toBe(4294967294n);
    expect<bigint>(toField(-1)).toBe(4294967294n);
    expect(toField(-1n)).not.toBe(P - 1n);
  });

  test("the mapping is width-independent: int16 -1 and int64 -1 agree", () => {
    // MarketIndex is int16 and AccountIndex is int64; both sign-extend to the same 64-bit word.
    expect<bigint>(toField(i16(-1))).toBe(4294967294n);
    expect<bigint>(toField(i64(-1n))).toBe(4294967294n);
  });

  test("small negatives step down from 2^32 - 2", () => {
    expect<bigint>(toField(-2n)).toBe(4294967293n);
    expect<bigint>(toField(-3n)).toBe(4294967292n);
  });

  test("-2^32 sign-extends to exactly p - 1, the one negative that does map there", () => {
    // 0xFFFFFFFF00000000 === p - 1. Coincidence, not the rule: it is still asUintN-then-reduce.
    expect<bigint>(toField(-4294967296n)).toBe(18446744069414584320n);
    expect<bigint>(toField(-4294967296n)).toBe(P - 1n);
  });

  test("int64 minimum sign-extends to 2^63, which is already canonical", () => {
    expect<bigint>(toField(-9223372036854775808n)).toBe(9223372036854775808n);
  });

  test("non-negative values below p are the identity", () => {
    expect<bigint>(toField(0n)).toBe(0n);
    expect<bigint>(toField(0)).toBe(0n);
    expect<bigint>(toField(1n)).toBe(1n);
    expect<bigint>(toField(304n)).toBe(304n); // the chain id
    expect<bigint>(toField(1893456000000n)).toBe(1893456000000n); // an ExpiredAt from tx.json
  });

  test("a uint64 at or above p reduces by exactly one p", () => {
    expect<bigint>(toField(P)).toBe(0n);
    expect<bigint>(toField(P + 4n)).toBe(4n);
    expect<bigint>(toField(18446744073709551615n)).toBe(4294967294n); // 2^64 - 1, same word as -1
    expect<bigint>(toField(P - 1n)).toBe(P - 1n);
  });

  test("bigint and number inputs agree wherever both can hold the value", () => {
    for (const v of [0, 1, -1, 254, 255, 2147483648, 4294967295, 4294967296]) {
      expect(toField(v)).toBe(toField(BigInt(v)));
    }
  });

  test("rejects a non-integral number rather than truncating it", () => {
    expect(thrown(() => toField(1.5)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => toField(Number.NaN)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => toField(Number.POSITIVE_INFINITY)).code).toBe("UNSAFE_INTEGER");
    expect(thrown(() => toField(2 ** 53)).code).toBe("UNSAFE_INTEGER");
  });

  test("rejects values outside the [-2^63, 2^64) protocol domain rather than truncating", () => {
    expect(thrown(() => toField(-9223372036854775809n)).code).toBe("VALUE_TOO_LOW");
    expect(thrown(() => toField(18446744073709551616n)).code).toBe("VALUE_TOO_HIGH");
  });
});

/*
 * spec/04-tx-types.md §14.1: table test over this value set for each of i16/u16/u32/i64/u64,
 * asserting the canonical field element. The point the table makes is that the declared width does
 * not appear in the answer — only the signed value does, because every width sign-extends to 64
 * bits before reduction.
 */
const TABLE: readonly { readonly label: string; readonly v: bigint; readonly want: bigint }[] = [
  { label: "0", v: 0n, want: 0n },
  { label: "1", v: 1n, want: 1n },
  { label: "-1", v: -1n, want: 4294967294n },
  { label: "254", v: 254n, want: 254n },
  { label: "255", v: 255n, want: 255n },
  { label: "2^31", v: 2147483648n, want: 2147483648n },
  { label: "2^32-1", v: 4294967295n, want: 4294967295n },
  { label: "2^32", v: 4294967296n, want: 4294967296n },
  { label: "2^47", v: 140737488355328n, want: 140737488355328n },
  { label: "2^48-2", v: 281474976710654n, want: 281474976710654n },
  { label: "2^48-1", v: 281474976710655n, want: 281474976710655n },
  { label: "2^60-1", v: 1152921504606846975n, want: 1152921504606846975n },
  { label: "2^63-1", v: 9223372036854775807n, want: 9223372036854775807n },
  { label: "-2^63", v: -9223372036854775808n, want: 9223372036854775808n },
];

const WIDTHS: readonly {
  readonly name: string;
  readonly min: bigint;
  readonly max: bigint;
  readonly mint: (v: bigint) => bigint | number;
}[] = [
  { name: "i16", min: -32768n, max: 32767n, mint: (v: bigint): number => i16(Number(v)) },
  { name: "u16", min: 0n, max: 65535n, mint: (v: bigint): number => u16(Number(v)) },
  { name: "u32", min: 0n, max: 4294967295n, mint: (v: bigint): number => u32(Number(v)) },
  {
    name: "i64",
    min: -9223372036854775808n,
    max: 9223372036854775807n,
    mint: (v: bigint): bigint => i64(v),
  },
  { name: "u64", min: 0n, max: 18446744073709551615n, mint: (v: bigint): bigint => u64(v) },
];

describe("toField — spec §14.1 width table", () => {
  for (const w of WIDTHS) {
    for (const row of TABLE) {
      if (row.v < w.min || row.v > w.max) continue;
      test(`${w.name}(${row.label}) -> ${row.want.toString()}`, () => {
        const got: bigint = toField(w.mint(row.v));
        expect(got).toBe(row.want);
        expectCanonical(got);
      });
    }
  }

  test("every row is canonical for every width that can hold it", () => {
    let checked: number = 0;
    for (const w of WIDTHS) {
      for (const row of TABLE) {
        if (row.v < w.min || row.v > w.max) continue;
        expectCanonical(toField(w.mint(row.v)));
        checked += 1;
      }
    }
    // 5 (i16) + 4 (u16) + 6 (u32) + 14 (i64) + 12 (u64) rows survive their width filters.
    expect(checked).toBe(41);
  });
});

describe("splitU64 — logical shift", () => {
  test("-1n splits to [4294967295, 4294967295]", () => {
    // Logical: the value is reinterpreted as the unsigned word 0xFFFFFFFFFFFFFFFF first, so BOTH
    // halves are 2^32 - 1. Contrast splitI64Arith(-1n) below, whose high half is one less because
    // it shifts while the value is still signed. The two helpers agree on every non-negative
    // input, so only negatives can tell them apart — which is why this pair of assertions exists.
    expect(pair(splitU64(-1n))).toEqual([4294967295n, 4294967295n]);
    expect(splitU64(-1n)[1]).not.toBe(splitI64Arith(-1n)[1]);
  });

  test("transfer/large_amount_lo_hi_split field values", () => {
    // tx.json -> transfer/large_amount_lo_hi_split: Amount 4886718345, USDCFee 2882400001.
    expect(pair(splitU64(4886718345n))).toEqual([591751049n, 1n]);
    expect(pair(splitU64(2882400001n))).toEqual([2882400001n, 0n]);
  });

  test("withdraw/large_amount_lo_hi_split Amount", () => {
    // tx.json -> withdraw/large_amount_lo_hi_split: Amount 549755813887 = 2^39 - 1.
    expect(pair(splitU64(549755813887n))).toEqual([4294967295n, 127n]);
  });

  test("boundaries around the 32-bit seam", () => {
    expect(pair(splitU64(0n))).toEqual([0n, 0n]);
    expect(pair(splitU64(4294967295n))).toEqual([4294967295n, 0n]);
    expect(pair(splitU64(4294967296n))).toEqual([0n, 1n]);
    expect(pair(splitU64(18446744073709551615n))).toEqual([4294967295n, 4294967295n]);
  });

  test("both halves are always canonical and below 2^32", () => {
    for (const row of TABLE) {
      if (row.v < 0n) continue;
      const [lo, hi] = splitU64(row.v);
      expectCanonical(lo);
      expectCanonical(hi);
      expect(lo < 4294967296n).toBe(true);
      expect(hi < 4294967296n).toBe(true);
      expect(lo + hi * 4294967296n).toBe(row.v);
    }
  });
});

describe("splitI64Arith — arithmetic shift, used only by L2UpdateMargin.USDCAmount", () => {
  test("-1n splits to [4294967295, 4294967294]", () => {
    // THE TRAP: the shift happens while the value is STILL SIGNED. -1n >> 32n === -1n, and
    // toField(-1n) is 4294967294. Normalising to unsigned first and then shifting would give
    // 4294967295 for the high half — the same answer splitU64 gives, and not what the reference
    // produces. Pinned by tx.json -> update_margin/negative_minus_one.
    expect(pair(splitI64Arith(-1n))).toEqual([4294967295n, 4294967294n]);
    expect(pair(splitU64(-1n))).toEqual([4294967295n, 4294967295n]);
  });

  test("-2^32 splits to [0, 4294967294]", () => {
    // tx.json -> update_margin/negative_2_pow_32, USDCAmount "-4294967296".
    // low : -2^32 & 0xffffffff = 0
    // high: -2^32 >> 32 = -1  -> toField(-1n) = 4294967294
    expect(pair(splitI64Arith(-4294967296n))).toEqual([0n, 4294967294n]);
  });

  test("-12345678901 splits to [539222987, 4294967292]", () => {
    // tx.json -> update_margin/negative_realistic, USDCAmount "-12345678901".
    // low : 2^32 - (12345678901 mod 2^32) = 4294967296 - 3755744309 = 539222987
    // high: floor(-12345678901 / 2^32) = -3 -> toField(-3n) = 4294967292
    expect(pair(splitI64Arith(-12345678901n))).toEqual([539222987n, 4294967292n]);
  });

  test("agrees with splitU64 on every non-negative input, and only there", () => {
    for (const row of TABLE) {
      if (row.v < 0n) continue;
      expect(pair(splitI64Arith(row.v))).toEqual(pair(splitU64(row.v)));
    }
    for (const v of [-1n, -2n, -4294967296n, -12345678901n, -9223372036854775808n]) {
      expect(pair(splitI64Arith(v))).not.toEqual(pair(splitU64(v)));
    }
  });

  test("int64 minimum: high half is toField(-2^31)", () => {
    // -2^63 >> 32 = -2^31 = -2147483648; asUintN gives 2^64 - 2^31, one p above 2147483647.
    const [lo, hi] = splitI64Arith(-9223372036854775808n);
    expect<bigint>(lo).toBe(0n);
    expect(hi).toBe(toField(-2147483648n));
    expect<bigint>(hi).toBe(2147483647n);
  });

  test("every half is canonical", () => {
    for (const v of [0n, 1n, -1n, 4294967296n, -4294967296n, -12345678901n, 9223372036854775807n]) {
      const [lo, hi] = splitI64Arith(v);
      expectCanonical(lo);
      expectCanonical(hi);
    }
  });

  test("rejects an out-of-domain value rather than truncating it", () => {
    expect(thrown(() => splitI64Arith(18446744073709551616n)).code).toBe("VALUE_TOO_HIGH");
    expect(thrown(() => splitU64(-9223372036854775809n)).code).toBe("VALUE_TOO_LOW");
  });
});

/** tx.json -> txHashes -> change_pub_key -> fields.PubKeyLeHex. */
const CHANGE_PUB_KEY_HEX: string =
  "2386e091523144a70cba52660fd90382d1b30ee377e5068b43992a63a2dea9ddaf2c1c0df62bcbca";

describe("pubKeyToFieldElements", () => {
  test("decodes the change_pub_key vector's 40-byte key into 5 little-endian limbs", () => {
    const limbs = pubKeyToFieldElements(hexToBytes(CHANGE_PUB_KEY_HEX));
    expect(limbs.length).toBe(5);
    expect<bigint[]>([...limbs]).toEqual([
      12052812733454779939n,
      9368570310025198092n,
      10017946724205507537n,
      15972542342475979075n,
      14612821751715605679n,
    ]);
    for (const l of limbs) expectCanonical(l);
  });

  test("limbs are little-endian within each 8-byte group", () => {
    const bytes: Uint8Array = new Uint8Array(40);
    bytes[0] = 1; // limb 0 low byte
    bytes[15] = 1; // limb 1 high byte
    const limbs = pubKeyToFieldElements(bytes);
    expect<bigint>(limbs[0]).toBe(1n);
    expect<bigint>(limbs[1]).toBe(72057594037927936n); // 2^56
    expect<bigint>(limbs[2]).toBe(0n);
  });

  test("reduces a non-canonical limb instead of rejecting it", () => {
    // The reference's FromCanonicalLittleEndianBytesF is a raw binary.LittleEndian.Uint64 with no
    // range check, and SchnorrPkFromSk(1) genuinely yields limbs of ORDER+4. Rejecting one would
    // refuse a public key the sequencer accepts (protocol-notes §1, spec/04 §1.4).
    const bytes: Uint8Array = new Uint8Array(40);
    bytes.set(hexToBytes("05000000ffffffff"), 0); // p + 4, little-endian
    const limbs = pubKeyToFieldElements(bytes);
    expect<bigint>(limbs[0]).toBe(4n);
    for (const l of limbs) expectCanonical(l);
  });

  test("accepts a limb of exactly p, which reduces to zero", () => {
    const bytes: Uint8Array = new Uint8Array(40);
    bytes.set(hexToBytes("01000000ffffffff"), 32); // p, little-endian, in the last limb
    expect<bigint>(pubKeyToFieldElements(bytes)[4]).toBe(0n);
  });

  test("rejects lengths 0, 39 and 41 with PUBKEY_INVALID", () => {
    for (const n of [0, 39, 41]) {
      const e: LighterValidationError = thrown(() => pubKeyToFieldElements(new Uint8Array(n)));
      expect(e.code).toBe("PUBKEY_INVALID");
      expect(e.kind).toBe("validation");
    }
  });

  test("respects the byte offset of a view into a larger buffer", () => {
    const backing: Uint8Array = new Uint8Array(48);
    backing.set(hexToBytes(CHANGE_PUB_KEY_HEX), 8);
    const view: Uint8Array = backing.subarray(8, 48);
    expect<bigint>(pubKeyToFieldElements(view)[0]).toBe(12052812733454779939n);
  });
});
