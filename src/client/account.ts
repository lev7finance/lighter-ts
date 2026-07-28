/**
 * {@link LighterAccount} — one `accountIndex`, its API keys, its nonce source, and the write path.
 *
 * A client reads; an account writes. The split is not cosmetic: `LighterClient` holds no key
 * material at all, so a process can hold one client and N accounts (sub-accounts, public pools,
 * several L1 owners) without any of them sharing state. Nothing here lives at module scope — the
 * reference's process-global signer registry with a "last created wins" default pointer is exactly
 * the bug this shape prevents (`docs/decisions.md` D8, `spec/07-high-level-client.md` §6).
 *
 * ## Two tiers, and this file owns the raw one
 *
 * `account.tx.*` is the **raw tier**: twenty builders, every numeric field a `bigint` in protocol
 * units, 1:1 with the wire, synchronous, no metadata required and no I/O. It is `src/tx/`'s twenty
 * builders with the account's `accountIndex` and `expiredAt` default already applied. The human
 * tier — decimal strings, market symbols, slippage — is a separate unit layered on top of this one
 * (§9.3).
 *
 * ## The nonce on a raw transaction is a placeholder
 *
 * A builder needs *a* nonce to produce a transaction; only a lease knows *the* nonce, and the lease
 * must not be taken until the transaction is otherwise ready to sign. So `account.tx.*` stamps
 * {@link PENDING_NONCE} and the first configured key, and `prepare()` / `send()` overwrite both
 * immediately before hashing. That is why the raw options accept `expiredAt` and `attributes` but
 * **not** `nonce` or `apiKeyIndex`: those belong to the submission, where they select
 * caller-managed mode, and accepting them in two places would let one silently lose to the other.
 *
 * ## What is never cached
 *
 * Balances, positions and open orders. {@link LighterAccount.state} is a thin pass-through to
 * `GET /api/v1/account` every time it is called (§8.2). Market metadata is cached — by the market
 * registry, which is a different unit, and which never holds an account's money.
 */

import { ApiKey } from "../crypto/key.js";
import { LighterConfigError, LighterValidationError } from "../errors.js";
import type { DetailedAccounts, SubAccounts } from "../models/account.js";
import type { CallOptions } from "../rest/client.js";
import type { TxAttributes } from "../tx/attributes.js";
import { type I64, type U8, i64, u8 } from "../tx/brands.js";
import {
  type ApproveIntegratorRequest,
  type BurnSharesRequest,
  type CancelAllOrdersRequest,
  type CancelOrderRequest,
  type ChangePubKeyRequest,
  type CreateGroupedOrdersRequest,
  type CreateOrderRequest,
  type CreatePublicPoolRequest,
  type CreateSubAccountRequest,
  type MintSharesRequest,
  type ModifyOrderRequest,
  type SignedTx,
  type StakeAssetsRequest,
  type TransferRequest,
  type UnsignedTx,
  type UnstakeAssetsRequest,
  type UpdateAccountAssetConfigRequest,
  type UpdateAccountConfigRequest,
  type UpdateLeverageRequest,
  type UpdateMarginRequest,
  type UpdatePublicPoolRequest,
  type WithdrawRequest,
  buildApproveIntegrator,
  buildBurnShares,
  buildCancelAllOrders,
  buildCancelOrder,
  buildChangePubKey,
  buildCreateGroupedOrders,
  buildCreateOrder,
  buildCreatePublicPool,
  buildCreateSubAccount,
  buildMintShares,
  buildModifyOrder,
  buildStakeAssets,
  buildTransfer,
  buildUnstakeAssets,
  buildUpdateAccountAssetConfig,
  buildUpdateAccountConfig,
  buildUpdateLeverage,
  buildUpdateMargin,
  buildUpdatePublicPool,
  buildWithdraw,
} from "../tx/build.js";
import { TxType } from "../tx/enums.js";
import type { EthPersonalSigner } from "../tx/l1/signer.js";
import type { TransactOpts } from "../tx/opts.js";
import type {
  ApproveIntegratorTx,
  ChangePubKeyTx,
  CreatePublicPoolTx,
  CreateSubAccountTx,
  MintSharesTx,
  BurnSharesTx,
  StakeAssetsTx,
  TransferTx,
  UnstakeAssetsTx,
  UpdateAccountAssetConfigTx,
  UpdateAccountConfigTx,
  UpdateLeverageTx,
  UpdateMarginTx,
  UpdatePublicPoolTx,
  WithdrawTx,
} from "../tx/types/account.js";
import type {
  CancelAllOrdersTx,
  CancelOrderTx,
  CreateGroupedOrdersTx,
  CreateOrderTx,
  ModifyOrderTx,
} from "../tx/types/orders.js";
import type { NonceSource } from "./nonce/types.js";
import type { TxReceipt } from "./receipt.js";
import {
  type PrepareOpts,
  type SendOpts,
  type SubmitChannel,
  type SubmitContext,
  prepareTx,
  submit,
  submitBatch,
  submitPrepared,
  submitPreparedBatch,
} from "./submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* The raw transaction surface                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The nonce a freshly built raw transaction carries.
 *
 * Not a sentinel and not `-1`: `-1` fails the builders' own `nonce >= 0` rule, and a transaction
 * that cannot be built is a worse debugging experience than one whose nonce is overwritten a
 * moment later. Every path that signs — `prepare()`, `send()`, `sendBatch()` — replaces it.
 */
export const PENDING_NONCE: I64 = i64(0);

/**
 * Per-call overrides for a raw builder.
 *
 * Deliberately **not** `nonce` or `apiKeyIndex`: those select caller-managed submission and live on
 * {@link SendOpts}. See the module header.
 */
export interface RawTxOpts {
  /** Unix **milliseconds**. Defaults to `now() + defaultTxExpiryMs` (599 000 ms). */
  readonly expiredAt?: bigint;
  /**
   * L2 attributes for this transaction, replacing the account's integrator defaults entirely.
   * Nil-valued entries are dropped, and an attribute changes the hash — none of them is free
   * metadata (§5.5).
   */
  readonly attributes?: TxAttributes;
  /** `false` turns off this SDK's tightenings, keeping only the reference's own rules. */
  readonly strict?: boolean;
}

/**
 * The twenty builders, bound to one account.
 *
 * Synchronous, allocation-only, no I/O, no clock read except the `expiredAt` default. Each returns
 * the transaction's own type rather than the union, so a caller who builds a `createOrder` can read
 * `.price` off the result without narrowing.
 */
export interface RawTxSurface {
  /** Code 8. Register or rotate the ECgFp5 public key. Needs an L1 signature (§7). */
  changePubKey(req: ChangePubKeyRequest, opts?: RawTxOpts): ChangePubKeyTx;
  /** Code 9. Needs an L1 signature, which it carries out of band. */
  createSubAccount(req?: CreateSubAccountRequest, opts?: RawTxOpts): CreateSubAccountTx;
  /** Code 10. */
  createPublicPool(req: CreatePublicPoolRequest, opts?: RawTxOpts): CreatePublicPoolTx;
  /** Code 11. The operator fee may only ever decrease. */
  updatePublicPool(req: UpdatePublicPoolRequest, opts?: RawTxOpts): UpdatePublicPoolTx;
  /** Code 12. `memo` is exactly 32 bytes; an L1 signature is needed across owners. */
  transfer(req: TransferRequest, opts?: RawTxOpts): TransferTx;
  /** Code 13. */
  withdraw(req: WithdrawRequest, opts?: RawTxOpts): WithdrawTx;
  /** Code 14. */
  createOrder(req: CreateOrderRequest, opts?: RawTxOpts): CreateOrderTx;
  /** Code 15. `index` is a client order index or an exchange order index. */
  cancelOrder(req: CancelOrderRequest, opts?: RawTxOpts): CancelOrderTx;
  /** Code 16. */
  cancelAllOrders(req: CancelAllOrdersRequest, opts?: RawTxOpts): CancelAllOrdersTx;
  /** Code 17. */
  modifyOrder(req: ModifyOrderRequest, opts?: RawTxOpts): ModifyOrderTx;
  /** Code 18. */
  mintShares(req: MintSharesRequest, opts?: RawTxOpts): MintSharesTx;
  /** Code 19. */
  burnShares(req: BurnSharesRequest, opts?: RawTxOpts): BurnSharesTx;
  /** Code 20. `initialMarginFraction` is the raw IMF, not a leverage. */
  updateLeverage(req: UpdateLeverageRequest, opts?: RawTxOpts): UpdateLeverageTx;
  /** Code 28. Leg order is load-bearing and is never normalised. */
  createGroupedOrders(req: CreateGroupedOrdersRequest, opts?: RawTxOpts): CreateGroupedOrdersTx;
  /** Code 29. `usdcAmount` is micro-USDC. */
  updateMargin(req: UpdateMarginRequest, opts?: RawTxOpts): UpdateMarginTx;
  /** Code 35. */
  stakeAssets(req: StakeAssetsRequest, opts?: RawTxOpts): StakeAssetsTx;
  /** Code 36. */
  unstakeAssets(req: UnstakeAssetsRequest, opts?: RawTxOpts): UnstakeAssetsTx;
  /** Code 41. */
  updateAccountConfig(req: UpdateAccountConfigRequest, opts?: RawTxOpts): UpdateAccountConfigTx;
  /** Code 42. */
  updateAccountAssetConfig(
    req: UpdateAccountAssetConfigRequest,
    opts?: RawTxOpts,
  ): UpdateAccountAssetConfigTx;
  /** Code 45. Needs an L1 signature unless every fee cap is zero or the integrator shares a master. */
  approveIntegrator(req: ApproveIntegratorRequest, opts?: RawTxOpts): ApproveIntegratorTx;
}

/* ---------------------------------------------------------------------------------------------- */
/* Construction                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** Integrator attribution applied by default to the transaction types that carry it. */
export interface IntegratorConfig {
  /** Attribute 1. */
  readonly accountIndex: bigint;
  /** Attribute 2, `/1e6` — `1000` is 0.1 %. */
  readonly takerFee?: number;
  /** Attribute 3, `/1e6`. */
  readonly makerFee?: number;
}

/** What `client.account({...})` accepts. */
export interface AccountOptions {
  readonly accountIndex: bigint | number;
  /**
   * `apiKeyIndex → private key`, as `0x`-prefixed or bare hex, or 40 raw little-endian bytes.
   *
   * The caller's object is **not** mutated — the reference strips `0x` in place, which quietly
   * rewrites a configuration object the caller may still be holding.
   */
  readonly keys: Record<number, string | Uint8Array>;
  /** Strategy name, or a source built elsewhere (a snapshot restored from Durable Object storage). */
  readonly nonces?: "optimistic" | "server" | "manual" | NonceSource;
  /** Injected EIP-191 signer for the four flows that need one. The SDK never holds an L1 key (D6). */
  readonly l1Signer?: EthPersonalSigner;
  readonly integrator?: IntegratorConfig;
  /** Default transport. `'http'` unless stated. */
  readonly submit?: SubmitChannel;
}

/** Everything an account needs from its client, passed in rather than reached for. */
export interface AccountDeps {
  readonly chainId: number;
  readonly ctx: SubmitContext;
  /** Reads that are not part of the write path but need the same transport. */
  readonly rest: {
    readonly account: {
      account(
        params: { by: "index" | "l1_address"; value: string; cursor?: string },
        opts?: CallOptions,
      ): Promise<DetailedAccounts>;
      accountsByL1Address(
        params: { l1_address: string; cursor?: string },
        opts?: CallOptions,
      ): Promise<SubAccounts>;
    };
  };
  /** Default `expiredAt` window in ms. */
  readonly defaultTxExpiryMs: number;
  readonly now: () => number;
  readonly l1Signer?: EthPersonalSigner | undefined;
  readonly integrator?: IntegratorConfig | undefined;
}

/**
 * Parse a private-key map into `ApiKey` instances.
 *
 * Every key is validated **here**, at construction, rather than at first use: a typo in a key is a
 * configuration error, and discovering it three seconds into a market-making run — after a lease
 * has been taken — is strictly worse. No key material appears in any error raised.
 */
function toKeyMap(keys: Record<number, string | Uint8Array>): ReadonlyMap<number, ApiKey> {
  if (keys === null || typeof keys !== "object") {
    throw new LighterConfigError("account keys must be an object of { apiKeyIndex: privateKey }");
  }
  const out: Map<number, ApiKey> = new Map<number, ApiKey>();
  for (const raw of Object.keys(keys)) {
    const index: number = Number(raw);
    if (!Number.isInteger(index)) {
      throw new LighterConfigError(`api key index ${JSON.stringify(raw)} is not an integer`);
    }
    const material: string | Uint8Array | undefined = keys[index];
    if (material === undefined) continue;
    try {
      // `u8()` checks the width; the pool and the validators check the domain. `255` is the nil
      // marker and is never a signing key.
      out.set(u8(index), ApiKey.fromPrivateKey(material));
    } catch (cause: unknown) {
      // The cause carries lengths and reasons only — `ApiKey` never puts key bytes in a message.
      throw new LighterConfigError(
        `the private key for api key index ${String(index)} could not be parsed`,
        { cause },
      );
    }
  }
  if (out.size === 0) {
    throw new LighterConfigError(
      "an account needs at least one api key; pass `keys: { 1: '0x…' }` keyed by api key index",
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* The account                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One account's write surface.
 *
 * Construct through `client.account({...})` rather than directly: the client owns the transports,
 * the chain id and the clock, and an account assembled by hand would be free to disagree with it
 * about the chain — which produces perfectly valid signatures that no sequencer will accept.
 */
export class LighterAccount {
  /** The signing account. `[-1, 2^48 − 2]`. */
  readonly accountIndex: bigint;

  /** The raw tier: twenty builders, protocol units, synchronous, 1:1 with the wire. */
  readonly tx: RawTxSurface;

  /** Where nonces come from. Shared, by reference, with every account returned by {@link via}. */
  readonly nonces: NonceSource;

  /** Which transport {@link send} uses when a call does not name one. */
  readonly channel: SubmitChannel;

  readonly #deps: AccountDeps;
  readonly #ctx: SubmitContext;

  constructor(deps: AccountDeps) {
    this.#deps = deps;
    this.#ctx = deps.ctx;
    this.accountIndex = deps.ctx.accountIndex;
    this.nonces = deps.ctx.nonces;
    this.channel = deps.ctx.channel;
    this.tx = this.#buildSurface();
  }

  /** The injected L1 signer, if one was configured. `undefined` means the four L1 flows will throw. */
  get l1Signer(): EthPersonalSigner | undefined {
    return this.#deps.l1Signer;
  }

  /** The API key indices this account can sign with. */
  get apiKeyIndexes(): readonly number[] {
    return Object.freeze([...this.#ctx.keys.keys()]);
  }

  /**
   * The same account over a different transport.
   *
   * The returned object shares the nonce source, the keys and the transports by reference — it is a
   * view, not a copy, so a lease taken through one is visible to the other. That is the point: two
   * views must never allocate the same nonce.
   */
  via(channel: SubmitChannel): LighterAccount {
    if (channel === this.channel) return this;
    return new LighterAccount({ ...this.#deps, ctx: { ...this.#ctx, channel } });
  }

  /* ---- the lifecycle --------------------------------------------------------------------------- */

  /**
   * Stamp, validate, hash and sign — everything except the network.
   *
   * In managed mode this **spends** a nonce: the caller now holds a signed transaction carrying it,
   * and the SDK cannot know whether it will be sent. Prefer {@link send} with an unsigned
   * transaction, which holds the lease across the submission and can therefore return the slot when
   * the sequencer refuses it.
   */
  prepare(tx: UnsignedTx, opts?: PrepareOpts): Promise<SignedTx> {
    return prepareTx(this.#ctx, tx, opts);
  }

  /**
   * Build → sign → submit → classify, in one call.
   *
   * Accepts an unsigned transaction (the ordinary path: the lease is held across signing *and*
   * submission) or an already-signed one (whose nonce is fixed, so no lease is taken).
   */
  send(prepared: UnsignedTx | SignedTx, opts?: SendOpts): Promise<TxReceipt> {
    return isSigned(prepared)
      ? submitPrepared(this.#ctx, prepared, opts)
      : submit(this.#ctx, prepared, opts);
  }

  /**
   * Submit several transactions as one request: one API key, consecutive nonces, no interleaving.
   *
   * Unsigned transactions get their nonces from a single run of leases on one key; already-signed
   * ones are checked for the same property and refused if they do not have it.
   */
  sendBatch(prepared: readonly (UnsignedTx | SignedTx)[], opts?: SendOpts): Promise<TxReceipt[]> {
    if (prepared.length > 0 && prepared.every(isSigned)) {
      return submitPreparedBatch(this.#ctx, prepared as readonly SignedTx[], opts);
    }
    if (prepared.some(isSigned)) {
      throw new LighterValidationError(
        "BATCH_MIXED_SIGNING",
        "a batch is either all unsigned (this SDK assigns consecutive nonces) or all signed " +
          "(their nonces are already fixed); mixing the two cannot produce one consecutive run",
        { field: "tx_infos" },
      );
    }
    return submitBatch(this.#ctx, prepared as readonly UnsignedTx[], opts);
  }

  /**
   * Attach an externally produced EIP-191 signature and submit.
   *
   * The resume path for `L1SignatureRequiredError`: the SDK produced the exact message, an outside
   * wallet signed it, and this puts the 65-byte `r ‖ s ‖ v` result on the transaction. The
   * signature is over fields that include the nonce, so the transaction must already carry the
   * nonce it will be submitted with — pass it through {@link prepare} first, or supply an explicit
   * `nonce` and `apiKeyIndex`.
   *
   * @throws {LighterValidationError} `SIGNATURE_INVALID` if the signature is not `0x` + 130 hex.
   */
  async submitWithL1Signature(
    tx: UnsignedTx,
    sig: `0x${string}`,
    opts?: SendOpts,
  ): Promise<TxReceipt> {
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
      throw new LighterValidationError(
        "SIGNATURE_INVALID",
        "an L1 signature is 0x followed by 130 hex characters (r ‖ s ‖ v, 65 bytes)",
        { field: "L1Sig" },
      );
    }
    const withSig: UnsignedTx = Object.freeze({
      ...(tx as object),
      l1Sig: sig.toLowerCase(),
    }) as unknown as UnsignedTx;
    return this.send(withSig, opts);
  }

  /* ---- account state --------------------------------------------------------------------------- */

  /**
   * `GET /api/v1/account?by=index` for this account. **Never cached.**
   *
   * Balances, positions and available collateral are the three things that must not be served
   * stale (§8.2): a cached collateral figure is how an SDK talks a caller into an order that
   * liquidates them.
   */
  state(opts?: CallOptions): Promise<DetailedAccounts> {
    return this.#deps.rest.account.account(
      { by: "index", value: this.accountIndex.toString(10) },
      opts,
    );
  }

  /**
   * `GET /api/v1/accountsByL1Address` — every sub-account under one L1 address.
   *
   * The **master** account is the one with the smallest index (§6). Uncached, like everything else
   * about an account's state.
   */
  async accountsByL1Address(l1Address: string, opts?: CallOptions): Promise<SubAccounts> {
    if (typeof l1Address !== "string" || l1Address.length === 0) {
      throw new LighterValidationError(
        "L1_ADDRESS_INVALID",
        "an L1 address is required, as a 0x-prefixed hex string",
        { field: "l1_address" },
      );
    }
    return this.#deps.rest.account.accountsByL1Address({ l1_address: l1Address }, opts);
  }

  /* ---- lifecycle ------------------------------------------------------------------------------- */

  /**
   * Release what this account owns. Idempotent, and never rejects.
   *
   * An account holds no socket and no timer of its own — the transports belong to the client — so
   * this exists for symmetry and for `await using`, and it does **not** close the client's socket:
   * two accounts on one client would otherwise close each other's transport.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Backing method for `Symbol.asyncDispose`; see the attachment below the class. */
  disposeAsync(): Promise<void> {
    return this.close();
  }

  /* ---- internals ------------------------------------------------------------------------------- */

  /**
   * The shared options every builder gets: this account's index, a placeholder identity, the
   * caller's overrides, and the integrator attributes where the type accepts them.
   */
  #opts(txType: number, opts: RawTxOpts | undefined): TransactOpts {
    const attributes: TxAttributes | undefined =
      opts?.attributes ?? this.#integratorAttributes(txType);
    return {
      accountIndex: i64(this.accountIndex),
      // Placeholders. `prepare()` / `send()` overwrite both before hashing — see the module header.
      apiKeyIndex: this.#defaultKeyIndex(),
      nonce: PENDING_NONCE,
      ...(opts?.expiredAt !== undefined ? { expiredAt: i64(opts.expiredAt) } : {}),
      ...(attributes !== undefined ? { attributes } : {}),
      ...(opts?.strict !== undefined ? { strict: opts.strict } : {}),
      now: this.#deps.now,
    };
  }

  /** The first configured key. Only ever a placeholder; the lease chooses the real one. */
  #defaultKeyIndex(): U8 {
    const first: number | undefined = this.#ctx.keys.keys().next().value;
    return u8(first ?? 0);
  }

  /**
   * Integrator attribution, for the three transaction types that carry it.
   *
   * Attributes 2 and 3 are refused without attribute 1 by `validateAttributes`, and they may not be
   * combined with the self-trade modes — so this returns a map and lets that validator speak, rather
   * than duplicating the rule.
   */
  #integratorAttributes(txType: number): TxAttributes | undefined {
    const integrator: IntegratorConfig | undefined = this.#deps.integrator;
    if (integrator === undefined) return undefined;
    if (
      txType !== TxType.L2CreateOrder &&
      txType !== TxType.L2ModifyOrder &&
      txType !== TxType.L2CreateGroupedOrders
    ) {
      return undefined;
    }
    return {
      1: Number(integrator.accountIndex),
      ...(integrator.takerFee !== undefined ? { 2: integrator.takerFee } : {}),
      ...(integrator.makerFee !== undefined ? { 3: integrator.makerFee } : {}),
    };
  }

  /** Bind all twenty builders. Frozen: the surface is a capability, not a hook table. */
  #buildSurface(): RawTxSurface {
    const o = (txType: number, opts: RawTxOpts | undefined): TransactOpts => this.#opts(txType, opts);
    return Object.freeze({
      changePubKey: (req: ChangePubKeyRequest, opts?: RawTxOpts): ChangePubKeyTx =>
        buildChangePubKey(req, o(TxType.L2ChangePubKey, opts)),
      createSubAccount: (
        req: CreateSubAccountRequest = {},
        opts?: RawTxOpts,
      ): CreateSubAccountTx => buildCreateSubAccount(req, o(TxType.L2CreateSubAccount, opts)),
      createPublicPool: (req: CreatePublicPoolRequest, opts?: RawTxOpts): CreatePublicPoolTx =>
        buildCreatePublicPool(req, o(TxType.L2CreatePublicPool, opts)),
      updatePublicPool: (req: UpdatePublicPoolRequest, opts?: RawTxOpts): UpdatePublicPoolTx =>
        buildUpdatePublicPool(req, o(TxType.L2UpdatePublicPool, opts)),
      transfer: (req: TransferRequest, opts?: RawTxOpts): TransferTx =>
        buildTransfer(req, o(TxType.L2Transfer, opts)),
      withdraw: (req: WithdrawRequest, opts?: RawTxOpts): WithdrawTx =>
        buildWithdraw(req, o(TxType.L2Withdraw, opts)),
      createOrder: (req: CreateOrderRequest, opts?: RawTxOpts): CreateOrderTx =>
        buildCreateOrder(req, o(TxType.L2CreateOrder, opts)),
      cancelOrder: (req: CancelOrderRequest, opts?: RawTxOpts): CancelOrderTx =>
        buildCancelOrder(req, o(TxType.L2CancelOrder, opts)),
      cancelAllOrders: (req: CancelAllOrdersRequest, opts?: RawTxOpts): CancelAllOrdersTx =>
        buildCancelAllOrders(req, o(TxType.L2CancelAllOrders, opts)),
      modifyOrder: (req: ModifyOrderRequest, opts?: RawTxOpts): ModifyOrderTx =>
        buildModifyOrder(req, o(TxType.L2ModifyOrder, opts)),
      mintShares: (req: MintSharesRequest, opts?: RawTxOpts): MintSharesTx =>
        buildMintShares(req, o(TxType.L2MintShares, opts)),
      burnShares: (req: BurnSharesRequest, opts?: RawTxOpts): BurnSharesTx =>
        buildBurnShares(req, o(TxType.L2BurnShares, opts)),
      updateLeverage: (req: UpdateLeverageRequest, opts?: RawTxOpts): UpdateLeverageTx =>
        buildUpdateLeverage(req, o(TxType.L2UpdateLeverage, opts)),
      createGroupedOrders: (
        req: CreateGroupedOrdersRequest,
        opts?: RawTxOpts,
      ): CreateGroupedOrdersTx =>
        buildCreateGroupedOrders(req, o(TxType.L2CreateGroupedOrders, opts)),
      updateMargin: (req: UpdateMarginRequest, opts?: RawTxOpts): UpdateMarginTx =>
        buildUpdateMargin(req, o(TxType.L2UpdateMargin, opts)),
      stakeAssets: (req: StakeAssetsRequest, opts?: RawTxOpts): StakeAssetsTx =>
        buildStakeAssets(req, o(TxType.L2StakeAssets, opts)),
      unstakeAssets: (req: UnstakeAssetsRequest, opts?: RawTxOpts): UnstakeAssetsTx =>
        buildUnstakeAssets(req, o(TxType.L2UnstakeAssets, opts)),
      updateAccountConfig: (
        req: UpdateAccountConfigRequest,
        opts?: RawTxOpts,
      ): UpdateAccountConfigTx =>
        buildUpdateAccountConfig(req, o(TxType.L2UpdateAccountConfig, opts)),
      updateAccountAssetConfig: (
        req: UpdateAccountAssetConfigRequest,
        opts?: RawTxOpts,
      ): UpdateAccountAssetConfigTx =>
        buildUpdateAccountAssetConfig(req, o(TxType.L2UpdateAccountAssetConfig, opts)),
      approveIntegrator: (
        req: ApproveIntegratorRequest,
        opts?: RawTxOpts,
      ): ApproveIntegratorTx => buildApproveIntegrator(req, o(TxType.L2ApproveIntegrator, opts)),
    });
  }
}

/** Whether a transaction has already been through the signer. */
function isSigned(tx: UnsignedTx | SignedTx): tx is SignedTx {
  return (tx as { sig?: unknown }).sig instanceof Uint8Array;
}

/**
 * Parse an account's keys and hand back the map the submit context holds.
 *
 * Exported because `./lighter-client.ts` builds the context and this is the only validated way in.
 */
export function parseAccountKeys(
  keys: Record<number, string | Uint8Array>,
): ReadonlyMap<number, ApiKey> {
  return toKeyMap(keys);
}

/*
 * Explicit resource management, attached defensively — the same reasoning as `src/ws/subscription.ts`.
 *
 * `Symbol.asyncDispose` is `undefined` on Node 20 and older Safari, and a class body containing a
 * computed `[Symbol.asyncDispose]()` member throws `TypeError: Cannot convert undefined to a
 * property key` at *import* time there, taking the whole package down on a runtime we advertise.
 * `Symbol.asyncDispose ??= …` is not used: mutating a global at module scope is an import side
 * effect, and this package ships `"sideEffects": false`.
 */
const asyncDisposeSym: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;
if (typeof asyncDisposeSym === "symbol") {
  Object.defineProperty(LighterAccount.prototype, asyncDisposeSym, {
    value: function asyncDispose(this: LighterAccount): Promise<void> {
      return this.disposeAsync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}
