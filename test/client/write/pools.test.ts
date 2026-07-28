/**
 * `src/client/write/pools.ts` — codes 10, 11, 18 and 19.
 *
 * The receipt test is the one worth reading: `createPublicPool` is the only call in the SDK whose
 * *result* is not in the response it gets, so the new pool's index is polled out of `event_info`,
 * and the fake transport withholds it for two polls to prove the loop is real.
 */

import { describe, expect, test } from "bun:test";

import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import type { TxReceipt } from "../../../src/client/receipt.js";
import {
  type CreatePublicPoolReceipt,
  type PublicPoolCreated,
  burnShares,
  createPublicPool,
  mintShares,
  poolIndexOf,
  updatePublicPool,
} from "../../../src/client/write/pools.js";
import { type Answer, type Call, type Harness, harness } from "./harness.js";

/** A pool account index in the sub-account range. */
const POOL: bigint = 140_737_488_355_400n;

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("createPublicPool", () => {
  test("takes ticks, share units and basis points, each named", async () => {
    const h: Harness = harness();
    await createPublicPool(h.ctx, {
      operatorFeeTicks: 100_000n,
      initialTotalShares: 1_000_000n,
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["OperatorFee"]).toBe(100_000);
    expect(tx["InitialTotalShares"]).toBe(1_000_000);
    expect(tx["MinOperatorShareRate"]).toBe(100);
  });

  test('initialUsdc "1000" is 1000000 shares at InitialPoolShareValue', async () => {
    const h: Harness = harness();
    await createPublicPool(h.ctx, {
      operatorFeeTicks: 100_000n,
      initialUsdc: "1000",
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["InitialTotalShares"]).toBe(1_000_000);
  });

  test("a USDC amount that does not land on a whole share is refused", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      createPublicPool(h.ctx, {
        operatorFeeTicks: 0n,
        initialUsdc: "1000.0000005",
        minOperatorShareRateBps: 100,
      }),
    );
    expect(error).toBeInstanceOf(LighterMathError);
  });

  test("supplying both share fields, or neither, is refused", async () => {
    const h: Harness = harness();
    const both: unknown = await caught(
      createPublicPool(h.ctx, {
        operatorFeeTicks: 0n,
        initialTotalShares: 1_000_000n,
        initialUsdc: "1000",
        minOperatorShareRateBps: 100,
      }),
    );
    const neither: unknown = await caught(
      createPublicPool(h.ctx, { operatorFeeTicks: 0n, minOperatorShareRateBps: 100 }),
    );
    expect((both as LighterValidationError).code).toBe("POOL_INITIAL_SHARES_TOO_LOW");
    expect((neither as LighterValidationError).code).toBe("POOL_INITIAL_SHARES_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });

  test("an operator fee above FeeTick is refused before signing", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      createPublicPool(h.ctx, {
        operatorFeeTicks: 1_000_001n,
        initialTotalShares: 1_000_000n,
        minOperatorShareRateBps: 100,
      }),
    );
    expect((error as LighterValidationError).code).toBe("POOL_OPERATOR_FEE_INVALID");
    expect(h.paths()).toEqual([]);
  });
});

describe("createPublicPool().wait()", () => {
  test("resolves { poolAccountIndex } from event_info field `a` on the third poll", async () => {
    let polls: number = 0;
    const h: Harness = harness({
      routes: {
        "/api/v1/tx": (): Answer => {
          polls += 1;
          if (polls < 3) return { body: { code: 200 } }; // "not in the index yet"
          return {
            body: {
              code: 200,
              hash: "aa".repeat(40),
              status: 1,
              executed_at: 1_700_000_000_000,
              event_info: JSON.stringify({ a: 140737488355400, other: "ignored" }),
            },
          };
        },
      },
    });
    const receipt: CreatePublicPoolReceipt = await createPublicPool(h.ctx, {
      operatorFeeTicks: 100_000n,
      initialUsdc: "1000",
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    // A one-millisecond interval keeps the test instant; the default is the reference's 1 s × 10.
    const created: PublicPoolCreated = await receipt.wait({ pollIntervalMs: 1, timeoutMs: 2_000 });
    expect(created.poolAccountIndex).toBe(POOL);
    expect(polls).toBe(3);
    expect(h.calls.filter((c: Call): boolean => c.path === "/api/v1/tx")).toHaveLength(3);
  });

  test("a receipt with no usable `a` is an error, not a zero", async () => {
    const h: Harness = harness({
      routes: {
        "/api/v1/tx": (): Answer => ({
          body: { code: 200, hash: "bb".repeat(40), event_info: JSON.stringify({ b: 1 }) },
        }),
      },
    });
    const receipt: CreatePublicPoolReceipt = await createPublicPool(h.ctx, {
      operatorFeeTicks: 0n,
      initialTotalShares: 1_000_000n,
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const error: unknown = await caught(receipt.wait({ pollIntervalMs: 1, timeoutMs: 500 }));
    expect((error as LighterValidationError).code).toBe("EVENT_INFO_MALFORMED");
  });

  test("poolIndexOf reads a string form exactly and refuses everything else", () => {
    expect(poolIndexOf({ a: POOL.toString() })).toBe(POOL);
    expect(poolIndexOf({ a: 140737488355400 })).toBe(POOL);
    expect(() => poolIndexOf({ a: 5 })).toThrow(LighterValidationError); // below 2^47
    expect(() => poolIndexOf(undefined)).toThrow(LighterValidationError);
    expect(() => poolIndexOf({ a: "not a number" })).toThrow(LighterValidationError);
  });
});

describe("updatePublicPool", () => {
  test("an operator fee higher than the current one is rejected locally, before signing", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      updatePublicPool(h.ctx, {
        publicPoolIndex: POOL,
        status: 1,
        operatorFeeTicks: 200_000n,
        currentOperatorFeeTicks: 100_000n,
        minOperatorShareRateBps: 100,
      }),
    );
    expect((error as LighterValidationError).code).toBe("POOL_OPERATOR_FEE_INVALID");
    expect(h.paths()).toEqual([]);
  });

  test("a decrease passes", async () => {
    const h: Harness = harness();
    await updatePublicPool(h.ctx, {
      publicPoolIndex: POOL,
      status: 1,
      operatorFeeTicks: 50_000n,
      currentOperatorFeeTicks: 100_000n,
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["OperatorFee"]).toBe(50_000);
    expect(tx["Status"]).toBe(1);
    expect(tx["PublicPoolIndex"]).toBe(140737488355400);
  });

  test("without an explicit current fee it reads the pool account", async () => {
    const h: Harness = harness({
      routes: {
        "/api/v1/account": (): Answer => ({
          body: {
            code: 200,
            accounts: [{ index: 140737488355400, pool_info: { operator_fee: "100000" } }],
          },
        }),
      },
    });
    const error: unknown = await caught(
      updatePublicPool(h.ctx, {
        publicPoolIndex: POOL,
        status: 1,
        operatorFeeTicks: 200_000n,
        minOperatorShareRateBps: 100,
      }),
    );
    expect((error as LighterValidationError).code).toBe("POOL_OPERATOR_FEE_INVALID");
    expect(h.paths()).toEqual(["/api/v1/account"]);
  });

  test("a fractional operator_fee is read as a fraction of one", async () => {
    const h: Harness = harness({
      routes: {
        "/api/v1/account": (): Answer => ({
          body: {
            code: 200,
            accounts: [{ index: 140737488355400, pool_info: { operator_fee: "0.100000" } }],
          },
        }),
      },
    });
    // 0.1 → 100000 millionths, so 100001 is an increase and 99999 is not.
    const up: unknown = await caught(
      updatePublicPool(h.ctx, {
        publicPoolIndex: POOL,
        status: 1,
        operatorFeeTicks: 100_001n,
        minOperatorShareRateBps: 100,
      }),
    );
    expect((up as LighterValidationError).code).toBe("POOL_OPERATOR_FEE_INVALID");
    await updatePublicPool(h.ctx, {
      publicPoolIndex: POOL,
      status: 1,
      operatorFeeTicks: 99_999n,
      minOperatorShareRateBps: 100,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["OperatorFee"]).toBe(99_999);
  });

  test("a pool index below 2^47 is rejected locally", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      updatePublicPool(h.ctx, {
        publicPoolIndex: 5n,
        status: 1,
        operatorFeeTicks: 0n,
        minOperatorShareRateBps: 100,
      }),
    );
    expect((error as LighterValidationError).code).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });
});

describe("mintShares / burnShares", () => {
  test("mint and burn carry the pool index and the share count", async () => {
    const mint: Harness = harness();
    const receipt: TxReceipt = await mintShares(mint.ctx, {
      publicPoolIndex: POOL,
      shareAmount: 1_000n,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(receipt.txType).toBe(18);
    expect(mint.submitted()["ShareAmount"]).toBe(1_000);

    const burn: Harness = harness();
    const burnt: TxReceipt = await burnShares(burn.ctx, {
      publicPoolIndex: POOL,
      shareAmount: 500n,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(burnt.txType).toBe(19);
    expect(burn.submitted()["ShareAmount"]).toBe(500);
  });

  test("a pool index below 2^47 is rejected locally on both", async () => {
    const h: Harness = harness();
    const minted: unknown = await caught(
      mintShares(h.ctx, { publicPoolIndex: 1n, shareAmount: 1n }),
    );
    const burnt: unknown = await caught(
      burnShares(h.ctx, { publicPoolIndex: 1n, shareAmount: 1n }),
    );
    expect((minted as LighterValidationError).code).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
    expect((burnt as LighterValidationError).code).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });
});
