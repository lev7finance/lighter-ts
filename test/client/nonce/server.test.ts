import { describe, expect, test } from "bun:test";

import { LighterConfigError, LighterNonceError } from "../../../src/errors.js";
import {
  DEFAULT_PACE_MS,
  MAX_PACE_MS,
  ServerNonceSource,
} from "../../../src/client/nonce/server.js";
import type {
  NextNonceClient,
  NextNonceResponse,
  NonceLease,
  NonceSnapshot,
} from "../../../src/client/nonce/types.js";

const ACCOUNT = 7;

interface FakeClient extends NextNonceClient {
  readonly calls: number[];
  server: Map<number, number>;
}

function fakeClient(server: Record<number, number> = {}): FakeClient {
  const calls: number[] = [];
  const table = new Map<number, number>(
    Object.entries(server).map(([k, v]): [number, number] => [Number(k), v]),
  );
  return {
    calls,
    server: table,
    transaction: {
      async nextNonce(params: {
        account_index: number;
        api_key_index: number;
      }): Promise<NextNonceResponse> {
        calls.push(params.api_key_index);
        const nonce = table.get(params.api_key_index) ?? 0;
        return nonce === 0 ? { code: 200 } : { code: 200, nonce };
      },
    },
  };
}

/** A hand-cranked clock and a sleep that advances it. Nothing here touches real time. */
function clock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let t = 1_000;
  const slept: number[] = [];
  return {
    now: (): number => t,
    slept,
    advance: (ms: number): void => {
      t += ms;
    },
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
    },
  };
}

function source(
  client: NextNonceClient,
  keys: readonly number[],
  c: ReturnType<typeof clock>,
): ServerNonceSource {
  return new ServerNonceSource({
    accountIndex: ACCOUNT,
    keys,
    client,
    now: c.now,
    sleep: c.sleep,
  });
}

describe("ServerNonceSource", () => {
  test("constructing performs zero network calls", () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0], clock());
    expect(client.calls).toEqual([]);
    expect(src.kind).toBe("server");
  });

  test("every allocation re-queries and uses the value verbatim", async () => {
    const client = fakeClient({ 0: 5 });
    const c = clock();
    const src = source(client, [0], c);

    const first = await src.lease();
    expect(first.nonce).toBe(5n);
    first.release();

    // The server has moved on; the source does not guess.
    client.server.set(0, 9);
    const second = await src.lease();
    expect(second.nonce).toBe(9n);
    second.release();

    expect(client.calls).toEqual([0, 0]);
  });

  test("the first use of a key is not paced", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const lease = await src.lease();
    lease.release();
    expect(c.slept).toEqual([]);
  });

  test("reusing a key waits out the 350 ms default", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const first = await src.lease();
    first.release();
    const second = await src.lease();
    second.release();
    expect(c.slept).toEqual([DEFAULT_PACE_MS]);
    expect(DEFAULT_PACE_MS).toBe(350);
  });

  test("time already elapsed counts against the interval", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const first = await src.lease();
    first.release();
    c.advance(300);
    const second = await src.lease();
    second.release();
    expect(c.slept).toEqual([50]);
  });

  test("a key idle longer than the interval is not paced at all", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const first = await src.lease();
    first.release();
    c.advance(5_000);
    const second = await src.lease();
    second.release();
    expect(c.slept).toEqual([]);
  });

  test("a fed-back prediction replaces the default for that key only", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1, 1: 1 }), [0, 1], c);

    const warm0 = await src.lease(0);
    warm0.release();
    const warm1 = await src.lease(1);
    warm1.release();

    src.notifyPredictedExecutionMs(0, 40);
    const a = await src.lease(0);
    a.release();
    const b = await src.lease(1);
    b.release();

    expect(c.slept).toEqual([40, DEFAULT_PACE_MS - 40]);
  });

  test("an unusable prediction is ignored rather than thrown — telemetry must not break a send", () => {
    const src = source(fakeClient({ 0: 1 }), [0], clock());
    expect(() => src.notifyPredictedExecutionMs(0, Number.NaN)).not.toThrow();
    expect(() => src.notifyPredictedExecutionMs(0, -5)).not.toThrow();
    expect(() => src.notifyPredictedExecutionMs(0, Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => src.notifyPredictedExecutionMs(99, 10)).not.toThrow();
    expect(src.snapshot().keys).toEqual([]);
  });

  test("an absurd prediction is clamped", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const first = await src.lease();
    first.release();
    src.notifyPredictedExecutionMs(0, 10 ** 9);
    const second = await src.lease();
    second.release();
    expect(c.slept).toEqual([MAX_PACE_MS]);
  });

  test("pacing waits inside the key's own mutex, so other keys keep flowing", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1, 1: 1 }), [0, 1], c);
    const warm = await src.lease(0);
    warm.release();

    const other = await src.lease(1);
    expect(other.apiKeyIndex).toBe(1);
    other.release();
    expect(c.slept).toEqual([]);
  });

  test("rollback is a no-op: the slot lives on the server", async () => {
    const client = fakeClient({ 0: 5 });
    const c = clock();
    const src = source(client, [0], c);
    const lease = await src.lease();
    lease.rollback();
    lease.release();
    const next = await src.lease();
    expect(next.nonce).toBe(5n);
    next.release();
  });

  test("resync is a no-op for a known key and rejects an unknown one", async () => {
    const client = fakeClient({ 0: 5 });
    const src = source(client, [0], clock());
    await src.resync(0);
    expect(client.calls).toEqual([]);
    await expect(src.resync(3)).rejects.toThrow(LighterNonceError);
  });

  test("a failed fetch releases the mutex", async () => {
    const failing: NextNonceClient = {
      transaction: {
        nextNonce: (): Promise<NextNonceResponse> => Promise.reject(new Error("down")),
      },
    };
    const src = source(failing, [0], clock());
    await expect(src.lease()).rejects.toThrow("down");
    // The key is free again: a second attempt reaches the fetch rather than hanging.
    await expect(src.lease()).rejects.toThrow("down");
  });

  test("preferKey outside the pool is rejected", async () => {
    const src = source(fakeClient(), [0], clock());
    await expect(src.lease(2)).rejects.toThrow(LighterNonceError);
  });

  test("the mutex serialises one key", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const held = await src.lease();
    let resolved = false;
    const queued = src.lease().then((l: NonceLease): NonceLease => {
      resolved = true;
      return l;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(resolved).toBe(false);
    held.release();
    const second = await queued;
    expect(resolved).toBe(true);
    second.release();
  });

  test("pacing state round-trips through JSON", async () => {
    const c = clock();
    const src = source(fakeClient({ 0: 1 }), [0], c);
    const lease = await src.lease();
    lease.release();
    src.notifyPredictedExecutionMs(0, 120);

    const wire = JSON.parse(JSON.stringify(src.snapshot())) as NonceSnapshot;
    expect(wire.kind).toBe("server");
    expect(wire.keys[0]?.paceMs).toBe(120);

    const c2 = clock();
    const cold = source(fakeClient({ 0: 1 }), [0], c2);
    cold.restore(wire);
    const next = await cold.lease();
    next.release();
    expect(c2.slept).toEqual([120]);
  });

  test("a snapshot from another strategy is refused", () => {
    const src = source(fakeClient(), [0], clock());
    expect(() =>
      src.restore({ version: 1, kind: "optimistic", accountIndex: ACCOUNT, keys: [] }),
    ).toThrow(LighterConfigError);
  });
});
