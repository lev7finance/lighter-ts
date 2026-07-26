/**
 * `src/client/write/transfer.ts` — scaling, routes, the conditional L1 signature, and the resume.
 *
 * The L1 assertions compare against `conformance/vectors/tx.json` → `l1Messages` byte for byte. No
 * message text is written in this file either: a test that retyped the template would pass against
 * a wrong implementation of the same typo.
 */

import { describe, expect, test } from "bun:test";

import { L1SignatureRequiredError, LighterMathError, LighterValidationError } from "../../../src/errors.js";
import type { TxReceipt } from "../../../src/client/receipt.js";
import type { L1SignatureRequired } from "../../../src/client/write/transfer.js";
import {
  NO_L1_SIGNATURE,
  isSameMasterAccount,
  transfer,
} from "../../../src/client/write/transfer.js";
import {
  CHAIN_ID,
  EXPIRED_AT,
  FAKE_L1_SIG,
  type Harness,
  SIBLING_ACCOUNT_INDEX,
  STRANGER_ACCOUNT_INDEX,
  harness,
  l1MessageVector,
  recordingSigner,
} from "./harness.js";

/** The vectors' transfer, expressed at the human tier. USDC is 6 decimals in the capture. */
const VECTOR_TRANSFER = {
  toAccountIndex: 2n,
  asset: "USDC",
  amount: "4886.718345", // 4886718345
  fromRoute: "perps",
  toRoute: "spot",
  fee: 2_882_400_001n,
  sameMasterAccount: false,
  send: { nonce: 14n, apiKeyIndex: 0 },
  tx: { expiredAt: EXPIRED_AT },
} as const;

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Scaling                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("exact scaling", () => {
  test('"8.2" USDC is 8200000, not the reference\'s 8199999', async () => {
    const h: Harness = harness();
    await transfer(h.ctx, {
      toAccountIndex: SIBLING_ACCOUNT_INDEX,
      asset: "USDC",
      amount: "8.2",
      sameMasterAccount: true,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["Amount"]).toBe(8_200_000);
    // The defect this pins, for the record: 8.2 * 1e6 === 8199999.999999999 in binary64.
    expect(Math.trunc(8.2 * 1_000_000)).toBe(8_199_999);
  });

  test('"0.4" at 8 decimals is 40000000 — ETH, resolved through the offline seed', async () => {
    const h: Harness = harness();
    await transfer(h.ctx, {
      toAccountIndex: SIBLING_ACCOUNT_INDEX,
      asset: 1, // ETH: absent from the capture, present in ASSET_DECIMALS_SEED at 8 decimals
      amount: "0.4",
      sameMasterAccount: true,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["Amount"]).toBe(40_000_000);
    expect(tx["AssetIndex"]).toBe(1);
    // Non-USDC defaults to spot → spot, the only combination the protocol allows for it.
    expect(tx["FromRouteType"]).toBe(1);
    expect(tx["ToRouteType"]).toBe(1);
  });

  test("more fractional digits than the asset carries throws rather than truncating", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      transfer(h.ctx, {
        toAccountIndex: SIBLING_ACCOUNT_INDEX,
        asset: "USDC",
        amount: "1.2345678",
        sameMasterAccount: true,
      }),
    );
    expect(error).toBeInstanceOf(LighterMathError);
    expect((error as LighterMathError).code).toBe("NOT_REPRESENTABLE");
    expect(h.paths()).toEqual([]);
  });

  test("an explicit rounding mode is honoured, and only then", async () => {
    const h: Harness = harness();
    await transfer(h.ctx, {
      toAccountIndex: SIBLING_ACCOUNT_INDEX,
      asset: "USDC",
      amount: "1.2345678",
      rounding: "FLOOR",
      sameMasterAccount: true,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["Amount"]).toBe(1_234_567);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Routes and fees                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("routes", () => {
  test("a self-transfer shuffles USDC perp → spot with no metadata reads at all", async () => {
    const h: Harness = harness();
    await transfer(h.ctx, {
      toAccountIndex: 1n, // the signing account
      asset: "USDC",
      amount: "10",
      toRoute: "spot",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["ToAccountIndex"]).toBe(1);
    expect(tx["FromRouteType"]).toBe(0);
    expect(tx["ToRouteType"]).toBe(1);
    expect(tx["USDCFee"]).toBe(0);
    // No account lookup, no fee lookup: an account is always under its own master.
    expect(h.paths()).toEqual(["/api/v1/sendTx"]);
  });

  test("a non-USDC asset may only move spot → spot", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      transfer(h.ctx, {
        toAccountIndex: SIBLING_ACCOUNT_INDEX,
        asset: "LDO",
        amount: "1",
        fromRoute: "perps",
        toRoute: "spot",
        sameMasterAccount: true,
      }),
    );
    expect(error).toBeInstanceOf(LighterValidationError);
    expect((error as LighterValidationError).code).toBe("ROUTE_TYPE_INVALID");
  });
});

describe("fees", () => {
  test("a same-master transfer is free and asks no authenticated endpoint", async () => {
    const h: Harness = harness();
    await transfer(h.ctx, {
      toAccountIndex: SIBLING_ACCOUNT_INDEX,
      asset: "USDC",
      amount: "1",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["USDCFee"]).toBe(0);
    expect(h.paths()).toEqual([
      "/api/v1/account",
      "/api/v1/accountsByL1Address",
      "/api/v1/sendTx",
    ]);
  });

  test("a cross-owner transfer takes its fee from transferFeeInfo, unchanged", async () => {
    const h: Harness = harness({ l1Signer: recordingSigner().signer });
    await transfer(h.ctx, {
      toAccountIndex: STRANGER_ACCOUNT_INDEX,
      asset: "USDC",
      amount: "1",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["USDCFee"]).toBe(10_000);
    expect(h.paths()).toEqual([
      "/api/v1/account",
      "/api/v1/accountsByL1Address",
      "/api/v1/transferFeeInfo",
      "/api/v1/sendTx",
    ]);
  });

  test("a fee the server reports beyond the safe-integer range is refused, not laundered", async () => {
    const h: Harness = harness({
      routes: {
        "/api/v1/transferFeeInfo": () => ({
          body: { code: 200, transfer_fee_usdc: 2 ** 53 + 2 },
        }),
      },
      l1Signer: recordingSigner().signer,
    });
    const error: unknown = await caught(
      transfer(h.ctx, { toAccountIndex: STRANGER_ACCOUNT_INDEX, asset: "USDC", amount: "1" }),
    );
    expect((error as LighterValidationError).code).toBe("TRANSFER_FEE_TOO_HIGH");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Same-master detection                                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("isSameMasterAccount", () => {
  test("is true for the account itself without any request", async () => {
    const h: Harness = harness();
    expect(await isSameMasterAccount(h.ctx, 1n)).toBe(true);
    expect(h.paths()).toEqual([]);
  });

  test("consults accountsByL1Address rather than index arithmetic", async () => {
    const h: Harness = harness();
    expect(await isSameMasterAccount(h.ctx, BigInt(SIBLING_ACCOUNT_INDEX))).toBe(true);
    expect(await isSameMasterAccount(h.ctx, BigInt(STRANGER_ACCOUNT_INDEX))).toBe(false);
    expect(h.paths()).toEqual([
      "/api/v1/account",
      "/api/v1/accountsByL1Address",
      "/api/v1/account",
      "/api/v1/accountsByL1Address",
    ]);
  });

  test("refuses to guess when the family cannot be read", async () => {
    const h: Harness = harness({
      routes: { "/api/v1/accountsByL1Address": () => ({ body: { code: 200, sub_accounts: [] } }) },
    });
    const error: unknown = await caught(isSameMasterAccount(h.ctx, 9n));
    expect((error as LighterValidationError).code).toBe("ACCOUNT_FAMILY_UNKNOWN");
  });

  test("refuses to guess when the account reports no l1_address", async () => {
    const h: Harness = harness({
      routes: { "/api/v1/account": () => ({ body: { code: 200, accounts: [{ index: 1 }] } }) },
    });
    const error: unknown = await caught(isSameMasterAccount(h.ctx, 9n));
    expect((error as LighterValidationError).code).toBe("L1_ADDRESS_INVALID");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The L1 gate                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("L1 signature gating", () => {
  test("a same-master transfer needs no signer and sends L1Sig as the empty 0x", async () => {
    const h: Harness = harness(); // no l1Signer at all
    await transfer(h.ctx, {
      toAccountIndex: SIBLING_ACCOUNT_INDEX,
      asset: "USDC",
      amount: "1",
      sameMasterAccount: true,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["L1Sig"]).toBe(NO_L1_SIGNATURE);
  });

  for (const row of ["transfer/empty_memo", "transfer/populated_memo"] as const) {
    test(`a cross-owner transfer with no signer throws the ${row} message verbatim`, async () => {
      const h: Harness = harness();
      const vector = l1MessageVector(row);
      const memoHex: string = vector.fields["MemoHex"] as string;
      const error: unknown = await caught(
        transfer(h.ctx, {
          ...VECTOR_TRANSFER,
          ...(row === "transfer/populated_memo" ? { memo: `0x${memoHex}` as const } : {}),
        }),
      );
      expect(error).toBeInstanceOf(L1SignatureRequiredError);
      const required: L1SignatureRequired = error as L1SignatureRequired;
      expect(required.message).toBe(vector.body);
      expect(required.template).toBe(vector.body);
      expect(required.txType).toBe(12);
      // Nothing was submitted: the refusal is before the wire, not after it.
      expect(h.paths()).toEqual([]);
    });
  }

  test("the prepared transaction resumes to the same hash the signer path produces", async () => {
    const withSigner: Harness = harness({ l1Signer: recordingSigner().signer });
    const signed: TxReceipt = await transfer(withSigner.ctx, VECTOR_TRANSFER);
    expect(withSigner.submitted()["L1Sig"]).toBe(FAKE_L1_SIG);

    const withoutSigner: Harness = harness();
    const error: unknown = await caught(transfer(withoutSigner.ctx, VECTOR_TRANSFER));
    const required: L1SignatureRequired = error as L1SignatureRequired;
    const resumed: TxReceipt = await withoutSigner.account.submitWithL1Signature(
      required.prepared,
      FAKE_L1_SIG,
    );

    expect(resumed.txHash).toBe(signed.txHash);
    expect(resumed.nonce).toBe(14n);
    // The two documents are identical except for `Sig`: the Schnorr nonce is hedged-deterministic
    // and mixes fresh randomness, so two signatures over the same message are both valid and are
    // not byte-equal (`docs/decisions.md` D2). The hash is what has to match, and does.
    const strip = (info: string): Record<string, unknown> => {
      const parsed: Record<string, unknown> = JSON.parse(info) as Record<string, unknown>;
      delete parsed["Sig"];
      return parsed;
    };
    expect(strip(resumed.txInfo)).toEqual(strip(signed.txInfo));
  });

  test("the injected signer is handed exactly the vector's message", async () => {
    const { signer, messages } = recordingSigner();
    const h: Harness = harness({ l1Signer: signer });
    await transfer(h.ctx, VECTOR_TRANSFER);
    expect(messages).toEqual([l1MessageVector("transfer/empty_memo").body]);
  });

  test("the transaction hash is independent of the memo, and the message is not", async () => {
    const memoHex: string = l1MessageVector("transfer/populated_memo").fields["MemoHex"] as string;
    const plain: Harness = harness({ l1Signer: recordingSigner().signer });
    const withMemo: Harness = harness({ l1Signer: recordingSigner().signer });
    const a: TxReceipt = await transfer(plain.ctx, VECTOR_TRANSFER);
    const b: TxReceipt = await transfer(withMemo.ctx, {
      ...VECTOR_TRANSFER,
      memo: `0x${memoHex}`,
    });
    // `Memo` is absent from the L2 hash and bound only by the L1 signature — protocol-notes §5.3.
    expect(b.txHash).toBe(a.txHash);
    expect(withMemo.submitted()["Memo"]).not.toEqual(plain.submitted()["Memo"]);
  });

  test("the memo reaches the wire as 32 JSON numbers", async () => {
    const h: Harness = harness({ l1Signer: recordingSigner().signer });
    await transfer(h.ctx, { ...VECTOR_TRANSFER, memo: `0x${"00".repeat(31)}ff` });
    const memo: unknown = h.submitted()["Memo"];
    expect(Array.isArray(memo)).toBe(true);
    expect(memo as number[]).toHaveLength(32);
    expect((memo as number[])[31]).toBe(255);
  });
});
