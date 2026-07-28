/**
 * `src/tx/serialize.ts` — the `tx_info` emitter.
 *
 * **There is no conformance vector behind this file.** All 38 `txHashes` rows in
 * `conformance/vectors/tx.json` carry `"txInfoJson": ""` — the Go oracle does not emit the JSON, so
 * nothing here can be regenerated. The golden strings below are written by hand from
 * `spec/04-tx-types.md` §9.2 (the encoding table) and §7 (the per-type key lists). Read a change to
 * one of them as a change to the interop surface, not as a fixture update; the only end-to-end
 * proof is the tagged live-testnet round-trip.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../src/errors.js";
import type { TxAttributes } from "../../src/tx/attributes.js";
import { TxType } from "../../src/tx/enums.js";
import { type Enc, type TxLike, type TxSchema, defineTxSchema } from "../../src/tx/schema.js";
import { serializeTx } from "../../src/tx/serialize.js";

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

/**
 * A synthetic transaction type that carries one field of **every** encoding at once.
 *
 * No real transaction looks like this — the type code is borrowed only so the schema is well-typed.
 * Its purpose is that a single golden string pins all seven JSON projections, so a regression in
 * any one of them fails here rather than on a testnet submission six units later.
 */
const kitchenSinkSchema: TxSchema = defineTxSchema({
  txType: TxType.L2ChangePubKey,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "index", json: "Index", enc: INT },
    { name: "amount", json: "Amount", enc: { k: "splitU64" } },
    { name: "usdcAmount", json: "USDCAmount", enc: { k: "splitI64Arith" } },
    { name: "pubKey", json: "PubKey", enc: { k: "gfp5" } },
    { name: "sig", json: "Sig", enc: { k: "bytesB64", len: 80 } },
    { name: "memo", json: "Memo", enc: { k: "byteArray", len: 32 } },
    { name: "l1Sig", json: "L1Sig", enc: { k: "hexString" } },
    {
      name: "orders",
      json: "Orders",
      enc: {
        k: "custom",
        elements: () => [],
        json(value: unknown): string {
          return `[${(value as readonly bigint[]).map((v) => v.toString(10)).join(",")}]`;
        },
      },
    },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "index", "amount", "usdcAmount", "pubKey"],
});

/** 80 bytes 0x00..0x4f — a `[]byte` slice, so base64. */
const SIG: Uint8Array = Uint8Array.from({ length: 80 }, (_, i) => i);
/** 40 bytes of 0xff — every limb above the modulus, which the JSON must carry verbatim. */
const PUBKEY: Uint8Array = new Uint8Array(40).fill(0xff);
/** 32 bytes 0x00..0x1f — a Go `[32]byte` array, so a number list. */
const MEMO: Uint8Array = Uint8Array.from({ length: 32 }, (_, i) => i);

const kitchenSinkTx: TxLike = {
  accountIndex: -1n,
  apiKeyIndex: 254,
  index: 1152921504606846975n,
  amount: 4294967296n,
  usdcAmount: -12345678901n,
  pubKey: PUBKEY,
  sig: SIG,
  memo: MEMO,
  l1Sig: `0x${"ab".repeat(65)}`,
  orders: [7n, 9n],
  expiredAt: 1893456000000n,
  nonce: 11n,
} as unknown as TxLike;

/**
 * The golden document. Written out key by key, in Go declaration order, with `L2TxAttributes` last.
 *
 * - `Index` is `2^60 - 1`, past `2^53`, and is emitted as literal digits — this is the case
 *   `JSON.stringify` cannot express and `JSON.parse` silently rounds.
 * - `Amount` and `USDCAmount` are split into two elements each for the hash and appear here as a
 *   single plain number: the split never reaches the wire.
 * - `PubKey` is 40 bytes -> 56 base64 characters; `Sig` is 80 bytes -> 108. Both `=`-padded.
 * - `Memo` is a 32-number array, not base64. Go writes `[32]byte` and `[]byte` differently.
 */
const GOLDEN: string =
  "{" +
  '"AccountIndex":-1,' +
  '"ApiKeyIndex":254,' +
  '"Index":1152921504606846975,' +
  '"Amount":4294967296,' +
  '"USDCAmount":-12345678901,' +
  '"PubKey":"/////////////////////////////////////////////////////w==",' +
  '"Sig":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk8=",' +
  '"Memo":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],' +
  '"L1Sig":"0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab",' +
  '"Orders":[7,9],' +
  '"ExpiredAt":1893456000000,' +
  '"Nonce":11,' +
  '"L2TxAttributes":null' +
  "}";

describe("the golden document", () => {
  test("every encoding, exactly", () => {
    expect(serializeTx(kitchenSinkSchema, kitchenSinkTx)).toBe(GOLDEN);
  });

  test("the base64 lengths are the ones the spec quotes", () => {
    // 80 bytes -> 108 characters, 40 bytes -> 56. A short Sig is a well-formed string the sequencer
    // rejects as a bad signature, which is expensive to diagnose from a 403.
    const sigValue: string = GOLDEN.split('"Sig":"')[1]?.split('"')[0] ?? "";
    const pubKeyValue: string = GOLDEN.split('"PubKey":"')[1]?.split('"')[0] ?? "";
    expect(sigValue).toHaveLength(108);
    expect(pubKeyValue).toHaveLength(56);
    expect(sigValue.endsWith("=")).toBe(true);
    expect(pubKeyValue.endsWith("==")).toBe(true);
  });

  test("the L1Sig is 132 characters including 0x", () => {
    const l1: string = GOLDEN.split('"L1Sig":"')[1]?.split('"')[0] ?? "";
    expect(l1).toHaveLength(132);
    expect(l1.startsWith("0x")).toBe(true);
  });

  test("starts with { and carries no SignedHash", () => {
    // The reference uses the leading brace as its sanity gate (§9.1), and `SignedHash` is
    // `json:"-"` — it goes back to the caller out-of-band as the transaction hash.
    const out: string = serializeTx(kitchenSinkSchema, kitchenSinkTx);
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
    expect(out).not.toContain("SignedHash");
  });

  test("L2TxAttributes is last and always present", () => {
    const out: string = serializeTx(kitchenSinkSchema, kitchenSinkTx);
    expect(out.endsWith(',"L2TxAttributes":null}')).toBe(true);
  });
});

describe("64-bit integers survive", () => {
  test("2^60 - 1 appears as literal digits, unquoted", () => {
    const out: string = serializeTx(kitchenSinkSchema, kitchenSinkTx);
    expect(out).toContain('"Index":1152921504606846975,');
    // What a JSON.parse round trip would have produced instead.
    expect(out).not.toContain("1152921504606847000");
    expect(out).not.toContain('"1152921504606846975"');
  });

  test("no exponent notation anywhere", () => {
    expect(serializeTx(kitchenSinkSchema, kitchenSinkTx)).not.toContain("e+");
  });

  test("a plain number field is emitted as decimal digits too", () => {
    expect(serializeTx(kitchenSinkSchema, kitchenSinkTx)).toContain('"ApiKeyIndex":254,');
  });
});

describe("attributes", () => {
  const schema: TxSchema = defineTxSchema({
    txType: TxType.L2CancelAllOrders,
    fields: [
      { name: "accountIndex", json: "AccountIndex", enc: INT },
      { name: "timeInForce", json: "TimeInForce", enc: INT },
    ],
    hashOrder: ["accountIndex", "timeInForce"],
  });
  const base = { nonce: 0n, expiredAt: 0n, accountIndex: 1n, timeInForce: 0 };

  test("an absent map is null, not omitted and not {}", () => {
    expect(serializeTx(schema, base as unknown as TxLike)).toBe(
      '{"AccountIndex":1,"TimeInForce":0,"L2TxAttributes":null}',
    );
  });

  test("an empty map is also null", () => {
    const tx: TxLike = { ...base, attributes: {} as TxAttributes } as unknown as TxLike;
    expect(serializeTx(schema, tx)).toContain('"L2TxAttributes":null');
  });

  test("a populated map has decimal-string keys in ascending order", () => {
    const tx: TxLike = {
      ...base,
      attributes: { 4: 1, 1: 42 } as unknown as TxAttributes,
    } as unknown as TxLike;
    expect(serializeTx(schema, tx)).toBe(
      '{"AccountIndex":1,"TimeInForce":0,"L2TxAttributes":{"1":42,"4":1}}',
    );
  });

  test("zero values are still emitted — nothing uses omitempty", () => {
    expect(serializeTx(schema, base as unknown as TxLike)).toContain('"TimeInForce":0');
  });
});

describe("the custom seam", () => {
  test("the caller's json callback is used verbatim", () => {
    // This is how `src/tx/grouped-hash.ts` will emit the flattened OrderInfo array without this
    // module knowing anything about orders.
    const schema: TxSchema = defineTxSchema({
      txType: TxType.L2CreateGroupedOrders,
      fields: [
        {
          name: "orders",
          json: "Orders",
          enc: {
            k: "custom",
            elements: () => [],
            json(value: unknown): string {
              return `[{"MarketIndex":${String(value)}}]`;
            },
          },
        },
      ],
      hashOrder: [],
    });
    const tx: TxLike = { nonce: 0n, expiredAt: 0n, orders: 3 } as unknown as TxLike;
    expect(serializeTx(schema, tx)).toBe('{"Orders":[{"MarketIndex":3}],"L2TxAttributes":null}');
  });
});

describe("failure modes", () => {
  function sink(overrides: Readonly<Record<string, unknown>>): TxLike {
    return { ...(kitchenSinkTx as unknown as Record<string, unknown>), ...overrides } as TxLike;
  }

  test("an absent declared field is an error, not a skipped key", () => {
    const partial: Record<string, unknown> = {
      ...(kitchenSinkTx as unknown as Record<string, unknown>),
    };
    delete partial["memo"];
    expect(thrown(() => serializeTx(kitchenSinkSchema, partial as TxLike)).code).toBe(
      "FIELD_MISSING",
    );
  });

  test("a short Sig is rejected", () => {
    expect(thrown(() => serializeTx(kitchenSinkSchema, sink({ sig: new Uint8Array(79) }))).code).toBe(
      "FIELD_LENGTH_INVALID",
    );
  });

  test("a PubKey of the wrong length is rejected", () => {
    expect(
      thrown(() => serializeTx(kitchenSinkSchema, sink({ pubKey: new Uint8Array(32) }))).code,
    ).toBe("FIELD_LENGTH_INVALID");
  });

  test("a Memo of the wrong length is rejected", () => {
    expect(
      thrown(() => serializeTx(kitchenSinkSchema, sink({ memo: new Uint8Array(31) }))).code,
    ).toBe("FIELD_LENGTH_INVALID");
  });

  test("an unprefixed, uppercase or odd-length L1Sig is rejected", () => {
    for (const bad of [`${"ab".repeat(65)}`, `0x${"AB".repeat(65)}`, "0xabc"]) {
      expect(thrown(() => serializeTx(kitchenSinkSchema, sink({ l1Sig: bad }))).code).toBe(
        "HEX_STRING_INVALID",
      );
    }
  });

  test("a string where an integer belongs is rejected, not quoted", () => {
    expect(thrown(() => serializeTx(kitchenSinkSchema, sink({ index: "12" }))).code).toBe(
      "FIELD_TYPE_INVALID",
    );
  });

  test("a non-integral number is rejected rather than emitted as 1.5", () => {
    expect(thrown(() => serializeTx(kitchenSinkSchema, sink({ apiKeyIndex: 1.5 }))).code).toBe(
      "UNSAFE_INTEGER",
    );
  });

  test("a number past 2^53 is rejected — it must be a bigint to be exact", () => {
    expect(
      thrown(() => serializeTx(kitchenSinkSchema, sink({ apiKeyIndex: 2 ** 53 }))).code,
    ).toBe("UNSAFE_INTEGER");
  });
});
