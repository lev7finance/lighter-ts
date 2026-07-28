/**
 * JSON that survives 64-bit integers.
 *
 * `JSON.parse` produces IEEE-754 doubles, so every integer above 2^53 is silently rounded to a
 * nearby value. That is exactly where this protocol lives: `order_index`, `trade_id`,
 * `transaction_time`, `nonce` and `offset` are all 64-bit. `9007199254740993` parses as
 * `9007199254740992`, and nothing anywhere reports a problem.
 *
 * A `JSON.parse` reviver cannot fix it. By the time a reviver runs it is handed the already-parsed
 * `number` — the digits are gone. The repair has to happen on the **raw text**, before the parser
 * ever sees it, which is what {@link parseFrameJson} does.
 *
 * This module contains two independent things that must never be confused:
 *
 * - {@link parseFrameJson} — inbound, on the REST and WebSocket read paths.
 * - {@link stableStringify} — outbound, for **diagnostics, cache keys and digests only**.
 *
 * **{@link stableStringify} is not the `tx_info` serialiser.** Transaction serialisation is
 * schema-ordered (`src/tx/serialize.ts`) and hand-rolled because `JSON.stringify` throws on
 * `bigint`. Sorted keys produce a different byte string, so wiring this function onto the signing
 * path would have every transaction rejected by the sequencer while the local test suite stays
 * green. If you are reaching for a serialiser and the bytes are going to be signed, this is the
 * wrong file.
 *
 * No I/O, no timers, no globals mutated.
 */

import { LighterValidationError } from "../errors.js";

/**
 * Keys whose values are 64-bit integers on the wire and must not pass through a double.
 *
 * Deliberately **not** trimmed on the theory that the `_str` twin already covers them: `nonce`,
 * `offset`, `transaction_time` and `last_updated_at` have no string twin at all. Where a `_str`
 * field does exist (`trade_id_str`, `ask_id_str`, …) it remains canonical — this set exists so the
 * numeric field is still usable rather than quietly wrong.
 */
export const DEFAULT_BIGINT_FIELDS: ReadonlySet<string> = new Set<string>([
  "nonce",
  "begin_nonce",
  "offset",
  "transaction_time",
  "last_updated_at",
  "trade_id",
  "ask_id",
  "bid_id",
  "ask_client_id",
  "bid_client_id",
  "order_index",
  "client_order_index",
]);

/**
 * Any run of 16 or more digits anywhere in the text. 2^53 has 16 digits, so a shorter run is
 * always exactly representable and the frame needs no work at all.
 *
 * No `g` flag: a global regular expression carries `lastIndex` between `test` calls and would
 * alternate true/false across frames.
 */
const LONG_DIGIT_RUN: RegExp = /\d{16,}/;

/** Smallest digit count that can exceed 2^53 (`9007199254740992`). */
const UNSAFE_DIGITS: 16 = 16;

const QUOTE: 0x22 = 0x22;
const BACKSLASH: 0x5c = 0x5c;
const COLON: 0x3a = 0x3a;
const MINUS: 0x2d = 0x2d;
const DOT: 0x2e = 0x2e;
const LOWER_E: 0x65 = 0x65;
const UPPER_E: 0x45 = 0x45;

/**
 * `JSON.parse`, with unquoted 64-bit integer literals rewritten to JSON strings first.
 *
 * Only the value of a key listed in `bigIntFields` is rewritten, only when that value is a bare
 * (unquoted) integer token of {@link UNSAFE_DIGITS} digits or more, and only when it is a genuine
 * integer — a token followed by `.`, `e` or `E` is left alone. Everything else in the text,
 * including digit runs inside string values and the values of unlisted keys, comes out
 * byte-identical.
 *
 * That precision is the whole point. A global `/(\d{16,})/g` replacement over the raw text corrupts
 * frames: it quotes digit runs inside string literals (a memo, a URL, an already-stringified `_str`
 * field) and inside keys nobody asked for, turning valid data into a different shape at random.
 *
 * The rewritten values arrive as **strings**, not `bigint` — a JSON document has no `bigint`. The
 * caller converts with `BigInt(...)` where it wants one.
 *
 * The common case costs one regular-expression scan and no rewriting.
 */
export function parseFrameJson(
  text: string,
  bigIntFields: ReadonlySet<string> = DEFAULT_BIGINT_FIELDS,
): unknown {
  if (bigIntFields.size === 0 || !LONG_DIGIT_RUN.test(text)) {
    return JSON.parse(text) as unknown;
  }
  return JSON.parse(quoteWideIntegers(text, bigIntFields)) as unknown;
}

/**
 * Single left-to-right pass over the raw text.
 *
 * The scanner only ever needs to recognise two things: string tokens (so a `"` inside a string is
 * not mistaken for the start of one) and the `key : value` position. Nothing else about JSON
 * structure matters here, and `JSON.parse` still does the real validation afterwards.
 */
function quoteWideIntegers(text: string, fields: ReadonlySet<string>): string {
  const length: number = text.length;
  let out: string = "";
  let copied: number = 0; // everything before this index is already accounted for in `out`
  let i: number = 0;

  while (i < length) {
    if (text.charCodeAt(i) !== QUOTE) {
      i += 1;
      continue;
    }

    const tokenStart: number = i;
    i = skipStringToken(text, i);

    // A string token is a key only when the next non-whitespace character is a colon.
    let j: number = i;
    while (j < length && isWhitespace(text.charCodeAt(j))) j += 1;
    if (j >= length || text.charCodeAt(j) !== COLON) continue;

    j += 1; // past the colon
    while (j < length && isWhitespace(text.charCodeAt(j))) j += 1;

    if (fields.has(keyNameOf(text.slice(tokenStart, i)))) {
      const valueEnd: number = wideIntegerEnd(text, j);
      if (valueEnd > j) {
        out += text.slice(copied, j) + '"' + text.slice(j, valueEnd) + '"';
        copied = valueEnd;
        i = valueEnd;
        continue;
      }
    }
    i = j; // resume at the value, which may itself be a string
  }

  return out + text.slice(copied);
}

/** Index just past the closing quote of the string token starting at `start`. */
function skipStringToken(text: string, start: number): number {
  const length: number = text.length;
  let i: number = start + 1;
  while (i < length) {
    const code: number = text.charCodeAt(i);
    if (code === BACKSLASH) {
      i += 2;
      continue;
    }
    if (code === QUOTE) return i + 1;
    i += 1;
  }
  return length; // unterminated; `JSON.parse` will report it properly
}

/** The key name, unescaped. `quoted` includes both quote characters. */
function keyNameOf(quoted: string): string {
  if (!quoted.includes("\\")) return quoted.slice(1, quoted.length - 1);
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return quoted;
  }
}

/**
 * End index of a bare integer token at `start` with at least {@link UNSAFE_DIGITS} digits, or
 * `start` when there is nothing to rewrite (a quoted value, a short integer, a fraction, an
 * exponent, `null`, an object, …).
 */
function wideIntegerEnd(text: string, start: number): number {
  const length: number = text.length;
  let i: number = start;
  if (i < length && text.charCodeAt(i) === MINUS) i += 1;
  const digitsStart: number = i;
  while (i < length && isDigit(text.charCodeAt(i))) i += 1;
  if (i - digitsStart < UNSAFE_DIGITS) return start;
  if (i < length) {
    const next: number = text.charCodeAt(i);
    // A fraction or an exponent is not an integer, and quoting it would change its meaning.
    if (next === DOT || next === LOWER_E || next === UPPER_E) return start;
  }
  return i;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** The four JSON whitespace characters: space, tab, newline, carriage return. */
function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Deterministic JSON text: object keys in ascending code-unit order, `bigint` as an unquoted
 * decimal literal.
 *
 * For diagnostics, cache keys and digests — anywhere two structurally equal values must produce the
 * same string. **Not** the transaction serialiser; see the module comment.
 *
 * Strict by construction, because a silent substitution in a cache key is a collision:
 *
 * - a cycle, a function, a symbol or a top-level `undefined` throws;
 * - a non-finite number throws rather than becoming `null`;
 * - anything that is not a primitive, a plain object or an array throws — `Uint8Array`, `Map`,
 *   `Set`, `Date`, a class instance. Encode bytes with `bytesToHex` and pass the string.
 *
 * `undefined` inside a container follows `JSON.stringify`: an object property is dropped, an array
 * element becomes `null`. `toJSON` methods are never consulted.
 */
export function stableStringify(value: unknown): string {
  return writeValue(value, []);
}

function writeValue(value: unknown, ancestors: unknown[]): string {
  if (value === null) return "null";

  const type: string = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "bigint") return (value as bigint).toString();
  if (type === "number") {
    // `Number.isFinite` is a type predicate on a caller-supplied value, not arithmetic on money.
    if (!Number.isFinite(value as number)) {
      throw new LighterValidationError(
        "NOT_SERIALIZABLE",
        "stableStringify received a non-finite number, which has no JSON representation",
      );
    }
    return JSON.stringify(value);
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    throw new LighterValidationError(
      "NOT_SERIALIZABLE",
      `stableStringify cannot serialise a value of type ${type}`,
    );
  }

  if (ancestors.includes(value)) {
    throw new LighterValidationError(
      "CYCLE_DETECTED",
      "stableStringify received a value that contains a cycle",
    );
  }
  ancestors.push(value);

  let out: string;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const element of value as readonly unknown[]) {
      parts.push(element === undefined ? "null" : writeValue(element, ancestors));
    }
    out = "[" + parts.join(",") + "]";
  } else if (Object.prototype.toString.call(value) === "[object Object]") {
    const record: Record<string, unknown> = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const property: unknown = record[key];
      if (property === undefined) continue; // matches `JSON.stringify`
      parts.push(JSON.stringify(key) + ":" + writeValue(property, ancestors));
    }
    out = "{" + parts.join(",") + "}";
  } else {
    throw new LighterValidationError(
      "NOT_SERIALIZABLE",
      `stableStringify cannot serialise ${describe(value)}; convert it to a primitive first`,
    );
  }

  ancestors.pop();
  return out;
}

/** A short, safe type name for an error message. Never the value itself. */
function describe(value: unknown): string {
  const tag: string = Object.prototype.toString.call(value); // "[object Uint8Array]"
  return tag.slice(8, tag.length - 1);
}
