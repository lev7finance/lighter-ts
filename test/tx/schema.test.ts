/**
 * `src/tx/schema.ts` — the declarative vocabulary.
 *
 * There is no conformance vector for a *schema*; what is testable here is that the consistency
 * checks actually fire. Each one of them stands in for a defect that would otherwise reach the
 * sequencer as a wrong hash or a malformed body: a duplicated field name resolves to the wrong
 * encoding, a `hashOrder` entry with no field silently drops elements, and a `Sig` in `hashOrder`
 * puts a signature inside the message it signs.
 */

import { describe, expect, test } from "bun:test";

import type { Fp } from "../../src/crypto/field/fp.js";
import { LighterValidationError } from "../../src/errors.js";
import { TxType } from "../../src/tx/enums.js";
import {
  ATTRIBUTES_JSON_KEY,
  type Enc,
  type TxLike,
  type TxSchema,
  type TxSchemaRegistry,
  createTxSchemaRegistry,
  defineTxSchema,
  isHashable,
  readTxField,
  requireTxSchema,
  schemaField,
} from "../../src/tx/schema.js";

/** Capture the thrown value so `code` can be inspected, not just the class. */
function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but nothing was thrown");
}

const INT: Enc = { k: "int" };

/** Mirrors `L2CancelAllOrders` (`spec/04-tx-types.md` §7.10): JSON order, then hash order. */
const cancelAllSchema: TxSchema = defineTxSchema({
  txType: TxType.L2CancelAllOrders,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "timeInForce", json: "TimeInForce", enc: INT },
    { name: "time", json: "Time", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: { k: "bytesB64", len: 80 } },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "timeInForce", "time"],
});

describe("isHashable", () => {
  test("element-producing encodings are hashable", () => {
    expect(isHashable({ k: "int" })).toBe(true);
    expect(isHashable({ k: "splitU64" })).toBe(true);
    expect(isHashable({ k: "splitI64Arith" })).toBe(true);
    expect(isHashable({ k: "gfp5" })).toBe(true);
    expect(
      isHashable({
        k: "custom",
        elements: () => [],
        json: () => "null",
      }),
    ).toBe(true);
  });

  test("Sig, Memo and L1Sig encodings are JSON-only", () => {
    expect(isHashable({ k: "bytesB64", len: 80 })).toBe(false);
    expect(isHashable({ k: "byteArray", len: 32 })).toBe(false);
    expect(isHashable({ k: "hexString" })).toBe(false);
  });
});

describe("the two lists are separate", () => {
  test("Nonce and ExpiredAt are JSON fields but not in hashOrder", () => {
    const jsonKeys: readonly string[] = cancelAllSchema.fields.map((f) => f.json);
    expect(jsonKeys).toContain("Nonce");
    expect(jsonKeys).toContain("ExpiredAt");
    expect(cancelAllSchema.hashOrder).not.toContain("nonce");
    expect(cancelAllSchema.hashOrder).not.toContain("expiredAt");
  });

  test("Sig is a JSON field only", () => {
    expect(cancelAllSchema.fields.map((f) => f.json)).toContain("Sig");
    expect(cancelAllSchema.hashOrder).not.toContain("sig");
  });

  test("hashOrder begins at the account-index field", () => {
    expect(cancelAllSchema.hashOrder[0]).toBe("accountIndex");
    expect(cancelAllSchema.hashOrder[1]).toBe("apiKeyIndex");
  });
});

describe("schemaField", () => {
  test("resolves by TS property name, not by wire key", () => {
    expect(schemaField(cancelAllSchema, "timeInForce").json).toBe("TimeInForce");
    expect(thrown(() => schemaField(cancelAllSchema, "TimeInForce")).code).toBe(
      "SCHEMA_FIELD_UNKNOWN",
    );
  });
});

describe("readTxField", () => {
  const tx: TxLike = { nonce: 1n, expiredAt: 2n } as TxLike;

  test("returns the declared value, including a legitimate zero", () => {
    const withZero: TxLike = { nonce: 0n, expiredAt: 0n, time: 0n } as unknown as TxLike;
    expect(readTxField(withZero, "time")).toBe(0n);
  });

  test("an absent field is an error, never an implied zero", () => {
    // Nothing in the protocol uses `omitempty`; a missing property is a construction bug.
    expect(thrown(() => readTxField(tx, "time")).code).toBe("FIELD_MISSING");
  });

  test("null is treated as absent", () => {
    const withNull: TxLike = { nonce: 0n, expiredAt: 0n, sig: null } as unknown as TxLike;
    expect(thrown(() => readTxField(withNull, "sig")).code).toBe("FIELD_MISSING");
  });
});

describe("defineTxSchema", () => {
  test("rejects a duplicate property name", () => {
    const e: LighterValidationError = thrown(() =>
      defineTxSchema({
        txType: TxType.L2CancelOrder,
        fields: [
          { name: "index", json: "Index", enc: INT },
          { name: "index", json: "Other", enc: INT },
        ],
        hashOrder: ["index"],
      }),
    );
    expect(e.code).toBe("SCHEMA_INVALID");
    expect(e.message).toContain("duplicate field name");
  });

  test("rejects a duplicate wire key", () => {
    const e: LighterValidationError = thrown(() =>
      defineTxSchema({
        txType: TxType.L2CancelOrder,
        fields: [
          { name: "a", json: "Index", enc: INT },
          { name: "b", json: "Index", enc: INT },
        ],
        hashOrder: [],
      }),
    );
    expect(e.message).toContain("duplicate JSON key");
  });

  test("rejects a field claiming the L2TxAttributes key", () => {
    const e: LighterValidationError = thrown(() =>
      defineTxSchema({
        txType: TxType.L2CancelOrder,
        fields: [{ name: "attrs", json: ATTRIBUTES_JSON_KEY, enc: INT }],
        hashOrder: [],
      }),
    );
    expect(e.message).toContain(ATTRIBUTES_JSON_KEY);
  });

  test("rejects a hashOrder entry with no matching field", () => {
    // The failure this prevents: elements silently missing from every hash of this type.
    expect(
      thrown(() =>
        defineTxSchema({
          txType: TxType.L2CancelOrder,
          fields: [{ name: "index", json: "Index", enc: INT }],
          hashOrder: ["indx"],
        }),
      ).code,
    ).toBe("SCHEMA_FIELD_UNKNOWN");
  });

  test("rejects a repeated hashOrder entry", () => {
    expect(
      thrown(() =>
        defineTxSchema({
          txType: TxType.L2CancelOrder,
          fields: [{ name: "index", json: "Index", enc: INT }],
          hashOrder: ["index", "index"],
        }),
      ).message,
    ).toContain("twice in hashOrder");
  });

  test("rejects a JSON-only encoding in hashOrder", () => {
    for (const enc of [
      { k: "bytesB64", len: 80 },
      { k: "byteArray", len: 32 },
      { k: "hexString" },
    ] as const satisfies readonly Enc[]) {
      const e: LighterValidationError = thrown(() =>
        defineTxSchema({
          txType: TxType.L2CancelOrder,
          fields: [{ name: "x", json: "X", enc }],
          hashOrder: ["x"],
        }),
      );
      expect(e.code).toBe("SCHEMA_INVALID");
      expect(e.message).toContain("cannot be hashed");
    }
  });

  test("copies and freezes, so a later mutation of the source arrays cannot change the schema", () => {
    const fields = [{ name: "index", json: "Index", enc: INT }];
    const hashOrder = ["index"];
    const schema: TxSchema = defineTxSchema({
      txType: TxType.L2CancelOrder,
      fields,
      hashOrder,
    });
    fields.push({ name: "sneaky", json: "Sneaky", enc: INT });
    hashOrder.push("sneaky");
    expect(schema.fields).toHaveLength(1);
    expect(schema.hashOrder).toEqual(["index"]);
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.fields)).toBe(true);
  });
});

describe("the custom seam", () => {
  // `{k:'custom'}` exists so `src/tx/grouped-hash.ts` can supply the OrderInfo fold without this
  // module importing it — that import would be a cycle. This proves the callbacks are carried
  // verbatim and invoked with the field's raw value.
  const legs: readonly bigint[] = [7n, 9n];
  const schema: TxSchema = defineTxSchema({
    txType: TxType.L2CreateGroupedOrders,
    fields: [
      {
        name: "orders",
        json: "Orders",
        enc: {
          k: "custom",
          elements(value: unknown): readonly Fp[] {
            return (value as readonly bigint[]).map((v) => v as Fp);
          },
          json(value: unknown): string {
            return `[${(value as readonly bigint[]).map((v) => v.toString(10)).join(",")}]`;
          },
        },
      },
    ],
    hashOrder: ["orders"],
  });

  test("custom is hashable and its callbacks round-trip the raw value", () => {
    const enc: Enc = schemaField(schema, "orders").enc;
    expect(enc.k).toBe("custom");
    if (enc.k !== "custom") throw new Error("unreachable");
    expect(enc.elements(legs)).toEqual([7n, 9n] as unknown as readonly Fp[]);
    expect(enc.json(legs)).toBe("[7,9]");
  });
});

describe("registry", () => {
  test("looks a schema up by tx type", () => {
    const registry: TxSchemaRegistry = createTxSchemaRegistry([cancelAllSchema]);
    expect(requireTxSchema(registry, TxType.L2CancelAllOrders)).toBe(cancelAllSchema);
  });

  test("an unregistered type is an error, not undefined", () => {
    const registry: TxSchemaRegistry = createTxSchemaRegistry([cancelAllSchema]);
    expect(thrown(() => requireTxSchema(registry, TxType.L2CreateOrder)).code).toBe(
      "SCHEMA_TX_TYPE_UNKNOWN",
    );
  });

  test("two schemas cannot claim the same tx type", () => {
    expect(
      thrown(() => createTxSchemaRegistry([cancelAllSchema, cancelAllSchema])).code,
    ).toBe("SCHEMA_INVALID");
  });
});
