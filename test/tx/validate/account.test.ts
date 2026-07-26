/**
 * Tests for `src/tx/validate/account.ts` — the fifteen non-order transaction validators.
 *
 * Three layers, in increasing order of how much they would cost to get wrong:
 *
 * 1. **Rules.** Every condition in `spec/04-tx-types.md` §7.1–§7.6 and §7.13–§7.19 has a case that
 *    trips it and asserts the exact §12 code. Codes, not messages: a caller branches on the code.
 * 2. **Order.** One case per type violates two rules at once and asserts which one wins. The order
 *    is normative and is invisible to any single-violation test.
 * 3. **Vectors.** Every account-family row of `conformance/vectors/tx.json` is rebuilt from its
 *    `fields` map and validated. The oracle calls `Validate()` on each row before emitting it, so a
 *    row that fails here means this validator is stricter than the sequencer — which would reject
 *    transactions the chain accepts.
 *
 * Vector field values are decimal **strings** and are parsed with `BigInt`, never `Number`:
 * `PublicPoolIndex` and `ApprovalExpiry` in these rows already exceed `2^47`.
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import { i16, i64, u8, u16, u32, u64 } from "../../../src/tx/brands.js";
import type { I16, I64, U8, U16, U32, U64 } from "../../../src/tx/brands.js";
import { TxType } from "../../../src/tx/enums.js";
import type {
  ApproveIntegratorTx,
  BurnSharesTx,
  ChangePubKeyTx,
  CreatePublicPoolTx,
  CreateSubAccountTx,
  MintSharesTx,
  StakeAssetsTx,
  TransferTx,
  UnstakeAssetsTx,
  UpdateAccountAssetConfigTx,
  UpdateAccountConfigTx,
  UpdateLeverageTx,
  UpdateMarginTx,
  UpdatePublicPoolTx,
  WithdrawTx,
} from "../../../src/tx/types/account.js";
import {
  validateApproveIntegrator,
  validateBurnShares,
  validateChangePubKey,
  validateCreatePublicPool,
  validateCreateSubAccount,
  validateMintShares,
  validateStakeAssets,
  validateTransfer,
  validateUnstakeAssets,
  validateUpdateAccountAssetConfig,
  validateUpdateAccountConfig,
  validateUpdateLeverage,
  validateUpdateMargin,
  validateUpdatePublicPool,
  validateWithdraw,
} from "../../../src/tx/validate/account.js";
import { hexToBytes } from "../../../src/util/bytes.js";

/** Minimal ambient for the vector loader. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

/* -------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/** The validation code a call throws, or `"<no throw>"`. Rethrows anything that is not ours. */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e.code;
    throw e;
  }
  return "<no throw>";
}

/** The whole error, for the few cases that assert `field` and `txType` as well as `code`. */
function errorOf(fn: () => void): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but the call returned normally");
}

/* -------------------------------------------------------------------------------------------------
 * Bounds, spelled out rather than imported, so a wrong constant cannot agree with itself
 * ---------------------------------------------------------------------------------------------- */

const MAX_ACCOUNT: bigint = 281474976710654n; // 2^48 - 2
const MAX_MASTER: bigint = 140737488355327n; // 2^47 - 1
const MIN_SUB: bigint = 140737488355328n; // 2^47
const MAX_TS: bigint = 281474976710655n; // 2^48 - 1
const MAX_U60: bigint = 1152921504606846975n; // 2^60 - 1

const NONCE: I64 = i64(1n);
const EXPIRED: I64 = i64(1893456000000n);
const POOL: I64 = i64(140737488355428n);

/* -------------------------------------------------------------------------------------------------
 * Valid baselines. Every negative case is one field away from one of these.
 * ---------------------------------------------------------------------------------------------- */

const CHANGE_PUB_KEY: ChangePubKeyTx = {
  type: TxType.L2ChangePubKey,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  pubKey: new Uint8Array(40),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const CREATE_SUB_ACCOUNT: CreateSubAccountTx = {
  type: TxType.L2CreateSubAccount,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const CREATE_PUBLIC_POOL: CreatePublicPoolTx = {
  type: TxType.L2CreatePublicPool,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  operatorFee: i64(100n),
  initialTotalShares: i64(1_000_000n),
  minOperatorShareRate: u16(1000),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const UPDATE_PUBLIC_POOL: UpdatePublicPoolTx = {
  type: TxType.L2UpdatePublicPool,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  publicPoolIndex: POOL,
  status: u8(1),
  operatorFee: i64(200n),
  minOperatorShareRate: u16(2000),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const TRANSFER: TransferTx = {
  type: TxType.L2Transfer,
  fromAccountIndex: i64(1n),
  apiKeyIndex: u8(0),
  toAccountIndex: i64(2n),
  assetIndex: i16(3),
  fromRouteType: u8(0),
  toRouteType: u8(1),
  amount: i64(4886718345n),
  usdcFee: i64(0n),
  memo: new Uint8Array(32),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const WITHDRAW: WithdrawTx = {
  type: TxType.L2Withdraw,
  fromAccountIndex: i64(1n),
  apiKeyIndex: u8(0),
  assetIndex: i16(3),
  routeType: u8(0),
  amount: u64(549755813887n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const MINT_SHARES: MintSharesTx = {
  type: TxType.L2MintShares,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  publicPoolIndex: POOL,
  shareAmount: i64(5000n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const BURN_SHARES: BurnSharesTx = {
  type: TxType.L2BurnShares,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  publicPoolIndex: POOL,
  shareAmount: i64(2500n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const UPDATE_LEVERAGE: UpdateLeverageTx = {
  type: TxType.L2UpdateLeverage,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  marketIndex: i16(1),
  initialMarginFraction: u16(500),
  marginMode: u8(0),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const UPDATE_MARGIN: UpdateMarginTx = {
  type: TxType.L2UpdateMargin,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  marketIndex: i16(1),
  usdcAmount: i64(4886718345n),
  direction: u8(1),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const STAKE: StakeAssetsTx = {
  type: TxType.L2StakeAssets,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  stakingPoolIndex: i64(140737488355335n),
  shareAmount: i64(1_000_000n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const UNSTAKE: UnstakeAssetsTx = {
  type: TxType.L2UnstakeAssets,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  stakingPoolIndex: i64(140737488355335n),
  shareAmount: i64(500_000n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const ACCOUNT_CONFIG: UpdateAccountConfigTx = {
  type: TxType.L2UpdateAccountConfig,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  accountTradingMode: u8(1),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const ASSET_CONFIG: UpdateAccountAssetConfigTx = {
  type: TxType.L2UpdateAccountAssetConfig,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  assetIndex: i16(1),
  assetMarginMode: u8(1),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

const APPROVE_INTEGRATOR: ApproveIntegratorTx = {
  type: TxType.L2ApproveIntegrator,
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  integratorAccountIndex: i64(4242n),
  maxPerpsTakerFee: u32(1000),
  maxPerpsMakerFee: u32(500),
  maxSpotTakerFee: u32(800),
  maxSpotMakerFee: u32(400),
  approvalExpiry: i64(1893456000000n),
  nonce: NONCE,
  expiredAt: EXPIRED,
};

/* -------------------------------------------------------------------------------------------------
 * Baselines are valid, under both option sets
 * ---------------------------------------------------------------------------------------------- */

describe("baselines", () => {
  const cases: readonly (readonly [string, () => void])[] = [
    ["changePubKey", () => validateChangePubKey(CHANGE_PUB_KEY)],
    ["createSubAccount", () => validateCreateSubAccount(CREATE_SUB_ACCOUNT)],
    ["createPublicPool", () => validateCreatePublicPool(CREATE_PUBLIC_POOL)],
    ["updatePublicPool", () => validateUpdatePublicPool(UPDATE_PUBLIC_POOL)],
    ["transfer", () => validateTransfer(TRANSFER)],
    ["withdraw", () => validateWithdraw(WITHDRAW)],
    ["mintShares", () => validateMintShares(MINT_SHARES)],
    ["burnShares", () => validateBurnShares(BURN_SHARES)],
    ["updateLeverage", () => validateUpdateLeverage(UPDATE_LEVERAGE)],
    ["updateMargin", () => validateUpdateMargin(UPDATE_MARGIN)],
    ["stakeAssets", () => validateStakeAssets(STAKE)],
    ["unstakeAssets", () => validateUnstakeAssets(UNSTAKE)],
    ["updateAccountConfig", () => validateUpdateAccountConfig(ACCOUNT_CONFIG)],
    ["updateAccountAssetConfig", () => validateUpdateAccountAssetConfig(ASSET_CONFIG)],
    ["approveIntegrator", () => validateApproveIntegrator(APPROVE_INTEGRATOR)],
  ];

  for (const [name, run] of cases) {
    test(`${name} accepts a well-formed transaction`, () => {
      expect(run).not.toThrow();
    });
  }

  test("account index -1 is legal, not an absence marker", () => {
    expect(() => validateTransfer({ ...TRANSFER, fromAccountIndex: i64(-1n) })).not.toThrow();
    expect(() => validateTransfer({ ...TRANSFER, toAccountIndex: i64(-1n) })).not.toThrow();
    expect(() =>
      validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, accountIndex: i64(-1n) }),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * 8 — L2ChangePubKey
 * ---------------------------------------------------------------------------------------------- */

describe("validateChangePubKey (8)", () => {
  test("account index below -1 reports the From-flavoured code despite the field name", () => {
    const err = errorOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, accountIndex: i64(-2n) }));
    expect(err.code).toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
    expect(err.field).toBe("AccountIndex");
    expect(err.txType).toBe(8);
  });

  test("account index ceiling is the full range, not the master range", () => {
    expect(() =>
      validateChangePubKey({ ...CHANGE_PUB_KEY, accountIndex: i64(MAX_ACCOUNT) }),
    ).not.toThrow();
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, accountIndex: i64(MAX_ACCOUNT + 1n) }))).toBe(
      "FROM_ACCOUNT_INDEX_TOO_HIGH",
    );
  });

  test("api key bounds", () => {
    expect(() => validateChangePubKey({ ...CHANGE_PUB_KEY, apiKeyIndex: u8(254) })).not.toThrow();
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, apiKeyIndex: u8(255) }))).toBe(
      "API_KEY_INDEX_TOO_HIGH",
    );
  });

  test("pubkey must be exactly 40 bytes", () => {
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, pubKey: new Uint8Array(39) }))).toBe(
      "PUBKEY_INVALID",
    );
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, pubKey: new Uint8Array(41) }))).toBe(
      "PUBKEY_INVALID",
    );
  });

  test("limbs above the modulus are accepted — no canonical-range check (§1.4)", () => {
    // All-0xff is five limbs each far above p; reduction happens at absorption time.
    expect(() =>
      validateChangePubKey({ ...CHANGE_PUB_KEY, pubKey: new Uint8Array(40).fill(0xff) }),
    ).not.toThrow();
  });

  test("nonce and expiredAt tail", () => {
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, nonce: i64(-1n) }))).toBe(
      "NONCE_TOO_LOW",
    );
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, expiredAt: i64(-1n) }))).toBe(
      "EXPIRED_AT_INVALID",
    );
    expect(codeOf(() => validateChangePubKey({ ...CHANGE_PUB_KEY, expiredAt: i64(MAX_TS + 1n) }))).toBe(
      "EXPIRED_AT_INVALID",
    );
    expect(() => validateChangePubKey({ ...CHANGE_PUB_KEY, expiredAt: i64(MAX_TS) })).not.toThrow();
  });

  test("order: account index beats pubkey length", () => {
    expect(
      codeOf(() =>
        validateChangePubKey({ ...CHANGE_PUB_KEY, accountIndex: i64(-2n), pubKey: new Uint8Array(1) }),
      ),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
  });

  test("order: pubkey length beats the nonce tail", () => {
    expect(
      codeOf(() =>
        validateChangePubKey({ ...CHANGE_PUB_KEY, pubKey: new Uint8Array(1), nonce: i64(-5n) }),
      ),
    ).toBe("PUBKEY_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 9 — L2CreateSubAccount
 * ---------------------------------------------------------------------------------------------- */

describe("validateCreateSubAccount (9)", () => {
  test("the ceiling is the master range, and 2^47 is one past it", () => {
    expect(() =>
      validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, accountIndex: i64(MAX_MASTER) }),
    ).not.toThrow();
    expect(
      codeOf(() => validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, accountIndex: i64(MIN_SUB) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_HIGH");
  });

  test("the same value passes updatePublicPool's account check — the ceilings differ", () => {
    expect(() =>
      validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, accountIndex: i64(MIN_SUB) }),
    ).not.toThrow();
  });

  test("floor and api key", () => {
    expect(
      codeOf(() => validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, accountIndex: i64(-2n) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
    expect(codeOf(() => validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, apiKeyIndex: u8(255) }))).toBe(
      "API_KEY_INDEX_TOO_HIGH",
    );
  });

  test("order: account index beats api key index", () => {
    expect(
      codeOf(() =>
        validateCreateSubAccount({
          ...CREATE_SUB_ACCOUNT,
          accountIndex: i64(MIN_SUB),
          apiKeyIndex: u8(255),
        }),
      ),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_HIGH");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 10 — L2CreatePublicPool
 * ---------------------------------------------------------------------------------------------- */

describe("validateCreatePublicPool (10)", () => {
  test("account ceiling is the master range", () => {
    expect(
      codeOf(() => validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, accountIndex: i64(MIN_SUB) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_HIGH");
  });

  test("operator fee range, one error identity for both ends", () => {
    expect(() =>
      validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, operatorFee: i64(0n) }),
    ).not.toThrow();
    expect(() =>
      validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, operatorFee: i64(1_000_000n) }),
    ).not.toThrow();
    expect(
      codeOf(() => validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, operatorFee: i64(-1n) })),
    ).toBe("POOL_OPERATOR_FEE_INVALID");
    expect(
      codeOf(() => validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, operatorFee: i64(1_000_001n) })),
    ).toBe("POOL_OPERATOR_FEE_INVALID");
  });

  test("strict enforces MinInitialTotalShares; strict:false uses the reference's <= 0", () => {
    const low: CreatePublicPoolTx = { ...CREATE_PUBLIC_POOL, initialTotalShares: i64(999_999n) };
    expect(codeOf(() => validateCreatePublicPool(low))).toBe("POOL_INITIAL_SHARES_TOO_LOW");
    expect(() => validateCreatePublicPool(low, { strict: false })).not.toThrow();

    const zero: CreatePublicPoolTx = { ...CREATE_PUBLIC_POOL, initialTotalShares: i64(0n) };
    expect(codeOf(() => validateCreatePublicPool(zero))).toBe("POOL_INITIAL_SHARES_TOO_LOW");
    expect(codeOf(() => validateCreatePublicPool(zero, { strict: false }))).toBe(
      "POOL_INITIAL_SHARES_TOO_LOW",
    );
  });

  test("exactly MinInitialTotalShares passes both ways", () => {
    expect(() => validateCreatePublicPool(CREATE_PUBLIC_POOL)).not.toThrow();
    expect(() => validateCreatePublicPool(CREATE_PUBLIC_POOL, { strict: false })).not.toThrow();
  });

  test("initial shares ceiling", () => {
    expect(() =>
      validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, initialTotalShares: i64(1_000_000_000_000n) }),
    ).not.toThrow();
    expect(
      codeOf(() =>
        validateCreatePublicPool({
          ...CREATE_PUBLIC_POOL,
          initialTotalShares: i64(1_000_000_000_001n),
        }),
      ),
    ).toBe("POOL_INITIAL_SHARES_TOO_HIGH");
  });

  test("min operator share rate ceiling only", () => {
    expect(() =>
      validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, minOperatorShareRate: u16(0) }),
    ).not.toThrow();
    expect(() =>
      validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, minOperatorShareRate: u16(10_000) }),
    ).not.toThrow();
    expect(
      codeOf(() =>
        validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, minOperatorShareRate: u16(10_001) }),
      ),
    ).toBe("POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH");
  });

  test("order: operator fee beats initial shares", () => {
    expect(
      codeOf(() =>
        validateCreatePublicPool({
          ...CREATE_PUBLIC_POOL,
          operatorFee: i64(-1n),
          initialTotalShares: i64(0n),
        }),
      ),
    ).toBe("POOL_OPERATOR_FEE_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 11 — L2UpdatePublicPool
 * ---------------------------------------------------------------------------------------------- */

describe("validateUpdatePublicPool (11)", () => {
  test("pool index floor is -1 here, unlike 18/19/35/36", () => {
    expect(() =>
      validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(-1n) }),
    ).not.toThrow();
    expect(() =>
      validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(0n) }),
    ).not.toThrow();
    expect(
      codeOf(() => validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(-2n) })),
    ).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
    expect(
      codeOf(() =>
        validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(MAX_ACCOUNT + 1n) }),
      ),
    ).toBe("PUBLIC_POOL_INDEX_TOO_HIGH");
  });

  test("status must be 0 or 1", () => {
    expect(() => validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, status: u8(0) })).not.toThrow();
    expect(codeOf(() => validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, status: u8(2) }))).toBe(
      "POOL_STATUS_INVALID",
    );
  });

  test("fee and share rate", () => {
    expect(
      codeOf(() => validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, operatorFee: i64(1_000_001n) })),
    ).toBe("POOL_OPERATOR_FEE_INVALID");
    expect(
      codeOf(() =>
        validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, minOperatorShareRate: u16(10_001) }),
      ),
    ).toBe("POOL_MIN_OPERATOR_SHARE_RATE_TOO_HIGH");
  });

  test("order: pool index beats status", () => {
    expect(
      codeOf(() =>
        validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(-2n), status: u8(9) }),
      ),
    ).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 12 — L2Transfer
 * ---------------------------------------------------------------------------------------------- */

describe("validateTransfer (12)", () => {
  test("from and to account indices report different identities", () => {
    expect(codeOf(() => validateTransfer({ ...TRANSFER, fromAccountIndex: i64(-2n) }))).toBe(
      "FROM_ACCOUNT_INDEX_TOO_LOW",
    );
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, fromAccountIndex: i64(MAX_ACCOUNT + 1n) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_HIGH");
    expect(codeOf(() => validateTransfer({ ...TRANSFER, toAccountIndex: i64(-2n) }))).toBe(
      "TO_ACCOUNT_INDEX_TOO_LOW",
    );
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, toAccountIndex: i64(MAX_ACCOUNT + 1n) })),
    ).toBe("TO_ACCOUNT_INDEX_TOO_HIGH");
  });

  test("asset index is [1, 62]; 0 (NilAssetIndex) is rejected", () => {
    expect(codeOf(() => validateTransfer({ ...TRANSFER, assetIndex: i16(0) }))).toBe(
      "ASSET_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, assetIndex: i16(-1) }))).toBe(
      "ASSET_INDEX_TOO_LOW",
    );
    expect(() => validateTransfer({ ...TRANSFER, assetIndex: i16(62) })).not.toThrow();
    expect(codeOf(() => validateTransfer({ ...TRANSFER, assetIndex: i16(63) }))).toBe(
      "ASSET_INDEX_TOO_HIGH",
    );
  });

  test("both route types share one error identity", () => {
    expect(codeOf(() => validateTransfer({ ...TRANSFER, fromRouteType: u8(2) }))).toBe(
      "ROUTE_TYPE_INVALID",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, toRouteType: u8(2) }))).toBe(
      "ROUTE_TYPE_INVALID",
    );
    expect(errorOf(() => validateTransfer({ ...TRANSFER, toRouteType: u8(2) })).field).toBe(
      "ToRouteType",
    );
  });

  test("amount and fee bounds are asymmetric: zero amount fails, zero fee passes", () => {
    expect(codeOf(() => validateTransfer({ ...TRANSFER, amount: i64(0n) }))).toBe(
      "TRANSFER_AMOUNT_TOO_LOW",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, amount: i64(-1n) }))).toBe(
      "TRANSFER_AMOUNT_TOO_LOW",
    );
    expect(() =>
      validateTransfer({ ...TRANSFER, amount: i64(1n), usdcFee: i64(0n) }),
    ).not.toThrow();
    expect(codeOf(() => validateTransfer({ ...TRANSFER, amount: i64(MAX_U60 + 1n) }))).toBe(
      "TRANSFER_AMOUNT_TOO_HIGH",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, usdcFee: i64(-1n) }))).toBe(
      "TRANSFER_FEE_NEGATIVE",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, usdcFee: i64(MAX_U60 + 1n) }))).toBe(
      "TRANSFER_FEE_TOO_HIGH",
    );
    expect(() => validateTransfer({ ...TRANSFER, amount: i64(MAX_U60), usdcFee: i64(MAX_U60) })).not.toThrow();
  });

  test("memo is exactly 32 bytes, under every option set", () => {
    expect(codeOf(() => validateTransfer({ ...TRANSFER, memo: new Uint8Array(31) }))).toBe(
      "MEMO_LENGTH_INVALID",
    );
    expect(codeOf(() => validateTransfer({ ...TRANSFER, memo: new Uint8Array(33) }))).toBe(
      "MEMO_LENGTH_INVALID",
    );
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, memo: new Uint8Array(0) }, { strict: false })),
    ).toBe("MEMO_LENGTH_INVALID");
  });

  test("order: asset index beats route type", () => {
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, assetIndex: i16(0), fromRouteType: u8(7) })),
    ).toBe("ASSET_INDEX_TOO_LOW");
  });

  test("order: amount beats fee, and fee beats memo", () => {
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, amount: i64(0n), usdcFee: i64(-1n) })),
    ).toBe("TRANSFER_AMOUNT_TOO_LOW");
    expect(
      codeOf(() => validateTransfer({ ...TRANSFER, usdcFee: i64(-1n), memo: new Uint8Array(2) })),
    ).toBe("TRANSFER_FEE_NEGATIVE");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 13 — L2Withdraw
 * ---------------------------------------------------------------------------------------------- */

describe("validateWithdraw (13)", () => {
  test("amount is uint64, so the low check is === 0", () => {
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, amount: u64(0n) }))).toBe(
      "WITHDRAWAL_AMOUNT_TOO_LOW",
    );
    expect(() => validateWithdraw({ ...WITHDRAW, amount: u64(1n) })).not.toThrow();
    expect(() => validateWithdraw({ ...WITHDRAW, amount: u64(MAX_U60) })).not.toThrow();
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, amount: u64(MAX_U60 + 1n) }))).toBe(
      "WITHDRAWAL_AMOUNT_TOO_HIGH",
    );
  });

  test("asset index and route type", () => {
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, assetIndex: i16(0) }))).toBe(
      "ASSET_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, assetIndex: i16(63) }))).toBe(
      "ASSET_INDEX_TOO_HIGH",
    );
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, routeType: u8(2) }))).toBe(
      "ROUTE_TYPE_INVALID",
    );
  });

  test("account and api key", () => {
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, fromAccountIndex: i64(-2n) }))).toBe(
      "FROM_ACCOUNT_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateWithdraw({ ...WITHDRAW, apiKeyIndex: u8(255) }))).toBe(
      "API_KEY_INDEX_TOO_HIGH",
    );
  });

  test("order: route type beats amount", () => {
    expect(
      codeOf(() => validateWithdraw({ ...WITHDRAW, routeType: u8(9), amount: u64(0n) })),
    ).toBe("ROUTE_TYPE_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 18 / 19 — shares
 * ---------------------------------------------------------------------------------------------- */

describe("validateMintShares (18) / validateBurnShares (19)", () => {
  test("pool index floor is 2^47 — the value one below it is rejected", () => {
    const justBelow: I64 = i64(MIN_SUB - 1n); // 2^47 - 1
    expect(codeOf(() => validateMintShares({ ...MINT_SHARES, publicPoolIndex: justBelow }))).toBe(
      "PUBLIC_POOL_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateBurnShares({ ...BURN_SHARES, publicPoolIndex: justBelow }))).toBe(
      "PUBLIC_POOL_INDEX_TOO_LOW",
    );
    expect(() =>
      validateMintShares({ ...MINT_SHARES, publicPoolIndex: i64(MIN_SUB) }),
    ).not.toThrow();
  });

  test("that same index is legal for updatePublicPool — the two floors really do differ", () => {
    expect(() =>
      validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, publicPoolIndex: i64(MIN_SUB - 1n) }),
    ).not.toThrow();
  });

  test("the TOO_LOW message still names -1, verbatim from the reference", () => {
    const err = errorOf(() =>
      validateMintShares({ ...MINT_SHARES, publicPoolIndex: i64(MIN_SUB - 1n) }),
    );
    expect(err.message).toBe("PublicPoolIndex should not be less than -1");
    expect(err.field).toBe("PublicPoolIndex");
    expect(err.txType).toBe(18);
  });

  test("pool index ceiling", () => {
    expect(
      codeOf(() => validateMintShares({ ...MINT_SHARES, publicPoolIndex: i64(MAX_ACCOUNT + 1n) })),
    ).toBe("PUBLIC_POOL_INDEX_TOO_HIGH");
    expect(
      codeOf(() => validateBurnShares({ ...BURN_SHARES, publicPoolIndex: i64(MAX_ACCOUNT + 1n) })),
    ).toBe("PUBLIC_POOL_INDEX_TOO_HIGH");
  });

  test("mint and burn differ only in the amount error identities", () => {
    expect(codeOf(() => validateMintShares({ ...MINT_SHARES, shareAmount: i64(0n) }))).toBe(
      "POOL_MINT_AMOUNT_TOO_LOW",
    );
    expect(codeOf(() => validateMintShares({ ...MINT_SHARES, shareAmount: i64(MAX_U60 + 1n) }))).toBe(
      "POOL_MINT_AMOUNT_TOO_HIGH",
    );
    expect(codeOf(() => validateBurnShares({ ...BURN_SHARES, shareAmount: i64(0n) }))).toBe(
      "POOL_BURN_AMOUNT_TOO_LOW",
    );
    expect(codeOf(() => validateBurnShares({ ...BURN_SHARES, shareAmount: i64(MAX_U60 + 1n) }))).toBe(
      "POOL_BURN_AMOUNT_TOO_HIGH",
    );
  });

  test("account index uses the full range and the From-flavoured codes", () => {
    expect(() =>
      validateMintShares({ ...MINT_SHARES, accountIndex: i64(MAX_ACCOUNT) }),
    ).not.toThrow();
    expect(
      codeOf(() => validateMintShares({ ...MINT_SHARES, accountIndex: i64(MAX_ACCOUNT + 1n) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_HIGH");
  });

  test("order: pool index beats share amount", () => {
    expect(
      codeOf(() =>
        validateMintShares({
          ...MINT_SHARES,
          publicPoolIndex: i64(0n),
          shareAmount: i64(0n),
        }),
      ),
    ).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
    expect(
      codeOf(() =>
        validateBurnShares({ ...BURN_SHARES, publicPoolIndex: i64(0n), shareAmount: i64(0n) }),
      ),
    ).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 20 — L2UpdateLeverage
 * ---------------------------------------------------------------------------------------------- */

describe("validateUpdateLeverage (20)", () => {
  test("255 is rejected under both option sets", () => {
    expect(codeOf(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(255) }))).toBe(
      "MARKET_INDEX_INVALID",
    );
    expect(
      codeOf(() =>
        validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(255) }, { strict: false }),
      ),
    ).toBe("MARKET_INDEX_INVALID");
  });

  test("strict enforces the perps range; strict:false restores reference laxity", () => {
    for (const bad of [-1, 256, 2048] as const) {
      expect(
        codeOf(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(bad) })),
      ).toBe("MARKET_INDEX_INVALID");
      expect(() =>
        validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(bad) }, { strict: false }),
      ).not.toThrow();
    }
    expect(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(254) })).not.toThrow();
    expect(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(0) })).not.toThrow();
  });

  test("margin mode must be 0 or 1", () => {
    expect(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marginMode: u8(1) })).not.toThrow();
    expect(codeOf(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, marginMode: u8(2) }))).toBe(
      "MARGIN_MODE_INVALID",
    );
  });

  test("initial margin fraction range", () => {
    expect(
      codeOf(() => validateUpdateLeverage({ ...UPDATE_LEVERAGE, initialMarginFraction: u16(0) })),
    ).toBe("IMF_TOO_LOW");
    expect(() =>
      validateUpdateLeverage({ ...UPDATE_LEVERAGE, initialMarginFraction: u16(1) }),
    ).not.toThrow();
    expect(() =>
      validateUpdateLeverage({ ...UPDATE_LEVERAGE, initialMarginFraction: u16(10_000) }),
    ).not.toThrow();
    expect(
      codeOf(() =>
        validateUpdateLeverage({ ...UPDATE_LEVERAGE, initialMarginFraction: u16(10_001) }),
      ),
    ).toBe("IMF_TOO_HIGH");
  });

  test("order: market index beats margin mode, margin mode beats IMF (§7.16)", () => {
    expect(
      codeOf(() =>
        validateUpdateLeverage({ ...UPDATE_LEVERAGE, marketIndex: i16(255), marginMode: u8(9) }),
      ),
    ).toBe("MARKET_INDEX_INVALID");
    expect(
      codeOf(() =>
        validateUpdateLeverage({
          ...UPDATE_LEVERAGE,
          marginMode: u8(9),
          initialMarginFraction: u16(0),
        }),
      ),
    ).toBe("MARGIN_MODE_INVALID");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 29 — L2UpdateMargin
 * ---------------------------------------------------------------------------------------------- */

describe("validateUpdateMargin (29)", () => {
  test("perps only — the reference does bound this market index", () => {
    for (const bad of [-1, 255, 2048] as const) {
      expect(codeOf(() => validateUpdateMargin({ ...UPDATE_MARGIN, marketIndex: i16(bad) }))).toBe(
        "MARKET_INDEX_INVALID",
      );
      // Not a strict-mode tightening: it fails with strict off too.
      expect(
        codeOf(() =>
          validateUpdateMargin({ ...UPDATE_MARGIN, marketIndex: i16(bad) }, { strict: false }),
        ),
      ).toBe("MARKET_INDEX_INVALID");
    }
    expect(() => validateUpdateMargin({ ...UPDATE_MARGIN, marketIndex: i16(254) })).not.toThrow();
  });

  test("zero amount is rejected under both option sets", () => {
    expect(codeOf(() => validateUpdateMargin({ ...UPDATE_MARGIN, usdcAmount: i64(0n) }))).toBe(
      "TRANSFER_AMOUNT_TOO_LOW",
    );
    expect(
      codeOf(() =>
        validateUpdateMargin({ ...UPDATE_MARGIN, usdcAmount: i64(0n) }, { strict: false }),
      ),
    ).toBe("TRANSFER_AMOUNT_TOO_LOW");
  });

  test("negatives: NEGATIVE_MARGIN_AMOUNT strict, accepted with strict:false", () => {
    for (const v of [-1n, -4294967296n, -12345678901n]) {
      const tx: UpdateMarginTx = { ...UPDATE_MARGIN, usdcAmount: i64(v), direction: u8(0) };
      expect(codeOf(() => validateUpdateMargin(tx))).toBe("NEGATIVE_MARGIN_AMOUNT");
      expect(() => validateUpdateMargin(tx, { strict: false })).not.toThrow();
    }
  });

  test("amount ceiling", () => {
    expect(() => validateUpdateMargin({ ...UPDATE_MARGIN, usdcAmount: i64(MAX_U60) })).not.toThrow();
    expect(
      codeOf(() => validateUpdateMargin({ ...UPDATE_MARGIN, usdcAmount: i64(MAX_U60 + 1n) })),
    ).toBe("TRANSFER_AMOUNT_TOO_HIGH");
  });

  test("direction must be 0 (remove) or 1 (add)", () => {
    expect(() => validateUpdateMargin({ ...UPDATE_MARGIN, direction: u8(0) })).not.toThrow();
    expect(codeOf(() => validateUpdateMargin({ ...UPDATE_MARGIN, direction: u8(2) }))).toBe(
      "UPDATE_MARGIN_DIRECTION_INVALID",
    );
  });

  test("order: market index beats amount; amount beats direction", () => {
    expect(
      codeOf(() =>
        validateUpdateMargin({ ...UPDATE_MARGIN, marketIndex: i16(255), usdcAmount: i64(0n) }),
      ),
    ).toBe("MARKET_INDEX_INVALID");
    expect(
      codeOf(() => validateUpdateMargin({ ...UPDATE_MARGIN, usdcAmount: i64(0n), direction: u8(9) })),
    ).toBe("TRANSFER_AMOUNT_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 35 / 36 — staking
 * ---------------------------------------------------------------------------------------------- */

describe("validateStakeAssets (35) / validateUnstakeAssets (36)", () => {
  test("same predicate, different reported identity — the reference copy-paste", () => {
    const low: I64 = i64(MIN_SUB - 1n);
    const high: I64 = i64(MAX_ACCOUNT + 1n);

    expect(codeOf(() => validateStakeAssets({ ...STAKE, stakingPoolIndex: low }))).toBe(
      "STAKING_POOL_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateStakeAssets({ ...STAKE, stakingPoolIndex: high }))).toBe(
      "STAKING_POOL_INDEX_TOO_HIGH",
    );

    expect(codeOf(() => validateUnstakeAssets({ ...UNSTAKE, stakingPoolIndex: low }))).toBe(
      "PUBLIC_POOL_INDEX_TOO_LOW",
    );
    expect(codeOf(() => validateUnstakeAssets({ ...UNSTAKE, stakingPoolIndex: high }))).toBe(
      "PUBLIC_POOL_INDEX_TOO_HIGH",
    );
  });

  test("unstake's mis-named error still points at the field that was actually checked", () => {
    const err = errorOf(() =>
      validateUnstakeAssets({ ...UNSTAKE, stakingPoolIndex: i64(MIN_SUB - 1n) }),
    );
    expect(err.field).toBe("StakingPoolIndex");
    expect(err.txType).toBe(36);
    expect(err.message).toBe("PublicPoolIndex should not be less than -1");
  });

  test("2^47 exactly is legal for both", () => {
    expect(() => validateStakeAssets({ ...STAKE, stakingPoolIndex: i64(MIN_SUB) })).not.toThrow();
    expect(() => validateUnstakeAssets({ ...UNSTAKE, stakingPoolIndex: i64(MIN_SUB) })).not.toThrow();
  });

  test("amount identities differ between stake and unstake", () => {
    expect(codeOf(() => validateStakeAssets({ ...STAKE, shareAmount: i64(0n) }))).toBe(
      "STAKE_AMOUNT_TOO_LOW",
    );
    expect(codeOf(() => validateStakeAssets({ ...STAKE, shareAmount: i64(MAX_U60 + 1n) }))).toBe(
      "STAKE_AMOUNT_TOO_HIGH",
    );
    expect(codeOf(() => validateUnstakeAssets({ ...UNSTAKE, shareAmount: i64(0n) }))).toBe(
      "UNSTAKE_AMOUNT_TOO_LOW",
    );
    expect(codeOf(() => validateUnstakeAssets({ ...UNSTAKE, shareAmount: i64(MAX_U60 + 1n) }))).toBe(
      "UNSTAKE_AMOUNT_TOO_HIGH",
    );
  });

  test("order: account index beats pool index; pool index beats amount", () => {
    expect(
      codeOf(() =>
        validateStakeAssets({ ...STAKE, accountIndex: i64(-2n), stakingPoolIndex: i64(0n) }),
      ),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
    expect(
      codeOf(() =>
        validateUnstakeAssets({ ...UNSTAKE, stakingPoolIndex: i64(0n), shareAmount: i64(0n) }),
      ),
    ).toBe("PUBLIC_POOL_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 41 / 42
 * ---------------------------------------------------------------------------------------------- */

describe("validateUpdateAccountConfig (41)", () => {
  test("trading mode must be 0 or 1", () => {
    expect(() =>
      validateUpdateAccountConfig({ ...ACCOUNT_CONFIG, accountTradingMode: u8(0) }),
    ).not.toThrow();
    expect(
      codeOf(() => validateUpdateAccountConfig({ ...ACCOUNT_CONFIG, accountTradingMode: u8(2) })),
    ).toBe("ACCOUNT_TRADING_MODE_INVALID");
  });

  test("account and api key bounds", () => {
    expect(
      codeOf(() => validateUpdateAccountConfig({ ...ACCOUNT_CONFIG, accountIndex: i64(-2n) })),
    ).toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
    expect(codeOf(() => validateUpdateAccountConfig({ ...ACCOUNT_CONFIG, apiKeyIndex: u8(255) }))).toBe(
      "API_KEY_INDEX_TOO_HIGH",
    );
  });

  test("order: api key beats trading mode", () => {
    expect(
      codeOf(() =>
        validateUpdateAccountConfig({
          ...ACCOUNT_CONFIG,
          apiKeyIndex: u8(255),
          accountTradingMode: u8(7),
        }),
      ),
    ).toBe("API_KEY_INDEX_TOO_HIGH");
  });
});

describe("validateUpdateAccountAssetConfig (42)", () => {
  test("AssetMarginMode = 2 reports MARGIN_MODE_INVALID, not ASSET_MARGIN_MODE_INVALID", () => {
    const err = errorOf(() =>
      validateUpdateAccountAssetConfig({ ...ASSET_CONFIG, assetMarginMode: u8(2) }),
    );
    expect(err.code).toBe("MARGIN_MODE_INVALID");
    expect(err.field).toBe("AssetMarginMode");
    expect(err.txType).toBe(42);
  });

  test("asset index bounds", () => {
    expect(
      codeOf(() => validateUpdateAccountAssetConfig({ ...ASSET_CONFIG, assetIndex: i16(0) })),
    ).toBe("ASSET_INDEX_TOO_LOW");
    expect(
      codeOf(() => validateUpdateAccountAssetConfig({ ...ASSET_CONFIG, assetIndex: i16(63) })),
    ).toBe("ASSET_INDEX_TOO_HIGH");
    expect(() =>
      validateUpdateAccountAssetConfig({ ...ASSET_CONFIG, assetIndex: i16(62) }),
    ).not.toThrow();
  });

  test("order: asset index beats margin mode", () => {
    expect(
      codeOf(() =>
        validateUpdateAccountAssetConfig({
          ...ASSET_CONFIG,
          assetIndex: i16(0),
          assetMarginMode: u8(5),
        }),
      ),
    ).toBe("ASSET_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * 45 — L2ApproveIntegrator
 * ---------------------------------------------------------------------------------------------- */

describe("validateApproveIntegrator (45)", () => {
  test("account bounds use the plain identities, unlike every other type here", () => {
    expect(
      codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, accountIndex: i64(-2n) })),
    ).toBe("ACCOUNT_INDEX_TOO_LOW");
    expect(
      codeOf(() =>
        validateApproveIntegrator({ ...APPROVE_INTEGRATOR, accountIndex: i64(MAX_ACCOUNT + 1n) }),
      ),
    ).toBe("ACCOUNT_INDEX_TOO_HIGH");
  });

  test("integrator index bounds", () => {
    expect(() =>
      validateApproveIntegrator({ ...APPROVE_INTEGRATOR, integratorAccountIndex: i64(-1n) }),
    ).not.toThrow();
    expect(
      codeOf(() =>
        validateApproveIntegrator({ ...APPROVE_INTEGRATOR, integratorAccountIndex: i64(-2n) }),
      ),
    ).toBe("INTEGRATOR_ACCOUNT_INDEX_TOO_LOW");
    expect(
      codeOf(() =>
        validateApproveIntegrator({
          ...APPROVE_INTEGRATOR,
          integratorAccountIndex: i64(MAX_ACCOUNT + 1n),
        }),
      ),
    ).toBe("INTEGRATOR_ACCOUNT_INDEX_TOO_HIGH");
  });

  test("each of the four fee caps is checked", () => {
    const over: U32 = u32(1_000_001);
    expect(codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, maxPerpsTakerFee: over }))).toBe(
      "FEE_TOO_HIGH",
    );
    expect(codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, maxPerpsMakerFee: over }))).toBe(
      "FEE_TOO_HIGH",
    );
    expect(codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, maxSpotTakerFee: over }))).toBe(
      "FEE_TOO_HIGH",
    );
    expect(codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, maxSpotMakerFee: over }))).toBe(
      "FEE_TOO_HIGH",
    );
    expect(() =>
      validateApproveIntegrator({ ...APPROVE_INTEGRATOR, maxSpotMakerFee: u32(1_000_000) }),
    ).not.toThrow();
  });

  test("a clean revocation — expiry 0 and all fees 0 — is legal", () => {
    expect(() =>
      validateApproveIntegrator({
        ...APPROVE_INTEGRATOR,
        approvalExpiry: i64(0n),
        maxPerpsTakerFee: u32(0),
        maxPerpsMakerFee: u32(0),
        maxSpotTakerFee: u32(0),
        maxSpotMakerFee: u32(0),
      }),
    ).not.toThrow();
  });

  test("a revocation carrying a non-zero fee reports APPROVAL_EXPIRY_ZERO_ON_REVOCATION", () => {
    expect(
      codeOf(() =>
        validateApproveIntegrator({
          ...APPROVE_INTEGRATOR,
          approvalExpiry: i64(0n),
          maxPerpsTakerFee: u32(1),
          maxPerpsMakerFee: u32(0),
          maxSpotTakerFee: u32(0),
          maxSpotMakerFee: u32(0),
        }),
      ),
    ).toBe("APPROVAL_EXPIRY_ZERO_ON_REVOCATION");
  });

  test("expiry range", () => {
    expect(() =>
      validateApproveIntegrator({ ...APPROVE_INTEGRATOR, approvalExpiry: i64(MAX_TS) }),
    ).not.toThrow();
    expect(
      codeOf(() =>
        validateApproveIntegrator({ ...APPROVE_INTEGRATOR, approvalExpiry: i64(MAX_TS + 1n) }),
      ),
    ).toBe("APPROVAL_EXPIRY_INVALID");
    expect(
      codeOf(() => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, approvalExpiry: i64(-1n) })),
    ).toBe("APPROVAL_EXPIRY_INVALID");
  });

  test("order: fee ceiling beats the revocation rule", () => {
    // A revocation with an over-cap fee violates both; the fee check runs first.
    expect(
      codeOf(() =>
        validateApproveIntegrator({
          ...APPROVE_INTEGRATOR,
          approvalExpiry: i64(0n),
          maxPerpsTakerFee: u32(1_000_001),
        }),
      ),
    ).toBe("FEE_TOO_HIGH");
  });

  test("order: integrator index bounds beat the fee ceiling", () => {
    // The revocation-vs-range ordering (§7.19, last two rows) is not directly observable: expiry 0
    // is inside [0, 2^48-1], so a revocation never trips the range check whichever runs first. The
    // implementation still follows the spec order; what *is* observable is this pair.
    expect(
      codeOf(() =>
        validateApproveIntegrator({
          ...APPROVE_INTEGRATOR,
          integratorAccountIndex: i64(-2n),
          maxPerpsTakerFee: u32(1_000_001),
        }),
      ),
    ).toBe("INTEGRATOR_ACCOUNT_INDEX_TOO_LOW");
  });
});

/* -------------------------------------------------------------------------------------------------
 * The universal tail, on every type
 * ---------------------------------------------------------------------------------------------- */

describe("universal tail", () => {
  const withTail: readonly (readonly [string, (nonce: I64, expiredAt: I64) => void])[] = [
    ["changePubKey", (n, e) => validateChangePubKey({ ...CHANGE_PUB_KEY, nonce: n, expiredAt: e })],
    [
      "createSubAccount",
      (n, e) => validateCreateSubAccount({ ...CREATE_SUB_ACCOUNT, nonce: n, expiredAt: e }),
    ],
    [
      "createPublicPool",
      (n, e) => validateCreatePublicPool({ ...CREATE_PUBLIC_POOL, nonce: n, expiredAt: e }),
    ],
    [
      "updatePublicPool",
      (n, e) => validateUpdatePublicPool({ ...UPDATE_PUBLIC_POOL, nonce: n, expiredAt: e }),
    ],
    ["transfer", (n, e) => validateTransfer({ ...TRANSFER, nonce: n, expiredAt: e })],
    ["withdraw", (n, e) => validateWithdraw({ ...WITHDRAW, nonce: n, expiredAt: e })],
    ["mintShares", (n, e) => validateMintShares({ ...MINT_SHARES, nonce: n, expiredAt: e })],
    ["burnShares", (n, e) => validateBurnShares({ ...BURN_SHARES, nonce: n, expiredAt: e })],
    [
      "updateLeverage",
      (n, e) => validateUpdateLeverage({ ...UPDATE_LEVERAGE, nonce: n, expiredAt: e }),
    ],
    ["updateMargin", (n, e) => validateUpdateMargin({ ...UPDATE_MARGIN, nonce: n, expiredAt: e })],
    ["stakeAssets", (n, e) => validateStakeAssets({ ...STAKE, nonce: n, expiredAt: e })],
    ["unstakeAssets", (n, e) => validateUnstakeAssets({ ...UNSTAKE, nonce: n, expiredAt: e })],
    [
      "updateAccountConfig",
      (n, e) => validateUpdateAccountConfig({ ...ACCOUNT_CONFIG, nonce: n, expiredAt: e }),
    ],
    [
      "updateAccountAssetConfig",
      (n, e) => validateUpdateAccountAssetConfig({ ...ASSET_CONFIG, nonce: n, expiredAt: e }),
    ],
    [
      "approveIntegrator",
      (n, e) => validateApproveIntegrator({ ...APPROVE_INTEGRATOR, nonce: n, expiredAt: e }),
    ],
  ];

  for (const [name, run] of withTail) {
    test(`${name}: negative nonce, then expiredAt out of [0, 2^48-1]`, () => {
      expect(codeOf(() => run(i64(-1n), EXPIRED))).toBe("NONCE_TOO_LOW");
      expect(codeOf(() => run(NONCE, i64(-1n)))).toBe("EXPIRED_AT_INVALID");
      expect(codeOf(() => run(NONCE, i64(MAX_TS + 1n)))).toBe("EXPIRED_AT_INVALID");
      // Nonce is checked before expiredAt.
      expect(codeOf(() => run(i64(-1n), i64(-1n)))).toBe("NONCE_TOO_LOW");
      expect(() => run(i64(0n), i64(0n))).not.toThrow();
    });
  }

  test("MAX_TIMESTAMP (2^48-1) and MAX_ACCOUNT_INDEX (2^48-2) are not the same bound", () => {
    expect(MAX_TS).toBe(MAX_ACCOUNT + 1n);
    expect(() => validateTransfer({ ...TRANSFER, expiredAt: i64(MAX_TS) })).not.toThrow();
    expect(codeOf(() => validateTransfer({ ...TRANSFER, fromAccountIndex: i64(MAX_TS) }))).toBe(
      "FROM_ACCOUNT_INDEX_TOO_HIGH",
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * Attribute validation runs first
 * ---------------------------------------------------------------------------------------------- */

describe("attribute validation runs first", () => {
  test("a bad attribute beats every field rule", () => {
    // Attribute type 1 (integrator account index) with an out-of-range value.
    const attrs = { 1: -1 } as const;
    expect(
      codeOf(() =>
        validateTransfer({ ...TRANSFER, attributes: attrs, fromAccountIndex: i64(-99n) }),
      ),
    ).not.toBe("FROM_ACCOUNT_INDEX_TOO_LOW");
    expect(() => validateTransfer({ ...TRANSFER, attributes: attrs })).toThrow(
      LighterValidationError,
    );
  });

  test("an empty attribute map is fine", () => {
    expect(() => validateTransfer({ ...TRANSFER, attributes: {} })).not.toThrow();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Conformance vectors
 * ---------------------------------------------------------------------------------------------- */

interface VectorRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
}
interface TxVectors {
  readonly txHashes: readonly VectorRow[];
}

const vectorPath: string = new URL(
  "../../../conformance/vectors/tx.json",
  import.meta.url,
).pathname;
const vectors: TxVectors = JSON.parse(await Bun.file(vectorPath).text()) as TxVectors;

const ACCOUNT_FAMILY: ReadonlySet<number> = new Set<number>([
  8, 9, 10, 11, 12, 13, 18, 19, 20, 29, 35, 36, 41, 42, 45,
]);

const rows: readonly VectorRow[] = vectors.txHashes.filter((r) => ACCOUNT_FAMILY.has(r.txType));

/** Vector field values are decimal strings; `BigInt` is the only safe parse above 2^53. */
function big(f: Readonly<Record<string, string>>, key: string): bigint {
  const raw: string | undefined = f[key];
  return raw === undefined ? 0n : BigInt(raw);
}
function small(f: Readonly<Record<string, string>>, key: string): number {
  return Number(big(f, key));
}
function bi64(f: Readonly<Record<string, string>>, key: string): I64 {
  return i64(big(f, key));
}
function bu64(f: Readonly<Record<string, string>>, key: string): U64 {
  return u64(big(f, key));
}
function b8(f: Readonly<Record<string, string>>, key: string): U8 {
  return u8(small(f, key));
}
function b16u(f: Readonly<Record<string, string>>, key: string): U16 {
  return u16(small(f, key));
}
function b16i(f: Readonly<Record<string, string>>, key: string): I16 {
  return i16(small(f, key));
}
function b32(f: Readonly<Record<string, string>>, key: string): U32 {
  return u32(small(f, key));
}

/**
 * Rebuild a transaction from a vector row and validate it.
 *
 * `Memo` is absent from the transfer rows because it is not hashed (§7.5); a 32-byte zero memo is
 * substituted, which is what the reference's own zero value is.
 */
function validateRow(row: VectorRow, opts?: { readonly strict: boolean }): void {
  const f: Readonly<Record<string, string>> = row.fields;
  const nonce: I64 = bi64(f, "Nonce");
  const expiredAt: I64 = bi64(f, "ExpiredAt");

  switch (row.txType) {
    case TxType.L2ChangePubKey:
      validateChangePubKey(
        {
          type: TxType.L2ChangePubKey,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          pubKey: hexToBytes(f["PubKeyLeHex"] ?? ""),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2CreateSubAccount:
      validateCreateSubAccount(
        {
          type: TxType.L2CreateSubAccount,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2CreatePublicPool:
      validateCreatePublicPool(
        {
          type: TxType.L2CreatePublicPool,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          operatorFee: bi64(f, "OperatorFee"),
          initialTotalShares: bi64(f, "InitialTotalShares"),
          minOperatorShareRate: b16u(f, "MinOperatorShareRate"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UpdatePublicPool:
      validateUpdatePublicPool(
        {
          type: TxType.L2UpdatePublicPool,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          publicPoolIndex: bi64(f, "PublicPoolIndex"),
          status: b8(f, "Status"),
          operatorFee: bi64(f, "OperatorFee"),
          minOperatorShareRate: b16u(f, "MinOperatorShareRate"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2Transfer:
      validateTransfer(
        {
          type: TxType.L2Transfer,
          fromAccountIndex: bi64(f, "FromAccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          toAccountIndex: bi64(f, "ToAccountIndex"),
          assetIndex: b16i(f, "AssetIndex"),
          fromRouteType: b8(f, "FromRouteType"),
          toRouteType: b8(f, "ToRouteType"),
          amount: bi64(f, "Amount"),
          usdcFee: bi64(f, "USDCFee"),
          memo: new Uint8Array(32),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2Withdraw:
      validateWithdraw(
        {
          type: TxType.L2Withdraw,
          fromAccountIndex: bi64(f, "FromAccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          assetIndex: b16i(f, "AssetIndex"),
          routeType: b8(f, "RouteType"),
          amount: bu64(f, "Amount"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2MintShares:
      validateMintShares(
        {
          type: TxType.L2MintShares,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          publicPoolIndex: bi64(f, "PublicPoolIndex"),
          shareAmount: bi64(f, "ShareAmount"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2BurnShares:
      validateBurnShares(
        {
          type: TxType.L2BurnShares,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          publicPoolIndex: bi64(f, "PublicPoolIndex"),
          shareAmount: bi64(f, "ShareAmount"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UpdateLeverage:
      validateUpdateLeverage(
        {
          type: TxType.L2UpdateLeverage,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          marketIndex: b16i(f, "MarketIndex"),
          initialMarginFraction: b16u(f, "InitialMarginFraction"),
          marginMode: b8(f, "MarginMode"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UpdateMargin:
      validateUpdateMargin(
        {
          type: TxType.L2UpdateMargin,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          marketIndex: b16i(f, "MarketIndex"),
          usdcAmount: bi64(f, "USDCAmount"),
          direction: b8(f, "Direction"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2StakeAssets:
      validateStakeAssets(
        {
          type: TxType.L2StakeAssets,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          stakingPoolIndex: bi64(f, "StakingPoolIndex"),
          shareAmount: bi64(f, "ShareAmount"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UnstakeAssets:
      validateUnstakeAssets(
        {
          type: TxType.L2UnstakeAssets,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          stakingPoolIndex: bi64(f, "StakingPoolIndex"),
          shareAmount: bi64(f, "ShareAmount"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UpdateAccountConfig:
      validateUpdateAccountConfig(
        {
          type: TxType.L2UpdateAccountConfig,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          accountTradingMode: b8(f, "AccountTradingMode"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2UpdateAccountAssetConfig:
      validateUpdateAccountAssetConfig(
        {
          type: TxType.L2UpdateAccountAssetConfig,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          assetIndex: b16i(f, "AssetIndex"),
          assetMarginMode: b8(f, "AssetMarginMode"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    case TxType.L2ApproveIntegrator:
      validateApproveIntegrator(
        {
          type: TxType.L2ApproveIntegrator,
          accountIndex: bi64(f, "AccountIndex"),
          apiKeyIndex: b8(f, "ApiKeyIndex"),
          integratorAccountIndex: bi64(f, "IntegratorAccountIndex"),
          maxPerpsTakerFee: b32(f, "MaxPerpsTakerFee"),
          maxPerpsMakerFee: b32(f, "MaxPerpsMakerFee"),
          maxSpotTakerFee: b32(f, "MaxSpotTakerFee"),
          maxSpotMakerFee: b32(f, "MaxSpotMakerFee"),
          approvalExpiry: bi64(f, "ApprovalExpiry"),
          nonce,
          expiredAt,
        },
        opts,
      );
      return;
    default:
      throw new Error(`unhandled account-family tx type ${String(row.txType)}`);
  }
}

/** The three rows the reference accepts and this SDK rejects by default (§15 row 7). */
const NEGATIVE_MARGIN_ROWS: ReadonlySet<string> = new Set<string>([
  "update_margin/negative_minus_one",
  "update_margin/negative_2_pow_32",
  "update_margin/negative_realistic",
]);

describe("conformance vectors", () => {
  test("the expected account-family rows are all present", () => {
    const names: readonly string[] = rows.map((r) => r.name);
    for (const expected of [
      "change_pub_key",
      "create_sub_account",
      "create_public_pool",
      "update_public_pool",
      "transfer/large_amount_lo_hi_split",
      "transfer/small_amount",
      "withdraw/large_amount_lo_hi_split",
      "mint_shares",
      "burn_shares",
      "update_leverage/cross",
      "update_leverage/isolated",
      "update_margin/add",
      "update_margin/negative_minus_one",
      "update_margin/negative_2_pow_32",
      "update_margin/negative_realistic",
      "stake_assets",
      "unstake_assets",
      "update_account_config",
      "update_account_asset_config",
      "approve_integrator",
    ]) {
      expect(names).toContain(expected);
    }
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });

  for (const row of rows) {
    test(`${row.name} (type ${String(row.txType)}) validates under { strict: false }`, () => {
      expect(() => validateRow(row, { strict: false })).not.toThrow();
    });
  }

  test("under default options, exactly the three negative-margin rows are rejected", () => {
    const rejected: string[] = [];
    for (const row of rows) {
      const code: string = codeOf(() => validateRow(row));
      if (code !== "<no throw>") {
        rejected.push(row.name);
        expect(code).toBe("NEGATIVE_MARGIN_AMOUNT");
      }
    }
    expect(new Set(rejected)).toEqual(new Set(NEGATIVE_MARGIN_ROWS));
  });

  test("the reference's own PublicPoolIndex value is above 2^47, as the sub-account rule requires", () => {
    const mint: VectorRow | undefined = rows.find((r) => r.name === "mint_shares");
    expect(mint).toBeDefined();
    expect(big(mint?.fields ?? {}, "PublicPoolIndex")).toBeGreaterThanOrEqual(MIN_SUB);
  });
});
