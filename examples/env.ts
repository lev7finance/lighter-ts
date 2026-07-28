/**
 * Shared setup for every example in this directory: pick a network, read credentials, refuse to
 * touch mainnet by accident.
 *
 * - **What it does:** turns environment variables into a network selection and typed credentials.
 *   It is imported by the other examples; it is not runnable on its own.
 * - **Credentials:** none of its own. It reads them on behalf of its callers and names the exact
 *   variable that is missing.
 * - **Network:** whatever `LIGHTER_NETWORK` says. Testnet (chain id **300**) unless told otherwise;
 *   mainnet (**304**) additionally requires `LIGHTER_ALLOW_MAINNET=yes`.
 * - **Whether it moves real funds:** no. Nothing here performs I/O, signs anything, or reads a clock.
 *
 * ## Two rules this file exists to enforce once instead of eight times
 *
 * 1. **The chain id is configuration, never inference.** It is the first element of every
 *    transaction hash and is not discoverable from `/systemConfig` (`docs/protocol-notes.md` §7).
 *    {@link selectNetwork} states it explicitly and then checks it against the endpoint profile's
 *    own copy, so "sign for mainnet, post to testnet" cannot happen silently.
 * 2. **Nothing that can move money defaults to mainnet.** The default is testnet and the opt-in is
 *    a separate variable, because a typo in one variable should never be enough.
 *
 * `process.env` is used rather than a runtime-specific API: Node, Bun and Deno 2 all provide it,
 * and the one runtime that does not — Cloudflare Workers — gets its secrets from the `env` binding
 * instead (see `workers/signer-worker.ts`).
 */

import { getProfile, type ProfileName } from "lighter-ts/config";
import { CHAIN_ID } from "lighter-ts/tx";

/** The two networks these examples will talk to. `robinhood` is deliberately not offered here. */
export type NetworkName = "testnet" | "mainnet";

/** A network, as the SDK wants it: a profile name plus the signing domain, together. */
export interface Network {
  /** Passed to `new LighterClient({ endpoint })`. */
  readonly name: NetworkName & ProfileName;
  /** Passed to anything in `lighter-ts/tx` that hashes. 300 on testnet, 304 on mainnet. */
  readonly chainId: number;
}

/** `LIGHTER_ALLOW_MAINNET` must equal this before any example will target mainnet. */
const MAINNET_OPT_IN: "yes" = "yes";

/**
 * Resolve the target network from the environment.
 *
 * Defaults to testnet. Mainnet requires `LIGHTER_NETWORK=mainnet` **and**
 * `LIGHTER_ALLOW_MAINNET=yes`; one without the other is refused rather than downgraded, because a
 * silent downgrade is its own surprise.
 *
 * @throws {Error} for an unknown network name, or for mainnet without the opt-in.
 */
export function selectNetwork(): Network {
  const requested: string = process.env["LIGHTER_NETWORK"] ?? "testnet";
  if (requested !== "testnet" && requested !== "mainnet") {
    throw new Error(
      `LIGHTER_NETWORK must be "testnet" or "mainnet", received ${JSON.stringify(requested)}`,
    );
  }
  if (requested === "mainnet" && process.env["LIGHTER_ALLOW_MAINNET"] !== MAINNET_OPT_IN) {
    throw new Error(
      "refusing to run against mainnet: these examples place, modify and cancel real orders. " +
        `Set LIGHTER_ALLOW_MAINNET=${MAINNET_OPT_IN} if that is genuinely what you want.`,
    );
  }

  const chainId: number = requested === "mainnet" ? CHAIN_ID.mainnet : CHAIN_ID.testnet;

  // `src/tx/constants.ts` and `src/config/endpoints.ts` hold the chain ids independently and are
  // required to agree (they may not import each other). Checking it here costs nothing and turns a
  // future disagreement into a message instead of a signature no sequencer will accept.
  const profileChainId: number = getProfile(requested).chainId;
  if (profileChainId !== chainId) {
    throw new Error(
      `chain id disagreement for ${requested}: the endpoint profile says ${String(profileChainId)}, ` +
        `CHAIN_ID says ${String(chainId)}. Do not sign anything until this is resolved.`,
    );
  }

  return { name: requested, chainId };
}

/**
 * A required environment variable.
 *
 * @throws {Error} naming the variable and what it is for. Never prints the value — several of
 * these are secrets.
 */
export function requireEnv(name: string, purpose: string): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing environment variable ${name} — ${purpose}`);
  }
  return value;
}

/** An optional environment variable. Empty strings count as absent. */
export function optionalEnv(name: string): string | undefined {
  const value: string | undefined = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * A required non-negative integer environment variable.
 *
 * `number` is correct here and only here: these are **indices and counts**, not money
 * (`docs/decisions.md` D7). The digits are checked before parsing, so `Number.parseInt` can never
 * silently accept `"12abc"` or `"1e3"`.
 */
export function requireCount(name: string, purpose: string): number {
  const raw: string = requireEnv(name, purpose);
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative whole number, received ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

/** An optional non-negative integer, with a fallback. Same rules as {@link requireCount}. */
export function optionalCount(name: string, fallback: number): number {
  const raw: string | undefined = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative whole number, received ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * The signing account index, in both spellings the SDK needs.
 *
 * `bigint` for anything that gets hashed or signed; `number` for REST query parameters, where the
 * wire format is a JSON number and the domain (`<= 2^48 - 2`) is inside the safe-integer range.
 */
export function requireAccountIndex(): { readonly big: bigint; readonly num: number } {
  const raw: string = requireEnv(
    "LIGHTER_ACCOUNT_INDEX",
    "the account index these examples act on (an integer, e.g. 12345)",
  );
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `LIGHTER_ACCOUNT_INDEX must be a non-negative whole number, received ${JSON.stringify(raw)}`,
    );
  }
  return { big: BigInt(raw), num: Number.parseInt(raw, 10) };
}

/** The API key slot the examples sign with. `0` is the web app's slot; SDK users should use `>= 1`. */
export function requireApiKeyIndex(): number {
  const index: number = requireCount(
    "LIGHTER_API_KEY_INDEX",
    "the API key slot to sign with (0 is the web app's slot; use >= 1 for an SDK key)",
  );
  if (index > 254) {
    throw new Error("LIGHTER_API_KEY_INDEX must be in [0, 254]; 255 is the nil marker");
  }
  return index;
}

/**
 * The API private key, as hex.
 *
 * Read from the environment and never logged. The SDK's own errors carry lengths and reasons only,
 * never key bytes, so a parse failure is safe to print.
 */
export function requireApiPrivateKey(): string {
  return requireEnv(
    "LIGHTER_API_PRIVATE_KEY",
    "the Lighter API private key for LIGHTER_API_KEY_INDEX (40 bytes, 0x + 80 hex characters)",
  );
}

/** A market symbol, e.g. `ETH`. Defaults to `ETH`. */
export function marketSymbol(): string {
  return optionalEnv("LIGHTER_MARKET") ?? "ETH";
}

/** Lowercase hex of a byte string. Used only to print signatures and public keys. */
export function toHex(bytes: Uint8Array): string {
  let out: string = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Print an error the way these examples want it printed, and set a non-zero exit code.
 *
 * The one case worth special-casing is **code 20558**, the geo-restriction: it arrives as HTTP 400,
 * so it looks exactly like a validation error, and reads keep succeeding while every write fails
 * (`docs/protocol-notes.md` §8.3). Hours have been lost to that.
 */
export function reportFailure(error: unknown): void {
  process.exitCode = 1;
  const code: unknown =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)["code"]
      : undefined;
  if (code === 20558) {
    console.error(
      "\nAPI code 20558 — restricted jurisdiction.\n" +
        "  Public reads succeed from here; /sendTx and the WebSocket stream do not.\n" +
        "  This example cannot run from this location. It is a precondition, not a bug.\n",
    );
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (error instanceof Error && error.cause !== undefined) console.error("  caused by:", error.cause);
}
