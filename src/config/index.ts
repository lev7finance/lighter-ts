/**
 * Public surface of `lighter-ts/config`.
 *
 * Re-exports only. Types and values are listed separately because `verbatimModuleSyntax` is on: a
 * type re-exported through a value `export {}` survives into the emitted JavaScript as an import of
 * something that does not exist at runtime.
 */

export type {
  EndpointProfile,
  ProfileMap,
  ProfileName,
} from "./endpoints.js";
export { defineProfile, getProfile, profiles } from "./endpoints.js";

export type {
  AuthProvider,
  Diagnostic,
  LighterConfig,
  ResolvedConfig,
  WebSocketConstructor,
  WebSocketLike,
} from "./config.js";
export { DEFAULT_TX_EXPIRY_MS, DEFAULT_USER_AGENT, isBrowserLike, resolveConfig } from "./config.js";
