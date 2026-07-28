/**
 * `src/tx/schemas/account.ts` and `src/tx/types/account.ts` — the fifteen non-order schemas.
 *
 * The spine is `conformance/vectors/tx.json` → `txHashes`, generated from the Go reference. Twenty
 * of its thirty-eight rows belong to the fifteen codes registered here, and the driver below is
 * **data-driven over the file**: it selects rows by `txType` membership in the registry, builds the
 * transaction object from the row's own `fields` map, and fails if a row carries a field key no
 * schema consumes. Adding a row to `tx.json` for one of these codes therefore either passes or
 * fails; it cannot be silently ignored.
 *
 * If a vector disagrees with the schema, the schema is wrong.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { TxAttributes } from "../../src/tx/attributes.js";
import { i16, i64, u8, u16, u32, u64 } from "../../src/tx/brands.js";
import { TxType } from "../../src/tx/enums.js";
import { hashTxHex } from "../../src/tx/hash.js";
import {
  ACCOUNT_TX_SCHEMAS,
  ACCOUNT_TX_SCHEMA_LIST,
  UPDATE_MARGIN_SCHEMA,
} from "../../src/tx/schemas/account.js";
import {
  type FieldSpec,
  type TxLike,
  type TxSchema,
  defineTxSchema,
  requireTxSchema,
} from "../../src/tx/schema.js";
import { serializeTx } from "../../src/tx/serialize.js";
import type {
  ApproveIntegratorTx,
  ChangePubKeyTx,
  CreateSubAccountTx,
  TransferTx,
  UpdateMarginTx,
  WithdrawTx,
} from "../../src/tx/types/account.js";
import { bytesToHex, hexToBytes } from "../../src/util/bytes.js";

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

/**
 * The vector file spells one key differently from the wire.
 *
 * `PubKeyLeHex` is the 40 raw bytes as hex; the wire key is `PubKey` and carries their base64. The
 * alias is declared rather than inferred so an unrecognised vector key stays an error.
 */
const VECTOR_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  PubKey: "PubKeyLeHex",
});

/**
 * Build the transaction object a vector row describes, driven entirely by the schema.
 *
 * Every schema field is looked up in the row by its wire key (through {@link VECTOR_KEY_ALIASES}).
 * Integer encodings are read as `bigint` — exact at any width, and the hasher and serialiser both
 * accept `bigint` for the narrow fields too. `Sig`, `L1Sig` and `Memo` are absent from every row
 * (the oracle does not sign, and `Memo` is not hashed), which is fine: neither is in `hashOrder`.
 *
 * Throws if the row carries a key no schema field claims — that is the "row added and left
 * unhandled" gate.
 */
function buildTx(schema: TxSchema, row: TxHashRow): TxLike {
  const tx: Record<string, unknown> = {};
  const consumed: Set<string> = new Set<string>();

  for (const field of schema.fields) {
    const vectorKey: string = VECTOR_KEY_ALIASES[field.json] ?? field.json;
    const raw: string | undefined = row.fields[vectorKey];
    if (raw === undefined) continue;
    consumed.add(vectorKey);
    switch (field.enc.k) {
      case "int":
      case "splitU64":
      case "splitI64Arith":
        tx[field.name] = BigInt(raw);
        break;
      case "gfp5":
        tx[field.name] = hexToBytes(raw);
        break;
      default:
        throw new Error(
          `row ${row.name}: field ${field.json} has encoding ${field.enc.k}, which no vector supplies`,
        );
    }
  }

  const unhandled: string[] = Object.keys(row.fields).filter((k: string) => !consumed.has(k));
  if (unhandled.length > 0) {
    throw new Error(
      `row ${row.name} (txType ${String(row.txType)}) carries field(s) no schema claims: ${unhandled.join(", ")}`,
    );
  }

  const attributes: Record<number, number> = {};
  for (const [k, v] of Object.entries(row.attributes)) attributes[Number(k)] = v;
  return { ...tx, attributes: attributes as TxAttributes } as unknown as TxLike;
}

/** The vector rows belonging to the fifteen codes this unit owns. */
const ACCOUNT_ROWS: readonly TxHashRow[] = vectors.txHashes.filter((r: TxHashRow) =>
  ACCOUNT_TX_SCHEMAS.has(r.txType as never),
);

/* -------------------------------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------------------------- */

describe("the account-family registry", () => {
  test("holds exactly the fifteen non-order codes", () => {
    expect([...ACCOUNT_TX_SCHEMAS.keys()].slice().sort((a: number, b: number) => a - b)).toEqual([
      8, 9, 10, 11, 12, 13, 18, 19, 20, 29, 35, 36, 41, 42, 45,
    ]);
  });

  test("the list and the map agree, and every schema self-reports its own code", () => {
    expect(ACCOUNT_TX_SCHEMA_LIST.length).toBe(ACCOUNT_TX_SCHEMAS.size);
    for (const schema of ACCOUNT_TX_SCHEMA_LIST) {
      expect(requireTxSchema(ACCOUNT_TX_SCHEMAS, schema.txType)).toBe(schema);
    }
  });

  test("no schema hashes Nonce, ExpiredAt, Sig, L1Sig or Memo", () => {
    for (const schema of ACCOUNT_TX_SCHEMA_LIST) {
      const hashedJsonKeys: readonly string[] = schema.hashOrder.map(
        (n: string) => (schema.fields.find((f: FieldSpec) => f.name === n) as FieldSpec).json,
      );
      for (const forbidden of ["Nonce", "ExpiredAt", "Sig", "L1Sig", "Memo"]) {
        expect(hashedJsonKeys).not.toContain(forbidden);
      }
    }
  });

  test("every hashOrder starts with the account index then the api-key index", () => {
    for (const schema of ACCOUNT_TX_SCHEMA_LIST) {
      const first: string = schema.hashOrder[0] as string;
      expect(["accountIndex", "fromAccountIndex"]).toContain(first);
      expect(schema.hashOrder[1]).toBe("apiKeyIndex");
    }
  });

  test("only codes 8, 12 and 45 declare an L1Sig field", () => {
    const withL1: number[] = ACCOUNT_TX_SCHEMA_LIST.filter((s: TxSchema) =>
      s.fields.some((f: FieldSpec) => f.json === "L1Sig"),
    ).map((s: TxSchema) => s.txType as number);
    expect(withL1.slice().sort((a: number, b: number) => a - b)).toEqual([8, 12, 45]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The vectors
 * ---------------------------------------------------------------------------------------------- */

describe("conformance/vectors/tx.json -> txHashes", () => {
  test("covers all twenty account-family rows", () => {
    expect(ACCOUNT_ROWS.map((r: TxHashRow) => r.name)).toEqual([
      "transfer/large_amount_lo_hi_split",
      "transfer/small_amount",
      "withdraw/large_amount_lo_hi_split",
      "update_leverage/cross",
      "update_leverage/isolated",
      "update_margin/add",
      "update_margin/negative_minus_one",
      "update_margin/negative_2_pow_32",
      "update_margin/negative_realistic",
      "change_pub_key",
      "create_sub_account",
      "mint_shares",
      "burn_shares",
      "stake_assets",
      "unstake_assets",
      "update_account_config",
      "update_account_asset_config",
      "approve_integrator",
      "create_public_pool",
      "update_public_pool",
    ]);
  });

  test("every one of the fifteen codes is exercised by at least one row", () => {
    const exercised: Set<number> = new Set<number>(ACCOUNT_ROWS.map((r: TxHashRow) => r.txType));
    for (const code of ACCOUNT_TX_SCHEMAS.keys()) expect(exercised.has(code)).toBe(true);
  });

  for (const row of ACCOUNT_ROWS) {
    test(`${row.name} (type ${String(row.txType)}) hashes to messageHashLeHex`, () => {
      const schema: TxSchema = requireTxSchema(ACCOUNT_TX_SCHEMAS, row.txType as never);
      expect(hashTxHex(schema, buildTx(schema, row), CHAIN_ID)).toBe(row.messageHashLeHex);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * The arithmetic shift on code 29
 * ---------------------------------------------------------------------------------------------- */

/**
 * `UPDATE_MARGIN_SCHEMA` with `USDCAmount` switched to the logical split — the plausible wrong
 * answer, and the one a suite of positive amounts cannot distinguish from the right one.
 */
const UPDATE_MARGIN_LOGICAL_SPLIT: TxSchema = defineTxSchema({
  txType: UPDATE_MARGIN_SCHEMA.txType,
  fields: UPDATE_MARGIN_SCHEMA.fields.map((f: FieldSpec) =>
    f.name === "usdcAmount" ? { ...f, enc: { k: "splitU64" as const } } : f,
  ),
  hashOrder: UPDATE_MARGIN_SCHEMA.hashOrder,
});

describe("L2UpdateMargin uses the arithmetic shift", () => {
  const marginRows: readonly TxHashRow[] = ACCOUNT_ROWS.filter(
    (r: TxHashRow) => r.txType === TxType.L2UpdateMargin,
  );

  test("switching USDCAmount to splitU64 breaks exactly the three negative rows", () => {
    const broken: string[] = [];
    for (const row of marginRows) {
      const hash: string = hashTxHex(
        UPDATE_MARGIN_LOGICAL_SPLIT,
        buildTx(UPDATE_MARGIN_SCHEMA, row),
        CHAIN_ID,
      );
      if (hash !== row.messageHashLeHex) broken.push(row.name);
    }
    expect(broken).toEqual([
      "update_margin/negative_minus_one",
      "update_margin/negative_2_pow_32",
      "update_margin/negative_realistic",
    ]);
  });

  test("the positive row is identical under either split, which is why it proves nothing", () => {
    const add: TxHashRow = marginRows.find(
      (r: TxHashRow) => r.name === "update_margin/add",
    ) as TxHashRow;
    expect(hashTxHex(UPDATE_MARGIN_LOGICAL_SPLIT, buildTx(UPDATE_MARGIN_SCHEMA, add), CHAIN_ID)).toBe(
      add.messageHashLeHex,
    );
  });

  test("Direction is absorbed after the amount limbs, not before", () => {
    expect(UPDATE_MARGIN_SCHEMA.hashOrder).toEqual([
      "accountIndex",
      "apiKeyIndex",
      "marketIndex",
      "usdcAmount",
      "direction",
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * JSON key order and emission
 * ---------------------------------------------------------------------------------------------- */

/** The JSON key order each `spec/04-tx-types.md` §7 subsection specifies, `L2TxAttributes` last. */
const EXPECTED_JSON_KEYS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  8: ["AccountIndex", "ApiKeyIndex", "PubKey", "L1Sig", "ExpiredAt", "Nonce", "Sig", "L2TxAttributes"],
  9: ["AccountIndex", "ApiKeyIndex", "ExpiredAt", "Nonce", "Sig", "L2TxAttributes"],
  10: [
    "AccountIndex",
    "ApiKeyIndex",
    "OperatorFee",
    "InitialTotalShares",
    "MinOperatorShareRate",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  11: [
    "AccountIndex",
    "ApiKeyIndex",
    "PublicPoolIndex",
    "Status",
    "OperatorFee",
    "MinOperatorShareRate",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  12: [
    "FromAccountIndex",
    "ApiKeyIndex",
    "ToAccountIndex",
    "AssetIndex",
    "FromRouteType",
    "ToRouteType",
    "Amount",
    "USDCFee",
    "Memo",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L1Sig",
    "L2TxAttributes",
  ],
  13: [
    "FromAccountIndex",
    "ApiKeyIndex",
    "AssetIndex",
    "RouteType",
    "Amount",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  18: [
    "AccountIndex",
    "ApiKeyIndex",
    "PublicPoolIndex",
    "ShareAmount",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  19: [
    "AccountIndex",
    "ApiKeyIndex",
    "PublicPoolIndex",
    "ShareAmount",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  20: [
    "AccountIndex",
    "ApiKeyIndex",
    "MarketIndex",
    "InitialMarginFraction",
    "MarginMode",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  29: [
    "AccountIndex",
    "ApiKeyIndex",
    "MarketIndex",
    "USDCAmount",
    "Direction",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  35: [
    "AccountIndex",
    "ApiKeyIndex",
    "StakingPoolIndex",
    "ShareAmount",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  36: [
    "AccountIndex",
    "ApiKeyIndex",
    "StakingPoolIndex",
    "ShareAmount",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  41: [
    "AccountIndex",
    "ApiKeyIndex",
    "AccountTradingMode",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  42: [
    "AccountIndex",
    "ApiKeyIndex",
    "AssetIndex",
    "AssetMarginMode",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L2TxAttributes",
  ],
  45: [
    "AccountIndex",
    "ApiKeyIndex",
    "IntegratorAccountIndex",
    "MaxPerpsTakerFee",
    "MaxPerpsMakerFee",
    "MaxSpotTakerFee",
    "MaxSpotMakerFee",
    "ApprovalExpiry",
    "ExpiredAt",
    "Nonce",
    "Sig",
    "L1Sig",
    "L2TxAttributes",
  ],
});

describe("JSON key order matches spec/04-tx-types.md §7", () => {
  for (const schema of ACCOUNT_TX_SCHEMA_LIST) {
    test(`type ${String(schema.txType)}`, () => {
      const declared: string[] = schema.fields.map((f: FieldSpec) => f.json);
      declared.push("L2TxAttributes");
      expect(declared).toEqual(EXPECTED_JSON_KEYS[schema.txType] as string[]);
    });
  }
});

/* -------------------------------------------------------------------------------------------------
 * Serialisation, on concrete typed transaction objects
 *
 * These double as the compile-time proof that `src/tx/types/account.ts` describes what the schemas
 * read: every property below is minted through a branded constructor.
 * ---------------------------------------------------------------------------------------------- */

const SIG_BYTES: Uint8Array = new Uint8Array(80).fill(0xab);
const L1_SIG_HEX = `0x${"cd".repeat(65)}` as const;

/** Extract the JSON keys of a flat `tx_info` document, in emission order. */
function jsonKeys(text: string): string[] {
  return [...text.matchAll(/"([A-Za-z0-9]+)":/g)].map((m: RegExpMatchArray) => m[1] as string);
}

describe("serializeTx over the account-family types", () => {
  test("a TransferTx emits Memo as 32 numbers and carries L1Sig", () => {
    const memo: Uint8Array = new Uint8Array(32);
    memo[0] = 1;
    memo[31] = 255;
    const tx: TransferTx & { readonly sig: Uint8Array } = {
      type: TxType.L2Transfer,
      fromAccountIndex: i64(1),
      apiKeyIndex: u8(0),
      toAccountIndex: i64(2),
      assetIndex: i16(3),
      fromRouteType: u8(0),
      toRouteType: u8(1),
      amount: i64(4886718345n),
      usdcFee: i64(0),
      memo,
      expiredAt: i64(1893456000000n),
      nonce: i64(14),
      sig: SIG_BYTES,
      l1Sig: L1_SIG_HEX,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2Transfer),
      tx,
    );

    expect(json).toContain(`"Memo":[1,${"0,".repeat(30)}255]`);
    expect(json).not.toContain('"Memo":"');
    expect(json).toContain(`"L1Sig":"${L1_SIG_HEX}"`);
    // The split is an absorption detail: the wire carries the whole value, once.
    expect(json).toContain('"Amount":4886718345');
    expect(json).toContain('"USDCFee":0');
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[12] as string[]);
  });

  test("a CreateSubAccountTx has no L1Sig key at all", () => {
    const tx: CreateSubAccountTx & { readonly sig: Uint8Array } = {
      type: TxType.L2CreateSubAccount,
      accountIndex: i64(1),
      apiKeyIndex: u8(0),
      expiredAt: i64(1893456000000n),
      nonce: i64(21),
      sig: SIG_BYTES,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2CreateSubAccount),
      tx,
    );

    expect(json).not.toContain("L1Sig");
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[9] as string[]);
    expect(json).toBe(
      '{"AccountIndex":1,"ApiKeyIndex":0,"ExpiredAt":1893456000000,"Nonce":21,' +
        `"Sig":"${json.split('"Sig":"')[1]?.split('"')[0] ?? ""}","L2TxAttributes":null}`,
    );
  });

  test("a ChangePubKeyTx emits PubKey as 56-character padded base64 of the original 40 bytes", () => {
    const row: TxHashRow = ACCOUNT_ROWS.find(
      (r: TxHashRow) => r.name === "change_pub_key",
    ) as TxHashRow;
    const pubKey: Uint8Array = hexToBytes(row.fields["PubKeyLeHex"] as string);
    expect(pubKey.length).toBe(40);

    const tx: ChangePubKeyTx & { readonly sig: Uint8Array } = {
      type: TxType.L2ChangePubKey,
      accountIndex: i64(1),
      apiKeyIndex: u8(0),
      pubKey,
      l1Sig: L1_SIG_HEX,
      expiredAt: i64(1893456000000n),
      nonce: i64(20),
      sig: SIG_BYTES,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2ChangePubKey),
      tx,
    );

    const encoded: string = json.split('"PubKey":"')[1]?.split('"')[0] ?? "";
    expect(encoded.length).toBe(56);
    expect(encoded.endsWith("==")).toBe(true);
    // Round-tripping the base64 must give back the exact bytes, not a re-encoding of the reduced
    // field elements — real keys carry limbs above the modulus (docs/protocol-notes.md §1).
    expect(bytesToHex(pubKey)).toBe(row.fields["PubKeyLeHex"] as string);
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[8] as string[]);
  });

  test("a WithdrawTx serialises its uint64 amount exactly", () => {
    const tx: WithdrawTx & { readonly sig: Uint8Array } = {
      type: TxType.L2Withdraw,
      fromAccountIndex: i64(1),
      apiKeyIndex: u8(0),
      assetIndex: i16(3),
      routeType: u8(0),
      amount: u64(1152921504606846975n),
      expiredAt: i64(1893456000000n),
      nonce: i64(16),
      sig: SIG_BYTES,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2Withdraw),
      tx,
    );
    expect(json).toContain('"Amount":1152921504606846975');
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[13] as string[]);
  });

  test("an UpdateMarginTx serialises a negative USDCAmount as one signed decimal", () => {
    const tx: UpdateMarginTx & { readonly sig: Uint8Array } = {
      type: TxType.L2UpdateMargin,
      accountIndex: i64(1),
      apiKeyIndex: u8(0),
      marketIndex: i16(1),
      usdcAmount: i64(-12345678901n),
      direction: u8(0),
      expiredAt: i64(1893456000000n),
      nonce: i64(38),
      sig: SIG_BYTES,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2UpdateMargin),
      tx,
    );
    expect(json).toContain('"USDCAmount":-12345678901');
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[29] as string[]);
  });

  test("an ApproveIntegratorTx emits all four fee caps and the expiry, L1Sig last before attributes", () => {
    const tx: ApproveIntegratorTx & { readonly sig: Uint8Array } = {
      type: TxType.L2ApproveIntegrator,
      accountIndex: i64(1),
      apiKeyIndex: u8(0),
      integratorAccountIndex: i64(4242),
      maxPerpsTakerFee: u32(1000),
      maxPerpsMakerFee: u32(500),
      maxSpotTakerFee: u32(800),
      maxSpotMakerFee: u32(400),
      approvalExpiry: i64(1893456000000n),
      expiredAt: i64(1893456000000n),
      nonce: i64(28),
      sig: SIG_BYTES,
      l1Sig: L1_SIG_HEX,
    };
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2ApproveIntegrator),
      tx,
    );
    expect(jsonKeys(json)).toEqual(EXPECTED_JSON_KEYS[45] as string[]);
    expect(json).toContain('"ApprovalExpiry":1893456000000');
  });

  test("zero values are still emitted — nothing uses omitempty", () => {
    const tx = {
      type: TxType.L2UpdateAccountConfig,
      accountIndex: i64(0),
      apiKeyIndex: u8(0),
      accountTradingMode: u8(0),
      expiredAt: i64(0),
      nonce: i64(0),
      sig: SIG_BYTES,
    } as const;
    const json: string = serializeTx(
      requireTxSchema(ACCOUNT_TX_SCHEMAS, TxType.L2UpdateAccountConfig),
      tx,
    );
    expect(json).toContain('"AccountTradingMode":0');
    expect(json).toContain('"Nonce":0');
    expect(json.endsWith('"L2TxAttributes":null}')).toBe(true);
  });

  test("the U16 and I16 brands cover the pool and market fields", () => {
    // Compile-time coverage of the widths declared in src/tx/types/account.ts.
    expect(u16(10000)).toBe(10000 as ReturnType<typeof u16>);
    expect(i16(-1)).toBe(-1 as ReturnType<typeof i16>);
  });
});
