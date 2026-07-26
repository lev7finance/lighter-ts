import { describe, expect, test } from "bun:test";

import {
  LighterApiError,
  LighterAuthError,
  LighterBlockedError,
  LighterConfigError,
  LighterError,
  LighterNonceError,
  LighterTimeoutError,
  LighterTransportError,
  LighterValidationError,
} from "../../../src/errors.js";
import {
  classifyOutcome,
  createLease,
  createOutcomeClassifier,
  INVALID_NONCE_API_CODES,
  readNextNonce,
} from "../../../src/client/nonce/types.js";
import type { NonceLease } from "../../../src/client/nonce/types.js";

const NONCE_CODE = 21120;

function apiError(code: number): LighterApiError {
  return new LighterApiError({ status: 400, code, message: "invalid nonce ", path: "/api/v1/sendTx" });
}

describe("readNextNonce", () => {
  test("an absent nonce is 0 — Go omitempty drops the zero value", () => {
    expect(readNextNonce({ code: 200 })).toBe(0n);
  });

  test("reads an integer verbatim", () => {
    expect(readNextNonce({ code: 200, nonce: 0 })).toBe(0n);
    expect(readNextNonce({ code: 200, nonce: 42 })).toBe(42n);
    expect(readNextNonce({ code: 200, nonce: Number.MAX_SAFE_INTEGER })).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  test("rejects a float rather than truncating it", () => {
    expect(() => readNextNonce({ code: 200, nonce: 8.2 })).toThrow(LighterValidationError);
  });

  test("rejects a value past the safe-integer range rather than guessing", () => {
    expect(() => readNextNonce({ code: 200, nonce: 2 ** 53 })).toThrow(LighterValidationError);
  });

  test("rejects a negative nonce", () => {
    try {
      readNextNonce({ code: 200, nonce: -1 });
      throw new Error("expected a throw");
    } catch (e: unknown) {
      expect((e as LighterValidationError).code).toBe("NONCE_TOO_LOW");
    }
  });
});

describe("classifyOutcome", () => {
  test("nothing thrown is acceptance", () => {
    expect(classifyOutcome(undefined)).toBe("accepted");
    expect(classifyOutcome(null)).toBe("accepted");
  });

  test("a body with code 200, or with no code at all, is acceptance", () => {
    expect(classifyOutcome({ code: 200, tx_hash: "0xabc" })).toBe("accepted");
    expect(classifyOutcome({ seconds: 1542 })).toBe("accepted");
  });

  test("a timeout is indeterminate — the transaction may still have landed", () => {
    expect(classifyOutcome(new LighterTimeoutError())).toBe("indeterminate");
  });

  test("a transport failure is indeterminate: a reset can follow a written request", () => {
    expect(classifyOutcome(new LighterTransportError("connection reset"))).toBe("indeterminate");
  });

  test("a foreign AbortError or TimeoutError is indeterminate", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyOutcome(abort)).toBe("indeterminate");
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(classifyOutcome(timeout)).toBe("indeterminate");
  });

  test("a websocket failure is indeterminate — the frame may be on the wire", () => {
    expect(classifyOutcome(new LighterError("ws", "socket closed"))).toBe("indeterminate");
  });

  test("an unrecognised value is indeterminate, which is the do-nothing default", () => {
    expect(classifyOutcome(new TypeError("fetch failed"))).toBe("indeterminate");
    expect(classifyOutcome("boom")).toBe("indeterminate");
    expect(classifyOutcome(7)).toBe("indeterminate");
  });

  test("an API refusal is a rejection", () => {
    expect(classifyOutcome(apiError(20001))).toBe("rejected");
    expect(
      classifyOutcome(
        new LighterAuthError({ status: 401, code: 20013, reason: "expired", message: "bad auth" }),
      ),
    ).toBe("rejected");
  });

  test("a CDN interstitial is a rejection — the origin never saw the request", () => {
    expect(classifyOutcome(new LighterBlockedError({ rawBody: "<html>", status: 403 }))).toBe(
      "rejected",
    );
  });

  test("local failures are rejections: nothing was sent", () => {
    expect(classifyOutcome(new LighterValidationError("PRICE_TOO_LOW"))).toBe("rejected");
    expect(classifyOutcome(new LighterConfigError("no endpoint"))).toBe("rejected");
    expect(classifyOutcome(new LighterNonceError("LEASE_EXHAUSTED"))).toBe("rejected");
  });

  test("our own INVALID_NONCE is the invalid-nonce outcome", () => {
    expect(classifyOutcome(new LighterNonceError("INVALID_NONCE"))).toBe("invalid-nonce");
  });

  test("a configured numeric code is invalid-nonce; the same code is a plain rejection by default", () => {
    expect(INVALID_NONCE_API_CODES).toEqual([]);
    expect(classifyOutcome(apiError(NONCE_CODE))).toBe("rejected");
    expect(classifyOutcome(apiError(NONCE_CODE), { invalidNonceCodes: [NONCE_CODE] })).toBe(
      "invalid-nonce",
    );
    expect(classifyOutcome({ code: NONCE_CODE }, { invalidNonceCodes: [NONCE_CODE] })).toBe(
      "invalid-nonce",
    );
  });

  test("classification never reads message text", () => {
    // Same message, different codes: the message is not stable and carries trailing whitespace.
    const classify = createOutcomeClassifier([NONCE_CODE]);
    expect(classify(apiError(NONCE_CODE))).toBe("invalid-nonce");
    expect(classify(apiError(20001))).toBe("rejected");
  });

  test("a bound classifier copies its code list, so later mutation is not observed", () => {
    const codes = [NONCE_CODE];
    const classify = createOutcomeClassifier(codes);
    codes.push(20001);
    expect(classify(apiError(20001))).toBe("rejected");
  });

  test("a host system error with a string code is not mistaken for a response body", () => {
    const sysError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(classifyOutcome(sysError)).toBe("indeterminate");
  });
});

describe("createLease", () => {
  function spy(): { calls: string[]; lease: NonceLease } {
    const calls: string[] = [];
    const lease = createLease({
      apiKeyIndex: 3,
      nonce: 11n,
      onCommit: () => calls.push("commit"),
      onRollback: () => calls.push("rollback"),
      onRelease: () => calls.push("release"),
    });
    return { calls, lease };
  }

  test("carries the slot and defaults skipNonce to false", () => {
    const { lease } = spy();
    expect(lease.apiKeyIndex).toBe(3);
    expect(lease.nonce).toBe(11n);
    expect(lease.skipNonce).toBe(false);
  });

  test("is frozen — a lease is a capability, not a mutable record", () => {
    const { lease } = spy();
    expect(Object.isFrozen(lease)).toBe(true);
  });

  test("commit and rollback are terminal: the first one wins", () => {
    const a = spy();
    a.lease.commit();
    a.lease.commit();
    a.lease.rollback();
    expect(a.calls).toEqual(["commit"]);

    const b = spy();
    b.lease.rollback();
    b.lease.commit();
    expect(b.calls).toEqual(["rollback"]);
  });

  test("release is idempotent", () => {
    const { calls, lease } = spy();
    lease.release();
    lease.release();
    expect(calls).toEqual(["release"]);
  });

  test("releasing without settling burns the slot — no commit, no rollback", () => {
    const { calls, lease } = spy();
    lease.release();
    expect(calls).toEqual(["release"]);
  });

  test("Symbol.dispose releases, where the runtime has it", () => {
    const { calls, lease } = spy();
    const dispose = (Symbol as { dispose?: symbol }).dispose;
    if (typeof dispose !== "symbol") return;
    (lease as unknown as Record<symbol, () => void>)[dispose]?.();
    expect(calls).toEqual(["release"]);
  });

  test("a `using` declaration releases on scope exit, including on a throw", () => {
    const dispose = (Symbol as { dispose?: symbol }).dispose;
    if (typeof dispose !== "symbol") return;

    const happy = spy();
    {
      using _lease = happy.lease;
      expect(_lease.nonce).toBe(11n);
    }
    expect(happy.calls).toEqual(["release"]);

    const sad = spy();
    expect(() => {
      using _lease = sad.lease;
      throw new Error("signer exploded");
    }).toThrow("signer exploded");
    expect(sad.calls).toEqual(["release"]);
  });

  test("onCommit and onRollback are optional", () => {
    let released = 0;
    const lease = createLease({
      apiKeyIndex: 0,
      nonce: 0n,
      onRelease: () => {
        released += 1;
      },
    });
    lease.commit();
    lease.release();
    expect(released).toBe(1);
  });
});
