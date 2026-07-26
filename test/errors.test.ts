import { describe, expect, test } from "bun:test";

import {
  ERR_ACCOUNT_NOT_FOUND,
  ERR_INVALID_AUTH,
  ERR_INVALID_MARKET_INDEX,
  ERR_INVALID_PARAM,
  ERR_NOT_FOUND,
  ERR_RESTRICTED_JURISDICTION,
  ERR_TIME_RANGE_EXCEEDED,
  ERR_TX_NOT_FOUND,
  L1SignatureRequiredError,
  LighterApiError,
  LighterAuthError,
  LighterBlockedError,
  LighterConfigError,
  LighterError,
  LighterMathError,
  LighterNonceError,
  LighterSignatureError,
  LighterTimeoutError,
  LighterTransportError,
  LighterValidationError,
  RESULT_OK,
  hasCode,
  isLighterApiError,
  isLighterAuthError,
  isLighterError,
  isRetryable,
} from "../src/errors.js";
import { REDACTED } from "../src/util/redact.js";

/** Minimal ambient for the vector loader. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

interface TxVectors {
  readonly authTokens: readonly { readonly token: string; readonly signatureBytesHex: string }[];
}

const vectorPath: string = new URL("../conformance/vectors/tx.json", import.meta.url).pathname;
const tx: TxVectors = JSON.parse(await Bun.file(vectorPath).text()) as TxVectors;
const REAL_TOKEN: string = tx.authTokens[0]?.token ?? "";
const REAL_SIG: string = tx.authTokens[0]?.signatureBytesHex ?? "";
const PRIVATE_KEY: string = `0x${"9f".repeat(40)}`;

describe("LighterError base", () => {
  test("carries the brand, a kind, and its own name", () => {
    const err = new LighterError("decode", "bad length");
    expect(err._tag).toBe("LighterError");
    expect(err.kind).toBe("decode");
    expect(err.name).toBe("LighterError");
    expect(err.message).toBe("bad length");
    expect(err).toBeInstanceOf(Error);
  });

  test("exposes cause via the ES2022 Error option", () => {
    const cause = new Error("underlying");
    expect(new LighterError("ws", "socket died", { cause }).cause).toBe(cause);
    expect(new LighterError("ws", "socket died").cause).toBeUndefined();
  });

  test("construction touches nothing global", () => {
    const now = Date.now;
    const random = Math.random;
    let touched = false;
    Date.now = (): number => {
      touched = true;
      return 0;
    };
    Math.random = (): number => {
      touched = true;
      return 0;
    };
    try {
      new LighterApiError({ status: 400, code: ERR_NOT_FOUND, message: "not found", path: "/p" });
      new LighterTimeoutError();
      new LighterValidationError("PRICE_TOO_LOW");
    } finally {
      Date.now = now;
      Math.random = random;
    }
    expect(touched).toBe(false);
  });
});

describe("each class sets kind and name", () => {
  const cases: readonly (readonly [LighterError, string, string])[] = [
    [new LighterConfigError("x"), "config", "LighterConfigError"],
    [new LighterValidationError("PRICE_TOO_LOW"), "validation", "LighterValidationError"],
    [new LighterMathError("EXCESSIVE_SLIPPAGE"), "math", "LighterMathError"],
    [new LighterSignatureError("x"), "signature", "LighterSignatureError"],
    [
      new L1SignatureRequiredError({ template: "t", txType: 8 }),
      "signature",
      "L1SignatureRequiredError",
    ],
    [new LighterNonceError("LEASE_EXHAUSTED"), "nonce", "LighterNonceError"],
    [new LighterTransportError("x"), "network", "LighterTransportError"],
    [new LighterTimeoutError(), "timeout", "LighterTimeoutError"],
    [
      new LighterApiError({ status: 400, code: ERR_NOT_FOUND, message: "not found", path: "/p" }),
      "http",
      "LighterApiError",
    ],
    [
      new LighterAuthError({
        status: 401,
        code: ERR_INVALID_AUTH,
        message: "invalid auth: expired token",
        path: "/p",
        reason: "expired",
      }),
      "auth",
      "LighterAuthError",
    ],
    [new LighterBlockedError({ rawBody: "<html/>", status: 403 }), "blocked", "LighterBlockedError"],
  ];

  for (const [err, kind, name] of cases) {
    test(`${name} → kind "${kind}"`, () => {
      expect(err._tag).toBe("LighterError");
      expect<string>(err.kind).toBe(kind);
      expect(err.name).toBe(name);
      expect(isLighterError(err)).toBe(true);
    });
  }
});

describe("guards are structural, never instanceof", () => {
  test("isLighterError accepts a foreign object carrying the brand", () => {
    expect(isLighterError({ _tag: "LighterError", kind: "http", message: "x" })).toBe(true);
  });

  test("isLighterError rejects non-errors", () => {
    expect(isLighterError(null)).toBe(false);
    expect(isLighterError(undefined)).toBe(false);
    expect(isLighterError("LighterError")).toBe(false);
    expect(isLighterError(new Error("plain"))).toBe(false);
    expect(isLighterError({ _tag: "LighterError" })).toBe(false);
    expect(isLighterError({ kind: "http" })).toBe(false);
  });

  test("isLighterApiError accepts a foreign api-error shape", () => {
    expect(
      isLighterApiError({ _tag: "LighterError", kind: "http", status: 400, code: 29404 }),
    ).toBe(true);
    expect(
      isLighterApiError({ _tag: "LighterError", kind: "auth", status: 401, code: 20013 }),
    ).toBe(true);
  });

  test("isLighterApiError rejects other lighter errors", () => {
    expect(isLighterApiError(new LighterTransportError("x"))).toBe(false);
    expect(isLighterApiError(new LighterBlockedError({ rawBody: "<html/>" }))).toBe(false);
    // kind is right but status/code are missing.
    expect(isLighterApiError({ _tag: "LighterError", kind: "http" })).toBe(false);
  });

  test("isLighterAuthError discriminates on kind and reason", () => {
    const auth = new LighterAuthError({
      status: 401,
      code: ERR_INVALID_AUTH,
      message: "invalid auth: invalid auth string",
      path: "/p",
      reason: "malformed",
    });
    expect(isLighterAuthError(auth)).toBe(true);
    expect(isLighterApiError(auth)).toBe(true);
    expect(
      isLighterAuthError({
        _tag: "LighterError",
        kind: "auth",
        status: 401,
        code: 20013,
        reason: "deadline-or-signature",
      }),
    ).toBe(true);
    expect(
      isLighterAuthError(
        new LighterApiError({ status: 400, code: ERR_INVALID_PARAM, message: "invalid param " }),
      ),
    ).toBe(false);
  });

  test("no guard depends on the constructor identity", () => {
    // A structural clone with a broken prototype chain still passes.
    const real = new LighterApiError({
      status: 400,
      code: ERR_NOT_FOUND,
      message: "not found",
      path: "/api/v1/account",
    });
    const clone = { ...real, _tag: real._tag, kind: real.kind, status: real.status, code: real.code };
    Object.setPrototypeOf(clone, null);
    expect(clone instanceof LighterApiError).toBe(false);
    expect(isLighterApiError(clone)).toBe(true);
  });
});

describe("LighterApiError", () => {
  test("an unobserved code survives construction intact", () => {
    const err = new LighterApiError({
      status: 400,
      code: 31337,
      message: "brand new failure",
      path: "/api/v1/whatever",
    });
    expect(err.code).toBe(31337);
    expect(hasCode(err, 31337)).toBe(true);
    expect(hasCode(err, ERR_NOT_FOUND)).toBe(false);
    expect(err.toJSON()["code"]).toBe(31337);
  });

  test("path never contains a query string", () => {
    const err = new LighterApiError({
      status: 400,
      code: ERR_INVALID_PARAM,
      message: "invalid param ",
      path: `/api/v1/transferFeeInfo?account_index=1&auth=${REAL_TOKEN}`,
    });
    expect(err.path).toBe("/api/v1/transferFeeInfo");
    expect(err.path).not.toContain("?");
    expect(JSON.stringify(err)).not.toContain(REAL_SIG);
  });

  test("path drops the query when handed a full URL", () => {
    const err = new LighterApiError({
      status: 400,
      code: ERR_NOT_FOUND,
      path: `https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&auth=${REAL_TOKEN}`,
    });
    expect(err.path).toBe("/api/v1/account");
  });

  test("messageText is verbatim and shortMessage is trimmed", () => {
    const err = new LighterApiError({
      status: 400,
      code: ERR_INVALID_PARAM,
      message: "invalid param ",
      path: "/api/v1/x",
    });
    expect(err.messageText).toBe("invalid param ");
    expect(err.shortMessage).toBe("invalid param");
  });

  test("not-found is HTTP 400 with code 29404, and there is no 404 path", () => {
    const err = new LighterApiError({
      status: 400,
      code: ERR_NOT_FOUND,
      message: "not found",
      path: "/api/v1/account",
    });
    expect(err.status).toBe(400);
    expect(hasCode(err, ERR_NOT_FOUND)).toBe(true);
  });

  test("keeps requestId only when supplied", () => {
    const withId = new LighterApiError({
      status: 400,
      code: ERR_NOT_FOUND,
      requestId: "cf-abc",
    });
    expect(withId.requestId).toBe("cf-abc");
    expect(new LighterApiError({ status: 400, code: ERR_NOT_FOUND }).requestId).toBeUndefined();
  });

  test("20013 arrives with HTTP 401 while other domain errors arrive with 400", () => {
    const auth = new LighterAuthError({
      status: 401,
      code: ERR_INVALID_AUTH,
      message: "invalid auth: invalid deadline",
      path: "/api/v1/transferFeeInfo",
      reason: "deadline-or-signature",
    });
    expect(auth.status).toBe(401);
    expect(auth.kind).toBe("auth");
    expect(auth.reason).toBe("deadline-or-signature");
  });

  test("the geo-block keeps its message verbatim", () => {
    const text =
      "You are accessing Lighter from a restricted jurisdiction. For more information, see the https://lighter.xyz/terms";
    const err = new LighterApiError({
      status: 400,
      code: ERR_RESTRICTED_JURISDICTION,
      message: text,
      path: "/api/v1/sendTx",
    });
    expect(err.messageText).toBe(text);
    expect(hasCode(err, ERR_RESTRICTED_JURISDICTION)).toBe(true);
  });
});

describe("isRetryable", () => {
  test("true for timeouts and retryable transport errors", () => {
    expect(isRetryable(new LighterTimeoutError())).toBe(true);
    expect(isRetryable(new LighterTransportError("reset"))).toBe(true);
    expect(isRetryable(new LighterTransportError("reset", { retryable: true }))).toBe(true);
  });

  test("false for a transport error explicitly marked non-retryable", () => {
    const err = new LighterTransportError("bad request body", { retryable: false });
    expect(err.retryable).toBe(false);
    expect(isRetryable(err)).toBe(false);
  });

  test("false for every api error, 429-derived included", () => {
    expect(
      isRetryable(new LighterApiError({ status: 429, code: 20001, message: "slow down" })),
    ).toBe(false);
    expect(
      isRetryable(
        new LighterAuthError({ status: 401, code: ERR_INVALID_AUTH, reason: "expired" }),
      ),
    ).toBe(false);
    expect(isRetryable(new LighterApiError({ status: 500, code: 500 }))).toBe(false);
  });

  test("false for everything else", () => {
    expect(isRetryable(new LighterBlockedError({ rawBody: "<html/>" }))).toBe(false);
    expect(isRetryable(new LighterConfigError("no base url"))).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });

  test("works on a foreign structural shape", () => {
    expect(isRetryable({ _tag: "LighterError", kind: "timeout" })).toBe(true);
    expect(isRetryable({ _tag: "LighterError", kind: "network", retryable: true })).toBe(true);
    expect(isRetryable({ _tag: "LighterError", kind: "network" })).toBe(false);
  });
});

describe("hasCode", () => {
  test("matches string codes without knowing the class", () => {
    expect(hasCode(new LighterValidationError("ORDER_PRICE_TOO_LOW"), "ORDER_PRICE_TOO_LOW")).toBe(
      true,
    );
    expect(hasCode(new LighterMathError("EXCESSIVE_SLIPPAGE"), "EXCESSIVE_SLIPPAGE")).toBe(true);
    expect(hasCode(new LighterNonceError("KEY_UNKNOWN"), "KEY_UNKNOWN")).toBe(true);
    expect(hasCode(new LighterNonceError("KEY_UNKNOWN"), "INVALID_NONCE")).toBe(false);
  });

  test("does not coerce between string and number", () => {
    const err = new LighterApiError({ status: 400, code: 29404 });
    expect(hasCode(err, 29404)).toBe(true);
    expect(hasCode(err, "29404")).toBe(false);
  });

  test("false for a non-lighter value", () => {
    expect(hasCode({ code: 29404 }, 29404)).toBe(false);
    expect(hasCode(undefined, 29404)).toBe(false);
  });
});

describe("subclass fields", () => {
  test("LighterValidationError carries field, txType and a bigint bound", () => {
    const err = new LighterValidationError("BASE_AMOUNT_TOO_HIGH", undefined, {
      field: "BaseAmount",
      txType: 14,
      bound: 281474976710654n,
    });
    expect(err.code).toBe("BASE_AMOUNT_TOO_HIGH");
    expect(err.message).toBe("BASE_AMOUNT_TOO_HIGH");
    expect(err.field).toBe("BaseAmount");
    expect(err.txType).toBe(14);
    expect(err.bound).toBe(281474976710654n);
  });

  test("a bigint bound does not break JSON serialisation", () => {
    const err = new LighterValidationError("BASE_AMOUNT_TOO_HIGH", "too big", {
      bound: 281474976710654n,
    });
    expect(() => JSON.stringify(err)).not.toThrow();
    expect(JSON.parse(JSON.stringify(err))["bound"]).toBe("281474976710654");
  });

  test("L1SignatureRequiredError carries the template and tx type", () => {
    const err = new L1SignatureRequiredError({ template: "Register API key\n...", txType: 8 });
    expect(err.template).toBe("Register API key\n...");
    expect(err.txType).toBe(8);
    expect(err.kind).toBe("signature");
    expect(isLighterError(err)).toBe(true);
  });

  test("LighterBlockedError keeps the raw non-JSON body", () => {
    const err = new LighterBlockedError({
      rawBody: "<HTML><HEAD><TITLE>403 Forbidden</TITLE></HEAD></HTML>",
      status: 403,
      path: "/api/v1/currentHeight?x=1",
      requestId: "cf-xyz",
    });
    expect(err.rawBody).toContain("403 Forbidden");
    expect(err.status).toBe(403);
    expect(err.path).toBe("/api/v1/currentHeight");
    expect(err.requestId).toBe("cf-xyz");
  });
});

describe("toJSON is redacted, plain, and stack-free", () => {
  const everyError = (): readonly LighterError[] => [
    new LighterError("decode", `raw ${REAL_TOKEN}`, { cause: { api_token: "shhh" } }),
    new LighterConfigError(`bad key ${PRIVATE_KEY}`, { cause: { private_key: PRIVATE_KEY } }),
    new LighterValidationError("SIGNATURE_INVALID", `sig ${REAL_TOKEN}`, {
      field: "Signature",
      bound: 1n,
      cause: { signature: REAL_SIG },
    }),
    new LighterMathError("NO_LIQUIDITY", `book empty ${REAL_TOKEN}`),
    new LighterSignatureError(`key ${PRIVATE_KEY}`, { cause: { privateKeyHex: PRIVATE_KEY } }),
    new L1SignatureRequiredError({ template: `sign ${REAL_TOKEN}`, txType: 8 }),
    new LighterNonceError("INVALID_NONCE", `nonce ${REAL_TOKEN}`),
    new LighterTransportError(`fetch failed for ${REAL_TOKEN}`, {
      cause: new Error(`inner ${PRIVATE_KEY}`),
    }),
    new LighterTimeoutError(`timed out ${REAL_TOKEN}`),
    new LighterApiError({
      status: 400,
      code: ERR_INVALID_PARAM,
      message: "invalid param ",
      path: `/api/v1/x?auth=${REAL_TOKEN}`,
      requestId: "cf-1",
      body: { code: 20001, message: "invalid param ", api_token: "shhh", auth: REAL_TOKEN },
      cause: new Error(`cause ${REAL_TOKEN}`),
    }),
    new LighterAuthError({
      status: 401,
      code: ERR_INVALID_AUTH,
      message: "invalid auth: expired token",
      path: `/api/v1/y?auth=${REAL_TOKEN}`,
      reason: "expired",
      body: { auth: REAL_TOKEN },
    }),
    new LighterBlockedError({
      rawBody: `<html>token ${REAL_TOKEN}</html>`,
      status: 403,
      path: `/api/v1/currentHeight?auth=${REAL_TOKEN}`,
    }),
  ];

  test("no serialised error leaks a token, api_token, or private key", () => {
    for (const err of everyError()) {
      const viaToJson = JSON.stringify(err.toJSON());
      const viaStringify = JSON.stringify(err);
      for (const serialised of [viaToJson, viaStringify]) {
        expect(serialised).not.toContain(REAL_SIG);
        expect(serialised).not.toContain(REAL_TOKEN);
        expect(serialised).not.toContain(PRIVATE_KEY);
        expect(serialised).not.toContain("shhh");
        expect(serialised).toContain(REDACTED);
      }
    }
  });

  test("no serialised error carries a stack or a query string", () => {
    for (const err of everyError()) {
      const json = err.toJSON();
      expect(json).not.toHaveProperty("stack");
      expect(JSON.stringify(json)).not.toContain("?auth=");
    }
  });

  test("carries name, _tag, kind, code and message", () => {
    const json = new LighterApiError({
      status: 400,
      code: ERR_ACCOUNT_NOT_FOUND,
      message: "account not found",
      path: "/api/v1/accountLimits",
    }).toJSON();
    expect(json["name"]).toBe("LighterApiError");
    expect(json["_tag"]).toBe("LighterError");
    expect(json["kind"]).toBe("http");
    expect(json["code"]).toBe(ERR_ACCOUNT_NOT_FOUND);
    expect(json["message"]).toContain("account not found");
    expect(json["status"]).toBe(400);
    expect(json["path"]).toBe("/api/v1/accountLimits");
    expect(json["messageText"]).toBe("account not found");
  });

  test("the result is a plain object usable by a logger", () => {
    const json = new LighterTimeoutError("slow").toJSON();
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(json["retryable"]).toBe(true);
  });
});

describe("domain code constants", () => {
  test("hold the observed values", () => {
    expect(RESULT_OK).toBe(200);
    expect(ERR_INVALID_PARAM).toBe(20001);
    expect(ERR_INVALID_AUTH).toBe(20013);
    expect(ERR_RESTRICTED_JURISDICTION).toBe(20558);
    expect(ERR_ACCOUNT_NOT_FOUND).toBe(21100);
    expect(ERR_TX_NOT_FOUND).toBe(21500);
    expect(ERR_INVALID_MARKET_INDEX).toBe(21602);
    expect(ERR_TIME_RANGE_EXCEEDED).toBe(22403);
    expect(ERR_NOT_FOUND).toBe(29404);
  });
});
