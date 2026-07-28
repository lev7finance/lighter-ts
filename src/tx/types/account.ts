/**
 * Transaction object shapes for the fifteen non-order transaction types: key rotation,
 * sub-accounts, public pools, transfers, withdrawals, share mint/burn, leverage, isolated-margin
 * moves, staking, account configuration and integrator approval.
 *
 * Codes 8, 9, 10, 11, 12, 13, 18, 19, 20, 29, 35, 36, 41, 42 and 45 (`spec/04-tx-types.md` §7.1–§7.6
 * and §7.13–§7.19). The tables that hash and serialise them live next door in
 * `src/tx/schemas/account.ts`; this module is types only and has no runtime content whatsoever
 * beyond the imports it re-uses for documentation.
 *
 * ## Why the discriminant is a number
 *
 * Every member carries `type: <numeric TxType member>` (`spec/04-tx-types.md` §13.2). That single
 * property is simultaneously:
 *
 * - the TypeScript discriminant, so `switch (tx.type)` narrows exhaustively;
 * - the `tx_type` value of the submission envelope;
 * - the second element of the transaction hash.
 *
 * A string discriminant would need a string↔number table maintained by hand, and a table that drifts
 * signs one transaction and submits it as another. The hasher never reads `tx.type` — it reads
 * `schema.txType` — so the two cannot disagree in the bytes that get signed, but keeping them equal
 * by construction means nothing downstream has to decide which one to trust.
 *
 * ## Widths
 *
 * Mechanically from `spec/04-tx-types.md` §13.1: every protocol field declared `int64`/`uint64` is a
 * `bigint` brand ({@link I64}, {@link U64}); everything 32 bits or narrower is a `number` brand
 * ({@link U8}, {@link U16}, {@link I16}, {@link U32}). There is no per-field judgement — `ShareAmount`,
 * `PublicPoolIndex`, `ApprovalExpiry` and `Amount` all exceed `2^53`, and `number` cannot hold them.
 *
 * Enumerated fields (`RouteType`, `Status`, `MarginMode`, `Direction`, `AccountTradingMode`,
 * `AssetMarginMode`) are typed by their **width**, not by a literal union of their legal codes. They
 * are `U8`, and the "must be 0 or 1" rule lives with the validators in `src/tx/validate/account.ts`.
 * Encoding it in the type instead would put half of a transaction's validation somewhere the error
 * catalogue cannot reach, and would silently reject values the sequencer accepts if the enumeration
 * ever grows a third member. The enumeration constants in `src/tx/enums.ts` remain the way to write
 * these values readably.
 *
 * ## `sig` and `l1Sig` are optional, and that is the lifecycle
 *
 * A transaction object exists before it is signed: `hashTx` reads only `nonce`, `expiredAt` and the
 * schema's `hashOrder`, none of which include a signature. Signing produces `T & { sig: Uint8Array }`
 * and L1 attachment produces `T & { l1Sig: \`0x…\` }` (`docs/ARCHITECTURE.md`), so both properties are
 * declared optional here and are **required at serialisation time** — `serializeTx` throws
 * `FIELD_MISSING` rather than emitting a transaction with a missing key, because nothing in the
 * protocol uses `omitempty`.
 *
 * Only codes **8, 12 and 45** declare `l1Sig`. Code 9 (`L2CreateSubAccount`) does not, despite
 * needing an Ethereum `personal_sign` over the §10.1 template (`docs/decisions.md` D6 — four flows,
 * not three): the L1 signature authorises the *creation* out of band and the L2 transaction body has
 * no key for it. Its vector row's fields are exactly `AccountIndex, ApiKeyIndex, ExpiredAt, Nonce`.
 * Adding an `L1Sig` key to code 9's JSON would corrupt every sub-account creation.
 */

import type { TxAttributes } from "../attributes.js";
import type { I16, I64, U8, U16, U32, U64 } from "../brands.js";
import type { TxType } from "../enums.js";

/**
 * An `0x`-prefixed lowercase hex EIP-191 signature, 65 bytes / 132 characters.
 *
 * Typed as a template literal rather than `string` so a bare hex body is a compile error; the
 * serialiser additionally rejects uppercase and odd-length bodies at runtime.
 */
export type L1SigHex = `0x${string}`;

/**
 * What every constructible L2 transaction carries (`spec/04-tx-types.md` §5).
 *
 * `nonce` and `expiredAt` are hash elements 2 and 3 — emitted by the hasher from these exact
 * property names, before any schema field — and are also JSON keys. `expiredAt` is **Unix
 * milliseconds**, not seconds.
 */
export interface BaseAccountTx {
  /** Per-`(account, apiKey)` sequence number. `>= 0`. Hash element 2. */
  readonly nonce: I64;
  /** Transaction deadline in **Unix milliseconds**, `[0, 2^48−1]`. Hash element 3. */
  readonly expiredAt: I64;
  /** Schnorr signature, `S(40 LE) ‖ E(40 LE)`. Absent until signed; required to serialise. */
  readonly sig?: Uint8Array | undefined;
  /** Optional `L2TxAttributes` side-channel (`spec/04-tx-types.md` §6). */
  readonly attributes?: TxAttributes | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * 8 — L2ChangePubKey (§7.1)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Register or rotate the ECgFp5 public key for `(accountIndex, apiKeyIndex)` — code 8.
 *
 * Requires an Ethereum `personal_sign` over the §10.1 template, carried in `l1Sig`.
 *
 * The field is `accountIndex`, not `fromAccountIndex`, even though the reference reports
 * `ErrFromAccountIndex*` for it (`spec/04-tx-types.md` §7.1). The error identity is a copy-paste in
 * the reference and is the validators' problem; renaming the field to match it would put the wrong
 * key on the wire.
 */
export interface ChangePubKeyTx extends BaseAccountTx {
  readonly type: typeof TxType.L2ChangePubKey;
  /** Account being rekeyed. `[-1, 2^48−2]`; `-1` is `MinAccountIndex`, not an absence marker. */
  readonly accountIndex: I64;
  /** API key slot to (re)key. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /**
   * The new public key: **exactly 40 bytes**, five little-endian 64-bit limbs.
   *
   * Absorbed as five field elements with limbs reduced rather than rejected — real keys carry limbs
   * above the modulus (`docs/protocol-notes.md` §1) — and emitted into JSON as base64 of these
   * original 40 bytes, which is not the same thing as a re-serialisation of the reduced elements.
   */
  readonly pubKey: Uint8Array;
  /** EIP-191 signature over the §10.1 registration message. Required to serialise. */
  readonly l1Sig?: L1SigHex | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * 9 — L2CreateSubAccount (§7.2)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create a sub-account under a master account — code 9.
 *
 * **No `l1Sig` property, deliberately.** The flow needs an L1 signature (`docs/decisions.md` D6) and
 * the L2 transaction has nowhere to put it.
 */
export interface CreateSubAccountTx extends BaseAccountTx {
  readonly type: typeof TxType.L2CreateSubAccount;
  /** Master account creating the sub-account. `[-1, 140737488355327]` — the **master** range. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
}

/* -------------------------------------------------------------------------------------------------
 * 10 / 11 — public pools (§7.3, §7.4)
 * ---------------------------------------------------------------------------------------------- */

/** Create a public pool — code 10. */
export interface CreatePublicPoolTx extends BaseAccountTx {
  readonly type: typeof TxType.L2CreatePublicPool;
  /** Pool operator. `[-1, 2^47−1]` — the master range. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Operator cut in millionths. `[0, 1000000]`. */
  readonly operatorFee: I64;
  /** Initial share supply. `> 0`, `<= 1000000000000`. One element, never split. */
  readonly initialTotalShares: I64;
  /** Minimum fraction of shares the operator must hold, basis points. `<= 10000`. */
  readonly minOperatorShareRate: U16;
}

/** Update a public pool's status, fee and minimum operator share — code 11. */
export interface UpdatePublicPoolTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UpdatePublicPool;
  /** Operator account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** The pool's own account index. `[-1, 2^48−2]`. One element, never split. */
  readonly publicPoolIndex: I64;
  /** `0` = closed/paused, `1` = open. See `PoolStatus` in `src/tx/enums.ts`. */
  readonly status: U8;
  /** Operator cut in millionths. `[0, 1000000]`. */
  readonly operatorFee: I64;
  /** Minimum operator share rate, basis points. `<= 10000`. */
  readonly minOperatorShareRate: U16;
}

/* -------------------------------------------------------------------------------------------------
 * 12 / 13 — value movement (§7.5, §7.6)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Move an asset between accounts and/or between the perps and spot routes — code 12.
 *
 * `amount` and `usdcFee` are each absorbed as **two** elements, low half then high half, with the
 * **logical** shift. `memo` is absorbed as **none**.
 */
export interface TransferTx extends BaseAccountTx {
  readonly type: typeof TxType.L2Transfer;
  /** Source account. `[-1, 2^48−2]`. */
  readonly fromAccountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Destination account. `[-1, 2^48−2]`. */
  readonly toAccountIndex: I64;
  /** Asset id. `[1, 62]`. Declared `int16`, so negative values are representable. */
  readonly assetIndex: I16;
  /** Source route: `0` perps, `1` spot. */
  readonly fromRouteType: U8;
  /** Destination route: `0` perps, `1` spot. */
  readonly toRouteType: U8;
  /** Amount in the asset's smallest unit. `[1, 2^60−1]`. Split logically into two elements. */
  readonly amount: I64;
  /** Transfer fee in USDC micro-units. `[0, 2^60−1]`. Split logically into two elements. */
  readonly usdcFee: I64;
  /**
   * Free-form 32 bytes, **exactly**.
   *
   * Absent from the L2 hash — it is bound to the transaction only by the L1 signature — and rendered
   * in JSON as an array of 32 numbers, because Go's `encoding/json` writes a `[32]byte` **array**
   * that way. Not base64, not hex (`spec/04-tx-types.md` §9.2).
   */
  readonly memo: Uint8Array;
  /** EIP-191 signature over the §10.2 transfer message. Required to serialise. */
  readonly l1Sig?: L1SigHex | undefined;
}

/**
 * Withdraw an asset to L1 — code 13.
 *
 * `amount` is declared `uint64` here and `int64` on {@link TransferTx}; both take the **logical**
 * split, so the declared signedness changes the validator's bounds and not the hash.
 */
export interface WithdrawTx extends BaseAccountTx {
  readonly type: typeof TxType.L2Withdraw;
  /** Source account. `[-1, 2^48−2]`. */
  readonly fromAccountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Asset id. `[1, 62]`. */
  readonly assetIndex: I16;
  /** Route: `0` perps, `1` spot. */
  readonly routeType: U8;
  /** Amount in the asset's smallest unit. `[1, 2^60−1]`. Split logically into two elements. */
  readonly amount: U64;
}

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — public-pool shares (§7.14)
 * ---------------------------------------------------------------------------------------------- */

/** Mint public-pool shares — code 18. Structurally identical to {@link BurnSharesTx}. */
export interface MintSharesTx extends BaseAccountTx {
  readonly type: typeof TxType.L2MintShares;
  /** Investor account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Pool account index, in the **sub-account** range `[140737488355328, 281474976710654]`. */
  readonly publicPoolIndex: I64;
  /** Shares to mint. `[1, 2^60−1]`. One element, never split. */
  readonly shareAmount: I64;
}

/** Burn public-pool shares — code 19. Differs from {@link MintSharesTx} only in the code. */
export interface BurnSharesTx extends BaseAccountTx {
  readonly type: typeof TxType.L2BurnShares;
  /** Investor account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Pool account index, in the **sub-account** range `[140737488355328, 281474976710654]`. */
  readonly publicPoolIndex: I64;
  /** Shares to burn. `[1, 2^60−1]`. One element, never split. */
  readonly shareAmount: I64;
}

/* -------------------------------------------------------------------------------------------------
 * 20 / 29 — margin (§7.16, §7.13)
 * ---------------------------------------------------------------------------------------------- */

/** Set a market's initial margin fraction and margin mode — code 20. */
export interface UpdateLeverageTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UpdateLeverage;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Market. Anything except `255` (`NilMarketIndex`). Signed, so `-1` is representable. */
  readonly marketIndex: I16;
  /** IMF in basis points, `[1, 10000]`. Leverage is `10000 / initialMarginFraction`. */
  readonly initialMarginFraction: U16;
  /** `0` = cross, `1` = isolated. See `MarginMode` in `src/tx/enums.ts`. */
  readonly marginMode: U8;
}

/**
 * Add or remove isolated margin for a perps position — code 29.
 *
 * Two things about this type are load-bearing and both are invisible from the field list:
 *
 * 1. `usdcAmount` is the **only** field in the protocol split with the **arithmetic** shift, so a
 *    negative value propagates its sign into the high half.
 * 2. `direction` is absorbed **after** the two amount limbs, not before, despite reading more
 *    naturally in the other order.
 */
export interface UpdateMarginTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UpdateMargin;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Perps market. `[0, 254]`. Signed, so `-1` is representable and hashes as `4294967294`. */
  readonly marketIndex: I16;
  /**
   * USDC micro-units. The reference checks `!= 0` and `<= 2^60−1` with **no lower bound**, so
   * negative values are reachable and take the arithmetic-shift path
   * (`docs/protocol-notes.md` §3.2). Strict mode in this SDK rejects them; the schema still hashes
   * them byte-identically when strict mode is bypassed.
   */
  readonly usdcAmount: I64;
  /** `0` = remove from isolated, `1` = add to isolated. See `MarginDirection` in `src/tx/enums.ts`. */
  readonly direction: U8;
}

/* -------------------------------------------------------------------------------------------------
 * 35 / 36 — staking (§7.15)
 * ---------------------------------------------------------------------------------------------- */

/** Stake assets into a staking pool — code 35. Structurally identical to {@link UnstakeAssetsTx}. */
export interface StakeAssetsTx extends BaseAccountTx {
  readonly type: typeof TxType.L2StakeAssets;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Staking pool account index. `[2^47, 2^48−2]`. One element, never split. */
  readonly stakingPoolIndex: I64;
  /** Shares to stake. `[1, 2^60−1]`. */
  readonly shareAmount: I64;
}

/** Unstake assets from a staking pool — code 36. Differs from {@link StakeAssetsTx} only in the code. */
export interface UnstakeAssetsTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UnstakeAssets;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Staking pool account index. `[2^47, 2^48−2]`. One element, never split. */
  readonly stakingPoolIndex: I64;
  /** Shares to unstake. `[1, 2^60−1]`. */
  readonly shareAmount: I64;
}

/* -------------------------------------------------------------------------------------------------
 * 41 / 42 / 45 — account configuration (§7.17, §7.18, §7.19)
 * ---------------------------------------------------------------------------------------------- */

/** Switch the account between standard and unified trading — code 41. */
export interface UpdateAccountConfigTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UpdateAccountConfig;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** `0` = standard, `1` = unified trading account. See `AccountTradingMode` in `src/tx/enums.ts`. */
  readonly accountTradingMode: U8;
}

/** Opt one asset in or out of being used as margin by this account — code 42. */
export interface UpdateAccountAssetConfigTx extends BaseAccountTx {
  readonly type: typeof TxType.L2UpdateAccountAssetConfig;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Asset id. `[1, 62]`. */
  readonly assetIndex: I16;
  /** `0` = margin disabled, `1` = margin enabled. See `AccountAssetMarginMode` in `src/tx/enums.ts`. */
  readonly assetMarginMode: U8;
}

/**
 * Authorise an integrator to charge fees on this account's trades, up to explicit caps — code 45.
 *
 * `approvalExpiry === 0` is a revocation and requires all four fee caps to be zero.
 */
export interface ApproveIntegratorTx extends BaseAccountTx {
  readonly type: typeof TxType.L2ApproveIntegrator;
  /** Signing account. `[-1, 2^48−2]`. */
  readonly accountIndex: I64;
  /** API key index. `[0, 254]`. */
  readonly apiKeyIndex: U8;
  /** Integrator account. `[-1, 2^48−2]`. One element, never split. */
  readonly integratorAccountIndex: I64;
  /** Perps taker fee cap in millionths. `<= 1000000`. */
  readonly maxPerpsTakerFee: U32;
  /** Perps maker fee cap in millionths. `<= 1000000`. */
  readonly maxPerpsMakerFee: U32;
  /** Spot taker fee cap in millionths. `<= 1000000`. */
  readonly maxSpotTakerFee: U32;
  /** Spot maker fee cap in millionths. `<= 1000000`. */
  readonly maxSpotMakerFee: U32;
  /** Approval deadline, Unix ms. `[0, 2^48−1]`; `0` means revoke. One element, never split. */
  readonly approvalExpiry: I64;
  /** EIP-191 signature over the §10.3 approval message. Required to serialise. */
  readonly l1Sig?: L1SigHex | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The union
 * ---------------------------------------------------------------------------------------------- */

/**
 * The fifteen non-order transaction shapes, discriminated on the numeric `type`.
 *
 * The order-family types (14, 15, 16, 17, 28) are declared in their own module; the SDK-wide
 * `UnsignedTx` is the union of this and that, assembled by the integration unit. Nothing here
 * imports the order family, so the two can be built in parallel.
 */
export type AccountFamilyTx =
  | ChangePubKeyTx
  | CreateSubAccountTx
  | CreatePublicPoolTx
  | UpdatePublicPoolTx
  | TransferTx
  | WithdrawTx
  | MintSharesTx
  | BurnSharesTx
  | UpdateLeverageTx
  | UpdateMarginTx
  | StakeAssetsTx
  | UnstakeAssetsTx
  | UpdateAccountConfigTx
  | UpdateAccountAssetConfigTx
  | ApproveIntegratorTx;

/** A member of {@link AccountFamilyTx} that has been signed and can therefore be serialised. */
export type SignedAccountFamilyTx = AccountFamilyTx & { readonly sig: Uint8Array };
