/**
 * `src/client/auth-schedule.ts` — the 6-hour grid, the 8-hour lifetime, and the 2-hour overlap.
 *
 * The property this file exists to protect is not "four tokens per day"; it is **there is never an
 * instant inside the covered range at which `lookupToken` returns a token that is already expired**.
 * A schedule that spaced tokens at the same interval as their lifetime would satisfy every count
 * assertion and still hand out a token with zero seconds left at a boundary. So the central test
 * walks the whole covered range in small steps, parses the deadline back out of each token it is
 * given, and asserts the margin — which is the assertion that fails if the lifetime is ever changed
 * to match the spacing.
 *
 * Every token here is signed for real, so the deadlines being asserted are the deadlines that were
 * signed, not a re-derivation. Nothing touches the network; the clock is injected.
 */

import { describe, expect, test } from "bun:test";

import { ApiKey } from "../../src/crypto/key.js";
import { LighterValidationError } from "../../src/errors.js";
import { redact } from "../../src/util/redact.js";
import type { AuthTokenContext } from "../../src/client/auth-token.js";
import { authTokenMessageHash, createAuthToken } from "../../src/client/auth-token.js";
import {
  AUTH_TOKEN_BOUNDARY_SECONDS,
  type AuthTokenSchedule,
  READ_ONLY_API_KEY_INDEX,
  SCHEDULE_TOKEN_LIFETIME_SECONDS,
  TOKENS_PER_DAY,
  alignedBoundary,
  generateAuthTokenSchedule,
  lookupToken,
} from "../../src/client/auth-schedule.js";
import { verify } from "../../src/crypto/schnorr.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** `conformance/vectors/tx.json`'s signing key, recovered in `test/tx/pipeline.test.ts`. */
const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

const KEY: ApiKey = ApiKey.fromPrivateKey(KEY_HEX);

/** A moment deliberately **not** on a boundary: 1750000000 s is 1749988800 + 11200. */
const NOW_MS: number = 1_750_000_000_000;

function account(accountIndex: bigint = 42n, index: number = READ_ONLY_API_KEY_INDEX): AuthTokenContext {
  return {
    accountIndex,
    keys: new Map<number, ApiKey>([[index, KEY]]),
    now: (): number => NOW_MS,
  };
}

/** The deadline a token carries, read back out of the token itself. */
function deadlineOf(token: string): number {
  return Number(token.split(":")[0]);
}

/* ---------------------------------------------------------------------------------------------- */
/* 1. The grid                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

describe("alignedBoundary", () => {
  test("snaps to multiples of 21600", () => {
    expect(AUTH_TOKEN_BOUNDARY_SECONDS).toBe(21_600);
    for (const t of [0, 1, 21_599, 21_600, 21_601, 1_750_000_000, 1_749_984_000]) {
      const b: number = alignedBoundary(t);
      expect(b % AUTH_TOKEN_BOUNDARY_SECONDS).toBe(0);
      expect(b).toBeLessThanOrEqual(t);
      expect(t - b).toBeLessThan(AUTH_TOKEN_BOUNDARY_SECONDS);
    }
  });

  test("a boundary is its own boundary, and is idempotent", () => {
    expect(alignedBoundary(21_600)).toBe(21_600);
    expect(alignedBoundary(alignedBoundary(1_750_000_000))).toBe(alignedBoundary(1_750_000_000));
    expect(alignedBoundary(1_750_000_000)).toBe(1_749_988_800);
  });

  test("floors rather than truncates, so a pre-epoch instant lands in the bucket containing it", () => {
    // Truncation would give `-0`, a bucket that starts *after* the instant.
    expect(alignedBoundary(-1)).toBe(-21_600);
  });

  test("a non-finite timestamp is refused", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => alignedBoundary(bad)).toThrow(LighterValidationError);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 2. Generation                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("generateAuthTokenSchedule", () => {
  test("emits exactly four tokens per day, keyed by account then boundary", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 2 });
    expect(Object.keys(schedule)).toEqual(["42"]);
    const perAccount: Record<number, string> = schedule[42] as Record<number, string>;
    expect(Object.keys(perAccount)).toHaveLength(2 * TOKENS_PER_DAY);
    expect(Object.keys(perAccount)).toHaveLength(8);
  });

  test("the boundaries are consecutive multiples of 21600 starting at the current one", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 2 });
    const boundaries: number[] = Object.keys(schedule[42] as object)
      .map(Number)
      .sort((a: number, b: number): number => a - b);
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    expect(boundaries[0]).toBe(start);
    for (let i: number = 1; i < boundaries.length; i += 1) {
      expect((boundaries[i] as number) - (boundaries[i - 1] as number)).toBe(
        AUTH_TOKEN_BOUNDARY_SECONDS,
      );
    }
  });

  test("each token's deadline is its own boundary plus the 8-hour lifetime", () => {
    expect(SCHEDULE_TOKEN_LIFETIME_SECONDS).toBe(28_800);
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    for (const [boundary, token] of Object.entries(schedule[42] as object)) {
      expect(deadlineOf(token as string)).toBe(Number(boundary) + SCHEDULE_TOKEN_LIFETIME_SECONDS);
    }
  });

  test("adjacent windows overlap by exactly two hours", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const entries: [number, string][] = Object.entries(schedule[42] as object)
      .map(([b, t]: [string, unknown]): [number, string] => [Number(b), t as string])
      .sort((a: [number, string], b: [number, string]): number => a[0] - b[0]);
    for (let i: number = 1; i < entries.length; i += 1) {
      const previousDeadline: number = deadlineOf((entries[i - 1] as [number, string])[1]);
      const nextStart: number = (entries[i] as [number, string])[0];
      expect(previousDeadline - nextStart).toBe(
        SCHEDULE_TOKEN_LIFETIME_SECONDS - AUTH_TOKEN_BOUNDARY_SECONDS,
      );
      expect(previousDeadline - nextStart).toBe(7_200);
    }
  });

  test("every token in the schedule is a real signature by the scheduled key", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    for (const token of Object.values(schedule[42] as object)) {
      const text: string = token as string;
      const cut: number = text.lastIndexOf(":");
      const message: string = text.slice(0, cut);
      const signature: Uint8Array = Uint8Array.from(
        (text.slice(cut + 1).match(/../g) ?? []).map((b: string): number => Number.parseInt(b, 16)),
      );
      expect(message.split(":")[1]).toBe("42");
      expect(message.split(":")[2]).toBe(String(READ_ONLY_API_KEY_INDEX));
      expect(verify(KEY.publicKeyBytes, authTokenMessageHash(message), signature)).toBe(true);
    }
  });

  test("the api key index defaults to the account's first key, and 253 is opt-in", () => {
    // The convention is documented, not silently applied: an account whose only key is 1 must not
    // silently produce tokens claiming to be signed by 253.
    const ctx: AuthTokenContext = account(9n, 1);
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: ctx, days: 1 });
    const first: string = Object.values(schedule[9] as object)[0] as string;
    expect(first.split(":")[2]).toBe("1");
    expect(READ_ONLY_API_KEY_INDEX).toBe(253);
  });

  test("an injected `now` overrides the account's clock", () => {
    const later: number = NOW_MS + 5 * 86_400_000;
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({
      account: account(),
      days: 1,
      now: (): number => later,
    });
    expect(Object.keys(schedule[42] as object).map(Number)[0]).toBe(
      alignedBoundary(Math.floor(later / 1000)),
    );
  });

  test("regenerating the same schedule reproduces the same deadlines", () => {
    const a: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const b: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    expect(Object.keys(a[42] as object)).toEqual(Object.keys(b[42] as object));
    // The tokens themselves differ: the default nonce is hedged (`docs/decisions.md` D2).
    expect(Object.values(a[42] as object)).not.toEqual(Object.values(b[42] as object));
  });

  test("a lifetime above the auth-token cap is refused, so a schedule cannot exempt itself", () => {
    expect(() =>
      generateAuthTokenSchedule({ account: account(), days: 1, lifetimeSeconds: 28_801 }),
    ).toThrow(LighterValidationError);
  });

  test("days must be a whole number in range", () => {
    for (const bad of [0, -1, 1.5, 367, Number.NaN]) {
      expect(() => generateAuthTokenSchedule({ account: account(), days: bad })).toThrow(
        LighterValidationError,
      );
    }
  });

  test("an account index that cannot survive as a number key is refused", () => {
    expect(() =>
      generateAuthTokenSchedule({ account: account(-1n), days: 1 }),
    ).toThrow(LighterValidationError);
    expect(() =>
      generateAuthTokenSchedule({ account: account(9_007_199_254_740_993n), days: 1 }),
    ).toThrow(LighterValidationError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 3. Lookup — the property that matters                                                            */
/* ---------------------------------------------------------------------------------------------- */

describe("lookupToken", () => {
  test("every instant in the covered range yields a token whose deadline is still ahead", () => {
    const days: number = 3;
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days });
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    const end: number = start + days * TOKENS_PER_DAY * AUTH_TOKEN_BOUNDARY_SECONDS;

    // 900-second steps: fine enough to land just before, on, and just after every boundary.
    let checked: number = 0;
    for (let t: number = start; t < end; t += 900) {
      const token: string | undefined = lookupToken(schedule, 42, t);
      expect(token).toBeDefined();
      const remaining: number = deadlineOf(token as string) - t;
      expect(remaining).toBeGreaterThan(0);
      // The overlap guarantee: never less than 2 hours of validity left.
      expect(remaining).toBeGreaterThanOrEqual(
        SCHEDULE_TOKEN_LIFETIME_SECONDS - AUTH_TOKEN_BOUNDARY_SECONDS,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });

  test("the boundary instants themselves are covered", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    for (let i: number = 0; i < TOKENS_PER_DAY; i += 1) {
      const b: number = start + i * AUTH_TOKEN_BOUNDARY_SECONDS;
      expect(lookupToken(schedule, 42, b)).toBeDefined();
      expect(lookupToken(schedule, 42, b + AUTH_TOKEN_BOUNDARY_SECONDS - 1)).toBeDefined();
    }
  });

  test("outside the range, and for an unknown account, the answer is undefined", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    expect(lookupToken(schedule, 42, start - 1)).toBeUndefined();
    expect(lookupToken(schedule, 42, start + 86_400)).toBeUndefined();
    expect(lookupToken(schedule, 43, start)).toBeUndefined();
  });

  test("a bigint account index looks up the same entry as its number twin", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    expect(lookupToken(schedule, 42n, start)).toBe(lookupToken(schedule, 42, start) as string);
  });

  test("the token found is byte-identical to the stored one, not a re-derivation", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const start: number = alignedBoundary(Math.floor(NOW_MS / 1000));
    expect(lookupToken(schedule, 42, start + 5)).toBe(
      (schedule[42] as Record<number, string>)[start] as string,
    );
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 4. Secrets                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("redaction", () => {
  test("a schedule passed through redact() carries no token", () => {
    const schedule: AuthTokenSchedule = generateAuthTokenSchedule({ account: account(), days: 1 });
    const tokens: string[] = Object.values(schedule[42] as object) as string[];
    const scrubbed: string = JSON.stringify(redact({ schedule }));
    for (const token of tokens) {
      expect(scrubbed).not.toContain(token);
      expect(scrubbed).not.toContain(token.split(":")[3] as string);
    }
  });

  test("no private key leaks through a scheduled token", () => {
    const token: string = createAuthToken(account(), { timestamp: 1_750_000_000 });
    expect(token).not.toContain(KEY_HEX);
    expect(token).not.toContain(KEY.privateKeyHex.slice(2));
  });
});
