/**
 * The type vocabulary the REST route table is written in, and the extractors the transport and the
 * grouped facade read back out of it.
 *
 * Nothing here has a runtime representation: this module compiles to an empty ES module. That is
 * deliberate — `routes.ts` carries per-operation *types* on phantom properties (`query`, `body`,
 * `response`) whose runtime values are empty object literals, so the whole 78-operation table is
 * inert data that a bundler with `"sideEffects": false` can shake down to the entries a program
 * actually names.
 *
 * Why a hand-maintained table at all, rather than generation from `spec/openapi.snapshot.json`:
 * `docs/ARCHITECTURE.md` ADR-6 and `spec/05-rest-api.md` §11.1. The short version is that the
 * document is measurably wrong about response shapes (§9.2 — it marks ~95% of fields `required`
 * while the Go server omits every zero-valued one) and wrong about **authentication on at least
 * six operations** (§5.4). `auth` is therefore data on the route, corrected against live probes,
 * and must never be re-derived from the document by a generator.
 */

/** Every operation on the API is one of these two. There is no `PUT`, `PATCH` or `DELETE`. */
export type RestMethod = "GET" | "POST";

/**
 * What the transport must do about credentials before sending.
 *
 * - `'none'` — never attach a token. Public reads, and the two write endpoints, whose
 *   authentication is the L2 signature *inside* `tx_info` rather than a bearer credential.
 * - `'required'` — the server rejects the call without one; fail fast if no auth provider is
 *   configured rather than spending a round-trip on a guaranteed `20001`.
 * - `'optional'` — attach one when the caller has configured it, proceed without otherwise.
 *
 * The token travels in the `Authorization` header (no scheme prefix) or, interchangeably, in an
 * `auth` query parameter or form field — `spec/05-rest-api.md` §5.2. Prefer the header: the query
 * parameter puts a bearer credential into URLs, access logs and referrers.
 */
export type RestAuth = "none" | "required" | "optional";

/**
 * How a `POST` body is serialised. `GET` routes declare neither.
 *
 * 17 of the 18 `POST` operations are `application/x-www-form-urlencoded`; `setAccountMetadata`
 * alone is `application/json` (`spec/05-rest-api.md` §2.1). `setMakerOnlyApiKeys` additionally
 * *advertises* `multipart/form-data`, which is why there is no `'multipart'` member here: it is
 * never needed and is deliberately not implementable from this table.
 */
export type RestEncoding = "form" | "json";

/**
 * The operation's OpenAPI tag, which is what the grouped client facade is keyed on
 * (`client.order.orderBooks(...)`).
 *
 * These are the document's tags, not a taxonomy of our own, so a few land somewhere surprising:
 * `referral/userReferrals` and every `rfq/*` operation are tagged **`account`**, not `referral`;
 * `withdrawalDelay` and `transferFeeInfo` are tagged `info`; `assetDetails` and `exchangeStats`
 * are tagged `order`. Regrouping them would break the tally test against the snapshot, and the
 * facade shape is not worth desynchronising from the wire vocabulary.
 */
export type RestGroup =
  | "account"
  | "order"
  | "transaction"
  | "bridge"
  | "referral"
  | "info"
  | "block"
  | "candlestick"
  | "root"
  | "announcement"
  | "funding"
  | "notification"
  | "tokenlist";

/**
 * One operation, entirely as data.
 *
 * `query`, `body` and `response` are **phantom** properties: written as `{} as SomeType`, they
 * carry a type into `typeof routes` while emitting an empty object literal. Read them with
 * {@link ParamsOf} / {@link ResponseOf} rather than at runtime — at runtime they are `{}`.
 */
export interface RouteDef {
  readonly method: RestMethod;
  /**
   * The full path, including the `/api/v1` prefix where the operation has one. Two operations
   * — `GET /` and `GET /info` — sit at the origin root and have no prefix, which is why the
   * prefix lives here rather than in the base URL.
   */
  readonly path: string;
  /** Hand-maintained and live-corrected. See {@link RestAuth} and `spec/05-rest-api.md` §5.4. */
  readonly auth: RestAuth;
  /** `POST` only. Absent on `GET`. Every `POST` in the table declares it explicitly. */
  readonly encoding?: RestEncoding;
  readonly group: RestGroup;
  /**
   * The wire key of the response's collection field, where the response has exactly one — `orders`,
   * `trades`, `order_books`, `sub_accounts`, `txs`, `blocks`, and so on.
   *
   * `paginateItems()` is typed off this through {@link ItemOf}, so a key that is not actually on
   * the response yields a compile-clean `undefined` at runtime. Responses with *two* plausible
   * collections (`orderBookOrders` has `asks` and `bids`; `orderBookDetails` has perp and spot
   * arrays) deliberately declare none — there is no single right answer to flatten to.
   */
  readonly itemsKey?: string;
  /** Phantom: `{} as QueryType`. */
  readonly query?: unknown;
  /** Phantom: `{} as BodyType`. */
  readonly body?: unknown;
  /** Phantom: `{} as ResponseType`. */
  readonly response: unknown;
}

/**
 * The caller-supplied input for a route: its query parameters and its body fields as one object.
 *
 * The transport already knows which half goes into the query string and which into the body, so
 * callers never have to. `unknown & X` collapses to `X`, which is what makes the intersection
 * degrade correctly for a `GET` (no `body`) or a `POST` (no `query`); a route with neither yields
 * `unknown`.
 */
export type ParamsOf<R> = (R extends { readonly query: infer Q } ? Q : unknown) &
  (R extends { readonly body: infer B } ? B : unknown);

/** The route's success-response type. `unknown` if the route somehow declares none. */
export type ResponseOf<R> = R extends { readonly response: infer T } ? T : unknown;

/**
 * The element type of `T`, seeing through the `| undefined` that every collection field on every
 * model carries (the server's `omitempty` means a collection can simply be absent).
 */
type ElementOf<T> = NonNullable<T> extends readonly (infer E)[] ? E : never;

/**
 * The element type of the collection a route's `itemsKey` names — the thing `paginateItems()`
 * yields — or `never` when the route declares no `itemsKey`.
 *
 * `never` is the useful answer rather than an error: it makes the flattening variant of the
 * pagination helper reject non-collection routes at the call site instead of returning junk.
 */
export type ItemOf<R> = R extends { readonly itemsKey: infer K; readonly response: infer T }
  ? K extends keyof T
    ? ElementOf<T[K]>
    : never
  : never;
