/**
 * Package identity, as literals.
 *
 * These are **not** read from `package.json` at runtime. There is no filesystem in a Cloudflare
 * Worker or a browser, a JSON import would need an import attribute that not every target supports,
 * and `package.json` is owned by the integration unit rather than by this one.
 *
 * The cost of a literal is that it can drift from the published version, so CI enforces the match
 * between {@link VERSION} and `package.json`'s `version` field. That check is the integration
 * unit's to write; this module only has to be honest about what it is.
 *
 * The REST transport composes its `User-Agent` from these where the environment permits it —
 * browsers forbid setting `User-Agent`, so it is runtime-conditional (`docs/decisions.md` D5).
 */

/** npm package name. */
export const NAME: string = "lighter-ts";

/** Package version. Kept in lockstep with `package.json` by a CI check owned by the integration unit. */
export const VERSION: string = "0.1.0";
