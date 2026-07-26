/**
 * `L2ApproveIntegrator` — code 45: authorise an integrator to charge fees on this account's trades,
 * up to explicit caps, until an explicit deadline.
 *
 * ## Three things about this transaction are counter-intuitive
 *
 * 1. **`approvalExpiry = 0` revokes.** It is not "no expiry" and it is not "unset". The codec
 *    additionally requires every fee cap to be zero when the expiry is, so a revocation that still
 *    names a fee is refused rather than silently reinterpreted.
 * 2. **The L1 signature is conditional.** It is required only when a *third-party* integrator is
 *    being authorised to charge a *non-zero* fee. Zero fees — an approval that grants attribution
 *    but no revenue, or a revocation — need none, and neither does an integrator under the same
 *    master account (`spec/07-high-level-client.md` §2.6, which is why the reference has a
 *    dedicated `sign_approve_integrator_same_master_account`).
 * 3. **`ApprovalExpiry` is not `ExpiredAt`.** The transaction's own deadline governs when the
 *    *submission* stops being valid; the approval's deadline governs the authorisation, is
 *    typically months away, and is the one the L1 message renders.
 *
 * Fees are millionths of a trade's notional: `1000` is 0.1 %, `FeeTick` is `1_000_000`. Each is
 * additionally bounded by the exchange-wide cap in `GET /api/v1/systemConfig`
 * (`max_integrator_perps_taker_fee` and its three siblings), checked here when a system config is
 * available so an over-cap approval never reaches the wire.
 */

import { LighterValidationError } from "../../errors.js";
import { i64, u32 } from "../../tx/brands.js";
import { FEE_TICK } from "../../tx/constants.js";
import type { ApproveIntegratorTx } from "../../tx/types/account.js";
import type { TxReceipt } from "../receipt.js";
import type { SystemConfigInfo } from "../system-config.js";
import {
  NO_L1_SIGNATURE,
  type WriteCallOptions,
  type WriteContext,
  isSameMasterAccount,
  sendWithL1Signature,
} from "./transfer.js";

/** The four fee caps, each in millionths. `0` on all four is a zero-fee approval. */
export interface IntegratorFeeCaps {
  /** `MaxPerpsTakerFee`, millionths. `<= 1000000`, and `<= max_integrator_perps_taker_fee`. */
  readonly maxPerpsTakerFee: number;
  /** `MaxPerpsMakerFee`, millionths. */
  readonly maxPerpsMakerFee: number;
  /** `MaxSpotTakerFee`, millionths. */
  readonly maxSpotTakerFee: number;
  /** `MaxSpotMakerFee`, millionths. */
  readonly maxSpotMakerFee: number;
}

/** {@link approveIntegrator}. */
export interface ApproveIntegratorOpts extends WriteCallOptions, IntegratorFeeCaps {
  /** The integrator's account index. */
  readonly integratorAccountIndex: bigint | number;
  /**
   * The approval deadline, in **Unix milliseconds**. `0` revokes.
   *
   * There is no "never expires" value; an approval that should outlive the caller's attention still
   * has to name a date.
   */
  readonly approvalExpiry: bigint;
  /**
   * States whether the integrator shares this account's master, instead of discovering it.
   *
   * Left undefined, and only when a fee is non-zero, the account family is read from
   * `accountsByL1Address` — the same rule and the same reasoning as a transfer.
   */
  readonly sameMasterAccount?: boolean;
}

/** All four caps zero: an approval that grants attribution but no revenue, or a revocation. */
function allFeesZero(fees: IntegratorFeeCaps): boolean {
  return (
    fees.maxPerpsTakerFee === 0 &&
    fees.maxPerpsMakerFee === 0 &&
    fees.maxSpotTakerFee === 0 &&
    fees.maxSpotMakerFee === 0
  );
}

/**
 * Whether this particular approval needs an Ethereum `personal_sign`.
 *
 * Exported because the answer is worth knowing *before* the call: an application that has to route
 * a message to a wallet would rather find out up front than by catching an error. Zero-fee
 * approvals are answered without any I/O at all.
 */
export async function approvalNeedsL1Signature(
  ctx: WriteContext,
  o: ApproveIntegratorOpts,
): Promise<boolean> {
  if (allFeesZero(o)) return false;
  const sameMaster: boolean =
    o.sameMasterAccount ??
    (await isSameMasterAccount(ctx, BigInt(o.integratorAccountIndex), o.signal));
  return !sameMaster;
}

/**
 * Authorise an integrator — code 45.
 *
 * ```ts
 * await approveIntegrator(ctx, {
 *   integratorAccountIndex: 4242n,
 *   maxPerpsTakerFee: 1000,   // 0.1 %
 *   maxPerpsMakerFee: 500,
 *   maxSpotTakerFee: 800,
 *   maxSpotMakerFee: 400,
 *   approvalExpiry: 1893456000000n,
 * });
 * ```
 *
 * @throws {L1SignatureRequiredError} when a third party is being granted a non-zero fee and no
 * `l1Signer` is configured. The error's `message` is the exact `Approve Integrator…` body and its
 * `prepared` transaction resumes through `account.submitWithL1Signature(prepared, signature)`.
 * @throws {LighterValidationError} `INTEGRATOR_FEE_RANGE` when a cap exceeds the exchange-wide
 * maximum, `FEE_TOO_HIGH` when one exceeds `FeeTick`, and
 * `APPROVAL_EXPIRY_ZERO_ON_REVOCATION` when a revocation still names a fee.
 */
export async function approveIntegrator(
  ctx: WriteContext,
  o: ApproveIntegratorOpts,
): Promise<TxReceipt> {
  assertFeeCaps(ctx, o);
  const needsL1: boolean = await approvalNeedsL1Signature(ctx, o);
  const tx: ApproveIntegratorTx = ctx.account.tx.approveIntegrator(
    {
      integratorAccountIndex: i64(BigInt(o.integratorAccountIndex)),
      maxPerpsTakerFee: u32(o.maxPerpsTakerFee),
      maxPerpsMakerFee: u32(o.maxPerpsMakerFee),
      maxSpotTakerFee: u32(o.maxSpotTakerFee),
      maxSpotMakerFee: u32(o.maxSpotMakerFee),
      approvalExpiry: i64(o.approvalExpiry),
      l1Sig: NO_L1_SIGNATURE,
    },
    o.tx,
  );
  return sendWithL1Signature(ctx, tx, needsL1, o.send);
}

/**
 * Revoke an integrator's authorisation — code 45 with four zero fees and `ApprovalExpiry = 0`.
 *
 * There is no separate revocation transaction: this *is* the revocation, and it needs no Ethereum
 * signature, so it works from a process that holds no L1 key at all. That matters — the account
 * that most needs to revoke an integrator is the one whose wallet is unavailable.
 */
export async function revokeIntegrator(
  ctx: WriteContext,
  integratorAccountIndex: bigint | number,
  o?: WriteCallOptions,
): Promise<TxReceipt> {
  return approveIntegrator(ctx, {
    ...o,
    integratorAccountIndex,
    maxPerpsTakerFee: 0,
    maxPerpsMakerFee: 0,
    maxSpotTakerFee: 0,
    maxSpotMakerFee: 0,
    approvalExpiry: 0n,
    // A revocation is authorised by the L2 signature alone; no family lookup, no wallet round trip.
    sameMasterAccount: true,
  });
}

/**
 * Bound each cap by `FeeTick` and, when a system config is loaded, by the exchange-wide maximum.
 *
 * The `FeeTick` check duplicates one the codec makes, on purpose: it runs before the nonce is
 * taken and names the human-tier field, whereas the codec's runs inside the builder and names the
 * wire field. The exchange-wide check exists nowhere else.
 */
function assertFeeCaps(ctx: WriteContext, fees: IntegratorFeeCaps): void {
  const config: SystemConfigInfo | undefined = ctx.systemConfig?.tryGet();
  const rows: readonly (readonly [string, number, number | undefined])[] = [
    ["maxPerpsTakerFee", fees.maxPerpsTakerFee, config?.maxIntegratorPerpsTakerFeeTicks],
    ["maxPerpsMakerFee", fees.maxPerpsMakerFee, config?.maxIntegratorPerpsMakerFeeTicks],
    ["maxSpotTakerFee", fees.maxSpotTakerFee, config?.maxIntegratorSpotTakerFeeTicks],
    ["maxSpotMakerFee", fees.maxSpotMakerFee, config?.maxIntegratorSpotMakerFeeTicks],
  ];
  for (const [field, value, cap] of rows) {
    if (!Number.isInteger(value) || value < 0 || value > FEE_TICK) {
      throw new LighterValidationError(
        "FEE_TOO_HIGH",
        `${field} is a count of millionths within [0, ${String(FEE_TICK)}], got ${String(value)}`,
        { field, bound: FEE_TICK },
      );
    }
    if (cap !== undefined && value > cap) {
      throw new LighterValidationError(
        "INTEGRATOR_FEE_RANGE",
        `${field} ${String(value)} exceeds the exchange's maximum of ${String(cap)} millionths`,
        { field, bound: cap },
      );
    }
  }
}
