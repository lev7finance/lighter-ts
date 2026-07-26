/**
 * {@link LighterClient} — the object a process holds: one endpoint, one chain id, one REST client,
 * one WebSocket client, one market registry, and **no keys**.
 *
 * ## The constructor performs no I/O
 *
 * No network call, no promise, no timer, no `crypto.getRandomValues`. That is a hard requirement,
 * not a nicety: Cloudflare Workers forbid randomness at module scope (`docs/decisions.md` D2), and
 * a constructor that fetched anything could not be evaluated during a Worker's global phase — which
 * is exactly where a client should be built so that a request handler does not pay for it. Every
 * network call in this SDK is behind an explicit `await`:
 *
 * ```ts
 * const lighter = new LighterClient({ endpoint: 'mainnet' });   // synchronous, safe at module scope
 * await lighter.markets.load();                                  // explicit
 * const lighter = await LighterClient.connect();                 // both, for scripts
 * ```
 *
 * The WebSocket client is built on first access rather than in the constructor. Constructing it
 * would not open a socket either, but it would read `globalThis.WebSocket` and allocate a transport
 * for a client that may never stream anything.
 *
 * ## `chainId` is configuration, never inference
 *
 * The chain id is the first element of every transaction hash and is not discoverable from any
 * endpoint — `/systemConfig` does not carry it (`docs/protocol-notes.md` §7). The Python reference
 * substring-matches the base URL, which signs for the wrong chain behind a proxy or a vanity
 * domain. Here it comes from the named profile, or from an explicit `chainId` on a custom profile,
 * and a custom profile without one is a construction-time `LighterConfigError` — raised by
 * `resolveConfig`, before this class exists.
 *
 * ## No module-level mutable state
 *
 * Everything hangs off the constructed instance. N clients for N accounts or chains coexist without
 * interference, which the reference's process-global signer registry and package-global chain id
 * make impossible (`docs/decisions.md` D8, `spec/07-high-level-client.md` §6).
 */

import type { LighterConfig, ResolvedConfig } from "../config/config.js";
import { resolveConfig } from "../config/config.js";
import { LighterConfigError } from "../errors.js";
import { LighterRestClient } from "../rest/client.js";
import { LighterWsClient } from "../ws/client.js";
import type { TxDispatcher } from "../ws/send-tx.js";
import { createTxDispatcher } from "../ws/send-tx.js";
import { type AccountOptions, LighterAccount, parseAccountKeys } from "./account.js";
import { MarketRegistry } from "./markets.js";
import { createNonceSource } from "./nonce/index.js";
import type { NonceSource } from "./nonce/types.js";
import { createOutcomeClassifier } from "./nonce/types.js";
import type { SubmitChannel, SubmitContext, WsTxSubmitter } from "./submit.js";
import { requireSigningAccountIndex } from "./submit.js";

/**
 * Endpoint fields that belong **inside** `endpoint`, not beside it.
 *
 * `new LighterClient({ restBase, wsBase })` type-checks only for a non-literal argument — which is
 * exactly the case where the values come from JSON, an environment variable, or plain JavaScript.
 * Left unchecked it resolves to the *mainnet* profile and signs mainnet transactions against a
 * custom host: a silent, unrecoverable failure and the precise defect this SDK exists not to
 * reproduce (`docs/protocol-notes.md` §7). So a stray one is a construction-time refusal.
 */
const STRAY_ENDPOINT_FIELDS: readonly string[] = Object.freeze([
  "restBase",
  "wsBase",
  "chainId",
  "apiUrl",
  "wsUrl",
  "url",
]);

function rejectStrayEndpointFields(config: object): void {
  if (config === null || typeof config !== "object") return;
  const stray: string[] = STRAY_ENDPOINT_FIELDS.filter((key: string): boolean =>
    Object.hasOwn(config, key),
  );
  if (stray.length === 0) return;
  throw new LighterConfigError(
    `${stray.map((k: string): string => JSON.stringify(k)).join(", ")} ${
      stray.length === 1 ? "is not a" : "are not"
    } top-level option${stray.length === 1 ? "" : "s"}. A custom network is one object: ` +
      `\`new LighterClient({ endpoint: { name, restBase, wsBase, chainId } })\`. The chain id is an ` +
      `input to every transaction hash and cannot be inferred from a URL, so an endpoint that omits ` +
      `it would silently sign for mainnet (304)`,
  );
}

/** What {@link LighterClient} is constructed with: the SDK config, plus an optional registry. */
export interface LighterClientOptions extends LighterConfig {
  /**
   * A market registry to adopt instead of building one — normally
   * `MarketRegistry.fromSnapshot(SNAP)`, which lets a Worker boot with **zero** metadata round
   * trips. The client attaches its own transport to whatever it is given, so a snapshot-seeded
   * registry can still revalidate later.
   */
  readonly markets?: MarketRegistry;
}

/**
 * The read-side client and the factory for account-side ones.
 *
 * Cheap enough to construct per request in a serverless handler, and safe enough to construct at
 * module scope in one that is not.
 */
export class LighterClient {
  /** Every setting resolved, frozen: profile, chain id, `fetch`, timeouts, retry policy, clock. */
  readonly config: ResolvedConfig;

  /** Signing domain: mainnet `304`, testnet `300`, rh `466324`. Never inferred from a URL. */
  readonly chainId: number;

  /** All 78 REST operations, grouped by tag. */
  readonly rest: LighterRestClient;

  /** Market and asset metadata. Loaded on demand; never loaded by the constructor. */
  readonly markets: MarketRegistry;

  /** Built on first access to {@link ws}. */
  #ws: LighterWsClient | undefined;

  /** Built on first access to {@link wsTx}. */
  #wsTx: TxDispatcher | undefined;

  #closed: boolean = false;

  constructor(config: LighterClientOptions = {}) {
    rejectStrayEndpointFields(config);
    // Resolution is where a custom profile without a chain id is refused, and where `fetch` is
    // located. It reads globals but calls nothing: no clock, no randomness, no network.
    this.config = resolveConfig(config);
    this.chainId = this.config.chainId;

    // Constructing the REST client is one pass over the route table — 78 closures, no I/O — so it
    // is eager. It is also what the registry needs as a transport, and a registry holding a
    // lazily-materialised transport would be a second way to get this wrong.
    this.rest = new LighterRestClient(config);

    this.markets =
      config.markets ??
      new MarketRegistry({
        now: this.config.now,
        onDiagnostic: this.config.onDiagnostic,
      });
    this.markets.setTransport(this.rest);
  }

  /**
   * Construct, then load market metadata. The one-liner for scripts.
   *
   * The only difference from `new LighterClient(...)` is the `await`: everything it does is
   * available separately, and nothing about the client requires it.
   */
  static async connect(config: LighterClientOptions = {}): Promise<LighterClient> {
    const client: LighterClient = new LighterClient(config);
    await client.markets.load();
    return client;
  }

  /**
   * The WebSocket client, built on first access.
   *
   * Building it does **not** open a socket — `connect()` or the first `subscribe()` does — so
   * touching this property is still free of I/O.
   *
   * @throws {LighterConfigError} in a runtime with no `WebSocket` and none injected. Node 20 has no
   * global one; pass `undici`'s.
   */
  get ws(): LighterWsClient {
    if (this.#ws === undefined) {
      if (this.config.WebSocket === null) {
        throw new LighterConfigError(
          "no WebSocket implementation is available. Browsers, Bun, Deno and Cloudflare Workers " +
            "provide a global one; on Node 20 pass undici's: " +
            "`new LighterClient({ WebSocket })`",
        );
      }
      this.#ws = new LighterWsClient({
        url: this.config.profile.wsBase,
        WebSocket: this.config.WebSocket,
        clock: this.config.now,
        onDiagnostic: this.config.onDiagnostic,
      });
    }
    return this.#ws;
  }

  /**
   * The transaction half of the socket: `jsonapi/sendtx` and `jsonapi/sendtxbatch`, correlated.
   *
   * Separate from {@link ws} because it is a different capability with different failure modes —
   * a market-data consumer never needs it, and attaching it registers an inbound frame tap.
   *
   * **Cloudflare Workers (risk R12):** outside a Durable Object a Worker cannot hold an outbound
   * WebSocket across requests, so `submit: 'ws'` there means one socket per submission. Prefer
   * `'http'` unless the code runs inside a Durable Object.
   */
  get wsTx(): TxDispatcher {
    if (this.#wsTx === undefined) {
      this.#wsTx = createTxDispatcher(this.ws, {
        now: this.config.now,
        onDiagnostic: (d: { kind: string; [k: string]: unknown }): void => {
          this.config.onDiagnostic({ level: "debug", event: `ws.tx.${d.kind}`, detail: d });
        },
      });
    }
    return this.#wsTx;
  }

  /**
   * Build the write surface for one account.
   *
   * Synchronous and I/O-free, like the constructor: the nonce source fetches its first counter
   * lazily, on the first transaction, so an account can be constructed at module scope too
   * (`spec/07-high-level-client.md` §2.1, behaviour 3).
   *
   * @throws {LighterConfigError} for an unparseable private key, an empty key map, or an unknown
   * nonce strategy. No key material appears in the message.
   * @throws {LighterValidationError} for an account index outside `[-1, 2^48 − 2]`.
   */
  account(opts: AccountOptions): LighterAccount {
    const accountIndex: bigint = requireSigningAccountIndex(BigInt(opts.accountIndex));
    const keys: ReadonlyMap<number, import("../crypto/key.js").ApiKey> = parseAccountKeys(opts.keys);
    const nonces: NonceSource = this.#nonceSource(opts, accountIndex, [...keys.keys()]);
    const channel: SubmitChannel = opts.submit ?? "http";

    const ctx: SubmitContext = {
      chainId: this.chainId,
      accountIndex,
      rest: this.rest,
      // A thunk, so an account whose channel is `'http'` never constructs a WS client at all.
      ws: (): WsTxSubmitter => this.wsTx,
      nonces,
      keys,
      channel,
      classify: createOutcomeClassifier(),
      now: this.config.now,
      onDiagnostic: this.config.onDiagnostic,
    };

    return new LighterAccount({
      chainId: this.chainId,
      ctx,
      rest: this.rest,
      defaultTxExpiryMs: this.config.defaultTxExpiryMs,
      now: this.config.now,
      ...(opts.l1Signer !== undefined ? { l1Signer: opts.l1Signer } : {}),
      ...(opts.integrator !== undefined ? { integrator: opts.integrator } : {}),
    });
  }

  /**
   * Shut down. Idempotent, and never rejects.
   *
   * Closes the socket if one was ever built, detaches the transaction dispatcher, and stops the
   * market registry's refresh timer. Nothing is left scheduled afterwards — a Durable Object cannot
   * hibernate with a live timer, and a Node process will not exit with one.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#wsTx?.close();
    this.markets.stop();
    if (this.#ws !== undefined) await this.#ws.close();
  }

  /** Backing method for `Symbol.asyncDispose`; see the attachment below the class. */
  disposeAsync(): Promise<void> {
    return this.close();
  }

  /* ---- internals ------------------------------------------------------------------------------- */

  /** Adopt the caller's source, or build the named strategy over this client's transport. */
  #nonceSource(
    opts: AccountOptions,
    accountIndex: bigint,
    keys: readonly number[],
  ): NonceSource {
    const requested: AccountOptions["nonces"] = opts.nonces ?? "optimistic";
    if (typeof requested !== "string") return requested;
    return createNonceSource(requested, {
      // `nextNonce` takes the index as a query parameter, so it is a `number` here. The domain tops
      // out at 2^48 − 2, well inside the safe-integer range.
      accountIndex: Number(accountIndex),
      keys,
      client: this.rest,
    });
  }
}

/*
 * Explicit resource management, attached defensively — the same reasoning as `src/ws/subscription.ts`.
 *
 * `Symbol.asyncDispose` is `undefined` on Node 20 and older Safari, where a class body containing a
 * computed `[Symbol.asyncDispose]()` member throws at *import* time. Reading it defensively keeps
 * this module importable there; on a runtime that has it, `await using client = new LighterClient()`
 * works. `Symbol.asyncDispose ??= …` is deliberately not used: mutating a global at module scope is
 * an import side effect and this package ships `"sideEffects": false`.
 */
const asyncDisposeSym: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
if (typeof asyncDisposeSym === "symbol") {
  Object.defineProperty(LighterClient.prototype, asyncDisposeSym, {
    value: function asyncDispose(this: LighterClient): Promise<void> {
      return this.disposeAsync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}
