/**
 * LIT staking: stake (35) and unstake (36).
 *
 * Structurally the pool mint/burn pair with a different index field and a different set of bounds —
 * and with the reference's own naming defect avoided. `stake_and_unstake.py` calls the unstake
 * helper with `public_pool_index=` while the parameter is named `staking_pool_index`, so the
 * reference's own example does not run (`spec/07-high-level-client.md` §11 defect 12). Here the
 * field is `stakingPoolIndex` on both calls and the compiler enforces it.
 *
 * The staking pool's account index is in `GET /api/v1/systemConfig` as `staking_pool_index`; it sits
 * in the sub-account range like every pool (`docs/protocol-notes.md` §11), which is checked here
 * before anything is signed. The `stake_assets` conformance vector uses `140737488355335`.
 *
 * Unstaking is subject to a server-side lockup (`staking_pool_lockup_period_ms` in the same
 * system config); a successful submission is not a released balance.
 */

import { LighterValidationError } from "../../errors.js";
import { i64 } from "../../tx/brands.js";
import { MIN_SUB_ACCOUNT_INDEX } from "../../tx/constants.js";
import type { StakeAssetsTx, UnstakeAssetsTx } from "../../tx/types/account.js";
import type { TxReceipt } from "../receipt.js";
import type { WriteCallOptions, WriteContext } from "./transfer.js";

/** {@link stake} and {@link unstake}. */
export interface StakingOpts extends WriteCallOptions {
  /** The staking pool's account index. `>= 2^47`; read it from `/systemConfig`. */
  readonly stakingPoolIndex: bigint;
  /** Shares to stake or unstake, in share units. `[1, 2^60−1]`. */
  readonly shareAmount: bigint;
}

/**
 * Refuse a staking pool index outside the sub-account range, before signing.
 *
 * @throws {LighterValidationError} `STAKING_POOL_INDEX_TOO_LOW`.
 */
function assertStakingPoolIndex(index: bigint): bigint {
  if (index < MIN_SUB_ACCOUNT_INDEX) {
    throw new LighterValidationError(
      "STAKING_POOL_INDEX_TOO_LOW",
      `stakingPoolIndex ${index.toString()} is below the sub-account range; staking pools start at ` +
        `${MIN_SUB_ACCOUNT_INDEX.toString()} (docs/protocol-notes.md §11)`,
      { field: "StakingPoolIndex", bound: MIN_SUB_ACCOUNT_INDEX },
    );
  }
  return index;
}

/**
 * Stake LIT into a staking pool — code 35.
 *
 * ```ts
 * await stake(ctx, { stakingPoolIndex: 140737488355335n, shareAmount: 10_000_000_000n });
 * ```
 */
export async function stake(ctx: WriteContext, o: StakingOpts): Promise<TxReceipt> {
  const tx: StakeAssetsTx = ctx.account.tx.stakeAssets(
    {
      stakingPoolIndex: i64(assertStakingPoolIndex(o.stakingPoolIndex)),
      shareAmount: i64(o.shareAmount),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}

/**
 * Unstake LIT from a staking pool — code 36.
 *
 * The codec reports `PUBLIC_POOL_INDEX_*` for an out-of-range index on this code and
 * `STAKING_POOL_INDEX_*` on code 35 — a copy-paste in the reference that is reproduced there
 * deliberately. The client-tier check above reports the field it actually read, on both.
 */
export async function unstake(ctx: WriteContext, o: StakingOpts): Promise<TxReceipt> {
  const tx: UnstakeAssetsTx = ctx.account.tx.unstakeAssets(
    {
      stakingPoolIndex: i64(assertStakingPoolIndex(o.stakingPoolIndex)),
      shareAmount: i64(o.shareAmount),
    },
    o.tx,
  );
  return ctx.account.send(tx, o.send);
}
