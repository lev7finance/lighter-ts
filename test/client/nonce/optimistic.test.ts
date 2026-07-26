import { describe, expect, test } from "bun:test";

import {
  LighterApiError,
  LighterConfigError,
  LighterNonceError,
  LighterTimeoutError,
} from "../../../src/errors.js";
import { KeyPool } from "../../../src/client/nonce/key-pool.js";
import { OptimisticNonceSource } from "../../../src/client/nonce/optimistic.js";
import { classifyOutcome } from "../../../src/client/nonce/types.js";
import type {
  NextNonceClient,
  NextNonceResponse,
  NonceLease,
  NonceSnapshot,
} from "../../../src/client/nonce/types.js";

const ACCOUNT = 42;
const NONCE_CODE = 21120;

/**
 * A `nextNonce` client that never touches the network. `calls` records every key it was asked
 * about, in order, which is what the lazy-init and resync assertions read.
 */
interface FakeClient extends NextNonceClient {
  readonly calls: number[];
  server: Map<number, number>;
  fail: Error | undefined;
  gate: (() => Promise<void>) | undefined;
}

function fakeClient(server: Record<number, number> = {}): FakeClient {
  const calls: number[] = [];
  const table = new Map<number, number>(
    Object.entries(server).map(([k, v]): [number, number] => [Number(k), v]),
  );
  const client: FakeClient = {
    calls,
    server: table,
    fail: undefined,
    gate: undefined,
    transaction: {
      async nextNonce(params: {
        account_index: number;
        api_key_index: number;
      }): Promise<NextNonceResponse> {
        calls.push(params.api_key_index);
        if (client.gate !== undefined) await client.gate();
        if (client.fail !== undefined) throw client.fail;
        const nonce = table.get(params.api_key_index) ?? 0;
        // Go's `omitempty` drops a zero nonce entirely; model that faithfully.
        return nonce === 0 ? { code: 200 } : { code: 200, nonce };
      },
    },
  };
  return client;
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function source(client: NextNonceClient, keys: readonly number[]): OptimisticNonceSource {
  return new OptimisticNonceSource({ accountIndex: ACCOUNT, keys, client });
}

describe("OptimisticNonceSource — construction", () => {
  test("constructing performs zero network calls", () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0, 1]);
    expect(client.calls).toEqual([]);
    expect(src.kind).toBe("optimistic");
    expect(src.accountIndex).toBe(ACCOUNT);
    expect(src.pool.keys).toEqual([0, 1]);
  });

  test("an existing pool can be shared", async () => {
    const pool = new KeyPool([9]);
    const client = fakeClient({ 9: 1 });
    const src = new OptimisticNonceSource({ accountIndex: ACCOUNT, pool, client });
    expect(src.pool).toBe(pool);
    const lease = await src.lease();
    expect(lease.apiKeyIndex).toBe(9);
    lease.release();
  });

  test("rejects a non-integer account index", () => {
    expect(
      () => new OptimisticNonceSource({ accountIndex: 1.5, keys: [0], client: fakeClient() }),
    ).toThrow(LighterConfigError);
  });
});

describe("OptimisticNonceSource — allocation", () => {
  test("the first allocated nonce equals the server's expected nonce", async () => {
    const client = fakeClient({ 0: 7 });
    const src = source(client, [0]);
    const lease = await src.lease();
    expect(lease.nonce).toBe(7n);
    expect(lease.apiKeyIndex).toBe(0);
    expect(lease.skipNonce).toBe(false);
    lease.release();
  });

  test("a key whose server nonce is omitted starts at 0", async () => {
    const client = fakeClient({ 0: 0 });
    const src = source(client, [0]);
    const first = await src.lease();
    expect(first.nonce).toBe(0n);
    first.release();
    const second = await src.lease();
    expect(second.nonce).toBe(1n);
    second.release();
  });

  test("lazy init: one nextNonce per key on first use, none afterwards", async () => {
    const client = fakeClient({ 0: 3, 1: 100 });
    const src = source(client, [0, 1]);
    expect(client.calls).toEqual([]);

    for (let i = 0; i < 4; i += 1) {
      const lease = await src.lease();
      lease.release();
    }
    expect(client.calls).toEqual([0, 1]);
  });

  test("rotates round-robin starting at keys[0]", async () => {
    const client = fakeClient({ 0: 0, 1: 10, 2: 20 });
    const src = source(client, [0, 1, 2]);
    const seen: Array<[number, bigint]> = [];
    for (let i = 0; i < 6; i += 1) {
      const lease = await src.lease();
      seen.push([lease.apiKeyIndex, lease.nonce]);
      lease.release();
    }
    expect(seen).toEqual([
      [0, 0n],
      [1, 10n],
      [2, 20n],
      [0, 1n],
      [1, 11n],
      [2, 21n],
    ]);
  });

  test("preferKey pins one key without rotating — the create/modify/cancel pattern", async () => {
    const client = fakeClient({ 0: 0, 1: 50 });
    const src = source(client, [0, 1]);
    const a = await src.lease(1);
    a.release();
    const b = await src.lease(1);
    b.release();
    const c = await src.lease(1);
    c.release();
    expect([a.nonce, b.nonce, c.nonce]).toEqual([50n, 51n, 52n]);
    expect(client.calls).toEqual([1]);
  });

  test("preferKey outside the pool is rejected", async () => {
    const src = source(fakeClient(), [0]);
    await expect(src.lease(4)).rejects.toThrow(LighterNonceError);
  });

  test("a failed seeding fetch releases the mutex instead of deadlocking the key", async () => {
    const client = fakeClient({ 0: 5 });
    client.fail = new Error("network down");
    const src = source(client, [0]);
    await expect(src.lease()).rejects.toThrow("network down");

    client.fail = undefined;
    const lease = await src.lease();
    expect(lease.nonce).toBe(5n);
    lease.release();
  });

  test("peek reports the next nonce without allocating", async () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0]);
    expect(src.peek(0)).toBeUndefined();
    const lease = await src.lease();
    lease.release();
    expect(src.peek(0)).toBe(6n);
    expect(client.calls).toEqual([0]);
  });
});

describe("OptimisticNonceSource — concurrency", () => {
  test("100 concurrent leases over 5 keys are distinct, gapless and contiguous", async () => {
    const starts: Record<number, number> = { 0: 0, 1: 7, 2: 1000, 3: 3, 4: 999 };
    const client = fakeClient(starts);
    const src = source(client, [0, 1, 2, 3, 4]);

    const pairs: Array<[number, bigint]> = [];
    await Promise.all(
      Array.from({ length: 100 }, async (): Promise<void> => {
        const lease = await src.lease();
        try {
          // Yield inside the critical section: this is where a missing mutex shows up.
          await ticks(3);
          pairs.push([lease.apiKeyIndex, lease.nonce]);
        } finally {
          lease.release();
        }
      }),
    );

    expect(pairs).toHaveLength(100);
    const unique = new Set(pairs.map(([k, n]: [number, bigint]): string => `${k}:${n}`));
    expect(unique.size).toBe(100);

    for (const key of [0, 1, 2, 3, 4]) {
      const nonces = pairs
        .filter(([k]: [number, bigint]): boolean => k === key)
        .map(([, n]: [number, bigint]): bigint => n)
        .sort((a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0));
      expect(nonces).toHaveLength(20);
      const start = BigInt(starts[key] as number);
      expect(nonces).toEqual(Array.from({ length: 20 }, (_, i: number): bigint => start + BigInt(i)));
    }

    // Still exactly one seeding fetch per key.
    expect(client.calls.slice().sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test("two concurrent leases on one key never share a nonce, even across the seeding await", async () => {
    const client = fakeClient({ 0: 4 });
    let openGate: () => void = () => {};
    client.gate = (): Promise<void> =>
      new Promise<void>((resolve: () => void): void => {
        openGate = resolve;
      });

    const src = source(client, [0]);
    const a = src.lease();
    const b = src.lease();
    await ticks(3);
    openGate();

    const leaseA = await a;
    expect(leaseA.nonce).toBe(4n);
    // The second lease cannot resolve until the first releases: that is the mutex.
    leaseA.release();

    const leaseB = await b;
    // It waited on the mutex, so it seeded from the counter rather than from the server.
    expect(client.calls).toEqual([0]);
    expect(leaseB.nonce).toBe(5n);
    leaseB.release();
  });

  test("the mutex is per key: a slow submit on key 3 does not block key 4", async () => {
    const client = fakeClient({ 3: 0, 4: 0 });
    const src = source(client, [3, 4]);

    const held = await src.lease(3);
    let secondResolved = false;
    const queued = src.lease(3).then((lease: NonceLease): NonceLease => {
      secondResolved = true;
      return lease;
    });

    const other = await src.lease(4);
    expect(other.apiKeyIndex).toBe(4);
    other.release();

    await ticks(10);
    expect(secondResolved).toBe(false);

    held.release();
    const second = await queued;
    expect(secondResolved).toBe(true);
    expect(second.nonce).toBe(1n);
    second.release();
  });
});

describe("OptimisticNonceSource — failure handling", () => {
  test("rollback on the top slot returns exactly that slot", async () => {
    const client = fakeClient({ 0: 10 });
    const src = source(client, [0]);

    const first = await src.lease();
    expect(first.nonce).toBe(10n);
    first.rollback();
    first.release();

    const second = await src.lease();
    expect(second.nonce).toBe(10n);
    second.release();
    expect(client.calls).toEqual([0]);
  });

  test("rollback of a middle slot forces a resync rather than duplicating a live nonce", async () => {
    const client = fakeClient({ 0: 10 });
    const src = source(client, [0]);

    const first = await src.lease();
    first.release();
    const second = await src.lease();
    second.release();
    expect([first.nonce, second.nonce]).toEqual([10n, 11n]);

    // `first` is no longer the top slot: decrementing would hand out 11 twice.
    first.rollback();
    client.server.set(0, 12);
    const third = await src.lease();
    expect(third.nonce).toBe(12n);
    third.release();
    expect(client.calls).toEqual([0, 0]);
  });

  test("a rejection classified as rejected rolls back; the next lease reuses the slot", async () => {
    const client = fakeClient({ 0: 1 });
    const src = source(client, [0]);

    const lease = await src.lease();
    try {
      throw new LighterApiError({ status: 400, code: 20001, message: "invalid param " });
    } catch (e: unknown) {
      expect(classifyOutcome(e)).toBe("rejected");
      lease.rollback();
    } finally {
      lease.release();
    }

    const retry = await src.lease();
    expect(retry.nonce).toBe(1n);
    retry.release();
  });

  test("an invalid-nonce code triggers exactly one refetch for that key and none for the others", async () => {
    const client = fakeClient({ 0: 4, 1: 90 });
    const src = source(client, [0, 1]);

    const warm0 = await src.lease(0);
    warm0.release();
    const warm1 = await src.lease(1);
    warm1.release();
    expect(client.calls).toEqual([0, 1]);

    const lease = await src.lease(0);
    const failure = new LighterApiError({ status: 400, code: NONCE_CODE, message: "invalid nonce " });
    expect(classifyOutcome(failure, { invalidNonceCodes: [NONCE_CODE] })).toBe("invalid-nonce");

    client.server.set(0, 77);
    await src.resync(lease.apiKeyIndex);
    lease.release();

    expect(client.calls).toEqual([0, 1, 0]);

    const after = await src.lease(0);
    expect(after.nonce).toBe(77n);
    after.release();
    expect(client.calls).toEqual([0, 1, 0]);

    const untouched = await src.lease(1);
    expect(untouched.nonce).toBe(91n);
    untouched.release();
    expect(client.calls).toEqual([0, 1, 0]);
  });

  test("resync is safe while the lease on that key is still held — it takes no lock", async () => {
    const client = fakeClient({ 0: 4 });
    const src = source(client, [0]);
    const lease = await src.lease();
    client.server.set(0, 40);
    // Would deadlock if resync queued behind the mutex this lease holds.
    await src.resync(0);
    lease.release();
    const next = await src.lease();
    expect(next.nonce).toBe(40n);
    next.release();
  });

  test("a failed resync leaves the key dirty so the next allocation reseeds", async () => {
    const client = fakeClient({ 0: 4 });
    const src = source(client, [0]);
    const first = await src.lease();
    first.release();

    client.fail = new Error("nextNonce unavailable");
    await expect(src.resync(0)).rejects.toThrow("nextNonce unavailable");
    client.fail = undefined;
    client.server.set(0, 30);

    const next = await src.lease();
    expect(next.nonce).toBe(30n);
    next.release();
  });

  test("resync rejects a key outside the pool", async () => {
    const src = source(fakeClient(), [0]);
    await expect(src.resync(9)).rejects.toThrow(LighterNonceError);
  });

  test("THE GATE — a timeout burns the slot: no rollback, no resync, next nonce advances", async () => {
    const client = fakeClient({ 0: 20 });
    const src = source(client, [0]);

    const lease = await src.lease();
    expect(lease.nonce).toBe(20n);

    const failure = new LighterTimeoutError();
    const outcome = classifyOutcome(failure);
    expect(outcome).toBe("indeterminate");

    // What the submit path does for `indeterminate`: nothing but release.
    if (outcome === "rejected") lease.rollback();
    if (outcome === "invalid-nonce") await src.resync(lease.apiKeyIndex);
    lease.release();

    const next = await src.lease();
    expect(next.nonce).toBe(21n);
    next.release();

    // No resync happened: still exactly one seeding fetch.
    expect(client.calls).toEqual([0]);
  });

  test("releasing without settling burns the slot, matching the timeout path", async () => {
    const client = fakeClient({ 0: 0 });
    const src = source(client, [0]);
    const first = await src.lease();
    first.release();
    const second = await src.lease();
    expect(second.nonce).toBe(1n);
    second.release();
  });
});

describe("OptimisticNonceSource — explicit resource management", () => {
  test("`using` releases the key's mutex on scope exit, and on a throw", async () => {
    if (typeof (Symbol as { dispose?: symbol }).dispose !== "symbol") return;
    const client = fakeClient({ 0: 1 });
    const src = source(client, [0]);

    {
      using lease = await src.lease();
      expect(lease.nonce).toBe(1n);
    }
    // The lock is free: this would hang forever if `using` had not released it.
    const after = await src.lease();
    expect(after.nonce).toBe(2n);
    after.release();

    await expect(
      (async (): Promise<void> => {
        using lease = await src.lease();
        expect(lease.nonce).toBe(3n);
        throw new Error("signer exploded");
      })(),
    ).rejects.toThrow("signer exploded");

    const recovered = await src.lease();
    expect(recovered.nonce).toBe(4n);
    recovered.release();
    expect(src.pool.isLocked(0)).toBe(false);
  });
});

describe("OptimisticNonceSource — snapshots", () => {
  test("a snapshot survives JSON and restores the exact allocation sequence", async () => {
    const client = fakeClient({ 0: 5, 1: 60 });
    const src = source(client, [0, 1]);
    const before: Array<[number, bigint]> = [];
    for (let i = 0; i < 4; i += 1) {
      const lease = await src.lease();
      before.push([lease.apiKeyIndex, lease.nonce]);
      lease.release();
    }

    const wire = JSON.stringify(src.snapshot());
    expect(wire).toContain('"counter":"6"');
    const parsed = JSON.parse(wire) as NonceSnapshot;

    // A cold isolate: a brand-new source, a brand-new client that would answer differently.
    const coldClient = fakeClient({ 0: 999, 1: 999 });
    const cold = source(coldClient, [0, 1]);
    cold.restore(parsed);

    const after: Array<[number, bigint]> = [];
    for (let i = 0; i < 4; i += 1) {
      const lease = await cold.lease();
      after.push([lease.apiKeyIndex, lease.nonce]);
      lease.release();
    }
    expect(after).toEqual([
      [0, 7n],
      [1, 62n],
      [0, 8n],
      [1, 63n],
    ]);
    expect(coldClient.calls).toEqual([]);
    expect(before).toEqual([
      [0, 5n],
      [1, 60n],
      [0, 6n],
      [1, 61n],
    ]);
  });

  test("an untouched source snapshots no keys, and a cold restore falls back to a lazy fetch", async () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0]);
    expect(src.snapshot()).toEqual({
      version: 1,
      kind: "optimistic",
      accountIndex: ACCOUNT,
      keys: [],
    });

    const other = source(fakeClient({ 0: 5 }), [0]);
    other.restore(src.snapshot());
    const lease = await other.lease();
    expect(lease.nonce).toBe(5n);
    lease.release();
  });

  test("a dirty key snapshots as dirty and reseeds after restore", async () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0]);
    const a = await src.lease();
    a.release();
    const b = await src.lease();
    b.release();
    a.rollback(); // not the top slot -> dirty

    const snap = JSON.parse(JSON.stringify(src.snapshot())) as NonceSnapshot;
    expect(snap.keys).toEqual([{ apiKeyIndex: 0, dirty: true }]);

    const coldClient = fakeClient({ 0: 42 });
    const cold = source(coldClient, [0]);
    cold.restore(snap);
    const lease = await cold.lease();
    expect(lease.nonce).toBe(42n);
    lease.release();
  });

  test("a snapshot from another account is refused", () => {
    const src = source(fakeClient(), [0]);
    const foreign: NonceSnapshot = {
      version: 1,
      kind: "optimistic",
      accountIndex: ACCOUNT + 1,
      keys: [],
    };
    expect(() => src.restore(foreign)).toThrow(LighterConfigError);
  });

  test("a snapshot from another strategy or version is refused", () => {
    const src = source(fakeClient(), [0]);
    expect(() =>
      src.restore({ version: 1, kind: "server", accountIndex: ACCOUNT, keys: [] }),
    ).toThrow(LighterConfigError);
    expect(() =>
      src.restore({ version: 2, kind: "optimistic", accountIndex: ACCOUNT, keys: [] } as unknown as NonceSnapshot),
    ).toThrow(LighterConfigError);
  });

  test("a corrupt counter is refused rather than coerced", () => {
    const src = source(fakeClient(), [0]);
    expect(() =>
      src.restore({
        version: 1,
        kind: "optimistic",
        accountIndex: ACCOUNT,
        keys: [{ apiKeyIndex: 0, counter: "12.5" }],
      }),
    ).toThrow(LighterConfigError);
    expect(() =>
      src.restore({
        version: 1,
        kind: "optimistic",
        accountIndex: ACCOUNT,
        keys: [{ apiKeyIndex: 0, counter: "-2" }],
      }),
    ).toThrow();
  });

  test("a counter of -1 round-trips: the key has issued nothing yet", async () => {
    const client = fakeClient({ 0: 0 });
    const src = source(client, [0]);
    src.restore({
      version: 1,
      kind: "optimistic",
      accountIndex: ACCOUNT,
      keys: [{ apiKeyIndex: 0, counter: "-1" }],
    });
    const lease = await src.lease();
    expect(lease.nonce).toBe(0n);
    lease.release();
    expect(client.calls).toEqual([]);
  });

  test("keys absent from the pool are ignored", async () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0]);
    src.restore({
      version: 1,
      kind: "optimistic",
      accountIndex: ACCOUNT,
      keys: [
        { apiKeyIndex: 0, counter: "9" },
        { apiKeyIndex: 7, counter: "1000" },
      ],
    });
    const lease = await src.lease();
    expect(lease.nonce).toBe(10n);
    lease.release();
  });

  test("snapshot counters are strings, so JSON.stringify cannot throw on a bigint", async () => {
    const src = source(fakeClient({ 0: 5 }), [0]);
    const lease = await src.lease();
    lease.release();
    const key = src.snapshot().keys[0];
    expect(typeof key?.counter).toBe("string");
    expect(() => JSON.stringify(src.snapshot())).not.toThrow();
  });
});

describe("OptimisticNonceSource — pipelined mode", () => {
  test("is off by default", async () => {
    const src = source(fakeClient({ 0: 1 }), [0]);
    await expect(src.leaseBatch(3)).rejects.toThrow(LighterNonceError);
    await src.leaseBatch(3).catch((e: unknown) => {
      expect((e as LighterNonceError).code).toBe("LEASE_EXHAUSTED");
    });
  });

  test("claims consecutive slots up front, all marked skipNonce", async () => {
    const client = fakeClient({ 0: 22 });
    const src = new OptimisticNonceSource({
      accountIndex: ACCOUNT,
      keys: [0],
      client,
      pipelined: true,
    });
    const leases = await src.leaseBatch(3);
    expect(leases.map((l: NonceLease): bigint => l.nonce)).toEqual([22n, 23n, 24n]);
    expect(leases.every((l: NonceLease): boolean => l.skipNonce)).toBe(true);
    expect(leases.every((l: NonceLease): boolean => l.apiKeyIndex === 0)).toBe(true);

    // The key stays locked until every lease in the batch is released.
    let unblocked = false;
    const queued = src.lease(0).then((l: NonceLease): NonceLease => {
      unblocked = true;
      return l;
    });
    leases[0]?.release();
    leases[1]?.release();
    await ticks(5);
    expect(unblocked).toBe(false);
    leases[2]?.release();
    const next = await queued;
    expect(next.nonce).toBe(25n);
    next.release();
  });

  test("rejects a nonsensical batch size", async () => {
    const src = new OptimisticNonceSource({
      accountIndex: ACCOUNT,
      keys: [0],
      client: fakeClient({ 0: 1 }),
      pipelined: true,
    });
    await expect(src.leaseBatch(0)).rejects.toThrow();
    await expect(src.leaseBatch(1.5)).rejects.toThrow();
  });
});
