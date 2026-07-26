/**
 * `src/client/write/staking.ts` — codes 35 and 36.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import type { TxReceipt } from "../../../src/client/receipt.js";
import { stake, unstake } from "../../../src/client/write/staking.js";
import { type Harness, harness } from "./harness.js";

/** The `stake_assets` conformance vector's pool index. */
const STAKING_POOL: bigint = 140_737_488_355_335n;

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("stake / unstake", () => {
  test("stake is code 35 and carries the staking pool index", async () => {
    const h: Harness = harness();
    const receipt: TxReceipt = await stake(h.ctx, {
      stakingPoolIndex: STAKING_POOL,
      shareAmount: 10_000_000_000n,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(receipt.txType).toBe(35);
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["StakingPoolIndex"]).toBe(140737488355335);
    expect(tx["ShareAmount"]).toBe(10_000_000_000);
  });

  test("unstake is code 36 with the same field name — the reference's example does not run", async () => {
    const h: Harness = harness();
    const receipt: TxReceipt = await unstake(h.ctx, {
      stakingPoolIndex: STAKING_POOL,
      shareAmount: 5_000_000_000n,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(receipt.txType).toBe(36);
    expect(h.submitted()["StakingPoolIndex"]).toBe(140737488355335);
  });

  test("a staking pool index below 2^47 is rejected locally, on both", async () => {
    const h: Harness = harness();
    const staked: unknown = await caught(
      stake(h.ctx, { stakingPoolIndex: 7n, shareAmount: 1n }),
    );
    const unstaked: unknown = await caught(
      unstake(h.ctx, { stakingPoolIndex: 7n, shareAmount: 1n }),
    );
    expect((staked as LighterValidationError).code).toBe("STAKING_POOL_INDEX_TOO_LOW");
    expect((unstaked as LighterValidationError).code).toBe("STAKING_POOL_INDEX_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });

  test("a share amount below the staking minimum is refused by the codec", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      stake(h.ctx, {
        stakingPoolIndex: STAKING_POOL,
        shareAmount: 0n,
        send: { nonce: 1n, apiKeyIndex: 0 },
      }),
    );
    expect((error as LighterValidationError).code).toBe("STAKE_AMOUNT_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });
});
