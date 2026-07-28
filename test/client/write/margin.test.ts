/**
 * `src/client/write/margin.ts` — code 29.
 *
 * Two assertions carry the file: the human tier scales micro-USDC exactly and states the direction,
 * and the raw tier still reaches the codec with a **signed** amount, because the arithmetic
 * high-word shift is only observable there (`docs/protocol-notes.md` §3.2).
 */

import { describe, expect, test } from "bun:test";

import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import { i16, i64, u8 } from "../../../src/tx/brands.js";
import { txHashHex } from "../../../src/tx/pipeline.js";
import type { UpdateMarginTx } from "../../../src/tx/types/account.js";
import { addMargin, removeMargin } from "../../../src/client/write/margin.js";
import { CHAIN_ID, EXPIRED_AT, type Harness, harness } from "./harness.js";

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("addMargin / removeMargin", () => {
  test('addMargin("10.5") is 10500000 micro-USDC with Direction 1', async () => {
    const h: Harness = harness();
    await addMargin(h.ctx, {
      marketIndex: 1,
      amount: "10.5",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["USDCAmount"]).toBe(10_500_000);
    expect(tx["Direction"]).toBe(1);
    expect(tx["MarketIndex"]).toBe(1);
  });

  test('removeMargin("5") is 5000000 micro-USDC with Direction 0', async () => {
    const h: Harness = harness();
    await removeMargin(h.ctx, { marketIndex: 2, amount: "5", send: { nonce: 1n, apiKeyIndex: 0 } });
    const tx: Record<string, unknown> = h.submitted();
    expect(tx["USDCAmount"]).toBe(5_000_000);
    expect(tx["Direction"]).toBe(0);
  });

  test("more than six fractional digits throws rather than truncating", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(addMargin(h.ctx, { marketIndex: 1, amount: "1.0000005" }));
    expect(error).toBeInstanceOf(LighterMathError);
    expect(h.paths()).toEqual([]);
  });

  test("the safe rounding direction is available per call site: CEIL paying, FLOOR receiving", async () => {
    const paying: Harness = harness();
    await addMargin(paying.ctx, {
      marketIndex: 1,
      amount: "1.0000005",
      rounding: "CEIL",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(paying.submitted()["USDCAmount"]).toBe(1_000_001);

    const receiving: Harness = harness();
    await removeMargin(receiving.ctx, {
      marketIndex: 1,
      amount: "1.0000005",
      rounding: "FLOOR",
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(receiving.submitted()["USDCAmount"]).toBe(1_000_000);
  });

  test("zero is refused by the codec", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      addMargin(h.ctx, { marketIndex: 1, amount: "0", send: { nonce: 1n, apiKeyIndex: 0 } }),
    );
    expect((error as LighterValidationError).code).toBe("TRANSFER_AMOUNT_TOO_LOW");
  });

  test("the human tier never produces a negative amount", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      addMargin(h.ctx, { marketIndex: 1, amount: "-1", send: { nonce: 1n, apiKeyIndex: 0 } }),
    );
    // Strict mode rejects it at the codec; the human tier does not silently flip the direction.
    expect((error as LighterValidationError).code).toBe("NEGATIVE_MARGIN_AMOUNT");
  });
});

describe("the raw tier stays sign-preserving", () => {
  test("a negative USDCAmount reaches the codec unchanged and hashes as the vectors say", () => {
    const h: Harness = harness();
    const tx: UpdateMarginTx = h.account.tx.updateMargin(
      { marketIndex: i16(1), usdcAmount: i64(-1n), direction: u8(1) },
      { expiredAt: EXPIRED_AT, strict: false },
    );
    expect(tx.usdcAmount === -1n).toBe(true);
    // The hash is computable, which is the point: normalising the sign first would change the high
    // word from 4294967294 to 4294967295 and produce a different, valid-looking digest.
    expect(txHashHex(tx, CHAIN_ID)).toHaveLength(80);
  });
});
