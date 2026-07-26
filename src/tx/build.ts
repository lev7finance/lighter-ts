/**
 * The twenty transaction builders: pure, synchronous, and the only place a transaction object is
 * created.
 *
 * ## What a builder is, and what it deliberately is not
 *
 * ```ts
 * const unsigned = buildCreateOrder(req, opts);   // this file — pure
 * const hash     = txHash(unsigned, CHAIN_ID.mainnet);
 * const signed   = signTx(unsigned, apiKey, CHAIN_ID.mainnet);
 * const body     = toTxInfo(signed);
 * ```
 *
 * A builder resolves the shared options, assembles a frozen record, runs the matching validator, and
 * returns. It does **not**:
 *
 * - reach a network, allocate a nonce, or look up a market — nonce management is L5's, and a builder
 *   that fetched one could not run offline;
 * - sign, or touch randomness — `crypto.getRandomValues` at module scope is forbidden on Cloudflare
 *   Workers (`docs/decisions.md` D2), and signing is a separate stage on purpose so the hash can be
 *   computed on one machine and signed on another;
 * - read the clock, except through the injected `opts.now` inside `resolveOpts`;
 * - normalise the payload. In particular {@link buildCreateGroupedOrders} does not sort,
 *   de-duplicate or reorder its legs: the leg fold is a left fold seeded with leg 0, so any
 *   reordering silently changes the transaction hash (`docs/protocol-notes.md` §4).
 *
 * ## The request/options split
 *
 * Every builder takes `(request, opts)`. `opts` carries what is true of *any* transaction from this
 * account — account index, api key index, nonce, expiry, attributes, strictness — and the request
 * carries the fields that belong to this transaction type alone. Each request type is derived from
 * its transaction type with `Omit`, so a field added to a transaction shape appears in the request
 * automatically and cannot drift.
 *
 * `L2Transfer` and `L2Withdraw` name their account field `fromAccountIndex`; it is still fed from
 * `opts.accountIndex`, because it is still the signing account.
 *
 * ## Validation is wired in, not optional
 *
 * Every builder calls its validator with the resolved `strict` flag before returning, so an invalid
 * transaction cannot reach a hash. `{ strict: false }` restores byte-identical reference behaviour
 * where the two differ (`spec/04-tx-types.md` §15) — the three `update_margin/negative_*` conformance
 * rows need it, and nothing else does.
 */

import { TxType } from "./enums.js";
import { type ResolvedTransactOpts, type TransactOpts, resolveOpts } from "./opts.js";
import type {
  AccountFamilyTx,
  ApproveIntegratorTx,
  BurnSharesTx,
  ChangePubKeyTx,
  CreatePublicPoolTx,
  CreateSubAccountTx,
  MintSharesTx,
  StakeAssetsTx,
  TransferTx,
  UnstakeAssetsTx,
  UpdateAccountAssetConfigTx,
  UpdateAccountConfigTx,
  UpdateLeverageTx,
  UpdateMarginTx,
  UpdatePublicPoolTx,
  WithdrawTx,
} from "./types/account.js";
import type {
  CancelAllOrdersTx,
  CancelOrderTx,
  CreateGroupedOrdersTx,
  CreateOrderTx,
  ModifyOrderTx,
  OrderTx,
} from "./types/orders.js";
import {
  validateApproveIntegrator,
  validateBurnShares,
  validateChangePubKey,
  validateCreatePublicPool,
  validateCreateSubAccount,
  validateMintShares,
  validateStakeAssets,
  validateTransfer,
  validateUnstakeAssets,
  validateUpdateAccountAssetConfig,
  validateUpdateAccountConfig,
  validateUpdateLeverage,
  validateUpdateMargin,
  validateUpdatePublicPool,
  validateWithdraw,
} from "./validate/account.js";
import { validateCreateGroupedOrders } from "./validate/grouped.js";
import {
  validateCancelAllOrders,
  validateCancelOrder,
  validateCreateOrder,
  validateModifyOrder,
} from "./validate/orders.js";

/* -------------------------------------------------------------------------------------------------
 * The union, and the request projection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every transaction this SDK can build: the fifteen account-family shapes and the five order-family
 * shapes, discriminated on the numeric `type`.
 *
 * The discriminant is simultaneously the TypeScript tag, the `tx_type` of the submission envelope
 * and the second element of the transaction hash, so `switch (tx.type)` narrows exhaustively and
 * there is no name↔code table to keep in sync.
 */
export type UnsignedTx = AccountFamilyTx | OrderTx;

/** An {@link UnsignedTx} that has been through `signTx` and can therefore be serialised. */
export type SignedTx = UnsignedTx & { readonly sig: Uint8Array };

/**
 * The properties a builder supplies from {@link TransactOpts} rather than from the request.
 *
 * `fromAccountIndex` is in the list for the two types that spell the signing account that way; on
 * the other eighteen the key simply is not present and `Omit` ignores it.
 */
type BuilderSupplied =
  | "type"
  | "accountIndex"
  | "fromAccountIndex"
  | "apiKeyIndex"
  | "nonce"
  | "expiredAt"
  | "attributes"
  | "sig";

/** The per-type half of a builder's input: everything the shared options do not already carry. */
type Request<T> = Omit<T, BuilderSupplied>;

/* -------------------------------------------------------------------------------------------------
 * Request types — one per builder, derived so they cannot drift from the transaction shapes
 * ---------------------------------------------------------------------------------------------- */

/** {@link buildChangePubKey}. `pubKey` is exactly 40 bytes; `l1Sig` is attached later, by `src/tx/l1`. */
export type ChangePubKeyRequest = Request<ChangePubKeyTx>;
/** {@link buildCreateSubAccount}. Empty — the transaction is entirely account, key, nonce and expiry. */
export type CreateSubAccountRequest = Request<CreateSubAccountTx>;
/** {@link buildCreatePublicPool}. */
export type CreatePublicPoolRequest = Request<CreatePublicPoolTx>;
/** {@link buildUpdatePublicPool}. */
export type UpdatePublicPoolRequest = Request<UpdatePublicPoolTx>;
/** {@link buildTransfer}. `memo` is exactly 32 bytes — see `memoFromHex` / `memoFromUtf8`. */
export type TransferRequest = Request<TransferTx>;
/** {@link buildWithdraw}. */
export type WithdrawRequest = Request<WithdrawTx>;
/** {@link buildCreateOrder}. The ten `OrderInfo` fields, flattened, with `type` renamed `orderType`. */
export type CreateOrderRequest = Request<CreateOrderTx>;
/** {@link buildCancelOrder}. */
export type CancelOrderRequest = Request<CancelOrderTx>;
/** {@link buildCancelAllOrders}. */
export type CancelAllOrdersRequest = Request<CancelAllOrdersTx>;
/** {@link buildModifyOrder}. */
export type ModifyOrderRequest = Request<ModifyOrderTx>;
/** {@link buildMintShares}. */
export type MintSharesRequest = Request<MintSharesTx>;
/** {@link buildBurnShares}. */
export type BurnSharesRequest = Request<BurnSharesTx>;
/** {@link buildUpdateLeverage}. */
export type UpdateLeverageRequest = Request<UpdateLeverageTx>;
/** {@link buildCreateGroupedOrders}. Leg order is load-bearing and is never normalised. */
export type CreateGroupedOrdersRequest = Request<CreateGroupedOrdersTx>;
/** {@link buildUpdateMargin}. */
export type UpdateMarginRequest = Request<UpdateMarginTx>;
/** {@link buildStakeAssets}. */
export type StakeAssetsRequest = Request<StakeAssetsTx>;
/** {@link buildUnstakeAssets}. */
export type UnstakeAssetsRequest = Request<UnstakeAssetsTx>;
/** {@link buildUpdateAccountConfig}. */
export type UpdateAccountConfigRequest = Request<UpdateAccountConfigTx>;
/** {@link buildUpdateAccountAssetConfig}. */
export type UpdateAccountAssetConfigRequest = Request<UpdateAccountAssetConfigTx>;
/** {@link buildApproveIntegrator}. */
export type ApproveIntegratorRequest = Request<ApproveIntegratorTx>;

/* -------------------------------------------------------------------------------------------------
 * 8 / 9 — key rotation and sub-accounts
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2ChangePubKey` — code 8. Register or rotate the ECgFp5 public key for `(account, apiKey)`.
 *
 * The 40-byte key is **copied**, so a later mutation of the caller's array cannot change a
 * transaction that has already been hashed. Its limbs are reduced at absorption time rather than
 * rejected — real public keys carry limbs above the modulus (`docs/protocol-notes.md` §1) — while
 * the JSON carries these original bytes as base64.
 *
 * Needs an EIP-191 `personal_sign` over the §10.1 template, attached separately by `src/tx/l1`.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildChangePubKey(req: ChangePubKeyRequest, opts: TransactOpts): ChangePubKeyTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: ChangePubKeyTx = Object.freeze({
    ...req,
    type: TxType.L2ChangePubKey,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    pubKey: req.pubKey.slice(),
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateChangePubKey(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2CreateSubAccount` — code 9. Create a sub-account under a master account.
 *
 * The account index is bounded by the **master** range, `[-1, 2^47−1]`, not the general one. The
 * flow needs an L1 signature (`docs/decisions.md` D6) but the transaction body has nowhere to put
 * one, so this type has no `l1Sig` field at all.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildCreateSubAccount(
  req: CreateSubAccountRequest,
  opts: TransactOpts,
): CreateSubAccountTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CreateSubAccountTx = Object.freeze({
    ...req,
    type: TxType.L2CreateSubAccount,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCreateSubAccount(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 10 / 11 — public pools
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2CreatePublicPool` — code 10.
 *
 * Under the default `strict: true` the initial share supply must be at least `1000000`, which is
 * what the reference's own error message claims while its code only checks `<= 0`
 * (`spec/04-tx-types.md` §15 row 5).
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildCreatePublicPool(
  req: CreatePublicPoolRequest,
  opts: TransactOpts,
): CreatePublicPoolTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CreatePublicPoolTx = Object.freeze({
    ...req,
    type: TxType.L2CreatePublicPool,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCreatePublicPool(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2UpdatePublicPool` — code 11. Change a pool's status, operator fee and minimum operator share.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildUpdatePublicPool(
  req: UpdatePublicPoolRequest,
  opts: TransactOpts,
): UpdatePublicPoolTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UpdatePublicPoolTx = Object.freeze({
    ...req,
    type: TxType.L2UpdatePublicPool,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUpdatePublicPool(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 12 / 13 — value movement
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2Transfer` — code 12. Move an asset between accounts and/or between the perps and spot routes.
 *
 * `amount` and `usdcFee` are each absorbed as two elements, low half then high half, with the
 * logical shift. The 32-byte `memo` is absorbed as **none** — it is bound to the transaction only by
 * the L1 signature — and is copied here so a later mutation cannot change what was signed.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated, including
 * `MEMO_LENGTH_INVALID` for a memo that is not exactly 32 bytes.
 */
export function buildTransfer(req: TransferRequest, opts: TransactOpts): TransferTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: TransferTx = Object.freeze({
    ...req,
    type: TxType.L2Transfer,
    fromAccountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    memo: req.memo.slice(),
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateTransfer(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2Withdraw` — code 13. Withdraw an asset to L1.
 *
 * `amount` is `uint64` here and `int64` on {@link buildTransfer}; both take the logical split, so
 * the declared signedness changes the bounds and not one hashed bit.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildWithdraw(req: WithdrawRequest, opts: TransactOpts): WithdrawTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: WithdrawTx = Object.freeze({
    ...req,
    type: TxType.L2Withdraw,
    fromAccountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateWithdraw(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 14 / 15 / 16 / 17 / 28 — the order family
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2CreateOrder` — code 14. Sixteen hash elements, exactly two full sponge blocks.
 *
 * `orderType` is the *order* type (limit, market, stop-loss, …); the transaction's own `type` is
 * `14` and never reaches the JSON, where the order type is emitted under the key `Type`.
 *
 * `baseAmount: 0n` is legal on a reduce-only order and only there — that is how a position-tied
 * stop-loss is expressed. `price` has no nil sentinel: a market order sends its slippage bound as a
 * price.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildCreateOrder(req: CreateOrderRequest, opts: TransactOpts): CreateOrderTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CreateOrderTx = Object.freeze({
    ...req,
    type: TxType.L2CreateOrder,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCreateOrder(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2CancelOrder` — code 15.
 *
 * `index` is either a client order index (`[1, 2^48−1]`) or a sequencer order index
 * (`[2^48, 2^60−1]`), disambiguated by magnitude — one `int64` element either way.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildCancelOrder(req: CancelOrderRequest, opts: TransactOpts): CancelOrderTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CancelOrderTx = Object.freeze({
    ...req,
    type: TxType.L2CancelOrder,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCancelOrder(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2CancelAllOrders` — code 16.
 *
 * The one type on which `apiKeyIndex = 255` (`NilApiKeyIndex`) is legal; it means "across every API
 * key on the account". Per-market cancel-all is expressed through attribute type 5, not a struct
 * field, and is only valid alongside `ImmediateCancelAll`.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildCancelAllOrders(
  req: CancelAllOrdersRequest,
  opts: TransactOpts,
): CancelAllOrdersTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CancelAllOrdersTx = Object.freeze({
    ...req,
    type: TxType.L2CancelAllOrders,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCancelAllOrders(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2ModifyOrder` — code 17. Eleven hash elements, and the absences are the interesting part: no
 * side, no time-in-force, no expiry. A modification changes size, price and trigger only.
 *
 * `baseAmount: 0n` here means "leave the size unchanged" and is always legal — unlike code 14.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildModifyOrder(req: ModifyOrderRequest, opts: TransactOpts): ModifyOrderTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: ModifyOrderTx = Object.freeze({
    ...req,
    type: TxType.L2ModifyOrder,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateModifyOrder(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2CreateGroupedOrders` — code 28. OTO, OCO and OTOCO brackets.
 *
 * **The legs reach the hasher in the caller's order.** The per-leg hashes are folded left to right
 * from leg 0, so sorting, de-duplicating or "normalising" the array would produce a different, valid
 * -looking transaction hash and a signature the sequencer rejects. The array is copied — never
 * reordered — so that a later mutation of the caller's array cannot change what was signed.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated, including the
 * per-grouping leg-count and side rules of §8.5.
 */
export function buildCreateGroupedOrders(
  req: CreateGroupedOrdersRequest,
  opts: TransactOpts,
): CreateGroupedOrdersTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: CreateGroupedOrdersTx = Object.freeze({
    ...req,
    type: TxType.L2CreateGroupedOrders,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    // `slice()`, never `sort()`: a copy in the caller's order.
    orders: Object.freeze(req.orders.slice()),
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateCreateGroupedOrders(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — public-pool shares
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2MintShares` — code 18. Buy into a public pool.
 *
 * `publicPoolIndex` is an account index in the **sub-account** range, `>= 2^47`.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildMintShares(req: MintSharesRequest, opts: TransactOpts): MintSharesTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: MintSharesTx = Object.freeze({
    ...req,
    type: TxType.L2MintShares,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateMintShares(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2BurnShares` — code 19. Redeem public-pool shares. Structurally code 18 with a different code.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildBurnShares(req: BurnSharesRequest, opts: TransactOpts): BurnSharesTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: BurnSharesTx = Object.freeze({
    ...req,
    type: TxType.L2BurnShares,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateBurnShares(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 20 / 29 — margin
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2UpdateLeverage` — code 20. Set a market's initial margin fraction and margin mode.
 *
 * Leverage is `10000 / initialMarginFraction`, in basis points. The reference's only market rule is
 * `!== NilMarketIndex`; `strict: true` additionally requires a perps market (§15 row 6).
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildUpdateLeverage(
  req: UpdateLeverageRequest,
  opts: TransactOpts,
): UpdateLeverageTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UpdateLeverageTx = Object.freeze({
    ...req,
    type: TxType.L2UpdateLeverage,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUpdateLeverage(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2UpdateMargin` — code 29. Add or remove isolated margin for a perps position.
 *
 * `usdcAmount` is the only field in the protocol absorbed with an **arithmetic** high-word shift, so
 * a negative value propagates its sign into the high half. The reference has no lower bound on it;
 * this SDK rejects negatives under the default `strict: true` and hashes them byte-identically under
 * `{ strict: false }`, which is exactly what the three `update_margin/negative_*` conformance rows
 * replay.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated, including
 * `NEGATIVE_MARGIN_AMOUNT` in strict mode.
 */
export function buildUpdateMargin(req: UpdateMarginRequest, opts: TransactOpts): UpdateMarginTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UpdateMarginTx = Object.freeze({
    ...req,
    type: TxType.L2UpdateMargin,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUpdateMargin(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 35 / 36 — staking
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2StakeAssets` — code 35. `stakingPoolIndex` sits in the sub-account range, `>= 2^47`.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildStakeAssets(req: StakeAssetsRequest, opts: TransactOpts): StakeAssetsTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: StakeAssetsTx = Object.freeze({
    ...req,
    type: TxType.L2StakeAssets,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateStakeAssets(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2UnstakeAssets` — code 36. Structurally code 35 with a different code.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated. Note that the reference
 * reports the `PUBLIC_POOL_INDEX_*` identities on this path where code 35 reports
 * `STAKING_POOL_INDEX_*`; that divergence is reproduced deliberately.
 */
export function buildUnstakeAssets(req: UnstakeAssetsRequest, opts: TransactOpts): UnstakeAssetsTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UnstakeAssetsTx = Object.freeze({
    ...req,
    type: TxType.L2UnstakeAssets,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUnstakeAssets(tx, { strict: o.strict });
  return tx;
}

/* -------------------------------------------------------------------------------------------------
 * 41 / 42 / 45 — account configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2UpdateAccountConfig` — code 41. Switch between standard and unified trading.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildUpdateAccountConfig(
  req: UpdateAccountConfigRequest,
  opts: TransactOpts,
): UpdateAccountConfigTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UpdateAccountConfigTx = Object.freeze({
    ...req,
    type: TxType.L2UpdateAccountConfig,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUpdateAccountConfig(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2UpdateAccountAssetConfig` — code 42. Opt one asset in or out of being used as margin.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildUpdateAccountAssetConfig(
  req: UpdateAccountAssetConfigRequest,
  opts: TransactOpts,
): UpdateAccountAssetConfigTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: UpdateAccountAssetConfigTx = Object.freeze({
    ...req,
    type: TxType.L2UpdateAccountAssetConfig,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateUpdateAccountAssetConfig(tx, { strict: o.strict });
  return tx;
}

/**
 * `L2ApproveIntegrator` — code 45. Authorise an integrator to charge fees, up to explicit caps.
 *
 * `approvalExpiry === 0n` is a revocation and requires all four fee caps to be zero. Needs an
 * EIP-191 signature over the §10.3 template, attached separately by `src/tx/l1`.
 *
 * @throws {LighterValidationError} the §12 code of the first rule violated.
 */
export function buildApproveIntegrator(
  req: ApproveIntegratorRequest,
  opts: TransactOpts,
): ApproveIntegratorTx {
  const o: ResolvedTransactOpts = resolveOpts(opts);
  const tx: ApproveIntegratorTx = Object.freeze({
    ...req,
    type: TxType.L2ApproveIntegrator,
    accountIndex: o.accountIndex,
    apiKeyIndex: o.apiKeyIndex,
    nonce: o.nonce,
    expiredAt: o.expiredAt,
    attributes: o.attributes,
  });
  validateApproveIntegrator(tx, { strict: o.strict });
  return tx;
}
