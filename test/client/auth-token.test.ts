/**
 * `src/client/auth-token.ts` — the token format, byte for byte.
 *
 * The load-bearing assertions are the three `conformance/vectors/tx.json` → `authTokens` rows,
 * replayed with `k` pinned from `nonceKLeHex`. Every intermediate the reference exposes is compared
 * separately — the UTF-8 bytes, the packed field elements as decimal strings, the 40-byte message
 * hash, the 80-byte signature and the final token — because a single end-to-end comparison tells
 * you a token is wrong without telling you where, and the four ways to get this format wrong
 * (endianness, tail padding, unit of the deadline, hex case) each fail at a different intermediate.
 *
 * Row 3 is the one that matters most: `"1750000000:140737488355327:254"` is 30 bytes, so it packs
 * to **four** elements and exercises both the multi-chunk path and the zero-padded tail. A
 * two-element message cannot distinguish "pad the tail" from "size the tail to what is left".
 *
 * Nothing here touches the network or the clock unless the clock is injected.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { P } from "../../src/crypto/field/constants.js";
import type { Fp } from "../../src/crypto/field/fp.js";
import { ApiKey } from "../../src/crypto/key.js";
import { scalarFromBytes } from "../../src/crypto/scalar.js";
import { LighterConfigError, LighterValidationError } from "../../src/errors.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "../../src/util/bytes.js";
import { redact } from "../../src/util/redact.js";
import {
  type AuthTokenContext,
  DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS,
  MAX_AUTH_TOKEN_LIFETIME_SECONDS,
  assertAuthTokenLifetime,
  authTokenMessage,
  authTokenMessageHash,
  createAuthToken,
  defaultAuthKeyIndex,
  packAuthMessage,
} from "../../src/client/auth-token.js";

/* ---------------------------------------------------------------------------------------------- */
/* Vectors                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface AuthTokenRow {
  readonly deadline: string;
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly message: string;
  readonly messageUtf8Hex: string;
  readonly packedFieldElements: readonly string[];
  readonly messageHashLeHex: string;
  readonly nonceKLeHex: string;
  readonly signatureBytesHex: string;
  readonly token: string;
}

const vectorsUrl: URL = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly authTokens: readonly AuthTokenRow[];
};

/**
 * The signing key behind every signature in `tx.json`, recovered in `test/tx/pipeline.test.ts` and
 * written out there rather than derived, so this file inherits an assertion rather than a
 * tautology.
 */
const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

const KEY: ApiKey = ApiKey.fromPrivateKey(KEY_HEX);

/** A context over one key at one index. No clock, no transport — a token needs neither. */
function ctxFor(accountIndex: bigint, apiKeyIndex: number, nowMs?: number): AuthTokenContext {
  return {
    accountIndex,
    keys: new Map<number, ApiKey>([[apiKeyIndex, KEY]]),
    ...(nowMs !== undefined ? { now: (): number => nowMs } : {}),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* 1. The vector gate                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("authTokens conformance rows", () => {
  test("the file carries all three rows, including the four-element one", () => {
    expect(vectors.authTokens).toHaveLength(3);
    const widest: AuthTokenRow = vectors.authTokens[2] as AuthTokenRow;
    expect(widest.message).toBe("1750000000:140737488355327:254");
    expect(widest.packedFieldElements).toHaveLength(4);
  });

  for (const row of vectors.authTokens) {
    describe(row.message, () => {
      const accountIndex: bigint = BigInt(row.accountIndex);
      const apiKeyIndex: number = Number(row.apiKeyIndex);
      const deadline: bigint = BigInt(row.deadline);

      test("message renders exactly, and its UTF-8 bytes match", () => {
        const message: string = authTokenMessage(deadline, accountIndex, apiKeyIndex);
        expect(message).toBe(row.message);
        expect(bytesToHex(utf8ToBytes(message))).toBe(row.messageUtf8Hex);
      });

      test("packs to the pinned field elements, little-endian, tail zero-padded", () => {
        const elements: readonly Fp[] = packAuthMessage(utf8ToBytes(row.message));
        expect(elements.map((e: Fp): string => e.toString(10))).toEqual([
          ...row.packedFieldElements,
        ]);
        // The count is the padding assertion: 30 bytes must be four elements, not three-and-a-bit.
        expect(elements).toHaveLength(Math.ceil(row.message.length / 8));
      });

      test("hashes to the pinned 40-byte little-endian digest", () => {
        expect(bytesToHex(authTokenMessageHash(row.message))).toBe(row.messageHashLeHex);
      });

      test("signs to the pinned bytes with k pinned, and assembles the pinned token", () => {
        const token: string = createAuthToken(ctxFor(accountIndex, apiKeyIndex), {
          timestamp: 0,
          // `deadline = timestamp + expirySeconds`, so a zero timestamp makes the expiry the deadline.
          expirySeconds: Number(deadline),
          maxLifetimeSeconds: Number(deadline),
          apiKeyIndex,
          sign: { nonce: scalarFromBytes(hexToBytes(row.nonceKLeHex)) },
        });
        expect(token).toBe(row.token);

        // And the pieces, so a failure names which one moved.
        const fields: readonly string[] = token.split(":");
        expect(fields).toHaveLength(4);
        expect(fields.slice(0, 3).join(":")).toBe(row.message);
        expect(fields[3]).toBe(row.signatureBytesHex);
      });
    });
  }

  test("the signature hex is lowercase and carries no 0x", () => {
    const row: AuthTokenRow = vectors.authTokens[0] as AuthTokenRow;
    const hex: string = row.token.slice(row.message.length + 1);
    expect(hex).toMatch(/^[0-9a-f]{160}$/);
    expect(hex.startsWith("0x")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 2. Packing                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("packAuthMessage", () => {
  test("errors rather than reducing a chunk >= p", () => {
    // `p = 2^64 − 2^32 + 1`. Little-endian bytes of exactly `p` — the smallest non-canonical word.
    const atModulus: Uint8Array = new Uint8Array(8);
    new DataView(atModulus.buffer).setBigUint64(0, P, true);

    expect(() => packAuthMessage(atModulus)).toThrow(LighterValidationError);
    try {
      packAuthMessage(atModulus);
      throw new Error("unreachable");
    } catch (error: unknown) {
      expect((error as LighterValidationError).code).toBe("AUTH_TOKEN_FIELD_NOT_CANONICAL");
    }

    // And `p − 1` is fine, so the boundary is exactly where it should be.
    const belowModulus: Uint8Array = new Uint8Array(8);
    new DataView(belowModulus.buffer).setBigUint64(0, P - 1n, true);
    expect(packAuthMessage(belowModulus).map((e: Fp): bigint => e)).toEqual([P - 1n as Fp]);
  });

  test("the offending chunk is identified by index, and its bytes never appear", () => {
    const bytes: Uint8Array = new Uint8Array(24);
    // Chunks 0 and 1 are zero; chunk 2 is `2^64 − 1`, comfortably above `p`.
    bytes.fill(0xff, 16, 24);
    try {
      packAuthMessage(bytes);
      throw new Error("unreachable");
    } catch (error: unknown) {
      const message: string = (error as Error).message;
      expect(message).toContain("element 2");
      expect(message).not.toContain("ffffffff");
    }
  });

  test("packs little-endian, and the tail is zero-padded rather than truncated", () => {
    // "17500000" — the first chunk of vector row 1, whose little-endian reading is pinned.
    const eight: readonly Fp[] = packAuthMessage(utf8ToBytes("17500000"));
    expect(eight.map(String)).toEqual(["3472328296228009777"]);

    // One byte, padded: `0x41` little-endian in a full 8-byte word is 65, not 0x4100000000000000.
    expect(packAuthMessage(utf8ToBytes("A")).map(String)).toEqual(["65"]);

    // Nine bytes are two elements, not one-and-an-eighth.
    expect(packAuthMessage(new Uint8Array(9))).toHaveLength(2);
    expect(packAuthMessage(new Uint8Array(0))).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 3. Lifetimes and units                                                                           */
/* ---------------------------------------------------------------------------------------------- */

describe("lifetime validation", () => {
  test("the cap is 8 hours and the default lifetime is 10 minutes", () => {
    expect(MAX_AUTH_TOKEN_LIFETIME_SECONDS).toBe(28_800);
    expect(DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS).toBe(600);
  });

  test("exactly the cap passes; one second more throws", () => {
    expect(() => assertAuthTokenLifetime(MAX_AUTH_TOKEN_LIFETIME_SECONDS)).not.toThrow();
    expect(() => assertAuthTokenLifetime(MAX_AUTH_TOKEN_LIFETIME_SECONDS + 1)).toThrow(
      LighterValidationError,
    );
  });

  test("a configured cap is honoured in both directions", () => {
    expect(() => assertAuthTokenLifetime(600, 600)).not.toThrow();
    expect(() => assertAuthTokenLifetime(601, 600)).toThrow(LighterValidationError);
  });

  test("zero, negative and fractional lifetimes are refused", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertAuthTokenLifetime(bad)).toThrow(LighterValidationError);
    }
  });

  test("an over-cap lifetime throws before anything is signed", () => {
    let signs: number = 0;
    const counting: AuthTokenContext = {
      accountIndex: 1n,
      keys: new Map<number, ApiKey>([
        [
          0,
          new Proxy(KEY, {
            get(target: ApiKey, prop: string | symbol, receiver: unknown): unknown {
              if (prop === "sign") {
                return (...args: unknown[]): unknown => {
                  signs += 1;
                  return (target.sign as (...a: unknown[]) => unknown).apply(target, args);
                };
              }
              return Reflect.get(target, prop, receiver) as unknown;
            },
          }),
        ],
      ]),
    };
    expect(() =>
      createAuthToken(counting, { expirySeconds: MAX_AUTH_TOKEN_LIFETIME_SECONDS + 1 }),
    ).toThrow(LighterValidationError);
    expect(signs).toBe(0);
  });

  test("a millisecond timestamp is refused rather than signed", () => {
    // `Date.now()`-shaped input. Nothing in the payload marks the unit, so this is the only place
    // the mistake is catchable locally (risk R11).
    expect(() => createAuthToken(ctxFor(1n, 0), { timestamp: 1_750_000_000_000 })).toThrow(
      LighterValidationError,
    );
    // The same instant in seconds is fine.
    expect(() => createAuthToken(ctxFor(1n, 0), { timestamp: 1_750_000_000 })).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 4. Defaults and key selection                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("createAuthToken defaults", () => {
  test("the deadline is now + 600 s, read from the injected clock in milliseconds", () => {
    const token: string = createAuthToken(ctxFor(7n, 2, 1_750_000_000_500));
    expect(token.startsWith(`${String(1_750_000_000 + 600)}:7:2:`)).toBe(true);
  });

  test("the clock is floored to whole seconds, never rounded", () => {
    // 999 ms past the second: a rounding clock would produce a deadline one second later.
    const token: string = createAuthToken(ctxFor(1n, 0, 1_750_000_000_999));
    expect(token.split(":")[0]).toBe("1750000600");
  });

  test("the default api key index is the first configured one", () => {
    const ctx: AuthTokenContext = {
      accountIndex: 3n,
      keys: new Map<number, ApiKey>([
        [5, KEY],
        [1, KEY],
      ]),
      now: (): number => 1_750_000_000_000,
    };
    expect(defaultAuthKeyIndex(ctx)).toBe(5);
    expect(createAuthToken(ctx).startsWith("1750000600:3:5:")).toBe(true);
  });

  test("an unconfigured key index is a config error naming indices, never key material", () => {
    try {
      createAuthToken(ctxFor(1n, 0), { apiKeyIndex: 4 });
      throw new Error("unreachable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LighterConfigError);
      expect((error as Error).message).toContain("[0]");
      expect((error as Error).message).not.toContain(KEY_HEX);
    }
  });

  test("an api key index outside [0, 254] is refused", () => {
    for (const bad of [-1, 255, 256, 1.5]) {
      expect(() => createAuthToken(ctxFor(1n, 0), { apiKeyIndex: bad })).toThrow(
        LighterValidationError,
      );
    }
  });

  test("an account with no keys refuses rather than defaulting to zero", () => {
    expect(() =>
      createAuthToken({ accountIndex: 1n, keys: new Map<number, ApiKey>() }),
    ).toThrow(LighterConfigError);
  });

  test("two tokens for the same message differ, because the default nonce is hedged", () => {
    const ctx: AuthTokenContext = ctxFor(1n, 0, 1_750_000_000_000);
    const a: string = createAuthToken(ctx);
    const b: string = createAuthToken(ctx);
    expect(a.split(":").slice(0, 3)).toEqual(b.split(":").slice(0, 3));
    expect(a).not.toBe(b);
  });

  test("a large account index renders in full decimal, never in exponent form", () => {
    const token: string = createAuthToken(
      { accountIndex: 281_474_976_710_655n, keys: new Map<number, ApiKey>([[0, KEY]]) },
      { timestamp: 1_750_000_000 },
    );
    expect(token.split(":")[1]).toBe("281474976710655");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 5. Secrets                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("redaction", () => {
  test("a token embedded in a diagnostic is redacted, and no error quotes a private key", () => {
    const token: string = createAuthToken(ctxFor(1n, 0, 1_750_000_000_000));
    const scrubbed: unknown = redact({ note: `authorization failed for ${token}`, auth: token });
    expect(JSON.stringify(scrubbed)).not.toContain(token);
    expect(JSON.stringify(scrubbed)).not.toContain(token.split(":")[3] as string);

    // Every error this module raises: none of them may quote the key.
    const errors: readonly unknown[] = [
      catchOf(() => createAuthToken(ctxFor(1n, 0), { expirySeconds: 1_000_000 })),
      catchOf(() => createAuthToken(ctxFor(1n, 0), { apiKeyIndex: 9 })),
      catchOf(() => createAuthToken(ctxFor(1n, 0), { timestamp: Date.now() })),
      catchOf(() => packAuthMessage(new Uint8Array(8).fill(0xff))),
    ];
    for (const error of errors) {
      const projected: string = JSON.stringify((error as { toJSON(): unknown }).toJSON());
      expect(projected).not.toContain(KEY_HEX);
      expect(projected).not.toContain(KEY.privateKeyHex.slice(2));
    }
  });
});

/** Run `fn`, returning whatever it threw. Fails loudly if it did not throw. */
function catchOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a throw");
}
