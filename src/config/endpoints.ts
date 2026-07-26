/**
 * Endpoint profiles: the four (host, host, chain id) triples the SDK knows about.
 *
 * A profile binds the REST origin, the WebSocket URL **and the chain id** into one frozen object,
 * and that binding is the whole point of the module. The chain id is the first element of every
 * transaction hash (`docs/protocol-notes.md` §3.3) and is **not discoverable from any endpoint** —
 * `/systemConfig` does not carry it. So a chain id that travels separately from the base URLs makes
 * "sign for mainnet, post to testnet" a silent, unrecoverable failure: the sequencer sees a
 * perfectly-formed signature over a hash it will never reproduce, and the caller sees a rejection
 * that mentions neither chain nor host.
 *
 * Three consequences worth stating, because each one looks like an omission:
 *
 * 1. **`restBase` is an origin; `wsBase` is a full URL.** The asymmetry is deliberate. Every v1 REST
 *    route carries its own `/api/v1` prefix and exactly two operations (`GET /`, `GET /info`) sit at
 *    the origin root, so baking `/api/v1` into the base makes those two unreachable. The WebSocket
 *    endpoint, by contrast, is a single fixed URL with nothing to append.
 * 2. **No policy lives here.** Timeouts, retries and rate limits are per-caller decisions, not
 *    per-network facts; they live on {@link LighterConfig} in `./config.js`. The reference's
 *    `endpoint_profiles` carries exactly these four fields and that is the right shape.
 * 3. **The chain id is never inferred from a URL.** The reference sniffs it out of the base URL.
 *    A custom profile without an explicit `chainId` throws here rather than defaulting to 304.
 *
 * Nothing in this module runs at import time beyond freezing four object literals: no global is
 * read, no URL is parsed, no clock is called. `defineProfile` — which does parse URLs — is only ever
 * called from user code or from `resolveConfig`.
 */

import { LighterConfigError } from "../errors.js";

/**
 * A network the SDK can talk to.
 *
 * Exactly four fields, deliberately. See the module comment for why `restBase` and `wsBase` have
 * different shapes and why `chainId` is not optional.
 */
export interface EndpointProfile {
  /** Human-readable identity. Appears in diagnostics and error messages only. */
  readonly name: string;
  /** REST **origin**, no trailing slash and no `/api/v1` — routes carry their own prefix. */
  readonly restBase: string;
  /** Full WebSocket stream URL, no trailing slash. Nothing is appended to it. */
  readonly wsBase: string;
  /** Signing-domain parameter. First element of every transaction hash; never inferred. */
  readonly chainId: number;
}

/** The built-in profiles, keyed by name. */
export interface ProfileMap {
  readonly mainnet: EndpointProfile;
  readonly testnet: EndpointProfile;
  readonly robinhood: EndpointProfile;
  readonly robinhood_testnet: EndpointProfile;
}

/**
 * The four networks, frozen.
 *
 * `mainnet` is the default everywhere in the SDK.
 *
 * **`testnet` and `robinhood_testnet` genuinely share chain id 300.** That is an upstream fact, not
 * a transcription slip: signatures produced for one of those two environments are cross-valid on
 * the other. Do not "fix" it, and do not build a chainId → profile reverse lookup on top of these —
 * a chain id does not identify a profile.
 *
 * Written as frozen literals rather than routed through {@link defineProfile} on purpose: parsing a
 * URL at module scope would be work performed on import, and this package promises `sideEffects:
 * false`. The values are already normalised (no trailing slashes) and are asserted string-for-string
 * by `test/config/endpoints.test.ts`.
 */
export const profiles: ProfileMap = Object.freeze({
  mainnet: Object.freeze({
    name: "mainnet",
    restBase: "https://mainnet.zklighter.elliot.ai",
    wsBase: "wss://mainnet.zklighter.elliot.ai/stream",
    chainId: 304,
  }),
  testnet: Object.freeze({
    name: "testnet",
    restBase: "https://testnet.zklighter.elliot.ai",
    wsBase: "wss://testnet.zklighter.elliot.ai/stream",
    // 300 — shared with `robinhood_testnet` upstream. Intentional. See the doc comment above.
    chainId: 300,
  }),
  robinhood: Object.freeze({
    name: "robinhood",
    restBase: "https://api.rh.lighter.xyz",
    wsBase: "wss://api.rh.lighter.xyz/stream",
    chainId: 466324,
  }),
  robinhood_testnet: Object.freeze({
    name: "robinhood_testnet",
    restBase: "https://api.rh-testnet.lighter.xyz",
    wsBase: "wss://api.rh-testnet.lighter.xyz/stream",
    // 300 — the same chain id as `testnet`. Upstream fact, not a bug.
    chainId: 300,
  }),
});

/** Name of a built-in profile. */
export type ProfileName = keyof ProfileMap;

/** The built-in names, in a stable order, for error messages. */
const PROFILE_NAMES: readonly ProfileName[] = Object.freeze([
  "mainnet",
  "testnet",
  "robinhood",
  "robinhood_testnet",
] as const);

/** `"mainnet", "testnet", "robinhood", "robinhood_testnet"` — quoted, for error text. */
function knownProfileList(): string {
  return PROFILE_NAMES.map((n: ProfileName): string => `"${n}"`).join(", ");
}

/**
 * Look a built-in profile up by name.
 *
 * The parameter is typed to the four known names, but the runtime check stays: the value routinely
 * arrives from JSON, an environment variable, or plain JavaScript, where the type says nothing.
 *
 * @throws {LighterConfigError} if `name` is not one of the four.
 */
export function getProfile(name: ProfileName): EndpointProfile {
  const found: EndpointProfile | undefined = Object.prototype.hasOwnProperty.call(profiles, name)
    ? profiles[name]
    : undefined;
  if (found === undefined) {
    throw new LighterConfigError(
      `unknown endpoint profile ${JSON.stringify(name)}; expected one of ${knownProfileList()}, ` +
        `or pass a full { name, restBase, wsBase, chainId } object`,
    );
  }
  return found;
}

/** Drop every trailing `/` so `https://host/` and `https://host` behave identically. */
function stripTrailingSlashes(value: string): string {
  let end: number = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

/**
 * Parse and scheme-check a base URL, returning the normalised (slash-stripped) form.
 *
 * `new URL` is only reached from here, i.e. never at module scope.
 */
function normaliseBase(
  raw: unknown,
  field: "restBase" | "wsBase",
  schemes: readonly string[],
  profileName: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new LighterConfigError(
      `endpoint profile ${JSON.stringify(profileName)} needs a non-empty string ${field}`,
    );
  }
  const normalised: string = stripTrailingSlashes(raw);
  let parsed: URL;
  try {
    parsed = new URL(normalised);
  } catch (cause: unknown) {
    throw new LighterConfigError(
      `endpoint profile ${JSON.stringify(profileName)} has an unparseable ${field}: ${JSON.stringify(raw)}`,
      { cause },
    );
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new LighterConfigError(
      `endpoint profile ${JSON.stringify(profileName)} has ${field} ${JSON.stringify(raw)} with ` +
        `scheme "${parsed.protocol}"; expected ${schemes.map((s: string): string => `"${s}"`).join(" or ")}`,
    );
  }
  return normalised;
}

/**
 * Validate and normalise a caller-supplied profile, returning a frozen copy.
 *
 * - Trailing slashes are stripped from both URLs, so `https://host/` ≡ `https://host`.
 * - `restBase` must be `http:`/`https:`; `wsBase` must be `ws:`/`wss:`.
 * - `chainId` must be **present** and a non-negative safe integer. A missing chain id throws — it is
 *   a signing-domain parameter, and defaulting it to mainnet's 304 would produce signatures that
 *   look valid and are rejected by every other network.
 *
 * @throws {LighterConfigError} on any of the above.
 */
export function defineProfile(p: EndpointProfile): EndpointProfile {
  if (typeof p !== "object" || p === null) {
    throw new LighterConfigError("an endpoint profile must be an object with { name, restBase, wsBase, chainId }");
  }
  const name: unknown = p.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new LighterConfigError("an endpoint profile needs a non-empty string name");
  }
  const chainId: unknown = p.chainId;
  if (chainId === undefined || chainId === null) {
    throw new LighterConfigError(
      `endpoint profile ${JSON.stringify(name)} has no chainId. The chain id is an input to every ` +
        `transaction hash and cannot be discovered from the API or inferred from a URL, so a custom ` +
        `profile must state it explicitly (mainnet is 304, testnet is 300)`,
    );
  }
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId < 0) {
    throw new LighterConfigError(
      `endpoint profile ${JSON.stringify(name)} has a chainId that is not a non-negative integer: ${String(chainId)}`,
    );
  }

  return Object.freeze({
    name,
    restBase: normaliseBase(p.restBase, "restBase", ["http:", "https:"], name),
    wsBase: normaliseBase(p.wsBase, "wsBase", ["ws:", "wss:"], name),
    chainId,
  });
}
