import { describe, expect, test } from "bun:test";

import { LighterConfigError, LighterNonceError } from "../../../src/errors.js";
import { LighterRestClient } from "../../../src/rest/client.js";
import {
  classifyOutcome,
  createLease,
  createNonceSource,
  createOutcomeClassifier,
  INVALID_NONCE_API_CODES,
  KeyPool,
  ManualNonceSource,
  OptimisticNonceSource,
  readNextNonce,
  ServerNonceSource,
} from "../../../src/client/nonce/index.js";
import type {
  NextNonceClient,
  NextNonceResponse,
  NonceLease,
  NonceOutcome,
  NonceSnapshot,
  NonceSource,
} from "../../../src/client/nonce/index.js";

const ACCOUNT = 11;

function fakeClient(start: number): NextNonceClient & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    transaction: {
      async nextNonce(params: {
        account_index: number;
        api_key_index: number;
      }): Promise<NextNonceResponse> {
        calls.push(params.api_key_index);
        return { code: 200, nonce: start };
      },
    },
  };
}

describe("the module surface", () => {
  test("exports everything the submit path needs", () => {
    expect(typeof createNonceSource).toBe("function");
    expect(typeof classifyOutcome).toBe("function");
    expect(typeof createOutcomeClassifier).toBe("function");
    expect(typeof createLease).toBe("function");
    expect(typeof readNextNonce).toBe("function");
    expect(typeof KeyPool).toBe("function");
    expect(typeof OptimisticNonceSource).toBe("function");
    expect(typeof ServerNonceSource).toBe("function");
    expect(typeof ManualNonceSource).toBe("function");
    expect(INVALID_NONCE_API_CODES).toEqual([]);
  });

  test("a real LighterRestClient satisfies NextNonceClient structurally", () => {
    // Type-level assertion: this is the whole point of the structural dependency. No call is made.
    const rest = new LighterRestClient({ endpoint: "mainnet" });
    const asClient: NextNonceClient = rest;
    expect(typeof asClient.transaction.nextNonce).toBe("function");
  });
});

describe("createNonceSource", () => {
  test("builds an optimistic source by default kind, with no I/O", async () => {
    const client = fakeClient(4);
    const src: NonceSource = createNonceSource("optimistic", {
      accountIndex: ACCOUNT,
      keys: [0, 1],
      client,
    });
    expect(src.kind).toBe("optimistic");
    expect(client.calls).toEqual([]);
    const lease = await src.lease();
    expect(lease.nonce).toBe(4n);
    lease.release();
  });

  test("builds a server source", () => {
    const src = createNonceSource("server", {
      accountIndex: ACCOUNT,
      keys: [0],
      client: fakeClient(1),
    });
    expect(src.kind).toBe("server");
  });

  test("builds a manual source, which needs no client", async () => {
    const src = createNonceSource("manual", { accountIndex: ACCOUNT });
    expect(src.kind).toBe("manual");
    await expect(src.lease()).rejects.toThrow(LighterNonceError);
  });

  test("refuses a networked strategy with no client", () => {
    expect(() => createNonceSource("optimistic", { accountIndex: ACCOUNT, keys: [0] })).toThrow(
      LighterConfigError,
    );
    expect(() => createNonceSource("server", { accountIndex: ACCOUNT, keys: [0] })).toThrow(
      LighterConfigError,
    );
  });

  test("refuses an unknown strategy arriving from untyped configuration", () => {
    expect(() =>
      createNonceSource("optimistc" as unknown as "optimistic", {
        accountIndex: ACCOUNT,
        keys: [0],
        client: fakeClient(0),
      }),
    ).toThrow(LighterConfigError);
  });

  test("passes pipelined through", async () => {
    const src = createNonceSource("optimistic", {
      accountIndex: ACCOUNT,
      keys: [0],
      client: fakeClient(22),
      pipelined: true,
    });
    const leases = await (src as OptimisticNonceSource).leaseBatch(2);
    expect(leases.map((l: NonceLease): bigint => l.nonce)).toEqual([22n, 23n]);
    for (const l of leases) l.release();
  });

  test("shares a pool between two sources when one is supplied", async () => {
    const pool = new KeyPool([5]);
    const a = createNonceSource("optimistic", {
      accountIndex: ACCOUNT,
      pool,
      client: fakeClient(0),
    });
    const b = createNonceSource("server", { accountIndex: ACCOUNT, pool, client: fakeClient(0) });
    const held = await a.lease();
    let resolved = false;
    const queued = b.lease().then((l: NonceLease): NonceLease => {
      resolved = true;
      return l;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    // One pool, one lock per key — even across two sources sharing it.
    expect(resolved).toBe(false);
    held.release();
    const second = await queued;
    second.release();
    expect(resolved).toBe(true);
  });

  test("two sources for two accounts hold independent state", async () => {
    const clientA = fakeClient(10);
    const clientB = fakeClient(500);
    const a = createNonceSource("optimistic", { accountIndex: 1, keys: [0], client: clientA });
    const b = createNonceSource("optimistic", { accountIndex: 2, keys: [0], client: clientB });

    const leaseA = await a.lease();
    const leaseB = await b.lease();
    expect(leaseA.nonce).toBe(10n);
    expect(leaseB.nonce).toBe(500n);
    leaseA.release();
    leaseB.release();

    const snapshotA: NonceSnapshot = a.snapshot();
    expect(() => b.restore(snapshotA)).toThrow(LighterConfigError);
  });
});

describe("the documented submit loop", () => {
  /** The four-way dispatch from the module doc comment, exercised end to end. */
  async function send(
    src: NonceSource,
    result: unknown,
    classify: (e: unknown) => NonceOutcome,
  ): Promise<NonceOutcome> {
    const lease = await src.lease();
    try {
      const outcome = classify(result);
      switch (outcome) {
        case "accepted":
          lease.commit();
          break;
        case "rejected":
          lease.rollback();
          break;
        case "invalid-nonce":
          await src.resync(lease.apiKeyIndex);
          break;
        case "indeterminate":
          break;
      }
      return outcome;
    } finally {
      lease.release();
    }
  }

  test("accepted spends the slot, rejected returns it, indeterminate burns it", async () => {
    const client = fakeClient(0);
    const src = createNonceSource("optimistic", {
      accountIndex: ACCOUNT,
      keys: [0],
      client,
    });
    const classify = createOutcomeClassifier();

    expect(await send(src, { code: 200, tx_hash: "0x1" }, classify)).toBe("accepted");
    expect((src as OptimisticNonceSource).peek(0)).toBe(1n);

    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(await send(src, abort, classify)).toBe("indeterminate");
    expect((src as OptimisticNonceSource).peek(0)).toBe(2n);

    expect(await send(src, { code: 20001, message: "invalid param " }, classify)).toBe("rejected");
    expect((src as OptimisticNonceSource).peek(0)).toBe(2n);

    // One seeding fetch for the whole sequence; no resync ever fired.
    expect(client.calls).toEqual([0]);
  });
});
