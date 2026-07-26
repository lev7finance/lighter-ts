/**
 * The five L1 message templates, as data, plus one pure builder each.
 *
 * Four Lighter flows bind an L2 action to an Ethereum L1 address by asking the address holder to
 * `personal_sign` a plain UTF-8 string: `change_pub_key`, `transfer`, `approve_integrator` and
 * `create_sub_account` (`docs/decisions.md` D6 — **four**, not the three the architecture's prose
 * claimed). The fifth template, `airdropAllocation`, is declared upstream and wired to no
 * transaction; it ships here for completeness.
 *
 * The signature comes from outside this package. What is owned here is the message string, which is
 * the part that is easy to get wrong: a single misplaced digit produces a signature that is
 * internally consistent, verifies against the wrong text, and is rejected with no indication why.
 * Every one of the six vector rows in `conformance/vectors/tx.json` → `l1Messages` is reproduced
 * byte for byte by `test/tx/l1/templates.test.ts`.
 *
 * ## Rules that are not visible from the field lists
 *
 * - Every `%s` is {@link hex16} — `0x` + 16 zero-padded lowercase hex digits — **except** three:
 *   the public key (80 hex digits, no prefix, because the template already writes `0x`), the
 *   transfer memo (64 hex digits, no prefix), and the airdrop allocations (an opaque string).
 * - The header is separated by a blank line (`\n\n`) and there is **no trailing newline** after
 *   `Only sign this message for a trusted client!`.
 * - `change_pub_key` takes no chain id. `create_sub_account` takes neither chain id nor nonce — one
 *   argument, the master account index. `transfer` and `approve_integrator` both put the chain id
 *   last before the trailing line (and `transfer` then appends the memo line after it).
 * - `approve_integrator` renders `ApprovalExpiry`, which is **not** the transaction's `ExpiredAt`;
 *   its fee caps run taker-before-maker and perps-before-spot.
 * - `transfer`'s argument order interleaves the route types and puts the api key between `from` and
 *   `to`. Read the template left to right; any other reading is wrong in a way tests with equal
 *   values cannot see.
 *
 * The templates are the single source of truth: each builder fills its own template's `%s` slots in
 * order, so a template edit cannot leave a builder behind.
 */

import { type LighterValidationCode, LighterValidationError } from "../../errors.js";
import { bytesToHex } from "../../util/bytes.js";
import { MEMO_LENGTH, PUBKEY_LENGTH } from "../constants.js";
import { hex16 } from "./hex16.js";

/** The five declared templates. Only the first four are wired to a transaction type. */
export type L1TemplateName =
  | "changePubKey"
  | "transfer"
  | "approveIntegrator"
  | "createSubAccount"
  | "airdropAllocation";

/**
 * The raw templates, exactly as the protocol defines them (`spec/04-tx-types.md` §10.2). `\n` is
 * LF, `%s` is a positional slot filled left to right by the matching builder.
 *
 * Do not "tidy" these strings. Spacing, capitalisation (`chainId` is camel case in a message that is
 * otherwise lower-case prose) and the absence of a trailing newline are all load-bearing.
 */
export const L1_TEMPLATES = {
  changePubKey:
    "Register Lighter Account\n\npubkey: 0x%s\nnonce: %s\naccount index: %s\napi key index: %s\nOnly sign this message for a trusted client!",
  transfer:
    "Transfer\n\nnonce: %s\nfrom: %s (route %s)\napi key: %s\nto: %s (route %s)\nasset: %s\namount: %s\nfee: %s\nchainId: %s\nmemo: %s\nOnly sign this message for a trusted client!",
  approveIntegrator:
    "Approve Integrator\n\nnonce: %s\naccount index: %s\napi key index: %s\nintegrator account index: %s\nmax perps taker fee: %s\nmax perps maker fee: %s\nmax spot taker fee: %s\nmax spot maker fee: %s\napproval expiry: %s\nchainId: %s\nOnly sign this message for a trusted client!",
  createSubAccount:
    "Create Lighter Sub Account\n\nmaster account index: %s\nOnly sign this message for a trusted client!",
  airdropAllocation:
    "Airdrop Allocation\n\nallocations: %s\nchainId: %s\nOnly sign this message for a trusted client!",
} as const satisfies Readonly<Record<L1TemplateName, string>>;

/**
 * Fill a template's `%s` slots from left to right.
 *
 * The scan runs over the template, never over the output, so an argument that happens to contain
 * `%s` is inserted verbatim rather than re-scanned. A count mismatch throws instead of leaving a
 * literal `%s` in a message someone is about to sign.
 */
function fill(template: string, args: readonly string[]): string {
  let index: number = 0;
  const out: string = template.replace(/%s/g, (): string => {
    const arg: string | undefined = args[index];
    index += 1;
    if (arg === undefined) {
      throw new LighterValidationError(
        "L1_TEMPLATE_ARITY",
        `L1 template expects more arguments than the ${args.length} supplied`,
      );
    }
    return arg;
  });
  if (index !== args.length) {
    throw new LighterValidationError(
      "L1_TEMPLATE_ARITY",
      `L1 template has ${index} slots but ${args.length} arguments were supplied`,
    );
  }
  return out;
}

/** Lowercase hex of a fixed-length byte field, with the length checked first. */
function fixedHex(
  bytes: Uint8Array,
  expected: number,
  field: string,
  code: LighterValidationCode,
): string {
  if (bytes.length !== expected) {
    throw new LighterValidationError(
      code,
      `${field} must be exactly ${expected} bytes, got ${bytes.length}`,
      { field },
    );
  }
  return bytesToHex(bytes);
}

/** Arguments of {@link changePubKeyMessage} (`spec/04-tx-types.md` §10.2, `L2ChangePubKey`). */
export interface ChangePubKeyMessageArgs {
  /** The new public key: exactly 40 bytes, rendered as 80 lowercase hex digits. */
  readonly pubKey: Uint8Array;
  /** `Nonce`. */
  readonly nonce: bigint;
  /** `AccountIndex`. */
  readonly accountIndex: bigint;
  /** `ApiKeyIndex`. */
  readonly apiKeyIndex: number;
}

/**
 * The `change_pub_key` registration message — no chain id, by design.
 *
 * @throws {LighterValidationError} `PUBKEY_INVALID` if `pubKey` is not exactly 40 bytes.
 */
export function changePubKeyMessage(a: ChangePubKeyMessageArgs): string {
  return fill(L1_TEMPLATES.changePubKey, [
    fixedHex(a.pubKey, PUBKEY_LENGTH, "PubKey", "PUBKEY_INVALID"),
    hex16(a.nonce),
    hex16(a.accountIndex),
    hex16(a.apiKeyIndex),
  ]);
}

/** Arguments of {@link transferMessage} (`spec/04-tx-types.md` §10.2, `L2Transfer`). */
export interface TransferMessageArgs {
  /** `Nonce`. */
  readonly nonce: bigint;
  /** `FromAccountIndex`. */
  readonly fromAccountIndex: bigint;
  /** `FromRouteType`: `0` perps, `1` spot. */
  readonly fromRouteType: number;
  /** `ApiKeyIndex` — rendered *between* `from` and `to`, not at the end. */
  readonly apiKeyIndex: number;
  /** `ToAccountIndex`. */
  readonly toAccountIndex: bigint;
  /** `ToRouteType`: `0` perps, `1` spot. */
  readonly toRouteType: number;
  /** `AssetIndex`. Declared `int16`, so negative values render as their `uint64` bit pattern. */
  readonly assetIndex: number;
  /** `Amount`, in the asset's smallest unit. */
  readonly amount: bigint;
  /** `USDCFee`, in USDC micro-units. */
  readonly usdcFee: bigint;
  /** The chain id — an input to the message, never read from the transaction. */
  readonly chainId: number;
  /** `Memo`: exactly 32 bytes, rendered as 64 lowercase hex digits with **no** `0x`. */
  readonly memo: Uint8Array;
}

/**
 * The `transfer` message.
 *
 * @throws {LighterValidationError} `MEMO_LENGTH_INVALID` if `memo` is not exactly 32 bytes.
 */
export function transferMessage(a: TransferMessageArgs): string {
  return fill(L1_TEMPLATES.transfer, [
    hex16(a.nonce),
    hex16(a.fromAccountIndex),
    hex16(a.fromRouteType),
    hex16(a.apiKeyIndex),
    hex16(a.toAccountIndex),
    hex16(a.toRouteType),
    hex16(a.assetIndex),
    hex16(a.amount),
    hex16(a.usdcFee),
    hex16(a.chainId),
    fixedHex(a.memo, MEMO_LENGTH, "Memo", "MEMO_LENGTH_INVALID"),
  ]);
}

/** Arguments of {@link approveIntegratorMessage} (`spec/04-tx-types.md` §10.2). */
export interface ApproveIntegratorMessageArgs {
  /** `Nonce`. */
  readonly nonce: bigint;
  /** `AccountIndex`. */
  readonly accountIndex: bigint;
  /** `ApiKeyIndex`. */
  readonly apiKeyIndex: number;
  /** `IntegratorAccountIndex`. */
  readonly integratorAccountIndex: bigint;
  /** `MaxPerpsTakerFee`, millionths. Taker comes before maker. */
  readonly maxPerpsTakerFee: number;
  /** `MaxPerpsMakerFee`, millionths. */
  readonly maxPerpsMakerFee: number;
  /** `MaxSpotTakerFee`, millionths. Perps come before spot. */
  readonly maxSpotTakerFee: number;
  /** `MaxSpotMakerFee`, millionths. */
  readonly maxSpotMakerFee: number;
  /** `ApprovalExpiry`, Unix ms — **not** the transaction's `ExpiredAt`. */
  readonly approvalExpiry: bigint;
  /** The chain id. */
  readonly chainId: number;
}

/** The `approve_integrator` message. */
export function approveIntegratorMessage(a: ApproveIntegratorMessageArgs): string {
  return fill(L1_TEMPLATES.approveIntegrator, [
    hex16(a.nonce),
    hex16(a.accountIndex),
    hex16(a.apiKeyIndex),
    hex16(a.integratorAccountIndex),
    hex16(a.maxPerpsTakerFee),
    hex16(a.maxPerpsMakerFee),
    hex16(a.maxSpotTakerFee),
    hex16(a.maxSpotMakerFee),
    hex16(a.approvalExpiry),
    hex16(a.chainId),
  ]);
}

/** Arguments of {@link createSubAccountMessage} (`spec/04-tx-types.md` §10.2). */
export interface CreateSubAccountMessageArgs {
  /**
   * The master account creating the sub-account — the transaction's `AccountIndex`, in the master
   * range `[0, 2^47 - 1]`.
   */
  readonly masterAccountIndex: bigint;
}

/**
 * The `create_sub_account` message — one argument, no nonce, no chain id.
 *
 * The L2 transaction (code 9) carries no `L1Sig` field, yet the flow still needs this signature
 * (`docs/decisions.md` D6). The caller passes it out of band.
 */
export function createSubAccountMessage(a: CreateSubAccountMessageArgs): string {
  return fill(L1_TEMPLATES.createSubAccount, [hex16(a.masterAccountIndex)]);
}

/** Arguments of {@link airdropAllocationMessage}. */
export interface AirdropAllocationMessageArgs {
  /** An opaque string, inserted verbatim. **Not** {@link hex16}. */
  readonly allocations: string;
  /** The chain id. */
  readonly chainId: number;
}

/**
 * The `airdrop_allocation` message.
 *
 * Declared by the protocol and wired to no transaction type — it belongs to an off-chain claim
 * flow. Shipped so the template set is complete and so a caller who needs it does not re-derive the
 * format by guesswork.
 */
export function airdropAllocationMessage(a: AirdropAllocationMessageArgs): string {
  return fill(L1_TEMPLATES.airdropAllocation, [a.allocations, hex16(a.chainId)]);
}
