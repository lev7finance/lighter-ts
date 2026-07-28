/**
 * The transaction-aware glue: which transaction types need an L1 `personal_sign`, what exactly they
 * need signed, and how the resulting signature is attached.
 *
 * ## Four flows need a signature; three have somewhere to put it
 *
 * This is the distinction that this module exists to keep straight, and it is the one thing a
 * reader is most likely to get wrong:
 *
 * | Code | Transaction | Needs a `personal_sign`? | Declares an `L1Sig` wire field? |
 * | --- | --- | --- | --- |
 * | 8 | `L2ChangePubKey` | yes | yes |
 * | 12 | `L2Transfer` | yes | yes |
 * | 45 | `L2ApproveIntegrator` | yes | yes |
 * | 9 | `L2CreateSubAccount` | **yes** | **no** |
 *
 * `docs/decisions.md` D6 ratifies four flows, not the three the architecture's prose claimed, and
 * `spec/04-tx-types.md` §7.2 is equally clear that code 9's L2 body has no key for a signature. Both
 * are true: the L1 signature authorises the *creation* out of band. So {@link l1MessageFor} answers
 * for all four, while {@link requiresL1Signature} is defined as "this type declares an `L1Sig`
 * field" and answers for three — because that predicate is what drives serialisation, and adding an
 * `L1Sig` key to a code-9 body would corrupt every sub-account creation.
 *
 * ## What {@link requiresL1Signature} does *not* mean
 *
 * It is a property of the transaction **type**, never of the particular transaction. Whether a given
 * transfer or integrator approval actually requires a fresh L1 authorisation depends on account
 * ownership, which this SDK does not know and cannot discover locally. Nothing here tries to infer
 * it; a caller who has that knowledge applies it above this layer.
 *
 * ## The transaction type
 *
 * The SDK-wide `UnsignedTx` union is assembled by the integration unit from the account and order
 * families, and does not exist yet as an importable name. This module therefore states the minimum
 * it needs — {@link UnsignedTxLike}, an object with a numeric `type` — which every member of that
 * union satisfies structurally. The per-type field reads are narrowed by the `switch` on the
 * discriminant and then asserted, because a value typed only as "has a `type`" carries no fields for
 * the compiler to narrow to.
 */

import { LighterValidationError } from "../../errors.js";
import { TxType } from "../enums.js";
import type {
  ApproveIntegratorTx,
  ChangePubKeyTx,
  CreateSubAccountTx,
  L1SigHex,
  TransferTx,
} from "../types/account.js";
import type { EthPersonalSigner } from "./signer.js";
import {
  approveIntegratorMessage,
  changePubKeyMessage,
  createSubAccountMessage,
  transferMessage,
} from "./templates.js";

/**
 * The structural minimum this module needs from a transaction: a numeric type discriminant.
 *
 * Every member of the SDK's transaction union satisfies it, so `l1MessageFor(tx, chainId)` accepts
 * an `UnsignedTx` without this module depending on a barrel it does not own.
 */
export interface UnsignedTxLike {
  /** The transaction type code — {@link TxType}. */
  readonly type: number;
}

/**
 * The three type codes that carry an `L1Sig` key on the wire.
 *
 * Code 9 is deliberately absent: it needs a signature and has no field for it. See the module note.
 */
export const L1_SIG_TX_TYPES: ReadonlySet<number> = new Set<number>([
  TxType.L2ChangePubKey,
  TxType.L2Transfer,
  TxType.L2ApproveIntegrator,
]);

/** The four type codes that have an L1 message — {@link L1_SIG_TX_TYPES} plus code 9. */
export const L1_MESSAGE_TX_TYPES: ReadonlySet<number> = new Set<number>([
  TxType.L2ChangePubKey,
  TxType.L2Transfer,
  TxType.L2ApproveIntegrator,
  TxType.L2CreateSubAccount,
]);

/**
 * The exact EIP-191 message body for a transaction, or `null` if its type needs no L1 signature.
 *
 * Returns a string for codes **8, 12, 45 and 9**. `chainId` is an argument rather than a
 * transaction field because it is not one — it is configuration, and only `transfer` and
 * `approve_integrator` render it at all.
 *
 * The result is the message to hand to {@link EthPersonalSigner.signMessage} verbatim. Every byte
 * of it is pinned by `conformance/vectors/tx.json` → `l1Messages`.
 */
export function l1MessageFor(tx: UnsignedTxLike, chainId: number): string | null {
  switch (tx.type) {
    case TxType.L2ChangePubKey: {
      const t: ChangePubKeyTx = tx as unknown as ChangePubKeyTx;
      return changePubKeyMessage({
        pubKey: t.pubKey,
        nonce: t.nonce,
        accountIndex: t.accountIndex,
        apiKeyIndex: t.apiKeyIndex,
      });
    }
    case TxType.L2Transfer: {
      const t: TransferTx = tx as unknown as TransferTx;
      return transferMessage({
        nonce: t.nonce,
        fromAccountIndex: t.fromAccountIndex,
        fromRouteType: t.fromRouteType,
        apiKeyIndex: t.apiKeyIndex,
        toAccountIndex: t.toAccountIndex,
        toRouteType: t.toRouteType,
        assetIndex: t.assetIndex,
        amount: t.amount,
        usdcFee: t.usdcFee,
        chainId,
        memo: t.memo,
      });
    }
    case TxType.L2ApproveIntegrator: {
      const t: ApproveIntegratorTx = tx as unknown as ApproveIntegratorTx;
      return approveIntegratorMessage({
        nonce: t.nonce,
        accountIndex: t.accountIndex,
        apiKeyIndex: t.apiKeyIndex,
        integratorAccountIndex: t.integratorAccountIndex,
        maxPerpsTakerFee: t.maxPerpsTakerFee,
        maxPerpsMakerFee: t.maxPerpsMakerFee,
        maxSpotTakerFee: t.maxSpotTakerFee,
        maxSpotMakerFee: t.maxSpotMakerFee,
        // Not `expiredAt`. The approval has its own deadline and the message renders that one.
        approvalExpiry: t.approvalExpiry,
        chainId,
      });
    }
    case TxType.L2CreateSubAccount: {
      const t: CreateSubAccountTx = tx as unknown as CreateSubAccountTx;
      // The master account index *is* the transaction's `AccountIndex`.
      return createSubAccountMessage({ masterAccountIndex: t.accountIndex });
    }
    default:
      return null;
  }
}

/**
 * True iff this transaction **type** declares an `L1Sig` field on the wire — codes 8, 12 and 45.
 *
 * That is the definition, and it is narrower than "this flow needs an Ethereum signature": code 9
 * needs one and returns `false` here, because it has nowhere to carry it. Use
 * {@link l1MessageFor} — not this — to decide whether a signature must be *obtained*.
 *
 * It is a statement about the type, never about the particular transaction: whether a specific
 * transfer needs a fresh L1 authorisation depends on account ownership, which is not knowable here.
 */
export function requiresL1Signature(tx: UnsignedTxLike): boolean {
  return L1_SIG_TX_TYPES.has(tx.type);
}

/** `0x` followed by 130 hex digits — a 65-byte `r ‖ s ‖ v` signature. */
const L1_SIG_PATTERN: RegExp = /^0x[0-9a-fA-F]{130}$/;

/**
 * Build this transaction's L1 message, have the injected signer sign it, and return a copy carrying
 * the signature.
 *
 * The input is not mutated — the result is a fresh object — and no cryptography runs in this
 * package: the message is text, the signature arrives from outside, and the only check applied to it
 * is a shape check. The returned hex is lowercased, since case is not meaningful in hex and the
 * serialiser rejects uppercase.
 *
 * For code 9 the signature is still attached to the returned object; the schema-driven serialiser
 * simply does not emit it, which is correct, and the caller passes it to the creation endpoint out
 * of band.
 *
 * @throws {LighterValidationError} `L1_SIGNATURE_NOT_APPLICABLE` if the transaction type has no L1
 * message at all, or `SIGNATURE_INVALID` if the signer returns something that is not `0x` + 130 hex
 * digits.
 */
export async function attachL1Signature<T extends UnsignedTxLike>(
  tx: T,
  signer: EthPersonalSigner,
  chainId: number,
): Promise<T & { l1Sig: L1SigHex }> {
  const message: string | null = l1MessageFor(tx, chainId);
  if (message === null) {
    throw new LighterValidationError(
      "L1_SIGNATURE_NOT_APPLICABLE",
      `transaction type ${tx.type} has no L1 message; only types 8, 9, 12 and 45 do`,
      { txType: tx.type },
    );
  }
  const signature: string = await signer.signMessage(message);
  if (!L1_SIG_PATTERN.test(signature)) {
    throw new LighterValidationError(
      "SIGNATURE_INVALID",
      "the injected signer must return an 0x-prefixed 65-byte hex signature (132 characters)",
      { txType: tx.type, field: "L1Sig" },
    );
  }
  return { ...tx, l1Sig: signature.toLowerCase() as L1SigHex };
}
