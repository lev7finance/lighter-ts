/**
 * `src/client/write/account-config.ts` — codes 41, 42 and 9.
 *
 * The interesting one is code 9: it needs an Ethereum signature and has no field to carry it, so
 * the assertions are that the refusal happens, that its text is the vector's, and that the
 * submitted document still has exactly four keys plus the signature and attributes.
 */

import { describe, expect, test } from "bun:test";

import { L1SignatureRequiredError, LighterValidationError } from "../../../src/errors.js";
import type { TxReceipt } from "../../../src/client/receipt.js";
import type { L1SignatureRequired } from "../../../src/client/write/transfer.js";
import {
  createSubAccount,
  setAccountTradingMode,
  setAssetMarginMode,
} from "../../../src/client/write/account-config.js";
import {
  EXPIRED_AT,
  FAKE_L1_SIG,
  type Harness,
  harness,
  l1MessageVector,
  recordingSigner,
} from "./harness.js";

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("setAccountTradingMode", () => {
  test('"uta" is 1 and "simple" is 0', async () => {
    const uta: Harness = harness();
    await setAccountTradingMode(uta.ctx, "uta", { send: { nonce: 1n, apiKeyIndex: 0 } });
    expect(uta.submitted()["AccountTradingMode"]).toBe(1);

    const simple: Harness = harness();
    await setAccountTradingMode(simple.ctx, "simple", { send: { nonce: 1n, apiKeyIndex: 0 } });
    expect(simple.submitted()["AccountTradingMode"]).toBe(0);
  });

  test("an unknown mode is refused before anything is sent", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      setAccountTradingMode(h.ctx, "unified" as "uta", { send: { nonce: 1n, apiKeyIndex: 0 } }),
    );
    expect((error as LighterValidationError).code).toBe("ACCOUNT_TRADING_MODE_INVALID");
    expect(h.paths()).toEqual([]);
  });
});

describe("setAssetMarginMode", () => {
  test("resolves the symbol through the registry and encodes the flag", async () => {
    const on: Harness = harness();
    await setAssetMarginMode(on.ctx, "USDC", true, { send: { nonce: 1n, apiKeyIndex: 0 } });
    expect(on.submitted()["AssetIndex"]).toBe(3);
    expect(on.submitted()["AssetMarginMode"]).toBe(1);

    const off: Harness = harness();
    await setAssetMarginMode(off.ctx, 9, false, { send: { nonce: 1n, apiKeyIndex: 0 } });
    expect(off.submitted()["AssetIndex"]).toBe(9);
    expect(off.submitted()["AssetMarginMode"]).toBe(0);
  });

  test("an unknown asset never reaches the wire", async () => {
    const h: Harness = harness();
    await caught(setAssetMarginMode(h.ctx, "NOPE", true));
    expect(h.paths()).toEqual([]);
  });
});

describe("createSubAccount", () => {
  for (const [row, accountIndex] of [
    ["create_sub_account/master_1", 1n],
    ["create_sub_account/master_140737488355327", 140_737_488_355_327n],
  ] as const) {
    test(`with no signer it throws the ${row} message verbatim`, async () => {
      const h: Harness = harness({ accountIndex });
      const error: unknown = await caught(
        createSubAccount(h.ctx, { send: { nonce: 3n, apiKeyIndex: 0 }, tx: { expiredAt: EXPIRED_AT } }),
      );
      expect(error).toBeInstanceOf(L1SignatureRequiredError);
      const required: L1SignatureRequired = error as L1SignatureRequired;
      expect(required.message).toBe(l1MessageVector(row).body);
      expect(required.txType).toBe(9);
      expect(h.paths()).toEqual([]);
    });
  }

  test("with a signer it submits, and the L1 signature is not in the document", async () => {
    const { signer, messages } = recordingSigner();
    const h: Harness = harness({ l1Signer: signer });
    const receipt: TxReceipt = await createSubAccount(h.ctx, {
      send: { nonce: 3n, apiKeyIndex: 0 },
      tx: { expiredAt: EXPIRED_AT },
    });
    expect(messages).toEqual([l1MessageVector("create_sub_account/master_1").body]);
    expect(receipt.txType).toBe(9);
    // Code 9's body is exactly these keys: adding an `L1Sig` would corrupt every creation.
    expect(Object.keys(h.submitted())).toEqual([
      "AccountIndex",
      "ApiKeyIndex",
      "ExpiredAt",
      "Nonce",
      "Sig",
      "L2TxAttributes",
    ]);
  });

  test("the refusal resumes to the same transaction the signer path submits", async () => {
    const signed: Harness = harness({ l1Signer: recordingSigner().signer });
    const first: TxReceipt = await createSubAccount(signed.ctx, {
      send: { nonce: 3n, apiKeyIndex: 0 },
      tx: { expiredAt: EXPIRED_AT },
    });

    const refused: Harness = harness();
    const error: unknown = await caught(
      createSubAccount(refused.ctx, {
        send: { nonce: 3n, apiKeyIndex: 0 },
        tx: { expiredAt: EXPIRED_AT },
      }),
    );
    const resumed: TxReceipt = await refused.account.submitWithL1Signature(
      (error as L1SignatureRequired).prepared,
      FAKE_L1_SIG,
    );
    expect(resumed.txHash).toBe(first.txHash);
  });
});
