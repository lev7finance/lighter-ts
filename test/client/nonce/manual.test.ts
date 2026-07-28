import { describe, expect, test } from "bun:test";

import { LighterConfigError, LighterNonceError } from "../../../src/errors.js";
import { ManualNonceSource } from "../../../src/client/nonce/manual.js";
import type { NonceSnapshot } from "../../../src/client/nonce/types.js";

const ACCOUNT = 3;

describe("ManualNonceSource", () => {
  test("refuses to allocate, with LEASE_EXHAUSTED", async () => {
    const src = new ManualNonceSource({ accountIndex: ACCOUNT });
    expect(src.kind).toBe("manual");
    await expect(src.lease()).rejects.toThrow(LighterNonceError);
    await src.lease().catch((e: unknown) => {
      expect((e as LighterNonceError).code).toBe("LEASE_EXHAUSTED");
      expect((e as LighterNonceError).kind).toBe("nonce");
    });
  });

  test("rejects rather than throwing synchronously, so .catch() works", () => {
    const src = new ManualNonceSource({ accountIndex: ACCOUNT });
    let caught: unknown;
    const promise = src.lease().catch((e: unknown) => {
      caught = e;
    });
    expect(promise).toBeInstanceOf(Promise);
    return promise.then(() => {
      expect(caught).toBeInstanceOf(LighterNonceError);
    });
  });

  test("resync is a no-op — there is no counter to be stale", async () => {
    const src = new ManualNonceSource({ accountIndex: ACCOUNT });
    await src.resync();
  });

  test("snapshots empty, and round-trips through JSON", () => {
    const src = new ManualNonceSource({ accountIndex: ACCOUNT });
    const snap = src.snapshot();
    expect(snap).toEqual({ version: 1, kind: "manual", accountIndex: ACCOUNT, keys: [] });
    const wire = JSON.parse(JSON.stringify(snap)) as NonceSnapshot;
    expect(() => src.restore(wire)).not.toThrow();
  });

  test("refuses a snapshot from another account or strategy", () => {
    const src = new ManualNonceSource({ accountIndex: ACCOUNT });
    expect(() =>
      src.restore({ version: 1, kind: "manual", accountIndex: ACCOUNT + 1, keys: [] }),
    ).toThrow(LighterConfigError);
    expect(() =>
      src.restore({ version: 1, kind: "optimistic", accountIndex: ACCOUNT, keys: [] }),
    ).toThrow(LighterConfigError);
  });

  test("rejects a non-integer account index", () => {
    expect(() => new ManualNonceSource({ accountIndex: 0.5 })).toThrow(LighterConfigError);
  });

  test("two sources do not share state", () => {
    const a = new ManualNonceSource({ accountIndex: 1 });
    const b = new ManualNonceSource({ accountIndex: 2 });
    expect(a.snapshot().accountIndex).toBe(1);
    expect(b.snapshot().accountIndex).toBe(2);
  });
});
