/**
 * `src/client/batch.ts` — one request, one API key, consecutive nonces.
 *
 * The assertions are read out of the **captured request bodies**, not out of the objects the SDK
 * held in memory: the property that matters is what the sequencer receives, and a batch whose
 * transactions were built correctly and stamped with two different keys looks perfectly healthy
 * from the inside.
 *
 * The nonce source deliberately holds three keys and rotates over them, so an implementation that
 * simply leased once per transaction would spread the batch across all three and fail the first
 * test here. That is the failure this unit exists to make impossible.
 */

import { describe, expect, test } from "bun:test";

import { LighterAccount } from "../../src/client/account.js";
import { batch, type BatchContext } from "../../src/client/batch.js";
import { createLease } from "../../src/client/nonce/types.js";
import type { NonceLease, NonceSnapshot, NonceSource } from "../../src/client/nonce/types.js";
import type { SubmitContext } from "../../src/client/submit.js";
import { ApiKey } from "../../src/crypto/key.js";
import { LighterConfigError } from "../../src/errors.js";
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

/** Every configured key. Three of them, so rotation is observable. */
const KEYS: readonly number[] = Object.freeze([0, 1, 2]);

/** One captured submission, as the transport saw it. */
interface Sent {
  readonly txType: number;
  readonly apiKeyIndex: number;
  readonly nonce: number;
  readonly clientOrderIndex: number;
}

/** How many HTTP calls were made, by route. `sendTxBatch: 1` is "submits once". */
interface Calls {
  sendTx: number;
  sendTxBatch: number;
}

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** A nonce source that rotates over its keys and counts every lease, release and rollback. */
class TestNonces implements NonceSource {
  readonly kind: "optimistic" = "optimistic";
  readonly counters: Map<number, bigint> = new Map<number, bigint>();
  leases: number = 0;
  releases: number = 0;
  rollbacks: number = 0;
  commits: number = 0;
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
        onCommit: (): void => {
          this.commits += 1;
        },
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
  readonly calls: Calls;
}

function harness(): Harness {
  const sent: Sent[] = [];
  const calls: Calls = { sendTx: 0, sendTxBatch: 0 };
  const nonces: TestNonces = new TestNonces();
  const refuse = (): never => {
    throw new Error("this test must not reach the network");
  };

  const record = (txType: number, txInfo: string): void => {
    const doc: Record<string, number> = JSON.parse(txInfo) as Record<string, number>;
    sent.push({
      txType,
      apiKeyIndex: doc["ApiKeyIndex"] as number,
      nonce: doc["Nonce"] as number,
      clientOrderIndex: doc["ClientOrderIndex"] ?? -1,
    });
  };

  const transaction = {
    sendTx: (p: { tx_type: number; tx_info: string }): Promise<{ code: number; tx_hash: string }> => {
      calls.sendTx += 1;
      record(p.tx_type, p.tx_info);
      return Promise.resolve({ code: 200, tx_hash: "" });
    },
    sendTxBatch: (p: {
      tx_types: string;
      tx_infos: string;
    }): Promise<{ code: number; tx_hash: string[] }> => {
      calls.sendTxBatch += 1;
      const types: number[] = JSON.parse(p.tx_types) as number[];
      const infos: string[] = JSON.parse(p.tx_infos) as string[];
      infos.forEach((info: string, i: number): void => {
        record(types[i] as number, info);
      });
      return Promise.resolve({ code: 200, tx_hash: [] });
    },
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
  return { account, nonces, sent, calls };
}

/** A distinguishable order, so a captured body can be traced back to the call that made it. */
function anOrder(account: LighterAccount, clientOrderIndex: bigint): UnsignedTx {
  return account.tx.createOrder({
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

/* ---------------------------------------------------------------------------------------------- */
/* Tests                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("batch", (): void => {
  test("submits once, on one key, with consecutive nonces", async (): Promise<void> => {
    const h: Harness = harness();

    const receipts = await batch(h.account, (b: BatchContext): void => {
      b.tx.createOrder({
        marketIndex: i16(1),
        clientOrderIndex: i64(11n),
        baseAmount: i64(1_000n),
        price: u32(250_000),
        isAsk: u8(0),
        orderType: u8(0),
        timeInForce: u8(1),
        reduceOnly: u8(0),
        triggerPrice: u32(0),
        orderExpiry: i64(1_893_456_000_000n),
      });
      b.tx.cancelOrder({ marketIndex: i16(1), index: i64(281_474_976_710_656n) });
      b.tx.createOrder({
        marketIndex: i16(1),
        clientOrderIndex: i64(13n),
        baseAmount: i64(2_000n),
        price: u32(250_100),
        isAsk: u8(1),
        orderType: u8(0),
        timeInForce: u8(1),
        reduceOnly: u8(0),
        triggerPrice: u32(0),
        orderExpiry: i64(1_893_456_000_000n),
      });
    });

    expect(receipts).toHaveLength(3);
    expect(h.calls.sendTxBatch).toBe(1);
    expect(h.calls.sendTx).toBe(0);

    // One key across the whole batch, whatever the pool's rotation would otherwise have done.
    const keys: number[] = h.sent.map((s: Sent): number => s.apiKeyIndex);
    expect(new Set(keys).size).toBe(1);
    // Consecutive, in submission order.
    expect(h.sent.map((s: Sent): number => s.nonce)).toEqual([0, 1, 2]);
    expect(h.sent.map((s: Sent): number => s.txType)).toEqual([14, 15, 14]);
  });

  test("the callback sees the key the batch is pinned to", async (): Promise<void> => {
    const h: Harness = harness();
    let seen: number = -1;
    await batch(
      h.account,
      (b: BatchContext): void => {
        seen = b.apiKeyIndex;
        b.tx.cancelAllOrders({ timeInForce: u8(0), time: i64(0n) });
      },
      { preferKey: 2 },
    );
    expect(seen).toBe(2);
    expect(h.sent[0]?.apiKeyIndex).toBe(2);
  });

  test("the lease is released even when the callback throws", async (): Promise<void> => {
    const h: Harness = harness();
    const boom: Error = new Error("the strategy changed its mind");

    await expect(
      batch(h.account, (): void => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    // Exactly one lease was taken — the pin — and it was returned and released.
    expect(h.nonces.leases).toBe(1);
    expect(h.nonces.releases).toBe(1);
    expect(h.nonces.rollbacks).toBe(1);
    // The pin's slot went back to the pool, so the key is exactly where it started.
    expect(h.nonces.counters.get(0)).toBe(0n);
    expect(h.calls.sendTxBatch).toBe(0);
  });

  test("the lease is released when the submission itself fails", async (): Promise<void> => {
    const h: Harness = harness();
    // Every lease taken must have been released, including the run `sendBatch` allocated.
    await batch(h.account, (b: BatchContext): void => {
      b.add(anOrder(h.account, 21n));
    });
    expect(h.nonces.releases).toBe(h.nonces.leases);
  });

  test("an async callback is awaited before anything is submitted", async (): Promise<void> => {
    const h: Harness = harness();
    await batch(h.account, async (b: BatchContext): Promise<void> => {
      await Promise.resolve();
      b.add(anOrder(h.account, 31n));
      await Promise.resolve();
      b.add(anOrder(h.account, 32n));
    });
    expect(h.calls.sendTxBatch).toBe(1);
    expect(h.sent.map((s: Sent): number => s.clientOrderIndex)).toEqual([31, 32]);
  });

  test("the context reports what it has queued", async (): Promise<void> => {
    const h: Harness = harness();
    let sizes: number[] = [];
    let queued: number = 0;
    await batch(h.account, (b: BatchContext): void => {
      sizes.push(b.size);
      b.add(anOrder(h.account, 41n));
      sizes.push(b.size);
      b.tx.cancelOrder({ marketIndex: i16(1), index: i64(281_474_976_710_656n) });
      sizes.push(b.size);
      queued = b.queued().length;
    });
    expect(sizes).toEqual([0, 1, 2]);
    expect(queued).toBe(2);
  });

  test("a batch that queued nothing is a bug in the callback, not an empty request", async (): Promise<void> => {
    const h: Harness = harness();
    await expect(batch(h.account, (): void => {})).rejects.toBeInstanceOf(LighterConfigError);
    expect(h.calls.sendTxBatch).toBe(0);
    expect(h.nonces.releases).toBe(h.nonces.leases);
  });

  test("`add` returns the transaction it queued, so it reads as a pass-through", async (): Promise<void> => {
    const h: Harness = harness();
    let same: boolean = false;
    await batch(h.account, (b: BatchContext): void => {
      const tx: UnsignedTx = anOrder(h.account, 51n);
      same = b.add(tx) === tx;
    });
    expect(same).toBe(true);
  });
});
