/**
 * API key lifecycle: generate, verify against the server, and register or rotate.
 *
 * A Lighter API key is a Schnorr keypair over the ecgFp5 curve, bound to an account at a chosen
 * `apiKeyIndex`. Registering one is a `ChangePubKey` (type 8) carrying the 40-byte public key,
 * signed at the L2 layer by **that same new key** — the key authorises its own registration — and
 * at the L1 layer by an Ethereum `personal_sign` from the account's owner. This module owns all
 * three of those steps and the `check_client` equivalent that confirms the result.
 *
 * ## Index conventions, which are not enforced by the protocol
 *
 * | Index | Meaning |
 * | --- | --- |
 * | `0` | the web app's slot — SDK users should stay off it and use `>= 1` |
 * | `>= 4` | required for maker-only restriction lists |
 * | `253` | the read-only auth-token convention (see `./auth-schedule.ts`) |
 * | `255` | the **nil marker**, meaning "every key" on `GET /apikeys`; never a signing index |
 *
 * The valid signing range is `[0, 254]`.
 *
 * ## The cache, and why a mismatch retries once
 *
 * {@link verifyKeys} caches the account's whole key set, and on a mismatch **invalidates and
 * refetches once** before declaring failure — a key rotation may have landed between the cached
 * read and the comparison, and a stale cache must not be reported as a misconfigured key. The cache
 * is also invalidated proactively whenever a `ChangePubKey` is signed, so the transaction that
 * changes the answer never leaves a stale one behind (`spec/07-high-level-client.md` §6).
 *
 * The cache is an ordinary object owned by the caller ({@link ApiKeyCache}), never a module-level
 * singleton: two accounts in one process, or two isolates sharing a module graph, must not see each
 * other's key sets (`docs/decisions.md` D8).
 *
 * ## Comparison is `0x`-insensitive
 *
 * The server returns public keys **without** the `0x` prefix; {@link ApiKey.publicKeyHex} includes
 * it. A raw `===` therefore fails on every key. {@link areKeysEqual} normalises both sides — prefix
 * stripped, lowercased — before comparing.
 *
 * ## Secrets
 *
 * Private keys never appear in an error message, a diagnostic, or a `toJSON()` projection here.
 * `ApiKey` itself refuses to put key bytes in a message, this module quotes only indices, and
 * `redact()` (`src/util/redact.ts`) is the backstop for anything that reaches a log.
 * `crypto.getRandomValues` is reached only from inside {@link createApiKey} — never at module
 * scope, which Cloudflare Workers forbids.
 */

import { ApiKey } from "../crypto/key.js";
import { PUBKEY_BYTES, verify } from "../crypto/schnorr.js";
import {
  L1SignatureRequiredError,
  LighterConfigError,
  LighterValidationError,
} from "../errors.js";
import type { ApiKey as ApiKeyRecord, AccountApiKeys } from "../models/account.js";
import type { CallOptions } from "../rest/client.js";
import { i64, u8 } from "../tx/brands.js";
import type { SignedTx, UnsignedTx } from "../tx/build.js";
import { buildChangePubKey } from "../tx/build.js";
import { TxType } from "../tx/enums.js";
import { l1MessageFor } from "../tx/l1/attach.js";
import type { EthPersonalSigner } from "../tx/l1/signer.js";
import { txHash } from "../tx/pipeline.js";
import type { ChangePubKeyTx } from "../tx/types/account.js";
import type { TxReceipt } from "./receipt.js";
import {
  type SendOpts,
  type SubmitContext,
  type SubmitTransport,
  prepareTx,
  submitPrepared,
} from "./submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* Constants                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The nil API key marker. `GET /apikeys?api_key_index=255` returns **every** key on the account. */
export const API_KEY_INDEX_NIL: 255 = 255;

/** Highest real signing index. */
export const MAX_API_KEY_INDEX: 254 = 254;

/**
 * How long to let the sequencer settle before the post-registration `apikeys` check, in ms.
 *
 * The reference sleeps ~5–10 s here. This is the default, not a hard-coded sleep: pass
 * `settleMs: 0` to skip the wait, or a larger value on a congested network.
 */
export const DEFAULT_KEY_SETTLE_MS: 8_000 = 8_000;

/* ---------------------------------------------------------------------------------------------- */
/* Context                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The one read this module performs, declared structurally: `LighterRestClient` satisfies it. */
export interface ApiKeysTransport {
  readonly account: {
    apikeys(
      params: { account_index: number; api_key_index?: number },
      opts?: CallOptions,
    ): Promise<AccountApiKeys>;
  };
}

/** {@link SubmitTransport} plus the `apikeys` read. `LighterRestClient` satisfies the whole thing. */
export type KeysTransport = SubmitTransport & ApiKeysTransport;

/**
 * What this module needs from an account.
 *
 * A superset of {@link SubmitContext}: {@link changeApiKey} signs and submits a transaction, so it
 * needs the whole write path, and {@link verifyKeys} needs one extra read. `LighterAccount`'s own
 * context satisfies it structurally.
 */
export interface KeysContext extends SubmitContext {
  readonly rest: KeysTransport;
  /** The injected EIP-191 signer. Absent means the four L1 flows throw rather than guess. */
  readonly l1Signer?: EthPersonalSigner | undefined;
  /**
   * Where the account's key set is remembered between calls. Absent means "no caching": each
   * {@link verifyKeys} starts cold, which is correct but costs a request.
   */
  readonly keyCache?: ApiKeyCache | undefined;
}

/* ---------------------------------------------------------------------------------------------- */
/* Hex comparison                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** Strip an optional `0x`/`0X` and lowercase. Not a validator: it does not check hex-ness. */
function normalizeKeyHex(value: string): string {
  const body: string = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return body.toLowerCase();
}

/**
 * Compare two public keys as the server compares them: `0x`-insensitive, case-insensitive.
 *
 * The server returns keys **without** a prefix and this SDK's `publicKeyHex` carries one, so a raw
 * `===` is wrong in exactly the case that matters. Two empty strings are **not** equal — an absent
 * `public_key` on an unregistered slot must never satisfy a comparison.
 */
export function areKeysEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left: string = normalizeKeyHex(a);
  const right: string = normalizeKeyHex(b);
  if (left.length === 0 || right.length === 0) return false;
  return left === right;
}

/* ---------------------------------------------------------------------------------------------- */
/* Local key generation                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** A freshly generated keypair, as `0x`-prefixed lowercase hex. */
export interface GeneratedApiKey {
  /** **Secret.** 40 bytes, `0x` + 80 hex characters. Store it before you lose it: it is not recoverable. */
  readonly privateKeyHex: string;
  /** 40 bytes, `0x` + 80 hex characters. This is what a `ChangePubKey` registers. */
  readonly publicKeyHex: string;
}

/**
 * Generate an API keypair locally. Pure computation plus one CSPRNG draw; no I/O.
 *
 * `crypto.getRandomValues` is resolved and called **inside this function**, never at module scope —
 * Cloudflare Workers throws on a module-scope draw and the whole package would fail to load.
 * Calling this twice returns two different keys, which is asserted rather than assumed.
 *
 * The returned private key is a secret with no server-side copy. `redact()` recognises both the
 * `privateKeyHex` property name and the `0x` + 80-hex shape, so an accidental log line is scrubbed;
 * not logging it is still cheaper.
 *
 * @throws {LighterSignatureError} if no platform CSPRNG is available. There is no fallback: a key
 * derived from anything weaker is a key an attacker derives too.
 */
export function createApiKey(): GeneratedApiKey {
  const key: ApiKey = ApiKey.generate();
  return { privateKeyHex: key.privateKeyHex, publicKeyHex: key.publicKeyHex };
}

/* ---------------------------------------------------------------------------------------------- */
/* The cache                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The account's registered key set, remembered between {@link verifyKeys} calls.
 *
 * Deliberately an object the caller constructs and holds, not a module singleton: N accounts in one
 * process must not share one, and a Workers isolate must not leak one account's key set into
 * another request's view (`docs/decisions.md` D8).
 *
 * {@link invalidations} is public because it is the observable half of the mismatch-retry contract —
 * "invalidate and refetch exactly once" is a counting assertion, not a shape assertion.
 */
export class ApiKeyCache {
  /** Keyed by account index rendered in decimal, so a `bigint` needs no lossy conversion. */
  readonly #entries: Map<string, readonly ApiKeyRecord[]> = new Map<string, readonly ApiKeyRecord[]>();

  /** How many times {@link invalidate} has been called. Diagnostics and tests read it. */
  invalidations: number = 0;

  /** The cached key set for an account, or `undefined` if nothing is remembered. */
  get(accountIndex: bigint): readonly ApiKeyRecord[] | undefined {
    return this.#entries.get(accountIndex.toString(10));
  }

  /** Remember an account's whole key set. Replaces any previous entry. */
  set(accountIndex: bigint, records: readonly ApiKeyRecord[]): void {
    this.#entries.set(accountIndex.toString(10), records);
  }

  /** Forget one account's key set and count the invalidation. Safe on a cold cache. */
  invalidate(accountIndex: bigint): void {
    this.invalidations += 1;
    this.#entries.delete(accountIndex.toString(10));
  }

  /** Forget everything. Does not count as an invalidation of any particular account. */
  clear(): void {
    this.#entries.clear();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Verification                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** Per-call options for {@link verifyKeys}. */
export interface VerifyKeysOptions {
  readonly signal?: AbortSignal;
}

/** Fetch the account's whole key set. `api_key_index: 255` is the nil marker meaning "all". */
async function fetchKeyRecords(
  ctx: KeysContext,
  signal: AbortSignal | undefined,
): Promise<readonly ApiKeyRecord[]> {
  const response: AccountApiKeys = await ctx.rest.account.apikeys(
    {
      account_index: Number(ctx.accountIndex),
      api_key_index: API_KEY_INDEX_NIL,
    },
    signal === undefined ? undefined : { signal },
  );
  return response.api_keys ?? [];
}

/**
 * Which configured keys disagree with a fetched key set.
 *
 * A slot the server does not know about counts as a mismatch: the caller believes it can sign with
 * it, and it cannot.
 */
function mismatchedIndexes(
  ctx: KeysContext,
  records: readonly ApiKeyRecord[],
): readonly number[] {
  const byIndex: Map<number, ApiKeyRecord> = new Map<number, ApiKeyRecord>();
  for (const record of records) {
    if (typeof record.api_key_index === "number") byIndex.set(record.api_key_index, record);
  }
  const bad: number[] = [];
  for (const [index, key] of ctx.keys) {
    const record: ApiKeyRecord | undefined = byIndex.get(index);
    const remote: string | undefined = record?.public_key;
    if (remote === undefined || !areKeysEqual(remote, key.publicKeyHex)) bad.push(index);
  }
  return bad;
}

/**
 * The `check_client` equivalent: every configured private key derives the public key the server has
 * registered for its slot.
 *
 * On the happy path with a cold cache this is **exactly one request**. On a mismatch it invalidates
 * the cache and refetches **once** — a rotation may have landed a moment ago, and reporting a stale
 * cache as a misconfiguration is a false alarm that costs a debugging session. A second mismatch is
 * a real one and throws.
 *
 * @throws {LighterConfigError} naming the offending indices. Never a key, never a signature.
 */
export async function verifyKeys(ctx: KeysContext, o?: VerifyKeysOptions): Promise<void> {
  if (ctx.keys.size === 0) {
    throw new LighterConfigError(
      "this account holds no api keys, so there is nothing to verify; pass `keys: { 1: '0x…' }`",
    );
  }
  const cache: ApiKeyCache | undefined = ctx.keyCache;

  let records: readonly ApiKeyRecord[] =
    cache?.get(ctx.accountIndex) ?? (await fetchKeyRecords(ctx, o?.signal));
  cache?.set(ctx.accountIndex, records);

  let bad: readonly number[] = mismatchedIndexes(ctx, records);
  if (bad.length > 0) {
    // Exactly one retry, against a definitively fresh read: a rotation may have landed between the
    // cached read and this comparison. With no cache installed the invalidation is a no-op and the
    // refetch still happens, so the behaviour is identical — only the counter is unobservable.
    cache?.invalidate(ctx.accountIndex);
    records = await fetchKeyRecords(ctx, o?.signal);
    cache?.set(ctx.accountIndex, records);
    bad = mismatchedIndexes(ctx, records);
  }

  if (bad.length > 0) {
    throw new LighterConfigError(
      `the configured private key for api key index ${bad.join(", ")} does not match the public ` +
        `key registered for account ${ctx.accountIndex.toString(10)}; register it with ` +
        "changeApiKey(), or correct the configuration",
    );
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Registration and rotation                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** What {@link changeApiKey} accepts. */
export interface ChangeApiKeyOpts {
  /** The slot to (re)key. `[0, 254]`; `0` is the web app's and `255` is the nil marker. */
  readonly apiKeyIndex: number;
  /**
   * Register **this** key instead of generating one — 40 raw little-endian bytes, or the same as
   * hex with or without `0x`. Supply it when the key already exists (a rotation you pre-generated,
   * a key held in a vault); omit it to generate one here.
   */
  readonly privateKey?: string | Uint8Array;
  /**
   * The transaction nonce. Default: the server's `nonce` for that slot, or `0` for a slot it does
   * not yet know about. The nonce source is deliberately not consulted — a brand-new key index has
   * no lease history, and the slot being rekeyed may not be one this account can currently sign for.
   */
  readonly nonce?: bigint;
  /** Overrides `ctx.l1Signer` for this call. */
  readonly l1Signer?: EthPersonalSigner;
  /** Unix **milliseconds**. Defaults to the builder's `now() + 599_000`. */
  readonly expiredAt?: bigint;
  /** Milliseconds to let the sequencer settle before verifying. Default {@link DEFAULT_KEY_SETTLE_MS}. */
  readonly settleMs?: number;
  /** `false` skips the post-submission `apikeys` verification. Default `true`. */
  readonly verifyAfter?: boolean;
  readonly signal?: AbortSignal;
  /** Transport-level knobs for the submission itself. */
  readonly send?: Omit<SendOpts, "nonce" | "apiKeyIndex" | "expiredAt">;
}

/**
 * {@link TxReceipt} for the `ChangePubKey`, plus the key that was registered.
 *
 * The private key is here because {@link changeApiKey} may have generated it, and a flow that
 * generates a secret and then discards it is a flow that bricks the slot. It is a `TxReceipt`, so
 * the narrower declared return type in the specification is satisfied.
 */
export interface ChangeApiKeyResult extends TxReceipt {
  /** **Secret.** The new private key, `0x` + 80 hex. Persist it before doing anything else. */
  readonly privateKeyHex: string;
  /** The registered public key, `0x` + 80 hex. */
  readonly publicKeyHex: string;
  /** The slot it was registered at. */
  readonly apiKeyIndex: number;
}

/** The server's current nonce for one slot, or `0` when it has never seen it. */
async function nonceForSlot(
  ctx: KeysContext,
  apiKeyIndex: number,
  signal: AbortSignal | undefined,
): Promise<bigint> {
  const response: AccountApiKeys = await ctx.rest.account.apikeys(
    { account_index: Number(ctx.accountIndex), api_key_index: apiKeyIndex },
    signal === undefined ? undefined : { signal },
  );
  const record: ApiKeyRecord | undefined = (response.api_keys ?? []).find(
    (r: ApiKeyRecord): boolean => r.api_key_index === apiKeyIndex,
  );
  const nonce: number | undefined = record?.nonce;
  return typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0
    ? BigInt(nonce)
    : 0n;
}

/**
 * `setTimeout`-backed delay, cancellable by a signal, with the handle always cleared.
 *
 * Never a repeating timer: a Durable Object cannot hibernate while one is live, and this package is
 * expected to run inside one. Used only when the context supplies no `sleep`.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const handle: ReturnType<typeof globalThis.setTimeout> = globalThis.setTimeout((): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      globalThis.clearTimeout(handle);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Register or rotate an API key: `ChangePubKey` (type 8), signed by the new key at L2 and by the
 * account's L1 owner at L1.
 *
 * The flow, in order (`spec/07-high-level-client.md` §7.1):
 *
 * 1. Obtain the new keypair — generated locally here, or the one the caller supplied. No I/O.
 * 2. Build the transaction carrying its 40-byte public key.
 * 3. Obtain the L1 authorisation over the exact `Register Lighter Account` message. **With no
 *    signer configured this throws {@link L1SignatureRequiredError} carrying the message, so the
 *    application can route it to a wallet and resume via `account.submitWithL1Signature()`** —
 *    and it throws before anything is signed or sent.
 * 4. Sign at L2 **with the new key**: the key authorises its own registration. The signature is
 *    then verified locally against the new public key before submission — one cheap `verify()` that
 *    catches a mis-derived key immediately instead of as an opaque sequencer rejection.
 * 5. Submit, let the sequencer settle, and confirm with the `apikeys` check.
 *
 * The key cache is invalidated the moment the transaction is signed, not after it lands: from that
 * instant the cached answer may be wrong, and a stale "your key does not match" is the exact false
 * alarm the retry in {@link verifyKeys} exists to avoid.
 *
 * @throws {L1SignatureRequiredError} `{ message, template, txType: 8 }` when no `L1Signer` is available.
 * @throws {LighterValidationError} for an index outside `[0, 254]`, a public key that is not 40
 * bytes, or a local Schnorr verification that fails.
 */
export async function changeApiKey(
  ctx: KeysContext,
  o: ChangeApiKeyOpts,
): Promise<ChangeApiKeyResult> {
  const apiKeyIndex: number = o.apiKeyIndex;
  if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex > MAX_API_KEY_INDEX) {
    throw new LighterValidationError(
      "API_KEY_INDEX_INVALID",
      `an api key index is an integer in [0, ${String(MAX_API_KEY_INDEX)}], received ` +
        `${String(apiKeyIndex)}; 255 is the nil marker and is not a real index`,
      { field: "ApiKeyIndex", txType: TxType.L2ChangePubKey, bound: MAX_API_KEY_INDEX },
    );
  }

  // 1. Local key material. `ApiKey.generate()` draws from the CSPRNG here, per call.
  const newKey: ApiKey =
    o.privateKey === undefined ? ApiKey.generate() : ApiKey.fromPrivateKey(o.privateKey);
  const pubKey: Uint8Array = newKey.publicKeyBytes;
  if (pubKey.length !== PUBKEY_BYTES) {
    throw new LighterValidationError(
      "PUBKEY_INVALID",
      `a ChangePubKey public key is exactly ${String(PUBKEY_BYTES)} bytes, got ${String(pubKey.length)}`,
      { field: "PubKey", txType: TxType.L2ChangePubKey, bound: PUBKEY_BYTES },
    );
  }

  // 2. The transaction. The nonce comes from the server unless the caller pinned one; asking the
  //    server is a read, so an explicit nonce keeps this whole path I/O-free up to submission.
  const nonce: bigint = o.nonce ?? (await nonceForSlot(ctx, apiKeyIndex, o.signal));
  const tx: ChangePubKeyTx = buildChangePubKey(
    { pubKey },
    {
      accountIndex: i64(ctx.accountIndex),
      apiKeyIndex: u8(apiKeyIndex),
      nonce: i64(nonce),
      ...(o.expiredAt !== undefined ? { expiredAt: i64(o.expiredAt) } : {}),
      ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    },
  );

  // 3. The L1 authorisation. `l1MessageFor` returns the byte-exact template pinned by
  //    `conformance/vectors/tx.json` → `l1Messages`. Type 8 always has one; the check is here
  //    because a `null` would otherwise be signed as the four characters "null".
  const message: string | null = l1MessageFor(tx, ctx.chainId);
  if (message === null) {
    throw new LighterValidationError(
      "L1_SIGNATURE_NOT_APPLICABLE",
      "ChangePubKey has no L1 message, which is impossible; the template table is corrupt",
      { txType: TxType.L2ChangePubKey },
    );
  }
  const signer: EthPersonalSigner | undefined = o.l1Signer ?? ctx.l1Signer;
  if (signer === undefined) {
    throw new L1SignatureRequiredError({
      message,
      template: message,
      txType: TxType.L2ChangePubKey,
    });
  }
  const l1Sig: string = await signer.signMessage(message);
  if (!/^0x[0-9a-fA-F]{130}$/.test(l1Sig)) {
    throw new LighterValidationError(
      "SIGNATURE_INVALID",
      "the injected signer must return an 0x-prefixed 65-byte hex signature (132 characters)",
      { field: "L1Sig", txType: TxType.L2ChangePubKey },
    );
  }
  const withL1: UnsignedTx = Object.freeze({
    ...(tx as object),
    l1Sig: l1Sig.toLowerCase(),
  }) as unknown as UnsignedTx;

  // 4. Sign at L2 with the *new* key. The context is derived rather than mutated: the caller's key
  //    map is not ours to change, and two accounts may share it by reference.
  const signingKeys: Map<number, ApiKey> = new Map<number, ApiKey>(ctx.keys);
  signingKeys.set(apiKeyIndex, newKey);
  const signingCtx: KeysContext = { ...ctx, keys: signingKeys };

  const signed: SignedTx = await prepareTx(signingCtx, withL1, { nonce, apiKeyIndex });

  // The answer to "which key is registered here" is now in flight, so the cache is stale from this
  // moment — invalidated on *signing*, exactly as the reference does.
  ctx.keyCache?.invalidate(ctx.accountIndex);

  if (!verify(pubKey, txHash(signed, ctx.chainId), signed.sig)) {
    throw new LighterValidationError(
      "SIGNATURE_INVALID",
      `the ChangePubKey for api key index ${String(apiKeyIndex)} does not verify against the key ` +
        "it registers; the transaction was not submitted",
      { field: "Sig", txType: TxType.L2ChangePubKey },
    );
  }

  // 5. Submit, settle, confirm.
  const receipt: TxReceipt = await submitPrepared(signingCtx, signed, {
    ...o.send,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  });

  if (o.verifyAfter !== false) {
    const settleMs: number = o.settleMs ?? DEFAULT_KEY_SETTLE_MS;
    if (settleMs > 0) await (ctx.sleep ?? defaultSleep)(settleMs, o.signal);
    // Verified against the new key alone: the other configured slots are not what this call changed,
    // and failing on an unrelated stale slot would misattribute the failure.
    await verifyKeys(
      { ...ctx, keys: new Map<number, ApiKey>([[apiKeyIndex, newKey]]) },
      o.signal === undefined ? undefined : { signal: o.signal },
    );
  }

  return {
    ...receipt,
    // `wait` is an own closure on the receipt and is carried across by the spread; it captures the
    // receipt's own state, not `this`, so nothing here rebinds.
    privateKeyHex: newKey.privateKeyHex,
    publicKeyHex: newKey.publicKeyHex,
    apiKeyIndex,
  };
}
