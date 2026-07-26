/**
 * Account configuration: trading mode (code 41), per-asset margin opt-in (code 42), and
 * sub-account creation (code 9).
 *
 * Two one-field switches and one of the four flows that need an Ethereum `personal_sign`.
 *
 * ## Code 9 needs a signature and has nowhere to put it
 *
 * `docs/decisions.md` D6 ratifies **four** L1 flows, not the three the architecture's prose listed,
 * and `create_sub_account` is the one that gets dropped when someone counts the `L1Sig` fields
 * instead of the flows: its L2 body has no such field (`spec/04-tx-types.md` §7.2 — the vector's
 * fields are exactly `AccountIndex, ApiKeyIndex, ExpiredAt, Nonce`), because the Ethereum
 * signature authorises the creation *out of band*. So this module still refuses to submit one
 * without a signer, and still hands back the exact message to sign; what it does not do is put the
 * result on the wire, where it would corrupt the document.
 */

import { LighterValidationError } from "../../errors.js";
import { i16, u8 } from "../../tx/brands.js";
import { AccountAssetMarginMode, AccountTradingMode } from "../../tx/enums.js";
import type {
  CreateSubAccountTx,
  UpdateAccountAssetConfigTx,
  UpdateAccountConfigTx,
} from "../../tx/types/account.js";
import type { TxReceipt } from "../receipt.js";
import {
  type AssetRef,
  type ResolvedAsset,
  type WriteCallOptions,
  type WriteContext,
  resolveAsset,
  sendWithL1Signature,
} from "./transfer.js";

/* -------------------------------------------------------------------------------------------------
 * 41 — trading mode
 * ---------------------------------------------------------------------------------------------- */

/**
 * How the account computes margin.
 *
 * `"simple"` is the standard per-market model; `"uta"` is the unified trading account, in which
 * every enabled asset contributes to one collateral pool — which is why enabling it is usually
 * followed by {@link setAssetMarginMode} for each asset that should count.
 */
export type AccountTradingModeName = "simple" | "uta";

/**
 * Switch the account between standard and unified trading — code 41.
 *
 * ```ts
 * await setAccountTradingMode(ctx, "uta");
 * ```
 */
export async function setAccountTradingMode(
  ctx: WriteContext,
  mode: AccountTradingModeName,
  o?: WriteCallOptions,
): Promise<TxReceipt> {
  const code: number =
    mode === "simple"
      ? AccountTradingMode.Standard
      : mode === "uta"
        ? AccountTradingMode.Unified
        : unknownMode(mode);
  const tx: UpdateAccountConfigTx = ctx.account.tx.updateAccountConfig(
    { accountTradingMode: u8(code) },
    o?.tx,
  );
  return ctx.account.send(tx, o?.send);
}

/** Never returns; typed as `number` so the conditional above stays an expression. */
function unknownMode(mode: string): number {
  throw new LighterValidationError(
    "ACCOUNT_TRADING_MODE_INVALID",
    `account trading mode must be "simple" or "uta", got ${JSON.stringify(mode)}`,
    { field: "AccountTradingMode" },
  );
}

/* -------------------------------------------------------------------------------------------------
 * 42 — per-asset margin opt-in
 * ---------------------------------------------------------------------------------------------- */

/**
 * Opt one asset in or out of being used as this account's margin — code 42.
 *
 * ```ts
 * await setAssetMarginMode(ctx, "ETH", true);
 * ```
 *
 * Per-account, and distinct from the exchange-wide `AssetMarginMode` reported on
 * `/api/v1/assetDetails`: an asset the exchange does not accept as margin cannot be enabled here,
 * and the refusal comes from the sequencer.
 *
 * The asset reference is resolved through the registry, so a symbol works and an unknown asset is a
 * local error rather than a rejected transaction.
 */
export async function setAssetMarginMode(
  ctx: WriteContext,
  asset: AssetRef,
  enabled: boolean,
  o?: WriteCallOptions,
): Promise<TxReceipt> {
  const resolved: ResolvedAsset = resolveAsset(ctx.assets, asset);
  const tx: UpdateAccountAssetConfigTx = ctx.account.tx.updateAccountAssetConfig(
    {
      assetIndex: i16(resolved.assetIndex),
      assetMarginMode: u8(
        enabled ? AccountAssetMarginMode.MarginEnabled : AccountAssetMarginMode.MarginDisabled,
      ),
    },
    o?.tx,
  );
  return ctx.account.send(tx, o?.send);
}

/* -------------------------------------------------------------------------------------------------
 * 9 — sub-account creation
 * ---------------------------------------------------------------------------------------------- */

/** {@link createSubAccount}. There are no business parameters; the transaction is pure identity. */
export type CreateSubAccountOpts = WriteCallOptions;

/**
 * Create a sub-account under this master account — code 9.
 *
 * The signing account must be a **master** account (`[-1, 2^47−1]`); the codec enforces that bound,
 * and the new sub-account's index is assigned by the sequencer, not chosen here.
 *
 * An Ethereum `personal_sign` over `Create Lighter Sub Account…` is required
 * (`docs/decisions.md` D6). The message renders one argument — the master account index — and
 * neither a nonce nor a chain id, so the same account always signs the same text.
 *
 * @throws {L1SignatureRequiredError} when no `l1Signer` is configured. The error's `message` is the
 * exact body to sign, and its `prepared` transaction resumes through
 * `account.submitWithL1Signature(prepared, signature)`.
 */
export async function createSubAccount(
  ctx: WriteContext,
  o?: CreateSubAccountOpts,
): Promise<TxReceipt> {
  const tx: CreateSubAccountTx = ctx.account.tx.createSubAccount({}, o?.tx);
  return sendWithL1Signature(ctx, tx, true, o?.send);
}
