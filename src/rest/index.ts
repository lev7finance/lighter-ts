/**
 * The `./rest` subpath barrel: the route table, the transport, the grouped client, pagination and
 * the candle mapping, and nothing else.
 *
 * Star re-exports rather than a hand-maintained name list. A name added to a module and forgotten
 * here is a name the package does not ship, and that omission is invisible until someone needs it.
 * There are no collisions to disambiguate: each module underneath owns a disjoint set of names.
 *
 * **`request` is re-exported alongside {@link LighterRestClient} on purpose.** The facade object
 * references every one of the 78 routes, so importing it defeats per-route tree-shaking — an
 * accepted trade for the ergonomics, but only because the untraded path stays available.
 * Size-sensitive consumers import `request` and the two or three route entries they actually use
 * and never touch `./client.js`:
 *
 * ```ts
 * import { request, routes } from "lighter-ts/rest";
 * const books = await request(routes.orderBooks, { filter: "perp" }, { endpoint: "mainnet" });
 * ```
 *
 * Importing this file is inert — no socket, no timer, no global read, no `crypto.getRandomValues`
 * (which Cloudflare Workers forbids at module scope, `docs/decisions.md` D2). `route-types.js`
 * compiles to an empty module, `routes.js` builds one frozen-shaped literal of phantom types, and
 * neither `client.js` nor `paginate.js` nor `candles.js` runs anything at load. `"sideEffects":
 * false` is therefore truthful, and a test asserts it rather than trusting it.
 *
 * This is **not** the package root barrel. `src/index.ts` and `package.json` belong to the final
 * integration unit (`docs/decisions.md` D8) and are not touched from here.
 */

export * from "./candles.js";
export * from "./client.js";
export * from "./paginate.js";
export * from "./route-types.js";
export * from "./routes.js";
export * from "./transport.js";
