import { afterEach, describe, expect, test } from "bun:test";

import { LighterConfigError } from "../../src/errors.js";
import type { AuthProvider, Diagnostic, ResolvedConfig, WebSocketConstructor, WebSocketLike } from "../../src/config/config.js";
import { DEFAULT_TX_EXPIRY_MS, DEFAULT_USER_AGENT, isBrowserLike, resolveConfig } from "../../src/config/config.js";
import { defineProfile, profiles } from "../../src/config/endpoints.js";

/** Minimal ambient for the subprocess check. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: {
  spawnSync(cmd: string[], opts?: { stdout?: "pipe"; stderr?: "pipe" }): {
    exitCode: number;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

type Mutable = Record<string, unknown>;
const g: Mutable = globalThis as unknown as Mutable;

/** Remove a global for the duration of `body`, restoring it afterwards. */
function withoutGlobal<T>(key: string, body: () => T): T {
  const had: boolean = key in g;
  const saved: unknown = g[key];
  delete g[key];
  try {
    return body();
  } finally {
    if (had) g[key] = saved;
  }
}

/** Install globals for the duration of `body`. */
function withGlobals<T>(entries: Record<string, unknown>, body: () => T): T {
  const saved = new Map<string, { had: boolean; value: unknown }>();
  for (const key of Object.keys(entries)) {
    saved.set(key, { had: key in g, value: g[key] });
    g[key] = entries[key];
  }
  try {
    return body();
  } finally {
    for (const [key, prior] of saved) {
      if (prior.had) g[key] = prior.value;
      else delete g[key];
    }
  }
}

afterEach(() => {
  // Guard against a leaked stub silently changing the meaning of a later assertion.
  expect(typeof g["fetch"]).toBe("function");
  expect(g["window"]).toBeUndefined();
  expect(g["document"]).toBeUndefined();
});

// `typeof globalThis.fetch` picks up whatever the ambient lib says — under `bun-types` that
// includes a `preconnect` property a plain function does not have. Cast rather than model it.
const fakeFetch: typeof globalThis.fetch = ((): Promise<Response> =>
  Promise.resolve(new Response("{}"))) as unknown as typeof globalThis.fetch;

describe("resolveConfig defaults", () => {
  test("with no argument: mainnet, chain 304, and every documented default", () => {
    const c: ResolvedConfig = resolveConfig();
    expect(c.profile).toBe(profiles.mainnet);
    expect(c.chainId).toBe(304);
    expect(c.defaultTxExpiryMs).toBe(599_000);
    expect(DEFAULT_TX_EXPIRY_MS).toBe(599_000);
    expect(c.timeouts).toEqual({ readMs: 10_000, writeMs: 30_000 });
    expect(c.retry).toEqual({ attempts: 2, baseMs: 200, capMs: 5_000 });
    expect(c.auth).toBeNull();
    expect(typeof c.fetch).toBe("function");
    expect(typeof c.now).toBe("function");
    expect(typeof c.onDiagnostic).toBe("function");
  });

  test("an empty object resolves identically to no argument", () => {
    expect(resolveConfig({}).timeouts).toEqual(resolveConfig().timeouts);
    expect(resolveConfig({}).profile).toBe(resolveConfig().profile);
  });

  test("chainId always mirrors the profile — it is never a separate input", () => {
    expect(resolveConfig({ endpoint: "testnet" }).chainId).toBe(300);
    expect(resolveConfig({ endpoint: "robinhood" }).chainId).toBe(466_324);
    const custom = resolveConfig({
      endpoint: { name: "c", restBase: "https://h", wsBase: "wss://h/stream", chainId: 42 },
    });
    expect(custom.chainId).toBe(42);
    expect(custom.chainId).toBe(custom.profile.chainId);
  });

  test("the result and its nested policy objects are frozen", () => {
    const c: ResolvedConfig = resolveConfig();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.timeouts)).toBe(true);
    expect(Object.isFrozen(c.retry)).toBe(true);
    expect(() => {
      (c as unknown as Mutable)["chainId"] = 300;
    }).toThrow(TypeError);
  });

  test("the default onDiagnostic swallows a diagnostic without throwing", () => {
    const d: Diagnostic = { level: "warn", event: "ws.reconnect", detail: { attempt: 1 } };
    expect(() => resolveConfig().onDiagnostic(d)).not.toThrow();
  });

  test("a supplied onDiagnostic receives what it is given", () => {
    const seen: Diagnostic[] = [];
    const c: ResolvedConfig = resolveConfig({ onDiagnostic: (d: Diagnostic): void => void seen.push(d) });
    c.onDiagnostic({ level: "debug", event: "http.request" });
    expect(seen).toEqual([{ level: "debug", event: "http.request" }]);
  });
});

describe("endpoint resolution", () => {
  test("a name is looked up; an object goes through defineProfile", () => {
    expect(resolveConfig({ endpoint: "testnet" }).profile).toBe(profiles.testnet);
    const c: ResolvedConfig = resolveConfig({
      endpoint: { name: "local", restBase: "http://127.0.0.1:8080/", wsBase: "ws://127.0.0.1:8080/stream/", chainId: 300 },
    });
    expect(c.profile.restBase).toBe("http://127.0.0.1:8080");
    expect(c.profile.wsBase).toBe("ws://127.0.0.1:8080/stream");
    expect(Object.isFrozen(c.profile)).toBe(true);
  });

  test("an already-defined profile object is accepted", () => {
    const p = defineProfile({ name: "c", restBase: "https://h/", wsBase: "wss://h/stream", chainId: 9 });
    expect(resolveConfig({ endpoint: p }).profile).toEqual(p);
  });

  test("an unknown name throws LighterConfigError naming the four valid profiles", () => {
    let message = "";
    try {
      resolveConfig({ endpoint: "nope" as "mainnet" });
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LighterConfigError);
      message = (e as Error).message;
    }
    for (const name of ["mainnet", "testnet", "robinhood", "robinhood_testnet"]) {
      expect(message).toContain(name);
    }
  });

  test("a custom endpoint with no chain id throws instead of defaulting to 304", () => {
    expect(() =>
      resolveConfig({ endpoint: { name: "c", restBase: "https://h", wsBase: "wss://h/stream" } as never }),
    ).toThrow(LighterConfigError);
  });
});

describe("fetch injection", () => {
  test("an injected fetch is used verbatim", () => {
    expect(resolveConfig({ fetch: fakeFetch }).fetch).toBe(fakeFetch);
  });

  test("the global is bound to globalThis, not captured bare", async () => {
    const calls: unknown[] = [];
    const receivers: unknown[] = [];
    // A plain function, so `this` is observable: an unbound global fetch is called with `undefined`
    // as its receiver and is `TypeError: Illegal invocation` in a browser.
    const spy = function spyFetch(this: unknown, input: unknown): Promise<Response> {
      receivers.push(this);
      calls.push(input);
      return Promise.resolve(new Response("ok"));
    } as unknown as typeof globalThis.fetch;
    const resolved: ResolvedConfig = withGlobals({ fetch: spy }, () => resolveConfig());
    await resolved.fetch("https://example.invalid/");
    expect(calls).toEqual(["https://example.invalid/"]);
    expect(receivers).toEqual([globalThis]);
  });

  test("with no global fetch and none injected, it throws LighterConfigError", () => {
    withoutGlobal("fetch", () => {
      expect(() => resolveConfig()).toThrow(LighterConfigError);
      try {
        resolveConfig();
        expect.unreachable();
      } catch (e: unknown) {
        expect((e as Error).message).toContain("fetch");
      }
      // …but an injected one still works with no global present.
      expect(resolveConfig({ fetch: fakeFetch }).fetch).toBe(fakeFetch);
    });
  });

  test("a non-function fetch is rejected", () => {
    expect(() => resolveConfig({ fetch: 1 as unknown as typeof globalThis.fetch })).toThrow(LighterConfigError);
  });
});

describe("WebSocket injection", () => {
  class FakeSocket implements WebSocketLike {
    readonly readyState: number = 0;
    send(): void {}
    close(): void {}
    addEventListener(): void {}
  }

  test("an injected constructor is used verbatim", () => {
    const Ctor: WebSocketConstructor = FakeSocket as unknown as WebSocketConstructor;
    expect(resolveConfig({ WebSocket: Ctor }).WebSocket).toBe(Ctor);
  });

  test("the global is picked up when present", () => {
    expect(resolveConfig().WebSocket).toBe(g["WebSocket"] as WebSocketConstructor);
  });

  test("with no global WebSocket it resolves to null and does NOT throw", () => {
    // Node 20 has no global WebSocket, and a REST-only consumer must still be able to build a
    // config there. The WS client is what throws, later, when it actually needs one.
    withoutGlobal("WebSocket", () => {
      const c: ResolvedConfig = resolveConfig({});
      expect(c.WebSocket).toBeNull();
      expect(c.fetch).toBeDefined();
      expect(resolveConfig({ WebSocket: FakeSocket as unknown as WebSocketConstructor }).WebSocket).toBe(
        FakeSocket as unknown as WebSocketConstructor,
      );
    });
  });
});

describe("clock injection", () => {
  test("an injected clock is used", () => {
    expect(resolveConfig({ now: () => 42 }).now()).toBe(42);
  });

  test("the default tracks Date.now", () => {
    const before: number = Date.now();
    const value: number = resolveConfig().now();
    const after: number = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

describe("timeouts", () => {
  test("a scalar sets both directions", () => {
    expect(resolveConfig({ timeoutMs: 5_000 }).timeouts).toEqual({ readMs: 5_000, writeMs: 5_000 });
  });

  test("an object sets each independently, defaulting the other", () => {
    expect(resolveConfig({ timeoutMs: { readMs: 1_000 } }).timeouts).toEqual({ readMs: 1_000, writeMs: 30_000 });
    expect(resolveConfig({ timeoutMs: { writeMs: 60_000 } }).timeouts).toEqual({ readMs: 10_000, writeMs: 60_000 });
    expect(resolveConfig({ timeoutMs: { readMs: 1, writeMs: 2 } }).timeouts).toEqual({ readMs: 1, writeMs: 2 });
  });

  test("zero, negative and fractional timeouts are rejected", () => {
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ timeoutMs: -1 })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ timeoutMs: 1.5 })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ timeoutMs: { readMs: 0 } })).toThrow(LighterConfigError);
  });
});

describe("retry", () => {
  test("partial overrides keep the other defaults", () => {
    expect(resolveConfig({ retry: { attempts: 5 } }).retry).toEqual({ attempts: 5, baseMs: 200, capMs: 5_000 });
    expect(resolveConfig({ retry: { baseMs: 50, capMs: 1_000 } }).retry).toEqual({
      attempts: 2,
      baseMs: 50,
      capMs: 1_000,
    });
  });

  test("zero attempts is legal — retries off", () => {
    expect(resolveConfig({ retry: { attempts: 0 } }).retry.attempts).toBe(0);
  });

  test("negative values are rejected", () => {
    expect(() => resolveConfig({ retry: { attempts: -1 } })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ retry: { baseMs: -1 } })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ retry: { capMs: -1 } })).toThrow(LighterConfigError);
  });
});

describe("defaultTxExpiryMs", () => {
  test("defaults to 600_000 minus the one-second haircut", () => {
    expect(resolveConfig().defaultTxExpiryMs).toBe(599_000);
    expect(600_000 - 599_000).toBe(1_000);
  });

  test("is overridable and validated", () => {
    expect(resolveConfig({ defaultTxExpiryMs: 60_000 }).defaultTxExpiryMs).toBe(60_000);
    expect(() => resolveConfig({ defaultTxExpiryMs: 0 })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ defaultTxExpiryMs: -1 })).toThrow(LighterConfigError);
  });
});

describe("auth", () => {
  test("a string becomes a provider returning that constant", async () => {
    const auth: AuthProvider | null = resolveConfig({ auth: "token" }).auth;
    expect(auth).not.toBeNull();
    expect(await (auth as AuthProvider)({})).toBe("token");
    expect(await (auth as AuthProvider)({ accountIndex: 7, channel: "account_all/7" })).toBe("token");
  });

  test("a provider is passed through, context and all", async () => {
    const seen: unknown[] = [];
    const provider: AuthProvider = (ctx): string => {
      seen.push(ctx);
      return "from-provider";
    };
    const resolved: AuthProvider | null = resolveConfig({ auth: provider }).auth;
    expect(resolved).toBe(provider);
    expect(await (resolved as AuthProvider)({ accountIndex: 1 })).toBe("from-provider");
    expect(seen).toEqual([{ accountIndex: 1 }]);
  });

  test("an async provider is allowed", async () => {
    const resolved = resolveConfig({ auth: (): Promise<string> => Promise.resolve("later") }).auth;
    expect(await (resolved as AuthProvider)({})).toBe("later");
  });

  test("absent auth is null, and an empty token is rejected", () => {
    expect(resolveConfig().auth).toBeNull();
    expect(() => resolveConfig({ auth: "" })).toThrow(LighterConfigError);
    expect(() => resolveConfig({ auth: 7 as unknown as string })).toThrow(LighterConfigError);
  });
});

describe("isBrowserLike and User-Agent", () => {
  test("false under Bun, which has neither document nor window", () => {
    expect(isBrowserLike()).toBe(false);
  });

  test("true only when BOTH document and window are present", () => {
    withGlobals({ document: {} }, () => expect(isBrowserLike()).toBe(false));
    withGlobals({ window: {} }, () => expect(isBrowserLike()).toBe(false));
    withGlobals({ document: {}, window: {} }, () => expect(isBrowserLike()).toBe(true));
  });

  test("outside a browser the default UA is browser-like and overridable", () => {
    expect(resolveConfig().userAgent).toBe(DEFAULT_USER_AGENT);
    // Browser-like on purpose: CloudFront answers some paths with a 403 HTML interstitial when the
    // UA is absent or obviously programmatic (docs/decisions.md D5).
    expect(DEFAULT_USER_AGENT.startsWith("Mozilla/5.0")).toBe(true);
    expect(resolveConfig({ userAgent: "my-bot/1.0" }).userAgent).toBe("my-bot/1.0");
    expect(() => resolveConfig({ userAgent: "" })).toThrow(LighterConfigError);
  });

  test("in a browser-like environment the UA is null, even if one was supplied", () => {
    // `User-Agent` is a forbidden header name in the fetch spec, and custom headers can promote a
    // simple request into a failing CORS preflight. `null` tells the transport not to try.
    withGlobals({ document: {}, window: {} }, () => {
      expect(resolveConfig().userAgent).toBeNull();
      expect(resolveConfig({ userAgent: "my-bot/1.0" }).userAgent).toBeNull();
    });
  });
});

describe("the module entry point", () => {
  test("re-exports the whole public surface", async () => {
    const barrel = await import("../../src/config/index.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "DEFAULT_TX_EXPIRY_MS",
      "DEFAULT_USER_AGENT",
      "defineProfile",
      "getProfile",
      "isBrowserLike",
      "profiles",
      "resolveConfig",
    ]);
    expect(barrel.profiles).toBe(profiles);
    expect(barrel.resolveConfig).toBe(resolveConfig);
    expect(barrel.defineProfile).toBe(defineProfile);
    expect(barrel.isBrowserLike).toBe(isBrowserLike);
  });
});

describe("import purity", () => {
  test("importing lighter-ts/config touches no global, clock, timer or network", () => {
    // Run in a fresh process rather than in-band: this test file has already imported the module,
    // so an in-process dynamic import would hit the module cache and assert nothing.
    const entry: string = new URL("../../src/config/index.ts", import.meta.url).pathname;
    const probe: string = [
      'const touched = [];',
      'for (const k of ["fetch","WebSocket","document","window","navigator","crypto","XMLHttpRequest"]) {',
      '  try { Object.defineProperty(globalThis, k, { configurable: true, get() { touched.push(k); throw new Error("read global " + k); } }); }',
      '  catch { touched.push("unstubbable:" + k); }',
      '}',
      'Date.now = () => { touched.push("Date.now"); throw new Error("clock"); };',
      'const realDate = Date; globalThis.Date = new Proxy(Date, { construct(t, a) { touched.push("new Date"); return Reflect.construct(t, a); } });',
      'for (const k of ["setTimeout","setInterval","queueMicrotask"]) {',
      '  const original = globalThis[k];',
      '  globalThis[k] = (...args) => { touched.push(k); return original(...args); };',
      '}',
      `const m = await import(${JSON.stringify(entry)});`,
      'globalThis.Date = realDate;',
      'if (typeof m.resolveConfig !== "function") { console.log("MISSING_EXPORT"); }',
      'else console.log(touched.length === 0 ? "CLEAN" : "TOUCHED:" + touched.join(","));',
    ].join("\n");

    const proc = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
    const stdout: string = proc.stdout.toString().trim();
    const stderr: string = proc.stderr.toString().trim();
    expect(`${stdout}${stderr === "" ? "" : ` | stderr: ${stderr}`}`).toBe("CLEAN");
    expect(proc.exitCode).toBe(0);
  });
});
