/**
 * Public pools: create (10), update (11), mint shares (18), burn shares (19).
 *
 * ## Three unit systems, none of them interchangeable
 *
 * | Quantity | Unit | Example |
 * | --- | --- | --- |
 * | `operatorFeeTicks` | millionths | `100000` is 10 % |
 * | `minOperatorShareRateBps` | basis points | `100` is 1 % |
 * | `initialTotalShares` | share units | `1_000_000` shares is 1000 USDC at `InitialPoolShareValue` |
 *
 * They are spelled out in the field names for exactly the reason `spec/07-high-level-client.md`
 * §11 defect 6 exists: the reference has two entry points per operation whose parameters differ in
 * both order *and* unit, and a `10` that means 10 %, 0.001 % or 10 shares depending on which one
 * you called is a trivially confusable 10⁴× error.
 *
 * ## The pool's account index is not in the send response
 *
 * It arrives in the **receipt**, inside `event_info`, under the key `a`. The reference polls
 * `GET /api/v1/tx?by=hash` once a second, up to ten times, and parses that JSON by hand at the call
 * site. Here {@link createPublicPool} returns a receipt whose `wait()` resolves
 * `{ poolAccountIndex }` with the same schedule, so no caller re-derives the parse.
 *
 * ## Pool indexes live in the sub-account range
 *
 * `>= 2^47` (`docs/protocol-notes.md` §11). Codes 18/19 enforce it in the codec; code 11's
 * reference validator floors at `-1` instead, which is a reference asymmetry this SDK reproduces at
 * the codec layer and tightens **here**, at the client tier, where a pool index below the
 * sub-account range is unambiguously a caller mistake.
 */

import { LighterValidationError } from "../../errors.js";
import type { DetailedAccount, DetailedAccounts, PublicPoolInfo } from "../../models/account.js";
import { i64, u16, u8 } from "../../tx/brands.js";
import {
  FEE_TICK,
  INITIAL_POOL_SHARE_VALUE,
  MIN_SUB_ACCOUNT_INDEX,
  ONE_USDC,
} from "../../tx/constants.js";
import type {
  BurnSharesTx,
  CreatePublicPoolTx,
  MintSharesTx,
  UpdatePublicPoolTx,
} from "../../tx/types/account.js";
import { type ParsedDecimal, divRound, parseDecimal, toScaled } from "../../util/decimal.js";
import type { TxReceipt, TxResult, WaitOptions } from "../receipt.js";
import type { WriteCallOptions, WriteContext } from "./transfer.js";

/* -------------------------------------------------------------------------------------------------
 * Shared checks
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refuse a pool index outside the sub-account range.
 *
 * @throws {LighterValidationError} `PUBLIC_POOL_INDEX_TOO_LOW`.
 */
export function assertPoolIndex(index: bigint, field: string = "PublicPoolIndex"): bigint {
  if (index < MIN_SUB_ACCOUNT_INDEX) {
    throw new LighterValidationError(
      "PUBLIC_POOL_INDEX_TOO_LOW",
      `${field} ${index.toString()} is below the sub-account range; pool accounts start at ` +
        `${MIN_SUB_ACCOUNT_INDEX.toString()} (docs/protocol-notes.md §11)`,
      { field, bound: MIN_SUB_ACCOUNT_INDEX },
    );
  }
  return index;
}

/** `[0, 1000000]`, the same bound the codec applies, checked before anything is fetched. */
function assertOperatorFee(ticks: bigint): bigint {
  if (ticks < 0n || ticks > BigInt(FEE_TICK)) {
    throw new LighterValidationError(
      "POOL_OPERATOR_FEE_INVALID",
      `operatorFeeTicks must be within [0, ${String(FEE_TICK)}] millionths, got ${ticks.toString()}`,
      { field: "OperatorFee", bound: FEE_TICK },
    );
  }
  return ticks;
}

/* -------------------------------------------------------------------------------------------------
 * 10 — create
 * ---------------------------------------------------------------------------------------------- */

/** {@link createPublicPool}. Exactly one of the two share-supply fields is given. */
export interface CreatePublicPoolOpts extends WriteCallOptions {
  /** The operator's cut, in millionths. `100000` is 10 %. `[0, 1000000]`. */
  readonly operatorFeeTicks: bigint;
  /** The initial share supply, in share units. Mutually exclusive with {@link initialUsdc}. */
  readonly initialTotalShares?: bigint;
  /**
   * The initial supply expressed as USDC, converted at `InitialPoolShareValue` (1000 micro-USDC per
   * share): `"1000"` is `1_000_000` shares. Exact — a value that does not land on a whole share is
   * refused rather than rounded.
   */
  readonly initialUsdc?: string;
  /** The share fraction the operator must retain, in basis points. `100` is 1 %. `<= 10000`. */
  readonly minOperatorShareRateBps: number;
}

/** What {@link CreatePublicPoolReceipt.wait} resolves: a {@link TxResult} plus the new pool. */
export interface PublicPoolCreated extends TxResult {
  /** The new pool's account index, from field `a` of the receipt's `event_info`. */
  readonly poolAccountIndex: bigint;
}

/** The receipt {@link createPublicPool} returns: a {@link TxReceipt} with a narrowed `wait()`. */
export interface CreatePublicPoolReceipt extends TxReceipt {
  /**
   * Poll until the creation executes, then report the new pool's account index.
   *
   * Defaults to the reference's schedule — one poll a second, ten times — because that is what the
   * sequencer's latency was measured against; both are overridable.
   *
   * @throws {LighterTimeoutError} when the transaction has not executed inside the budget. The pool
   * may still be created: the transaction hash remains authoritative.
   * @throws {LighterValidationError} `EVENT_INFO_MALFORMED` when the executed transaction carries
   * no usable `a` field, which means the receipt is not the one this call submitted.
   */
  wait(opts?: WaitOptions): Promise<PublicPoolCreated>;
}

/** The reference's poll cadence for the pool-creation receipt: once a second… */
const POOL_POLL_INTERVAL_MS: 1_000 = 1_000;

/** …up to ten times. */
const POOL_POLL_TIMEOUT_MS: 10_000 = 10_000;

/**
 * Create a public pool — code 10.
 *
 * ```ts
 * const receipt = await createPublicPool(ctx, {
 *   operatorFeeTicks: 100_000n,      // 10 %
 *   initialUsdc: "1000",             // 1_000_000 shares
 *   minOperatorShareRateBps: 100,    // 1 %
 * });
 * const { poolAccountIndex } = await receipt.wait();
 * ```
 *
 * The operator is the signing account, which must be a **master** account — the codec enforces the
 * `[-1, 2^47−1]` bound.
 */
export async function createPublicPool(
  ctx: WriteContext,
  o: CreatePublicPoolOpts,
): Promise<CreatePublicPoolReceipt> {
  const shares: bigint = resolveInitialShares(o);
  const tx: CreatePublicPoolTx = ctx.account.tx.createPublicPool(
    {
      operatorFee: i64(assertOperatorFee(o.operatorFeeTicks)),
      initialTotalShares: i64(shares),
      minOperatorShareRate: u16(o.minOperatorShareRateBps),
    },
    o.tx,
  );
  const receipt: TxReceipt = await ctx.account.send(tx, o.send);
  return poolReceipt(receipt);
}

/** Exactly one of `initialTotalShares` / `initialUsdc`, converted exactly. */
function resolveInitialShares(o: CreatePublicPoolOpts): bigint {
  const both: boolean = o.initialTotalShares !== undefined && o.initialUsdc !== undefined;
  const neither: boolean = o.initialTotalShares === undefined && o.initialUsdc === undefined;
  if (both || neither) {
    throw new LighterValidationError(
      "POOL_INITIAL_SHARES_TOO_LOW",
      "supply exactly one of `initialTotalShares` (share units) or `initialUsdc` (a decimal USDC string)",
      { field: "InitialTotalShares" },
    );
  }
  if (o.initialTotalShares !== undefined) return o.initialTotalShares;
  // `EXACT` twice: once turning the string into micro-USDC, once dividing into whole shares. A
  // deposit that does not land on a share boundary is a caller mistake, not something to round away.
  const microUsdc: bigint = toScaled(o.initialUsdc as string, usdcDecimals(), "EXACT");
  return divRound(microUsdc, BigInt(INITIAL_POOL_SHARE_VALUE), "EXACT");
}

/**
 * USDC's protocol scale, derived from `ONE_USDC` rather than written as a literal so the two can
 * never disagree. `1_000_000` micro-USDC per USDC is six decimal digits.
 */
function usdcDecimals(): number {
  return String(ONE_USDC).length - 1;
}

/** Wrap a receipt so `wait()` also reports the new pool's account index. */
function poolReceipt(receipt: TxReceipt): CreatePublicPoolReceipt {
  const wait = async (opts?: WaitOptions): Promise<PublicPoolCreated> => {
    const result: TxResult = await receipt.wait({
      timeoutMs: POOL_POLL_TIMEOUT_MS,
      pollIntervalMs: POOL_POLL_INTERVAL_MS,
      ...opts,
    });
    return Object.freeze({ ...result, poolAccountIndex: poolIndexOf(result.eventInfo) });
  };
  return Object.freeze({
    txHash: receipt.txHash,
    txType: receipt.txType,
    txInfo: receipt.txInfo,
    nonce: receipt.nonce,
    apiKeyIndex: receipt.apiKeyIndex,
    predictedExecutionTimeMs: receipt.predictedExecutionTimeMs,
    volumeQuotaRemaining: receipt.volumeQuotaRemaining,
    wait,
  });
}

/**
 * The new pool's account index, out of field `a` of a decoded `event_info`.
 *
 * `a` is a JSON number on the wire and account indexes stop at `2^48 − 2`, comfortably inside the
 * safe-integer range, so `JSON.parse` has not lost anything by the time it reaches here — but the
 * check is made rather than assumed, and a string form is read exactly if the API ever emits one.
 */
export function poolIndexOf(eventInfo: unknown): bigint {
  const record: Record<string, unknown> | undefined =
    typeof eventInfo === "object" && eventInfo !== null && !Array.isArray(eventInfo)
      ? (eventInfo as Record<string, unknown>)
      : undefined;
  const raw: unknown = record?.["a"];
  if (typeof raw === "string" && /^\d+$/.test(raw)) return assertPoolIndex(BigInt(raw), "a");
  if (typeof raw === "bigint") return assertPoolIndex(raw, "a");
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return assertPoolIndex(BigInt(raw), "a");
  }
  throw new LighterValidationError(
    "EVENT_INFO_MALFORMED",
    "the executed transaction's event_info carries no `a` field holding the new pool's account index",
    { field: "event_info" },
  );
}

/* -------------------------------------------------------------------------------------------------
 * 11 — update
 * ---------------------------------------------------------------------------------------------- */

/** {@link updatePublicPool}. */
export interface UpdatePublicPoolOpts extends WriteCallOptions {
  /** The pool's own account index. `>= 2^47`. */
  readonly publicPoolIndex: bigint;
  /**
   * The pool's status code.
   *
   * Taken as the protocol's `uint8` rather than a named boolean because the two source documents
   * disagree about which code means open: `spec/04-tx-types.md` §7.4, which is derived from the Go
   * type, says `0` closed / `1` open, while `spec/07-high-level-client.md` §2.5, which paraphrases a
   * Python example's comment, says `0` active / `1` frozen. Use `PoolStatus` from
   * `src/tx/enums.ts` — it follows the former — and treat the disagreement as unresolved.
   */
  readonly status: number;
  /**
   * The operator's cut, in millionths.
   *
   * **May only ever decrease.** Checked here, before signing, against {@link currentOperatorFeeTicks}
   * or against the pool's own record.
   */
  readonly operatorFeeTicks: bigint;
  /** The share fraction the operator must retain, in basis points. */
  readonly minOperatorShareRateBps: number;
  /**
   * The pool's current fee, in millionths, when the caller already knows it.
   *
   * Supplying it skips a read of the pool account — and skips this SDK having to interpret the
   * `operator_fee` string the API returns, whose unit is not documented (see
   * {@link fetchOperatorFeeTicks}).
   */
  readonly currentOperatorFeeTicks?: bigint;
}

/**
 * Change a pool's status, operator fee and minimum operator share — code 11.
 *
 * The fee-may-only-decrease rule is enforced **locally, before signing**: an increase is refused
 * without spending a nonce or reaching the sequencer.
 *
 * @throws {LighterValidationError} `POOL_OPERATOR_FEE_INVALID` for an increase, and
 * `PUBLIC_POOL_INDEX_TOO_LOW` for an index outside the sub-account range.
 */
export async function updatePublicPool(
  ctx: WriteContext,
  o: UpdatePublicPoolOpts,
): Promise<TxReceipt> {
  const poolIndex: bigint = assertPoolIndex(o.publicPoolIndex);
  const next: bigint = assertOperatorFee(o.operatorFeeTicks);
  const current: bigint =
    o.currentOperatorFeeTicks ?? (await fetchOperatorFeeTicks(ctx, poolIndex, o.signal));
  if (next > current) {
    throw new LighterValidationError(
      "POOL_OPERATOR_FEE_INVALID",
      `a public pool's operator fee may only decrease: ${current.toString()} → ${next.toString()} millionths`,
      { field: "OperatorFee", bound: current },
    );
  }
  const tx: UpdatePublicPoolTx = ctx.account.tx.updatePublicPool(
    {
      publicPoolIndex: i64(poolIndex),
      status: u8(o.status),
      operatorFee: i64(next),
      minOperatorShareRate: u16(o.minOperatorShareRateBps),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}

/**
 * The pool's current operator fee in millionths, read from `GET /api/v1/account`.
 *
 * **The wire unit is not documented.** `pool_info.operator_fee` is a decimal *string*, and nothing
 * in either reference SDK states whether it is a tick count (`"100000"`) or a fraction (`"0.1"`).
 * Both appear in the wild for adjacent fields, so this reads it the only way that cannot silently
 * mean the wrong thing: an integral string is a tick count, a fractional one is a fraction of one
 * and is scaled by `FeeTick`. A caller who knows better passes `currentOperatorFeeTicks` and this
 * function is never called.
 */
export async function fetchOperatorFeeTicks(
  ctx: WriteContext,
  poolIndex: bigint,
  signal?: AbortSignal,
): Promise<bigint> {
  const body: DetailedAccounts = await ctx.rest.account.account(
    { by: "index", value: poolIndex.toString(10) },
    signal === undefined ? undefined : { signal },
  );
  const account: DetailedAccount | undefined = (body.accounts ?? [])[0];
  const info: PublicPoolInfo | undefined = account?.pool_info;
  const fee: string | undefined = info?.operator_fee;
  if (fee === undefined || fee === "") {
    throw new LighterValidationError(
      "POOL_OPERATOR_FEE_INVALID",
      `account ${poolIndex.toString()} reports no pool_info.operator_fee, so the "fees may only ` +
        'decrease" rule cannot be checked; pass `currentOperatorFeeTicks` explicitly',
      { field: "OperatorFee" },
    );
  }
  const parsed: ParsedDecimal = parseDecimal(fee);
  return parsed.scale === 0 ? parsed.unscaled : toScaled(fee, feeTickDecimals(), "EXACT");
}

/** `FeeTick` as a count of decimal digits: `1_000_000` millionths is six. */
function feeTickDecimals(): number {
  return String(FEE_TICK).length - 1;
}

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — shares
 * ---------------------------------------------------------------------------------------------- */

/** {@link mintShares} and {@link burnShares}. */
export interface SharesOpts extends WriteCallOptions {
  /** The pool's account index. `>= 2^47`. */
  readonly publicPoolIndex: bigint;
  /** Shares to mint or burn, in share units. `[1, 2^60−1]`. */
  readonly shareAmount: bigint;
}

/**
 * Buy into a public pool — code 18.
 *
 * `shareAmount` is a count of **shares**, not USDC: the two are related by the pool's live share
 * price, which this SDK does not compute for you because the price moves between the quote and the
 * execution.
 */
export async function mintShares(ctx: WriteContext, o: SharesOpts): Promise<TxReceipt> {
  const tx: MintSharesTx = ctx.account.tx.mintShares(
    {
      publicPoolIndex: i64(assertPoolIndex(o.publicPoolIndex)),
      shareAmount: i64(o.shareAmount),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}

/** Redeem public-pool shares — code 19. Structurally {@link mintShares} with a different code. */
export async function burnShares(ctx: WriteContext, o: SharesOpts): Promise<TxReceipt> {
  const tx: BurnSharesTx = ctx.account.tx.burnShares(
    {
      publicPoolIndex: i64(assertPoolIndex(o.publicPoolIndex)),
      shareAmount: i64(o.shareAmount),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}
