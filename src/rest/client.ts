/**
 * The grouped REST client — the ergonomic surface over `./routes.js` and `./transport.js`.
 *
 * It exists to **delete** work, not to add it. The reference Python SDK ships 13 API classes, each
 * needing an `ApiClient`, with three method variants per operation (234 methods) and `auth`
 * threaded by hand through every call site. All of that is derivable from the route table, so it is
 * derived: the constructor walks `routes` once and binds `request(route, params, config)` under the
 * route's own key inside its own group.
 *
 * ```ts
 * const client = new LighterRestClient({ endpoint: "mainnet" });
 * const books  = await client.order.orderBooks({ filter: "perp" });
 * const orders = await client.order.accountActiveOrders({ account_index: 42 });
 * ```
 *
 * Three properties are load-bearing and easy to lose in a refactor:
 *
 * 1. **Parameter names stay `snake_case`, exactly as the wire spells them** (`spec/05-rest-api.md`
 *    §11.4). Camel-casing looks nicer for about a day and then costs a bidirectional mapping over
 *    142 models, breaks pasting a field name straight out of the API docs, and becomes a permanent
 *    drift surface. Candles are the one documented exception, and they live in `./candles.js`.
 * 2. **Nothing happens at import time, and nothing expensive or stateful happens in the
 *    constructor.** `"sideEffects": false` must stay truthful: importing this module may not open a
 *    socket, schedule a timer, mutate a global, or call `crypto.getRandomValues` — Cloudflare
 *    Workers forbids the last one at module scope (`docs/decisions.md` D2). Auth is *not* resolved
 *    here either; the transport resolves it per request, so a token minted at construction cannot
 *    go stale in a long-lived client.
 * 3. **There is no queue, no pool, and no shared mutable state.** Concurrency is the caller's
 *    business, and the injectable `fetch` covers every case anyone has needed to date. The only
 *    state a client owns is a shallow copy of its config, which it never writes to.
 *
 * The one accepted cost: the facade object references every route, so importing it defeats
 * per-route tree-shaking. That is why `request()` is re-exported from `./index.js` unchanged —
 * size-sensitive consumers name the two or three routes they use and skip this file entirely.
 */

import type { LighterConfig } from "../config/config.js";
import type { ParamsOf, ResponseOf, RestGroup, RouteDef } from "./route-types.js";
import { routes } from "./routes.js";
import type { RequestOptions } from "./transport.js";
import { request as executeRequest } from "./transport.js";

/* ---------------------------------------------------------------------------------------------- */
/* The route table, as types                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The whole route table's type. Literal-keyed, which is what makes the facade inferable. */
export type RouteTable = typeof routes;

/** Every operation id in the table — `"orderBooks" | "accountActiveOrders" | … | "export"`. */
export type RouteKey = keyof RouteTable;

/** The keys of every route tagged `G`. Distributes over the table, so a new route joins its group. */
type KeysOfGroup<G extends RestGroup> = {
  [K in RouteKey]: RouteTable[K]["group"] extends G ? K : never;
}[RouteKey];

/* ---------------------------------------------------------------------------------------------- */
/* Per-call options                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What a single call may override.
 *
 * A superset of the `{ signal, raw }` the facade strictly needs: everything {@link RequestOptions}
 * carries is accepted and shallow-merged **over** the client's own config, so one call can widen a
 * timeout or swap a credential without a second client. Omitted keys keep the client's value.
 *
 * `raw` is `false`-or-absent here and `true` on {@link RawCallOptions}. Splitting it that way is
 * what lets the return type be `Response` exactly when the body is not parsed — a plain
 * `raw?: boolean` would have to widen every method's return type to `ResponseOf<R> | Response`,
 * which every caller would then have to narrow by hand.
 */
export interface CallOptions extends Omit<RequestOptions, "raw"> {
  readonly raw?: false;
}

/** {@link CallOptions} with `raw: true`: the untouched `Response`, body unread. */
export type RawCallOptions = Omit<RequestOptions, "raw"> & { readonly raw: true };

/**
 * The argument list for one route.
 *
 * `params` becomes optional exactly when it can be — a route with no `query` and no `body` (`GET /`
 * and `GET /info`) has `ParamsOf<R> = unknown`, and a route whose every parameter is optional is
 * satisfied by `{}`. Both then call as `client.root.status()` rather than
 * `client.root.status(undefined)`.
 */
type CallArgs<R> = unknown extends ParamsOf<R>
  ? [params?: undefined, opts?: CallOptions]
  : Record<never, never> extends ParamsOf<R>
    ? [params?: ParamsOf<R>, opts?: CallOptions]
    : [params: ParamsOf<R>, opts?: CallOptions];

/**
 * One bound operation.
 *
 * Two call signatures rather than a union return: with `raw: true` the transport hands back the
 * `Response` without reading its body, and with anything else it hands back the parsed, typed
 * success model. Overload order matters — the raw signature must come first, because its `opts` is
 * required and would otherwise never be reached.
 */
export interface RouteMethod<R> {
  (params: ParamsOf<R>, opts: RawCallOptions): Promise<Response>;
  (...args: CallArgs<R>): Promise<ResponseOf<R>>;
}

/**
 * Every operation tagged `G`, keyed by its operation id.
 *
 * The groups are the OpenAPI document's own tags, so a few land somewhere surprising —
 * `referralUserReferrals` and every `rfq*` operation are tagged `account`, and `assetDetails` and
 * `exchangeStats` are tagged `order` (see {@link RestGroup}). Regrouping them would desynchronise
 * the facade from the wire vocabulary for no gain.
 */
export type GroupFacade<G extends RestGroup> = {
  readonly [K in KeysOfGroup<G>]: RouteMethod<RouteTable[K]>;
};

/* ---------------------------------------------------------------------------------------------- */
/* The client                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** Buckets under construction: one record of bound methods per group seen in the table. */
type GroupBuckets = { [G in RestGroup]?: Record<string, unknown> };

/**
 * All 78 REST operations, grouped by tag.
 *
 * Construction is one pass over `routes` — 78 closures and 13 frozen objects, no I/O, no clock, no
 * randomness. Constructing a client is therefore cheap enough to do per request in a serverless
 * handler, and safe enough to do at module scope in one that is not.
 *
 * @see {@link paginate} in `./paginate.js` for cursor iteration.
 * @see `request` in `./transport.js` to skip the facade entirely and keep tree-shaking.
 */
export class LighterRestClient {
  /** Shallow copy: a client never observes later mutation of the object it was handed. */
  readonly #config: LighterConfig;

  readonly account: GroupFacade<"account">;
  readonly order: GroupFacade<"order">;
  readonly transaction: GroupFacade<"transaction">;
  readonly bridge: GroupFacade<"bridge">;
  readonly referral: GroupFacade<"referral">;
  readonly info: GroupFacade<"info">;
  readonly block: GroupFacade<"block">;
  readonly candlestick: GroupFacade<"candlestick">;
  readonly root: GroupFacade<"root">;
  readonly announcement: GroupFacade<"announcement">;
  readonly funding: GroupFacade<"funding">;
  readonly notification: GroupFacade<"notification">;
  readonly tokenlist: GroupFacade<"tokenlist">;

  constructor(config: LighterConfig = {}) {
    this.#config = Object.freeze({ ...config });

    const buckets: GroupBuckets = {};
    for (const key of Object.keys(routes)) {
      const route: RouteDef = (routes as Record<string, RouteDef>)[key] as RouteDef;
      const group: RestGroup = route.group;
      let bucket: Record<string, unknown> | undefined = buckets[group];
      if (bucket === undefined) {
        // Null-prototype: route keys are data, and a table entry named `constructor` or
        // `__proto__` must be an ordinary own property rather than a prototype write.
        bucket = Object.create(null) as Record<string, unknown>;
        buckets[group] = bucket;
      }
      bucket[key] = (params?: unknown, opts?: RequestOptions): Promise<unknown> =>
        this.request(route as never, params as never, opts as never);
    }

    this.account = facadeOf(buckets, "account");
    this.order = facadeOf(buckets, "order");
    this.transaction = facadeOf(buckets, "transaction");
    this.bridge = facadeOf(buckets, "bridge");
    this.referral = facadeOf(buckets, "referral");
    this.info = facadeOf(buckets, "info");
    this.block = facadeOf(buckets, "block");
    this.candlestick = facadeOf(buckets, "candlestick");
    this.root = facadeOf(buckets, "root");
    this.announcement = facadeOf(buckets, "announcement");
    this.funding = facadeOf(buckets, "funding");
    this.notification = facadeOf(buckets, "notification");
    this.tokenlist = facadeOf(buckets, "tokenlist");
  }

  /** The configuration this client was constructed with, frozen. Never mutated, never resolved here. */
  get config(): LighterConfig {
    return this.#config;
  }

  /**
   * Issue any route, including one that is not in the table — the escape hatch the facade is built
   * on, and what {@link paginate} drives.
   *
   * Per-call `opts` are shallow-merged over the client's config, so `{ signal }` alone leaves
   * everything else in place.
   */
  request<R extends RouteDef>(
    route: R,
    params: ParamsOf<R>,
    opts: RawCallOptions,
  ): Promise<Response>;
  request<R extends RouteDef>(
    route: R,
    params?: ParamsOf<R>,
    opts?: CallOptions,
  ): Promise<ResponseOf<R>>;
  request<R extends RouteDef>(
    route: R,
    params?: ParamsOf<R>,
    opts?: CallOptions | RawCallOptions,
  ): Promise<ResponseOf<R> | Response> {
    const merged: RequestOptions = { ...this.#config, ...opts } as RequestOptions;
    return executeRequest(route, params, merged);
  }
}

/**
 * Freeze and hand back one group's bucket.
 *
 * A group with no routes yields `{}`, which is precisely what `GroupFacade<G>` maps to in that
 * case — so an editing accident in the table surfaces as a missing method at compile time rather
 * than as a constructor that throws.
 */
function facadeOf<G extends RestGroup>(buckets: GroupBuckets, group: G): GroupFacade<G> {
  const bucket: Record<string, unknown> = buckets[group] ?? (Object.create(null) as Record<string, unknown>);
  return Object.freeze(bucket) as unknown as GroupFacade<G>;
}
