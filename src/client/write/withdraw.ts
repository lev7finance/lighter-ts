/**
 * `L2Withdraw` — code 13 — at the human tier.
 *
 * The simplest of the value-movement flows and the one with the fewest ways to go wrong: no fee, no
 * memo, no Ethereum signature. What remains is the scaling, which is exactly the arithmetic the
 * reference gets wrong — `int(amount * ASSET_SCALE)` truncates a binary-float product, so `"0.4"`
 * ETH at eight decimals leaves one unit behind on every call
 * (`docs/protocol-notes.md` §9, `spec/07-high-level-client.md` §11 defect 1). Here the string is
 * parsed lexically and the scale comes from the asset registry.
 *
 * The destination is the account's own L1 address, held by the exchange; there is no address
 * parameter and nothing on this path chooses a recipient. For a withdrawal that pays a bridge to
 * front the funds, and therefore does name a recipient, see `./fast-withdraw.ts`.
 */

import { i16, u64, u8 } from "../../tx/brands.js";
import { USDC_ASSET_INDEX } from "../../tx/constants.js";
import type { WithdrawTx } from "../../tx/types/account.js";
import type { RoundingMode } from "../../util/decimal.js";
import type { TxReceipt } from "../receipt.js";
import {
  type AssetRef,
  type ResolvedAsset,
  type RouteName,
  type WriteCallOptions,
  type WriteContext,
  resolveAsset,
  routeCode,
  scaleAmount,
} from "./transfer.js";

/** {@link withdraw}. */
export interface WithdrawOpts extends WriteCallOptions {
  /** Asset id or symbol. `[1, 62]` on the wire; the scale comes from the registry. */
  readonly asset: AssetRef;
  /** Human decimal string in the asset's own units. `[1, 2^60−1]` once scaled. */
  readonly amount: string;
  /** Which balance the funds leave. Defaults to `perps` for USDC and `spot` for everything else. */
  readonly route?: RouteName;
  /** Rounding when `amount` carries more digits than the asset's scale. Default `EXACT` — throws. */
  readonly rounding?: RoundingMode;
}

/**
 * Withdraw an asset to L1 — code 13.
 *
 * ```ts
 * await withdraw(ctx, { asset: "USDC", amount: "25" });
 * ```
 *
 * There is a server-side delay before the funds appear on L1 (`GET /api/v1/withdrawalDelay`); this
 * call returns as soon as the transaction is accepted, and the receipt's `wait()` reports when it
 * executed on L2, which is not the same event.
 *
 * @throws {LighterMathError} `NOT_REPRESENTABLE` when `amount` carries more fractional digits than
 * the asset's `decimals` and no explicit rounding mode was given.
 * @throws {LighterValidationError} `WITHDRAWAL_AMOUNT_TOO_LOW` for zero, and the codec's own bounds
 * for everything else.
 */
export async function withdraw(ctx: WriteContext, o: WithdrawOpts): Promise<TxReceipt> {
  const asset: ResolvedAsset = resolveAsset(ctx.assets, o.asset);
  const route: RouteName = o.route ?? (asset.assetIndex === USDC_ASSET_INDEX ? "perps" : "spot");
  const amount: bigint = scaleAmount(o.amount, asset.decimals, o.rounding);

  const tx: WithdrawTx = ctx.account.tx.withdraw(
    {
      assetIndex: i16(asset.assetIndex),
      routeType: u8(routeCode(route, "RouteType")),
      amount: u64(amount),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}
