/**
 * `src/client/write/fast-withdraw.ts`.
 *
 * The acceptance criterion for this flow is the **sequence**, so that is what the first test is: the
 * exact list of requests, in order, and the exact body of the last one. A fast withdrawal that makes
 * the right calls in the wrong order pays a fee computed against the wrong pool.
 */

import { describe, expect, test } from "bun:test";

import { LighterMathError, LighterValidationError } from "../../../src/errors.js";
import { bytesToHex } from "../../../src/util/bytes.js";
import { fastWithdraw } from "../../../src/client/write/fast-withdraw.js";
import type { FastWithdrawResult } from "../../../src/client/write/fast-withdraw.js";
import {
  type Answer,
  type Call,
  FAKE_AUTH_TOKEN,
  FASTWITHDRAW_POOL_INDEX,
  type Harness,
  harness,
} from "./harness.js";

const TO_ADDRESS: `0x${string}` = `0x${"22".repeat(20)}`;

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (): unknown => {
      throw new Error("expected a rejection");
    },
    (e: unknown): unknown => e,
  );
}

describe("the sequence", () => {
  test("auth token → fastwithdraw/info → transferFeeInfo → signed transfer → POST /fastwithdraw", async () => {
    const tokens: string[] = [];
    const h: Harness = harness({
      authToken: (): string => {
        tokens.push("issued");
        return FAKE_AUTH_TOKEN;
      },
    });

    const result: FastWithdrawResult = await fastWithdraw(h.ctx, {
      toAddress: TO_ADDRESS,
      amount: "25",
      send: { nonce: 4n, apiKeyIndex: 0 },
    });

    // 1. the token was obtained, once, before any request.
    expect(tokens).toEqual(["issued"]);
    // 2–3, 6. the exact call order. The transfer itself never goes through /sendTx.
    expect(h.paths()).toEqual([
      "/api/v1/fastwithdraw/info",
      "/api/v1/transferFeeInfo",
      "/api/v1/fastwithdraw",
    ]);

    const post: Call = h.calls[2] as Call;
    expect(post.method).toBe("POST");
    const body: URLSearchParams = new URLSearchParams(post.body);
    // 6. the exact final body fields, and only those two.
    expect([...body.keys()].sort()).toEqual(["to_address", "tx_info"]);
    expect(body.get("to_address")).toBe(TO_ADDRESS);
    expect(body.get("tx_info")).toBe(result.txInfo);

    // 5. what was signed: a transfer to the bridge pool, carrying the fee and the memo.
    const tx: Record<string, unknown> = JSON.parse(result.txInfo) as Record<string, unknown>;
    expect(tx["ToAccountIndex"]).toBe(FASTWITHDRAW_POOL_INDEX);
    expect(tx["Amount"]).toBe(25_000_000);
    expect(tx["USDCFee"]).toBe(10_000);
    expect(tx["Nonce"]).toBe(4);
    expect(typeof tx["Sig"]).toBe("string");

    // 4. the memo is the 20 address bytes followed by twelve zeroes.
    const memo: number[] = tx["Memo"] as number[];
    expect(bytesToHex(Uint8Array.from(memo))).toBe("22".repeat(20) + "00".repeat(12));

    expect(result.poolAccountIndex).toBe(BigInt(FASTWITHDRAW_POOL_INDEX));
    expect(result.fee).toBe(10_000n);
    expect(result.withdrawLimit).toBe("100000.000000");
    expect(result.maxWithdrawalAmount).toBe("50000.000000");
    expect(result.txHash.startsWith("0x")).toBe(true);
  });

  test("the token travels on the Authorization header, never in the body or the query", async () => {
    const h: Harness = harness();
    await fastWithdraw(h.ctx, {
      toAddress: TO_ADDRESS,
      amount: "25",
      send: { nonce: 4n, apiKeyIndex: 0 },
    });
    for (const call of h.calls) {
      expect(call.authHeader).toBe(FAKE_AUTH_TOKEN);
      expect(call.url).not.toContain(FAKE_AUTH_TOKEN);
      expect(call.body).not.toContain(FAKE_AUTH_TOKEN);
    }
  });
});

describe("refusals", () => {
  test("a malformed address costs no request and no token", async () => {
    let issued: number = 0;
    const h: Harness = harness({
      authToken: (): string => {
        issued += 1;
        return FAKE_AUTH_TOKEN;
      },
    });
    const error: unknown = await caught(
      fastWithdraw(h.ctx, { toAddress: "0xdeadbeef" as `0x${string}`, amount: "1" }),
    );
    expect((error as LighterValidationError).code).toBe("L1_ADDRESS_INVALID");
    expect(issued).toBe(0);
    expect(h.paths()).toEqual([]);
  });

  test("an amount over the bridge's reported maximum is refused before signing", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      fastWithdraw(h.ctx, { toAddress: TO_ADDRESS, amount: "50000.000001" }),
    );
    expect((error as LighterValidationError).code).toBe("WITHDRAWAL_AMOUNT_TOO_HIGH");
    expect(h.paths()).toEqual(["/api/v1/fastwithdraw/info"]);
  });

  test("skipLimitCheck lets the bridge decide for itself", async () => {
    const h: Harness = harness();
    await fastWithdraw(h.ctx, {
      toAddress: TO_ADDRESS,
      amount: "50000.000001",
      skipLimitCheck: true,
      send: { nonce: 1n, apiKeyIndex: 0 },
    });
    expect(h.paths()).toContain("/api/v1/fastwithdraw");
  });

  test("a bridge with no pool account is a typed refusal", async () => {
    const h: Harness = harness({
      routes: { "/api/v1/fastwithdraw/info": (): Answer => ({ body: { code: 200 } }) },
    });
    const error: unknown = await caught(
      fastWithdraw(h.ctx, { toAddress: TO_ADDRESS, amount: "1" }),
    );
    expect((error as LighterValidationError).code).toBe("FASTWITHDRAW_UNAVAILABLE");
  });

  test("digits beyond the asset's scale throw rather than truncating, before any request", async () => {
    const h: Harness = harness();
    const error: unknown = await caught(
      fastWithdraw(h.ctx, { toAddress: TO_ADDRESS, amount: "1.2345678" }),
    );
    expect(error).toBeInstanceOf(LighterMathError);
    expect(h.paths()).toEqual([]);
  });

  test("no error raised on this path carries the auth token", async () => {
    const h: Harness = harness({
      routes: {
        "/api/v1/transferFeeInfo": (): Answer => ({
          status: 400,
          body: { code: 20001, message: "invalid param " },
        }),
      },
    });
    const error: unknown = await caught(
      fastWithdraw(h.ctx, { toAddress: TO_ADDRESS, amount: "1" }),
    );
    const rendered: string = JSON.stringify({
      message: (error as Error).message,
      json: (error as { toJSON?: () => unknown }).toJSON?.() ?? null,
      stack: (error as Error).stack ?? "",
    });
    expect(rendered).not.toContain(FAKE_AUTH_TOKEN);
    expect(rendered).not.toContain("0123456789abcdef");
  });
});
