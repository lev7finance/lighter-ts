/**
 * `L2Transfer` — code 12 — at the human tier, plus the context and the L1 plumbing the rest of
 * `src/client/write/` is built on.
 *
 * ## Why the shared vocabulary lives here
 *
 * This unit owns exactly nine files and none of them is a `types.ts` (`docs/decisions.md` D8: one
 * owner per path, and the barrel belongs to the integration unit). The context every write function
 * takes, and the L1 sign-or-refuse helper three of them need, therefore live in the first and
 * richest L1 flow — this one — and the other files import them from here. `transfer` is the flow
 * whose L1 requirement is conditional, whose fee comes off the wire and whose memo is bound by
 * nothing else, so it is where the reasoning is written down.
 *
 * ## What "human tier" means, exactly
 *
 * `amount` is a decimal **string** scaled by the *asset registry's* `decimals` for that asset — not
 * by a hard-coded id→scale table, which is how the reference breaks on every new listing
 * (`spec/07-high-level-client.md` §1.7, defect 13). The scaling is lexical
 * (`src/util/decimal.ts`): `"8.2"` at 6 decimals is `8200000n`, exactly, where the reference's
 * `int(8.2 × 10⁶)` is `8199999` (`docs/protocol-notes.md` §9, defect 2). A value with more
 * fractional digits than the asset carries is refused by default rather than truncated.
 *
 * ## The L1 signature is conditional, and getting the condition wrong is expensive
 *
 * A transfer needs an Ethereum `personal_sign` when the destination is **not** under the same
 * master account (`spec/04-tx-types.md` §7.5). Demanding one when it is not needed blocks a legal
 * call; omitting one when it is needed submits an unauthorised transaction. Whether the answer can
 * be derived from account indexes alone is an open question (`spec/07-high-level-client.md` §13.5),
 * so nothing here derives it: {@link TransferOpts.sameMasterAccount} states it, and when it is
 * absent {@link isSameMasterAccount} asks `accountsByL1Address`. Index arithmetic is never used.
 */

import { L1SignatureRequiredError, LighterValidationError } from "../../errors.js";
import type {
  Account,
  DetailedAccount,
  DetailedAccounts,
  SubAccounts,
} from "../../models/account.js";
import type { TransferFeeInfo } from "../../models/misc.js";
import type { CallOptions } from "../../rest/client.js";
import { i16, i64, u8 } from "../../tx/brands.js";
import type { SignedTx, UnsignedTx } from "../../tx/build.js";
import { USDC_ASSET_INDEX } from "../../tx/constants.js";
import { AssetRouteType } from "../../tx/enums.js";
import { attachL1Signature, l1MessageFor } from "../../tx/l1/attach.js";
import type { EthPersonalSigner } from "../../tx/l1/signer.js";
import type { L1SigHex, TransferTx } from "../../tx/types/account.js";
import { type RoundingMode, toScaled } from "../../util/decimal.js";
import type { RawTxOpts, RawTxSurface } from "../account.js";
import type { AssetInfo } from "../assets.js";
import type { TxReceipt } from "../receipt.js";
import type { PrepareOpts, SendOpts } from "../submit.js";
import type { SystemConfigInfo } from "../system-config.js";
import { type MemoInput, emptyMemo, toMemo } from "./memo.js";

/* -------------------------------------------------------------------------------------------------
 * The context
 * ---------------------------------------------------------------------------------------------- */

/**
 * The account half of a write context — {@link LighterAccount} satisfies it structurally.
 *
 * Structural rather than nominal so a test can drive every function in this directory with a plain
 * object and no network, and so this module does not depend on the class it is layered over.
 */
export interface WriteAccount {
  /** The signing account. */
  readonly accountIndex: bigint;
  /** The twenty raw builders, already bound to this account. */
  readonly tx: RawTxSurface;
  /** The injected EIP-191 signer, if one was configured. This package never holds an L1 key. */
  readonly l1Signer?: EthPersonalSigner | undefined;
  /** Stamp the nonce, validate, hash and sign — everything except the network. */
  prepare(tx: UnsignedTx, opts?: PrepareOpts): Promise<SignedTx>;
  /** Sign (if needed) and submit. */
  send(prepared: UnsignedTx | SignedTx, opts?: SendOpts): Promise<TxReceipt>;
}

/**
 * The REST operations this directory calls, structurally. `LighterRestClient` satisfies it.
 *
 * Only four operations appear, and each is here because a write needs a number it cannot compute:
 * the fee, the fast-withdraw pool, the account family that decides the L1 requirement, and the pool
 * account whose operator fee may only ever decrease.
 */
export interface WriteTransport {
  readonly account: {
    account(
      params: { by: "index" | "l1_address"; value: string; cursor?: string },
      opts?: CallOptions,
    ): Promise<DetailedAccounts>;
    accountsByL1Address(
      params: { l1_address: string; cursor?: string },
      opts?: CallOptions,
    ): Promise<SubAccounts>;
  };
  readonly info: {
    transferFeeInfo(
      params: { account_index: number; to_account_index?: number },
      opts?: CallOptions,
    ): Promise<TransferFeeInfo>;
  };
}

/** The asset lookups a human-tier amount needs. `AssetRegistry` satisfies it. */
export interface AssetLookup {
  /** Throws on a miss; there is no safe guess about an asset's scale. */
  get(idOrSymbol: number | string): AssetInfo;
  tryGet(idOrSymbol: number | string): AssetInfo | undefined;
  /** The scale, preferring the server and falling back to the offline seed with a diagnostic. */
  decimalsFor(idOrSymbol: number | string): number | undefined;
}

/**
 * The exchange-wide limits an integrator approval is bounded by. `SystemConfigCache` satisfies it.
 *
 * `tryGet` rather than `get`: an unloaded cache is not an error here, it means the cap cannot be
 * checked locally and the sequencer's own bound is the only one that applies.
 */
export interface SystemConfigLookup {
  tryGet(): SystemConfigInfo | undefined;
}

/** What every function in `src/client/write/` is given. Assembled by the trading facade. */
export interface WriteContext {
  readonly account: WriteAccount;
  /** Signing domain. An input to two of the four L1 message templates, never inferred from a URL. */
  readonly chainId: number;
  readonly rest: WriteTransport;
  readonly assets: AssetLookup;
  /** Optional. Only `./integrator.ts` reads it, and only to bound the four fee caps. */
  readonly systemConfig?: SystemConfigLookup | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * L1: sign, or refuse in a way the caller can resume from
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `L1Sig` value of a transaction that legitimately carries no Ethereum signature.
 *
 * Codes 12 and 45 declare `L1Sig` unconditionally on the wire, and the serialiser emits every
 * declared field — nothing in this protocol uses `omitempty` — so a same-master transfer still has
 * to put *something* there. `"0x"` is the only value the serialiser accepts that carries no
 * signature bytes (`src/tx/serialize.ts`, `hexString`), and it is what this SDK sends.
 *
 * **Open question, recorded rather than hidden:** the Go reference leaves the field at its zero
 * value, which its encoder writes as `""`. This SDK cannot emit `""` — `toTxInfo` requires the
 * `0x` prefix — and no capture of a same-master transfer exists to say which the sequencer wants.
 * If one ever rejects a same-master transfer, this constant is the first thing to look at.
 */
export const NO_L1_SIGNATURE: L1SigHex = "0x";

/**
 * An {@link L1SignatureRequiredError} carrying the transaction it was raised for.
 *
 * The transaction is already stamped with the nonce it will be submitted under and already carries
 * its L2 signature, so the resume is exactly one call:
 *
 * ```ts
 * try {
 *   await transfer(ctx, opts);
 * } catch (e) {
 *   if (e instanceof L1SignatureRequiredError) {
 *     const sig = await wallet.signMessage({ message: e.message });
 *     await account.submitWithL1Signature((e as L1SignatureRequired).prepared, sig);
 *   }
 * }
 * ```
 */
export type L1SignatureRequired = L1SignatureRequiredError & { readonly prepared: SignedTx };

/**
 * Build the refusal for a transaction that needs an L1 signature when no signer was injected.
 *
 * `message` **is** the exact EIP-191 body — the same string `template` carries — because that is
 * what the caller has to route to a wallet, and an error whose text is a summary of the thing you
 * actually need is a worse error. Every byte of it comes from `src/tx/l1/templates.ts` and is
 * pinned by `conformance/vectors/tx.json` → `l1Messages`; no message text is written in this
 * directory.
 *
 * @throws {LighterValidationError} `L1_SIGNATURE_NOT_APPLICABLE` if the transaction type has no L1
 * message at all — a caller error, and never reachable from the four flows that call this.
 */
export function l1SignatureRequired(prepared: SignedTx, chainId: number): L1SignatureRequired {
  const message: string | null = l1MessageFor(prepared, chainId);
  if (message === null) {
    throw new LighterValidationError(
      "L1_SIGNATURE_NOT_APPLICABLE",
      `transaction type ${String(prepared.type)} has no L1 message; only types 8, 9, 12 and 45 do`,
      { txType: prepared.type },
    );
  }
  const error: L1SignatureRequiredError = new L1SignatureRequiredError({
    template: message,
    txType: prepared.type,
    message,
  });
  return Object.assign(error, { prepared });
}

/**
 * Submit a transaction, obtaining an Ethereum `personal_sign` first when this particular call needs
 * one.
 *
 * When `needsL1` is false this is `account.send(tx)` and nothing else. When it is true the order is
 * load-bearing:
 *
 * 1. `prepare()` — the nonce is stamped and the L2 signature produced. It has to happen first
 *    because two of the four L1 messages render the nonce, so a message built before the nonce is
 *    known would authorise a different transaction.
 * 2. build the message and hand it to the injected signer, or throw {@link L1SignatureRequired}
 *    carrying the prepared transaction so an outside wallet can finish the job.
 * 3. attach and submit. `submitPrepared` is used because the transaction is already signed, so no
 *    second nonce is taken and the two paths produce the same transaction hash.
 *
 * @throws {L1SignatureRequiredError} when a signature is needed and no `l1Signer` was configured.
 */
export async function sendWithL1Signature(
  ctx: WriteContext,
  tx: UnsignedTx,
  needsL1: boolean,
  opts?: SendOpts,
): Promise<TxReceipt> {
  if (!needsL1) return ctx.account.send(tx, opts);
  const prepared: SignedTx = await ctx.account.prepare(tx, opts);
  const signer: EthPersonalSigner | undefined = ctx.account.l1Signer;
  if (signer === undefined) throw l1SignatureRequired(prepared, ctx.chainId);
  const signed: SignedTx & { l1Sig: L1SigHex } = await attachL1Signature(
    prepared,
    signer,
    ctx.chainId,
  );
  return ctx.account.send(signed, opts);
}

/* -------------------------------------------------------------------------------------------------
 * Account family
 * ---------------------------------------------------------------------------------------------- */

/**
 * Options shared by every call in this directory that can reach the network.
 *
 * Every exported write function is `async` even where its body is synchronous up to the submission.
 * That is deliberate: a function that sometimes throws synchronously and sometimes rejects forces
 * every caller to write both a `try` and a `.catch`, and the one they forget is the one that fires.
 */
export interface WriteCallOptions {
  /** Passed to `account.send()` / `account.prepare()`: nonce mode, channel, timeout, signal. */
  readonly send?: SendOpts;
  /** Per-call overrides for the raw builder: `expiredAt`, `attributes`, `strict`. */
  readonly tx?: RawTxOpts;
  /** Cancellation for the metadata reads this call makes before signing. */
  readonly signal?: AbortSignal;
}

/** `CallOptions` carrying only a signal, and only when there is one. */
function readOpts(signal: AbortSignal | undefined): CallOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

/**
 * An account index as the REST layer's `number`, refusing anything that has already lost digits.
 *
 * Account indexes reach `2^48 − 2`, comfortably inside `Number.MAX_SAFE_INTEGER`, so this always
 * succeeds for a legal index — and says so loudly for one that is not. The conversion goes through
 * the decimal text and is checked by re-rendering it, which is exact by construction; a widening
 * cast would be too, but it would also be indistinguishable from the float conversions this SDK
 * bans, and the round trip states the precondition instead of assuming it.
 */
export function toAccountIndexParam(index: bigint, field: string): number {
  const text: string = index.toString(10);
  const asNumber: number = parseInt(text, 10);
  if (!Number.isSafeInteger(asNumber) || asNumber.toString(10) !== text) {
    throw new LighterValidationError(
      "ACCOUNT_INDEX_TOO_HIGH",
      `${field} ${text} cannot be sent as a query parameter without losing digits`,
      { field },
    );
  }
  return asNumber;
}

/** The L1 address that owns the signing account, from an uncached `GET /api/v1/account`. */
async function ownL1Address(ctx: WriteContext, signal: AbortSignal | undefined): Promise<string> {
  const body: DetailedAccounts = await ctx.rest.account.account(
    { by: "index", value: ctx.account.accountIndex.toString(10) },
    readOpts(signal),
  );
  const first: DetailedAccount | undefined = (body.accounts ?? [])[0];
  const address: string | undefined = first?.l1_address;
  if (address === undefined || address.length === 0) {
    throw new LighterValidationError(
      "L1_ADDRESS_INVALID",
      `account ${ctx.account.accountIndex.toString()} reports no l1_address, so this SDK cannot ` +
        "tell whether the destination shares its master account; pass `sameMasterAccount` explicitly",
      { field: "l1_address" },
    );
  }
  return address;
}

/**
 * Whether `other` sits under the same master account as the signing account.
 *
 * Answered from `accountsByL1Address`, never from index arithmetic: whether the shared-master
 * relation is visible in the indexes at all is open (`spec/07-high-level-client.md` §13.5), and a
 * wrong answer here either blocks a legal transfer or submits an unauthorised one.
 *
 * A self-transfer short-circuits — an account is always under its own master, and that is the
 * `perp ↔ spot` shuffle, which must not need a wallet round trip.
 *
 * Uncached on purpose. Ownership changes rarely, but a stale "yes" is an unauthorised submission,
 * and the two reads happen once per transfer whose caller did not already know the answer.
 */
export async function isSameMasterAccount(
  ctx: WriteContext,
  other: bigint,
  signal?: AbortSignal,
): Promise<boolean> {
  if (other === ctx.account.accountIndex) return true;
  const address: string = await ownL1Address(ctx, signal);
  const family: SubAccounts = await ctx.rest.account.accountsByL1Address(
    { l1_address: address },
    readOpts(signal),
  );
  const members: readonly Account[] = family.sub_accounts ?? [];
  if (members.length === 0) {
    throw new LighterValidationError(
      "ACCOUNT_FAMILY_UNKNOWN",
      `accountsByL1Address returned no accounts for the owner of ${ctx.account.accountIndex.toString()}, ` +
        "so this SDK cannot tell whether the destination shares its master account; pass " +
        "`sameMasterAccount` explicitly",
      { field: "sub_accounts" },
    );
  }
  return members.some(
    (member: Account): boolean => member.index !== undefined && BigInt(member.index) === other,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Assets and amounts
 * ---------------------------------------------------------------------------------------------- */

/** An asset id, or a symbol such as `"USDC"`. Symbols are matched case-insensitively. */
export type AssetRef = number | string;

/** One asset's identity and scale, as the write path needs them. */
export interface ResolvedAsset {
  readonly assetIndex: number;
  readonly decimals: number;
  readonly symbol: string;
}

/**
 * Resolve an asset reference to `(id, decimals)` from the **registry**.
 *
 * The offline seed is consulted only when the registry has nothing — a Worker scaling a USDC
 * transfer before its first round trip — and only for a numeric id, because a symbol cannot be
 * mapped to an id without metadata. Every other path throws rather than guessing a scale: an asset
 * scaled at the wrong exponent is a transfer that is wrong by a factor of one hundred.
 */
export function resolveAsset(assets: AssetLookup, ref: AssetRef): ResolvedAsset {
  const known: AssetInfo | undefined = assets.tryGet(ref);
  if (known !== undefined) {
    return { assetIndex: known.assetId, decimals: known.decimals, symbol: known.symbol };
  }
  if (typeof ref === "number") {
    const seeded: number | undefined = assets.decimalsFor(ref);
    if (seeded !== undefined) {
      return { assetIndex: ref, decimals: seeded, symbol: String(ref) };
    }
  }
  // Throws `LighterConfigError` naming the asset and saying whether the registry was ever loaded.
  const resolved: AssetInfo = assets.get(ref);
  return { assetIndex: resolved.assetId, decimals: resolved.decimals, symbol: resolved.symbol };
}

/**
 * A decimal string in an asset's own units → the protocol integer.
 *
 * `EXACT` is the default everywhere in this directory: a value carrying more fractional digits than
 * the asset has decimals is a mistake worth surfacing, not dust worth discarding. A caller who
 * means to round says so, and `docs/decisions.md` D7 requires the direction to be stated at the
 * call site — `CEIL` when the amount is being paid, `FLOOR` when it is being received
 * (`spec/07-high-level-client.md` §3.2).
 *
 * @throws {LighterMathError} `NOT_REPRESENTABLE` under `EXACT` when digits would be lost.
 * @throws {LighterValidationError} `INVALID_DECIMAL` for anything that is not a plain decimal
 * string — exponent notation, `NaN`, a `number` that has already lost precision.
 */
export function scaleAmount(amount: string, decimals: number, rounding?: RoundingMode): bigint {
  return toScaled(amount, decimals, rounding ?? "EXACT");
}

/* -------------------------------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------------------------- */

/** Which balance a transfer leaves from or lands in. `0` perps, `1` spot. */
export type RouteName = "perps" | "spot";

/**
 * Route name → the protocol's `uint8`, validating the name.
 *
 * Exported so every route in this directory goes through one mapping: a second copy that defaults
 * an unrecognised name to `perps` would move money out of the wrong balance in a JavaScript caller,
 * where the type is not checked.
 */
export function routeCode(route: RouteName, field: string): number {
  if (route === "perps") return AssetRouteType.Perps;
  if (route === "spot") return AssetRouteType.Spot;
  throw new LighterValidationError(
    "ROUTE_TYPE_INVALID",
    `${field} must be "perps" or "spot", got ${JSON.stringify(route)}`,
    { field },
  );
}

/**
 * The default route for an asset.
 *
 * USDC is the collateral asset and lives on the perps route unless the caller says otherwise; every
 * other asset can only move `spot → spot`, which is the rule enforced below. Where exactly one
 * route is legal it is filled in; where two are, the caller states which.
 */
function defaultRoute(assetIndex: number): RouteName {
  return assetIndex === USDC_ASSET_INDEX ? "perps" : "spot";
}

/* -------------------------------------------------------------------------------------------------
 * transfer
 * ---------------------------------------------------------------------------------------------- */

/** {@link transfer}. */
export interface TransferOpts extends WriteCallOptions {
  /** Destination account. Equal to the signing account for a `perp ↔ spot` self-transfer. */
  readonly toAccountIndex: bigint | number;
  /** Asset id or symbol. The scale comes from the registry, never from a constant table. */
  readonly asset: AssetRef;
  /** Human decimal string in the asset's own units — `"8.2"` USDC, `"0.4"` ETH. */
  readonly amount: string;
  /** Source balance. Defaults to `perps` for USDC and `spot` for everything else. */
  readonly fromRoute?: RouteName;
  /** Destination balance. Defaults to {@link fromRoute}'s default. */
  readonly toRoute?: RouteName;
  /**
   * The fee, in **micro-USDC**, passed through to the wire unchanged.
   *
   * Omitted, it is `0` for a same-master transfer (which is free for every asset) and otherwise
   * comes from `GET /api/v1/transferFeeInfo` — an **authenticated** read, so a client that makes
   * cross-owner transfers without supplying `fee` must be constructed with an `auth` token.
   */
  readonly fee?: bigint;
  /** 32 bytes, or `0x` + 64 hex digits. Defaults to 32 zero bytes. */
  readonly memo?: MemoInput;
  /**
   * States the L1 requirement instead of discovering it.
   *
   * `true` skips both metadata reads and signs no L1 message; `false` forces the signature. Left
   * undefined, {@link isSameMasterAccount} asks the API.
   */
  readonly sameMasterAccount?: boolean;
  /** Rounding when `amount` carries more digits than the asset's scale. Default `EXACT` — throws. */
  readonly rounding?: RoundingMode;
}

/**
 * Move an asset between accounts, and/or between the perps and spot balances — code 12.
 *
 * ```ts
 * await transfer(ctx, { toAccountIndex: 42n, asset: "USDC", amount: "8.2", toRoute: "spot" });
 * ```
 *
 * Route rules (`spec/07-high-level-client.md` §2.4): USDC may move perps↔spot in any combination,
 * including to the account's own index — that is how a caller shuffles between their own perps and
 * spot balances. Every other asset must move `spot → spot`, and anything else is refused here
 * rather than by the sequencer.
 *
 * @throws {L1SignatureRequiredError} for a cross-owner transfer with no `l1Signer` configured. The
 * error carries the exact message to sign and the prepared transaction to resume with.
 * @throws {LighterMathError} `NOT_REPRESENTABLE` when `amount` has more digits than the asset.
 * @throws {LighterValidationError} for a route combination the asset does not allow, and for every
 * field bound the codec checks.
 */
export async function transfer(ctx: WriteContext, o: TransferOpts): Promise<TxReceipt> {
  const asset: ResolvedAsset = resolveAsset(ctx.assets, o.asset);
  const to: bigint = BigInt(o.toAccountIndex);
  const fromRoute: RouteName = o.fromRoute ?? defaultRoute(asset.assetIndex);
  const toRoute: RouteName = o.toRoute ?? o.fromRoute ?? defaultRoute(asset.assetIndex);
  const fromCode: number = routeCode(fromRoute, "FromRouteType");
  const toCode: number = routeCode(toRoute, "ToRouteType");

  if (asset.assetIndex !== USDC_ASSET_INDEX && (fromRoute !== "spot" || toRoute !== "spot")) {
    throw new LighterValidationError(
      "ROUTE_TYPE_INVALID",
      `${asset.symbol} is not USDC, so it can only move spot → spot; received ${fromRoute} → ${toRoute}`,
      { field: "FromRouteType" },
    );
  }

  const amount: bigint = scaleAmount(o.amount, asset.decimals, o.rounding);
  const sameMaster: boolean =
    o.sameMasterAccount ?? (await isSameMasterAccount(ctx, to, o.signal));
  const fee: bigint = await resolveTransferFee(ctx, to, sameMaster, o.fee, o.signal);
  const memo: Uint8Array = o.memo === undefined ? emptyMemo() : toMemo(o.memo);

  const tx: TransferTx = ctx.account.tx.transfer(
    {
      toAccountIndex: i64(to),
      assetIndex: i16(asset.assetIndex),
      fromRouteType: u8(fromCode),
      toRouteType: u8(toCode),
      amount: i64(amount),
      usdcFee: i64(fee),
      memo,
      l1Sig: NO_L1_SIGNATURE,
    },
    o.tx,
  );
  return sendWithL1Signature(ctx, tx, !sameMaster, o.send);
}

/**
 * The fee for one transfer, in micro-USDC.
 *
 * A same-master transfer is free for every asset (`spec/07-high-level-client.md` §2.4), so no
 * authenticated read is made for one — which also keeps the same-master path usable with no auth
 * token configured at all. Everything else asks the server and passes the answer through
 * **unchanged**: it is already an integer count of micro-USDC and converting it would be the only
 * way to get it wrong.
 */
async function resolveTransferFee(
  ctx: WriteContext,
  to: bigint,
  sameMaster: boolean,
  explicit: bigint | undefined,
  signal: AbortSignal | undefined,
): Promise<bigint> {
  if (explicit !== undefined) return explicit;
  if (sameMaster) return 0n;
  return fetchTransferFee(ctx, to, signal);
}

/**
 * `GET /api/v1/transferFeeInfo` — the fee in micro-USDC, as a `bigint`.
 *
 * The server declares `transfer_fee_usdc` an `int64` and `JSON.parse` has already made it a
 * `number`, so a value beyond `Number.MAX_SAFE_INTEGER` arrived rounded and is refused rather than
 * laundered into a signed transaction. A fee that large is not a real fee.
 */
export async function fetchTransferFee(
  ctx: WriteContext,
  toAccountIndex: bigint,
  signal?: AbortSignal,
): Promise<bigint> {
  const body: TransferFeeInfo = await ctx.rest.info.transferFeeInfo(
    {
      account_index: toAccountIndexParam(ctx.account.accountIndex, "account_index"),
      to_account_index: toAccountIndexParam(toAccountIndex, "to_account_index"),
    },
    readOpts(signal),
  );
  const fee: number | undefined = body.transfer_fee_usdc;
  if (fee === undefined) return 0n;
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw new LighterValidationError(
      "TRANSFER_FEE_TOO_HIGH",
      `transferFeeInfo returned ${String(fee)}, which is not a usable micro-USDC integer`,
      { field: "USDCFee" },
    );
  }
  return BigInt(fee);
}
