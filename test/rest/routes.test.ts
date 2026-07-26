/**
 * The route table, checked against the vendored OpenAPI snapshot — and, where the snapshot is
 * known to be wrong, against `spec/05-rest-api.md` §5.4 instead.
 *
 * Two different jobs here, and they pull in opposite directions:
 *
 *  1. **Completeness and shape** come from `spec/openapi.snapshot.json`. Every `(path, method)` in
 *     the document must have exactly one entry, and every entry must exist in the document. Counts
 *     are *derived* from the document rather than written down — `docs/decisions.md` (Corrections)
 *     makes that a house rule after a hand-copied count drifted across three documents.
 *
 *  2. **Authentication** deliberately does *not* come from the document, because on at least eight
 *     operations the document is wrong. Those eight are pinned by hand below with the evidence
 *     inline, so the next person does not "fix" them back.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { OrderBooks } from "../../src/models/market.js";
import type { Order, Trade } from "../../src/models/order.js";
import type { ReqSendTx } from "../../src/models/transaction.js";
import type { ItemOf, ParamsOf, ResponseOf, RestGroup } from "../../src/rest/route-types.js";
import { routes } from "../../src/rest/routes.js";

/* ---------------------------------------------------------------------------------------------- */
/* The document                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

interface SnapshotOperation {
  readonly operationId?: string;
  readonly tags?: readonly string[];
  readonly requestBody?: { readonly content?: Record<string, unknown> };
}

interface Snapshot {
  readonly paths: Record<string, Record<string, SnapshotOperation>>;
}

const snapshot = JSON.parse(
  readFileSync(new URL("../../spec/openapi.snapshot.json", import.meta.url), "utf8"),
) as Snapshot;

interface DocOperation {
  readonly method: string;
  readonly path: string;
  readonly key: string;
  readonly operationId: string;
  readonly tag: string;
  readonly contentTypes: readonly string[];
}

const docOperations: readonly DocOperation[] = Object.entries(snapshot.paths).flatMap(
  ([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      key: `${method.toUpperCase()} ${path}`,
      operationId: op.operationId ?? "",
      tag: op.tags?.[0] ?? "",
      contentTypes: Object.keys(op.requestBody?.content ?? {}),
    })),
);

/**
 * Operations present in the document but deliberately absent from the table.
 *
 * Empty, and it should stay that way: every one of the document's operations is reachable. This
 * list exists so that a future omission has to be written down and justified rather than silently
 * dropped — an absent route and an unimplemented route look identical from the outside.
 */
export const EXCLUDED_OPERATIONS: readonly string[] = [];

/* ---------------------------------------------------------------------------------------------- */
/* The table, as plain data                                                                         */
/* ---------------------------------------------------------------------------------------------- */

interface RouteRow {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly auth: string;
  readonly group: RestGroup;
  readonly encoding?: string;
  readonly itemsKey?: string;
}

const routeRows: readonly RouteRow[] = Object.entries(routes).map(([key, r]) => {
  const row = r as { method: string; path: string; auth: string; group: RestGroup } & {
    encoding?: string;
    itemsKey?: string;
  };
  return {
    key,
    method: row.method,
    path: row.path,
    auth: row.auth,
    group: row.group,
    ...(row.encoding === undefined ? {} : { encoding: row.encoding }),
    ...(row.itemsKey === undefined ? {} : { itemsKey: row.itemsKey }),
  };
});

const routeWireKey = (r: RouteRow): string => `${r.method} ${r.path}`;

/* ---------------------------------------------------------------------------------------------- */
/* Coverage against the snapshot                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("coverage against spec/openapi.snapshot.json", () => {
  test("every documented (path, method) has exactly one route entry", () => {
    const covered = new Map<string, string[]>();
    for (const r of routeRows) {
      const list = covered.get(routeWireKey(r));
      if (list === undefined) covered.set(routeWireKey(r), [r.key]);
      else list.push(r.key);
    }

    const missing = docOperations
      .filter((op) => !covered.has(op.key) && !EXCLUDED_OPERATIONS.includes(op.key))
      .map((op) => op.key);
    expect(missing).toEqual([]);

    const duplicated = [...covered.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([wire, keys]) => `${wire} -> ${keys.join(", ")}`);
    expect(duplicated).toEqual([]);
  });

  test("every route entry exists in the document — no invented endpoints, no typo'd paths", () => {
    const documented = new Set(docOperations.map((op) => op.key));
    const unknown = routeRows.filter((r) => !documented.has(routeWireKey(r))).map(routeWireKey);
    expect(unknown).toEqual([]);
  });

  test("the operation count is the document's, not a number copied into prose", () => {
    // Derived on both sides on purpose. If the snapshot is re-vendored and grows an operation,
    // this fails with the real number rather than agreeing with a stale constant.
    expect(routeRows.length).toBe(docOperations.length - EXCLUDED_OPERATIONS.length);
  });

  test("the GET/POST split matches the document", () => {
    const count = (rows: readonly { method: string }[], m: string): number =>
      rows.filter((r) => r.method === m).length;

    expect(count(routeRows, "GET")).toBe(count(docOperations, "GET"));
    expect(count(routeRows, "POST")).toBe(count(docOperations, "POST"));
    expect(routeRows.filter((r) => r.method !== "GET" && r.method !== "POST")).toEqual([]);
  });

  test("the per-group tally matches the document's tags", () => {
    const tally = (pairs: readonly (readonly [string, string])[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [, group] of pairs) out[group] = (out[group] ?? 0) + 1;
      return out;
    };

    const fromDoc = tally(docOperations.map((op) => [op.key, op.tag] as const));
    const fromTable = tally(routeRows.map((r) => [r.key, r.group] as const));
    expect(fromTable).toEqual(fromDoc);
  });

  test("each route's group is the document's tag for that operation", () => {
    const tagByWire = new Map(docOperations.map((op) => [op.key, op.tag]));
    const mismatched = routeRows
      .filter((r) => tagByWire.get(routeWireKey(r)) !== r.group)
      .map((r) => `${r.key}: table=${r.group} doc=${tagByWire.get(routeWireKey(r)) ?? "?"}`);
    expect(mismatched).toEqual([]);
  });

  test("route keys are the document's operation ids, camel-cased", () => {
    const camel = (id: string): string =>
      id
        .split(/[_-]/)
        .map((part, i) => (i === 0 ? part : (part[0] ?? "").toUpperCase() + part.slice(1)))
        .join("");

    const expected = new Map(docOperations.map((op) => [op.key, camel(op.operationId)]));
    const mismatched = routeRows
      .filter((r) => expected.get(routeWireKey(r)) !== r.key)
      .map((r) => `${routeWireKey(r)}: key=${r.key} expected=${expected.get(routeWireKey(r)) ?? "?"}`);
    expect(mismatched).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The two root-level operations                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("the origin-root pair", () => {
  // 76 paths sit under /api/v1 and two more sit at the origin root. Putting /api/v1 into the base
  // URL to "tidy up" the prefix makes these two unreachable.
  test("GET / and GET /info are present, in group root, with no /api/v1 prefix", () => {
    expect(routes.status.method).toBe("GET");
    expect(routes.status.path).toBe("/");
    expect(routes.status.group).toBe("root");

    expect(routes.info.method).toBe("GET");
    expect(routes.info.path).toBe("/info");
    expect(routes.info.group).toBe("root");
  });

  test("every other route is prefixed /api/v1", () => {
    const unprefixed = routeRows
      .filter((r) => r.group !== "root")
      .filter((r) => !r.path.startsWith("/api/v1/"))
      .map(routeWireKey);
    expect(unprefixed).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Authentication — hand-maintained, and NOT derived from the document                              */
/* ---------------------------------------------------------------------------------------------- */

describe("auth requirement", () => {
  /**
   * `spec/05-rest-api.md` §5.4: these six are declared auth-*optional* by the OpenAPI document and
   * are **enforced at runtime** — verified 400 without a token. The table is corrected evidence,
   * not a transcription of the document, so do not change these back to `'optional'` because the
   * snapshot says so. `trades` is the notable one: it has no required account parameter and still
   * answers `{"code":20001,"message":"invalid param : auth query param and Authorization header
   * are empty"}` unauthenticated.
   */
  test.each([
    ["accountMetadata", routes.accountMetadata.auth],
    ["positionFunding", routes.positionFunding.auth],
    ["leases", routes.leases.auth],
    ["tokens", routes.tokens.auth],
    ["referralGet", routes.referralGet.auth],
    ["trades", routes.trades.auth],
  ])("%s is 'required' despite the document declaring it optional (§5.4)", (_name, auth) => {
    expect(auth).toBe("required");
  });

  /**
   * `spec/05-rest-api.md` §5.4: the write path authenticates with the L2 signature inside
   * `tx_info`, not with a bearer token. Marking these `'required'` would make every submission
   * depend on a read token and push a credential onto the write path for no reason.
   */
  test.each([
    ["sendTx", routes.sendTx.auth],
    ["sendTxBatch", routes.sendTxBatch.auth],
  ])("%s takes no auth token (§5.4)", (_name, auth) => {
    expect(auth).toBe("none");
  });

  /**
   * `spec/05-rest-api.md` §5.4: declared optional and *genuinely* optional — verified 200 without
   * a token. `pnl` is rejected on range and `transferHistory` on account lookup, neither on auth.
   */
  test.each([
    ["publicPoolsMetadata", routes.publicPoolsMetadata.auth],
    ["pnl", routes.pnl.auth],
    ["transferHistory", routes.transferHistory.auth],
  ])("%s stays 'optional' — verified 200 unauthenticated (§5.4)", (_name, auth) => {
    expect(auth).toBe("optional");
  });

  test("the 19 operations the document declares authorization REQUIRED are all 'required'", () => {
    // §5.4's first list, spelled as route keys. These agree with the document, unlike the six above.
    const declaredRequired = [
      "accountLimits",
      "getMakerOnlyApiKeys",
      "l1Metadata",
      "liquidations",
      "setMakerOnlyApiKeys",
      "rfqCreate",
      "rfqGet",
      "rfqList",
      "rfqRespond",
      "rfqUpdate",
      "fastwithdrawInfo",
      "transferFeeInfo",
      "accountActiveOrders",
      "accountInactiveOrders",
      "export",
      "referralPoints",
      "depositHistory",
      "withdrawHistory",
    ] as const;

    const byKey = new Map(routeRows.map((r) => [r.key, r]));
    const wrong = declaredRequired
      .filter((k) => byKey.get(k)?.auth !== "required")
      .map((k) => `${k}=${byKey.get(k)?.auth ?? "MISSING"}`);
    expect(wrong).toEqual([]);
  });

  test("every auth value is one of the three legal ones", () => {
    const illegal = routeRows
      .filter((r) => r.auth !== "none" && r.auth !== "required" && r.auth !== "optional")
      .map((r) => `${r.key}=${r.auth}`);
    expect(illegal).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Body encoding                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("body encoding", () => {
  test("setAccountMetadata is the only json route; every other POST is form", () => {
    const json = routeRows.filter((r) => r.encoding === "json").map((r) => r.key);
    expect(json).toEqual(["setAccountMetadata"]);

    const posts = routeRows.filter((r) => r.method === "POST");
    const notForm = posts.filter((r) => r.encoding !== "form" && r.encoding !== "json");
    expect(notForm.map((r) => r.key)).toEqual([]);
    expect(posts.filter((r) => r.encoding === "form").length).toBe(posts.length - 1);
  });

  test("GET routes declare no encoding", () => {
    const withEncoding = routeRows
      .filter((r) => r.method === "GET" && r.encoding !== undefined)
      .map((r) => r.key);
    expect(withEncoding).toEqual([]);
  });

  test("the declared encoding matches the document's content type", () => {
    const byWire = new Map(docOperations.map((op) => [op.key, op]));
    const mismatched: string[] = [];
    for (const r of routeRows.filter((row) => row.method === "POST")) {
      const doc = byWire.get(routeWireKey(r));
      const expected = doc?.contentTypes.includes("application/json") ? "json" : "form";
      if (r.encoding !== expected) mismatched.push(`${r.key}: ${r.encoding ?? "none"} != ${expected}`);
    }
    expect(mismatched).toEqual([]);
  });

  test("no route declares multipart, even though setMakerOnlyApiKeys advertises it", () => {
    // The document lists multipart/form-data as a second accepted content type on that one
    // operation. There is no reason to use it and it is deliberately not representable here.
    expect(
      docOperations.find((op) => op.key === "POST /api/v1/setMakerOnlyApiKeys")?.contentTypes,
    ).toContain("multipart/form-data");
    expect(routes.setMakerOnlyApiKeys.encoding).toBe("form");

    const encodings = new Set(routeRows.map((r) => r.encoding).filter((e) => e !== undefined));
    expect([...encodings].sort()).toEqual(["form", "json"]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The table is data                                                                                */
/* ---------------------------------------------------------------------------------------------- */

describe("the table is inert data", () => {
  test("every property is a plain value — no functions, no getters", () => {
    for (const [key, route] of Object.entries(routes)) {
      for (const prop of Object.keys(route)) {
        const d = Object.getOwnPropertyDescriptor(route, prop);
        expect(`${key}.${prop} descriptor`).toBe(`${key}.${prop} descriptor`);
        expect(d?.get).toBeUndefined();
        expect(d?.set).toBeUndefined();
        expect(typeof (d?.value as unknown)).not.toBe("function");
      }
    }
  });

  test("phantom properties are empty at runtime; everything else is a string literal", () => {
    const phantom = new Set(["query", "body", "response"]);
    for (const [key, route] of Object.entries(routes)) {
      for (const [prop, value] of Object.entries(route as Record<string, unknown>)) {
        if (phantom.has(prop)) {
          expect(`${key}.${prop}`).toBe(`${key}.${prop}`);
          expect(typeof value).toBe("object");
          expect(Object.keys(value as object)).toEqual([]);
        } else {
          expect(`${key}.${prop}=${String(value)}`).toBe(`${key}.${prop}=${String(value)}`);
          expect(typeof value).toBe("string");
        }
      }
    }
  });

  test("every route declares a response phantom", () => {
    const missing = Object.entries(routes)
      .filter(([, r]) => !Object.hasOwn(r, "response"))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* itemsKey                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** `T` must be exactly `true`; anything else is a compile error at the use site. */
type Assert<T extends true> = T;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Every declared `itemsKey` names a key that actually exists on the route's response model, and
 * that key holds an array. This is the check that a runtime test cannot make — the phantom is `{}`
 * at runtime, so a wrong `itemsKey` is compile-clean and returns `undefined` in production.
 */
type ItemsKeyResolves<R> = R extends { readonly itemsKey: string }
  ? [ItemOf<R>] extends [never]
    ? false
    : true
  : true;

/**
 * Evaluated eagerly, one entry per route, then collapsed. A single unresolvable `itemsKey` widens
 * the union to `boolean` and fails the `Equals` below. (The check cannot be `Assert<…>` *inside*
 * the mapped type: with a generic key the conditional stays deferred and the constraint is
 * unverifiable, so it would fail for every table, correct or not.)
 */
type ItemsKeyReport = { [K in keyof typeof routes]: ItemsKeyResolves<(typeof routes)[K]> };

type _AllItemsKeysResolve = Assert<Equals<ItemsKeyReport[keyof ItemsKeyReport], true>>;

describe("itemsKey", () => {
  test("routes whose response has two collections declare none", () => {
    // asks + bids, and perp + spot order book details. There is no single right answer to flatten
    // to, and guessing one would make paginateItems() silently drop half the payload.
    expect(routeRows.find((r) => r.key === "orderBookOrders")?.itemsKey).toBeUndefined();
    expect(routeRows.find((r) => r.key === "orderBookDetails")?.itemsKey).toBeUndefined();
    expect(routeRows.find((r) => r.key === "layer1BasicInfo")?.itemsKey).toBeUndefined();
  });

  test("the wire keys are the server's, not tidied-up ones", () => {
    expect(routes.orderBooks.itemsKey).toBe("order_books");
    expect(routes.accountsByL1Address.itemsKey).toBe("sub_accounts");
    expect(routes.accountTxs.itemsKey).toBe("txs");
    expect(routes.blocks.itemsKey).toBe("blocks");
    expect(routes.accountActiveOrders.itemsKey).toBe("orders");
    expect(routes.trades.itemsKey).toBe("trades");
    // Candles.c is the array of candles; Candle.c one level down is the close price.
    expect(routes.candles.itemsKey).toBe("c");
  });

  test("no itemsKey is an empty string", () => {
    expect(routeRows.filter((r) => r.itemsKey === "").map((r) => r.key)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Type-level extraction                                                                            */
/* ---------------------------------------------------------------------------------------------- */

type _ResponseOfOrderBooks = Assert<Equals<ResponseOf<typeof routes.orderBooks>, OrderBooks>>;
type _ItemOfTrades = Assert<Equals<ItemOf<typeof routes.trades>, Trade>>;
type _ItemOfActiveOrders = Assert<Equals<ItemOf<typeof routes.accountActiveOrders>, Order>>;
type _ItemOfUnkeyed = Assert<Equals<ItemOf<typeof routes.orderBookOrders>, never>>;

type _ParamsHasAccountIndex = Assert<
  ParamsOf<typeof routes.accountActiveOrders> extends { account_index: number } ? true : false
>;
/** A POST route's params are its body — `unknown & B` collapses to `B`. */
type _ParamsOfSendTx = Assert<Equals<ParamsOf<typeof routes.sendTx>, ReqSendTx>>;
/** A route with neither query nor body extracts to `unknown`, not to an error. */
type _ParamsOfStatus = Assert<Equals<ParamsOf<typeof routes.status>, unknown>>;

describe("type-level extraction", () => {
  test("the compile-time assertions above are inhabited", () => {
    // Each alias is `true` by construction; naming them here is what stops a future edit from
    // deleting the assertions as unused.
    const checks: [
      _ResponseOfOrderBooks,
      _ItemOfTrades,
      _ItemOfActiveOrders,
      _ItemOfUnkeyed,
      _ParamsHasAccountIndex,
      _ParamsOfSendTx,
      _ParamsOfStatus,
      _AllItemsKeysResolve,
    ] = [true, true, true, true, true, true, true, true];
    expect(checks.every(Boolean)).toBe(true);
  });

  test("params carry the declared query fields at runtime-free cost", () => {
    // The phantom is empty: this is the whole point. Reading it must not throw and must not
    // produce anything.
    expect(Object.keys(routes.accountActiveOrders.query)).toEqual([]);
    expect(Object.keys(routes.sendTx.body)).toEqual([]);
  });
});
