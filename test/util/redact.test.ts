import { describe, expect, test } from "bun:test";

import { REDACTED, redact, redactString, redactUrl } from "../../src/util/redact.js";

/** Minimal ambient for the vector loader. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

interface AuthTokenVector {
  readonly message: string;
  readonly signatureBytesHex: string;
  readonly token: string;
}
interface TxVectors {
  readonly authTokens: readonly AuthTokenVector[];
}

const vectorPath: string = new URL("../../conformance/vectors/tx.json", import.meta.url).pathname;
const tx: TxVectors = JSON.parse(await Bun.file(vectorPath).text()) as TxVectors;
const authVector: AuthTokenVector = tx.authTokens[0] as AuthTokenVector;

/** A real auth token, straight from the vector: `<deadline>:<account>:<apiKey>:<160 hex>`. */
const REAL_TOKEN: string = authVector.token;

describe("shape of the vector this file depends on", () => {
  test("the vector token is message + ':' + 160 hex characters", () => {
    expect(REAL_TOKEN).toBe(`${authVector.message}:${authVector.signatureBytesHex}`);
    expect(authVector.signatureBytesHex).toMatch(/^[0-9a-f]{160}$/);
    expect(authVector.message).toMatch(/^\d+:\d+:\d+$/);
  });
});

describe("redactString", () => {
  test("replaces a bare auth token embedded in free text", () => {
    const message = `invalid auth: expired token ${REAL_TOKEN} (retry later)`;
    const out = redactString(message);
    expect(out).not.toContain(authVector.signatureBytesHex);
    expect(out).toBe(`invalid auth: expired token ${REDACTED} (retry later)`);
  });

  test("replaces every occurrence, not just the first", () => {
    const out = redactString(`${REAL_TOKEN} and ${REAL_TOKEN}`);
    expect(out).toBe(`${REDACTED} and ${REDACTED}`);
  });

  test("replaces a 0x-prefixed 40-byte private key", () => {
    const key = `0x${"ab".repeat(40)}`;
    expect(key).toHaveLength(82);
    expect(redactString(`private_key=${key} was rejected`)).toBe(
      `private_key=${REDACTED} was rejected`,
    );
  });

  test("does NOT redact legitimate hex diagnostics", () => {
    // A message hash (40 bytes, no 0x prefix) and a bare signature must survive: blanket hex
    // redaction makes error reports useless.
    const messageHash = "3ac676d8a705f5f893591455c5aca1447a8c77a28dc0fd6641a1d7aafb674058";
    const signature = authVector.signatureBytesHex;
    const text = `hash=${messageHash} sig=${signature}`;
    expect(redactString(text)).toBe(text);
  });

  test("does not partially redact a longer hex run", () => {
    // 0x + 160 hex is a signature, not a private key: the 80-char rule must not match its prefix.
    const longer = `0x${"c".repeat(160)}`;
    expect(redactString(longer)).toBe(longer);
  });

  test("passes ordinary text through unchanged", () => {
    expect(redactString("")).toBe("");
    expect(redactString("invalid param ")).toBe("invalid param ");
  });
});

describe("redactUrl", () => {
  test("removes the auth query value and keeps everything else", () => {
    const out = redactUrl(`https://h/api/v1/x?account_index=1&auth=${REAL_TOKEN}`);
    expect(out).toContain("account_index=1");
    expect(out).not.toContain(authVector.signatureBytesHex);
    expect(out).toBe(`https://h/api/v1/x?account_index=1&auth=${REDACTED}`);
  });

  test("matches secret parameter names case-insensitively", () => {
    const out = redactUrl("https://h/p?Authorization=abc&API_TOKEN=def&market_id=7");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).toContain("market_id=7");
  });

  test("leaves a URL with no secrets byte-identical", () => {
    const url = "https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?market_id=1";
    expect(redactUrl(url)).toBe(url);
  });

  test("falls back to string replacement for a relative URL", () => {
    const out = redactUrl(`/api/v1/transferFeeInfo?account_index=1&auth=${REAL_TOKEN}`);
    expect(out).toBe(`/api/v1/transferFeeInfo?account_index=1&auth=${REDACTED}`);
  });

  test("still catches a token that leaked into the path", () => {
    expect(redactUrl(`/api/v1/x/${REAL_TOKEN}`)).toBe(`/api/v1/x/${REDACTED}`);
  });

  test("does not throw on junk input", () => {
    expect(redactUrl("")).toBe("");
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });
});

describe("redact — key-based", () => {
  test("replaces the mandated keys at any nesting depth", () => {
    const input = {
      level1: {
        level2: [
          {
            api_token: "secret-a",
            auth: "secret-b",
            authorization: "secret-c",
            signature: "secret-d",
            private_key: "secret-e",
            market_id: 7,
          },
        ],
      },
    };
    const out = redact(input);
    const serialised = JSON.stringify(out);
    for (const secret of ["secret-a", "secret-b", "secret-c", "secret-d", "secret-e"]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('"market_id":7');
    expect(out).toEqual({
      level1: {
        level2: [
          {
            api_token: REDACTED,
            auth: REDACTED,
            authorization: REDACTED,
            signature: REDACTED,
            private_key: REDACTED,
            market_id: 7,
          },
        ],
      },
    });
  });

  test("is case-insensitive and covers the camelCase twins", () => {
    const out = redact({
      API_TOKEN: "a",
      ApiToken: "b",
      Authorization: "c",
      privateKey: "d",
      privateKeyHex: "e",
      Sig: "f",
      SECRET: "g",
      token: "h",
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  test("does not redact keys that merely resemble secret names", () => {
    const out = redact({ signature_scheme: "schnorr", token_id: 4, authenticated: true });
    expect(out).toEqual({ signature_scheme: "schnorr", token_id: 4, authenticated: true });
  });
});

describe("redact — value-shaped", () => {
  test("catches a token that arrived under a harmless key", () => {
    const out = redact({ message: `bad token ${REAL_TOKEN}`, note: "fine" });
    expect(JSON.stringify(out)).not.toContain(authVector.signatureBytesHex);
    expect(out).toEqual({ message: `bad token ${REDACTED}`, note: "fine" });
  });
});

describe("redact — structural behaviour", () => {
  test("passes non-string primitives through unchanged, bigint included", () => {
    expect(redact(1)).toBe(1);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(10n ** 30n)).toBe(10n ** 30n);
    expect(redact({ bound: 281474976710654n })).toEqual({ bound: 281474976710654n });
  });

  test("returns a new structure and never mutates the input", () => {
    const nested = { auth: REAL_TOKEN, keep: [1, 2, { token: "x" }] };
    const input = { nested };
    const before = JSON.stringify(input);
    const out = redact(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.nested.auth).toBe(REAL_TOKEN);
    expect(out).not.toBe(input);
    expect((out as { nested: unknown }).nested).not.toBe(nested);
  });

  test("is cycle-safe", () => {
    interface Cyclic {
      name: string;
      self?: Cyclic;
      children?: Cyclic[];
    }
    const a: Cyclic = { name: "a" };
    a.self = a;
    a.children = [a];
    const snapshot = { name: a.name, self: a.self, children: a.children };

    let out: unknown;
    expect(() => {
      out = redact(a);
    }).not.toThrow();
    expect(out).toEqual({ name: "a", self: REDACTED, children: [REDACTED] });

    // Input untouched.
    expect(a.name).toBe(snapshot.name);
    expect(a.self).toBe(snapshot.self);
    expect(a.children).toBe(snapshot.children);
  });

  test("a repeated (non-cyclic) reference is redacted, not collapsed", () => {
    const shared = { auth: "s", keep: 1 };
    const out = redact({ first: shared, second: shared });
    expect(out).toEqual({
      first: { auth: REDACTED, keep: 1 },
      second: { auth: REDACTED, keep: 1 },
    });
  });

  test("converts Headers to a plain object and redacts authorization", () => {
    const headers = new Headers({
      authorization: REAL_TOKEN,
      "x-amz-cf-id": "cf-123",
      "content-type": "application/json",
    });
    const out = redact(headers) as Record<string, unknown>;
    expect(out["authorization"]).toBe(REDACTED);
    expect(out["x-amz-cf-id"]).toBe("cf-123");
    expect(out["content-type"]).toBe("application/json");
    expect(JSON.stringify(out)).not.toContain(authVector.signatureBytesHex);
  });

  test("converts Map and Set to plain structures", () => {
    const map = new Map<string, unknown>([
      ["auth", REAL_TOKEN],
      ["market_id", 7],
    ]);
    expect(redact(map)).toEqual({ auth: REDACTED, market_id: 7 });
    expect(redact(new Set(["a", `t=${REAL_TOKEN}`]))).toEqual(["a", `t=${REDACTED}`]);
  });

  test("redacts a URL value", () => {
    const out = redact({ url: new URL(`https://h/p?auth=${REAL_TOKEN}&x=1`) }) as {
      url: string;
    };
    expect(out.url).toBe(`https://h/p?auth=${REDACTED}&x=1`);
  });

  test("redacts an Error, recurses into cause, and drops the stack", () => {
    const inner = new Error(`token ${REAL_TOKEN}`);
    const outer = new Error("wrapped", { cause: inner });
    const out = redact(outer) as Record<string, unknown>;
    expect(out["name"]).toBe("Error");
    expect(out["message"]).toBe("wrapped");
    expect(out).not.toHaveProperty("stack");
    expect((out["cause"] as Record<string, unknown>)["message"]).toBe(`token ${REDACTED}`);
    expect(JSON.stringify(out)).not.toContain(authVector.signatureBytesHex);
  });

  test("survives a throwing getter without throwing", () => {
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
      keep: 1,
    };
    expect(redact(hostile)).toEqual({ boom: REDACTED, keep: 1 });
  });

  test("does not walk into a typed array", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(redact({ bytes })).toEqual({ bytes });
  });

  test("handles arrays at the top level", () => {
    expect(redact([{ auth: "x" }, "plain"])).toEqual([{ auth: REDACTED }, "plain"]);
  });
});
