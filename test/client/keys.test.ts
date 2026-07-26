/**
 * `src/client/keys.ts` — generation, the `check_client` equivalent, and `ChangePubKey`.
 *
 * Three things here are counted rather than shaped, because the shape is identical whether the
 * behaviour is right or wrong:
 *
 * 1. **Requests.** "A matching key set costs exactly one request" and "a mismatch costs exactly one
 *    refetch" are the whole contract of the cache. A test that only asserts the throw passes
 *    against an implementation that refetches in a loop.
 * 2. **Cache invalidations.** The invalidate-then-retry is what prevents a rotation that landed a
 *    second ago from being reported as a misconfigured key, and it is invisible from the outside.
 * 3. **`crypto.getRandomValues` at import time.** Cloudflare Workers refuses a module-scope draw and
 *    the package fails to *load* — so the assertion is made against a freshly imported copy of the
 *    module with the CSPRNG wrapped, not against the already-loaded one.
 *
 * The `ChangePubKey` assertions are byte-level against `conformance/vectors/tx.json` → `l1Messages`:
 * the L1 message the SDK produces for `{accountIndex: 1, apiKeyIndex: 0, nonce: 20, pubKey}` is
 * compared to the pinned body character for character, and the L2 signature that reaches the wire is
 * verified against the **new** public key and asserted not to verify against the old one.
 *
 * Nothing here touches the network: `fetch` is injected into a real `LighterRestClient`, so the real
 * form encoder, success rule and error classifier all run.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { ApiKey } from "../../src/crypto/key.js";
import { verify } from "../../src/crypto/schnorr.js";
import {
  L1SignatureRequiredError,
  LighterConfigError,
  LighterValidationError,
} from "../../src/errors.js";
import type { AccountApiKeys } from "../../src/models/account.js";
import { LighterRestClient } from "../../src/rest/client.js";
import { i64, u8 } from "../../src/tx/brands.js";
import type { UnsignedTx } from "../../src/tx/build.js";
import { buildChangePubKey } from "../../src/tx/build.js";
import { TxType } from "../../src/tx/enums.js";
import { txHash } from "../../src/tx/pipeline.js";
import type { ChangePubKeyTx } from "../../src/tx/types/account.js";
import { base64ToBytes, bytesToHex } from "../../src/util/bytes.js";
import { redact } from "../../src/util/redact.js";
import { createLease } from "../../src/client/nonce/types.js";
import type {
  NonceLease,
  NonceSnapshot,
  NonceSource,
  NonceSourceKind,
} from "../../src/client/nonce/types.js";
import {
  ApiKeyCache,
  type ChangeApiKeyResult,
  type KeysContext,
  type KeysTransport,
  areKeysEqual,
  changeApiKey,
  createApiKey,
  verifyKeys,
} from "../../src/client/keys.js";

/* ---------------------------------------------------------------------------------------------- */
/* Vectors and fixtures                                                                             */
/* ---------------------------------------------------------------------------------------------- */

interface L1MessageRow {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

const vectorsUrl: URL = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly l1Messages: readonly L1MessageRow[];
};

const CHAIN_ID: number = vectors.chainId;

/** The `change_pub_key` row: `{accountIndex: 1, apiKeyIndex: 0, nonce: 20, pubKey: 0x2386…}`. */
const CHANGE_PUB_KEY_ROW: L1MessageRow = vectors.l1Messages.find(
  (r: L1MessageRow): boolean => r.name === "change_pub_key",
) as L1MessageRow;

/** `conformance/vectors/tx.json`'s signing key, recovered in `test/tx/pipeline.test.ts`. */
const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

const KEY: ApiKey = ApiKey.fromPrivateKey(KEY_HEX);

/** A second, unrelated key — the "currently configured" one in the rotation tests. */
const OTHER_KEY: ApiKey = ApiKey.fromPrivateKey(
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728",
);

/** A 65-byte `r ‖ s ‖ v` signature. Its contents are never inspected: this package verifies no L1. */
const L1_SIG: `0x${string}` = `0x${"ab".repeat(64)}1b` as `0x${string}`;

/** The vector's expected registered public key, without a prefix, as the server would return it. */
const REGISTERED_PUBLIC_KEY: string = CHANGE_PUB_KEY_ROW.fields["PubKeyLeHex"] as string;

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

interface FakeHttp {
  readonly rest: KeysTransport;
  readonly calls: Call[];
  countOf(path: string): number;
}

/** A `LighterRestClient` over an injected `fetch`. A path with no answer is a test bug, not a 404. */
function fakeHttp(respond: (call: Call, index: number) => { status?: number; body: unknown }): FakeHttp {
  const calls: Call[] = [];
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url: URL = new URL(String(input));
    const call: Call = {
      path: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : url.search,
    };
    calls.push(call);
    const answer: { status?: number; body: unknown } = respond(call, calls.length - 1);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    calls,
    countOf: (path: string): number => calls.filter((c: Call): boolean => c.path === path).length,
    rest: new LighterRestClient({
      endpoint: "mainnet",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }) as unknown as KeysTransport,
  };
}

/** The minimum `NonceSource` the submit path's type requires. Nothing here leases. */
class StubNonceSource implements NonceSource {
  readonly kind: NonceSourceKind = "optimistic";
  resyncs: number = 0;

  lease(preferKey?: number): Promise<NonceLease> {
    return Promise.resolve(
      createLease({
        apiKeyIndex: preferKey ?? 0,
        nonce: 0n,
        onRelease: (): void => {
          /* no mutex to release */
        },
      }),
    );
  }

  resync(_apiKeyIndex: number): Promise<void> {
    this.resyncs += 1;
    return Promise.resolve();
  }

  snapshot(): NonceSnapshot {
    return { version: 1, kind: this.kind, accountIndex: 1, keys: [] };
  }

  restore(_s: NonceSnapshot): void {
    /* nothing to restore */
  }
}

function contextOver(http: FakeHttp, overrides: Partial<KeysContext> = {}): KeysContext {
  return {
    chainId: CHAIN_ID,
    accountIndex: 1n,
    rest: http.rest,
    nonces: new StubNonceSource(),
    keys: new Map<number, ApiKey>([[0, KEY]]),
    channel: "http",
    // Instant, so the settle wait costs the suite nothing.
    sleep: (): Promise<void> => Promise.resolve(),
    ...overrides,
  };
}

const PATH_APIKEYS: string = "/api/v1/apikeys";
const PATH_SEND_TX: string = "/api/v1/sendTx";

/** An `apikeys` body registering `publicKey` at `index`. */
function apikeysBody(index: number, publicKey: string): AccountApiKeys {
  return {
    code: 200,
    api_keys: [
      { account_index: 1, api_key_index: index, nonce: 20, public_key: publicKey, transaction_time: 0 },
    ],
  };
}

/** A `sendTx` acceptance. */
function acceptedSendTx(): { body: unknown } {
  return { body: { code: 200, predicted_execution_time_ms: 120, volume_quota_remaining: 9_000 } };
}

/* ---------------------------------------------------------------------------------------------- */
/* 1. createApiKey                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("createApiKey", () => {
  test("returns 0x-prefixed 40-byte hex for both halves", () => {
    const key = createApiKey();
    expect(key.privateKeyHex).toMatch(/^0x[0-9a-f]{80}$/);
    expect(key.publicKeyHex).toMatch(/^0x[0-9a-f]{80}$/);
  });

  test("two calls return different keys", () => {
    const a = createApiKey();
    const b = createApiKey();
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  test("the public key is the one the private key derives", () => {
    const key = createApiKey();
    expect(ApiKey.fromPrivateKey(key.privateKeyHex).publicKeyHex).toBe(key.publicKeyHex);
  });

  test("importing the module draws no randomness; calling it does", async () => {
    const realCrypto: Crypto = globalThis.crypto;
    const realDraw: typeof realCrypto.getRandomValues = realCrypto.getRandomValues.bind(realCrypto);
    let draws: number = 0;
    const spy = <T extends ArrayBufferView | null>(array: T): T => {
      draws += 1;
      return realDraw(array as unknown as Uint8Array) as unknown as T;
    };
    Object.defineProperty(globalThis, "crypto", {
      value: { ...realCrypto, getRandomValues: spy, subtle: realCrypto.subtle },
      configurable: true,
      writable: true,
    });
    try {
      // A cache-busted specifier forces a fresh module instance, so module-scope code runs again.
      // The specifier is built at run time: a literal would be resolved statically by the compiler,
      // which cannot see a query string on a relative path.
      const specifier: string = "../../src/client/keys.js?module-scope-probe";
      const fresh = (await import(specifier)) as {
        createApiKey: () => { privateKeyHex: string };
      };
      expect(draws).toBe(0);
      fresh.createApiKey();
      expect(draws).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: realCrypto,
        configurable: true,
        writable: true,
      });
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 2. areKeysEqual                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

describe("areKeysEqual", () => {
  test("0x-insensitive and case-insensitive", () => {
    expect(areKeysEqual("0xAB12", "ab12")).toBe(true);
    expect(areKeysEqual("ab12", "0XAB12")).toBe(true);
    expect(areKeysEqual("0xab12", "0xab12")).toBe(true);
  });

  test("a one-character difference is false", () => {
    expect(areKeysEqual("0xAB12", "ab13")).toBe(false);
    expect(areKeysEqual(REGISTERED_PUBLIC_KEY, `${REGISTERED_PUBLIC_KEY.slice(0, -1)}0`)).toBe(false);
  });

  test("the server's prefix-free key matches this SDK's prefixed one", () => {
    expect(areKeysEqual(REGISTERED_PUBLIC_KEY, KEY.publicKeyHex)).toBe(true);
    // The failure this guards: a raw === on the two spellings.
    expect(REGISTERED_PUBLIC_KEY === KEY.publicKeyHex).toBe(false);
  });

  test("empty strings never match, so an unregistered slot cannot satisfy a comparison", () => {
    expect(areKeysEqual("", "")).toBe(false);
    expect(areKeysEqual("0x", "")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 3. verifyKeys                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("verifyKeys", () => {
  test("a matching key set passes with exactly one request", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, REGISTERED_PUBLIC_KEY),
    }));
    const cache: ApiKeyCache = new ApiKeyCache();
    await verifyKeys(contextOver(http, { keyCache: cache }));
    expect(http.countOf(PATH_APIKEYS)).toBe(1);
    expect(cache.invalidations).toBe(0);
  });

  test("the fetch asks for the nil marker, so the whole key set comes back", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, REGISTERED_PUBLIC_KEY),
    }));
    await verifyKeys(contextOver(http));
    expect(http.calls[0]?.body).toContain("api_key_index=255");
  });

  test("a warm cache costs no request at all", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, REGISTERED_PUBLIC_KEY),
    }));
    const cache: ApiKeyCache = new ApiKeyCache();
    const ctx: KeysContext = contextOver(http, { keyCache: cache });
    await verifyKeys(ctx);
    await verifyKeys(ctx);
    expect(http.countOf(PATH_APIKEYS)).toBe(1);
  });

  test("a mismatch invalidates once and refetches once before throwing", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, OTHER_KEY.publicKeyHex.slice(2)),
    }));
    const cache: ApiKeyCache = new ApiKeyCache();
    await expect(verifyKeys(contextOver(http, { keyCache: cache }))).rejects.toThrow(
      LighterConfigError,
    );
    expect(cache.invalidations).toBe(1);
    expect(http.countOf(PATH_APIKEYS)).toBe(2);
  });

  test("a successful refetch after a mismatch passes without throwing", async () => {
    // The rotation-just-landed case: the first read is stale, the second is current.
    const http: FakeHttp = fakeHttp((_call: Call, index: number): { body: unknown } => ({
      body:
        index === 0
          ? apikeysBody(0, OTHER_KEY.publicKeyHex.slice(2))
          : apikeysBody(0, REGISTERED_PUBLIC_KEY),
    }));
    const cache: ApiKeyCache = new ApiKeyCache();
    await verifyKeys(contextOver(http, { keyCache: cache }));
    expect(cache.invalidations).toBe(1);
    expect(http.countOf(PATH_APIKEYS)).toBe(2);
  });

  test("a stale cache alone never fails: the retry reads through it", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, REGISTERED_PUBLIC_KEY),
    }));
    const cache: ApiKeyCache = new ApiKeyCache();
    cache.set(1n, [{ account_index: 1, api_key_index: 0, public_key: "deadbeef" }]);
    await verifyKeys(contextOver(http, { keyCache: cache }));
    expect(http.countOf(PATH_APIKEYS)).toBe(1);
    expect(cache.invalidations).toBe(1);
  });

  test("a slot the server does not know about is a mismatch, not a pass", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200, api_keys: [] } }));
    await expect(verifyKeys(contextOver(http))).rejects.toThrow(LighterConfigError);
  });

  test("the error names the offending index and never any key material", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(3, OTHER_KEY.publicKeyHex.slice(2)),
    }));
    const ctx: KeysContext = contextOver(http, { keys: new Map<number, ApiKey>([[3, KEY]]) });
    try {
      await verifyKeys(ctx);
      throw new Error("unreachable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LighterConfigError);
      const projected: string = JSON.stringify((error as LighterConfigError).toJSON());
      expect(projected).toContain("3");
      expect(projected).not.toContain(KEY_HEX);
      expect(projected).not.toContain(KEY.privateKeyHex.slice(2));
    }
  });

  test("an account with no keys refuses rather than passing vacuously", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200, api_keys: [] } }));
    await expect(
      verifyKeys(contextOver(http, { keys: new Map<number, ApiKey>() })),
    ).rejects.toThrow(LighterConfigError);
    expect(http.countOf(PATH_APIKEYS)).toBe(0);
  });

  test("two caches do not see each other's key sets", () => {
    const a: ApiKeyCache = new ApiKeyCache();
    const b: ApiKeyCache = new ApiKeyCache();
    a.set(1n, [{ api_key_index: 0, public_key: "aa" }]);
    expect(b.get(1n)).toBeUndefined();
    a.invalidate(1n);
    expect(a.get(1n)).toBeUndefined();
    expect(b.invalidations).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 4. changeApiKey — the L1 seam                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("changeApiKey without an L1 signer", () => {
  test("throws L1SignatureRequiredError carrying the pinned message and txType 8", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => {
      throw new Error("no request should be made before the L1 refusal");
    });
    try {
      await changeApiKey(contextOver(http), {
        apiKeyIndex: 0,
        privateKey: KEY_HEX,
        nonce: 20n,
      });
      throw new Error("unreachable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(L1SignatureRequiredError);
      const e: L1SignatureRequiredError = error as L1SignatureRequiredError;
      expect(e.message).toBe(CHANGE_PUB_KEY_ROW.body);
      expect(e.template).toBe(CHANGE_PUB_KEY_ROW.body);
      expect(e.txType).toBe(8);
      expect(e.txType).toBe(TxType.L2ChangePubKey);
    }
    // The refusal is local: nothing was sent, and the explicit nonce meant nothing was read.
    expect(http.calls).toHaveLength(0);
  });

  test("the pinned body is the one the vector records, including the pubkey and the hex16 fields", () => {
    expect(CHANGE_PUB_KEY_ROW.body).toContain(`pubkey: 0x${REGISTERED_PUBLIC_KEY}`);
    expect(CHANGE_PUB_KEY_ROW.body).toContain("nonce: 0x0000000000000014");
    expect(CHANGE_PUB_KEY_ROW.body).toContain("api key index: 0x0000000000000000");
  });

  test("an api key index outside [0, 254] is refused before any key is generated", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: {} }));
    for (const bad of [-1, 255, 300, 1.5]) {
      await expect(changeApiKey(contextOver(http), { apiKeyIndex: bad })).rejects.toThrow(
        LighterValidationError,
      );
    }
    expect(http.calls).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 5. changeApiKey — the full flow                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** Pull the base64 `Sig` and `PubKey` out of a submitted `tx_info` document. */
function submittedTx(call: Call): { sig: Uint8Array; pubKey: Uint8Array; txInfo: string } {
  const params: URLSearchParams = new URLSearchParams(call.body);
  const txInfo: string = params.get("tx_info") as string;
  const doc = JSON.parse(txInfo) as { Sig: string; PubKey: string };
  return { sig: base64ToBytes(doc.Sig), pubKey: base64ToBytes(doc.PubKey), txInfo };
}

describe("changeApiKey with an injected signer", () => {
  test("signs with the NEW key, not the account's existing one, and verifies locally first", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } => {
      if (call.path === PATH_SEND_TX) return acceptedSendTx();
      return { body: apikeysBody(1, KEY.publicKeyHex.slice(2)) };
    });
    // The account currently signs with `OTHER_KEY` at index 0; it is registering `KEY` at index 1.
    const ctx: KeysContext = contextOver(http, {
      keys: new Map<number, ApiKey>([[0, OTHER_KEY]]),
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });

    const receipt: ChangeApiKeyResult = await changeApiKey(ctx, {
      apiKeyIndex: 1,
      privateKey: KEY_HEX,
      nonce: 20n,
      settleMs: 0,
    });

    expect(receipt.publicKeyHex).toBe(KEY.publicKeyHex);
    expect(receipt.privateKeyHex).toBe(KEY.privateKeyHex);
    expect(receipt.apiKeyIndex).toBe(1);
    expect(receipt.txType).toBe(TxType.L2ChangePubKey);

    const send: Call = http.calls.find((c: Call): boolean => c.path === PATH_SEND_TX) as Call;
    const { sig, pubKey } = submittedTx(send);

    // The registered public key is the new one, on the wire.
    expect(bytesToHex(pubKey)).toBe(KEY.publicKeyHex.slice(2));

    // Rebuild the exact transaction and check who signed it.
    const expected: ChangePubKeyTx = buildChangePubKey(
      { pubKey: KEY.publicKeyBytes },
      { accountIndex: i64(1n), apiKeyIndex: u8(1), nonce: i64(20n), expiredAt: i64(0n) },
    );
    const doc = JSON.parse(submittedTx(send).txInfo) as { ExpiredAt: number };
    const rebuilt: UnsignedTx = Object.freeze({
      ...(expected as object),
      expiredAt: i64(BigInt(doc.ExpiredAt)),
      l1Sig: L1_SIG,
    }) as unknown as UnsignedTx;
    const digest: Uint8Array = txHash(rebuilt, CHAIN_ID);

    expect(verify(KEY.publicKeyBytes, digest, sig)).toBe(true);
    expect(verify(OTHER_KEY.publicKeyBytes, digest, sig)).toBe(false);
  });

  test("the L1 message handed to the signer is the pinned body", async () => {
    const seen: string[] = [];
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX ? acceptedSendTx() : { body: apikeysBody(0, REGISTERED_PUBLIC_KEY) },
    );
    const ctx: KeysContext = contextOver(http, {
      l1Signer: {
        signMessage: (m: string): Promise<`0x${string}`> => {
          seen.push(m);
          return Promise.resolve(L1_SIG);
        },
      },
    });
    await changeApiKey(ctx, { apiKeyIndex: 0, privateKey: KEY_HEX, nonce: 20n, settleMs: 0 });
    expect(seen).toEqual([CHANGE_PUB_KEY_ROW.body]);
  });

  test("the key cache is invalidated when the transaction is signed, not after it lands", async () => {
    const cache: ApiKeyCache = new ApiKeyCache();
    cache.set(1n, [{ api_key_index: 0, public_key: REGISTERED_PUBLIC_KEY }]);
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX
        ? acceptedSendTx()
        : { body: apikeysBody(0, REGISTERED_PUBLIC_KEY) },
    );
    const ctx: KeysContext = contextOver(http, {
      keyCache: cache,
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });
    await changeApiKey(ctx, { apiKeyIndex: 0, privateKey: KEY_HEX, nonce: 20n, settleMs: 0 });
    expect(cache.invalidations).toBeGreaterThanOrEqual(1);
  });

  test("a generated key is returned, is fresh, and is what was registered", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX ? acceptedSendTx() : { body: { code: 200, api_keys: [] } },
    );
    const ctx: KeysContext = contextOver(http, {
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });
    const receipt: ChangeApiKeyResult = await changeApiKey(ctx, {
      apiKeyIndex: 2,
      nonce: 0n,
      verifyAfter: false,
    });
    expect(receipt.privateKeyHex).toMatch(/^0x[0-9a-f]{80}$/);
    expect(ApiKey.fromPrivateKey(receipt.privateKeyHex).publicKeyHex).toBe(receipt.publicKeyHex);
    const send: Call = http.calls.find((c: Call): boolean => c.path === PATH_SEND_TX) as Call;
    expect(`0x${bytesToHex(submittedTx(send).pubKey)}`).toBe(receipt.publicKeyHex);
  });

  test("the nonce comes from the server when the caller does not pin one", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX ? acceptedSendTx() : { body: apikeysBody(0, REGISTERED_PUBLIC_KEY) },
    );
    const ctx: KeysContext = contextOver(http, {
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });
    await changeApiKey(ctx, { apiKeyIndex: 0, privateKey: KEY_HEX, settleMs: 0 });
    const send: Call = http.calls.find((c: Call): boolean => c.path === PATH_SEND_TX) as Call;
    const doc = JSON.parse(submittedTx(send).txInfo) as { Nonce: number };
    // The fixture reports nonce 20 for the slot.
    expect(doc.Nonce).toBe(20);
  });

  test("a malformed L1 signature is refused rather than submitted", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX ? acceptedSendTx() : { body: apikeysBody(0, REGISTERED_PUBLIC_KEY) },
    );
    const ctx: KeysContext = contextOver(http, {
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve("0xdead" as `0x${string}`) },
    });
    await expect(
      changeApiKey(ctx, { apiKeyIndex: 0, privateKey: KEY_HEX, nonce: 20n }),
    ).rejects.toThrow(LighterValidationError);
    expect(http.countOf(PATH_SEND_TX)).toBe(0);
  });

  test("the post-submission verification runs against the new key, and its failure surfaces", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } =>
      call.path === PATH_SEND_TX
        ? acceptedSendTx()
        : { body: apikeysBody(0, OTHER_KEY.publicKeyHex.slice(2)) },
    );
    const ctx: KeysContext = contextOver(http, {
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });
    await expect(
      changeApiKey(ctx, { apiKeyIndex: 0, privateKey: KEY_HEX, nonce: 20n, settleMs: 0 }),
    ).rejects.toThrow(LighterConfigError);
    expect(http.countOf(PATH_SEND_TX)).toBe(1);
  });

  test("`verifyAfter: false` skips the confirmation read entirely", async () => {
    const http: FakeHttp = fakeHttp((call: Call): { body: unknown } => {
      if (call.path === PATH_SEND_TX) return acceptedSendTx();
      throw new Error("no apikeys read expected");
    });
    const ctx: KeysContext = contextOver(http, {
      l1Signer: { signMessage: (): Promise<`0x${string}`> => Promise.resolve(L1_SIG) },
    });
    await changeApiKey(ctx, {
      apiKeyIndex: 0,
      privateKey: KEY_HEX,
      nonce: 20n,
      verifyAfter: false,
    });
    expect(http.countOf(PATH_APIKEYS)).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 6. Secrets                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("redaction", () => {
  test("a generated private key survives no diagnostic projection", () => {
    const key = createApiKey();
    const scrubbed: string = JSON.stringify(
      redact({ privateKeyHex: key.privateKeyHex, note: `key is ${key.privateKeyHex}` }),
    );
    expect(scrubbed).not.toContain(key.privateKeyHex);
    expect(scrubbed).not.toContain(key.privateKeyHex.slice(2));
  });

  test("no error raised by this module quotes a private key", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: apikeysBody(0, OTHER_KEY.publicKeyHex.slice(2)),
    }));
    const errors: unknown[] = [];
    try {
      await verifyKeys(contextOver(http));
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      await changeApiKey(contextOver(http), { apiKeyIndex: 0, privateKey: KEY_HEX, nonce: 20n });
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      await changeApiKey(contextOver(http), { apiKeyIndex: 255 });
    } catch (error: unknown) {
      errors.push(error);
    }
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      const projected: string = JSON.stringify((error as { toJSON(): unknown }).toJSON());
      expect(projected).not.toContain(KEY_HEX);
      expect(projected).not.toContain(KEY.privateKeyHex.slice(2));
    }
  });
});
