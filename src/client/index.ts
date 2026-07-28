/**
 * The `./client` subpath barrel: the public client surface, in one place.
 *
 * Every name below is re-exported from the module that owns it — this file declares nothing and
 * defines nothing, so importing it can never change behaviour, only reachability
 * (`docs/decisions.md` D8: one owner per path, and a barrel is owned by exactly one unit).
 *
 * The selection is deliberate rather than a `export *` sweep. Three reasons:
 *
 * 1. **Names collide across modules.** `MAX_ORDER_PRICE` is a protocol constant in three places and
 *    `MARGIN_FRACTION_TICK` in two; a star re-export would either shadow silently or fail to build
 *    depending on which pair happened to overlap.
 * 2. **A barrel is an API promise.** Anything reachable from here is something a caller may depend
 *    on; internals that happen to be exported for a sibling module are not part of that promise.
 * 3. **Tree-shaking.** Every export here is either a type (erased) or a function/class with no
 *    module-scope side effects, so a bundler can drop what a caller does not touch.
 *
 * `src/index.ts`, `package.json` and the exports map belong to the integration unit and are not
 * touched from here.
 */

/* ---------------------------------------------------------------------------------------------- */
/* The client and its accounts                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export { LighterClient, type LighterClientOptions } from "./lighter-client.js";
export {
  LighterAccount,
  PENDING_NONCE,
  type AccountOptions,
  type IntegratorConfig,
  type RawTxOpts,
  type RawTxSurface,
} from "./account.js";

/* ---------------------------------------------------------------------------------------------- */
/* Market and asset metadata                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export {
  MarketRegistry,
  NIL_MARKET_INDEX,
  PERPS_MARKET_INDEX_RANGE,
  SPOT_MARKET_INDEX_RANGE,
  type MarketConfigInfo,
  type MarketFilter,
  type MarketInfo,
  type MarketQuery,
  type MarketSnapshot,
  type PerpsMarketInfo,
} from "./markets.js";
export {
  AssetRegistry,
  type AssetInfo,
  type AssetSnapshot,
  type Decimals,
  type LoadOptions,
  type RegistryOptions,
} from "./assets.js";
export { SystemConfigCache, type SystemConfigInfo } from "./system-config.js";

/* ---------------------------------------------------------------------------------------------- */
/* Nonces                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export { createNonceSource } from "./nonce/index.js";
export type {
  NonceKeySnapshot,
  NonceLease,
  NonceOutcome,
  NonceSnapshot,
  NonceSource,
  NonceSourceKind,
  NonceSourceOptions,
} from "./nonce/types.js";

/* ---------------------------------------------------------------------------------------------- */
/* Submission and receipts                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export type {
  PrepareOpts,
  SendOpts,
  SubmitChannel,
  SubmitContext,
  SubmitTransport,
} from "./submit.js";
export {
  normalizeTxHash,
  txHashesEqual,
  type TxReceipt,
  type TxResult,
  type WaitOptions,
} from "./receipt.js";

/* ---------------------------------------------------------------------------------------------- */
/* Keys and auth tokens                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export { areKeysEqual, createApiKey, type GeneratedApiKey } from "./keys.js";
export {
  createAuthToken,
  DEFAULT_AUTH_TOKEN_EXPIRY_SECONDS,
  MAX_AUTH_TOKEN_LIFETIME_SECONDS,
  type AuthTokenContext,
  type CreateAuthTokenOptions,
} from "./auth-token.js";
export {
  generateAuthTokenSchedule,
  lookupToken,
  READ_ONLY_API_KEY_INDEX,
  type AuthTokenSchedule,
  type AuthTokenScheduleOptions,
} from "./auth-schedule.js";

/* ---------------------------------------------------------------------------------------------- */
/* Pure order math                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

export {
  bestPrice,
  bookFromLevels,
  bookFromRestOrders,
  leverageToImf,
  parseSlippage,
  potentialExecutionPrice,
  quoteToBase,
  slippageBound,
  type BaseSizing,
  type BookLevel,
  type BookSnapshot,
  type ExecutionEstimate,
  type Fraction,
  type LeverageInput,
  type LeverageResult,
  type QuoteSizing,
  type SizingOptions,
  type SlippageMode,
} from "./math/index.js";

/* ---------------------------------------------------------------------------------------------- */
/* This unit: the trading facade                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export {
  DEFAULT_BOOK_DEPTH,
  MarketHandle,
  marketHandle,
  restBookSource,
  TOP_OF_BOOK_DEPTH,
  type AppliedReceipt,
  type BookSource,
  type CancelAllOpts,
  type LeverageApplied,
  type LeverageOpts,
  type LimitOpts,
  type MarginModeName,
  type MarketContext,
  type MarketLookup,
  type ModifyOpts,
  type OrderBookTransport,
  type SizedOrderOpts,
  type TradeCallOptions,
  type TradingAccount,
} from "./market-handle.js";

export {
  assertGroupLegality,
  buildOco,
  buildOto,
  buildOtoco,
  DEFAULT_ORDER_EXPIRY_MS,
  expiryIn,
  NO_ORDER_INTEGERS,
  type Applied,
  type BracketOpts,
  type Duration,
  type EntryOpts,
  type GroupPlan,
  type OtoOpts,
  type PositionBracketOpts,
  type PriceRounding,
  type Side,
  type TimeInForceName,
  type TriggerFamily,
  type TriggerOpts,
} from "./brackets.js";

export { batch, type AccountContext, type BatchContext, type BatchOptions } from "./batch.js";
export {
  sequence,
  type SequenceContext,
  type SequenceOptions,
  type SequencePrepareOpts,
  type SequenceSendOpts,
} from "./sequence.js";
