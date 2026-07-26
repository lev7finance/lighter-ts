/**
 * `src/client/write/integrator.ts` — code 45.
 *
 * The subject is the L1 gate: two of the three "no signature needed" cases are decided without any
 * I/O at all, the third asks the account family, and the case that does need one refuses with the
 * vector's message.
 */

import { describe, expect, test } from "bun:test";

import { L1SignatureRequiredError, LighterValidationError } from "../../../src/errors.js";
import type { TxReceipt } from "../../../src/client/receipt.js";
import type { SystemConfig } from "../../../src/models/market.js";
import type { L1SignatureRequired } from "../../../src/client/write/transfer.js";
import {
  approvalNeedsL1Signature,
  approveIntegrator,
  revokeIntegrator,
} from "../../../src/client/write/integrator.js";
import {
  EXPIRED_AT,
  FAKE_L1_SIG,
  type Harness,
  SIBLING_ACCOUNT_INDEX,
  harness,
  l1MessageVector,
  recordingSigner,
} from "./harness.js";

/** The `approve_integrator` vector's inputs, at the human tier. */
const VECTOR_APPROVAL = {
  integratorAccountIndex: 4242n,
  maxPerpsTakerFee: 1000,
  maxPerpsMakerFee: 500,
  maxSpotTakerFee: 800,
  maxSpotMakerFee: 400,
  approvalExpiry: 1_893_456_000_000n,
  sameMasterAccount: false,
  send: { nonce: 28n, apiKeyIndex: 0 },
  tx: { expiredAt: EXPIRED_AT },
} as const;

const ZERO_FEES = {
  maxPerpsTakerFee: 0,
  maxPerpsMakerFee: 0,
  maxSpotTakerFee: 0,
  maxSpotMakerFee: 0,
} as const;

/** A `/systemConfig` body whose integrator caps are lower than the vector's fees. */
function cappedSystemConfig(): SystemConfig {
  return {
    code: 200,
    liquidity_pool_index: 0,
    staking_pool_index: 140_737_488_355_335,
    funding_fee_rebate_account_index: 0,
    market_maker_incentive_account_index: 0,
    liquidity_pool_cooldown_period: 0,
    staking_pool_lockup_period: 0,
    max_integrator_perps_maker_fee: 400,
    max_integrator_perps_taker_fee: 900,
    max_integrator_spot_maker_fee: 400,
    max_integrator_spot_taker_fee: 900,
  } as unknown as SystemConfig;
}

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("the L1 gate", () => {
  test("all four fees zero needs no signer, and asks nothing about ownership", async () => {
    const h: Harness = harness(); // no l1Signer
    expect(
      await approvalNeedsL1Signature(h.ctx, {
        ...ZERO_FEES,
        integratorAccountIndex: 4242n,
        approvalExpiry: 1_893_456_000_000n,
      }),
    ).toBe(false);

    const receipt: TxReceipt = await approveIntegrator(h.ctx, {
      ...ZERO_FEES,
      integratorAccountIndex: 4242n,
      approvalExpiry: 1_893_456_000_000n,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(receipt.txType).toBe(45);
    expect(h.paths()).toEqual(["/api/v1/sendTx"]);
    expect(h.submitted()["MaxPerpsTakerFee"]).toBe(0);
  });

  test("a same-master integrator needs no signer, decided from the account family", async () => {
    const h: Harness = harness();
    // `sameMasterAccount` is deliberately absent: this is the discovery path.
    const { sameMasterAccount: _omitted, ...rest } = VECTOR_APPROVAL;
    await approveIntegrator(h.ctx, {
      ...rest,
      integratorAccountIndex: SIBLING_ACCOUNT_INDEX,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.paths()).toEqual([
      "/api/v1/account",
      "/api/v1/accountsByL1Address",
      "/api/v1/sendTx",
    ]);
  });

  test("a third party with a non-zero fee and no signer throws the vector's message", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(approveIntegrator(h.ctx, VECTOR_APPROVAL));
    expect(error).toBeInstanceOf(L1SignatureRequiredError);
    const required: L1SignatureRequired = error as L1SignatureRequired;
    expect(required.message).toBe(l1MessageVector("approve_integrator").body);
    expect(required.template).toBe(l1MessageVector("approve_integrator").body);
    expect(required.txType).toBe(45);
    expect(h.paths()).toEqual([]);
  });

  test("the refusal resumes to the same transaction the signer path submits", async () => {
    const { signer, messages } = recordingSigner();
    const signed: Harness = harness({ l1Signer: signer });
    const first: TxReceipt = await approveIntegrator(signed.ctx, VECTOR_APPROVAL);
    expect(messages).toEqual([l1MessageVector("approve_integrator").body]);
    expect(signed.submitted()["L1Sig"]).toBe(FAKE_L1_SIG);

    const refused: Harness = harness();
    const error: unknown = await caught(approveIntegrator(refused.ctx, VECTOR_APPROVAL));
    const resumed: TxReceipt = await refused.account.submitWithL1Signature(
      (error as L1SignatureRequired).prepared,
      FAKE_L1_SIG,
    );
    expect(resumed.txHash).toBe(first.txHash);
    expect(JSON.parse(resumed.txInfo)["L1Sig"]).toBe(FAKE_L1_SIG);
  });
});

describe("fee caps", () => {
  test("a cap above the exchange maximum is refused locally", async () => {
    const h: Harness = harness({ systemConfig: cappedSystemConfig() });
    const error: unknown = await caught(approveIntegrator(h.ctx, VECTOR_APPROVAL));
    expect((error as LighterValidationError).code).toBe("INTEGRATOR_FEE_RANGE");
    expect(h.paths()).toEqual([]);
  });

  test("a cap above FeeTick is refused even with no system config loaded", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      approveIntegrator(h.ctx, { ...VECTOR_APPROVAL, maxSpotMakerFee: 1_000_001 }),
    );
    expect((error as LighterValidationError).code).toBe("FEE_TOO_HIGH");
  });

  test("caps at or under the exchange maximum pass", async () => {
    const h: Harness = harness({
      systemConfig: cappedSystemConfig(),
      l1Signer: recordingSigner().signer,
    });
    await approveIntegrator(h.ctx, {
      ...VECTOR_APPROVAL,
      maxPerpsTakerFee: 900,
      maxPerpsMakerFee: 400,
      maxSpotTakerFee: 900,
      maxSpotMakerFee: 400,
    });
    expect(h.submitted()["MaxPerpsTakerFee"]).toBe(900);
  });
});

describe("revokeIntegrator", () => {
  test("is four zero fees and expiry 0, with no signer and no lookups", async () => {
    const h: Harness = harness();
    await revokeIntegrator(h.ctx, 4242n, { send: { nonce: 1n, apiKeyIndex: 0 } });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["IntegratorAccountIndex"]).toBe(4242);
    expect(tx["MaxPerpsTakerFee"]).toBe(0);
    expect(tx["MaxPerpsMakerFee"]).toBe(0);
    expect(tx["MaxSpotTakerFee"]).toBe(0);
    expect(tx["MaxSpotMakerFee"]).toBe(0);
    expect(tx["ApprovalExpiry"]).toBe(0);
    expect(h.paths()).toEqual(["/api/v1/sendTx"]);
  });

  test("expiry 0 with a non-zero fee is refused by the codec", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      approveIntegrator(h.ctx, {
        ...VECTOR_APPROVAL,
        approvalExpiry: 0n,
        sameMasterAccount: true,
        send: { nonce: 1n, apiKeyIndex: 0 },
      }),
    );
    expect((error as LighterValidationError).code).toBe("APPROVAL_EXPIRY_ZERO_ON_REVOCATION");
  });
});
