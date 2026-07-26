/**
 * The `lighter-ts/tx` subpath: everything needed to build, validate, hash, sign and serialise a
 * Lighter transaction, and nothing that touches a network.
 *
 * ```ts
 * import { buildCreateOrder, signTx, txSubmission, CHAIN_ID, i64, u8, u32, i16 } from "lighter-ts/tx";
 *
 * const unsigned = buildCreateOrder(
 *   { marketIndex: i16(1), clientOrderIndex: i64(100), baseAmount: i64(1_000_000),
 *     price: u32(250_000), isAsk: u8(0), orderType: u8(0), timeInForce: u8(1),
 *     reduceOnly: u8(0), triggerPrice: u32(0), orderExpiry: i64(1_893_456_000_000n) },
 *   { accountIndex: i64(1), apiKeyIndex: u8(0), nonce: i64(42) },
 * );
 * const { txType, txInfo, txHash } = txSubmission(
 *   signTx(unsigned, apiKey, CHAIN_ID.mainnet), CHAIN_ID.mainnet,
 * );
 * ```
 *
 * A bot that only places and cancels orders pulls this and `lighter-ts/crypto` and nothing else. Every
 * module below is side-effect-free, so a bundler drops what is unused.
 *
 * ## Why the re-exports are explicit in one place and starred in the rest
 *
 * `NB_ATTRIBUTES_PER_TX` and `MAX_ATTRIBUTE_TYPE` are declared by both `constants.ts` (as protocol
 * bounds) and `attributes.ts` (as the attribute vocabulary), with identical values. A star export
 * from both would make those two names ambiguous and silently drop them from this barrel, so
 * `attributes.ts` is re-exported by name with those two omitted; the surviving pair comes from
 * `constants.ts`, which is where the protocol's numeric bounds live.
 *
 * ## Scope
 *
 * This barrel covers `src/tx/**` only. The package root barrel, `package.json`, the size budget and
 * CI belong to the integration unit (`docs/decisions.md` D8) and are not touched from here.
 */

// ---- vocabulary: widths, protocol constants, enumerations, field encoding -------------------------
export * from "./brands.js";
export * from "./constants.js";
export * from "./enums.js";
export * from "./field-encode.js";

// ---- the attribute side-channel. Two names come from `constants.js`; see the header. -------------
export {
  ATTRIBUTE_REGISTRY,
  type AttributeSpec,
  type AttributeType,
  type TxAttributes,
  aggregateTxHash,
  attributeTypeSlots,
  attributesAreEmpty,
  attributesHash,
  attributesToJson,
  normalizeAttributes,
  validateAttributes,
} from "./attributes.js";

// ---- the schema engine and the two projections it drives -----------------------------------------
export * from "./schema.js";
export * from "./hash.js";
export * from "./serialize.js";
export * from "./grouped-hash.js";

// ---- the twenty per-type tables ------------------------------------------------------------------
export * from "./schemas/account.js";
export * from "./schemas/orders.js";

// ---- the twenty transaction shapes ---------------------------------------------------------------
export * from "./types/account.js";
export * from "./types/orders.js";

// ---- the validators ------------------------------------------------------------------------------
export * from "./validate/account.js";
export * from "./validate/orders.js";
export * from "./validate/grouped.js";

// ---- L1 (EIP-191) message construction and the injected-signer seam ------------------------------
export * from "./l1/index.js";

// ---- the pipeline: options, builders, hash/sign/serialise ----------------------------------------
export * from "./opts.js";
export * from "./build.js";
export * from "./pipeline.js";
