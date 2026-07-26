/**
 * The grouped facade.
 *
 * The interesting property is not that any one method works — the transport is tested separately
 * and every method is the same three-line closure — but that the *derivation* from `routes` is
 * total and lossless. So the structural assertions here are computed from `routes` itself, never
 * from a hardcoded list: a route added to the table and forgotten in a group would otherwise pass
 * a list-based test forever.
 *
 * Type-level expectations are written as ordinary annotated assignments and `@ts-expect-error`
 * comments rather than as a homegrown assertion library. They fail the typecheck gate, which is the
 * gate that matters, and they are readable by someone who has never seen the helper.
 */

import { describe, expect, test } from "bun:test";

import type { LighterConfig } from "../../src/config/config.js";
import { LighterConfigError } from "../../src/errors.js";
import type { OrderBooks } from "../../src/models/market.js";
import type { Orders } from "../../src/models/order.js";
import type { GroupFacade, RouteKey } from "../../src/rest/client.js";
import { LighterRestClient } from "../../src/rest/client.js";
import type { RestGroup, RouteDef } from "../../src/rest/route-types.js";
import { routes } from "../../src/rest/routes.js";

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
}

/** A `fetch` that never touches the network and records exactly what it was asked to send. */
function stub(responder: (call: RecordedCall, index: number) => Response): Stub {
  const calls: RecordedCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw: HeadersInit | undefined = init?.headers;
    if (raw !== undefined) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(responder(call, calls.length - 1));
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every group name that actually appears in the table, derived rather than listed. */
const GROUPS: readonly RestGroup[] = [
  ...new Set(Object.values(routes as Record<string, RouteDef>).map((r: RouteDef) => r.group)),
];

/* ---------------------------------------------------------------------------------------------- */
/* Derivation                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("the facade is derived from the route table", () => {
  test("all 13 groups are present as own properties", () => {
    const client = new LighterRestClient();
    const facades: Record<string, unknown> = client as unknown as Record<string, unknown>;
    expect(GROUPS.length).toBe(13);
    for (const group of GROUPS) {
      expect(typeof facades[group]).toBe("object");
      expect(facades[group]).not.toBeNull();
    }
  });

  test("the union of every group's method names equals the route key set exactly", () => {
    const client = new LighterRestClient();
    const facades: Record<string, Record<string, unknown>> = client as unknown as Record<
      string,
      Record<string, unknown>
    >;

    const seen: string[] = [];
    for (const group of GROUPS) {
      for (const key of Object.keys(facades[group] ?? {})) seen.push(key);
    }

    // No route lands in two groups: the multiset and the set have the same size.
    expect(seen.length).toBe(seen.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(Object.keys(routes).sort());
    expect(seen.length).toBe(78);
  });

  test("every method lands in the group its route declares, and is a function", () => {
    const client = new LighterRestClient();
    const facades: Record<string, Record<string, unknown>> = client as unknown as Record<
      string,
      Record<string, unknown>
    >;
    for (const [key, route] of Object.entries(routes as Record<string, RouteDef>)) {
      const bucket: Record<string, unknown> | undefined = facades[route.group];
      expect(typeof bucket?.[key]).toBe("function");
    }
  });

  test("`export` is a route key and is reachable as a property", () => {
    const client = new LighterRestClient();
    // A legal property access, even though `export` cannot be a declared function name. Reaching
    // it through the facade is the whole point.
    expect(typeof client.order.export).toBe("function");
  });

  test("buckets are frozen and have a null prototype", () => {
    const client = new LighterRestClient();
    expect(Object.isFrozen(client.order)).toBe(true);
    // Null-prototype, so a route named `constructor` or `toString` would be an ordinary own
    // property rather than a prototype write.
    expect(Object.getPrototypeOf(client.order)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Construction                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe("construction", () => {
  test("takes no configuration and performs no I/O", () => {
    const spy = stub(() => json({ code: 200 }));
    const client = new LighterRestClient({ fetch: spy.fetch });
    expect(spy.calls.length).toBe(0);
    expect(client.config.fetch).toBe(spy.fetch);
  });

  test("the config is copied and frozen, so later mutation is not observed", () => {
    const mutable: LighterConfig = { endpoint: "mainnet" };
    const client = new LighterRestClient(mutable);
    (mutable as { endpoint: string }).endpoint = "testnet";
    expect(client.config.endpoint).toBe("mainnet");
    expect(Object.isFrozen(client.config)).toBe(true);
  });

  test("auth is not resolved at construction time", () => {
    let invocations: number = 0;
    const client = new LighterRestClient({
      auth: (): string => {
        invocations += 1;
        return "token";
      },
    });
    expect(invocations).toBe(0);
    expect(client.account).toBeDefined();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Dispatch                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("dispatch", () => {
  test("a call reaches the transport with the route's method, path and snake_case query", async () => {
    const spy = stub(() => json({ code: 200, order_books: [] }));
    const client = new LighterRestClient({ endpoint: "mainnet", fetch: spy.fetch });

    const result: OrderBooks = await client.order.orderBooks({ filter: "perp", market_id: 1 });

    expect(result.code).toBe(200);
    expect(spy.calls.length).toBe(1);
    const call: RecordedCall = spy.calls[0] as RecordedCall;
    expect(call.method).toBe("GET");
    expect(new URL(call.url).pathname).toBe("/api/v1/orderBooks");
    expect(new URL(call.url).searchParams.get("filter")).toBe("perp");
    expect(new URL(call.url).searchParams.get("market_id")).toBe("1");
  });

  test("a route with no required parameters is callable with no arguments", async () => {
    const spy = stub(() => json({ code: 200, timestamp: 1 }));
    const client = new LighterRestClient({ fetch: spy.fetch });
    await client.root.status();
    expect(new URL((spy.calls[0] as RecordedCall).url).pathname).toBe("/");
  });

  test("per-call options are merged over the client's config", async () => {
    const clientLevel = stub(() => json({ code: 200 }));
    const perCall = stub(() => json({ code: 200 }));
    const client = new LighterRestClient({ fetch: clientLevel.fetch });

    await client.order.orderBooks({}, { fetch: perCall.fetch });

    expect(clientLevel.calls.length).toBe(0);
    expect(perCall.calls.length).toBe(1);
  });

  test("`raw: true` yields the untouched Response, body unread", async () => {
    const spy = stub(() => json({ code: 200, order_books: [] }));
    const client = new LighterRestClient({ fetch: spy.fetch });
    const response: Response = await client.order.orderBooks({}, { raw: true });
    expect(response.status).toBe(200);
    expect(response.bodyUsed).toBe(false);
    expect(((await response.json()) as { code: number }).code).toBe(200);
  });

  test("a per-call signal reaches fetch, composed with the transport's own timeout", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const spy = stub(() => json({ code: 200 }));
    const client = new LighterRestClient({
      fetch: ((input: string | URL, init?: RequestInit): Promise<Response> => {
        observed = init?.signal ?? undefined;
        return spy.fetch(input as string, init);
      }) as unknown as typeof globalThis.fetch,
    });
    await client.order.orderBooks({}, { signal: controller.signal });
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(false);
    controller.abort();
    expect(observed?.aborted).toBe(true);
  });

  test("a route declaring `auth: required` fails fast when no credential is configured", async () => {
    const spy = stub(() => json({ code: 200 }));
    const client = new LighterRestClient({ fetch: spy.fetch });
    await expect(client.order.accountActiveOrders({ account_index: 42 })).rejects.toBeInstanceOf(
      LighterConfigError,
    );
    expect(spy.calls.length).toBe(0);
  });

  test("the escape-hatch `request` drives any route, which is what paginate uses", async () => {
    const spy = stub(() => json({ code: 200, order_books: [] }));
    const client = new LighterRestClient({ fetch: spy.fetch });
    const result: OrderBooks = await client.request(routes.orderBooks, { filter: "spot" });
    expect(result.code).toBe(200);
    expect(new URL((spy.calls[0] as RecordedCall).url).searchParams.get("filter")).toBe("spot");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Types                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("type inference", () => {
  test("parameters and responses infer from the single declaration site", () => {
    const spy = stub(() => json({ code: 200, orders: [] }));
    const client = new LighterRestClient({ fetch: spy.fetch, auth: "t" });

    // The annotations are the assertion: a wrong `ResponseOf` fails the typecheck gate.
    const orders: Promise<Orders> = client.order.accountActiveOrders({ account_index: 42 });
    const books: Promise<OrderBooks> = client.order.orderBooks({ filter: "perp" });
    void orders.catch((): void => undefined);
    void books.catch((): void => undefined);

    // @ts-expect-error `nope` is not a parameter of accountActiveOrders
    void client.order.accountActiveOrders({ account_index: 42, nope: true }).catch(() => undefined);

    // @ts-expect-error `account_index` is a number, not a string
    void client.order.accountActiveOrders({ account_index: "42" }).catch(() => undefined);

    // @ts-expect-error `market_id` is required on candles
    void client.candlestick.candles({ resolution: "1h" }).catch(() => undefined);

    // `2h` is not a candle resolution — the three resolution unions are deliberately distinct and
    // none of them contains it. Written on one line so the directive lands on the reported error.
    // prettier-ignore
    // @ts-expect-error
    void client.candlestick.candles({ market_id: 1, resolution: "2h", start_timestamp: 0, end_timestamp: 1, count_back: 1 }).catch(() => undefined);

    expect(typeof client.order.accountActiveOrders).toBe("function");
  });

  test("a group facade's key set is exactly its routes' keys, at the type level", () => {
    // `orderBooks` is tagged `order`; asking for it on `account` is a type error.
    const order: GroupFacade<"order"> = new LighterRestClient().order;
    expect(typeof order.orderBooks).toBe("function");

    // @ts-expect-error `orderBooks` is tagged `order`, not `account`
    const misplaced: keyof GroupFacade<"account"> = "orderBooks";
    void misplaced;

    // The route key union is the table's own key union.
    const key: RouteKey = "accountActiveOrders";
    expect(key in routes).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Hygiene                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("hygiene", () => {
  test("no Node built-in and no runtime dependency", async () => {
    const source: string = await Bun.file(
      new URL("../../src/rest/client.ts", import.meta.url).pathname,
    ).text();
    for (const forbidden of ["node:", "Buffer", "process.", "require("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
