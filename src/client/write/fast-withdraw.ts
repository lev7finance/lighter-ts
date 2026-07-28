/**
 * Fast withdrawal: pay a bridge pool to front the funds on L1 instead of waiting out the normal
 * withdrawal delay.
 *
 * It is not a withdrawal transaction at all. It is an L2 **transfer** to the bridge's pool account
 * whose 32-byte memo carries the destination L1 address, submitted to a dedicated endpoint that
 * does the L1 leg. Six steps, in this exact order (`spec/07-high-level-client.md` §10.I,
 * `withdraw_fast.py`):
 *
 * 1. an auth token — both metadata reads are authenticated;
 * 2. `GET /api/v1/fastwithdraw/info` → the pool account and the current limits;
 * 3. `GET /api/v1/transferFeeInfo` → the fee, in micro-USDC, passed through unchanged;
 * 4. the memo: 20 address bytes ‖ 12 zero bytes — **this is how the recipient is authenticated**;
 * 5. build and sign the L2 transfer;
 * 6. `POST /api/v1/fastwithdraw` with `tx_info` and `to_address`.
 *
 * ## Why this does not go through `/sendTx`
 *
 * The bridge has to see the transaction before it lands, so the signed document is handed to the
 * bridge endpoint and the bridge submits it. There is therefore no `RespSendTx`, no
 * `predicted_execution_time_ms` and no server-echoed hash: {@link FastWithdrawResult} carries the
 * locally computed transaction hash, which is authoritative anyway.
 *
 * ## The L1 signature question, stated rather than assumed
 *
 * The documented sequence signs the transfer at L2 only, and the memo — which is absent from the L2
 * hash and would ordinarily be bound by an Ethereum signature and nothing else — is what names the
 * recipient. So `L1Sig` goes out as {@link NO_L1_SIGNATURE} and this module never asks for a
 * wallet. If a deployment ever rejects a fast withdrawal as unauthorised, that is the assumption to
 * re-test first; it is recorded here rather than left implicit.
 *
 * ## Auth tokens are secrets
 *
 * The token is passed through per-call `auth` (the `Authorization` header, never the query string)
 * and appears in no error, no diagnostic and no field of the result.
 */

import { LighterValidationError } from "../../errors.js";
import type { ResultCode } from "../../models/common.js";
import type { RespGetFastwithdrawalInfo } from "../../models/misc.js";
import type { CallOptions } from "../../rest/client.js";
import { i16, i64, u8 } from "../../tx/brands.js";
import type { SignedTx } from "../../tx/build.js";
import { USDC_ASSET_INDEX } from "../../tx/constants.js";
import { toTxInfo, txHashHex } from "../../tx/pipeline.js";
import type { TransferTx } from "../../tx/types/account.js";
import { type RoundingMode, compareDecimal } from "../../util/decimal.js";
import { memoFromAddress } from "./memo.js";
import {
  NO_L1_SIGNATURE,
  type AssetRef,
  type ResolvedAsset,
  type RouteName,
  type WriteCallOptions,
  type WriteContext,
  type WriteTransport,
  fetchTransferFee,
  resolveAsset,
  routeCode,
  scaleAmount,
  toAccountIndexParam,
} from "./transfer.js";

/* -------------------------------------------------------------------------------------------------
 * Context
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where the auth token comes from.
 *
 * The token itself is built by the keys/auth unit (`createAuthToken`, `src/client/auth-token.ts`) —
 * this module calls whatever the facade injected and never constructs one, because a second
 * implementation of a signed credential is a second way to get it subtly wrong.
 */
export type AuthTokenProvider = () => string | Promise<string>;

/** The two bridge operations, structurally. `LighterRestClient` satisfies them. */
export interface FastWithdrawTransport extends WriteTransport {
  readonly bridge: {
    fastwithdrawInfo(
      params: { account_index: number },
      opts?: CallOptions,
    ): Promise<RespGetFastwithdrawalInfo>;
    fastwithdraw(
      params: { tx_info: string; to_address: string; auth?: string },
      opts?: CallOptions,
    ): Promise<ResultCode>;
  };
}

/** {@link fastWithdraw}'s context: a write context whose transport reaches the bridge. */
export interface FastWithdrawContext extends WriteContext {
  readonly rest: FastWithdrawTransport;
  /** Supplies the auth token for the two authenticated reads and the POST. */
  readonly authToken: AuthTokenProvider;
}

/* -------------------------------------------------------------------------------------------------
 * Options and result
 * ---------------------------------------------------------------------------------------------- */

/** {@link fastWithdraw}. */
export interface FastWithdrawOpts extends WriteCallOptions {
  /** The destination L1 address — `0x` + 40 hex digits. It reaches the bridge in the memo. */
  readonly toAddress: `0x${string}`;
  /** Human decimal string in the asset's own units. */
  readonly amount: string;
  /** Asset id or symbol. Defaults to USDC, which is what the bridge fronts. */
  readonly asset?: AssetRef;
  /** Source balance. Defaults to `perps` for USDC and `spot` for everything else. */
  readonly fromRoute?: RouteName;
  /**
   * The balance the bridge pool is credited in. Defaults to {@link fromRoute}'s default.
   *
   * Which route the pool actually wants is not documented anywhere and no capture shows one, so the
   * default is the same rule a plain transfer uses rather than a guess dressed up as knowledge. If a
   * bridge ever refuses the transfer, this is the knob.
   */
  readonly toRoute?: RouteName;
  /** The fee in micro-USDC, when the caller already has it. Otherwise `transferFeeInfo` is asked. */
  readonly fee?: bigint;
  /** Rounding when `amount` carries more digits than the asset's scale. Default `EXACT` — throws. */
  readonly rounding?: RoundingMode;
  /**
   * Skip the local check against `max_withdrawal_amount`.
   *
   * The limit is a snapshot and the bridge decides for itself; the check exists so a caller who is
   * obviously over it finds out before signing, not so it can be the last word.
   */
  readonly skipLimitCheck?: boolean;
}

/** What {@link fastWithdraw} reports. There is no `RespSendTx` on this path. */
export interface FastWithdrawResult {
  /** `0x` + 80 lowercase hex — computed locally from the signed transaction. */
  readonly txHash: `0x${string}`;
  /** The exact `tx_info` document handed to the bridge. */
  readonly txInfo: string;
  /** The destination L1 address, as sent. */
  readonly toAddress: string;
  /** The bridge pool account the transfer was addressed to. */
  readonly poolAccountIndex: bigint;
  /** The scaled amount, in the asset's smallest unit. */
  readonly amount: bigint;
  /** The fee actually applied, in micro-USDC. */
  readonly fee: bigint;
  /** The bridge's remaining limit at the time of the call, as a decimal string, when reported. */
  readonly withdrawLimit?: string;
  /** The largest single withdrawal the bridge would front, as a decimal string, when reported. */
  readonly maxWithdrawalAmount?: string;
  /** The bridge's response envelope, verbatim. */
  readonly response: ResultCode;
}

/* -------------------------------------------------------------------------------------------------
 * The flow
 * ---------------------------------------------------------------------------------------------- */

/**
 * Withdraw through the fast-withdraw bridge.
 *
 * ```ts
 * const { txHash } = await fastWithdraw(ctx, { toAddress: "0x…", amount: "25" });
 * ```
 *
 * @throws {LighterValidationError} `L1_ADDRESS_INVALID` for a malformed destination,
 * `FASTWITHDRAW_UNAVAILABLE` when the bridge reports no pool account, and
 * `WITHDRAWAL_AMOUNT_TOO_HIGH` when the amount is over the reported maximum.
 * @throws {LighterMathError} `NOT_REPRESENTABLE` when `amount` carries more digits than the asset.
 */
export async function fastWithdraw(
  ctx: FastWithdrawContext,
  o: FastWithdrawOpts,
): Promise<FastWithdrawResult> {
  // Built first: a malformed address must not cost a request, let alone an auth token.
  const memo: Uint8Array = memoFromAddress(o.toAddress);
  const asset: ResolvedAsset = resolveAsset(ctx.assets, o.asset ?? USDC_ASSET_INDEX);
  const amount: bigint = scaleAmount(o.amount, asset.decimals, o.rounding);

  // 1. the auth token, then 2. the pool, then 3. the fee — the order the endpoints expect, and the
  //    order the acceptance tests assert.
  const token: string = await ctx.authToken();
  const authed: CallOptions =
    o.signal === undefined ? { auth: token } : { auth: token, signal: o.signal };

  const info: RespGetFastwithdrawalInfo = await ctx.rest.bridge.fastwithdrawInfo(
    { account_index: toAccountIndexParam(ctx.account.accountIndex, "account_index") },
    authed,
  );
  const poolAccountIndex: bigint = requirePool(info);
  assertWithinLimit(o, info);

  const fee: bigint =
    o.fee ?? (await fetchTransferFeeWithToken(ctx, poolAccountIndex, token, o.signal));

  // 5. the L2 transfer. `prepare()` stamps the nonce and signs; nothing is submitted through
  //    /sendTx on this path, so the document is serialised here and handed to the bridge.
  const fallback: RouteName = asset.assetIndex === USDC_ASSET_INDEX ? "perps" : "spot";
  const fromRoute: number = routeCode(o.fromRoute ?? fallback, "FromRouteType");
  const toRoute: number = routeCode(o.toRoute ?? o.fromRoute ?? fallback, "ToRouteType");
  const tx: TransferTx = ctx.account.tx.transfer(
    {
      toAccountIndex: i64(poolAccountIndex),
      assetIndex: i16(asset.assetIndex),
      fromRouteType: u8(fromRoute),
      toRouteType: u8(toRoute),
      amount: i64(amount),
      usdcFee: i64(fee),
      memo,
      l1Sig: NO_L1_SIGNATURE,
    },
    o.tx,
  );
  const signed: SignedTx = await ctx.account.prepare(tx, o.send);
  const txInfo: string = toTxInfo(signed);

  // 6. the bridge, with the token on the `Authorization` header rather than in the body.
  const response: ResultCode = await ctx.rest.bridge.fastwithdraw(
    { tx_info: txInfo, to_address: o.toAddress },
    authed,
  );

  return Object.freeze({
    txHash: `0x${txHashHex(signed, ctx.chainId)}` as `0x${string}`,
    txInfo,
    toAddress: o.toAddress,
    poolAccountIndex,
    amount,
    fee,
    ...(info.withdraw_limit !== undefined ? { withdrawLimit: info.withdraw_limit } : {}),
    ...(info.max_withdrawal_amount !== undefined
      ? { maxWithdrawalAmount: info.max_withdrawal_amount }
      : {}),
    response,
  });
}

/** The bridge pool account, or a typed refusal — a transfer to account `0` is the treasury. */
function requirePool(info: RespGetFastwithdrawalInfo): bigint {
  const index: number | undefined = info.to_account_index;
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
    throw new LighterValidationError(
      "FASTWITHDRAW_UNAVAILABLE",
      "fastwithdraw/info reported no to_account_index, so there is no bridge pool to pay",
      { field: "to_account_index" },
    );
  }
  return BigInt(index);
}

/** Refuse an amount the bridge has already said it will not front. */
function assertWithinLimit(o: FastWithdrawOpts, info: RespGetFastwithdrawalInfo): void {
  if (o.skipLimitCheck === true) return;
  const max: string | undefined = info.max_withdrawal_amount;
  if (max === undefined || max === "") return;
  // Exact decimal comparison, aligned in `bigint`: never a float comparison of two strings.
  if (compareDecimal(o.amount, max) > 0) {
    throw new LighterValidationError(
      "WITHDRAWAL_AMOUNT_TOO_HIGH",
      `the bridge's maximum fast withdrawal is ${max}; requested ${o.amount}`,
      { field: "Amount" },
    );
  }
}

/** `transferFeeInfo`, carrying the token this flow already holds. */
function fetchTransferFeeWithToken(
  ctx: FastWithdrawContext,
  poolAccountIndex: bigint,
  token: string,
  signal: AbortSignal | undefined,
): Promise<bigint> {
  // The token rides on the context's transport for this one call, so `fetchTransferFee` stays the
  // single place that reads `transfer_fee_usdc` and refuses an unsafe integer.
  const scoped: FastWithdrawContext = {
    ...ctx,
    rest: {
      ...ctx.rest,
      info: {
        transferFeeInfo: (
          params: { account_index: number; to_account_index?: number },
          opts?: CallOptions,
        ): ReturnType<WriteTransport["info"]["transferFeeInfo"]> =>
          ctx.rest.info.transferFeeInfo(params, { ...opts, auth: token }),
      },
    },
  };
  return fetchTransferFee(scoped, poolAccountIndex, signal);
}
