/**
 * L1 (EIP-191) message construction for the four Lighter flows that bind an L2 action to an
 * Ethereum address: `change_pub_key`, `transfer`, `approve_integrator` and `create_sub_account`
 * (`docs/decisions.md` D6).
 *
 * This directory builds the exact message and defines the seam a signature is injected through. It
 * holds no L1 key, no curve arithmetic and no digest — D6 and D10 cut all of it from v1 — so the
 * whole module is strings, bytes and one `await`.
 *
 * ```ts
 * const message = l1MessageFor(tx, CHAIN_ID.mainnet);      // exact, vector-pinned text
 * const signed = await attachL1Signature(tx, l1Signer, CHAIN_ID.mainnet);
 * ```
 *
 * A barrel over this directory only. The package-level `src/tx/index.ts` belongs to the integration
 * unit and is not touched from here.
 */

export {
  L1_MESSAGE_TX_TYPES,
  L1_SIG_TX_TYPES,
  type UnsignedTxLike,
  attachL1Signature,
  l1MessageFor,
  requiresL1Signature,
} from "./attach.js";
export { EIP191_PREFIX, eip191Message } from "./eip191.js";
export { hex16 } from "./hex16.js";
export type { EthPersonalSigner } from "./signer.js";
export {
  type AirdropAllocationMessageArgs,
  type ApproveIntegratorMessageArgs,
  type ChangePubKeyMessageArgs,
  type CreateSubAccountMessageArgs,
  type L1TemplateName,
  L1_TEMPLATES,
  type TransferMessageArgs,
  airdropAllocationMessage,
  approveIntegratorMessage,
  changePubKeyMessage,
  createSubAccountMessage,
  transferMessage,
} from "./templates.js";
