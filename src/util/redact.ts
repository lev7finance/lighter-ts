/**
 * Secret redaction for anything that leaves the SDK as a diagnostic — error payloads, log lines,
 * request/response hooks.
 *
 * Two independent mechanisms, both required:
 *
 * 1. **Key-based.** Any object property (or header, or `Map` key, or query parameter) whose name
 *    matches the mandated list is replaced wholesale, case-insensitively.
 * 2. **Value-shaped.** Every string that survives key-based redaction is scanned for the two
 *    credential shapes that can appear in free text: a Lighter auth token
 *    (`<deadline>:<accountIndex>:<apiKeyIndex>:<160 hex>`) and a 40-byte private-key hex
 *    (`0x` + exactly 80 hex characters).
 *
 * Deliberately *not* done: blanket redaction of long hex runs. Message hashes, public keys and
 * signatures show up in legitimate diagnostics, and redacting them makes bug reports useless.
 *
 * This module must never import `../errors.js` — `errors.ts` imports *this*, and the reverse edge
 * would be a cycle. When redaction cannot proceed it returns {@link REDACTED} rather than throwing.
 *
 * No Node built-ins, no I/O, no clock, no globals mutated.
 */

/** The replacement marker substituted for every redacted value. */
export const REDACTED: "[redacted]" = "[redacted]";

/**
 * Property / parameter / header names whose values are secrets. Stored lowercase; lookups
 * lowercase the candidate, which makes the match case-insensitive and covers the camelCase twins
 * of the snake_case wire names.
 *
 * The first five are mandated by `spec/08-extras-and-dx.md` §A′10; the rest are the camelCase
 * spellings our own models use plus the obvious generic names.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  "api_token",
  "apitoken",
  "auth",
  "authorization",
  "signature",
  "sig",
  "private_key",
  "privatekey",
  "privatekeyhex",
  "secret",
  "token",
]);

/**
 * A Lighter auth token in free text: three decimal fields then an 80-byte signature as hex.
 * See `docs/protocol-notes.md` §6. The trailing lookahead stops a longer hex run from being
 * partially matched (and partially left in the clear).
 */
const AUTH_TOKEN_RE: RegExp = /\d+:\d+:\d+:[0-9a-fA-F]{160}(?![0-9a-fA-F])/g;

/** A 40-byte scalar as `0x` + exactly 80 hex characters — the shape of an L2 private key. */
const PRIVATE_KEY_HEX_RE: RegExp = /0[xX][0-9a-fA-F]{80}(?![0-9a-fA-F])/g;

/** `[redacted]` after `URL` percent-encodes it into a query value. */
const ENCODED_REDACTED: string = "%5Bredacted%5D";

/** `?key=value` / `&key=value` pairs, for the non-absolute-URL fallback path. */
const QUERY_PAIR_RE: RegExp = /([?&])([^=&#?]+)=([^&#]*)/g;

/** True when a property, header, or query-parameter name names a secret. */
function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/**
 * Replace credential-shaped substrings inside a free-text string.
 *
 * Key-based redaction cannot help here: the token is embedded in a message such as
 * `"invalid auth: expired token 1750000000:1:0:<160 hex>"`.
 */
export function redactString(s: string): string {
  if (s.length === 0) return s;
  let out: string = s;
  if (out.includes(":")) out = out.replace(AUTH_TOKEN_RE, REDACTED);
  if (out.includes("0x") || out.includes("0X")) out = out.replace(PRIVATE_KEY_HEX_RE, REDACTED);
  return out;
}

/** Replace the values of secret-named query parameters in a string that is not a parseable URL. */
function redactQueryPairs(s: string): string {
  return s.replace(QUERY_PAIR_RE, (match: string, sep: string, key: string): string => {
    let decoded: string = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* a malformed escape is not a reason to give up on the rest of the string */
    }
    return isSecretKey(decoded) ? `${sep}${key}=${REDACTED}` : match;
  });
}

/**
 * Strip credential values out of a URL while preserving everything else.
 *
 * The Lighter API accepts an auth token in the `auth` **query parameter**
 * (`docs/protocol-notes.md` §8.1.1), so URLs are a first-class leak channel.
 */
export function redactUrl(u: string): string {
  try {
    const url: URL = new URL(u);
    const params: URLSearchParams = url.searchParams;
    for (const key of [...params.keys()]) {
      if (isSecretKey(key)) params.set(key, REDACTED);
    }
    return redactString(url.toString().split(ENCODED_REDACTED).join(REDACTED));
  } catch {
    // Relative path, template string, or otherwise not an absolute URL.
    return redactString(redactQueryPairs(u));
  }
}

/** Read a property without letting a throwing getter take down the whole redaction. */
function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return REDACTED;
  }
}

/** `Object.prototype.toString` brand — realm-independent, unlike `instanceof`. */
function brandOf(value: object): string {
  return Object.prototype.toString.call(value);
}

function redactObjectEntries(
  source: object,
  keys: readonly string[],
  seen: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(readProperty(source, key), seen);
  }
  return out;
}

function redactErrorLike(source: object, seen: Set<object>): Record<string, unknown> {
  const err: Error = source as Error;
  const out: Record<string, unknown> = {
    name: typeof err.name === "string" ? err.name : String(err.name),
    // `message` is an own, non-enumerable property, so `Object.keys` never reaches it.
    message: redactString(typeof err.message === "string" ? err.message : String(err.message)),
  };
  for (const key of Object.keys(err)) {
    // `stack` is excluded on purpose: it is noisy, environment-specific, and can quote source
    // text containing a credential.
    if (key === "stack" || key === "name" || key === "message") continue;
    out[key] = isSecretKey(key) ? REDACTED : redactValue(readProperty(err, key), seen);
  }
  const cause: unknown = readProperty(err, "cause");
  if (cause !== undefined) out["cause"] = redactValue(cause, seen);
  return out;
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "function") return REDACTED;
  if (typeof value !== "object" || value === null) return value;

  const obj: object = value;
  // A cycle, not merely a repeated reference: `seen` is a path, popped on the way out.
  if (seen.has(obj)) return REDACTED;

  const brand: string = brandOf(obj);

  // Leaves: nothing to walk into, and walking would produce garbage.
  if (brand === "[object Date]") return obj;
  if (brand === "[object RegExp]") return String(obj);
  if (brand === "[object URL]") return redactUrl(String(obj));
  // Binary leaves — typed arrays and views. Walking them yields index-keyed garbage. Duck-typed on
  // `byteLength` so the source stays clear of the CI grep gate for Node-only identifiers.
  if (typeof (obj as { byteLength?: unknown }).byteLength === "number") return obj;

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const arr: readonly unknown[] = obj as readonly unknown[];
      const out: unknown[] = new Array<unknown>(arr.length);
      for (let i = 0; i < arr.length; i += 1) out[i] = redactValue(arr[i], seen);
      return out;
    }

    if (brand === "[object Headers]") {
      const out: Record<string, unknown> = {};
      (obj as Headers).forEach((headerValue: string, headerName: string): void => {
        out[headerName] = isSecretKey(headerName) ? REDACTED : redactString(headerValue);
      });
      return out;
    }

    if (brand === "[object Map]") {
      const out: Record<string, unknown> = {};
      for (const [rawKey, mapValue] of obj as Map<unknown, unknown>) {
        const key: string = typeof rawKey === "string" ? rawKey : String(rawKey);
        out[key] = isSecretKey(key) ? REDACTED : redactValue(mapValue, seen);
      }
      return out;
    }

    if (brand === "[object Set]") {
      const out: unknown[] = [];
      for (const member of obj as Set<unknown>) out.push(redactValue(member, seen));
      return out;
    }

    if (brand === "[object Error]") return redactErrorLike(obj, seen);

    return redactObjectEntries(obj, Object.keys(obj), seen);
  } finally {
    seen.delete(obj);
  }
}

/**
 * Deep-redact an arbitrary value.
 *
 * - Returns a **new** structure; the input is never mutated.
 * - Cycle-safe. A back-reference becomes {@link REDACTED} rather than throwing or looping.
 * - Primitives other than strings pass through unchanged, `bigint` included — there is no
 *   `JSON.parse`/`stringify` round trip here, because that throws on `bigint` and loses `Headers`.
 * - `Headers`, `URL`, `Error`, `Map` and `Set` are converted to plain structures.
 * - Never throws: on any internal failure the whole value collapses to {@link REDACTED}, because
 *   a diagnostic helper that can fail is worse than one that says nothing.
 */
export function redact<T>(value: T): unknown {
  try {
    return redactValue(value, new Set<object>());
  } catch {
    return REDACTED;
  }
}
