/**
 * Tests for the WebSocket error taxonomy.
 *
 * Two properties carry real weight here and are tested harder than the rest:
 *
 * - **The guard is structural.** `instanceof` breaks across bundler chunks and realms
 *   (`docs/ARCHITECTURE.md` ADR-8), so `isLighterWsError` must accept an error that never passed
 *   through this module's constructors — a `structuredClone`, a `toJSON` round trip, or a duplicate
 *   copy of the package.
 * - **The numeric code survives.** The server's code set is open and undocumented in both reference
 *   SDKs, so an unlisted code must reach the caller unmodified rather than be flattened.
 */

import { describe, expect, test } from "bun:test";

import { LighterError, isLighterError } from "../../src/errors.js";
import {
  LighterWsAuthError,
  LighterWsClosedError,
  LighterWsError,
  LighterWsOverflowError,
  LighterWsRateLimitError,
  LighterWsReadOnlyError,
  LighterWsTimeoutError,
  WS_ERR_ALREADY_SUBSCRIBED,
  WS_ERR_API_KEY_NOT_FOUND,
  WS_ERR_API_TOKEN_NOT_FOUND,
  WS_ERR_API_TOKEN_REVOKED,
  WS_ERR_FAILED_TO_CONNECT,
  WS_ERR_FAILED_TO_FETCH,
  WS_ERR_FAILED_TO_SUBSCRIBE,
  WS_ERR_INVALID_ACCOUNT_TYPE,
  WS_ERR_INVALID_API_KEY_INDEX,
  WS_ERR_INVALID_CHANNEL,
  WS_ERR_INVALID_DATA,
  WS_ERR_INVALID_JSON,
  WS_ERR_INVALID_SIGNATURE,
  WS_ERR_INVALID_TYPE,
  WS_ERR_NOT_SUBSCRIBED,
  WS_ERR_OPERATION_NOT_SUPPORTED,
  WS_ERR_TOO_MANY_ACCOUNTS,
  WS_ERR_TOO_MANY_CONNECTIONS,
  WS_ERR_TOO_MANY_INFLIGHT,
  WS_ERR_TOO_MANY_MESSAGES,
  WS_ERR_TOO_MANY_REQUESTS,
  WS_ERR_TOO_MANY_SUBSCRIPTIONS,
  WS_ERR_TOO_MANY_WITHDRAWALS,
  isLighterWsError,
  wsLimitName,
} from "../../src/ws/errors.js";

describe("the hierarchy", () => {
  test("every class is a LighterError with kind ws", () => {
    const errors: LighterWsError[] = [
      new LighterWsError("plain"),
      new LighterWsAuthError("auth"),
      new LighterWsRateLimitError("limit", { limit: "subscriptions" }),
      new LighterWsTimeoutError("timeout"),
      new LighterWsReadOnlyError(),
      new LighterWsOverflowError("overflow", { dropped: 3 }),
      new LighterWsClosedError("closed", { wsCode: 1006 }),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LighterError);
      expect(error.kind).toBe("ws");
      expect(isLighterError(error)).toBe(true);
      expect(isLighterWsError(error)).toBe(true);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test("each class stamps its own name and wsKind", () => {
    expect(new LighterWsError("x").name).toBe("LighterWsError");
    expect(new LighterWsError("x").wsKind).toBe("generic");
    expect(new LighterWsAuthError("x").name).toBe("LighterWsAuthError");
    expect(new LighterWsAuthError("x").wsKind).toBe("auth");
    expect(new LighterWsRateLimitError("x", { limit: "messages" }).wsKind).toBe("rate-limit");
    expect(new LighterWsTimeoutError("x").wsKind).toBe("timeout");
    expect(new LighterWsReadOnlyError().wsKind).toBe("read-only");
    expect(new LighterWsOverflowError("x", { dropped: 1 }).wsKind).toBe("overflow");
    expect(new LighterWsClosedError("x", { wsCode: 4000 }).wsKind).toBe("closed");
  });

  test("subclasses are instances of the base", () => {
    expect(new LighterWsAuthError("x")).toBeInstanceOf(LighterWsError);
    expect(new LighterWsClosedError("x", { wsCode: 1000 })).toBeInstanceOf(LighterWsError);
  });
});

describe("payloads", () => {
  test("the numeric code survives intact, listed or not", () => {
    expect(new LighterWsError("x", { code: WS_ERR_INVALID_CHANNEL }).code).toBe(30005);
    // An unlisted code is not remapped, not clamped, not dropped.
    expect(new LighterWsError("x", { code: 987654 }).code).toBe(987654);
  });

  test("no code means no own property, not a null", () => {
    const error = new LighterWsError("x");
    expect(error.code).toBeUndefined();
    expect(Object.hasOwn(error, "code")).toBe(false);
  });

  test("the channel is carried when known", () => {
    const error = new LighterWsAuthError("bad token", { channel: "account_all_assets/1234" });
    expect(error.channel).toBe("account_all_assets/1234");
    expect(Object.hasOwn(new LighterWsAuthError("x"), "channel")).toBe(false);
  });

  test("rate-limit errors always name the limit", () => {
    const error = new LighterWsRateLimitError("too many", {
      limit: "subscriptions",
      code: WS_ERR_TOO_MANY_SUBSCRIPTIONS,
    });
    expect(error.limit).toBe("subscriptions");
    expect(error.code).toBe(23001);
  });

  test("a timeout carries the locally computed tx hash, which is the recovery path", () => {
    const error = new LighterWsTimeoutError("no ack", { txHash: "ab".repeat(40) });
    expect(error.txHash).toBe("ab".repeat(40));
    expect(Object.hasOwn(new LighterWsTimeoutError("no ack"), "txHash")).toBe(false);
  });

  test("overflow reports how many frames were dropped", () => {
    expect(new LighterWsOverflowError("behind", { dropped: 512 }).dropped).toBe(512);
  });

  test("the close error keeps the wire close code and reason", () => {
    const error = new LighterWsClosedError("upgrade refused", {
      wsCode: 1006,
      wsReason: "Expected 101 status code",
    });
    expect(error.wsCode).toBe(1006);
    expect(error.wsReason).toBe("Expected 101 status code");
    expect(Object.hasOwn(new LighterWsClosedError("x", { wsCode: 4000 }), "wsReason")).toBe(false);
  });

  test("a refused upgrade can carry the probed reason, which the close frame never has", () => {
    // The seam: a plain HTTPS GET against the stream URL is the only way to see code 20558.
    const error = new LighterWsClosedError(
      "You are accessing Lighter from a restricted jurisdiction.",
      { wsCode: 1006, wsReason: "Expected 101 status code", code: 20558 },
    );
    expect(error.code).toBe(20558);
    expect(error.message).toContain("restricted jurisdiction");
  });

  test("the read-only error has a usable default message", () => {
    expect(new LighterWsReadOnlyError().message).toContain("read-only");
  });

  test("cause is preserved", () => {
    const cause = new Error("socket died");
    expect(new LighterWsError("x", { cause }).cause).toBe(cause);
  });

  test("no message anywhere names LighterWsPool, which was cut from v1", () => {
    const errors: LighterWsError[] = [
      new LighterWsError("plain"),
      new LighterWsReadOnlyError(),
      new LighterWsRateLimitError("too many connections", { limit: "connections" }),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain("Pool");
    }
  });
});

describe("isLighterWsError", () => {
  test("true for every class here", () => {
    expect(isLighterWsError(new LighterWsError("x"))).toBe(true);
    expect(isLighterWsError(new LighterWsClosedError("x", { wsCode: 1006 }))).toBe(true);
  });

  test("false for other Lighter kinds and for non-errors", () => {
    expect(isLighterWsError(new LighterError("network", "x"))).toBe(false);
    expect(isLighterWsError(new Error("x"))).toBe(false);
    expect(isLighterWsError(null)).toBe(false);
    expect(isLighterWsError(undefined)).toBe(false);
    expect(isLighterWsError("ws")).toBe(false);
    expect(isLighterWsError({ kind: "ws" })).toBe(false);
    expect(isLighterWsError({ _tag: "LighterError" })).toBe(false);
  });

  test("true across a realm boundary — a structural clone, not an instance", () => {
    // This is the case `instanceof` gets wrong, and the reason the guard reads data.
    const original = new LighterWsRateLimitError("too many", {
      limit: "connections",
      code: WS_ERR_TOO_MANY_CONNECTIONS,
    });
    const cloned: unknown = {
      _tag: original._tag,
      kind: original.kind,
      wsKind: original.wsKind,
      code: original.code,
      limit: original.limit,
      message: original.message,
    };
    expect(cloned).not.toBeInstanceOf(LighterWsError);
    expect(isLighterWsError(cloned)).toBe(true);
    expect(isLighterWsError(JSON.parse(JSON.stringify(original.toJSON())))).toBe(true);
  });

  test("a toJSON projection keeps the fields a consumer branches on", () => {
    const json = new LighterWsClosedError("closed", { wsCode: 1006, code: 20558 }).toJSON();
    expect(json["kind"]).toBe("ws");
    expect(json["code"]).toBe(20558);
    expect(json["wsCode"]).toBe(1006);
    expect(json["wsKind"]).toBe("closed");
    // Stacks are never serialised.
    expect(Object.hasOwn(json, "stack")).toBe(false);
  });
});

describe("documented code constants", () => {
  test("the 30000–30012 WebSocket band", () => {
    expect([
      WS_ERR_INVALID_JSON,
      WS_ERR_INVALID_TYPE,
      WS_ERR_NOT_SUBSCRIBED,
      WS_ERR_ALREADY_SUBSCRIBED,
      WS_ERR_FAILED_TO_FETCH,
      WS_ERR_INVALID_CHANNEL,
      WS_ERR_OPERATION_NOT_SUPPORTED,
      WS_ERR_INVALID_DATA,
      WS_ERR_INVALID_ACCOUNT_TYPE,
      WS_ERR_TOO_MANY_MESSAGES,
      WS_ERR_TOO_MANY_INFLIGHT,
      WS_ERR_FAILED_TO_CONNECT,
      WS_ERR_FAILED_TO_SUBSCRIBE,
    ]).toEqual([
      30000, 30001, 30002, 30003, 30004, 30005, 30006, 30007, 30008, 30009, 30010, 30011, 30012,
    ]);
  });

  test("the 23000–23004 rate-limit band", () => {
    expect([
      WS_ERR_TOO_MANY_REQUESTS,
      WS_ERR_TOO_MANY_SUBSCRIPTIONS,
      WS_ERR_TOO_MANY_ACCOUNTS,
      WS_ERR_TOO_MANY_CONNECTIONS,
      WS_ERR_TOO_MANY_WITHDRAWALS,
    ]).toEqual([23000, 23001, 23002, 23003, 23004]);
  });

  test("the selected auth-band codes", () => {
    expect([
      WS_ERR_API_KEY_NOT_FOUND,
      WS_ERR_INVALID_API_KEY_INDEX,
      WS_ERR_INVALID_SIGNATURE,
      WS_ERR_API_TOKEN_NOT_FOUND,
      WS_ERR_API_TOKEN_REVOKED,
    ]).toEqual([21109, 21110, 21120, 61005, 61006]);
  });
});

describe("wsLimitName", () => {
  test("names each documented budget", () => {
    expect(wsLimitName(WS_ERR_TOO_MANY_MESSAGES)).toBe("messages");
    expect(wsLimitName(WS_ERR_TOO_MANY_REQUESTS)).toBe("messages");
    expect(wsLimitName(WS_ERR_TOO_MANY_INFLIGHT)).toBe("inflight");
    expect(wsLimitName(WS_ERR_TOO_MANY_SUBSCRIPTIONS)).toBe("subscriptions");
    expect(wsLimitName(WS_ERR_TOO_MANY_ACCOUNTS)).toBe("accounts");
    expect(wsLimitName(WS_ERR_TOO_MANY_CONNECTIONS)).toBe("connections");
    expect(wsLimitName(WS_ERR_TOO_MANY_WITHDRAWALS)).toBe("l2-withdrawals");
  });

  test("undefined for anything that is not a rate limit", () => {
    expect(wsLimitName(WS_ERR_INVALID_JSON)).toBeUndefined();
    expect(wsLimitName(200)).toBeUndefined();
  });
});
