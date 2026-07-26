/**
 * `src/client/sequence.ts` — several separate submissions pinned to one API key.
 *
 * The property under test is the one that is invisible until it fails in production: a nonce is
 * ordered only within `(account, apiKey)`, so a `create → modify → cancel` run spread across a
 * rotating key pool arrives out of order however carefully the caller awaits each step. The nonce
 * source here rotates over three keys, and unrelated traffic is deliberately interleaved between the
 * sequence's own sends, so an implementation that forgot to pin would visibly scatter.
 *
 * As in `batch.test.ts`, every assertion is read out of the captured request bodies rather than out
 * of the SDK's own objects.
 */

import { describe, expect, test } from "bun:test";

import { LighterAccount } from "../../src/client/account.js";
import { createLease } from "../../src/client/nonce/types.js";
import type { NonceLease, NonceSnapshot, NonceSource } from "../../src/client/nonce/types.js";
import { sequence, type SequenceContext } from "../../src/client/sequence.js";
import type { SubmitContext } from "../../src/client/submit.js";
import { ApiKey } from "../../src/crypto/key.js";
import { i16, i64, u8, u32 } from "../../src/tx/brands.js";
import type { UnsignedTx } from "../../src/tx/build.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const KEY: ApiKey = ApiKey.fromPrivateKey(
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a",
);

const CHAIN_ID: 304 = 304;
const NOW_MS: 1_700_000_000_000 = 1_700_000_000_000;

/** Three keys, so the pool's rotation is observable and a missing pin would scatter the run. */
const KEYS: readonly number[] = Object.freeze([0, 1, 2]);

interface Sent {
  readonly apiKeyIndex: number;
  readonly nonce: number;
  readonly clientOrderIndex: number;
}

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

class TestNonces implements NonceSource {
  readonly kind: "optimistic" = "optimistic";
  readonly counters: Map<number, bigint> = new Map<number, bigint>();
  leases: number = 0;
  releases: number = 0;
  rollbacks: number = 0;
  #cursor: number = 0;

  lease(preferKey?: number): Promise<NonceLease> {
    const key: number = preferKey ?? this.#next();
    const nonce: bigint = this.counters.get(key) ?? 0n;
    this.counters.set(key, nonce + 1n);
    this.leases += 1;
    return Promise.resolve(
      createLease({
        apiKeyIndex: key,
        nonce,
        onRollback: (): void => {
          this.rollbacks += 1;
          this.counters.set(key, (this.counters.get(key) ?? 1n) - 1n);
        },
        onRelease: (): void => {
          this.releases += 1;
        },
      }),
    );
  }

  resync(): Promise<void> {
    return Promise.resolve();
  }

  snapshot(): NonceSnapshot {
    return { version: 1, kind: "optimistic", accountIndex: 1, keys: [] };
  }

  restore(): void {
    /* not exercised here */
  }

  #next(): number {
    const key: number = KEYS[this.#cursor % KEYS.length] as number;
    this.#cursor += 1;
    return key;
  }
}

interface Harness {
  readonly account: LighterAccount;
  readonly nonces: TestNonces;
  readonly sent: Sent[];
}

function harness(): Harness {
  const sent: Sent[] = [];
  const nonces: TestNonces = new TestNonces();
  const refuse = (): never => {
    throw new Error("this test must not reach the network");
  };
  const transaction = {
    sendTx: (p: { tx_type: number; tx_info: string }): Promise<{ code: number; tx_hash: string }> => {
      const doc: Record<string, number> = JSON.parse(p.tx_info) as Record<string, number>;
      sent.push({
        apiKeyIndex: doc["ApiKeyIndex"] as number,
        nonce: doc["Nonce"] as number,
        clientOrderIndex: doc["ClientOrderIndex"] ?? -1,
      });
      return Promise.resolve({ code: 200, tx_hash: "" });
    },
    sendTxBatch: refuse,
    tx: refuse,
  };
  const ctx: SubmitContext = {
    chainId: CHAIN_ID,
    accountIndex: 1n,
    rest: { transaction } as unknown as SubmitContext["rest"],
    nonces,
    keys: new Map<number, ApiKey>(KEYS.map((k: number): [number, ApiKey] => [k, KEY])),
    channel: "http",
    now: (): number => NOW_MS,
  };
  const account: LighterAccount = new LighterAccount({
    chainId: CHAIN_ID,
    ctx,
    rest: { account: { account: refuse, accountsByL1Address: refuse } } as never,
    defaultTxExpiryMs: 599_000,
    now: (): number => NOW_MS,
  });
  return { account, nonces, sent };
}

function anOrder(surface: LighterAccount["tx"], clientOrderIndex: bigint): UnsignedTx {
  return surface.createOrder({
    marketIndex: i16(1),
    clientOrderIndex: i64(clientOrderIndex),
    baseAmount: i64(1_000n),
    price: u32(250_000),
    isAsk: u8(0),
    orderType: u8(0),
    timeInForce: u8(1),
    reduceOnly: u8(0),
    triggerPrice: u32(0),
    orderExpiry: i64(1_893_456_000_000n),
  });
}

/** Every submission whose client order index falls in the sequence's own range. */
function ofSequence(sent: readonly Sent[]): readonly Sent[] {
  return sent.filter((s: Sent): boolean => s.clientOrderIndex >= 100 && s.clientOrderIndex < 200);
}

/* ---------------------------------------------------------------------------------------------- */
/* Tests                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("sequence", (): void => {
  test("pins one key across three separate submissions with consecutive nonces", async (): Promise<void> => {
    const h: Harness = harness();

    await sequence(h.account, async (s: SequenceContext): Promise<void> => {
      await s.send(anOrder(s.tx, 101n));
      await s.send(anOrder(s.tx, 102n));
      await s.send(anOrder(s.tx, 103n));
    });

    expect(h.sent).toHaveLength(3);
    expect(new Set(h.sent.map((x: Sent): number => x.apiKeyIndex)).size).toBe(1);
    expect(h.sent.map((x: Sent): number => x.nonce)).toEqual([0, 1, 2]);
  });

  test("interleaved sends on other keys do not disturb the run", async (): Promise<void> => {
    const h: Harness = harness();

    await sequence(h.account, async (s: SequenceContext): Promise<void> => {
      await s.send(anOrder(s.tx, 101n));
      // Unrelated traffic, taking whatever key the pool's rotation offers next.
      await h.account.send(anOrder(h.account.tx, 900n));
      await s.send(anOrder(s.tx, 102n));
      await h.account.send(anOrder(h.account.tx, 901n));
      await s.send(anOrder(s.tx, 103n));
    });

    const run: readonly Sent[] = ofSequence(h.sent);
    expect(run.map((x: Sent): number => x.clientOrderIndex)).toEqual([101, 102, 103]);
    expect(new Set(run.map((x: Sent): number => x.apiKeyIndex)).size).toBe(1);
    expect(run.map((x: Sent): number => x.nonce)).toEqual([0, 1, 2]);
    // The interleaved sends genuinely went somewhere else, or this would prove nothing.
    const others: readonly Sent[] = h.sent.filter((x: Sent): boolean => x.clientOrderIndex >= 900);
    expect(others.every((x: Sent): boolean => x.apiKeyIndex !== run[0]?.apiKeyIndex)).toBe(true);
  });

  test("the callback's own value is passed through", async (): Promise<void> => {
    const h: Harness = harness();
    const answer: string = await sequence(h.account, async (s: SequenceContext): Promise<string> => {
      const receipt = await s.send(anOrder(s.tx, 101n));
      return receipt.txHash;
    });
    expect(answer).toMatch(/^0x[0-9a-f]{80}$/);
  });

  test("the pin is released even when the callback throws", async (): Promise<void> => {
    const h: Harness = harness();
    const boom: Error = new Error("the strategy changed its mind");

    await expect(
      sequence(h.account, (): never => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(h.nonces.leases).toBe(1);
    expect(h.nonces.releases).toBe(1);
    expect(h.nonces.rollbacks).toBe(1);
    // The pin returned its slot, so the pinned key is exactly where it started.
    expect(h.nonces.counters.get(0)).toBe(0n);
    expect(h.sent).toHaveLength(0);
  });

  test("every lease taken inside the run is released", async (): Promise<void> => {
    const h: Harness = harness();
    await sequence(h.account, async (s: SequenceContext): Promise<void> => {
      await s.send(anOrder(s.tx, 101n));
      await s.send(anOrder(s.tx, 102n));
    });
    expect(h.nonces.releases).toBe(h.nonces.leases);
  });

  test("the context reports the key it pinned and how much it sent", async (): Promise<void> => {
    const h: Harness = harness();
    const observed: { key: number; before: number; after: number } = await sequence(
      h.account,
      async (s: SequenceContext): Promise<{ key: number; before: number; after: number }> => {
        const before: number = s.sent;
        await s.send(anOrder(s.tx, 101n));
        return { key: s.apiKeyIndex, before, after: s.sent };
      },
      { preferKey: 2 },
    );
    expect(observed).toEqual({ key: 2, before: 0, after: 1 });
    expect(h.sent[0]?.apiKeyIndex).toBe(2);
  });

  test("prepare rides the pinned key too", async (): Promise<void> => {
    const h: Harness = harness();
    const apiKeyIndex: number = await sequence(
      h.account,
      async (s: SequenceContext): Promise<number> => {
        const signed = await s.prepare(anOrder(s.tx, 101n));
        return signed.apiKeyIndex;
      },
      { preferKey: 1 },
    );
    expect(apiKeyIndex).toBe(1);
  });
});
