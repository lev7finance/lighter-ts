/**
 * Cursor pagination, driven entirely by an injected `fetch`.
 *
 * Every case here is one of the four ways the reference behaviour is easy to get wrong: the two
 * response spellings of the cursor (`next_cursor` and plain `cursor`), the fact that exhaustion is
 * the key being *absent* rather than empty, the request spelling being invariantly `cursor`, and
 * the two bounds that stop a misbehaving server from spinning the loop forever.
 *
 * The routes are real entries from `src/rest/routes.ts` rather than fabricated `RouteDef`s, so the
 * `itemsKey` and cursor-family assertions are assertions about the shipping table.
 */

import { describe, expect, test } from "bun:test";

import { LighterError, LighterValidationError } from "../../src/errors.js";
import type { DetailedAccounts } from "../../src/models/account.js";
import type { Trade } from "../../src/models/order.js";
import { LighterRestClient } from "../../src/rest/client.js";
import {
  DEFAULT_MAX_PAGES,
  nextCursor,
  paginate,
  paginateItems,
} from "../../src/rest/paginate.js";
import type { ItemOf } from "../../src/rest/route-types.js";
import { routes } from "../../src/rest/routes.js";

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface Recorded {
  readonly url: URL;
}

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Recorded[];
  /** The `cursor` query parameter of each request, in order. `null` when the key was absent. */
  cursors(): (string | null)[];
}

/** Answers each successive request with the next body in `bodies`; then repeats the last one. */
function pages(bodies: readonly unknown[]): Stub {
  const calls: Recorded[] = [];
  const impl = (input: string | URL): Promise<Response> => {
    const url: URL = new URL(String(input));
    calls.push({ url });
    const body: unknown = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    fetch: impl as unknown as typeof globalThis.fetch,
    calls,
    cursors: (): (string | null)[] => calls.map((c: Recorded) => c.url.searchParams.get("cursor")),
  };
}

function clientOf(stub: Stub): LighterRestClient {
  return new LighterRestClient({ endpoint: "mainnet", fetch: stub.fetch, auth: "token" });
}

/** A server that never runs out of pages, each with a cursor it has never used before. */
function endlessPages(itemsKey: string): { client: LighterRestClient; served: () => number } {
  let served: number = 0;
  const impl = (): Promise<Response> => {
    served += 1;
    const body: Record<string, unknown> = {
      code: 200,
      next_cursor: `page-${String(served)}`,
    };
    body[itemsKey] = [{ n: served }];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    client: new LighterRestClient({
      auth: "token",
      fetch: impl as unknown as typeof globalThis.fetch,
    }),
    served: (): number => served,
  };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* The normaliser                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("nextCursor", () => {
  test("reads the `next_cursor` family", () => {
    expect(nextCursor({ code: 200, next_cursor: "abc" })).toBe("abc");
  });

  test("reads the legacy `cursor` family", () => {
    expect(nextCursor({ code: 200, cursor: "abc" })).toBe("abc");
  });

  test("prefers `next_cursor` if a response ever carried both", () => {
    expect(nextCursor({ next_cursor: "new", cursor: "old" })).toBe("new");
  });

  test("an absent key is exhaustion — not `\"\"`, not `null`", () => {
    expect(nextCursor({ code: 200 })).toBeUndefined();
    expect(nextCursor({ code: 200, next_cursor: undefined })).toBeUndefined();
    expect(nextCursor({ code: 200, next_cursor: null })).toBeUndefined();
  });

  test("an empty string is treated as exhaustion, since `?cursor=` cannot advance", () => {
    expect(nextCursor({ next_cursor: "" })).toBeUndefined();
    expect(nextCursor({ cursor: "" })).toBeUndefined();
  });

  test("a non-object is exhaustion rather than a crash", () => {
    expect(nextCursor(null)).toBeUndefined();
    expect(nextCursor(undefined)).toBeUndefined();
    expect(nextCursor("nope")).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Page iteration                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("paginate", () => {
  test("follows `next_cursor` across two pages and stops when the key is absent", async () => {
    const stub = pages([
      { code: 200, accounts: [{ account_index: 1 }], next_cursor: "p2" },
      { code: 200, accounts: [{ account_index: 2 }] },
    ]);
    const collected: DetailedAccounts[] = await collect(
      paginate(clientOf(stub), routes.account, { by: "index", value: "1" }),
    );

    expect(collected.length).toBe(2);
    expect(stub.calls.length).toBe(2);
    expect(stub.cursors()).toEqual([null, "p2"]);
  });

  test("follows the legacy `cursor` spelling across two pages", async () => {
    const stub = pages([
      { code: 200, transfers: [{ id: 1 }], cursor: "p2" },
      { code: 200, transfers: [{ id: 2 }] },
    ]);
    const collected = await collect(
      paginate(clientOf(stub), routes.transferHistory, { account_index: 1, type: ["all"] }),
    );

    expect(collected.length).toBe(2);
    expect(stub.cursors()).toEqual([null, "p2"]);
  });

  test("the outgoing parameter is always `cursor`, whichever key the response used", async () => {
    const stub = pages([
      { code: 200, accounts: [], next_cursor: "opaque-token" },
      { code: 200, accounts: [] },
    ]);
    await collect(paginate(clientOf(stub), routes.account, { by: "index", value: "1" }));

    const second: URL = (stub.calls[1] as Recorded).url;
    expect(second.searchParams.get("cursor")).toBe("opaque-token");
    expect(second.searchParams.get("next_cursor")).toBeNull();
  });

  test("a single page with no cursor key at all terminates after one request", async () => {
    const stub = pages([{ code: 200, accounts: [{ account_index: 1 }] }]);
    const collected = await collect(
      paginate(clientOf(stub), routes.account, { by: "index", value: "1" }),
    );
    expect(collected.length).toBe(1);
    expect(stub.calls.length).toBe(1);
  });

  test("a repeated cursor throws rather than spinning", async () => {
    const stub = pages([{ code: 200, accounts: [], next_cursor: "stuck" }]);
    const walk = paginate(clientOf(stub), routes.account, { by: "index", value: "1" });

    let thrown: unknown;
    try {
      await collect(walk);
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LighterError);
    expect((thrown as LighterError).code).toBe("CURSOR_REPEATED");
    // Page one is fetched and yielded; page two repeats the cursor and is refused.
    expect(stub.calls.length).toBe(2);
  });

  test("a cursor equal to the one the caller resumed from is also refused", async () => {
    const stub = pages([{ code: 200, accounts: [], next_cursor: "resume" }]);
    await expect(
      collect(paginate(clientOf(stub), routes.account, { by: "index", value: "1", cursor: "resume" })),
    ).rejects.toThrow(/already returned/);
    expect(stub.calls.length).toBe(1);
  });

  test("an alternating pair of cursors is refused too", async () => {
    const stub = pages([
      { code: 200, accounts: [], next_cursor: "a" },
      { code: 200, accounts: [], next_cursor: "b" },
      { code: 200, accounts: [], next_cursor: "a" },
    ]);
    await expect(
      collect(paginate(clientOf(stub), routes.account, { by: "index", value: "1" })),
    ).rejects.toThrow(/already returned/);
    expect(stub.calls.length).toBe(3);
  });

  test("maxPages bounds a walk the server would happily continue forever", async () => {
    // Every page hands back a *fresh* cursor, so the repeated-cursor guard never fires and
    // `maxPages` is the only thing that stops the loop.
    const endless = endlessPages("accounts");
    const collected = await collect(
      paginate(endless.client, routes.account, { by: "index", value: "1" }, { maxPages: 3 }),
    );
    expect(collected.length).toBe(3);
    expect(endless.served()).toBe(3);
  });

  test("the default bound is 1000 and is documented as such", () => {
    expect(DEFAULT_MAX_PAGES).toBe(1000);
  });

  test("an invalid maxPages fails at the call site, not on the first next()", () => {
    const stub = pages([{ code: 200 }]);
    const client = clientOf(stub);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        paginate(client, routes.account, { by: "index", value: "1" }, { maxPages: bad }),
      ).toThrow(LighterValidationError);
    }
    expect(stub.calls.length).toBe(0);
  });

  test("breaking out of the loop issues no further request", async () => {
    const stub = pages([{ code: 200, accounts: [], next_cursor: "p2" }]);
    for await (const page of paginate(clientOf(stub), routes.account, { by: "index", value: "1" })) {
      expect(page.code).toBe(200);
      break;
    }
    expect(stub.calls.length).toBe(1);
  });

  test("every other parameter — including `limit` — is carried through untouched", async () => {
    const stub = pages([
      { code: 200, trades: [], next_cursor: "p2" },
      { code: 200, trades: [] },
    ]);
    await collect(
      paginate(clientOf(stub), routes.trades, {
        sort_by: "trade_id",
        limit: 100,
        market_id: 1,
      }),
    );
    for (const call of stub.calls) {
      expect(call.url.searchParams.get("limit")).toBe("100");
      expect(call.url.searchParams.get("sort_by")).toBe("trade_id");
      expect(call.url.searchParams.get("market_id")).toBe("1");
    }
    expect(stub.cursors()).toEqual([null, "p2"]);
  });

  test("the caller's params object is not mutated", async () => {
    const stub = pages([
      { code: 200, accounts: [], next_cursor: "p2" },
      { code: 200, accounts: [] },
    ]);
    const params = { by: "index", value: "1" } as const;
    await collect(paginate(clientOf(stub), routes.account, params));
    expect(Object.keys(params)).toEqual(["by", "value"]);
  });

  test("per-call options reach the transport", async () => {
    const unused = pages([{ code: 200, accounts: [] }]);
    const used = pages([{ code: 200, accounts: [] }]);
    const client = new LighterRestClient({ fetch: unused.fetch });
    await collect(
      paginate(client, routes.account, { by: "index", value: "1" }, { fetch: used.fetch, maxPages: 5 }),
    );
    expect(unused.calls.length).toBe(0);
    expect(used.calls.length).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Item iteration                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe("paginateItems", () => {
  test("flattens by the route's itemsKey across pages", async () => {
    const stub = pages([
      { code: 200, trades: [{ trade_id_str: "1" }, { trade_id_str: "2" }], next_cursor: "p2" },
      { code: 200, trades: [{ trade_id_str: "3" }] },
    ]);
    const items: Trade[] = await collect(
      paginateItems(clientOf(stub), routes.trades, { sort_by: "trade_id", limit: 100 }),
    );
    expect(items.map((t: Trade) => t.trade_id_str)).toEqual(["1", "2", "3"]);
  });

  test("ItemOf names the element type, so the yielded values are typed", async () => {
    // The annotation is the assertion; a wrong `itemsKey` on the route fails the typecheck gate.
    const asTrade: ItemOf<typeof routes.trades> = { trade_id_str: "1" } satisfies Trade;
    expect(asTrade.trade_id_str).toBe("1");
  });

  test("a page whose collection is absent contributes nothing and is not an error", async () => {
    const stub = pages([
      { code: 200, next_cursor: "p2" },
      { code: 200, trades: [{ trade_id_str: "1" }] },
    ]);
    const items: Trade[] = await collect(
      paginateItems(clientOf(stub), routes.trades, { sort_by: "trade_id", limit: 100 }),
    );
    expect(items.length).toBe(1);
  });

  test("a route with no itemsKey is rejected at the call site", () => {
    const stub = pages([{ code: 200 }]);
    expect(() => paginateItems(clientOf(stub), routes.orderBookOrders, { market_id: 1, limit: 10 }))
      .toThrow(LighterValidationError);
    expect(stub.calls.length).toBe(0);
  });

  test("a collection field that is not an array is rejected", async () => {
    const stub = pages([{ code: 200, trades: "oops" }]);
    await expect(
      collect(paginateItems(clientOf(stub), routes.trades, { sort_by: "trade_id", limit: 100 })),
    ).rejects.toThrow(LighterValidationError);
  });

  test("maxPages applies to the flattening variant too", async () => {
    const endless = endlessPages("trades");
    const items: Trade[] = await collect(
      paginateItems(endless.client, routes.trades, { sort_by: "trade_id", limit: 100 }, { maxPages: 2 }),
    );
    expect(items.length).toBe(2);
    expect(endless.served()).toBe(2);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hygiene                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("hygiene", () => {
  test("no Node built-in and no runtime dependency", async () => {
    const source: string = await Bun.file(
      new URL("../../src/rest/paginate.ts", import.meta.url).pathname,
    ).text();
    for (const forbidden of ["node:", "Buffer", "process.", "require("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
