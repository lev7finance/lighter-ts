/**
 * `src/client/receipt.ts` — hash normalisation, the integrity assertion, and `wait()`.
 *
 * Two things are being pinned here, and they are the two that cost real money when they are wrong:
 *
 * 1. **The normalisation.** `txHashHex()` emits 80 lowercase hex characters with no `0x`;
 *    `TxReceipt.txHash` is `0x`-prefixed; the API echoes whatever it likes. Every test below that
 *    compares hashes does so across at least two of those spellings, because a naive `===` passes a
 *    test written in one spelling and fails on every real transaction.
 * 2. **A "not found" answer is not a failure.** It is the expected answer until the sequencer
 *    executes the transaction, so it must be polled through rather than thrown.
 *
 * No network, no wall clock: the transport, the clock and the sleep are all injected.
 */

import { describe, expect, test } from "bun:test";

import { ERR_TX_NOT_FOUND, LighterApiError, LighterTimeoutError } from "../../src/errors.js";
import type { EnrichedTx } from "../../src/models/transaction.js";
import {
  type ReceiptTransport,
  type TxReceipt,
  type TxResult,
  assertTxHashMatch,
  createReceipt,
  normalizeTxHash,
  txHashesEqual,
} from "../../src/client/receipt.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures and fakes                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** 80 hex characters — a real digest's width. Lowercase, no prefix: `txHashHex()`'s spelling. */
const HASH_BARE: string =
  "4891376b9db197260c1968749f410c61506379aef1815f50fda41b300a57c88c3356fefa6599aa7b";

/** One `GET /api/v1/tx` fake, plus the calls and the delays it observed. */
interface FakeTx {
  readonly rest: ReceiptTransport;
  readonly calls: string[];
  readonly delays: number[];
  now: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * `EnrichedTx` requires `code`, which none of these fixtures cares about; every answer below is a
 * partial and is widened at the one place it is handed back.
 */
type Answer = Partial<EnrichedTx> | Error;

function fakeTx(answers: readonly Answer[]): FakeTx {
  const calls: string[] = [];
  const delays: number[] = [];
  let cursor: number = 0;
  const state: FakeTx = {
    calls,
    delays,
    now: 1_000,
    rest: {
      transaction: {
        tx(params: { by: string; value: string }): Promise<EnrichedTx> {
          calls.push(params.value);
          const answer: Answer | undefined = answers[Math.min(cursor, answers.length - 1)];
          cursor += 1;
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve((answer ?? {}) as EnrichedTx);
        },
      },
    },
    sleep(ms: number): Promise<void> {
      delays.push(ms);
      // Advancing the injected clock is what makes the timeout test finite.
      state.now += ms;
      return Promise.resolve();
    },
  };
  return state;
}

function receiptOver(fake: FakeTx, predictedExecutionTimeMs: number = 200): TxReceipt {
  return createReceipt(
    {
      txHash: HASH_BARE,
      txType: 14,
      txInfo: '{"AccountIndex":1}',
      nonce: 7n,
      apiKeyIndex: 3,
      predictedExecutionTimeMs,
      volumeQuotaRemaining: 42,
    },
    { rest: fake.rest, now: (): number => fake.now, sleep: fake.sleep },
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Normalisation                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("normalizeTxHash", () => {
  test("accepts both spellings and both cases, and emits exactly one", () => {
    const expected: string = `0x${HASH_BARE}`;
    expect(normalizeTxHash(HASH_BARE)).toBe(expected as `0x${string}`);
    expect(normalizeTxHash(`0x${HASH_BARE}`)).toBe(expected as `0x${string}`);
    expect(normalizeTxHash(HASH_BARE.toUpperCase())).toBe(expected as `0x${string}`);
    expect(normalizeTxHash(`0x${HASH_BARE.toUpperCase()}`)).toBe(expected as `0x${string}`);
  });

  test("refuses anything that is not 80 hex characters", () => {
    expect(() => normalizeTxHash("")).toThrow(/hex characters/);
    expect(() => normalizeTxHash(`0x${HASH_BARE.slice(0, 78)}`)).toThrow(/hex characters/);
    expect(() => normalizeTxHash(`${HASH_BARE}ab`)).toThrow(/hex characters/);
    expect(() => normalizeTxHash(`0x${"z".repeat(80)}`)).toThrow(/hex characters/);
  });

  test("the error names lengths, never the value's provenance", () => {
    expect(() => normalizeTxHash("0xdead")).toThrow(/optionally 0x-prefixed/);
  });
});

describe("txHashesEqual", () => {
  test("is insensitive to prefix and case in both directions", () => {
    expect(txHashesEqual(HASH_BARE, `0x${HASH_BARE.toUpperCase()}`)).toBe(true);
    expect(txHashesEqual(`0x${HASH_BARE}`, HASH_BARE)).toBe(true);
  });

  test("is false, not throwing, for a malformed input", () => {
    expect(txHashesEqual("", HASH_BARE)).toBe(false);
    expect(txHashesEqual("0xdead", "0xdead")).toBe(false);
    expect(txHashesEqual(HASH_BARE, `${HASH_BARE.slice(0, 79)}f`)).toBe(false);
  });
});

describe("assertTxHashMatch", () => {
  test("an absent echo is not a mismatch — the local digest is authoritative", () => {
    expect(() => assertTxHashMatch(HASH_BARE, undefined)).not.toThrow();
    expect(() => assertTxHashMatch(HASH_BARE, "")).not.toThrow();
  });

  test("the two spellings of the same hash agree", () => {
    expect(() => assertTxHashMatch(HASH_BARE, `0x${HASH_BARE.toUpperCase()}`)).not.toThrow();
  });

  test("a genuine mismatch raises and names both hashes", () => {
    const other: string = `f${HASH_BARE.slice(1)}`;
    let message: string = "";
    try {
      assertTxHashMatch(HASH_BARE, other);
    } catch (e: unknown) {
      message = (e as Error).message;
    }
    expect(message).toContain(other);
    expect(message).toContain(HASH_BARE);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The receipt itself                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("createReceipt", () => {
  test("carries the locally known fields and normalises the hash", () => {
    const receipt: TxReceipt = receiptOver(fakeTx([{ hash: HASH_BARE }]));
    expect(receipt.txHash).toBe(`0x${HASH_BARE}` as `0x${string}`);
    expect(receipt.txType).toBe(14);
    expect(receipt.nonce).toBe(7n);
    expect(receipt.apiKeyIndex).toBe(3);
  });

  test("volumeQuotaRemaining is a bigint, and an int64 string is taken verbatim", () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE }]);
    const deps = { rest: fake.rest, now: (): number => fake.now, sleep: fake.sleep };
    const fromNumber: TxReceipt = createReceipt(
      { txHash: HASH_BARE, txType: 14, txInfo: "{}", nonce: 0n, apiKeyIndex: 0, volumeQuotaRemaining: 5 },
      deps,
    );
    expect(fromNumber.volumeQuotaRemaining).toBe(5n);

    // Above 2^53 the wire value can only survive as a string; if the API ever sends one, it is not
    // routed through a double here.
    const wide: TxReceipt = createReceipt(
      {
        txHash: HASH_BARE,
        txType: 14,
        txInfo: "{}",
        nonce: 0n,
        apiKeyIndex: 0,
        volumeQuotaRemaining: "9007199254740993",
      },
      deps,
    );
    expect(wide.volumeQuotaRemaining).toBe(9_007_199_254_740_993n);
  });

  test("an absent quota is 0n, never NaN or undefined", () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE }]);
    const receipt: TxReceipt = createReceipt(
      { txHash: HASH_BARE, txType: 15, txInfo: "{}", nonce: 1n, apiKeyIndex: 1 },
      { rest: fake.rest },
    );
    expect(receipt.volumeQuotaRemaining).toBe(0n);
    expect(receipt.predictedExecutionTimeMs).toBe(0);
  });
});

describe("wait", () => {
  test("polls the 0x-prefixed hash and returns as soon as the tx appears", async () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE, status: 1 }]);
    const result: TxResult = await receiptOver(fake).wait();
    expect(fake.calls).toEqual([`0x${HASH_BARE}`]);
    expect(result.status).toBe(1);
    expect(result.txHash).toBe(`0x${HASH_BARE}` as `0x${string}`);
    // Found on the first look: nothing slept.
    expect(fake.delays).toEqual([]);
  });

  test("seeds the first delay from predicted_execution_time_ms and backs off from there", async () => {
    const fake: FakeTx = fakeTx([{}, {}, {}, { hash: HASH_BARE }]);
    await receiptOver(fake, 300).wait({ timeoutMs: 60_000 });
    expect(fake.delays).toEqual([300, 600, 1_200]);
  });

  test("the delay is floored, so a zero prediction is not a spin loop", async () => {
    const fake: FakeTx = fakeTx([{}, { hash: HASH_BARE }]);
    await receiptOver(fake, 0).wait({ timeoutMs: 60_000 });
    expect(fake.delays[0]).toBeGreaterThan(0);
  });

  test("a fixed pollIntervalMs overrides the backoff entirely", async () => {
    const fake: FakeTx = fakeTx([{}, {}, { hash: HASH_BARE }]);
    await receiptOver(fake, 5_000).wait({ pollIntervalMs: 25, timeoutMs: 60_000 });
    expect(fake.delays).toEqual([25, 25]);
  });

  test("a 'not found' API error is polled through, not thrown", async () => {
    const notFound: LighterApiError = new LighterApiError({
      status: 400,
      code: ERR_TX_NOT_FOUND,
      message: "not found",
      path: "/api/v1/tx",
    });
    const fake: FakeTx = fakeTx([notFound, notFound, { hash: HASH_BARE }]);
    const result: TxResult = await receiptOver(fake, 10).wait({ timeoutMs: 60_000 });
    expect(result.tx.hash).toBe(HASH_BARE);
    expect(fake.calls).toHaveLength(3);
  });

  test("any other API error propagates immediately", async () => {
    const boom: LighterApiError = new LighterApiError({
      status: 400,
      code: 20001,
      message: "invalid param ",
      path: "/api/v1/tx",
    });
    const fake: FakeTx = fakeTx([boom]);
    await expect(receiptOver(fake).wait()).rejects.toThrow(LighterApiError);
    expect(fake.calls).toHaveLength(1);
  });

  test("a timeout says the transaction may still land, and does not claim it failed", async () => {
    const fake: FakeTx = fakeTx([{}]);
    const promise: Promise<TxResult> = receiptOver(fake, 100).wait({ timeoutMs: 500 });
    await expect(promise).rejects.toThrow(LighterTimeoutError);
    await promise.catch((e: unknown): void => {
      expect((e as Error).message).toContain("may still be");
      expect((e as Error).message).toContain("GET /api/v1/tx?by=hash");
    });
  });

  test("an already-aborted signal rejects before the first request", async () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE }]);
    const controller: AbortController = new AbortController();
    controller.abort();
    await expect(receiptOver(fake).wait({ signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("event_info", () => {
  test("is parsed on first access, and not before", async () => {
    let parses: number = 0;
    const eventInfo: string = '{"a":4242}';
    const fake: FakeTx = fakeTx([
      // A getter on the response object proves the field is untouched until `eventInfo` is read.
      Object.defineProperty({ hash: HASH_BARE } as EnrichedTx, "event_info", {
        get(): string {
          parses += 1;
          return eventInfo;
        },
        enumerable: true,
      }),
    ]);
    const result: TxResult = await receiptOver(fake).wait();
    expect(parses).toBe(0);
    expect(result.eventInfo).toEqual({ a: 4242 });
    expect(result.eventInfo).toEqual({ a: 4242 });
    // Memoised: read twice, fetched once.
    expect(parses).toBe(1);
  });

  test("is undefined when the response carries none", async () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE }]);
    const result: TxResult = await receiptOver(fake).wait();
    expect(result.eventInfo).toBeUndefined();
  });

  test("malformed JSON throws only when it is read", async () => {
    const fake: FakeTx = fakeTx([{ hash: HASH_BARE, event_info: "{not json" }]);
    const result: TxResult = await receiptOver(fake).wait();
    expect(() => result.eventInfo).toThrow(/event_info/);
  });
});
