/**
 * Pre-generated auth tokens — read-only access with **no private key at request time**.
 *
 * This is the pattern that makes authenticated reads possible on Cloudflare Workers, in a browser,
 * or anywhere else a private key must not live: sign a batch of tokens once, somewhere trusted,
 * ship the resulting table, and look one up by the clock. Nothing at request time signs anything.
 *
 * ## The schedule, and why the windows overlap
 *
 * One token per **6-hour aligned boundary** (`floor(t / 21600) * 21600`) with an **8-hour**
 * lifetime — the reference's read-only workflow, reproduced (`spec/07-high-level-client.md` §7.5,
 * `docs/protocol-notes.md` §6). Four tokens per day per account.
 *
 * ```text
 * boundary:   00:00        06:00        12:00        18:00
 * token A:    |==================== 8h ====|
 * token B:                 |==================== 8h ====|
 * token C:                              |==================== 8h ====|
 * ```
 *
 * The two extra hours are the point. A lookup keyed by the *current* boundary always lands on a
 * token with at least six hours left, so clock skew between the caller and the server, a request
 * issued microseconds before a boundary, and a retry that straddles one are all covered by
 * construction rather than by a "is it nearly expired?" check that would itself be racy.
 *
 * ## The read-only key
 *
 * The convention is to dedicate one API key index — **253** ({@link READ_ONLY_API_KEY_INDEX}) — to
 * read-only token generation, and to configure that key on nothing else. Two consequences worth
 * stating plainly:
 *
 * - **Rotating key 253 invalidates every pre-generated token at once.** That is the revocation
 *   mechanism, and it is the only one: a token that has been handed out cannot be recalled
 *   individually, and it stays valid until its deadline passes.
 * - The default here is the account's *first configured* key, not 253, because silently falling
 *   back to a different key than the caller believes is signing is worse than an explicit choice.
 *   Pass `apiKeyIndex: READ_ONLY_API_KEY_INDEX` to follow the convention.
 *
 * A schedule is a table of bearer credentials. Treat the whole object as secret: store it where a
 * private key would go, never in a log or an error payload. `redactString` in `src/util/redact.ts`
 * recognises a token's shape in free text as a backstop.
 *
 * No module-scope state, no clock read at import, no I/O.
 */

import { LighterValidationError } from "../errors.js";
import type { SignOptions } from "../crypto/key.js";
import {
  type AuthTokenContext,
  MAX_AUTH_TOKEN_LIFETIME_SECONDS,
  createAuthToken,
} from "./auth-token.js";

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The alignment grid: 6 hours, in seconds. Tokens are keyed by a multiple of this. */
export const AUTH_TOKEN_BOUNDARY_SECONDS: 21_600 = 21_600;

/**
 * Each scheduled token's lifetime: 8 hours, in seconds.
 *
 * Two hours longer than the boundary spacing, which is what makes consecutive windows overlap. It
 * is also exactly {@link MAX_AUTH_TOKEN_LIFETIME_SECONDS}, so a schedule sits at the documented
 * ceiling — see that constant for why the real server bound is an open question.
 */
export const SCHEDULE_TOKEN_LIFETIME_SECONDS: 28_800 = MAX_AUTH_TOKEN_LIFETIME_SECONDS;

/** Tokens per day: `86400 / 21600`. */
export const TOKENS_PER_DAY: 4 = 4;

/**
 * The conventional API key index for read-only token generation.
 *
 * Not a default — see the module header. `0` belongs to the web app, maker-only restriction lists
 * need `>= 4`, and `255` is the nil marker.
 */
export const READ_ONLY_API_KEY_INDEX: 253 = 253;

/** A ceiling on `days`, so a typo cannot ask for a million Schnorr signatures. */
const MAX_SCHEDULE_DAYS: 366 = 366;

/* ---------------------------------------------------------------------------------------------- */
/* Types                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `accountIndex → alignedTimestamp → token`.
 *
 * A plain nested record so it round-trips through `JSON.stringify` into KV, a Durable Object, or a
 * build artifact without a codec. Both key levels are decimal integers.
 */
export type AuthTokenSchedule = Record<number, Record<number, string>>;

/** What {@link generateAuthTokenSchedule} accepts. */
export interface AuthTokenScheduleOptions {
  /** The account to sign for. One call covers one account; merge the results for several. */
  readonly account: AuthTokenContext;
  /** How many days to cover, from the current boundary forward. `days * 4` tokens are produced. */
  readonly days: number;
  /** Which key signs. Default: the account's first configured key. See {@link READ_ONLY_API_KEY_INDEX}. */
  readonly apiKeyIndex?: number;
  /** Injected clock, **milliseconds**, like `Date.now`. Overrides `account.now`. */
  readonly now?: () => number;
  /** Per-token lifetime in seconds. Default {@link SCHEDULE_TOKEN_LIFETIME_SECONDS} (8 h). */
  readonly lifetimeSeconds?: number;
  /** Passed to the signer; `{ nonce: k }` pins the Schnorr nonce for vectors. */
  readonly sign?: SignOptions;
}

/* ---------------------------------------------------------------------------------------------- */
/* The grid                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Snap a unix timestamp in **seconds** down to its 6-hour boundary: `floor(t / 21600) * 21600`.
 *
 * `Math.floor`, not truncation: they differ for negative inputs, and a truncating version would
 * snap a pre-epoch instant *upward* into a bucket that does not contain it. The result is always a
 * multiple of {@link AUTH_TOKEN_BOUNDARY_SECONDS} and is always `<= unixSeconds`.
 *
 * @throws {LighterValidationError} `AUTH_TOKEN_TIMESTAMP_INVALID` if the input is not a finite number.
 */
export function alignedBoundary(unixSeconds: number): number {
  if (!Number.isFinite(unixSeconds)) {
    throw new LighterValidationError(
      "AUTH_TOKEN_TIMESTAMP_INVALID",
      `an aligned boundary needs a finite unix timestamp in seconds, received ${String(unixSeconds)}`,
      { field: "deadline" },
    );
  }
  return Math.floor(unixSeconds / AUTH_TOKEN_BOUNDARY_SECONDS) * AUTH_TOKEN_BOUNDARY_SECONDS;
}

/* ---------------------------------------------------------------------------------------------- */
/* Generation                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Sign `days * 4` tokens for one account, keyed by aligned boundary.
 *
 * Coverage runs from `alignedBoundary(now)` to that boundary plus `days` — the current partial
 * window counts as one of the four, which is what makes "generate for tomorrow" mean "I am covered
 * from right now until this time tomorrow" rather than leaving a hole until the next midnight.
 *
 * Each token's `timestamp` is its own boundary, so `token(b)` has deadline `b + lifetime` and the
 * result is a pure function of `(boundary, accountIndex, apiKeyIndex, key)` — regenerating the same
 * schedule twice produces the same deadlines, and, with a pinned `k`, the same bytes.
 *
 * Cost is one Schnorr signature per token — roughly 2–3 ms each on a desktop engine
 * (`docs/decisions.md` D4). A year is 1464 signatures, a few seconds. There is no I/O.
 *
 * @throws {LighterValidationError} for a non-integer or out-of-range `days`, or an account index
 * that is not a safe integer (it becomes an object key here, so it must survive as a `number`).
 * @throws {LighterConfigError} if the requested key is not configured on the account.
 */
export function generateAuthTokenSchedule(o: AuthTokenScheduleOptions): AuthTokenSchedule {
  if (!Number.isInteger(o.days) || o.days <= 0 || o.days > MAX_SCHEDULE_DAYS) {
    throw new LighterValidationError(
      "AUTH_TOKEN_SCHEDULE_INVALID",
      `an auth token schedule covers a whole number of days in [1, ${String(MAX_SCHEDULE_DAYS)}], ` +
        `received ${String(o.days)}`,
      { field: "days", bound: MAX_SCHEDULE_DAYS },
    );
  }

  const accountIndex: bigint = o.account.accountIndex;
  if (accountIndex < 0n || accountIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LighterValidationError(
      "AUTH_TOKEN_SCHEDULE_INVALID",
      `an account index used as a schedule key must be a non-negative safe integer, received ` +
        `${accountIndex.toString(10)}`,
      { field: "account_index" },
    );
  }

  const nowMs: number = (o.now ?? o.account.now ?? Date.now)();
  const start: number = alignedBoundary(Math.floor(nowMs / 1000));
  const lifetimeSeconds: number = o.lifetimeSeconds ?? SCHEDULE_TOKEN_LIFETIME_SECONDS;
  const count: number = o.days * TOKENS_PER_DAY;

  const tokens: Record<number, string> = {};
  for (let i: number = 0; i < count; i += 1) {
    const boundary: number = start + i * AUTH_TOKEN_BOUNDARY_SECONDS;
    tokens[boundary] = createAuthToken(o.account, {
      timestamp: boundary,
      expirySeconds: lifetimeSeconds,
      // `maxLifetimeSeconds` is deliberately not widened here: a schedule that wants a lifetime
      // above the cap must say so through `lifetimeSeconds` and be refused, not be exempted.
      ...(o.apiKeyIndex !== undefined ? { apiKeyIndex: o.apiKeyIndex } : {}),
      ...(o.sign !== undefined ? { sign: o.sign } : {}),
    });
  }

  return { [Number(accountIndex)]: tokens };
}

/* ---------------------------------------------------------------------------------------------- */
/* Lookup                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The token covering `nowSeconds`, or `undefined` if the schedule has run out.
 *
 * A single object lookup by the current aligned boundary — no scan, no deadline arithmetic, no
 * clock read of its own. `undefined` means the schedule needs regenerating; it never means "the
 * token expired", because a token found here always has at least
 * `SCHEDULE_TOKEN_LIFETIME_SECONDS - AUTH_TOKEN_BOUNDARY_SECONDS` (2 h) of validity left.
 *
 * The returned string is a bearer credential. Put it in the `Authorization` header, not the `auth`
 * query parameter (`docs/protocol-notes.md` §8.1.1).
 */
export function lookupToken(
  schedule: AuthTokenSchedule,
  accountIndex: number | bigint,
  nowSeconds: number,
): string | undefined {
  const perAccount: Record<number, string> | undefined = schedule[Number(accountIndex)];
  if (perAccount === undefined) return undefined;
  return perAccount[alignedBoundary(nowSeconds)];
}
