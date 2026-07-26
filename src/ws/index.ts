/**
 * The `ws` barrel: every WebSocket module, re-exported and nothing else.
 *
 * Side-effect free at import, and provably so — each module underneath does its own work lazily
 * (`WsTransport`'s constructor opens no socket and reads no global; `channels` and `errors` freeze
 * literals and stop). Importing this file must never open a connection, read a clock, or call
 * `crypto.getRandomValues`, which Cloudflare Workers forbids outside a request
 * (`docs/decisions.md` D2).
 *
 * Star re-exports rather than a hand-maintained name list: a name added to a module and forgotten
 * here is a name the package does not ship, and that omission is invisible until someone needs it.
 * The one wrinkle is `LighterWsOverflowError`, which `./subscription.js` re-exports from
 * `./errors.js` — the same binding through two paths, which is not an ambiguous star export.
 *
 * This is not the package root barrel. `src/index.ts` belongs to the final integration unit
 * (`docs/decisions.md` D8) and is not touched from here.
 */

export * from "./account-assets-stream.js";
export * from "./backoff.js";
export * from "./channels.js";
export * from "./client.js";
export * from "./errors.js";
export * from "./protocol.js";
export * from "./ratelimit.js";
export * from "./subscription.js";
export * from "./transport.js";
export * from "./types.js";

// The transaction dispatcher and the order-book maintainer land after this unit and own their own
// files; their issues authorise uncommenting exactly the one line each.
export * from "./send-tx.js";
// TODO(ws-orderbook): export * from "./orderbook.js";
