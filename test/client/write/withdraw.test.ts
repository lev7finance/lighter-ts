/**
 * `src/client/write/withdraw.ts` — code 13.
 *
 * The whole surface is one scaling and one route, so that is what is asserted, including the two
 * ways the reference gets the scaling wrong.
 */

import { describe, expect, test } from "bun:test";

import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import { withdraw } from "../../../src/client/write/withdraw.js";
import { type Harness, harness } from "./harness.js";

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("withdraw", () => {
  test("scales by the registry's decimals and defaults USDC to the perps route", async () => {
    const h: Harness = harness();
    await withdraw(h.ctx, { asset: "USDC", amount: "8.2", send: { nonce: 3n, apiKeyIndex: 0 } });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["AssetIndex"]).toBe(3);
    expect(tx["Amount"]).toBe(8_200_000);
    expect(tx["RouteType"]).toBe(0);
    expect(tx["Nonce"]).toBe(3);
    expect(h.paths()).toEqual(["/api/v1/sendTx"]);
  });

  test("a non-USDC asset defaults to the spot route", async () => {
    const h: Harness = harness();
    await withdraw(h.ctx, { asset: "LDO", amount: "2", send: { nonce: 1n, apiKeyIndex: 0 } });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["AssetIndex"]).toBe(9);
    expect(tx["Amount"]).toBe(200_000_000); // 8 decimals
    expect(tx["RouteType"]).toBe(1);
  });

  test("an explicit route wins", async () => {
    const h: Harness = harness();
    await withdraw(h.ctx, {
      asset: "USDC",
      amount: "1",
      route: "spot",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.submitted()["RouteType"]).toBe(1);
  });

  test("digits beyond the asset's scale throw rather than truncating", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(withdraw(h.ctx, { asset: "USDC", amount: "1.2345678" }));
    expect(error).toBeInstanceOf(LighterMathError);
    expect(h.paths()).toEqual([]);
  });

  test("zero is refused by the codec before anything is sent", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      withdraw(h.ctx, { asset: "USDC", amount: "0", send: { nonce: 1n, apiKeyIndex: 0 } }),
    );
    expect((error as LighterValidationError).code).toBe("WITHDRAWAL_AMOUNT_TOO_LOW");
    expect(h.paths()).toEqual([]);
  });

  test("an unknown asset is a local error, not a rejected transaction", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(withdraw(h.ctx, { asset: "NOPE", amount: "1" }));
    expect((error as Error).message).toContain("NOPE");
    expect(h.paths()).toEqual([]);
  });
});
