/**
 * `src/tx/l1/attach.ts` — which transaction types need an L1 signature, and what happens to one.
 *
 * The asymmetry between the two predicates is the point of this file. Four types have a message
 * (8, 12, 45, 9); only three declare an `L1Sig` wire field (8, 12, 45). A change that "fixes" the
 * inconsistency in either direction breaks something: adding 9 to `requiresL1Signature` puts a key
 * on the wire that the sequencer does not accept, and dropping 9 from `l1MessageFor` silently stops
 * producing a signature the flow needs (`docs/decisions.md` D6, `spec/04-tx-types.md` §7.2).
 */

import { describe, expect, test } from "bun:test";

import { LighterValidationError } from "../../../src/errors.js";
import { i16, i64, u8, u32 } from "../../../src/tx/brands.js";
import { TxType } from "../../../src/tx/enums.js";
import type { EthPersonalSigner, UnsignedTxLike } from "../../../src/tx/l1/index.js";
import {
  L1_MESSAGE_TX_TYPES,
  L1_SIG_TX_TYPES,
  attachL1Signature,
  l1MessageFor,
  requiresL1Signature,
} from "../../../src/tx/l1/index.js";
import type {
  ApproveIntegratorTx,
  ChangePubKeyTx,
  CreateSubAccountTx,
  TransferTx,
  WithdrawTx,
} from "../../../src/tx/types/account.js";

const CHAIN_ID: number = 304;

const changePubKey: ChangePubKeyTx = {
  type: TxType.L2ChangePubKey,
  nonce: i64(20n),
  expiredAt: i64(1893456000000n),
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  pubKey: new Uint8Array(40).fill(0x11),
};

const transfer: TransferTx = {
  type: TxType.L2Transfer,
  nonce: i64(14n),
  expiredAt: i64(1893456000000n),
  fromAccountIndex: i64(1n),
  apiKeyIndex: u8(0),
  toAccountIndex: i64(2n),
  assetIndex: i16(3),
  fromRouteType: u8(0),
  toRouteType: u8(1),
  amount: i64(4886718345n),
  usdcFee: i64(2882400001n),
  memo: new Uint8Array(32),
};

const approveIntegrator: ApproveIntegratorTx = {
  type: TxType.L2ApproveIntegrator,
  nonce: i64(28n),
  expiredAt: i64(1893456000000n),
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
  integratorAccountIndex: i64(4242n),
  maxPerpsTakerFee: u32(1000),
  maxPerpsMakerFee: u32(500),
  maxSpotTakerFee: u32(800),
  maxSpotMakerFee: u32(400),
  approvalExpiry: i64(1893456000000n),
};

const createSubAccount: CreateSubAccountTx = {
  type: TxType.L2CreateSubAccount,
  nonce: i64(21n),
  expiredAt: i64(1893456000000n),
  accountIndex: i64(1n),
  apiKeyIndex: u8(0),
};

const withdraw: WithdrawTx = {
  type: TxType.L2Withdraw,
  nonce: i64(1n),
  expiredAt: i64(1893456000000n),
  fromAccountIndex: i64(1n),
  apiKeyIndex: u8(0),
  assetIndex: i16(3),
  routeType: u8(0),
  amount: BigInt(1000) as WithdrawTx["amount"],
};

/** A 65-byte signature that no cryptography produced. That is the point: none runs here. */
const FAKE_SIG: `0x${string}` = `0x${"ab".repeat(32)}${"cd".repeat(32)}1b`;

function fakeSigner(): EthPersonalSigner & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    signMessage: async (message: string): Promise<`0x${string}`> => {
      seen.push(message);
      return FAKE_SIG;
    },
  };
}

describe("requiresL1Signature", () => {
  test("true for the three types that declare an L1Sig field", () => {
    expect(requiresL1Signature(changePubKey)).toBe(true);
    expect(requiresL1Signature(transfer)).toBe(true);
    expect(requiresL1Signature(approveIntegrator)).toBe(true);
  });

  test("false for create_sub_account, which needs a signature but cannot carry one", () => {
    expect(requiresL1Signature(createSubAccount)).toBe(false);
    expect(l1MessageFor(createSubAccount, CHAIN_ID)).not.toBeNull();
  });

  test("false for every other type code", () => {
    for (let code: number = 0; code <= 46; code += 1) {
      if (code === 8 || code === 12 || code === 45) continue;
      expect(requiresL1Signature({ type: code })).toBe(false);
    }
    expect(requiresL1Signature(withdraw)).toBe(false);
  });

  test("the exported sets say the same thing", () => {
    expect([...L1_SIG_TX_TYPES].sort((a: number, b: number): number => a - b)).toEqual([8, 12, 45]);
    expect([...L1_MESSAGE_TX_TYPES].sort((a: number, b: number): number => a - b)).toEqual([
      8, 9, 12, 45,
    ]);
  });
});

describe("l1MessageFor", () => {
  test("returns a message for 8, 12, 45 and 9", () => {
    for (const tx of [changePubKey, transfer, approveIntegrator, createSubAccount]) {
      const message: string | null = l1MessageFor(tx, CHAIN_ID);
      expect(typeof message).toBe("string");
      expect(message).toContain("Only sign this message for a trusted client!");
    }
  });

  test("returns null for every other type code", () => {
    expect(l1MessageFor(withdraw, CHAIN_ID)).toBeNull();
    for (let code: number = 0; code <= 46; code += 1) {
      if (code === 8 || code === 9 || code === 12 || code === 45) continue;
      expect(l1MessageFor({ type: code }, CHAIN_ID)).toBeNull();
    }
  });

  test("the chain id reaches transfer and approve_integrator, and nothing else", () => {
    expect(l1MessageFor(transfer, 300)).toContain("chainId: 0x000000000000012c\n");
    expect(l1MessageFor(approveIntegrator, 300)).toContain("chainId: 0x000000000000012c\n");
    expect(l1MessageFor(changePubKey, 300)).toBe(l1MessageFor(changePubKey, 466324));
    expect(l1MessageFor(createSubAccount, 300)).toBe(l1MessageFor(createSubAccount, 466324));
  });

  test("create_sub_account renders the transaction's own account index as the master index", () => {
    expect(l1MessageFor(createSubAccount, CHAIN_ID)).toBe(
      "Create Lighter Sub Account\n\nmaster account index: 0x0000000000000001\n" +
        "Only sign this message for a trusted client!",
    );
    const maxMaster: CreateSubAccountTx = { ...createSubAccount, accountIndex: i64(140737488355327n) };
    expect(l1MessageFor(maxMaster, CHAIN_ID)).toContain("master account index: 0x00007fffffffffff\n");
  });

  test("approve_integrator ignores expiredAt in favour of approvalExpiry", () => {
    const shifted: ApproveIntegratorTx = { ...approveIntegrator, expiredAt: i64(1n) };
    expect(l1MessageFor(shifted, CHAIN_ID)).toBe(l1MessageFor(approveIntegrator, CHAIN_ID));
    expect(l1MessageFor(shifted, CHAIN_ID)).toContain("approval expiry: 0x000001b8dac5b400\n");
  });

  test("a plain object with only a type is enough to be told 'no'", () => {
    const minimal: UnsignedTxLike = { type: TxType.L2CreateOrder };
    expect(l1MessageFor(minimal, CHAIN_ID)).toBeNull();
  });
});

describe("attachL1Signature", () => {
  test("awaits the injected signer and attaches its output", async () => {
    const signer = fakeSigner();
    const signed = await attachL1Signature(transfer, signer, CHAIN_ID);
    expect(signer.seen).toEqual([l1MessageFor(transfer, CHAIN_ID) as string]);
    expect(signed.l1Sig).toBe(FAKE_SIG);
    expect(signed.amount).toBe(transfer.amount);
    expect(signed.type).toBe(TxType.L2Transfer);
  });

  test("does not mutate the input transaction", async () => {
    const signer = fakeSigner();
    const before: string = JSON.stringify(changePubKey, (_k: string, v: unknown): unknown =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const signed = await attachL1Signature(changePubKey, signer, CHAIN_ID);
    expect(signed).not.toBe(changePubKey);
    expect("l1Sig" in changePubKey).toBe(false);
    expect(
      JSON.stringify(changePubKey, (_k: string, v: unknown): unknown =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ).toBe(before);
    expect(signed.pubKey).toBe(changePubKey.pubKey);
  });

  test("attaches to create_sub_account too, even though nothing serialises it", async () => {
    const signer = fakeSigner();
    const signed = await attachL1Signature(createSubAccount, signer, CHAIN_ID);
    expect(signed.l1Sig).toBe(FAKE_SIG);
    expect(requiresL1Signature(signed)).toBe(false);
  });

  test("lowercases the signature, since hex case is not meaningful", async () => {
    const upper: EthPersonalSigner = {
      signMessage: async (): Promise<`0x${string}`> => `0x${"AB".repeat(65)}`,
    };
    const signed = await attachL1Signature(approveIntegrator, upper, CHAIN_ID);
    expect(signed.l1Sig).toBe(`0x${"ab".repeat(65)}`);
  });

  test("rejects a transaction type that has no L1 message", async () => {
    const signer = fakeSigner();
    await expect(attachL1Signature(withdraw, signer, CHAIN_ID)).rejects.toThrow(
      LighterValidationError,
    );
    expect(signer.seen).toEqual([]);
  });

  test("rejects a signature that is not 65 bytes of hex", async () => {
    const short: EthPersonalSigner = {
      signMessage: async (): Promise<`0x${string}`> => "0xdeadbeef",
    };
    await expect(attachL1Signature(transfer, short, CHAIN_ID)).rejects.toThrow(
      LighterValidationError,
    );
  });

  test("the signer is the only thing that ever sees a key — a stub with no crypto suffices", async () => {
    let called: number = 0;
    const stub: EthPersonalSigner = {
      signMessage: async (message: string): Promise<`0x${string}`> => {
        called += 1;
        expect(message.startsWith("Register Lighter Account\n\n")).toBe(true);
        return FAKE_SIG;
      },
      getAddress: async (): Promise<`0x${string}`> => "0x0000000000000000000000000000000000000001",
    };
    const signed = await attachL1Signature(changePubKey, stub, CHAIN_ID);
    expect(called).toBe(1);
    expect(signed.l1Sig).toBe(FAKE_SIG);
  });
});
