/**
 * `src/client/lighter-client.ts` — construction, and what construction is not allowed to do.
 *
 * The load-bearing test in this file is the instrumented one: `new LighterClient({...})` must not
 * call `fetch`, must not schedule a timer, must not draw randomness, and must not return a promise.
 * That is the contract that lets a Cloudflare Worker build a client during its global evaluation
 * phase — where `crypto.getRandomValues` is forbidden outright (`docs/decisions.md` D2) and where
 * anything asynchronous is unavailable — and it is the sort of property that decays silently, one
 * convenient eager fetch at a time. So the globals are replaced with throwing spies rather than
 * inspected afterwards.
 *
 * The second is `chainId`: a custom endpoint with no chain id is a construction-time error. The
 * reference infers the chain from a URL substring, which signs for the wrong chain behind a proxy
 * (`docs/protocol-notes.md` §7).
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";

import { LighterConfigError } from "../../src/errors.js";
import { LighterRestClient } from "../../src/rest/client.js";
import type { WebSocketLike } from "../../src/config/config.js";
import { LighterAccount } from "../../src/client/account.js";
import { LighterClient } from "../../src/client/lighter-client.js";
import { MarketRegistry } from "../../src/client/markets.js";

/* ---------------------------------------------------------------------------------------------- */
/* Instrumented globals                                                                             */
/* ---------------------------------------------------------------------------------------------- */

interface Spies {
  readonly restore: () => void;
  readonly log: string[];
}

/**
 * Replace every global the constructor is forbidden to touch with a recorder.
 *
 * `fetch` is recorded rather than thrown from, so that a violation produces a readable assertion
 * instead of an exception from three frames down.
 */
function instrument(): Spies {
  const log: string[] = [];
  const g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {
    fetch: g["fetch"],
    setTimeout: g["setTimeout"],
    setInterval: g["setInterval"],
  };
  const crypto: Crypto = globalThis.crypto;
  const originalRandom: typeof crypto.getRandomValues = crypto.getRandomValues.bind(crypto);

  g["fetch"] = (input: unknown): Promise<Response> => {
    log.push(`fetch ${String(input)}`);
    return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  };
  g["setTimeout"] = ((fn: () => void, ms?: number): number => {
    log.push(`setTimeout ${String(ms)}`);
    return (original["setTimeout"] as (f: () => void, m?: number) => number)(fn, ms);
  }) as unknown;
  g["setInterval"] = ((fn: () => void, ms?: number): number => {
    log.push(`setInterval ${String(ms)}`);
    return (original["setInterval"] as (f: () => void, m?: number) => number)(fn, ms);
  }) as unknown;
  Object.defineProperty(crypto, "getRandomValues", {
    value: <T extends ArrayBufferView | null>(array: T): T => {
      log.push("getRandomValues");
      return originalRandom(array as never) as T;
    },
    configurable: true,
    writable: true,
  });

  return {
    log,
    restore(): void {
      g["fetch"] = original["fetch"];
      g["setTimeout"] = original["setTimeout"];
      g["setInterval"] = original["setInterval"];
      Object.defineProperty(crypto, "getRandomValues", {
        value: originalRandom,
        configurable: true,
        writable: true,
      });
    },
  };
}

/** Clients built during a test, closed afterwards so no socket or timer survives it. */
const built: LighterClient[] = [];

function track(client: LighterClient): LighterClient {
  built.push(client);
  return client;
}

afterEach(async (): Promise<void> => {
  while (built.length > 0) await built.pop()?.close();
});

/** A `fetch` that answers every route with an empty success envelope, and counts. */
function countingFetch(): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: ((input: unknown): Promise<Response> => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: 200, order_books: [], assets: [], api_keys: [], nonce: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof globalThis.fetch,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Construction                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("the constructor performs no I/O", () => {
  test("no fetch, no timer, no randomness, and no promise", () => {
    const spies: Spies = instrument();
    try {
      const client: LighterClient = track(new LighterClient({ endpoint: "mainnet" }));
      expect(client).toBeInstanceOf(LighterClient);
      expect(client as unknown).not.toBeInstanceOf(Promise);
      expect(spies.log).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  test("building an account is I/O-free too — nextNonce is fetched lazily", () => {
    const spies: Spies = instrument();
    try {
      const client: LighterClient = track(new LighterClient({ endpoint: "testnet" }));
      const account: LighterAccount = client.account({
        accountIndex: 65n,
        keys: { 3: `0x${"11".repeat(40)}` },
      });
      expect(account).toBeInstanceOf(LighterAccount);
      expect(account.accountIndex).toBe(65n);
      expect(spies.log).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  test("touching client.ws builds a client but opens no socket", () => {
    let constructed: number = 0;
    class SpySocket implements WebSocketLike {
      readonly readyState: number = 0;
      constructor(_url: string) {
        constructed += 1;
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
    }
    const client: LighterClient = track(
      new LighterClient({
        endpoint: "mainnet",
        WebSocket: SpySocket as unknown as new (url: string) => WebSocketLike,
      }),
    );
    expect(client.ws.url).toContain("wss://mainnet.zklighter.elliot.ai/stream");
    expect(client.ws).toBe(client.ws);
    expect(constructed).toBe(0);
  });
});

describe("chainId", () => {
  test("comes from the named profile", () => {
    expect(track(new LighterClient()).chainId).toBe(304);
    expect(track(new LighterClient({ endpoint: "testnet" })).chainId).toBe(300);
    expect(track(new LighterClient({ endpoint: "robinhood" })).chainId).toBe(466_324);
  });

  test("a custom endpoint without one is a construction-time error", () => {
    expect(
      () =>
        new LighterClient({
          endpoint: {
            name: "proxy",
            restBase: "https://lighter.internal",
            wsBase: "wss://lighter.internal/stream",
          } as never,
        }),
    ).toThrow(LighterConfigError);
  });

  test("restBase / wsBase beside `endpoint` rather than inside it is refused", () => {
    // The shape a caller reaches for first, and the one that would otherwise resolve to mainnet and
    // sign chain 304 transactions against a private host.
    const stray: unknown = { restBase: "https://lighter.internal", wsBase: "wss://lighter.internal/stream" };
    expect(() => new LighterClient(stray as never)).toThrow(LighterConfigError);
    expect(() => new LighterClient(stray as never)).toThrow(/chain id/);
    expect(() => new LighterClient({ chainId: 300 } as never)).toThrow(LighterConfigError);
  });

  test("an explicit chain id on a custom endpoint is honoured verbatim", () => {
    const client: LighterClient = track(
      new LighterClient({
        endpoint: {
          name: "proxy",
          restBase: "https://lighter.internal",
          wsBase: "wss://lighter.internal/stream",
          chainId: 300,
        },
      }),
    );
    // Not 304, and not sniffed out of the host name.
    expect(client.chainId).toBe(300);
  });
});

describe("markets", () => {
  test("an injected registry is adopted, and gets this client's transport", async () => {
    const registry: MarketRegistry = new MarketRegistry();
    const http = countingFetch();
    const client: LighterClient = track(new LighterClient({ fetch: http.fetch, markets: registry }));
    expect(client.markets).toBe(registry);
    // Adopted *and* wired: a registry with no transport cannot load.
    await client.markets.load();
    expect(http.urls.length).toBeGreaterThan(0);
  });

  test("connect() is the constructor plus one load", async () => {
    const http = countingFetch();
    const client: LighterClient = track(await LighterClient.connect({ fetch: http.fetch }));
    expect(client).toBeInstanceOf(LighterClient);
    expect(http.urls.length).toBeGreaterThan(0);
    expect(http.urls.some((u: string): boolean => u.includes("/api/v1/"))).toBe(true);
  });
});

describe("no module-level mutable state", () => {
  test("two clients on two chains do not corrupt each other", () => {
    const mainnet: LighterClient = track(new LighterClient({ endpoint: "mainnet" }));
    const testnet: LighterClient = track(new LighterClient({ endpoint: "testnet" }));
    expect(mainnet.chainId).toBe(304);
    expect(testnet.chainId).toBe(300);
    expect(mainnet.rest).not.toBe(testnet.rest);
    expect(mainnet.markets).not.toBe(testnet.markets);
  });

  test("two accounts on one client keep separate nonce state", () => {
    const client: LighterClient = track(new LighterClient());
    const a: LighterAccount = client.account({ accountIndex: 1, keys: { 1: `0x${"11".repeat(40)}` } });
    const b: LighterAccount = client.account({ accountIndex: 2, keys: { 1: `0x${"22".repeat(40)}` } });
    expect(a.nonces).not.toBe(b.nonces);
    expect(a.accountIndex).toBe(1n);
    expect(b.accountIndex).toBe(2n);
  });

  test("the rest client is shared, because it holds no state", () => {
    const client: LighterClient = track(new LighterClient());
    expect(client.rest).toBeInstanceOf(LighterRestClient);
    expect(client.rest).toBe(client.rest);
  });
});

describe("account()", () => {
  test("rejects an account index outside the protocol range", () => {
    const client: LighterClient = track(new LighterClient());
    expect(() => client.account({ accountIndex: -2, keys: { 1: `0x${"11".repeat(40)}` } })).toThrow(
      /accountIndex/,
    );
    expect(() =>
      client.account({ accountIndex: 281_474_976_710_655n, keys: { 1: `0x${"11".repeat(40)}` } }),
    ).toThrow(/accountIndex/);
  });

  test("`-1` is a legal account index, and is not mistaken for a sentinel", () => {
    const client: LighterClient = track(new LighterClient());
    expect(client.account({ accountIndex: -1, keys: { 1: `0x${"11".repeat(40)}` } }).accountIndex).toBe(
      -1n,
    );
  });

  test("an unknown nonce strategy is refused by name", () => {
    const client: LighterClient = track(new LighterClient());
    expect(() =>
      client.account({
        accountIndex: 1,
        keys: { 1: `0x${"11".repeat(40)}` },
        nonces: "hopeful" as never,
      }),
    ).toThrow();
  });

  test("a caller-supplied nonce source is adopted by reference", () => {
    const client: LighterClient = track(new LighterClient());
    const account: LighterAccount = client.account({
      accountIndex: 1,
      keys: { 1: `0x${"11".repeat(40)}` },
      nonces: "manual",
    });
    const second: LighterAccount = client.account({
      accountIndex: 1,
      keys: { 1: `0x${"11".repeat(40)}` },
      nonces: account.nonces,
    });
    expect(second.nonces).toBe(account.nonces);
  });

  test("submit: 'ws' is accepted at construction and needs no socket", () => {
    const client: LighterClient = track(new LighterClient());
    const account: LighterAccount = client.account({
      accountIndex: 1,
      keys: { 1: `0x${"11".repeat(40)}` },
      submit: "ws",
    });
    expect(account.channel).toBe("ws");
  });
});

describe("disposal", () => {
  test("close() is idempotent and leaves nothing scheduled", async () => {
    const spies: Spies = instrument();
    let client: LighterClient;
    try {
      client = track(new LighterClient());
    } finally {
      spies.restore();
    }
    await client.close();
    await client.close();
    expect(spies.log.filter((l: string): boolean => l.startsWith("setInterval"))).toEqual([]);
  });

  test("`await using` works where the runtime has Symbol.asyncDispose", async () => {
    const dispose: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
    if (dispose === undefined) return;
    const client: LighterClient = new LighterClient();
    const method: unknown = (client as unknown as Record<symbol, unknown>)[dispose];
    expect(typeof method).toBe("function");
    await (method as () => Promise<void>).call(client);
  });

  test("closing a client that never built a socket does not build one", async () => {
    let constructed: number = 0;
    class SpySocket implements WebSocketLike {
      readonly readyState: number = 1;
      constructor(_url: string) {
        constructed += 1;
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
    }
    const client: LighterClient = new LighterClient({
      WebSocket: SpySocket as unknown as new (url: string) => WebSocketLike,
    });
    await client.close();
    expect(constructed).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Purity gate                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("the unit's four files stay portable", () => {
  const files: readonly string[] = [
    "lighter-client.ts",
    "account.ts",
    "submit.ts",
    "receipt.ts",
  ];

  for (const name of files) {
    test(`${name} imports no Node built-in and schedules no interval`, () => {
      const source: string = readFileSync(
        new URL(`../../src/client/${name}`, import.meta.url),
        "utf8",
      );
      // The same expression the issue's verification step greps for.
      const forbidden: RegExp = /from ['"]node:|require\(|\bBuffer\b|\bprocess\.|setInterval/;
      expect(forbidden.test(source)).toBe(false);
    });
  }

  test("wait() is built on setTimeout alone", () => {
    const source: string = readFileSync(
      new URL("../../src/client/receipt.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("setTimeout(");
    expect(source).toContain("clearTimeout(");
    expect(source).not.toContain("setInterval");
  });
});
