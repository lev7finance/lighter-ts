/**
 * `src/tx/attributes.ts` — registry, validation, normalisation, hashing and aggregation.
 *
 * The conformance rows in `conformance/vectors/tx.json` -> `attributeHashes` are the spine of this
 * file. They are generated from the Go reference; if one disagrees with the implementation, the
 * implementation is wrong.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { Fp } from "../../src/crypto/field/fp.js";
import type { Fp5 } from "../../src/crypto/field/fp5.js";
import { hashToQuinticExtension } from "../../src/crypto/poseidon2/index.js";
import { LighterValidationError, isLighterError } from "../../src/errors.js";
import {
  ATTRIBUTE_REGISTRY,
  type AttributeType,
  type TxAttributes,
  aggregateTxHash,
  attributeTypeSlots,
  attributesAreEmpty,
  attributesHash,
  attributesToJson,
  normalizeAttributes,
  validateAttributes,
} from "../../src/tx/attributes.js";
import { bytesToHex } from "../../src/util/bytes.js";

interface AttributeHashRow {
  readonly attributes: Readonly<Record<string, number>>;
  readonly isEmpty: boolean;
  readonly attributesHash: readonly string[];
  readonly inputTxHash: readonly string[];
  readonly aggregatedLeBytesHex: string;
}

const vectorsUrl = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly attributeHashes: readonly AttributeHashRow[];
};

/** The vector's string keys are numeric attribute types; JS object keys are strings either way. */
function asAttributes(raw: Readonly<Record<string, number>>): TxAttributes {
  return raw as unknown as TxAttributes;
}

function asFp5(limbs: readonly string[]): Fp5 {
  const [a, b, c, d, e] = limbs.map((s) => BigInt(s) as Fp);
  return [a ?? 0n, b ?? 0n, c ?? 0n, d ?? 0n, e ?? 0n] as Fp5;
}

/** Element-wise brand, so a literal list can be fed to the hasher without a whole-array cast. */
function fps(...v: readonly bigint[]): readonly Fp[] {
  return v.map((x) => x as Fp);
}

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

describe("registry", () => {
  test("matches spec/04-tx-types.md §6.1 row for row", () => {
    expect(
      Object.values(ATTRIBUTE_REGISTRY).map((s) => [s.type, s.name, s.min, s.max, s.nil]),
    ).toEqual([
      [1, "IntegratorAccountIndex", 0, 281474976710654, 0],
      [2, "IntegratorTakerFee", 0, 1000000, 0],
      [3, "IntegratorMakerFee", 0, 1000000, 0],
      [4, "SkipTxNonce", 1, 1, 0],
      [5, "CancelAllMarketIndex", 0, 255, 255],
      [6, "SelfTradeBehaviorMode", 0, 3, 0],
      [7, "SelfTradeEqualityMode", 0, 1, 0],
    ]);
  });

  test("CancelAllMarketIndex's nil is 255 and sits inside its own legal range", () => {
    // THE TRAP. Every other type nils at 0, and 0 is a *meaningful* market index here.
    const spec = ATTRIBUTE_REGISTRY[5];
    expect(spec.nil).toBe(255);
    expect(spec.nil >= spec.min && spec.nil <= spec.max).toBe(true);
  });

  test("the largest legal attribute value is a safe integer", () => {
    // Justifies `number` rather than `bigint` for attribute values.
    expect(Number.isSafeInteger(ATTRIBUTE_REGISTRY[1].max)).toBe(true);
    expect(ATTRIBUTE_REGISTRY[1].max).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  test("per-type range error codes are the ones §12 names", () => {
    expect(Object.values(ATTRIBUTE_REGISTRY).map((s) => s.rangeErrorCode)).toEqual([
      "INTEGRATOR_ACCOUNT_INDEX_RANGE",
      "INTEGRATOR_FEE_RANGE",
      "INTEGRATOR_FEE_RANGE",
      "NONCE_SKIP_ATTRIBUTE_INVALID",
      "CANCEL_ALL_MARKET_INDEX_RANGE",
      "SELF_TRADE_BEHAVIOR_MODE_RANGE",
      "SELF_TRADE_EQUALITY_MODE_RANGE",
    ]);
  });
});

describe("conformance — tx.json attributeHashes", () => {
  test("the vector file carries all six rows", () => {
    expect(vectors.attributeHashes.length).toBe(6);
  });

  test("inputTxHash is independently derivable, so aggregation is fed the right thing", () => {
    // If this fails, every aggregatedLeBytesHex assertion below is meaningless: the oracle would
    // be aggregating something other than what we think it is.
    const derived: Fp5 = hashToQuinticExtension(fps(304n, 1n, 2n, 3n, 4n));
    for (const row of vectors.attributeHashes) {
      expect(derived.map((x) => x.toString())).toEqual([...row.inputTxHash]);
    }
  });

  for (const row of vectors.attributeHashes) {
    const label = JSON.stringify(row.attributes);

    test(`${label} — attributesHash`, () => {
      const a = asAttributes(row.attributes);
      expect(attributesHash(a).map((x) => x.toString())).toEqual([...row.attributesHash]);
    });

    test(`${label} — isEmpty`, () => {
      expect(attributesAreEmpty(asAttributes(row.attributes))).toBe(row.isEmpty);
    });

    test(`${label} — aggregateTxHash`, () => {
      const bytes = aggregateTxHash(asFp5(row.inputTxHash), asAttributes(row.attributes));
      expect(bytes.length).toBe(40);
      expect(bytesToHex(bytes)).toBe(row.aggregatedLeBytesHex);
    });
  }
});

describe("aggregateTxHash — the two branches", () => {
  const txHash: Fp5 = hashToQuinticExtension(fps(304n, 1n, 2n, 3n, 4n));
  const empty = vectors.attributeHashes[0] as AttributeHashRow;

  test("the empty case serialises the tx hash directly — it does NOT re-hash", () => {
    // THE TRAP. Hashing again "for uniformity" breaks all 20 transaction types at once.
    const direct = aggregateTxHash(txHash, undefined);
    expect(bytesToHex(direct)).toBe(empty.aggregatedLeBytesHex);

    const rehashed = hashToQuinticExtension([...txHash, ...attributesHash({})]);
    expect(rehashed.map((x) => x.toString())).not.toEqual(txHash.map((x) => x.toString()));
  });

  test("undefined, {}, {6:0} and {5:255} all aggregate identically", () => {
    const want = bytesToHex(aggregateTxHash(txHash, undefined));
    for (const a of [{}, { 6: 0 }, { 5: 255 }, { 4: 0 }] as TxAttributes[]) {
      expect(bytesToHex(aggregateTxHash(txHash, a))).toBe(want);
    }
  });

  test("combined is tx hash FIRST, attribute hash second", () => {
    const a: TxAttributes = { 4: 1 };
    const attr = attributesHash(a);
    const rightWayRound = hashToQuinticExtension([...txHash, ...attr]);
    const backwards = hashToQuinticExtension([...attr, ...txHash]);

    const got = bytesToHex(aggregateTxHash(txHash, a));
    expect(got).toBe(bytesToHex(fp5Bytes(rightWayRound)));
    expect(got).not.toBe(bytesToHex(fp5Bytes(backwards)));
  });

  function fp5Bytes(v: Fp5): Uint8Array {
    // Re-derive via the module under test's empty branch rather than importing fp5ToBytes twice.
    return aggregateTxHash(v, undefined);
  }
});

describe("attributesHash — the 8-element absorb list", () => {
  test("the absorb list is exactly [t0,v0,t1,v1,t2,v2,t3,v3]", () => {
    const row = vectors.attributeHashes[3] as AttributeHashRow;
    const interleaved = hashToQuinticExtension(fps(1n, 777n, 2n, 1000n, 3n, 500n, 0n, 0n));
    expect(interleaved.map((x) => x.toString())).toEqual([...row.attributesHash]);

    // Types-then-values, an easy transposition to make, is a different hash.
    const grouped = hashToQuinticExtension(fps(1n, 2n, 3n, 0n, 777n, 1000n, 500n, 0n));
    expect(grouped.map((x) => x.toString())).not.toEqual([...row.attributesHash]);
  });

  test("the trailing [0,0] pairs are absorbed, and are indistinguishable from omitting them", () => {
    // Worth pinning explicitly because it is easy to mis-generalise in either direction. The
    // sponge does not pad partial blocks (docs/protocol-notes.md §2), so trailing zeros land in
    // lanes that were already zero. Emitting the full 8 elements is what the reference does and is
    // what this module does; it happens to agree with a truncated list only because the padding is
    // at the *end*. Interleaving order (above) is where the real damage lives.
    const a: TxAttributes = { 4: 1 };
    expect(attributesHash(a).map((x) => x.toString())).toEqual([
      ...(vectors.attributeHashes[1] as AttributeHashRow).attributesHash,
    ]);
    const truncated = hashToQuinticExtension(fps(4n, 1n));
    expect(truncated.map((x) => x.toString())).toEqual([
      ...(vectors.attributeHashes[1] as AttributeHashRow).attributesHash,
    ]);
  });

  test("the empty set still hashes eight zeros — it is not short-circuited", () => {
    const eightZeros = hashToQuinticExtension(fps(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n));
    expect(attributesHash({}).map((x) => x.toString())).toEqual(
      eightZeros.map((x) => x.toString()),
    );
  });

  test("insertion order does not change the hash", () => {
    const forwards = attributesHash({ 1: 777, 2: 1000, 3: 500 });
    const backwards = attributesHash({ 3: 500, 1: 777, 2: 1000 });
    expect(backwards.map((x) => x.toString())).toEqual(forwards.map((x) => x.toString()));
  });

  test("{5:0} is market 0 and hashes differently from the nil {5:255}", () => {
    const market0 = attributesHash({ 5: 0 });
    const nil = attributesHash({ 5: 255 });
    expect(market0.map((x) => x.toString())).not.toEqual(nil.map((x) => x.toString()));
    expect(nil.map((x) => x.toString())).toEqual(attributesHash({}).map((x) => x.toString()));
  });
});

describe("attributeTypeSlots", () => {
  test("empty map pads to four zeros", () => {
    expect(attributeTypeSlots({})).toEqual([0, 0, 0, 0]);
    expect(attributeTypeSlots(undefined)).toEqual([0, 0, 0, 0]);
  });

  test("one entry occupies slot 0, trailing zeros stay put", () => {
    expect(attributeTypeSlots({ 4: 1 })).toEqual([4, 0, 0, 0]);
  });

  test("unsorted insertion order sorts ascending across the populated prefix", () => {
    expect(attributeTypeSlots({ 3: 500, 1: 777, 2: 1000 })).toEqual([1, 2, 3, 0]);
  });

  test("high types sort too", () => {
    expect(attributeTypeSlots({ 7: 1, 6: 2 })).toEqual([6, 7, 0, 0]);
  });

  test("nil-valued entries never take a slot", () => {
    expect(attributeTypeSlots({ 2: 0, 5: 255, 4: 1 })).toEqual([4, 0, 0, 0]);
    expect(attributeTypeSlots({ 5: 0 })).toEqual([5, 0, 0, 0]);
  });
});

describe("attributesAreEmpty", () => {
  test("absent and {} are empty", () => {
    expect(attributesAreEmpty(undefined)).toBe(true);
    expect(attributesAreEmpty({})).toBe(true);
  });

  test("{6:0} is empty — a present entry equal to its nil does not count", () => {
    expect(attributesAreEmpty({ 6: 0 })).toBe(true);
  });

  test("{5:255} is empty but {5:0} is not", () => {
    expect(attributesAreEmpty({ 5: 255 })).toBe(true);
    expect(attributesAreEmpty({ 5: 0 })).toBe(false);
  });

  test("a single non-nil entry among nils is enough to be non-empty", () => {
    expect(attributesAreEmpty({ 2: 0, 3: 0, 5: 255, 4: 1 })).toBe(false);
  });
});

describe("normalizeAttributes", () => {
  test("drops every nil-valued entry", () => {
    expect(normalizeAttributes({ 2: 0, 5: 255, 4: 1 })).toEqual({ 4: 1 });
  });

  test("keeps {5:0} — market 0 is meaningful", () => {
    expect(normalizeAttributes({ 5: 0 })).toEqual({ 5: 0 });
  });

  test("undefined normalises to an empty object", () => {
    expect(normalizeAttributes(undefined)).toEqual({});
  });

  test("is idempotent and does not mutate its input", () => {
    const input: TxAttributes = { 3: 0, 1: 42 };
    const once = normalizeAttributes(input);
    expect(normalizeAttributes(once)).toEqual(once);
    expect(input).toEqual({ 3: 0, 1: 42 });
  });

  test("emits keys in ascending numeric order", () => {
    expect(Object.keys(normalizeAttributes({ 4: 1, 1: 42 }))).toEqual(["1", "4"]);
  });
});

describe("validateAttributes — §6.2 in order, §12 identities", () => {
  test("absent and empty pass", () => {
    expect(() => {
      validateAttributes(undefined);
    }).not.toThrow();
    expect(() => {
      validateAttributes({});
    }).not.toThrow();
  });

  test("five entries -> TOO_MANY_ATTRIBUTES, before any type check", () => {
    const tooMany = { 1: 1, 2: 1, 3: 1, 4: 1, 8: 1 } as unknown as TxAttributes;
    const e = thrown(() => {
      validateAttributes(tooMany);
    });
    expect(e.code).toBe("TOO_MANY_ATTRIBUTES");
    expect(e.message).toBe("Too many attributes, should not be larger than 4");
  });

  test("unknown type -> ATTRIBUTE_TYPE_INVALID carrying the offending type", () => {
    const e = thrown(() => {
      validateAttributes({ 8: 1 } as unknown as TxAttributes);
    });
    expect(e.code).toBe("ATTRIBUTE_TYPE_INVALID");
    expect(e.message).toBe("Attribute type is invalid: 8");
  });

  test("type 0 is the padding sentinel, not a usable attribute", () => {
    expect(thrown(() => {
      validateAttributes({ 0: 1 } as unknown as TxAttributes);
    }).code).toBe("ATTRIBUTE_TYPE_INVALID");
  });

  const rangeCases: ReadonlyArray<
    readonly [label: string, attrs: TxAttributes, code: string, message: string]
  > = [
    [
      "type 1 above max",
      { 1: 281474976710655 },
      "INTEGRATOR_ACCOUNT_INDEX_RANGE",
      "IntegratorAccountIndex is in invalid range",
    ],
    ["type 1 below min", { 1: -1 }, "INTEGRATOR_ACCOUNT_INDEX_RANGE", "IntegratorAccountIndex is in invalid range"],
    [
      "type 2 above FeeTick",
      { 1: 1, 2: 1000001 },
      "INTEGRATOR_FEE_RANGE",
      "Integrator fees are in invalid range",
    ],
    [
      "type 3 above FeeTick",
      { 1: 1, 3: 1000001 },
      "INTEGRATOR_FEE_RANGE",
      "Integrator fees are in invalid range",
    ],
    ["type 4 = 2", { 4: 2 }, "NONCE_SKIP_ATTRIBUTE_INVALID", "Nonce skip attribute is invalid"],
    [
      "type 5 = 256",
      { 5: 256 },
      "CANCEL_ALL_MARKET_INDEX_RANGE",
      "Cancel all for market index attribute is in invalid range",
    ],
    [
      "type 6 = 4",
      { 6: 4 },
      "SELF_TRADE_BEHAVIOR_MODE_RANGE",
      "SelfTradeBehaviorMode is in invalid range",
    ],
    [
      "type 7 = 2",
      { 7: 2 },
      "SELF_TRADE_EQUALITY_MODE_RANGE",
      "SelfTradeEqualityMode is in invalid range",
    ],
  ];

  for (const [label, attrs, code, message] of rangeCases) {
    test(`range: ${label} -> ${code}`, () => {
      const e = thrown(() => {
        validateAttributes(attrs);
      });
      expect(e.code).toBe(code);
      expect(e.message).toBe(message);
    });
  }

  test("{4:0} is BOTH nil and out of range — validation rejects it", () => {
    // SkipTxNonce is the one type whose nil value (0) falls outside its own range ([1, 1]).
    // §6.2 step 3 iterates the raw map, so a present nil entry is still range-checked and this
    // throws — even though §6.4 would have dropped it before hashing. The option constructor never
    // produces it (§6.7 includes type 4 only when the value is 1), so the two rules never collide
    // in practice; a hand-built map hits the range error, which is the reference's behaviour.
    expect(thrown(() => {
      validateAttributes({ 4: 0 });
    }).code).toBe("NONCE_SKIP_ATTRIBUTE_INVALID");
    // Hashing, which never validates, still treats it as nil.
    expect(attributesAreEmpty({ 4: 0 })).toBe(true);
  });

  test("boundary values are accepted", () => {
    expect(() => {
      validateAttributes({ 1: 281474976710654, 2: 1000000, 3: 1000000 });
    }).not.toThrow();
    expect(() => {
      validateAttributes({ 5: 0 });
    }).not.toThrow();
    expect(() => {
      validateAttributes({ 5: 255 });
    }).not.toThrow();
  });

  test("{2:250} without an integrator index -> INTEGRATOR_REQUIRED_FOR_FEES", () => {
    const e = thrown(() => {
      validateAttributes({ 2: 250 });
    });
    expect(e.code).toBe("INTEGRATOR_REQUIRED_FOR_FEES");
    expect(e.message).toBe(
      "IntegratorAccountIndex should be non-zero when integrator taker fee or maker fee is non-zero",
    );
  });

  test("a maker fee alone also requires the index", () => {
    expect(thrown(() => {
      validateAttributes({ 3: 250 });
    }).code).toBe("INTEGRATOR_REQUIRED_FOR_FEES");
  });

  test("{1:0, 2:250} still fails — index 0 is the nil value", () => {
    expect(thrown(() => {
      validateAttributes({ 1: 0, 2: 250 });
    }).code).toBe("INTEGRATOR_REQUIRED_FOR_FEES");
  });

  test("{1:4242, 2:250, 6:1} -> SELF_TRADE_SPEC_WITH_FEES", () => {
    const e = thrown(() => {
      validateAttributes({ 1: 4242, 2: 250, 6: 1 });
    });
    expect(e.code).toBe("SELF_TRADE_SPEC_WITH_FEES");
    expect(e.message).toBe("Self-trade specification isn't allowed with integrator fees");
  });

  test("{6:3, 7:1} -> SELF_TRADE_REDUCE_WITH_MAI", () => {
    const e = thrown(() => {
      validateAttributes({ 6: 3, 7: 1 });
    });
    expect(e.code).toBe("SELF_TRADE_REDUCE_WITH_MAI");
    expect(e.message).toBe(
      "Reduce self-trade behavior mode isn't allowed with master account index equality mode",
    );
  });

  test("the reduce/MAI check reads the raw map, so a missing key is 0 and does not fire", () => {
    expect(() => {
      validateAttributes({ 6: 3 });
    }).not.toThrow();
    expect(() => {
      validateAttributes({ 7: 1 });
    }).not.toThrow();
    expect(() => {
      validateAttributes({ 6: 2, 7: 1 });
    }).not.toThrow();
  });

  test("every vector row validates", () => {
    for (const row of vectors.attributeHashes) {
      expect(() => {
        validateAttributes(asAttributes(row.attributes));
      }).not.toThrow();
    }
  });

  test("a non-integral value is rejected rather than silently truncated", () => {
    expect(thrown(() => {
      validateAttributes({ 1: 1.5 });
    }).code).toBe("UNSAFE_INTEGER");
  });
});

describe("attributesToJson", () => {
  test("absent -> the literal string null", () => {
    expect(attributesToJson(undefined)).toBe("null");
  });

  test("keys ascend numerically, values are unquoted integers", () => {
    expect(attributesToJson({ 4: 1, 1: 42 })).toBe('{"1":42,"4":1}');
  });

  test("an all-nil map serialises as null, matching the hash", () => {
    // Deviation #1: nil entries are dropped, so JSON and hash never disagree.
    expect(attributesToJson({})).toBe("null");
    expect(attributesToJson({ 2: 0, 5: 255 })).toBe("null");
  });

  test("nil entries are dropped from a mixed map", () => {
    expect(attributesToJson({ 2: 0, 5: 255, 4: 1 })).toBe('{"4":1}');
  });

  test("{5:0} survives — it is market 0, not nil", () => {
    expect(attributesToJson({ 5: 0 })).toBe('{"5":0}');
  });

  test("the largest legal value prints in full decimal, no exponent, no n suffix", () => {
    const json = attributesToJson({ 1: 281474976710654 });
    expect(json).toBe('{"1":281474976710654}');
    expect(json).not.toContain("e");
    expect(json).not.toContain("n");
  });

  test("round-trips through JSON.parse to the same map", () => {
    const a: TxAttributes = { 1: 4242, 2: 250, 3: 100 };
    const parsed = JSON.parse(attributesToJson(a)) as Record<string, number>;
    for (const key of Object.keys(parsed)) {
      expect(parsed[key]).toBe(a[Number(key) as AttributeType] as number);
    }
  });
});
