/**
 * `src/client/account.ts` — the raw transaction surface, and the proof that it produces the same
 * bytes as the codec it wraps.
 *
 * The load-bearing test is the conformance replay: all 38 rows of `conformance/vectors/tx.json` are
 * rebuilt **through `account.tx.*`** and prepared through `account.prepare()`, and both the message
 * hash and the signature bytes must come out identical to the oracle's. That is what makes the
 * account layer a binding rather than a reimplementation: if it stamped a field differently, mixed
 * up the account index, or lost an attribute, every one of those rows would change.
 *
 * The vector file carries no private key — it carries the pinned Schnorr nonce `k`, and the key is
 * recovered from any one signature (see `test/tx/pipeline.test.ts`, which does the recovery and
 * pins the result). `txInfoJson` is `""` for all 38 rows, so nothing here gates on it.
 *
 * No network: the transport is an injected `fetch`, and the nonce strategy is `manual`, which
 * refuses to allocate — so every nonce below is the vector's own.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { ApiKey } from "../../src/crypto/key.js";
import { scalarFromBytes } from "../../src/crypto/scalar.js";
import { LighterConfigError, LighterValidationError } from "../../src/errors.js";
import { LighterRestClient } from "../../src/rest/client.js";
import { bytesToHex, hexToBytes } from "../../src/util/bytes.js";
import type { TxAttributes } from "../../src/tx/attributes.js";
import { i16, i64, u16, u32, u64, u8 } from "../../src/tx/brands.js";
import type { SignedTx, UnsignedTx } from "../../src/tx/build.js";
import { TxType } from "../../src/tx/enums.js";
import { txHashHex } from "../../src/tx/pipeline.js";
import type { OrderInfo } from "../../src/tx/types/orders.js";
import {
  LighterAccount,
  PENDING_NONCE,
  type RawTxOpts,
  parseAccountKeys,
} from "../../src/client/account.js";
import { ManualNonceSource } from "../../src/client/nonce/manual.js";
import type { TxReceipt } from "../../src/client/receipt.js";
import { createOutcomeClassifier } from "../../src/client/nonce/types.js";
import type { SubmitContext } from "../../src/client/submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* Vectors                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, number>>;
  readonly messageHashLeHex: string;
  readonly signatureBytesHex: string;
  readonly nonceKLeHex: string;
}

const vectors = JSON.parse(
  await readFile(new URL("../../conformance/vectors/tx.json", import.meta.url), "utf8"),
) as { readonly chainId: number; readonly txHashes: readonly TxHashRow[] };

/** `304`, taken from the vector file. Never inferred from a URL. */
const CHAIN_ID: number = vectors.chainId;

/** The key behind every signature in `tx.json`, recovered in `test/tx/pipeline.test.ts`. */
const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

const KEY: ApiKey = ApiKey.fromPrivateKey(KEY_HEX);

function str(f: Readonly<Record<string, string>>, key: string): string {
  const value: string | undefined = f[key];
  if (value === undefined) throw new Error(`vector row is missing field ${key}`);
  return value;
}

/** A decimal-string field as `bigint`. Never via `Number` — `Index` reaches 2^60 − 1. */
function big(f: Readonly<Record<string, string>>, key: string): bigint {
  return BigInt(str(f, key));
}

/** A decimal-string field as `number`. Only for fields the protocol declares ≤ 32 bits. */
function num(f: Readonly<Record<string, string>>, key: string): number {
  return Number(str(f, key));
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
 * The per-row builder options.
 *
 * `now` throws: `expiredAt` is supplied by every row, and a clock read here would mean the account
 * layer had lost it.
 */
function rawOpts(row: TxHashRow): RawTxOpts {
  return {
    expiredAt: big(row.fields, "ExpiredAt"),
    attributes: row.attributes as TxAttributes,
    // The reference has no lower bound on `L2UpdateMargin.USDCAmount`; this SDK's default rejects
    // negatives, so the three negative rows replay with the tightening off.
    strict: !row.name.startsWith("update_margin/negative"),
  };
}

/** Dispatch a vector row to the account's raw surface. */
function buildFromRow(account: LighterAccount, row: TxHashRow): UnsignedTx {
  const f: Readonly<Record<string, string>> = row.fields;
  const o: RawTxOpts = rawOpts(row);
  const tx = account.tx;

  switch (row.txType) {
    case TxType.L2ChangePubKey:
      return tx.changePubKey({ pubKey: hexToBytes(str(f, "PubKeyLeHex")) }, o);
    case TxType.L2CreateSubAccount:
      return tx.createSubAccount({}, o);
    case TxType.L2CreatePublicPool:
      return tx.createPublicPool(
        {
          operatorFee: i64(big(f, "OperatorFee")),
          initialTotalShares: i64(big(f, "InitialTotalShares")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2UpdatePublicPool:
      return tx.updatePublicPool(
        {
          publicPoolIndex: i64(big(f, "PublicPoolIndex")),
          status: u8(num(f, "Status")),
          operatorFee: i64(big(f, "OperatorFee")),
          minOperatorShareRate: u16(num(f, "MinOperatorShareRate")),
        },
        o,
      );
    case TxType.L2Transfer:
      return tx.transfer(
        {
          toAccountIndex: i64(big(f, "ToAccountIndex")),
          assetIndex: i16(num(f, "AssetIndex")),
          fromRouteType: u8(num(f, "FromRouteType")),
          toRouteType: u8(num(f, "ToRouteType")),
          amount: i64(big(f, "Amount")),
          usdcFee: i64(big(f, "USDCFee")),
          // Not in the vector because it is not in the hash — it is bound to the transaction only
          // by the L1 signature.
          memo: new Uint8Array(32),
        },
        o,
      );
    case TxType.L2Withdraw:
      return tx.withdraw(
        {
          assetIndex: i16(num(f, "AssetIndex")),
          routeType: u8(num(f, "RouteType")),
          amount: u64(big(f, "Amount")),
        },
        o,
      );
    case TxType.L2CreateOrder:
      return tx.createOrder(
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
      return tx.cancelOrder({ marketIndex: i16(num(f, "MarketIndex")), index: i64(big(f, "Index")) }, o);
    case TxType.L2CancelAllOrders:
      return tx.cancelAllOrders(
        { timeInForce: u8(num(f, "TimeInForce")), time: i64(big(f, "Time")) },
        o,
      );
    case TxType.L2ModifyOrder:
      return tx.modifyOrder(
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
      return tx.mintShares(
        { publicPoolIndex: i64(big(f, "PublicPoolIndex")), shareAmount: i64(big(f, "ShareAmount")) },
        o,
      );
    case TxType.L2BurnShares:
      return tx.burnShares(
        { publicPoolIndex: i64(big(f, "PublicPoolIndex")), shareAmount: i64(big(f, "ShareAmount")) },
        o,
      );
    case TxType.L2UpdateLeverage:
      return tx.updateLeverage(
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
      for (let i: number = 0; i < count; i += 1) orders.push(leg(f, i));
      return tx.createGroupedOrders({ groupingType: u8(num(f, "GroupingType")), orders }, o);
    }
    case TxType.L2UpdateMargin:
      return tx.updateMargin(
        {
          marketIndex: i16(num(f, "MarketIndex")),
          usdcAmount: i64(big(f, "USDCAmount")),
          direction: u8(num(f, "Direction")),
        },
        o,
      );
    case TxType.L2StakeAssets:
      return tx.stakeAssets(
        { stakingPoolIndex: i64(big(f, "StakingPoolIndex")), shareAmount: i64(big(f, "ShareAmount")) },
        o,
      );
    case TxType.L2UnstakeAssets:
      return tx.unstakeAssets(
        { stakingPoolIndex: i64(big(f, "StakingPoolIndex")), shareAmount: i64(big(f, "ShareAmount")) },
        o,
      );
    case TxType.L2UpdateAccountConfig:
      return tx.updateAccountConfig({ accountTradingMode: u8(num(f, "AccountTradingMode")) }, o);
    case TxType.L2UpdateAccountAssetConfig:
      return tx.updateAccountAssetConfig(
        { assetIndex: i16(num(f, "AssetIndex")), assetMarginMode: u8(num(f, "AssetMarginMode")) },
        o,
      );
    case TxType.L2ApproveIntegrator:
      return tx.approveIntegrator(
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

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface Harness {
  readonly account: LighterAccount;
  readonly bodies: string[];
  /** What the fake server will echo as `tx_hash`. */
  hashToEcho: string | undefined;
}

function harness(accountIndex: bigint, apiKeyIndexes: readonly number[] = [0]): Harness {
  const bodies: string[] = [];
  const state: { hashToEcho: string | undefined } = { hashToEcho: undefined };
  const rest: LighterRestClient = new LighterRestClient({
    endpoint: "mainnet",
    fetch: ((_url: unknown, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 200,
            ...(state.hashToEcho !== undefined ? { tx_hash: state.hashToEcho } : {}),
            predicted_execution_time_ms: 50,
            volume_quota_remaining: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof globalThis.fetch,
  });

  const keys: Map<number, ApiKey> = new Map<number, ApiKey>();
  for (const index of apiKeyIndexes) keys.set(index, KEY);

  const ctx: SubmitContext = {
    chainId: CHAIN_ID,
    accountIndex,
    rest,
    // Manual: it refuses to allocate, so every nonce below is one the vector supplied.
    nonces: new ManualNonceSource({ accountIndex: Number(accountIndex < 0n ? 0n : accountIndex) }),
    keys,
    channel: "http",
    classify: createOutcomeClassifier(),
  };

  const account: LighterAccount = new LighterAccount({
    chainId: CHAIN_ID,
    ctx,
    rest,
    defaultTxExpiryMs: 599_000,
    now: (): number => 1_700_000_000_000,
  });

  return {
    account,
    bodies,
    get hashToEcho(): string | undefined {
      return state.hashToEcho;
    },
    set hashToEcho(value: string | undefined) {
      state.hashToEcho = value;
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* 1. Hash and signature parity, through the account surface                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("account.tx.* reproduces every conformance row", () => {
  test("the vector file still has 38 rows", () => {
    expect(vectors.txHashes).toHaveLength(38);
    expect(CHAIN_ID).toBe(304);
  });

  for (const row of vectors.txHashes) {
    test(`${row.name} — hash and signature`, async () => {
      const f: Readonly<Record<string, string>> = row.fields;
      const accountKey: string = "AccountIndex" in f ? "AccountIndex" : "FromAccountIndex";
      const apiKeyIndex: number = num(f, "ApiKeyIndex");
      const h: Harness = harness(big(f, accountKey), [apiKeyIndex]);

      const unsigned: UnsignedTx = buildFromRow(h.account, row);
      const signed: SignedTx = await h.account.prepare(unsigned, {
        nonce: big(f, "Nonce"),
        apiKeyIndex,
        sign: { nonce: scalarFromBytes(hexToBytes(row.nonceKLeHex)) },
      });

      expect(txHashHex(signed, CHAIN_ID)).toBe(row.messageHashLeHex);
      expect(bytesToHex(signed.sig)).toBe(row.signatureBytesHex);
    });
  }

  test("the receipt's txHash is the vector's message hash, 0x-prefixed and lowercase", async () => {
    const row: TxHashRow = vectors.txHashes[0] as TxHashRow;
    const f: Readonly<Record<string, string>> = row.fields;
    const h: Harness = harness(big(f, "AccountIndex"), [num(f, "ApiKeyIndex")]);
    // The server echoes the same digest in the other spelling; the SDK asserts they agree.
    h.hashToEcho = `0x${row.messageHashLeHex.toUpperCase()}`;

    const receipt: TxReceipt = await h.account.send(buildFromRow(h.account, row), {
      nonce: big(f, "Nonce"),
      apiKeyIndex: num(f, "ApiKeyIndex"),
      sign: { nonce: scalarFromBytes(hexToBytes(row.nonceKLeHex)) },
    });
    expect(receipt.txHash).toBe(`0x${row.messageHashLeHex}` as `0x${string}`);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 2. The raw surface                                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("the raw tier", () => {
  test("stamps the account's index and a placeholder identity", () => {
    const h: Harness = harness(65n, [3]);
    const tx = h.account.tx.cancelOrder({ marketIndex: i16(0), index: i64(1n) });
    expect(tx.accountIndex as bigint).toBe(65n);
    expect(tx.nonce as bigint).toBe(PENDING_NONCE as bigint);
    // The first configured key, and only as a placeholder — the lease decides the real one.
    expect(tx.apiKeyIndex as number).toBe(3);
  });

  test("defaults expiredAt to now + 599 000 ms through the injected clock", () => {
    const h: Harness = harness(1n);
    const tx = h.account.tx.cancelOrder({ marketIndex: i16(0), index: i64(1n) });
    expect(tx.expiredAt as bigint).toBe(1_700_000_000_000n + 599_000n);
  });

  test("is synchronous and covers all twenty constructible types", () => {
    const h: Harness = harness(1n);
    const names: readonly string[] = Object.keys(h.account.tx).sort();
    expect(names).toHaveLength(20);
    expect(names).toContain("createOrder");
    expect(names).toContain("approveIntegrator");
    expect(Object.isFrozen(h.account.tx)).toBe(true);
  });

  test("a per-call expiredAt wins over the default", () => {
    const h: Harness = harness(1n);
    const tx = h.account.tx.cancelOrder({ marketIndex: i16(0), index: i64(1n) }, {
      expiredAt: 42n,
    });
    expect(tx.expiredAt as bigint).toBe(42n);
  });

  test("a builder still validates: an out-of-range price is refused before anything is signed", () => {
    const h: Harness = harness(1n);
    expect(() =>
      h.account.tx.createOrder({
        marketIndex: i16(1),
        clientOrderIndex: i64(1n),
        baseAmount: i64(1n),
        price: u32(0),
        isAsk: u8(0),
        orderType: u8(0),
        timeInForce: u8(1),
        reduceOnly: u8(0),
        triggerPrice: u32(0),
        orderExpiry: i64(1_893_456_000_000n),
      }),
    ).toThrow(LighterValidationError);
  });
});

describe("integrator attribution", () => {
  const order = {
    marketIndex: i16(1),
    clientOrderIndex: i64(1n),
    baseAmount: i64(1n),
    price: u32(1),
    isAsk: u8(0),
    orderType: u8(0),
    timeInForce: u8(1),
    reduceOnly: u8(0),
    triggerPrice: u32(0),
    orderExpiry: i64(1_893_456_000_000n),
  };

  test("is absent unless configured", () => {
    expect(harness(1n).account.tx.createOrder(order).attributes).toEqual({});
  });

  test("lands on order types as attributes 1/2/3, and on nothing else", () => {
    const h: Harness = harness(1n, [0]);
    const integrating: LighterAccount = withIntegrator(h.account, {
      accountIndex: 4242n,
      takerFee: 250,
      makerFee: 100,
    });
    expect(integrating.tx.createOrder(order).attributes).toEqual({ 1: 4242, 2: 250, 3: 100 });
    // An attribute participates in the hash, so it is never free metadata — and a withdrawal has
    // no integrator, so it must carry none.
    expect(
      integrating.tx.withdraw({ assetIndex: i16(3), routeType: u8(0), amount: u64(1n) }).attributes,
    ).toEqual({});
  });

  test("an explicit per-call attribute map replaces the defaults wholesale", () => {
    const h: Harness = harness(1n, [0]);
    const integrating: LighterAccount = withIntegrator(h.account, { accountIndex: 4242n });
    expect(integrating.tx.createOrder(order, { attributes: { 6: 2 } }).attributes).toEqual({ 6: 2 });
  });
});

/** Rebuild an account with integrator defaults, reusing the harness's transports. */
function withIntegrator(
  account: LighterAccount,
  integrator: { accountIndex: bigint; takerFee?: number; makerFee?: number },
): LighterAccount {
  const rest: LighterRestClient = new LighterRestClient({ endpoint: "mainnet" });
  return new LighterAccount({
    chainId: CHAIN_ID,
    ctx: {
      chainId: CHAIN_ID,
      accountIndex: account.accountIndex,
      rest,
      nonces: account.nonces,
      keys: new Map<number, ApiKey>([[0, KEY]]),
      channel: "http",
    },
    rest,
    defaultTxExpiryMs: 599_000,
    now: (): number => 1_700_000_000_000,
    integrator,
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* 3. Transport views and state reads                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe("via", () => {
  test("returns the identical surface over a different transport, sharing keys and nonces", () => {
    const h: Harness = harness(9n, [0, 1]);
    const ws: LighterAccount = h.account.via("ws");
    expect(ws).not.toBe(h.account);
    expect(ws.channel).toBe("ws");
    expect(h.account.channel).toBe("http");
    // Shared by reference: two views must never allocate the same nonce.
    expect(ws.nonces).toBe(h.account.nonces);
    expect(ws.accountIndex).toBe(h.account.accountIndex);
    expect(ws.apiKeyIndexes).toEqual(h.account.apiKeyIndexes);
    expect(Object.keys(ws.tx).sort()).toEqual(Object.keys(h.account.tx).sort());
  });

  test("asking for the channel it already has returns the same object", () => {
    const h: Harness = harness(9n);
    expect(h.account.via("http")).toBe(h.account);
  });
});

describe("account state", () => {
  test("state() reads by index and is never cached", async () => {
    const seen: string[] = [];
    const rest: LighterRestClient = new LighterRestClient({
      endpoint: "mainnet",
      fetch: ((url: unknown): Promise<Response> => {
        seen.push(String(url));
        return Promise.resolve(
          new Response(JSON.stringify({ code: 200, accounts: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof globalThis.fetch,
    });
    const account: LighterAccount = new LighterAccount({
      chainId: CHAIN_ID,
      ctx: {
        chainId: CHAIN_ID,
        accountIndex: 140_737_488_355_328n,
        rest,
        nonces: new ManualNonceSource({ accountIndex: 1 }),
        keys: new Map<number, ApiKey>([[0, KEY]]),
        channel: "http",
      },
      rest,
      defaultTxExpiryMs: 599_000,
      now: (): number => 0,
    });

    await account.state();
    await account.state();
    // Two calls, two requests: balances and positions are never served stale.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("by=index");
    expect(seen[0]).toContain("value=140737488355328");

    await account.accountsByL1Address("0xabc");
    expect(seen[2]).toContain("l1_address=0xabc");
    await expect(account.accountsByL1Address("")).rejects.toThrow(LighterValidationError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 4. Keys                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("key handling", () => {
  test("an unparseable key fails at construction, and the error never quotes it", () => {
    let message: string = "";
    try {
      harnessWithKeys({ 1: "0xdeadbeef" });
    } catch (e: unknown) {
      message = `${(e as Error).message}\n${JSON.stringify((e as { toJSON?: () => unknown }).toJSON?.() ?? {})}`;
    }
    expect(message).toContain("api key index 1");
    expect(message).not.toContain("deadbeef");
  });

  test("an empty key map is refused", () => {
    expect(() => harnessWithKeys({})).toThrow(LighterConfigError);
  });

  test("the caller's key object is not mutated", () => {
    const keys: Record<number, string> = { 1: `0x${KEY_HEX}` };
    harnessWithKeys(keys);
    expect(keys[1]).toBe(`0x${KEY_HEX}`);
  });
});

/** The one validated door into key material — what `client.account({ keys })` calls. */
function harnessWithKeys(keys: Record<number, string | Uint8Array>): ReadonlyMap<number, ApiKey> {
  return parseAccountKeys(keys);
}

/* ---------------------------------------------------------------------------------------------- */
/* 5. L1 resume path                                                                                */
/* ---------------------------------------------------------------------------------------------- */

describe("submitWithL1Signature", () => {
  test("refuses anything that is not 0x + 130 hex", async () => {
    const h: Harness = harness(1n);
    const tx: UnsignedTx = h.account.tx.createSubAccount();
    await expect(
      h.account.submitWithL1Signature(tx, "0xdead" as `0x${string}`),
    ).rejects.toThrow(LighterValidationError);
  });

  test("attaches the signature and submits", async () => {
    const h: Harness = harness(1n, [0]);
    const tx: UnsignedTx = h.account.tx.changePubKey({ pubKey: new Uint8Array(40).fill(3) });
    const sig: `0x${string}` = `0x${"ab".repeat(65)}`;
    const receipt: TxReceipt = await h.account.submitWithL1Signature(tx, sig, {
      nonce: 1n,
      apiKeyIndex: 0,
    });
    expect(receipt.txInfo).toContain(`"L1Sig":"0x${"ab".repeat(65)}"`);
  });
});

describe("disposal", () => {
  test("closing an account is idempotent and leaves the client's transport alone", async () => {
    const h: Harness = harness(1n);
    await h.account.close();
    await h.account.close();
    // Still usable for building: an account owns no socket and no timer.
    expect(h.account.tx.cancelOrder({ marketIndex: i16(0), index: i64(1n) }).type).toBe(
      TxType.L2CancelOrder,
    );
  });
});
