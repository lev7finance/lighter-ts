/**
 * Protocol bounds and scales — pure data, zero imports, zero side effects.
 *
 * Every value here is enforced by the sequencer. None of them is a tunable, a default, or a
 * suggestion: a transaction that violates one is rejected on-chain, and the point of reproducing
 * them locally is that the rejection happens before a nonce is burned.
 *
 * ## The bigint rule, and why it is per-constant
 *
 * A protocol field declared `int64`/`uint64` is a `bigint` in this SDK; anything 32 bits or narrower
 * is a `number` (`spec/04-tx-types.md` §13.1). **Each bound below carries the type of the field it
 * guards**, so a validator never has to coerce and never has a chance to coerce wrongly.
 *
 * That rule is not cosmetic. `MaxOrderIndex` is `2^60 - 1 = 1152921504606846975`, which as a
 * `number` literal silently becomes `1152921504606847000` — a bound 25 units *too high*, which
 * accepts order indices the sequencer refuses, and which no test that stays inside the safe range
 * will ever catch. The same is true of {@link MAX_EXCHANGE_USDC}, {@link MAX_TRANSFER_AMOUNT},
 * {@link MAX_ORDER_EXPIRY} and every `2^60`-scale share bound.
 *
 * The scales and ticks in §11.7 are the deliberate exception: they are multipliers rather than
 * bounds, all are ≤ `10^8`, and they are exact as `number`. Callers doing money arithmetic widen
 * them at the call site, where the scale is visible.
 *
 * ## Sentinels are values, not absences
 *
 * Three of these are routinely misread:
 *
 * - {@link NIL_API_KEY_INDEX} (`255`) is a legal API key index for exactly one transaction —
 *   `L2CancelAllOrders`. It is *not* generally legal, and the width constructor `u8()` must not
 *   special-case it. That rule belongs to the validators.
 * - {@link NIL_MARKET_INDEX} (`255`) sits just above the perps range `[0, 254]`, and the spot range
 *   starts at `2048`. Market index is `int16` and negative values are reachable in decoded data, so
 *   it is `I16`, never `U16`.
 * - {@link MIN_ACCOUNT_INDEX} is `-1n` and is a **legal account index**, not a marker for "absent".
 *   It hashes to `4294967294` (`docs/protocol-notes.md` §3.1), and there is a conformance vector
 *   pinning exactly that.
 *
 * ## Chain id
 *
 * {@link CHAIN_ID} is here and not in `src/config/` because it is an input to *every* transaction
 * hash, and `src/tx/**` must not depend on `src/config/**`. `src/config/endpoints.ts` binds the same
 * three numbers to endpoint profiles; the values must agree, and a test on either side is free to
 * assert that they do.
 */

/* -------------------------------------------------------------------------------------------------
 * §11.7 — Scales and ticks
 *
 * Multipliers, not bounds. All exact as `number`; widen at the call site for `bigint` arithmetic.
 * ---------------------------------------------------------------------------------------------- */

/** USDC is quoted with 6 decimals: `1 USDC = 1_000_000` base units. */
export const ONE_USDC: 1_000_000 = 1_000_000;

/** LIT is quoted with 8 decimals: `1 LIT = 100_000_000` base units. */
export const ONE_LIT: 100_000_000 = 100_000_000;

/** Fees are expressed in millionths. `FEE_TICK` is 100%, and every fee bound is `[0, FEE_TICK]`. */
export const FEE_TICK: 1_000_000 = 1_000_000;

/**
 * Initial margin fraction is expressed in ten-thousandths. `MARGIN_FRACTION_TICK` is 100%, i.e. 1x
 * leverage; the maximum leverage a market allows is `MARGIN_FRACTION_TICK / imf`.
 */
export const MARGIN_FRACTION_TICK: 10_000 = 10_000;

/** Pool share rates are expressed in ten-thousandths. `SHARE_TICK` is 100%. */
export const SHARE_TICK: 10_000 = 10_000;

/** A newly created pool share is worth `1_000` USDC base units, i.e. 0.001 USDC. */
export const INITIAL_POOL_SHARE_VALUE: 1_000 = 1_000;

/* -------------------------------------------------------------------------------------------------
 * §11.8 — Index domains
 * ---------------------------------------------------------------------------------------------- */

/**
 * Lowest legal account index — **`-1`, and it is legal**.
 *
 * Not a sentinel for "no account". It is accepted by the validators and hashes to `2^32 - 2`
 * (`docs/protocol-notes.md` §3.1). Any `I64` domain that cannot represent it is wrong.
 */
export const MIN_ACCOUNT_INDEX: bigint = -1n;

/** Highest legal account index, `2^48 - 2`. */
export const MAX_ACCOUNT_INDEX: bigint = 281474976710654n;

/** Master accounts occupy `[0, 2^47 - 1]`. */
export const MAX_MASTER_ACCOUNT_INDEX: bigint = 140737488355327n;

/**
 * Sub-accounts start at `2^47`.
 *
 * Public pool and staking pool indices must sit in this range (`docs/protocol-notes.md` §11), which
 * is why the pool transactions bound their pool index by this value rather than by zero.
 */
export const MIN_SUB_ACCOUNT_INDEX: bigint = 140737488355328n;

/** The treasury's account index. */
export const TREASURY_ACCOUNT_INDEX: bigint = 0n;

/** The insurance-fund operator's account index. */
export const INSURANCE_FUND_OPERATOR_ACCOUNT_INDEX: bigint = 1n;

/** API key indices are `uint8`; `0` is the master key. */
export const MIN_API_KEY_INDEX: 0 = 0;

/** Highest generally legal API key index, `2^8 - 2`. */
export const MAX_API_KEY_INDEX: 254 = 254;

/**
 * `255` — accepted **only** by `L2CancelAllOrders`, where it means "every key on the account".
 *
 * It is inside the `uint8` range, so no width check can reject it. Only the per-transaction
 * validators may allow it, and only for that one transaction type.
 */
export const NIL_API_KEY_INDEX: 255 = 255;

/** Market index is `int16`. Lowest legal value across both families. */
export const MIN_MARKET_INDEX: 0 = 0;

/** Perpetual markets occupy `[0, 254]`. */
export const MIN_PERPS_MARKET_INDEX: 0 = 0;

/** Highest perps market index, `2^8 - 2`. */
export const MAX_PERPS_MARKET_INDEX: 254 = 254;

/**
 * `255` — "all markets", used by `L2CancelAllOrders`' per-market attribute.
 *
 * It falls between the perps range and the spot range, so it is not reachable as a real market and
 * needs no exclusion rule beyond the family bounds.
 */
export const NIL_MARKET_INDEX: 255 = 255;

/** Spot markets occupy `[2048, 4094]`, i.e. `[2^11, 2^12 - 2]`. */
export const MIN_SPOT_MARKET_INDEX: 2048 = 2048;

/** Highest spot market index, `2^12 - 2`. */
export const MAX_SPOT_MARKET_INDEX: 4094 = 4094;

/** No integrator. Attribute-encoded, so its absence is an explicit zero rather than a missing field. */
export const NIL_INTEGRATOR_INDEX: 0 = 0;

/** No integrator taker fee. */
export const NIL_INTEGRATOR_TAKER_FEE: 0 = 0;

/** No integrator maker fee. */
export const NIL_INTEGRATOR_MAKER_FEE: 0 = 0;

/** Asset index of the native token (LIT). */
export const NATIVE_ASSET_INDEX: 1 = 1;

/** Asset index of USDC. */
export const USDC_ASSET_INDEX: 3 = 3;

/** Asset indices are `uint16` in a `[1, 62]` domain; `0` is the nil marker. */
export const MIN_ASSET_INDEX: 1 = 1;

/** Highest legal asset index, `2^6 - 2`. */
export const MAX_ASSET_INDEX: 62 = 62;

/** No asset. */
export const NIL_ASSET_INDEX: 0 = 0;

/** Strategy index used when none is specified. */
export const DEFAULT_STRATEGY_INDEX: 0 = 0;

/** Strategy indices are `uint8` in `[0, 7]`. */
export const MIN_STRATEGY_INDEX: 0 = 0;

/** Highest legal strategy index. */
export const MAX_STRATEGY_INDEX: 7 = 7;

/** No strategy — one past {@link MAX_STRATEGY_INDEX}, so it is inside the `uint8` width. */
export const NIL_STRATEGY_INDEX: 8 = 8;

/* -------------------------------------------------------------------------------------------------
 * §11.9 — Order domains
 * ---------------------------------------------------------------------------------------------- */

/** Transaction nonces are non-negative. There is no upper bound beyond `int64`. */
export const MIN_NONCE: bigint = 0n;

/** Order nonces occupy `[0, 2^48 - 1]`. */
export const MIN_ORDER_NONCE: bigint = 0n;

/** Highest legal order nonce, `2^48 - 1`. */
export const MAX_ORDER_NONCE: bigint = 281474976710655n;

/** "No client order index." Distinct from index `0` being unusable — `0` *is* the nil value. */
export const NIL_CLIENT_ORDER_INDEX: bigint = 0n;

/** "No order index." */
export const NIL_ORDER_INDEX: bigint = 0n;

/** Client-assigned order indices occupy `[1, 2^48 - 1]`. */
export const MIN_CLIENT_ORDER_INDEX: bigint = 1n;

/** Highest legal client order index, `2^48 - 1`. */
export const MAX_CLIENT_ORDER_INDEX: bigint = 281474976710655n;

/**
 * Exchange-assigned order indices start immediately above the client range, at `2^48`.
 *
 * The two domains are disjoint by construction, so an index alone says which side assigned it.
 */
export const MIN_ORDER_INDEX: bigint = 281474976710656n;

/**
 * Highest exchange-assigned order index, `2^60 - 1`.
 *
 * Exceeds `Number.MAX_SAFE_INTEGER`. As a `number` this rounds to `1152921504606847000`.
 */
export const MAX_ORDER_INDEX: bigint = 1152921504606846975n;

/** Order base amounts occupy `[1, 2^48 - 1]`. */
export const MIN_ORDER_BASE_AMOUNT: bigint = 1n;

/**
 * Highest order base amount, `2^48 - 1`.
 *
 * Note that this exceeds 32 bits and is nevertheless absorbed into the transaction hash as a
 * **single** field element — the lo/hi split is per-field, not per-width
 * (`docs/protocol-notes.md` §3.2).
 */
export const MAX_ORDER_BASE_AMOUNT: bigint = 281474976710655n;

/** "No base amount" — required on the child legs of OTO and OTOCO groups. */
export const NIL_ORDER_BASE_AMOUNT: bigint = 0n;

/** "No price." Prices are `uint32` scaled by the market's price decimals. */
export const NIL_ORDER_PRICE: 0 = 0;

/** Lowest legal order price. */
export const MIN_ORDER_PRICE: 1 = 1;

/** Highest legal order price, `2^32 - 1`. */
export const MAX_ORDER_PRICE: 4_294_967_295 = 4_294_967_295;

/** "No trigger price." */
export const NIL_ORDER_TRIGGER_PRICE: 0 = 0;

/** Lowest legal trigger price. */
export const MIN_ORDER_TRIGGER_PRICE: 1 = 1;

/** Highest legal trigger price, `2^32 - 1`. */
export const MAX_ORDER_TRIGGER_PRICE: 4_294_967_295 = 4_294_967_295;

/** Shortest scheduled cancel-all delay: 5 minutes, in milliseconds. */
export const MIN_ORDER_CANCEL_ALL_PERIOD: bigint = 300_000n;

/** Longest scheduled cancel-all delay: 15 days, in milliseconds. */
export const MAX_ORDER_CANCEL_ALL_PERIOD: bigint = 1_296_000_000n;

/** "No expiry" — the order rests until cancelled. */
export const NIL_ORDER_EXPIRY: bigint = 0n;

/** Lowest non-nil order expiry, in milliseconds since the epoch. */
export const MIN_ORDER_EXPIRY: bigint = 1n;

/**
 * Highest order expiry: `int64` max, `9223372036854775807`.
 *
 * Far past `Number.MAX_SAFE_INTEGER`; a `number` literal here rounds to `9223372036854776000`.
 */
export const MAX_ORDER_EXPIRY: bigint = 9223372036854775807n;

/** Shortest order lifetime measured from now: 5 minutes, in milliseconds. */
export const MIN_ORDER_EXPIRY_PERIOD: bigint = 300_000n;

/** Longest order lifetime measured from now: 30 days, in milliseconds. */
export const MAX_ORDER_EXPIRY_PERIOD: bigint = 2_592_000_000n;

/** A grouped-order transaction carries at most three legs (OTOCO). */
export const MAX_GROUPED_ORDER_COUNT: 3 = 3;

/**
 * Upper bound on `ExpiredAt` and every other transaction timestamp: `2^48 - 1` milliseconds.
 *
 * The field is `int64`, so the bound is `bigint` even though the value is safe as a `number`.
 */
export const MAX_TIMESTAMP: bigint = 281474976710655n;

/* -------------------------------------------------------------------------------------------------
 * §11.10 — Value and share domains
 * ---------------------------------------------------------------------------------------------- */

/** An account may hold shares in at most 16 public pools at once. */
export const MAX_INVESTED_PUBLIC_POOL_COUNT: 16 = 16;

/** A new public pool must be seeded with at least 1,000 USDC worth of shares. */
export const MIN_INITIAL_TOTAL_SHARES: bigint = 1_000_000n;

/** A new public pool may be seeded with at most 1,000,000,000 USDC worth of shares. */
export const MAX_INITIAL_TOTAL_SHARES: bigint = 1_000_000_000_000n;

/** Total public-pool shares are capped at `2^60 - 1`. */
export const MAX_POOL_SHARES: bigint = 1152921504606846975n;

/** A single burn may realise at most `2^60 - 1` USDC base units. */
export const MAX_BURNT_SHARE_USDC_VALUE: bigint = 1152921504606846975n;

/** At most `2^56 - 1` USDC base units may be committed to a pool in one entry. */
export const MAX_POOL_ENTRY_USDC: bigint = 72057594037927935n;

/** Mint and burn amounts are at least one share. */
export const MIN_POOL_SHARES_TO_MINT_OR_BURN: bigint = 1n;

/** Mint and burn amounts are capped at `2^60 - 1` shares. */
export const MAX_POOL_SHARES_TO_MINT_OR_BURN: bigint = 1152921504606846975n;

/** A new staking pool must be seeded with at least 100,000 LIT worth of shares. */
export const MIN_INITIAL_TOTAL_STAKING_SHARES: bigint = 10_000_000_000n;

/** A new staking pool may be seeded with at most 1,000,000,000 LIT worth of shares. */
export const MAX_INITIAL_TOTAL_STAKING_SHARES: bigint = 100_000_000_000_000n;

/** Stake and unstake amounts are at least one share. */
export const MIN_STAKING_SHARES_TO_MINT_OR_BURN: bigint = 1n;

/** Stake and unstake amounts are capped at `2^60 - 1` shares. */
export const MAX_STAKING_SHARES_TO_MINT_OR_BURN: bigint = 1152921504606846975n;

/** Total staking-pool shares are capped at `2^60 - 1`. */
export const MAX_STAKING_POOL_SHARES: bigint = 1152921504606846975n;

/**
 * The exchange-wide USDC ceiling, `2^60 - 1`.
 *
 * Every transfer, withdrawal, margin move and burn is bounded by this value.
 */
export const MAX_EXCHANGE_USDC: bigint = 1152921504606846975n;

/** Transfers move at least one USDC base unit. */
export const MIN_TRANSFER_AMOUNT: bigint = 1n;

/** Transfers are capped at {@link MAX_EXCHANGE_USDC}. */
export const MAX_TRANSFER_AMOUNT: bigint = 1152921504606846975n;

/** Withdrawals move at least one USDC base unit. Withdrawal amounts are `uint64`. */
export const MIN_WITHDRAWAL_AMOUNT: bigint = 1n;

/** Withdrawals are capped at {@link MAX_EXCHANGE_USDC}. */
export const MAX_WITHDRAWAL_AMOUNT: bigint = 1152921504606846975n;

/* -------------------------------------------------------------------------------------------------
 * §11.11 — Sizes
 * ---------------------------------------------------------------------------------------------- */

/**
 * A transaction carries exactly four attribute slots.
 *
 * Unused slots are not omitted: normalization pads with zeros to four entries, and **each padding
 * entry still contributes two field elements** to the hash (`docs/protocol-notes.md` §3.3).
 */
export const NB_ATTRIBUTES_PER_TX: 4 = 4;

/** Highest assigned attribute type code. Types are `[1, 7]`; `0` means "empty slot". */
export const MAX_ATTRIBUTE_TYPE: 7 = 7;

/** A Schnorr signature is 80 bytes: `s` as 40 little-endian bytes, then `e` as 40. */
export const SIGNATURE_LENGTH: 80 = 80;

/** An Ethereum `personal_sign` signature is 65 bytes: `r ‖ s ‖ v`. */
export const L1_SIGNATURE_LENGTH: 65 = 65;

/** A public key is one `GF(p^5)` element: 5 limbs × 8 bytes. */
export const PUBKEY_LENGTH: 40 = 40;

/** A message hash is one `GF(p^5)` element: 5 limbs × 8 bytes. */
export const HASH_LENGTH: 40 = 40;

/** A private key is one `ECgFp5` scalar: 5 limbs × 8 bytes. */
export const PRIVATE_KEY_LENGTH: 40 = 40;

/** A transfer memo is a fixed 32-byte field, hex-encoded verbatim into the L1 message body. */
export const MEMO_LENGTH: 32 = 32;

/* -------------------------------------------------------------------------------------------------
 * Chain ids
 * ---------------------------------------------------------------------------------------------- */

/**
 * Chain id per network (`docs/protocol-notes.md` §7).
 *
 * The chain id is the **first element of every transaction hash**. It is not discoverable from
 * `/systemConfig` or any other endpoint, so it must be configured; a wrong value produces
 * signatures that are internally consistent, verify locally, and are rejected by the sequencer with
 * no indication why.
 *
 * `src/config/endpoints.ts` binds these same numbers to base URLs. `src/tx/**` may not import from
 * `src/config/**`, so the two tables are independent and must agree.
 */
export const CHAIN_ID = {
  /** `https://mainnet.zklighter.elliot.ai` */
  mainnet: 304,
  testnet: 300,
  rh: 466324,
} as const;

/** A configured network name. */
export type ChainName = keyof typeof CHAIN_ID;

/** A known chain id value. Callers may still pass an arbitrary `number` for an unlisted network. */
export type ChainIdCode = (typeof CHAIN_ID)[ChainName];
