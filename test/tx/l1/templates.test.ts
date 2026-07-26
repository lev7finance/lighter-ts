/**
 * `src/tx/l1/templates.ts` — the five L1 message templates and their builders.
 *
 * The spine is `conformance/vectors/tx.json` → `l1Messages`, generated from the Go reference. Six
 * rows, each carrying the field map, the exact `body` and its UTF-8 bytes. Every row is checked
 * twice:
 *
 * 1. **from the field map**, through the individual builders — this pins the templates; and
 * 2. **from a constructed transaction object**, through `l1MessageFor` — this pins the
 *    transaction→argument mapping, which is where the interleaved transfer arguments and the
 *    `ApprovalExpiry`/`ExpiredAt` confusion actually live.
 *
 * A template test alone would pass with `from` and `to` swapped in the tx mapping. Both passes
 * assert `===` on the string; nothing is normalised.
 *
 * `eip191HashHex` is not checked and cannot be: producing it needs an L1 digest this package
 * deliberately does not ship (`docs/decisions.md` D6, D10). `body` and `bodyUtf8Hex` are the whole
 * contract on this side of the seam.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import { i16, i64, u8, u32 } from "../../../src/tx/brands.js";
import { TxType } from "../../../src/tx/enums.js";
import type { UnsignedTxLike } from "../../../src/tx/l1/attach.js";
import { l1MessageFor } from "../../../src/tx/l1/attach.js";
import {
  L1_TEMPLATES,
  airdropAllocationMessage,
  approveIntegratorMessage,
  changePubKeyMessage,
  createSubAccountMessage,
  transferMessage,
} from "../../../src/tx/l1/templates.js";
import type {
  ApproveIntegratorTx,
  ChangePubKeyTx,
  CreateSubAccountTx,
  TransferTx,
} from "../../../src/tx/types/account.js";
import { bytesToHex, hexToBytes } from "../../../src/util/bytes.js";

interface L1MessageRow {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyUtf8Hex: string;
}

const vectorsUrl = new URL("../../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly l1Messages: readonly L1MessageRow[];
};

/** A required decimal-or-hex field from a vector row. Missing means the vector changed shape. */
function field(row: L1MessageRow, key: string): string {
  const value: string | undefined = row.fields[key];
  if (value === undefined) {
    throw new Error(`vector row ${row.name} has no field ${key}`);
  }
  return value;
}

/** Decimal string -> bigint. Never `Number()`: `1893456000000` and friends exceed nothing yet, but
 * `Amount` reaches `2^60 - 1` and would round. */
function big(row: L1MessageRow, key: string): bigint {
  return BigInt(field(row, key));
}

/** Decimal string -> number, for the fields the protocol declares 32 bits or narrower. */
function num(row: L1MessageRow, key: string): number {
  const value: bigint = big(row, key);
  return Number(value);
}

/** The chain id a row renders, falling back to the vector file's own for rows that render none. */
function chainIdOf(row: L1MessageRow): number {
  return row.fields["ChainId"] === undefined ? vectors.chainId : num(row, "ChainId");
}

/** Build a row's message from its field map, through the per-template builders. */
function fromFields(row: L1MessageRow): string {
  if (row.name === "change_pub_key") {
    return changePubKeyMessage({
      pubKey: hexToBytes(field(row, "PubKeyLeHex")),
      nonce: big(row, "Nonce"),
      accountIndex: big(row, "AccountIndex"),
      apiKeyIndex: num(row, "ApiKeyIndex"),
    });
  }
  if (row.name.startsWith("transfer/")) {
    return transferMessage({
      nonce: big(row, "Nonce"),
      fromAccountIndex: big(row, "FromAccountIndex"),
      fromRouteType: num(row, "FromRouteType"),
      apiKeyIndex: num(row, "ApiKeyIndex"),
      toAccountIndex: big(row, "ToAccountIndex"),
      toRouteType: num(row, "ToRouteType"),
      assetIndex: num(row, "AssetIndex"),
      amount: big(row, "Amount"),
      usdcFee: big(row, "USDCFee"),
      chainId: num(row, "ChainId"),
      memo: hexToBytes(field(row, "MemoHex")),
    });
  }
  if (row.name === "approve_integrator") {
    return approveIntegratorMessage({
      nonce: big(row, "Nonce"),
      accountIndex: big(row, "AccountIndex"),
      apiKeyIndex: num(row, "ApiKeyIndex"),
      integratorAccountIndex: big(row, "IntegratorAccountIndex"),
      maxPerpsTakerFee: num(row, "MaxPerpsTakerFee"),
      maxPerpsMakerFee: num(row, "MaxPerpsMakerFee"),
      maxSpotTakerFee: num(row, "MaxSpotTakerFee"),
      maxSpotMakerFee: num(row, "MaxSpotMakerFee"),
      approvalExpiry: big(row, "ApprovalExpiry"),
      chainId: num(row, "ChainId"),
    });
  }
  if (row.name.startsWith("create_sub_account/")) {
    return createSubAccountMessage({ masterAccountIndex: big(row, "MasterAccountIndex") });
  }
  throw new Error(`unhandled vector row ${row.name}`);
}

/**
 * A transaction object carrying a row's fields.
 *
 * `expiredAt` is deliberately set to a value that appears in no message — and, for
 * `approve_integrator`, to a value *different* from `ApprovalExpiry`, so a mapping that reached for
 * the wrong deadline would produce a different string.
 */
const UNRENDERED_EXPIRED_AT: bigint = 1712345678901n;

function toTx(row: L1MessageRow): UnsignedTxLike {
  if (row.name === "change_pub_key") {
    const tx: ChangePubKeyTx = {
      type: TxType.L2ChangePubKey,
      nonce: i64(big(row, "Nonce")),
      expiredAt: i64(UNRENDERED_EXPIRED_AT),
      accountIndex: i64(big(row, "AccountIndex")),
      apiKeyIndex: u8(num(row, "ApiKeyIndex")),
      pubKey: hexToBytes(field(row, "PubKeyLeHex")),
    };
    return tx;
  }
  if (row.name.startsWith("transfer/")) {
    const tx: TransferTx = {
      type: TxType.L2Transfer,
      nonce: i64(big(row, "Nonce")),
      expiredAt: i64(UNRENDERED_EXPIRED_AT),
      fromAccountIndex: i64(big(row, "FromAccountIndex")),
      apiKeyIndex: u8(num(row, "ApiKeyIndex")),
      toAccountIndex: i64(big(row, "ToAccountIndex")),
      assetIndex: i16(num(row, "AssetIndex")),
      fromRouteType: u8(num(row, "FromRouteType")),
      toRouteType: u8(num(row, "ToRouteType")),
      amount: i64(big(row, "Amount")),
      usdcFee: i64(big(row, "USDCFee")),
      memo: hexToBytes(field(row, "MemoHex")),
    };
    return tx;
  }
  if (row.name === "approve_integrator") {
    const tx: ApproveIntegratorTx = {
      type: TxType.L2ApproveIntegrator,
      nonce: i64(big(row, "Nonce")),
      expiredAt: i64(UNRENDERED_EXPIRED_AT),
      accountIndex: i64(big(row, "AccountIndex")),
      apiKeyIndex: u8(num(row, "ApiKeyIndex")),
      integratorAccountIndex: i64(big(row, "IntegratorAccountIndex")),
      maxPerpsTakerFee: u32(num(row, "MaxPerpsTakerFee")),
      maxPerpsMakerFee: u32(num(row, "MaxPerpsMakerFee")),
      maxSpotTakerFee: u32(num(row, "MaxSpotTakerFee")),
      maxSpotMakerFee: u32(num(row, "MaxSpotMakerFee")),
      approvalExpiry: i64(big(row, "ApprovalExpiry")),
    };
    return tx;
  }
  if (row.name.startsWith("create_sub_account/")) {
    const tx: CreateSubAccountTx = {
      type: TxType.L2CreateSubAccount,
      nonce: i64(7n),
      expiredAt: i64(UNRENDERED_EXPIRED_AT),
      // The master account index is the transaction's own AccountIndex.
      accountIndex: i64(big(row, "MasterAccountIndex")),
      apiKeyIndex: u8(0),
    };
    return tx;
  }
  throw new Error(`unhandled vector row ${row.name}`);
}

describe("l1Messages vectors", () => {
  test("the vector file still carries all six rows", () => {
    expect(vectors.l1Messages.map((r: L1MessageRow): string => r.name)).toEqual([
      "change_pub_key",
      "transfer/empty_memo",
      "transfer/populated_memo",
      "approve_integrator",
      "create_sub_account/master_1",
      "create_sub_account/master_140737488355327",
    ]);
  });

  for (const row of vectors.l1Messages) {
    describe(row.name, () => {
      test("builder reproduces `body` exactly", () => {
        expect(fromFields(row)).toBe(row.body);
      });

      test("UTF-8 bytes reproduce `bodyUtf8Hex`", () => {
        expect(bytesToHex(new TextEncoder().encode(fromFields(row)))).toBe(row.bodyUtf8Hex);
      });

      test("l1MessageFor reproduces the same string from a transaction", () => {
        expect(l1MessageFor(toTx(row), chainIdOf(row))).toBe(row.body);
      });
    });
  }
});

describe("template data", () => {
  test("exactly five templates", () => {
    expect(Object.keys(L1_TEMPLATES).sort()).toEqual([
      "airdropAllocation",
      "approveIntegrator",
      "changePubKey",
      "createSubAccount",
      "transfer",
    ]);
  });

  test("the wired templates are character for character what the protocol defines", () => {
    expect(L1_TEMPLATES.changePubKey).toBe(
      "Register Lighter Account\n\npubkey: 0x%s\nnonce: %s\naccount index: %s\napi key index: %s\nOnly sign this message for a trusted client!",
    );
    expect(L1_TEMPLATES.transfer).toBe(
      "Transfer\n\nnonce: %s\nfrom: %s (route %s)\napi key: %s\nto: %s (route %s)\nasset: %s\namount: %s\nfee: %s\nchainId: %s\nmemo: %s\nOnly sign this message for a trusted client!",
    );
    expect(L1_TEMPLATES.approveIntegrator).toBe(
      "Approve Integrator\n\nnonce: %s\naccount index: %s\napi key index: %s\nintegrator account index: %s\nmax perps taker fee: %s\nmax perps maker fee: %s\nmax spot taker fee: %s\nmax spot maker fee: %s\napproval expiry: %s\nchainId: %s\nOnly sign this message for a trusted client!",
    );
    expect(L1_TEMPLATES.createSubAccount).toBe(
      "Create Lighter Sub Account\n\nmaster account index: %s\nOnly sign this message for a trusted client!",
    );
    expect(L1_TEMPLATES.airdropAllocation).toBe(
      "Airdrop Allocation\n\nallocations: %s\nchainId: %s\nOnly sign this message for a trusted client!",
    );
  });

  test("no template ends with a newline, and each has a blank line after its header", () => {
    for (const template of Object.values(L1_TEMPLATES)) {
      expect(template.endsWith("Only sign this message for a trusted client!")).toBe(true);
      expect(template.endsWith("\n")).toBe(false);
      expect(template).toContain("\n\n");
      expect(template).not.toContain("\r");
    }
  });
});

describe("builder details the vectors do not reach", () => {
  test("airdropAllocation inserts its allocations verbatim and hex16s only the chain id", () => {
    expect(airdropAllocationMessage({ allocations: "a:1,b:2", chainId: 304 })).toBe(
      "Airdrop Allocation\n\nallocations: a:1,b:2\nchainId: 0x0000000000000130\nOnly sign this message for a trusted client!",
    );
  });

  test("an argument containing %s is inserted, not re-scanned", () => {
    const message: string = airdropAllocationMessage({ allocations: "%s%s", chainId: 0 });
    expect(message).toContain("allocations: %s%s\n");
    expect(message).toContain("chainId: 0x0000000000000000\n");
  });

  test("the pubkey is 80 hex digits and the template supplies the 0x", () => {
    const pubKey: Uint8Array = new Uint8Array(40).fill(0xab);
    const message: string = changePubKeyMessage({
      pubKey,
      nonce: 0n,
      accountIndex: 0n,
      apiKeyIndex: 0,
    });
    expect(message).toContain(`pubkey: 0x${"ab".repeat(40)}\n`);
    expect(message).not.toContain("0x0x");
  });

  test("the memo is 64 hex digits with no prefix", () => {
    const memo: Uint8Array = new Uint8Array(32).fill(0xcd);
    const message: string = transferMessage({
      nonce: 0n,
      fromAccountIndex: 0n,
      fromRouteType: 0,
      apiKeyIndex: 0,
      toAccountIndex: 0n,
      toRouteType: 0,
      assetIndex: 0,
      amount: 0n,
      usdcFee: 0n,
      chainId: 0,
      memo,
    });
    expect(message).toContain(`memo: ${"cd".repeat(32)}\n`);
  });

  test("a wrong-length pubkey or memo is rejected, not padded", () => {
    expect(() =>
      changePubKeyMessage({
        pubKey: new Uint8Array(39),
        nonce: 0n,
        accountIndex: 0n,
        apiKeyIndex: 0,
      }),
    ).toThrow(LighterValidationError);
    expect(() =>
      transferMessage({
        nonce: 0n,
        fromAccountIndex: 0n,
        fromRouteType: 0,
        apiKeyIndex: 0,
        toAccountIndex: 0n,
        toRouteType: 0,
        assetIndex: 0,
        amount: 0n,
        usdcFee: 0n,
        chainId: 0,
        memo: new Uint8Array(31),
      }),
    ).toThrow(LighterValidationError);
  });

  test("transfer's argument order is the template's, not the field list's", () => {
    // Distinct values everywhere, so any transposition changes the output.
    const message: string = transferMessage({
      nonce: 1n,
      fromAccountIndex: 2n,
      fromRouteType: 3,
      apiKeyIndex: 4,
      toAccountIndex: 5n,
      toRouteType: 6,
      assetIndex: 7,
      amount: 8n,
      usdcFee: 9n,
      chainId: 10,
      memo: new Uint8Array(32),
    });
    expect(message).toBe(
      "Transfer\n\nnonce: 0x0000000000000001\nfrom: 0x0000000000000002 (route 0x0000000000000003)\n" +
        "api key: 0x0000000000000004\nto: 0x0000000000000005 (route 0x0000000000000006)\n" +
        "asset: 0x0000000000000007\namount: 0x0000000000000008\nfee: 0x0000000000000009\n" +
        "chainId: 0x000000000000000a\nmemo: " +
        "00".repeat(32) +
        "\nOnly sign this message for a trusted client!",
    );
  });

  test("approve_integrator renders ApprovalExpiry, and taker before maker", () => {
    const message: string = approveIntegratorMessage({
      nonce: 1n,
      accountIndex: 2n,
      apiKeyIndex: 3,
      integratorAccountIndex: 4n,
      maxPerpsTakerFee: 5,
      maxPerpsMakerFee: 6,
      maxSpotTakerFee: 7,
      maxSpotMakerFee: 8,
      approvalExpiry: 9n,
      chainId: 10,
    });
    expect(message).toContain("max perps taker fee: 0x0000000000000005\n");
    expect(message).toContain("max perps maker fee: 0x0000000000000006\n");
    expect(message).toContain("max spot taker fee: 0x0000000000000007\n");
    expect(message).toContain("max spot maker fee: 0x0000000000000008\n");
    expect(message).toContain("approval expiry: 0x0000000000000009\n");
    expect(message.indexOf("max perps taker fee")).toBeLessThan(
      message.indexOf("max perps maker fee"),
    );
    expect(message.indexOf("max perps maker fee")).toBeLessThan(
      message.indexOf("max spot taker fee"),
    );
  });

  test("change_pub_key and create_sub_account render no chain id", () => {
    const registration: string = changePubKeyMessage({
      pubKey: new Uint8Array(40),
      nonce: 0n,
      accountIndex: 0n,
      apiKeyIndex: 0,
    });
    expect(registration).not.toContain("chainId");
    expect(createSubAccountMessage({ masterAccountIndex: 1n })).not.toContain("chainId");
    expect(createSubAccountMessage({ masterAccountIndex: 1n })).not.toContain("nonce");
  });
});
