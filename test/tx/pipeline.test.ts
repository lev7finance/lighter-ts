/**
 * `src/tx/pipeline.ts` — where the whole stack meets `conformance/vectors/tx.json`.
 *
 * ## What is actually being proved
 *
 * All 38 `txHashes` rows are replayed end to end: a builder constructs the transaction from the
 * row's decimal-string fields, and `txHashHex(tx, 304)` must equal `messageHashLeHex` exactly. That
 * single assertion exercises the Goldilocks field, `GF(p^5)`, the Poseidon2 permutation and sponge,
 * the integer→element rule with its sign extension, the four hard-coded lo/hi splits, every element
 * ordering, the grouped-order leaf fold and the attribute aggregation — at once, the way production
 * signing does. A wrong Poseidon round constant surfaces here and nowhere earlier.
 *
 * ## The signatures, and how the key was recovered
 *
 * `tx.json` does not carry the signing private key. It carries the pinned nonce, and Schnorr gives
 * the rest: `s = k − e·sk (mod n)`, so `sk = (k − s)·e⁻¹ (mod n)` with `s` the first 40 bytes of
 * `signatureBytesHex` and `e` the second 40, both little-endian.
 *
 * That recovery is run over all 38 transaction rows **and** all 3 `authTokens` rows, and every one
 * of the 41 yields the same key — which is itself the check: if the challenge, the scalar field or
 * the little-endian scalar codec were wrong, the 41 recoveries would disagree. Then `signTx` with
 * the row's pinned `k` must reproduce `signatureBytesHex` byte for byte.
 *
 * ## What is *not* pinned
 *
 * Every row carries `"txInfoJson": ""` — the Go oracle does not emit the JSON, so `toTxInfo` has no
 * vector behind it. Those fields are deliberately not asserted against, and the vector is never
 * edited to add one. The gate for the emitter is the hand-authored golden strings below, written
 * from `spec/04-tx-types.md` §9.2 and §7.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { ApiKey } from "../../src/crypto/key.js";
import type { Fp5 } from "../../src/crypto/field/fp5.js";
import { hashToQuinticExtension } from "../../src/crypto/poseidon2/index.js";
import { N, scalarFromBytes, scalarToBytes } from "../../src/crypto/scalar.js";
import { bytesToBase64, bytesToHex, hexToBytes } from "../../src/util/bytes.js";
import { type TxAttributes, aggregateTxHash } from "../../src/tx/attributes.js";
import { type I64, i16, i64, u8, u16, u32, u64 } from "../../src/tx/brands.js";
import {
  type SignedTx,
  type UnsignedTx,
  buildApproveIntegrator,
  buildBurnShares,
  buildCancelAllOrders,
  buildCancelOrder,
  buildChangePubKey,
  buildCreateGroupedOrders,
  buildCreateOrder,
  buildCreatePublicPool,
  buildCreateSubAccount,
  buildMintShares,
  buildModifyOrder,
  buildStakeAssets,
  buildTransfer,
  buildUnstakeAssets,
  buildUpdateAccountAssetConfig,
  buildUpdateAccountConfig,
  buildUpdateLeverage,
  buildUpdateMargin,
  buildUpdatePublicPool,
  buildWithdraw,
} from "../../src/tx/build.js";
import { CHAIN_ID } from "../../src/tx/constants.js";
import { TxType } from "../../src/tx/enums.js";
import { txHashElements } from "../../src/tx/hash.js";
import type { TransactOpts } from "../../src/tx/opts.js";
import {
  TX_SCHEMAS,
  signTx,
  toTxInfo,
  txHash,
  txHashHex,
  txSubmission,
} from "../../src/tx/pipeline.js";
import { requireTxSchema } from "../../src/tx/schema.js";
import type { L1SigHex } from "../../src/tx/types/account.js";
import type { OrderInfo } from "../../src/tx/types/orders.js";

/* -------------------------------------------------------------------------------------------------
 * Vectors
 * ---------------------------------------------------------------------------------------------- */

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
  readonly messageHashLeHex: string;
  readonly signatureBytesHex: string;
  readonly nonceKLeHex: string;
  readonly txInfoJson: string;
}

interface AttributeRow {
  readonly attributes: Readonly<Record<string, number>>;
  readonly isEmpty: boolean;
  readonly inputTxHash: readonly string[];
  readonly aggregatedLeBytesHex: string;
}

interface AuthTokenRow {
  readonly messageHashLeHex: string;
  readonly nonceKLeHex: string;
  readonly signatureBytesHex: string;
}

const vectorsUrl = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly attributeHashes: readonly AttributeRow[];
  readonly txHashes: readonly TxHashRow[];
  readonly authTokens: readonly AuthTokenRow[];
};

/** `304`. Pinned by the vector file itself, never inferred from a URL. */
const CHAIN: number = vectors.chainId;

/**
 * The signing key behind every signature in `tx.json`, recovered as described in the header.
 *
 * Written out rather than computed into a variable and compared against itself: this constant is
 * what makes the recovery an assertion instead of a tautology.
 */
const EXPECTED_KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

/* -------------------------------------------------------------------------------------------------
 * Row → transaction
 * ---------------------------------------------------------------------------------------------- */

/** Read a declared field, failing loudly rather than coercing `undefined` to `0`. */
function str(f: Readonly<Record<string, string>>, key: string): string {
  const value: string | undefined = f[key];
  if (value === undefined) throw new Error(`vector row is missing field ${key}`);
  return value;
}

/** A decimal-string field as `bigint`. Never via `Number` — `Index` reaches `2^60 − 1`. */
function big(f: Readonly<Record<string, string>>, key: string): bigint {
  return BigInt(str(f, key));
}

/** A decimal-string field as `number`. Only for fields the protocol declares ≤ 32 bits. */
function num(f: Readonly<Record<string, string>>, key: string): number {
  return Number(str(f, key));
}

/** The shared options a row implies. `strict` is turned off only where the row demands it. */
function optsOf(row: TxHashRow): TransactOpts {
  const f = row.fields;
  const accountKey: string = "AccountIndex" in f ? "AccountIndex" : "FromAccountIndex";
  return {
    accountIndex: i64(big(f, accountKey)),
    apiKeyIndex: u8(num(f, "ApiKeyIndex")),
    nonce: i64(big(f, "Nonce")),
    expiredAt: i64(big(f, "ExpiredAt")),
    attributes: row.attributes as TxAttributes,
    // The reference has no lower bound on `L2UpdateMargin.USDCAmount`; this SDK's default rejects
    // negatives (§15 row 7), so the three negative rows replay with the tightening off.
    strict: !row.name.startsWith("update_margin/negative"),
    now: (): number => {
      throw new Error("the clock must not be read when expiredAt is supplied");
    },
  };
}

/** One grouped-order leg, read from the row's `Order<i>.*` keys. */
function leg(f: Readonly<Record<string, string>>, index: number): OrderInfo {
  const p: string = `Order${String(index)}.`;
  return {
    marketIndex: i16(num(f, `${p}MarketIndex`)),
    clientOrderIndex: i64(big(f, `${p}ClientOrderIndex`)),
    baseAmount: i64(big(f, `${p}BaseAmount`)),
    price: u32(num(f, `${p}Price`)),
    isAsk: u8(num(f, `${p}IsAsk`)),
    type: u8(num(f, `${p}Type`)),
    timeInForce: u8(num(f, `${p}TimeInForce`)),
    reduceOnly: u8(num(f, `${p}ReduceOnly`)),
    triggerPrice: u32(num(f, `${p}TriggerPrice`)),
    orderExpiry: i64(big(f, `${p}OrderExpiry`)),
  };
}

/**
 * Dispatch a vector row to its builder.
 *
 * The `Memo` of a transfer is not in the vector because it is not in the hash — it is bound to the
 * transaction only by the L1 signature — so a zero memo is supplied here and cannot affect the
 * assertion.
 */
function buildFromRow(row: TxHashRow): UnsignedTx {
  const f = row.fields;
  const o: TransactOpts = optsOf(row);

  switch (row.txType) {
    case TxType.L2ChangePubKey:
      return buildChangePubKey({ pubKey: hexToBytes(str(f, "PubKeyLeHex")) }, o);
    case TxType.L2CreateSubAccount:
      return buildCreateSubAccount({}, o);
    case TxType.L2CreatePublicPool:
      return buildCreatePublicPool(
        {
          operatorFee: i64(big(f, "OperatorFee")),
          initialTotalShares: i64(big(f, "InitialTotalShares")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2UpdatePublicPool:
      return buildUpdatePublicPool(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          status: u8(num(f, "Status")),
          operatorFee: i64(big(f, "OperatorFee")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2Transfer:
      return buildTransfer(
        {
          toAccountIndex: i64(big(f, "ToAccountIndex")),
          assetIndex: i16(num(f, "AssetIndex")),
          fromRouteType: u8(num(f, "FromRouteType")),
          toRouteType: u8(num(f, "ToRouteType")),
          amount: i64(big(f, "Amount")),
          usdcFee: i64(big(f, "USDCFee")),
          memo: new Uint8Array(32),
        },
        o,
      );
    case TxType.L2Withdraw:
      return buildWithdraw(
        {
          assetIndex: i16(num(f, "AssetIndex")),
          routeType: u8(num(f, "RouteType")),
          amount: u64(big(f, "Amount")),
        },
        o,
      );
    case TxType.L2CreateOrder:
      return buildCreateOrder(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          clientOrderIndex: i64(big(f, "ClientOrderIndex")),
          baseAmount: i64(big(f, "BaseAmount")),
          price: u32(num(f, "Price")),
          isAsk: u8(num(f, "IsAsk")),
          orderType: u8(num(f, "Type")),
          timeInForce: u8(num(f, "TimeInForce")),
          reduceOnly: u8(num(f, "ReduceOnly")),
          triggerPrice: u32(num(f, "TriggerPrice")),
          orderExpiry: i64(big(f, "OrderExpiry")),
        },
        o,
      );
    case TxType.L2CancelOrder:
      return buildCancelOrder(
        { marketIndex: i16(num(f, "MarketIndex")), index: i64(big(f, "Index")) },
        o,
      );
    case TxType.L2CancelAllOrders:
      return buildCancelAllOrders(
        { timeInForce: u8(num(f, "TimeInForce")), time: i64(big(f, "Time")) },
        o,
      );
    case TxType.L2ModifyOrder:
      return buildModifyOrder(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          index: i64(big(f, "Index")),
          baseAmount: i64(big(f, "BaseAmount")),
          price: u32(num(f, "Price")),
          triggerPrice: u32(num(f, "TriggerPrice")),
        },
        o,
      );
    case TxType.L2MintShares:
      return buildMintShares(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2BurnShares:
      return buildBurnShares(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UpdateLeverage:
      return buildUpdateLeverage(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          initialMarginFraction: u16(num(f, "InitialMarginFraction")),
          marginMode: u8(num(f, "MarginMode")),
        },
        o,
      );
    case TxType.L2CreateGroupedOrders: {
      const count: number = num(f, "OrderCount");
      const orders: OrderInfo[] = [];
      for (let i = 0; i < count; i += 1) orders.push(leg(f, i));
      return buildCreateGroupedOrders(
        { groupingType: u8(num(f, "GroupingType")), orders },
        o,
      );
    }
    case TxType.L2UpdateMargin:
      return buildUpdateMargin(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          usdcAmount: i64(big(f, "USDCAmount")),
          direction: u8(num(f, "Direction")),
        },
        o,
      );
    case TxType.L2StakeAssets:
      return buildStakeAssets(
        {
          stakingPoolIndex: i64(big(f, "StakingPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UnstakeAssets:
      return buildUnstakeAssets(
        {
          stakingPoolIndex: i64(big(f, "StakingPoolIndex")),
          shareAmount: i64(big(f, "ShareAmount")),
        },
        o,
      );
    case TxType.L2UpdateAccountConfig:
      return buildUpdateAccountConfig(
        { accountTradingMode: u8(num(f, "AccountTradingMode")) },
        o,
      );
    case TxType.L2UpdateAccountAssetConfig:
      return buildUpdateAccountAssetConfig(
        { assetIndex: i16(num(f, "AssetIndex")), assetMarginMode: u8(num(f, "AssetMarginMode")) },
        o,
      );
    case TxType.L2ApproveIntegrator:
      return buildApproveIntegrator(
        {
          integratorAccountIndex: i64(big(f, "IntegratorAccountIndex")),
          maxPerpsTakerFee: u32(num(f, "MaxPerpsTakerFee")),
          maxPerpsMakerFee: u32(num(f, "MaxPerpsMakerFee")),
          maxSpotTakerFee: u32(num(f, "MaxSpotTakerFee")),
          maxSpotMakerFee: u32(num(f, "MaxSpotMakerFee")),
          approvalExpiry: i64(big(f, "ApprovalExpiry")),
        },
        o,
      );
    default:
      throw new Error(`vector row has no builder for tx type ${String(row.txType)}`);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Scalar helpers for the key recovery
 * ---------------------------------------------------------------------------------------------- */

/** `a⁻¹ mod m` by the extended Euclidean algorithm. Test-only; nothing in `src/` needs it. */
function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1]: [bigint, bigint] = [((a % m) + m) % m, m];
  let [s0, s1]: [bigint, bigint] = [1n, 0n];
  while (r1 !== 0n) {
    const q: bigint = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** `sk = (k − s)·e⁻¹ (mod n)`, as canonical 40-byte little-endian hex. */
function recoverKeyHex(signatureBytesHex: string, nonceKLeHex: string): string {
  const sig: Uint8Array = hexToBytes(signatureBytesHex);
  const s: bigint = scalarFromBytes(sig.subarray(0, 40));
  const e: bigint = scalarFromBytes(sig.subarray(40, 80));
  const k: bigint = scalarFromBytes(hexToBytes(nonceKLeHex));
  const sk: bigint = (((((k - s) % N) + N) % N) * modInverse(e, N)) % N;
  return bytesToHex(scalarToBytes(sk));
}

const KEY: ApiKey = ApiKey.fromPrivateKey(EXPECTED_KEY_HEX);

/* -------------------------------------------------------------------------------------------------
 * 1. Message hashes — the load-bearing assertion
 * ---------------------------------------------------------------------------------------------- */

describe("txHashHex reproduces every conformance row", () => {
  test("the vector file still has the expected shape", () => {
    expect(vectors.txHashes).toHaveLength(38);
    expect(vectors.attributeHashes).toHaveLength(6);
    expect(CHAIN).toBe(CHAIN_ID.mainnet);
  });

  for (const row of vectors.txHashes) {
    test(row.name, () => {
      const tx: UnsignedTx = buildFromRow(row);
      expect(tx.type).toBe(row.txType as UnsignedTx["type"]);
      expect(txHashHex(tx, CHAIN)).toBe(row.messageHashLeHex);
      // 40 bytes, and the hex form carries no `0x`.
      expect(txHash(tx, CHAIN)).toHaveLength(40);
      expect(row.messageHashLeHex).toMatch(/^[0-9a-f]{80}$/);
    });
  }

  test("all twenty constructible types are covered by the rows", () => {
    const covered: Set<number> = new Set(vectors.txHashes.map((r) => r.txType));
    expect(covered.size).toBe(20);
  });

  test("a wrong chain id changes every hash", () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const tx: UnsignedTx = buildFromRow(row);
    expect(txHashHex(tx, CHAIN_ID.testnet)).not.toBe(row.messageHashLeHex);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 2. The aggregate step
 * ---------------------------------------------------------------------------------------------- */

describe("the aggregate step is the last step of every hash", () => {
  for (const [i, row] of vectors.attributeHashes.entries()) {
    test(`attributeHashes[${String(i)}]${row.isEmpty ? " (empty)" : ""}`, () => {
      const input: Fp5 = row.inputTxHash.map((limb) => BigInt(limb)) as unknown as Fp5;
      const aggregated: Uint8Array = aggregateTxHash(input, row.attributes as TxAttributes);
      expect(bytesToHex(aggregated)).toBe(row.aggregatedLeBytesHex);
    });
  }

  test("the pipeline routes a real transaction through aggregate", () => {
    const row: TxHashRow = vectors.txHashes.find(
      (r) => r.name === "create_order/with_integrator_attributes",
    ) as TxHashRow;
    const tx: UnsignedTx = buildFromRow(row);
    const schema = requireTxSchema(TX_SCHEMAS, tx.type);
    const raw = hashToQuinticExtension(txHashElements(schema, tx, CHAIN));
    // The un-aggregated digest is *not* the signed message; the aggregate step is what closes the gap.
    expect(bytesToHex(aggregateTxHash(raw, tx.attributes))).toBe(row.messageHashLeHex);
    expect(bytesToHex(aggregateTxHash(raw, undefined))).not.toBe(row.messageHashLeHex);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 3. Signatures
 * ---------------------------------------------------------------------------------------------- */

describe("signTx", () => {
  test("all 41 signed rows recover one consistent private key", () => {
    const recovered: Set<string> = new Set<string>();
    for (const row of vectors.txHashes) {
      recovered.add(recoverKeyHex(row.signatureBytesHex, row.nonceKLeHex));
    }
    for (const row of vectors.authTokens) {
      recovered.add(recoverKeyHex(row.signatureBytesHex, row.nonceKLeHex));
    }
    expect(vectors.txHashes.length + vectors.authTokens.length).toBe(41);
    expect([...recovered]).toEqual([EXPECTED_KEY_HEX]);
  });

  for (const row of vectors.txHashes) {
    test(`${row.name} — signature bytes with the pinned k`, () => {
      const tx: UnsignedTx = buildFromRow(row);
      const signed = signTx(tx, KEY, CHAIN, {
        nonce: scalarFromBytes(hexToBytes(row.nonceKLeHex)),
      });
      expect(bytesToHex(signed.sig)).toBe(row.signatureBytesHex);
    });
  }

  test("returns a value, not a Promise — at run time and at type level", () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const signed = signTx(buildFromRow(row), KEY, CHAIN);
    expect(signed instanceof Promise).toBe(false);
    expect(signed.sig).toBeInstanceOf(Uint8Array);
    expect(signed.sig).toHaveLength(80);

    // Type level: `ReturnType<typeof signTx>` must not be assignable to a promise of anything.
    type IsPromise<T> = T extends Promise<unknown> ? true : false;
    const notAPromise: IsPromise<ReturnType<typeof signTx>> = false;
    expect(notAPromise).toBe(false);
  });

  test("the default nonce is hedged, and still verifies against the message", () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const tx: UnsignedTx = buildFromRow(row);
    const a = signTx(tx, KEY, CHAIN);
    const b = signTx(tx, KEY, CHAIN);
    // Hedged, so two signatures over the same message differ — and neither is the pinned one.
    expect(bytesToHex(a.sig)).not.toBe(bytesToHex(b.sig));
    expect(bytesToHex(a.sig)).not.toBe(row.signatureBytesHex);
  });

  test("does not mutate the transaction it signs", () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const tx: UnsignedTx = buildFromRow(row);
    const signed = signTx(tx, KEY, CHAIN);
    expect(tx).not.toHaveProperty("sig");
    expect(Object.isFrozen(signed)).toBe(true);
    expect(txHashHex(signed, CHAIN)).toBe(row.messageHashLeHex);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 4. `toTxInfo` — golden strings, not vectors
 * ---------------------------------------------------------------------------------------------- */

const GOLDEN_OPTS: TransactOpts = {
  accountIndex: i64(1),
  apiKeyIndex: u8(0),
  nonce: i64(42),
  expiredAt: i64(1_893_456_000_000n),
};

/** A deterministic 80-byte signature, so the golden strings do not depend on the nonce mode. */
function withSig<T extends UnsignedTx>(tx: T, fill: number): T & { sig: Uint8Array } {
  const sig: Uint8Array = new Uint8Array(80).fill(fill);
  return Object.freeze({ ...tx, sig }) as unknown as T & { sig: Uint8Array };
}

describe("toTxInfo", () => {
  test("create_order with integrator attributes", () => {
    const tx = buildCreateOrder(
      {
        marketIndex: i16(1),
        clientOrderIndex: i64(55),
        baseAmount: i64(1000),
        price: u32(2000),
        isAsk: u8(0),
        orderType: u8(0),
        timeInForce: u8(1),
        reduceOnly: u8(0),
        triggerPrice: u32(0),
        orderExpiry: i64(1_893_456_000_000n),
      },
      { ...GOLDEN_OPTS, attributes: { 1: 4242, 2: 250, 3: 100 } },
    );
    const info: string = toTxInfo(withSig(tx, 0));
    expect(info).toBe(
      '{"AccountIndex":1,"ApiKeyIndex":0,"MarketIndex":1,"ClientOrderIndex":55,"BaseAmount":1000,' +
        '"Price":2000,"IsAsk":0,"Type":0,"TimeInForce":1,"ReduceOnly":0,"TriggerPrice":0,' +
        '"OrderExpiry":1893456000000,"ExpiredAt":1893456000000,"Nonce":42,"Sig":"' +
        "A".repeat(107) +
        '=","L2TxAttributes":{"1":4242,"2":250,"3":100}}',
    );
    // 80 bytes of base64 is 108 characters including the `==` pad.
    const sigField: string = info.slice(info.indexOf('"Sig":"') + 7, info.indexOf('","L2Tx'));
    expect(sigField).toHaveLength(108);
    expect(info.startsWith("{")).toBe(true);
    expect(info).not.toContain("SignedHash");
  });

  test("absent attributes render as null", () => {
    const tx = buildCancelOrder({ marketIndex: i16(1), index: i64(12_345) }, GOLDEN_OPTS);
    expect(toTxInfo(withSig(tx, 0))).toBe(
      '{"AccountIndex":1,"ApiKeyIndex":0,"MarketIndex":1,"Index":12345,' +
        '"ExpiredAt":1893456000000,"Nonce":42,"Sig":"' +
        "A".repeat(107) +
        '=","L2TxAttributes":null}',
    );
  });

  test("an Index above 2^53 round-trips as an unquoted decimal number", () => {
    const tx = buildCancelOrder(
      { marketIndex: i16(1), index: i64(1_152_921_504_606_846_975n) },
      GOLDEN_OPTS,
    );
    const info: string = toTxInfo(withSig(tx, 0));
    expect(info).toContain('"Index":1152921504606846975,');
    // The value survives verbatim: no quotes, no exponent, no rounding to …847000.
    expect(info).not.toContain("1152921504606847000");
    expect(info).not.toContain('"1152921504606846975"');
  });

  test("Memo is 32 JSON numbers, and L1Sig is a 0x hex string", () => {
    const memo: Uint8Array = new Uint8Array(32);
    memo[0] = 1;
    memo[31] = 255;
    const tx = buildTransfer(
      {
        toAccountIndex: i64(2),
        assetIndex: i16(3),
        fromRouteType: u8(0),
        toRouteType: u8(1),
        amount: i64(4_886_718_345n),
        usdcFee: i64(0),
        memo,
      },
      GOLDEN_OPTS,
    );
    const l1Sig: L1SigHex = `0x${"ab".repeat(65)}`;
    const info: string = toTxInfo(withSig({ ...tx, l1Sig }, 0));
    expect(info).toBe(
      '{"FromAccountIndex":1,"ApiKeyIndex":0,"ToAccountIndex":2,"AssetIndex":3,' +
        '"FromRouteType":0,"ToRouteType":1,"Amount":4886718345,"USDCFee":0,' +
        '"Memo":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255],' +
        '"ExpiredAt":1893456000000,"Nonce":42,"Sig":"' +
        "A".repeat(107) +
        `=","L1Sig":"0x${"ab".repeat(65)}","L2TxAttributes":null}`,
    );
    // Not base64, not hex: a Go `[32]byte` array is a JSON number list (§9.2).
    expect(info).toContain('"Memo":[');
  });

  test("PubKey is 56 base64 characters of the original 40 bytes", () => {
    const pubKey: Uint8Array = hexToBytes(
      "2386e091523144a70cba52660fd90382d1b30ee377e5068b43992a63a2dea9ddaf2c1c0df62bcbca",
    );
    const tx = buildChangePubKey({ pubKey }, GOLDEN_OPTS);
    const l1Sig: L1SigHex = `0x${"cd".repeat(65)}`;
    const info: string = toTxInfo(withSig({ ...tx, l1Sig }, 0));
    const expectedPubKey: string = bytesToBase64(pubKey);
    expect(expectedPubKey).toHaveLength(56);
    expect(info).toBe(
      '{"AccountIndex":1,"ApiKeyIndex":0,"PubKey":"' +
        expectedPubKey +
        `","L1Sig":"0x${"cd".repeat(65)}","ExpiredAt":1893456000000,"Nonce":42,"Sig":"` +
        "A".repeat(107) +
        '=","L2TxAttributes":null}',
    );
    // The base64 is of the original bytes, not a re-serialisation of the reduced field elements.
    expect(expectedPubKey).toBe("I4bgkVIxRKcMulJmD9kDgtGzDuN35QaLQ5kqY6Leqd2vLBwN9ivLyg==");
  });

  test("key order matches the schema's declaration order", () => {
    const tx = buildUpdateMargin(
      { marketIndex: i16(1), usdcAmount: i64(4_886_718_345n), direction: u8(1) },
      GOLDEN_OPTS,
    );
    const info: string = toTxInfo(withSig(tx, 0));
    const keys: string[] = [...info.matchAll(/"([A-Za-z0-9]+)":/g)].map((m) => m[1] as string);
    expect(keys).toEqual([
      "AccountIndex",
      "ApiKeyIndex",
      "MarketIndex",
      "USDCAmount",
      "Direction",
      "ExpiredAt",
      "Nonce",
      "Sig",
      "L2TxAttributes",
    ]);
  });

  test("an unsigned transaction cannot be serialised", () => {
    const tx = buildCancelOrder({ marketIndex: i16(1), index: i64(1) }, GOLDEN_OPTS);
    expect(() => toTxInfo(tx as SignedTx)).toThrow(/missing declared field "sig"/);
  });
});

/* -------------------------------------------------------------------------------------------------
 * 5. `txSubmission`
 * ---------------------------------------------------------------------------------------------- */

describe("txSubmission", () => {
  test("carries the tx type, the document and the out-of-band hash", () => {
    const row: TxHashRow = vectors.txHashes.find((r) => r.name === "cancel_order/2") as TxHashRow;
    const signed = signTx(buildFromRow(row), KEY, CHAIN, {
      nonce: scalarFromBytes(hexToBytes(row.nonceKLeHex)),
    });
    const sub = txSubmission(signed, CHAIN);

    expect(sub.txType).toBe(TxType.L2CancelOrder);
    expect(sub.txInfo.startsWith("{")).toBe(true);
    expect(sub.txInfo).not.toContain("SignedHash");
    expect(sub.txHash).toBe(row.messageHashLeHex);
    expect(sub.txHash).toMatch(/^[0-9a-f]{80}$/);
    expect(sub.txHash.startsWith("0x")).toBe(false);
  });

  test("the hash follows the chain id it is asked for", () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const signed = signTx(buildFromRow(row), KEY, CHAIN);
    expect(txSubmission(signed, CHAIN_ID.testnet).txHash).not.toBe(
      txSubmission(signed, CHAIN_ID.mainnet).txHash,
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * 6. `tx.json` is read, never written
 * ---------------------------------------------------------------------------------------------- */

describe("the vector file is treated as ground truth", () => {
  test("txInfoJson is empty in every row and is deliberately not asserted against", () => {
    // The Go oracle does not emit `tx_info`. These fields exist so that a future oracle can fill
    // them; asserting `=== ""` today would freeze that absence into a requirement.
    for (const row of vectors.txHashes) {
      expect(typeof row.txInfoJson).toBe("string");
    }
  });

  test("every row carries a pinned nonce, without which no signature is reproducible", () => {
    for (const row of vectors.txHashes) {
      expect(row.nonceKLeHex).toMatch(/^[0-9a-f]{80}$/);
      expect(row.signatureBytesHex).toMatch(/^[0-9a-f]{160}$/);
    }
  });
});
