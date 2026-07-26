/**
 * Validators for the fifteen non-order transaction types — codes 8, 9, 10, 11, 12, 13, 18, 19, 20,
 * 29, 35, 36, 41, 42 and 45 (`spec/04-tx-types.md` §7.1–§7.6, §7.13–§7.19).
 *
 * A validator throws {@link LighterValidationError} on the **first** rule it trips, carrying the
 * §12 `code`, the offending `field` and the `txType`. It returns `void` on success. Nothing here
 * mutates, allocates a transaction, or touches the clock.
 *
 * ## The three things that make this file look wrong and are not
 *
 * 1. **Three different account-index ceilings.** Most types allow `[-1, 2^48−2]`
 *    ({@link MAX_ACCOUNT_INDEX}); `L2CreateSubAccount` (9) and `L2CreatePublicPool` (10) allow only
 *    `[-1, 2^47−1]` ({@link MAX_MASTER_ACCOUNT_INDEX}) because the signer must be a *master*
 *    account. The floor is `-1` everywhere, and `-1` is a legal account index rather than an
 *    absence marker (`docs/protocol-notes.md` §3.1).
 * 2. **Two different pool-index floors.** `L2UpdatePublicPool` (11) bounds `PublicPoolIndex` from
 *    `-1`; `L2MintShares` (18), `L2BurnShares` (19), `L2StakeAssets` (35) and `L2UnstakeAssets`
 *    (36) bound their pool index from `2^47` ({@link MIN_SUB_ACCOUNT_INDEX}), because pools live in
 *    the sub-account range (`docs/protocol-notes.md` §11). Unifying them would accept transactions
 *    the sequencer refuses and refuse ones it accepts.
 * 3. **Several error identities name the wrong field.** They are copy-pastes in the reference and
 *    they are *observable*, so they are part of parity and are reproduced verbatim, message text
 *    included. Each site carries a comment naming the spec section; do not "fix" them.
 *
 * ## `strict`
 *
 * Three checks in this file are tightenings this SDK adds on top of the reference
 * (`spec/04-tx-types.md` §15 rows 5, 6 and 7). `{ strict: false }` removes exactly those three and
 * nothing else, which is what lets the `update_margin/negative_*` conformance vectors replay
 * byte-identically:
 *
 * | # | Reference | `strict !== false` |
 * | --- | --- | --- |
 * | 5 | `L2CreatePublicPool.InitialTotalShares <= 0` rejected | `< 1000000` rejected |
 * | 6 | `L2UpdateLeverage.MarketIndex` only `!== 255` | perps range `[0, 254]` enforced |
 * | 7 | `L2UpdateMargin.USDCAmount` negative accepted | negative rejected |
 *
 * {@link MEMO_LENGTH_INVALID} is deliberately *not* one of them: a wrong-length memo silently
 * changes the L1 message body, so it is structural and is rejected under every option set.
 *
 * ## Locality
 *
 * The bound helpers below are intentionally private to this module. `src/tx/validate/orders.ts`
 * keeps its own copies; a shared `validate/common.ts` would couple two independently-owned
 * validators to one another's check ordering, which is the part of this file that is normative.
 */

import { validateAttributes } from "../attributes.js";
import {
  FEE_TICK,
  MARGIN_FRACTION_TICK,
  MAX_ACCOUNT_INDEX,
  MAX_API_KEY_INDEX,
  MAX_ASSET_INDEX,
  MAX_EXCHANGE_USDC,
  MAX_INITIAL_TOTAL_SHARES,
  MAX_MASTER_ACCOUNT_INDEX,
  MAX_PERPS_MARKET_INDEX,
  MAX_POOL_SHARES_TO_MINT_OR_BURN,
  MAX_STAKING_SHARES_TO_MINT_OR_BURN,
  MAX_TIMESTAMP,
  MAX_TRANSFER_AMOUNT,
  MAX_WITHDRAWAL_AMOUNT,
  MEMO_LENGTH,
  MIN_ACCOUNT_INDEX,
  MIN_API_KEY_INDEX,
  MIN_ASSET_INDEX,
  MIN_INITIAL_TOTAL_SHARES,
  MIN_NONCE,
  MIN_PERPS_MARKET_INDEX,
  MIN_POOL_SHARES_TO_MINT_OR_BURN,
  MIN_STAKING_SHARES_TO_MINT_OR_BURN,
  MIN_SUB_ACCOUNT_INDEX,
  MIN_TRANSFER_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
  NIL_MARKET_INDEX,
  PUBKEY_LENGTH,
  SHARE_TICK,
} from "../constants.js";
import { TxType } from "../enums.js";
import type { LighterValidationCode } from "../../errors.js";
import { LighterValidationError } from "../../errors.js";
import type {
  ApproveIntegratorTx,
  BaseAccountTx,
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
} from "../types/account.js";

/* -------------------------------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------------------------- */

/** Options accepted by every validator in this module. */
export interface AccountValidateOptions {
  /**
   * Apply this SDK's three tightenings (`spec/04-tx-types.md` §15 rows 5–7). Default `true`.
   *
   * `false` restores byte-identical reference behaviour and nothing else — every other rule stays
   * on, because every other rule is one the sequencer enforces.
   */
  readonly strict?: boolean | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Messages — reproduced verbatim from `spec/04-tx-types.md` §12
 *
 * Parity is on the code *and* the text, so a stale reference message stays stale here. The clearest
 * example: `PUBLIC_POOL_INDEX_TOO_LOW` says "less than -1" and is raised by types 18, 19 and 36,
 * where the actual bound is 140737488355328. That is the reference's message; changing it would be
 * a divergence dressed up as a correction.
 * ---------------------------------------------------------------------------------------------- */

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ACCOUNT_INDEX_TOO_LOW: "AccountIndex should not be less than -1",
  ACCOUNT_INDEX_TOO_HIGH: "AccountIndex should not be larger than 281474976710654",
  ACCOUNT_TRADING_MODE_INVALID: "AccountTradingMode is invalid",
  API_KEY_INDEX_TOO_LOW: "ApiKeyIndex should not be less than 0",
  API_KEY_INDEX_TOO_HIGH: "ApiKeyIndex should not be larger than 254",
  APPROVAL_EXPIRY_INVALID: "ApprovalExpiry is invalid",
  APPROVAL_EXPIRY_ZERO_ON_REVOCATION:
    "ApprovalExpiry should be zero when revoking integrator approval",
  ASSET_INDEX_TOO_LOW: "AssetIndex should not be less than 1",
  ASSET_INDEX_TOO_HIGH: "AssetIndex should not be larger than 62",
  EXPIRED_AT_INVALID: "ExpiredAt is invalid",
  FEE_TOO_HIGH: "MarketFee should not be larger than 1000000",
  FROM_ACCOUNT_INDEX_TOO_LOW: "FromAccountIndex should not be less than -1",
  FROM_ACCOUNT_INDEX_TOO_HIGH: "FromAccountIndex should not be larger than 281474976710654",
  IMF_TOO_LOW: "InitialMarginFraction should not be less than 0",
  IMF_TOO_HIGH: "InitialMarginFraction should not be larger than 10000",
  INTEGRATOR_ACCOUNT_INDEX_TOO_LOW: "IntegratorAccountIndex should not be less than -1",
  INTEGRATOR_ACCOUNT_INDEX_TOO_HIGH:
    "IntegratorAccountIndex should not be larger than 281474976710654",
  MARGIN_MODE_INVALID: "MarginMode is not valid",
  MARKET_INDEX_INVALID: "MarketIndex is not valid",
  NONCE_TOO_LOW: "AccountNonce should not be less than 0",
  POOL_BURN_AMOUNT_TOO_LOW: "PoolBurnShareAmount should be larger than 1",
  POOL_BURN_AMOUNT_TOO_HIGH: "PoolBurnShareAmount should not be larger than 1152921504606846975",
  POOL_INITIAL_SHARES_TOO_LOW: "PoolInitialTotalShares should be larger than 1000000",
  POOL_INITIAL_SHARES_TOO_HIGH: "PoolInitialTotalShares should not be larger than 1000000000000",
  POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH: "PoolMinOperatorShareRate should not be larger than 10000",
  POOL_MINT_AMOUNT_TOO_LOW: "PoolMintShareAmount should be larger than 1",
  POOL_MINT_AMOUNT_TOO_HIGH: "PoolMintShareAmount should not be larger than 1152921504606846975",
  POOL_OPERATOR_FEE_INVALID: "PoolOperatorFee should be larger than 0 and not larger than 1000000",
  POOL_STATUS_INVALID: "PoolStatus should be either 0 or 1",
  PUBKEY_INVALID: "PubKey is invalid",
  PUBLIC_POOL_INDEX_TOO_LOW: "PublicPoolIndex should not be less than -1",
  PUBLIC_POOL_INDEX_TOO_HIGH: "PublicPoolIndex should not be larger than 281474976710654",
  ROUTE_TYPE_INVALID: "RouteType is invalid",
  STAKE_AMOUNT_TOO_LOW: "StakeAssetsAmount should be larger than 1",
  STAKE_AMOUNT_TOO_HIGH: "StakeAssetsAmount should not be larger than 1152921504606846975",
  STAKING_POOL_INDEX_TOO_LOW: "StakingPoolIndex should not be less than 140737488355328",
  STAKING_POOL_INDEX_TOO_HIGH: "StakingPoolIndex should not be larger than 281474976710654",
  TRANSFER_AMOUNT_TOO_LOW: "TransferAmount should be larger than 1",
  TRANSFER_AMOUNT_TOO_HIGH: "TransferAmount should not be larger than 1152921504606846975",
  TRANSFER_FEE_NEGATIVE: "TransferFee should not be negative",
  TRANSFER_FEE_TOO_HIGH: "TransferFee should not be larger than 1152921504606846975",
  UNSTAKE_AMOUNT_TOO_LOW: "UnstakeAssetsAmount should be larger than 1",
  UNSTAKE_AMOUNT_TOO_HIGH: "UnstakeAssetsAmount should not be larger than 1152921504606846975",
  UPDATE_MARGIN_DIRECTION_INVALID: "Margin movement direction is not valid",
  WITHDRAWAL_AMOUNT_TOO_LOW: "WithdrawalAmount should be larger than 1",
  WITHDRAWAL_AMOUNT_TOO_HIGH: "WithdrawalAmount should not be larger than 1152921504606846975",

  // Introduced by this SDK (§12, "New codes introduced by this SDK").
  MEMO_LENGTH_INVALID: "Memo must be exactly 32 bytes",
  NEGATIVE_MARGIN_AMOUNT: "USDCAmount should not be negative",
});

/* -------------------------------------------------------------------------------------------------
 * Local helpers. Private on purpose — see the module header.
 * ---------------------------------------------------------------------------------------------- */

/** Throw the §12 error for `code`, with its verbatim message. */
function fail(
  code: LighterValidationCode,
  field: string,
  txType: number,
  bound?: bigint | number,
): never {
  const message: string | undefined = MESSAGES[code];
  throw new LighterValidationError(
    code,
    message ?? code,
    bound === undefined ? { field, txType } : { field, txType, bound },
  );
}

/**
 * Account-index bounds. The floor is always {@link MIN_ACCOUNT_INDEX} (`-1`, legal); the ceiling
 * and the reported error identity are per transaction type and are passed in explicitly, because
 * the reference does not use one identity consistently.
 */
function checkAccountIndex(
  value: bigint,
  max: bigint,
  lowCode: LighterValidationCode,
  highCode: LighterValidationCode,
  field: string,
  txType: number,
): void {
  if (value < MIN_ACCOUNT_INDEX) fail(lowCode, field, txType, MIN_ACCOUNT_INDEX);
  if (value > max) fail(highCode, field, txType, max);
}

/** API-key bounds, `[0, 254]`. `255` (`NilApiKeyIndex`) is legal only for `L2CancelAllOrders`. */
function checkApiKeyIndex(value: number, txType: number): void {
  if (value < MIN_API_KEY_INDEX) fail("API_KEY_INDEX_TOO_LOW", "ApiKeyIndex", txType, MIN_API_KEY_INDEX);
  if (value > MAX_API_KEY_INDEX) {
    fail("API_KEY_INDEX_TOO_HIGH", "ApiKeyIndex", txType, MAX_API_KEY_INDEX);
  }
}

/** Asset id bounds, `[1, 62]`. `0` is `NilAssetIndex` and is rejected. */
function checkAssetIndex(value: number, txType: number): void {
  if (value < MIN_ASSET_INDEX) fail("ASSET_INDEX_TOO_LOW", "AssetIndex", txType, MIN_ASSET_INDEX);
  if (value > MAX_ASSET_INDEX) fail("ASSET_INDEX_TOO_HIGH", "AssetIndex", txType, MAX_ASSET_INDEX);
}

/** `{0 perps, 1 spot}`. */
function checkRouteType(value: number, field: string, txType: number): void {
  if (value !== 0 && value !== 1) fail("ROUTE_TYPE_INVALID", field, txType);
}

/** Operator cut in millionths, `[0, 1000000]`. Both directions share one error identity. */
function checkOperatorFee(value: bigint, txType: number): void {
  if (value < 0n || value > BigInt(FEE_TICK)) {
    fail("POOL_OPERATOR_FEE_INVALID", "OperatorFee", txType, BigInt(FEE_TICK));
  }
}

/** Minimum operator share rate, basis points. Only the ceiling is checked by the reference. */
function checkMinOperatorShareRate(value: number, txType: number): void {
  if (value > SHARE_TICK) {
    fail("POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH", "MinOperatorShareRate", txType, SHARE_TICK);
  }
}

/**
 * The universal tail (`spec/04-tx-types.md` §7): nonce, then expiredAt, checked **last** on every
 * type in this module.
 *
 * `MAX_TIMESTAMP` is `2^48−1` while `MAX_ACCOUNT_INDEX` is `2^48−2`. Adjacent constants, different
 * values; they are not interchangeable.
 */
function checkTail(tx: BaseAccountTx, txType: number): void {
  if (tx.nonce < MIN_NONCE) fail("NONCE_TOO_LOW", "Nonce", txType, MIN_NONCE);
  if (tx.expiredAt < 0n || tx.expiredAt > MAX_TIMESTAMP) {
    fail("EXPIRED_AT_INVALID", "ExpiredAt", txType, MAX_TIMESTAMP);
  }
}

/** `opts.strict` defaults to `true`; only an explicit `false` turns the tightenings off. */
function isStrict(opts?: AccountValidateOptions): boolean {
  return opts?.strict !== false;
}

/* -------------------------------------------------------------------------------------------------
 * 8 — L2ChangePubKey (§7.1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a public-key rotation — code 8.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateChangePubKey(tx: ChangePubKeyTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2ChangePubKey;
  validateAttributes(tx.attributes);
  // §7.1: the field is `AccountIndex`, the error is the *From*-flavoured one. Copy-paste in the
  // reference, observable, therefore reproduced (ADR-13). Do not "correct" this.
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // Exactly 40 bytes. No canonical-range check on the five limbs: real keys carry limbs above the
  // modulus and are reduced at absorption time (`spec/04-tx-types.md` §1.4).
  if (tx.pubKey.length !== PUBKEY_LENGTH) fail("PUBKEY_INVALID", "PubKey", txType, PUBKEY_LENGTH);
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 9 — L2CreateSubAccount (§7.2)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a sub-account creation — code 9.
 *
 * The ceiling is {@link MAX_MASTER_ACCOUNT_INDEX} (`2^47−1`), not {@link MAX_ACCOUNT_INDEX}: only a
 * master account may create a sub-account. The error message still quotes `281474976710654`,
 * because the reference reuses the same sentinel.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateCreateSubAccount(
  tx: CreateSubAccountTx,
  _opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2CreateSubAccount;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_MASTER_ACCOUNT_INDEX, // master range — narrower than every other type except code 10
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 10 — L2CreatePublicPool (§7.3)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a public-pool creation — code 10.
 *
 * Under `{ strict: false }` the initial-share floor is the reference's `<= 0`; otherwise it is
 * {@link MIN_INITIAL_TOTAL_SHARES}, which is what the reference's own error message already claims
 * (§15 row 5).
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateCreatePublicPool(
  tx: CreatePublicPoolTx,
  opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2CreatePublicPool;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_MASTER_ACCOUNT_INDEX, // master range — the pool operator must be a master account
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkOperatorFee(tx.operatorFee, txType);
  if (isStrict(opts)) {
    if (tx.initialTotalShares < MIN_INITIAL_TOTAL_SHARES) {
      fail("POOL_INITIAL_SHARES_TOO_LOW", "InitialTotalShares", txType, MIN_INITIAL_TOTAL_SHARES);
    }
  } else if (tx.initialTotalShares <= 0n) {
    // Reference behaviour: the check is `<= 0` even though the message names 1000000 (§15 row 5).
    fail("POOL_INITIAL_SHARES_TOO_LOW", "InitialTotalShares", txType, 0n);
  }
  if (tx.initialTotalShares > MAX_INITIAL_TOTAL_SHARES) {
    fail("POOL_INITIAL_SHARES_TOO_HIGH", "InitialTotalShares", txType, MAX_INITIAL_TOTAL_SHARES);
  }
  checkMinOperatorShareRate(tx.minOperatorShareRate, txType);
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 11 — L2UpdatePublicPool (§7.4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a public-pool update — code 11.
 *
 * `PublicPoolIndex` is bounded from `-1` here and from `2^47` on codes 18/19/35/36. That asymmetry
 * is in the reference and is verified; see the module header.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUpdatePublicPool(
  tx: UpdatePublicPoolTx,
  _opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2UpdatePublicPool;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // §7.4: floor is MinAccountIndex (-1) — NOT MinSubAccountIndex. Codes 18/19/35/36 use 2^47.
  if (tx.publicPoolIndex < MIN_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_LOW", "PublicPoolIndex", txType, MIN_ACCOUNT_INDEX);
  }
  if (tx.publicPoolIndex > MAX_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_HIGH", "PublicPoolIndex", txType, MAX_ACCOUNT_INDEX);
  }
  if (tx.status !== 0 && tx.status !== 1) fail("POOL_STATUS_INVALID", "Status", txType);
  checkOperatorFee(tx.operatorFee, txType);
  checkMinOperatorShareRate(tx.minOperatorShareRate, txType);
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 12 — L2Transfer (§7.5)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a transfer — code 12.
 *
 * The amount and fee bounds are asymmetric on purpose: `Amount <= 0` is rejected while
 * `USDCFee === 0` is legal, so a zero-fee transfer of one base unit passes.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateTransfer(tx: TransferTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2Transfer;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.fromAccountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "FromAccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkAccountIndex(
    tx.toAccountIndex,
    MAX_ACCOUNT_INDEX,
    "TO_ACCOUNT_INDEX_TOO_LOW",
    "TO_ACCOUNT_INDEX_TOO_HIGH",
    "ToAccountIndex",
    txType,
  );
  checkAssetIndex(tx.assetIndex, txType);
  checkRouteType(tx.fromRouteType, "FromRouteType", txType);
  checkRouteType(tx.toRouteType, "ToRouteType", txType);
  if (tx.amount < MIN_TRANSFER_AMOUNT) {
    fail("TRANSFER_AMOUNT_TOO_LOW", "Amount", txType, MIN_TRANSFER_AMOUNT);
  }
  if (tx.amount > MAX_TRANSFER_AMOUNT) {
    fail("TRANSFER_AMOUNT_TOO_HIGH", "Amount", txType, MAX_TRANSFER_AMOUNT);
  }
  // A zero fee is legal; only a negative one is not.
  if (tx.usdcFee < 0n) fail("TRANSFER_FEE_NEGATIVE", "USDCFee", txType, 0n);
  if (tx.usdcFee > MAX_EXCHANGE_USDC) {
    fail("TRANSFER_FEE_TOO_HIGH", "USDCFee", txType, MAX_EXCHANGE_USDC);
  }
  // Structural, not a strict-mode tightening: the memo is absent from the L2 hash but present in
  // the L1 message body, so a wrong length silently changes what the user signed (§9.2).
  if (tx.memo.length !== MEMO_LENGTH) fail("MEMO_LENGTH_INVALID", "Memo", txType, MEMO_LENGTH);
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 13 — L2Withdraw (§7.6)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a withdrawal — code 13.
 *
 * `Amount` is declared `uint64` here (and `int64` on {@link TransferTx}), so the low check is
 * `=== 0` rather than `<= 0`.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateWithdraw(tx: WithdrawTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2Withdraw;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.fromAccountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "FromAccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkAssetIndex(tx.assetIndex, txType);
  checkRouteType(tx.routeType, "RouteType", txType);
  if (tx.amount === 0n) {
    fail("WITHDRAWAL_AMOUNT_TOO_LOW", "Amount", txType, MIN_WITHDRAWAL_AMOUNT);
  }
  if (tx.amount > MAX_WITHDRAWAL_AMOUNT) {
    fail("WITHDRAWAL_AMOUNT_TOO_HIGH", "Amount", txType, MAX_WITHDRAWAL_AMOUNT);
  }
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — public-pool shares (§7.14)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a share mint — code 18.
 *
 * The pool index floor is {@link MIN_SUB_ACCOUNT_INDEX} (`2^47`), because public pools live in the
 * sub-account range (`docs/protocol-notes.md` §11). The reported message still says "less than -1";
 * that is the reference's stale text and it is part of parity.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateMintShares(tx: MintSharesTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2MintShares;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // §7.14: floor is MinSubAccountIndex (2^47) — NOT MinAccountIndex. Code 11 uses -1.
  if (tx.publicPoolIndex < MIN_SUB_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_LOW", "PublicPoolIndex", txType, MIN_SUB_ACCOUNT_INDEX);
  }
  if (tx.publicPoolIndex > MAX_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_HIGH", "PublicPoolIndex", txType, MAX_ACCOUNT_INDEX);
  }
  if (tx.shareAmount < MIN_POOL_SHARES_TO_MINT_OR_BURN) {
    fail("POOL_MINT_AMOUNT_TOO_LOW", "ShareAmount", txType, MIN_POOL_SHARES_TO_MINT_OR_BURN);
  }
  if (tx.shareAmount > MAX_POOL_SHARES_TO_MINT_OR_BURN) {
    fail("POOL_MINT_AMOUNT_TOO_HIGH", "ShareAmount", txType, MAX_POOL_SHARES_TO_MINT_OR_BURN);
  }
  checkTail(tx, txType);
}

/**
 * Validate a share burn — code 19. Identical to {@link validateMintShares} except for the two
 * amount error identities (`POOL_BURN_*`).
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateBurnShares(tx: BurnSharesTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2BurnShares;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // §7.14: floor is MinSubAccountIndex (2^47) — NOT MinAccountIndex. Code 11 uses -1.
  if (tx.publicPoolIndex < MIN_SUB_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_LOW", "PublicPoolIndex", txType, MIN_SUB_ACCOUNT_INDEX);
  }
  if (tx.publicPoolIndex > MAX_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_HIGH", "PublicPoolIndex", txType, MAX_ACCOUNT_INDEX);
  }
  if (tx.shareAmount < MIN_POOL_SHARES_TO_MINT_OR_BURN) {
    fail("POOL_BURN_AMOUNT_TOO_LOW", "ShareAmount", txType, MIN_POOL_SHARES_TO_MINT_OR_BURN);
  }
  if (tx.shareAmount > MAX_POOL_SHARES_TO_MINT_OR_BURN) {
    fail("POOL_BURN_AMOUNT_TOO_HIGH", "ShareAmount", txType, MAX_POOL_SHARES_TO_MINT_OR_BURN);
  }
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 20 — L2UpdateLeverage (§7.16)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a leverage update — code 20.
 *
 * The reference checks nothing about `MarketIndex` except `!== 255`, so negative and out-of-range
 * indices pass it. `{ strict: false }` reproduces that; the default additionally enforces the perps
 * range (§15 row 6).
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUpdateLeverage(tx: UpdateLeverageTx, opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2UpdateLeverage;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // Reference: the only market rule is `!== NilMarketIndex`.
  if (tx.marketIndex === NIL_MARKET_INDEX) fail("MARKET_INDEX_INVALID", "MarketIndex", txType);
  if (
    isStrict(opts) &&
    (tx.marketIndex < MIN_PERPS_MARKET_INDEX || tx.marketIndex > MAX_PERPS_MARKET_INDEX)
  ) {
    // §15 row 6 — the tightening, not the reference.
    fail("MARKET_INDEX_INVALID", "MarketIndex", txType, MAX_PERPS_MARKET_INDEX);
  }
  // §7.16 order: MarginMode is checked before InitialMarginFraction.
  if (tx.marginMode !== 0 && tx.marginMode !== 1) fail("MARGIN_MODE_INVALID", "MarginMode", txType);
  if (tx.initialMarginFraction <= 0) {
    fail("IMF_TOO_LOW", "InitialMarginFraction", txType, 0);
  }
  if (tx.initialMarginFraction > MARGIN_FRACTION_TICK) {
    fail("IMF_TOO_HIGH", "InitialMarginFraction", txType, MARGIN_FRACTION_TICK);
  }
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 29 — L2UpdateMargin (§7.13)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate an isolated-margin move — code 29.
 *
 * The reference has **no lower bound** on `USDCAmount`: it checks `=== 0` and the `2^60−1` ceiling
 * only, so negative amounts pass and take the arithmetic-shift branch of the field encoder
 * (`docs/protocol-notes.md` §3.2). Three conformance vectors depend on that, and they are replayed
 * with `{ strict: false }`. The default rejects negatives with `NEGATIVE_MARGIN_AMOUNT` (§15 row 7).
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUpdateMargin(tx: UpdateMarginTx, opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2UpdateMargin;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // Perps only, and the reference does check this one (unlike code 20).
  if (tx.marketIndex < MIN_PERPS_MARKET_INDEX || tx.marketIndex > MAX_PERPS_MARKET_INDEX) {
    fail("MARKET_INDEX_INVALID", "MarketIndex", txType, MAX_PERPS_MARKET_INDEX);
  }
  if (tx.usdcAmount === 0n) fail("TRANSFER_AMOUNT_TOO_LOW", "USDCAmount", txType, 0n);
  if (isStrict(opts) && tx.usdcAmount < 0n) {
    // §15 row 7 — the tightening. `{ strict: false }` lets the negative through unchanged.
    fail("NEGATIVE_MARGIN_AMOUNT", "USDCAmount", txType, 0n);
  }
  if (tx.usdcAmount > MAX_EXCHANGE_USDC) {
    fail("TRANSFER_AMOUNT_TOO_HIGH", "USDCAmount", txType, MAX_EXCHANGE_USDC);
  }
  if (tx.direction !== 0 && tx.direction !== 1) {
    fail("UPDATE_MARGIN_DIRECTION_INVALID", "Direction", txType);
  }
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 35 / 36 — staking (§7.15)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate a stake — code 35.
 *
 * Uses the *correct* `STAKING_POOL_INDEX_*` identities. {@link validateUnstakeAssets} does not —
 * that difference is real and is asserted by the tests.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateStakeAssets(tx: StakeAssetsTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2StakeAssets;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // §7.15: staking pools live in the sub-account range, and code 35 reports the matching identity.
  if (tx.stakingPoolIndex < MIN_SUB_ACCOUNT_INDEX) {
    fail("STAKING_POOL_INDEX_TOO_LOW", "StakingPoolIndex", txType, MIN_SUB_ACCOUNT_INDEX);
  }
  if (tx.stakingPoolIndex > MAX_ACCOUNT_INDEX) {
    fail("STAKING_POOL_INDEX_TOO_HIGH", "StakingPoolIndex", txType, MAX_ACCOUNT_INDEX);
  }
  if (tx.shareAmount < MIN_STAKING_SHARES_TO_MINT_OR_BURN) {
    fail("STAKE_AMOUNT_TOO_LOW", "ShareAmount", txType, MIN_STAKING_SHARES_TO_MINT_OR_BURN);
  }
  if (tx.shareAmount > MAX_STAKING_SHARES_TO_MINT_OR_BURN) {
    fail("STAKE_AMOUNT_TOO_HIGH", "ShareAmount", txType, MAX_STAKING_SHARES_TO_MINT_OR_BURN);
  }
  checkTail(tx, txType);
}

/**
 * Validate an unstake — code 36.
 *
 * The predicate is on `StakingPoolIndex` but the reported error is `PUBLIC_POOL_INDEX_TOO_LOW` /
 * `_TOO_HIGH`. That is a copy-paste in the reference (`spec/04-tx-types.md` §7.15, ADR-13); it is
 * observable, so it is part of parity and is reproduced deliberately. Code 35 reports the *correct*
 * `STAKING_POOL_INDEX_*` pair on the same predicate. Do not unify them.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUnstakeAssets(tx: UnstakeAssetsTx, _opts?: AccountValidateOptions): void {
  const txType: number = TxType.L2UnstakeAssets;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  // §7.15: predicate on StakingPoolIndex, error identity PublicPoolIndex. Reference copy-paste.
  if (tx.stakingPoolIndex < MIN_SUB_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_LOW", "StakingPoolIndex", txType, MIN_SUB_ACCOUNT_INDEX);
  }
  if (tx.stakingPoolIndex > MAX_ACCOUNT_INDEX) {
    fail("PUBLIC_POOL_INDEX_TOO_HIGH", "StakingPoolIndex", txType, MAX_ACCOUNT_INDEX);
  }
  if (tx.shareAmount < MIN_STAKING_SHARES_TO_MINT_OR_BURN) {
    fail("UNSTAKE_AMOUNT_TOO_LOW", "ShareAmount", txType, MIN_STAKING_SHARES_TO_MINT_OR_BURN);
  }
  if (tx.shareAmount > MAX_STAKING_SHARES_TO_MINT_OR_BURN) {
    fail("UNSTAKE_AMOUNT_TOO_HIGH", "ShareAmount", txType, MAX_STAKING_SHARES_TO_MINT_OR_BURN);
  }
  checkTail(tx, txType);
}

/* -------------------------------------------------------------------------------------------------
 * 41 / 42 / 45 — account configuration (§7.17–§7.19)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Validate an account-config change — code 41.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUpdateAccountConfig(
  tx: UpdateAccountConfigTx,
  _opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2UpdateAccountConfig;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  if (tx.accountTradingMode !== 0 && tx.accountTradingMode !== 1) {
    fail("ACCOUNT_TRADING_MODE_INVALID", "AccountTradingMode", txType);
  }
  checkTail(tx, txType);
}

/**
 * Validate a per-asset margin-mode change — code 42.
 *
 * `AssetMarginMode` out of `{0, 1}` reports **`MARGIN_MODE_INVALID`**, not
 * `ASSET_MARGIN_MODE_INVALID` — the latter exists in the reference's error catalogue and is never
 * raised (`spec/04-tx-types.md` §7.18, §12). Reproduced deliberately.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateUpdateAccountAssetConfig(
  tx: UpdateAccountAssetConfigTx,
  _opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2UpdateAccountAssetConfig;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "FROM_ACCOUNT_INDEX_TOO_LOW",
    "FROM_ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkAssetIndex(tx.assetIndex, txType);
  // §7.18: the field is AssetMarginMode, the error is ErrInvalidMarginMode. Not a typo here.
  if (tx.assetMarginMode !== 0 && tx.assetMarginMode !== 1) {
    fail("MARGIN_MODE_INVALID", "AssetMarginMode", txType);
  }
  checkTail(tx, txType);
}

/**
 * Validate an integrator approval — code 45.
 *
 * Two things are specific to this type:
 *
 * - The account bounds report the **plain** `ACCOUNT_INDEX_*` identities, not the *From*-flavoured
 *   ones every other type in this module uses (`spec/04-tx-types.md` §7.19).
 * - The revocation check runs **before** the `ApprovalExpiry` range check. Swapping them changes
 *   which error a revocation-with-fees produces, and the order is normative.
 *
 * @throws {LighterValidationError} on the first rule violated.
 */
export function validateApproveIntegrator(
  tx: ApproveIntegratorTx,
  _opts?: AccountValidateOptions,
): void {
  const txType: number = TxType.L2ApproveIntegrator;
  validateAttributes(tx.attributes);
  checkAccountIndex(
    tx.accountIndex,
    MAX_ACCOUNT_INDEX,
    "ACCOUNT_INDEX_TOO_LOW", // §7.19 — plain identities here, unlike codes 8/10/11/18/19/20/29/35/36/41/42
    "ACCOUNT_INDEX_TOO_HIGH",
    "AccountIndex",
    txType,
  );
  checkApiKeyIndex(tx.apiKeyIndex, txType);
  checkAccountIndex(
    tx.integratorAccountIndex,
    MAX_ACCOUNT_INDEX,
    "INTEGRATOR_ACCOUNT_INDEX_TOO_LOW",
    "INTEGRATOR_ACCOUNT_INDEX_TOO_HIGH",
    "IntegratorAccountIndex",
    txType,
  );
  const fees: readonly (readonly [string, number])[] = [
    ["MaxPerpsTakerFee", tx.maxPerpsTakerFee],
    ["MaxPerpsMakerFee", tx.maxPerpsMakerFee],
    ["MaxSpotTakerFee", tx.maxSpotTakerFee],
    ["MaxSpotMakerFee", tx.maxSpotMakerFee],
  ];
  for (const [field, value] of fees) {
    if (value > FEE_TICK) fail("FEE_TOO_HIGH", field, txType, FEE_TICK);
  }
  // Revocation before range — see the doc comment.
  if (tx.approvalExpiry === 0n) {
    for (const [field, value] of fees) {
      if (value !== 0) fail("APPROVAL_EXPIRY_ZERO_ON_REVOCATION", field, txType, 0);
    }
  }
  if (tx.approvalExpiry < 0n || tx.approvalExpiry > MAX_TIMESTAMP) {
    fail("APPROVAL_EXPIRY_INVALID", "ApprovalExpiry", txType, MAX_TIMESTAMP);
  }
  checkTail(tx, txType);
}
