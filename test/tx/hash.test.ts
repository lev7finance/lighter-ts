/**
 * `src/tx/hash.ts` — the generic transaction hasher.
 *
 * The spine is `conformance/vectors/tx.json` -> `txHashes`, generated from the Go reference. The
 * `cancel_all_orders/*` rows are used because that type's five fields exercise the universal prefix,
 * a negative account index (the sign-extension rule of `docs/protocol-notes.md` §3.1), the maximum
 * index domain, and — via `immediate_single_market` — the non-empty attribute branch of
 * `aggregateTxHash`. If one of these disagrees with the implementation, the implementation is wrong.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { Fp } from "../../src/crypto/field/fp.js";
import { LighterValidationError } from "../../src/errors.js";
import type { TxAttributes } from "../../src/tx/attributes.js";
import { TxType } from "../../src/tx/enums.js";
import { hashTx, hashTxHex, txHashElements } from "../../src/tx/hash.js";
import {
  type Enc,
  type TxLike,
  type TxSchema,
  defineTxSchema,
} from "../../src/tx/schema.js";

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
  readonly messageHashLeHex: string;
}

const vectorsUrl = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly txHashes: readonly TxHashRow[];
};

const CHAIN_ID: number = vectors.chainId;

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
 * `L2CancelAllOrders` (`spec/04-tx-types.md` §7.10), declared locally.
 *
 * This unit must not import `src/tx/schemas/**`, so the table is restated here. Hash order is
 * `AccountIndex, ApiKeyIndex, TimeInForce, Time` after the universal prefix; JSON order is
 * `AccountIndex, ApiKeyIndex, TimeInForce, Time, ExpiredAt, Nonce, Sig`.
 */
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

/** Build the transaction object a `cancel_all_orders` row describes. */
function cancelAllTx(row: TxHashRow): TxLike {
  const f: Readonly<Record<string, string>> = row.fields;
  return {
    accountIndex: BigInt(f["AccountIndex"] as string),
    apiKeyIndex: Number(f["ApiKeyIndex"] as string),
    timeInForce: Number(f["TimeInForce"] as string),
    time: BigInt(f["Time"] as string),
    expiredAt: BigInt(f["ExpiredAt"] as string),
    nonce: BigInt(f["Nonce"] as string),
    attributes: row.attributes as unknown as TxAttributes,
  } as unknown as TxLike;
}

const cancelAllRows: readonly TxHashRow[] = vectors.txHashes.filter((r) =>
  r.name.startsWith("cancel_all_orders/"),
);

function rowNamed(name: string): TxHashRow {
  const row: TxHashRow | undefined = cancelAllRows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`vector row ${name} is missing`);
  return row;
}

describe("hashTxHex against conformance vectors", () => {
  test("the expected rows are present", () => {
    expect(cancelAllRows.map((r) => r.name)).toEqual([
      "cancel_all_orders/immediate",
      "cancel_all_orders/immediate_single_market",
      "cancel_all_orders/scheduled",
      "cancel_all_orders/negative_account_index",
      "cancel_all_orders/max_indices",
    ]);
  });

  for (const row of cancelAllRows) {
    test(row.name, () => {
      expect(row.txType).toBe(TxType.L2CancelAllOrders);
      expect(hashTxHex(cancelAllSchema, cancelAllTx(row), CHAIN_ID)).toBe(row.messageHashLeHex);
    });
  }

  test("immediate_single_market really does exercise the attribute branch", () => {
    // Otherwise the non-empty aggregation path would be untested and the four rows would all pass
    // with an aggregate that ignores attributes entirely.
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate_single_market");
    expect(row.attributes).toEqual({ "5": 3 });

    const withoutAttributes: TxLike = { ...cancelAllTx(row), attributes: undefined } as TxLike;
    expect(hashTxHex(cancelAllSchema, withoutAttributes, CHAIN_ID)).not.toBe(row.messageHashLeHex);
  });
});

describe("output shape", () => {
  const tx: TxLike = cancelAllTx(rowNamed("cancel_all_orders/immediate"));

  test("hashTx is exactly 40 bytes", () => {
    const out: Uint8Array = hashTx(cancelAllSchema, tx, CHAIN_ID);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(40);
  });

  test("hashTxHex is 80 lowercase hex characters with no 0x prefix", () => {
    const hex: string = hashTxHex(cancelAllSchema, tx, CHAIN_ID);
    expect(hex).toHaveLength(80);
    expect(hex.startsWith("0x")).toBe(false);
    expect(/^[0-9a-f]{80}$/.test(hex)).toBe(true);
  });
});

describe("txHashElements", () => {
  test("the universal prefix is chainId, txType, Nonce, ExpiredAt", () => {
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate");
    const elements: readonly Fp[] = txHashElements(cancelAllSchema, cancelAllTx(row), CHAIN_ID);
    expect(elements.slice(0, 4)).toEqual([
      BigInt(CHAIN_ID),
      16n,
      11n,
      1893456000000n,
    ] as unknown as Fp[]);
  });

  test("cancel-all absorbs exactly 8 elements", () => {
    // 4 prefix + AccountIndex, ApiKeyIndex, TimeInForce, Time. `spec/04-tx-types.md` §7.10.
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate");
    expect(txHashElements(cancelAllSchema, cancelAllTx(row), CHAIN_ID)).toHaveLength(8);
  });

  test("position 4 is the account index and 5 the api-key index", () => {
    const row: TxHashRow = rowNamed("cancel_all_orders/max_indices");
    const elements: readonly Fp[] = txHashElements(cancelAllSchema, cancelAllTx(row), CHAIN_ID);
    expect(elements[4]).toBe(281474976710654n as Fp);
    expect(elements[5]).toBe(254n as Fp);
  });

  test("a negative account index sign-extends to 4294967294, not p - 1", () => {
    // `docs/protocol-notes.md` §3.1 — the whole reason `toField` exists separately from `fpFromInt`.
    const row: TxHashRow = rowNamed("cancel_all_orders/negative_account_index");
    const elements: readonly Fp[] = txHashElements(cancelAllSchema, cancelAllTx(row), CHAIN_ID);
    expect(elements[4]).toBe(4294967294n as Fp);
  });

  test("element 1 comes from the schema, not from the transaction object", () => {
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate");
    const lying: TxLike = { ...cancelAllTx(row), txType: 14, type: 14 } as TxLike;
    expect(hashTxHex(cancelAllSchema, lying, CHAIN_ID)).toBe(row.messageHashLeHex);
  });

  test("the chain id is part of the message", () => {
    const row: TxHashRow = rowNamed("cancel_all_orders/immediate");
    expect(hashTxHex(cancelAllSchema, cancelAllTx(row), CHAIN_ID + 1)).not.toBe(
      row.messageHashLeHex,
    );
  });
});

describe("encodings", () => {
  test("splitU64 and splitI64Arith contribute two elements and differ on negatives", () => {
    // `docs/protocol-notes.md` §3.2: the split is declared per field, never inferred from the value.
    const base = {
      fields: [
        { name: "accountIndex", json: "AccountIndex", enc: INT },
        { name: "amount", json: "Amount", enc: { k: "splitU64" } as Enc },
      ],
      hashOrder: ["accountIndex", "amount"],
    };
    const logical: TxSchema = defineTxSchema({ txType: TxType.L2Transfer, ...base });
    const arithmetic: TxSchema = defineTxSchema({
      txType: TxType.L2UpdateMargin,
      fields: [
        { name: "accountIndex", json: "AccountIndex", enc: INT },
        { name: "amount", json: "Amount", enc: { k: "splitI64Arith" } },
      ],
      hashOrder: ["accountIndex", "amount"],
    });
    const tx: TxLike = { nonce: 1n, expiredAt: 2n, accountIndex: 0n, amount: -1n } as TxLike;

    expect(txHashElements(logical, tx, CHAIN_ID)).toHaveLength(7);
    expect(txHashElements(logical, tx, CHAIN_ID).slice(5)).toEqual([
      4294967295n,
      4294967295n,
    ] as unknown as Fp[]);
    expect(txHashElements(arithmetic, tx, CHAIN_ID).slice(5)).toEqual([
      4294967295n,
      4294967294n,
    ] as unknown as Fp[]);
  });

  test("gfp5 contributes five elements, reduced but not rejected", () => {
    // A 0xff-filled key has every limb above the modulus; real keys do too
    // (`docs/protocol-notes.md` §1), so rejecting one would refuse a key the sequencer accepts.
    const schema: TxSchema = defineTxSchema({
      txType: TxType.L2ChangePubKey,
      fields: [{ name: "pubKey", json: "PubKey", enc: { k: "gfp5" } }],
      hashOrder: ["pubKey"],
    });
    const tx: TxLike = {
      nonce: 0n,
      expiredAt: 0n,
      pubKey: new Uint8Array(40).fill(0xff),
    } as TxLike;
    const elements: readonly Fp[] = txHashElements(schema, tx, CHAIN_ID);
    expect(elements).toHaveLength(9);
    // 0xffffffffffffffff mod p == 2^32 - 2.
    expect(elements.slice(4)).toEqual(
      [4294967294n, 4294967294n, 4294967294n, 4294967294n, 4294967294n] as unknown as Fp[],
    );
  });

  test("custom supplies its own elements — the seam grouped orders uses", () => {
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
            json(): string {
              return "[]";
            },
          },
        },
      ],
      hashOrder: ["orders"],
    });
    const tx: TxLike = { nonce: 0n, expiredAt: 0n, orders: [11n, 22n, 33n, 44n] } as TxLike;
    expect(txHashElements(schema, tx, CHAIN_ID).slice(4)).toEqual([
      11n,
      22n,
      33n,
      44n,
    ] as unknown as Fp[]);
  });
});

describe("failure modes", () => {
  const tx: TxLike = cancelAllTx(rowNamed("cancel_all_orders/immediate"));

  test("a JSON-only encoding in a hand-built hashOrder throws instead of dropping elements", () => {
    // `defineTxSchema` rejects this; a raw object literal skips that check, and a silently-dropped
    // field would change the hash of every transaction of the type.
    const raw: TxSchema = {
      txType: TxType.L2CancelAllOrders,
      fields: [{ name: "sig", json: "Sig", enc: { k: "bytesB64", len: 80 } }],
      hashOrder: ["sig"],
    };
    const withSig: TxLike = { ...tx, sig: new Uint8Array(80) } as TxLike;
    expect(thrown(() => txHashElements(raw, withSig, CHAIN_ID)).code).toBe("SCHEMA_INVALID");
  });

  test("a missing declared field is an error", () => {
    const incomplete: TxLike = { nonce: 1n, expiredAt: 2n } as TxLike;
    expect(thrown(() => hashTx(cancelAllSchema, incomplete, CHAIN_ID)).code).toBe("FIELD_MISSING");
  });

  test("a non-integral number is rejected rather than truncated", () => {
    const bad: TxLike = { ...tx, timeInForce: 1.5 } as TxLike;
    expect(thrown(() => hashTx(cancelAllSchema, bad, CHAIN_ID)).code).toBe("UNSAFE_INTEGER");
  });

  test("a string where an integer belongs is rejected", () => {
    const bad: TxLike = { ...tx, time: "0" } as unknown as TxLike;
    expect(thrown(() => hashTx(cancelAllSchema, bad, CHAIN_ID)).code).toBe("FIELD_TYPE_INVALID");
  });

  test("a nonce beyond 2^53 must be a bigint, and is exact", () => {
    const big: TxLike = { ...tx, nonce: 1152921504606846975n } as TxLike;
    expect(txHashElements(cancelAllSchema, big, CHAIN_ID)[2]).toBe(1152921504606846975n as Fp);
    const unsafe: TxLike = { ...tx, nonce: 1152921504606846975 } as TxLike;
    expect(thrown(() => hashTx(cancelAllSchema, unsafe, CHAIN_ID)).code).toBe("UNSAFE_INTEGER");
  });
});
