/**
 * The fifteen schema tables for the non-order transaction types — codes 8, 9, 10, 11, 12, 13, 18,
 * 19, 20, 29, 35, 36, 41, 42 and 45.
 *
 * One table per type. `src/tx/hash.ts` reads `hashOrder`, `src/tx/serialize.ts` reads `fields`, and
 * nothing else in the SDK knows the shape of these transactions. The two lists are deliberately
 * different and are described in `src/tx/schema.ts`: `fields` is JSON emission order (Go struct
 * declaration order, from `spec/04-tx-types.md` §7), `hashOrder` is absorption order **after** the
 * universal `chainId, txType, Nonce, ExpiredAt` prefix the hasher emits by itself.
 *
 * So `Nonce` and `ExpiredAt` appear in every `fields` list and in no `hashOrder`; `Sig`, `L1Sig` and
 * `Memo` appear only in `fields`. Every `hashOrder` begins with the account-index field, then the
 * api-key index — absorbed positions 4 and 5 — and the account-index *property* name is
 * `fromAccountIndex` on Transfer and Withdraw and `accountIndex` everywhere else.
 *
 * ## What is easy to get wrong here
 *
 * **The lo/hi split is per-field, not per-width** (`docs/protocol-notes.md` §3.2). Exactly four
 * fields in the whole protocol are absorbed as two elements, and three of them are in this file:
 * `Transfer.Amount`, `Transfer.USDCFee` and `Withdraw.Amount` take the logical shift, and
 * `UpdateMargin.USDCAmount` takes the **arithmetic** one. Every other 64-bit field here —
 * `ShareAmount`, `PublicPoolIndex`, `StakingPoolIndex`, `InitialTotalShares`, `ApprovalExpiry`,
 * `IntegratorAccountIndex`, `OperatorFee` — is a **single** element regardless of magnitude.
 *
 * **`Direction` comes after the amount limbs on code 29.** Absorbing it before them, which is how
 * the field list reads, gives a wrong hash for every margin update.
 *
 * **`Memo` is not hashed.** It is bound to the transaction only by the L1 signature, and it is
 * emitted as a JSON array of 32 numbers rather than base64 — Go's `encoding/json` rendering of a
 * `[32]byte` array (`spec/04-tx-types.md` §9.2). `defineTxSchema` enforces the first half of that by
 * refusing a `byteArray` encoding in `hashOrder`.
 *
 * **Code 9 has no `L1Sig` field.** The create-sub-account flow does need an Ethereum `personal_sign`
 * (`docs/decisions.md` D6, and the message is pinned in `tx.json` → `l1Messages`), but the L2
 * transaction body has no key for it. Only codes 8, 12 and 45 declare one.
 *
 * **Nothing uses `omitempty`.** Every declared key is emitted, including zero values.
 */

import { MEMO_LENGTH, SIGNATURE_LENGTH } from "../constants.js";
import { TxType } from "../enums.js";
import {
  type Enc,
  type TxSchema,
  type TxSchemaRegistry,
  createTxSchemaRegistry,
  defineTxSchema,
} from "../schema.js";

/* -------------------------------------------------------------------------------------------------
 * Shared encodings
 *
 * Hoisted so the tables below read as data. `Enc` is frozen-by-convention structural data; the same
 * object being shared across fields is safe because `defineTxSchema` never mutates it.
 * ---------------------------------------------------------------------------------------------- */

/** One element, `BigInt.asUintN(64, v) mod p` (`docs/protocol-notes.md` §3.1). */
const INT: Enc = { k: "int" };

/** Two elements, low half then high half, **logical** shift on the reinterpreted unsigned word. */
const SPLIT_U64: Enc = { k: "splitU64" };

/** Two elements, low half then high half, **arithmetic** shift on the still-signed value. */
const SPLIT_I64_ARITH: Enc = { k: "splitI64Arith" };

/** 40 bytes → five elements into the hash; base64 of those same 40 bytes into JSON. */
const GFP5: Enc = { k: "gfp5" };

/** The 80-byte Schnorr signature. JSON-only — it cannot be inside the hash it signs. */
const SIG: Enc = { k: "bytesB64", len: SIGNATURE_LENGTH };

/** The `0x`-prefixed EIP-191 signature. JSON-only — it signs a different message entirely. */
const L1_SIG: Enc = { k: "hexString" };

/** The 32-byte memo, as a JSON array of 32 numbers. JSON-only, by protocol. */
const MEMO: Enc = { k: "byteArray", len: MEMO_LENGTH };

/* -------------------------------------------------------------------------------------------------
 * 8 — L2ChangePubKey (§7.1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2ChangePubKey`, 11 hash elements.
 *
 * `chainId, 8, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, gFp5(PubKey)[0..5)`.
 *
 * The field is `AccountIndex`, not `FromAccountIndex`, even though the reference reports
 * `ErrFromAccountIndex*` for it (`spec/04-tx-types.md` §7.1). That is a copy-pasted error identity,
 * and it belongs to the validator; the wire key is `AccountIndex`.
 */
export const CHANGE_PUB_KEY_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2ChangePubKey,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "pubKey", json: "PubKey", enc: GFP5 },
    { name: "l1Sig", json: "L1Sig", enc: L1_SIG },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "pubKey"],
});

/* -------------------------------------------------------------------------------------------------
 * 9 — L2CreateSubAccount (§7.2)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2CreateSubAccount`, 6 hash elements.
 *
 * `chainId, 9, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex`.
 *
 * **No `L1Sig` field.** See the module header: the flow is L1-signed, the transaction body is not.
 */
export const CREATE_SUB_ACCOUNT_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CreateSubAccount,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex"],
});

/* -------------------------------------------------------------------------------------------------
 * 10 / 11 — public pools (§7.3, §7.4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2CreatePublicPool`, 9 hash elements.
 *
 * `chainId, 10, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, OperatorFee, InitialTotalShares,
 * MinOperatorShareRate`.
 *
 * `InitialTotalShares` reaches `10^12` and is still a **single** element.
 */
export const CREATE_PUBLIC_POOL_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2CreatePublicPool,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "operatorFee", json: "OperatorFee", enc: INT },
    { name: "initialTotalShares", json: "InitialTotalShares", enc: INT },
    { name: "minOperatorShareRate", json: "MinOperatorShareRate", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: [
    "accountIndex",
    "apiKeyIndex",
    "operatorFee",
    "initialTotalShares",
    "minOperatorShareRate",
  ],
});

/**
 * `L2UpdatePublicPool`, 10 hash elements.
 *
 * `chainId, 11, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, PublicPoolIndex, Status, OperatorFee,
 * MinOperatorShareRate`.
 *
 * `PublicPoolIndex` is an account index in the sub-account range — well past `2^32` — and is a
 * single element.
 */
export const UPDATE_PUBLIC_POOL_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UpdatePublicPool,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "publicPoolIndex", json: "PublicPoolIndex", enc: INT },
    { name: "status", json: "Status", enc: INT },
    { name: "operatorFee", json: "OperatorFee", enc: INT },
    { name: "minOperatorShareRate", json: "MinOperatorShareRate", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: [
    "accountIndex",
    "apiKeyIndex",
    "publicPoolIndex",
    "status",
    "operatorFee",
    "minOperatorShareRate",
  ],
});

/* -------------------------------------------------------------------------------------------------
 * 12 / 13 — value movement (§7.5, §7.6)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2Transfer`, 14 hash elements.
 *
 * `chainId, 12, Nonce, ExpiredAt, FromAccountIndex, ApiKeyIndex, ToAccountIndex, AssetIndex,
 * FromRouteType, ToRouteType, lo32(Amount), hi32(Amount), lo32(USDCFee), hi32(USDCFee)`.
 *
 * Both amounts take {@link SPLIT_U64} — the **logical** shift — and both split at any size, including
 * `USDCFee = 0`, whose two limbs are `0, 0`. `Memo` is declared and never hashed.
 */
export const TRANSFER_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2Transfer,
  fields: [
    { name: "fromAccountIndex", json: "FromAccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "toAccountIndex", json: "ToAccountIndex", enc: INT },
    { name: "assetIndex", json: "AssetIndex", enc: INT },
    { name: "fromRouteType", json: "FromRouteType", enc: INT },
    { name: "toRouteType", json: "ToRouteType", enc: INT },
    { name: "amount", json: "Amount", enc: SPLIT_U64 },
    { name: "usdcFee", json: "USDCFee", enc: SPLIT_U64 },
    { name: "memo", json: "Memo", enc: MEMO },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
    { name: "l1Sig", json: "L1Sig", enc: L1_SIG },
  ],
  hashOrder: [
    "fromAccountIndex",
    "apiKeyIndex",
    "toAccountIndex",
    "assetIndex",
    "fromRouteType",
    "toRouteType",
    "amount",
    "usdcFee",
  ],
});

/**
 * `L2Withdraw`, 10 hash elements.
 *
 * `chainId, 13, Nonce, ExpiredAt, FromAccountIndex, ApiKeyIndex, AssetIndex, RouteType,
 * lo32(Amount), hi32(Amount)`.
 *
 * `Amount` is `uint64` here and `int64` on {@link TRANSFER_SCHEMA}; both take {@link SPLIT_U64}, so
 * the declared signedness changes the validator's bounds and not a single hashed bit.
 */
export const WITHDRAW_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2Withdraw,
  fields: [
    { name: "fromAccountIndex", json: "FromAccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "assetIndex", json: "AssetIndex", enc: INT },
    { name: "routeType", json: "RouteType", enc: INT },
    { name: "amount", json: "Amount", enc: SPLIT_U64 },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["fromAccountIndex", "apiKeyIndex", "assetIndex", "routeType", "amount"],
});

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — public-pool shares (§7.14)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2MintShares`, 8 hash elements.
 *
 * `chainId, 18, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, PublicPoolIndex, ShareAmount`.
 *
 * `ShareAmount` reaches `2^60 − 1` and is a **single** element — the split is per-field, and this is
 * not one of the four fields that split.
 */
export const MINT_SHARES_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2MintShares,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "publicPoolIndex", json: "PublicPoolIndex", enc: INT },
    { name: "shareAmount", json: "ShareAmount", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "publicPoolIndex", "shareAmount"],
});

/** `L2BurnShares`, 8 hash elements. Identical to {@link MINT_SHARES_SCHEMA} but for the code, `19`. */
export const BURN_SHARES_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2BurnShares,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "publicPoolIndex", json: "PublicPoolIndex", enc: INT },
    { name: "shareAmount", json: "ShareAmount", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "publicPoolIndex", "shareAmount"],
});

/* -------------------------------------------------------------------------------------------------
 * 20 / 29 — margin (§7.16, §7.13)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2UpdateLeverage`, 9 hash elements.
 *
 * `chainId, 20, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, InitialMarginFraction,
 * MarginMode`.
 */
export const UPDATE_LEVERAGE_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UpdateLeverage,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "marketIndex", json: "MarketIndex", enc: INT },
    { name: "initialMarginFraction", json: "InitialMarginFraction", enc: INT },
    { name: "marginMode", json: "MarginMode", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "marketIndex", "initialMarginFraction", "marginMode"],
});

/**
 * `L2UpdateMargin`, 10 hash elements.
 *
 * `chainId, 29, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, MarketIndex, lo32(USDCAmount),
 * hi32Arithmetic(USDCAmount), Direction`.
 *
 * Two deliberate departures from how the field list reads, and both are pinned by vectors:
 *
 * 1. **`usdcAmount` uses {@link SPLIT_I64_ARITH}, not {@link SPLIT_U64}.** It is the only field in
 *    the protocol that does. The reference validates `USDCAmount != 0` and `<= 2^60−1` with **no
 *    lower bound**, so negatives reach the hasher, and the arithmetic shift propagates the sign into
 *    the high half: `splitI64Arith(-1n)` is `[4294967295, 4294967294]` where `splitU64(-1n)` is
 *    `[4294967295, 4294967295]`. Switching this one encoding to `SPLIT_U64` leaves
 *    `update_margin/add` passing and breaks **exactly** `update_margin/negative_minus_one`,
 *    `update_margin/negative_2_pow_32` and `update_margin/negative_realistic` — asserted directly in
 *    `test/tx/schemas-account.test.ts`, which builds that mutant schema and checks the split.
 * 2. **`direction` is absorbed after the two amount limbs.** Moving it before them, which reads more
 *    naturally, gives a wrong hash for every margin update and a rejected signature for all of them.
 */
export const UPDATE_MARGIN_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UpdateMargin,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "marketIndex", json: "MarketIndex", enc: INT },
    { name: "usdcAmount", json: "USDCAmount", enc: SPLIT_I64_ARITH },
    { name: "direction", json: "Direction", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "marketIndex", "usdcAmount", "direction"],
});

/* -------------------------------------------------------------------------------------------------
 * 35 / 36 — staking (§7.15)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2StakeAssets`, 8 hash elements.
 *
 * `chainId, 35, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, StakingPoolIndex, ShareAmount`.
 *
 * Structurally the mint/burn pair with a different pool-index key: `StakingPoolIndex`, not
 * `PublicPoolIndex`. The reference's *error* identities cross the two over (the unstake path reports
 * `ErrPublicPoolIndex*`); that is the validator's problem, and the wire key is unaffected.
 */
export const STAKE_ASSETS_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2StakeAssets,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "stakingPoolIndex", json: "StakingPoolIndex", enc: INT },
    { name: "shareAmount", json: "ShareAmount", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "stakingPoolIndex", "shareAmount"],
});

/** `L2UnstakeAssets`, 8 hash elements. Identical to {@link STAKE_ASSETS_SCHEMA} but for the code, `36`. */
export const UNSTAKE_ASSETS_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UnstakeAssets,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "stakingPoolIndex", json: "StakingPoolIndex", enc: INT },
    { name: "shareAmount", json: "ShareAmount", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "stakingPoolIndex", "shareAmount"],
});

/* -------------------------------------------------------------------------------------------------
 * 41 / 42 / 45 — account configuration (§7.17, §7.18, §7.19)
 * ---------------------------------------------------------------------------------------------- */

/**
 * `L2UpdateAccountConfig`, 7 hash elements.
 *
 * `chainId, 41, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, AccountTradingMode`.
 */
export const UPDATE_ACCOUNT_CONFIG_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UpdateAccountConfig,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "accountTradingMode", json: "AccountTradingMode", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "accountTradingMode"],
});

/**
 * `L2UpdateAccountAssetConfig`, 8 hash elements.
 *
 * `chainId, 42, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, AssetIndex, AssetMarginMode`.
 */
export const UPDATE_ACCOUNT_ASSET_CONFIG_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2UpdateAccountAssetConfig,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "assetIndex", json: "AssetIndex", enc: INT },
    { name: "assetMarginMode", json: "AssetMarginMode", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
  ],
  hashOrder: ["accountIndex", "apiKeyIndex", "assetIndex", "assetMarginMode"],
});

/**
 * `L2ApproveIntegrator`, 12 hash elements.
 *
 * `chainId, 45, Nonce, ExpiredAt, AccountIndex, ApiKeyIndex, IntegratorAccountIndex,
 * MaxPerpsTakerFee, MaxPerpsMakerFee, MaxSpotTakerFee, MaxSpotMakerFee, ApprovalExpiry`.
 *
 * `IntegratorAccountIndex` and `ApprovalExpiry` are both 64-bit and both **single** elements.
 * `ApprovalExpiry` in particular is a millisecond timestamp comfortably past `2^32` and does not
 * split — the same rule that leaves `OrderExpiry` unsplit.
 */
export const APPROVE_INTEGRATOR_SCHEMA: TxSchema = defineTxSchema({
  txType: TxType.L2ApproveIntegrator,
  fields: [
    { name: "accountIndex", json: "AccountIndex", enc: INT },
    { name: "apiKeyIndex", json: "ApiKeyIndex", enc: INT },
    { name: "integratorAccountIndex", json: "IntegratorAccountIndex", enc: INT },
    { name: "maxPerpsTakerFee", json: "MaxPerpsTakerFee", enc: INT },
    { name: "maxPerpsMakerFee", json: "MaxPerpsMakerFee", enc: INT },
    { name: "maxSpotTakerFee", json: "MaxSpotTakerFee", enc: INT },
    { name: "maxSpotMakerFee", json: "MaxSpotMakerFee", enc: INT },
    { name: "approvalExpiry", json: "ApprovalExpiry", enc: INT },
    { name: "expiredAt", json: "ExpiredAt", enc: INT },
    { name: "nonce", json: "Nonce", enc: INT },
    { name: "sig", json: "Sig", enc: SIG },
    { name: "l1Sig", json: "L1Sig", enc: L1_SIG },
  ],
  hashOrder: [
    "accountIndex",
    "apiKeyIndex",
    "integratorAccountIndex",
    "maxPerpsTakerFee",
    "maxPerpsMakerFee",
    "maxSpotTakerFee",
    "maxSpotMakerFee",
    "approvalExpiry",
  ],
});

/* -------------------------------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every schema in this module, in code order.
 *
 * Exported as a list as well as a map so the integration unit can concatenate it with the
 * order-family list and build one registry, rather than merging two maps and having to decide what a
 * duplicate key means.
 */
export const ACCOUNT_TX_SCHEMA_LIST: readonly TxSchema[] = Object.freeze([
  CHANGE_PUB_KEY_SCHEMA,
  CREATE_SUB_ACCOUNT_SCHEMA,
  CREATE_PUBLIC_POOL_SCHEMA,
  UPDATE_PUBLIC_POOL_SCHEMA,
  TRANSFER_SCHEMA,
  WITHDRAW_SCHEMA,
  MINT_SHARES_SCHEMA,
  BURN_SHARES_SCHEMA,
  UPDATE_LEVERAGE_SCHEMA,
  UPDATE_MARGIN_SCHEMA,
  STAKE_ASSETS_SCHEMA,
  UNSTAKE_ASSETS_SCHEMA,
  UPDATE_ACCOUNT_CONFIG_SCHEMA,
  UPDATE_ACCOUNT_ASSET_CONFIG_SCHEMA,
  APPROVE_INTEGRATOR_SCHEMA,
]);

/**
 * `txType → schema` for the fifteen non-order types.
 *
 * Key set is exactly `{8, 9, 10, 11, 12, 13, 18, 19, 20, 29, 35, 36, 41, 42, 45}`. Built from
 * {@link ACCOUNT_TX_SCHEMA_LIST} at module load, which is a pure fold over frozen data — nothing here
 * depends on import order, and a schema is reachable because it is in that list, not because a side
 * effect ran.
 */
export const ACCOUNT_TX_SCHEMAS: TxSchemaRegistry =
  createTxSchemaRegistry(ACCOUNT_TX_SCHEMA_LIST);
