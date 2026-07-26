/**
 * `L2UpdateMargin` — code 29 — at the human tier: add or remove isolated-margin collateral.
 *
 * Meaningful only for an **open isolated-margin position** (`spec/07-high-level-client.md` §3.9). On
 * a cross-margin position there is no per-position collateral bucket to move, and the sequencer
 * refuses it.
 *
 * ## Direction is a field, not a sign
 *
 * `Direction` (`0` remove, `1` add) and the sign of `USDCAmount` are independent. The human tier
 * here only ever produces a **positive** amount and states the direction, because that is the
 * combination the exchange documents.
 *
 * Negative amounts are nevertheless reachable, and deliberately so: the reference validator checks
 * `!= 0` and an upper bound and has **no lower bound**, `USDCAmount` is the one field in the
 * protocol absorbed with an *arithmetic* high-word shift, and three conformance vectors
 * (`update_margin/negative_*`) pin the result. That path stays available through the raw tier —
 * `account.tx.updateMargin({ usdcAmount: i64(-1n) }, { strict: false })` — and this module never
 * normalises a signed value on its way there, because normalising first yields `4294967295` where
 * the reference produces `4294967294` (`docs/protocol-notes.md` §3.2).
 */

import { i16, i64, u8 } from "../../tx/brands.js";
import { MarginDirection } from "../../tx/enums.js";
import type { UpdateMarginTx } from "../../tx/types/account.js";
import type { RoundingMode } from "../../util/decimal.js";
import type { TxReceipt } from "../receipt.js";
import { type WriteCallOptions, type WriteContext, scaleAmount } from "./transfer.js";

/**
 * USDC's protocol scale: `USDCAmount`, `USDCFee` and every other `micro-USDC` field is an integer
 * count of `10^-6` USDC.
 *
 * A protocol constant, not an asset-registry lookup: these fields are defined in micro-USDC by the
 * transaction format itself (`ONE_USDC` in `src/tx/constants.ts` is the same fact as a multiplier),
 * and they stay micro-USDC even if the USDC listing's own `decimals` ever changed.
 */
const MICRO_USDC_DECIMALS: 6 = 6;

/** {@link addMargin} and {@link removeMargin}. */
export interface MarginOpts extends WriteCallOptions {
  /** The perps market whose isolated position is being funded. `[0, 254]`. */
  readonly marketIndex: number;
  /** Human decimal USDC string — `"10.5"` is `10500000` micro-USDC. */
  readonly amount: string;
  /**
   * Rounding when `amount` carries more than six fractional digits. Default `EXACT` — it throws.
   *
   * If you must round, the direction is stated per call site by
   * `spec/07-high-level-client.md` §3.2: `CEIL` when the account is paying (adding collateral) and
   * `FLOOR` when it is receiving (removing it), so rounding never moves more of the user's money
   * than they asked for.
   */
  readonly rounding?: RoundingMode;
}

/**
 * Add isolated-margin collateral to a position — code 29, `Direction = 1`.
 *
 * ```ts
 * await addMargin(ctx, { marketIndex: 1, amount: "10.5" });   // USDCAmount = 10500000n
 * ```
 */
export async function addMargin(ctx: WriteContext, o: MarginOpts): Promise<TxReceipt> {
  return updateMargin(ctx, o, MarginDirection.AddToIsolated);
}

/**
 * Remove isolated-margin collateral from a position — code 29, `Direction = 0`.
 *
 * ```ts
 * await removeMargin(ctx, { marketIndex: 1, amount: "5" });   // USDCAmount = 5000000n
 * ```
 */
export async function removeMargin(ctx: WriteContext, o: MarginOpts): Promise<TxReceipt> {
  return updateMargin(ctx, o, MarginDirection.RemoveFromIsolated);
}

/** The shared body. `direction` is the only difference between the two exported flows. */
function updateMargin(ctx: WriteContext, o: MarginOpts, direction: number): Promise<TxReceipt> {
  const usdcAmount: bigint = scaleAmount(o.amount, MICRO_USDC_DECIMALS, o.rounding);
  const tx: UpdateMarginTx = ctx.account.tx.updateMargin(
    {
      marketIndex: i16(o.marketIndex),
      usdcAmount: i64(usdcAmount),
      direction: u8(direction),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}
