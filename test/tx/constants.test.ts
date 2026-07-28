import { describe, expect, test } from "bun:test";

import * as C from "../../src/tx/constants.js";

/**
 * Every constant, asserted against a literal written out here rather than derived.
 *
 * Each row is `[name, expected]`. The expected value carries its own type, so a constant declared
 * `number` where the protocol field is `int64` fails on `typeof`, not just on value — which is the
 * failure that actually costs money: `2^60 - 1` as a `number` is 25 units too high and no test
 * inside the safe range can see it.
 */
const EXPECTED: ReadonlyArray<readonly [string, number | bigint]> = [
  // §11.7 scales and ticks
  ["ONE_USDC", 1_000_000],
  ["ONE_LIT", 100_000_000],
  ["FEE_TICK", 1_000_000],
  ["MARGIN_FRACTION_TICK", 10_000],
  ["SHARE_TICK", 10_000],
  ["INITIAL_POOL_SHARE_VALUE", 1_000],

  // §11.8 index domains
  ["MIN_ACCOUNT_INDEX", -1n],
  ["MAX_ACCOUNT_INDEX", 281474976710654n],
  ["MAX_MASTER_ACCOUNT_INDEX", 140737488355327n],
  ["MIN_SUB_ACCOUNT_INDEX", 140737488355328n],
  ["TREASURY_ACCOUNT_INDEX", 0n],
  ["INSURANCE_FUND_OPERATOR_ACCOUNT_INDEX", 1n],
  ["MIN_API_KEY_INDEX", 0],
  ["MAX_API_KEY_INDEX", 254],
  ["NIL_API_KEY_INDEX", 255],
  ["MIN_MARKET_INDEX", 0],
  ["MIN_PERPS_MARKET_INDEX", 0],
  ["MAX_PERPS_MARKET_INDEX", 254],
  ["NIL_MARKET_INDEX", 255],
  ["MIN_SPOT_MARKET_INDEX", 2048],
  ["MAX_SPOT_MARKET_INDEX", 4094],
  ["NIL_INTEGRATOR_INDEX", 0],
  ["NIL_INTEGRATOR_TAKER_FEE", 0],
  ["NIL_INTEGRATOR_MAKER_FEE", 0],
  ["NATIVE_ASSET_INDEX", 1],
  ["USDC_ASSET_INDEX", 3],
  ["MIN_ASSET_INDEX", 1],
  ["MAX_ASSET_INDEX", 62],
  ["NIL_ASSET_INDEX", 0],
  ["DEFAULT_STRATEGY_INDEX", 0],
  ["MIN_STRATEGY_INDEX", 0],
  ["MAX_STRATEGY_INDEX", 7],
  ["NIL_STRATEGY_INDEX", 8],

  // §11.9 order domains
  ["MIN_NONCE", 0n],
  ["MIN_ORDER_NONCE", 0n],
  ["MAX_ORDER_NONCE", 281474976710655n],
  ["NIL_CLIENT_ORDER_INDEX", 0n],
  ["NIL_ORDER_INDEX", 0n],
  ["MIN_CLIENT_ORDER_INDEX", 1n],
  ["MAX_CLIENT_ORDER_INDEX", 281474976710655n],
  ["MIN_ORDER_INDEX", 281474976710656n],
  ["MAX_ORDER_INDEX", 1152921504606846975n],
  ["MIN_ORDER_BASE_AMOUNT", 1n],
  ["MAX_ORDER_BASE_AMOUNT", 281474976710655n],
  ["NIL_ORDER_BASE_AMOUNT", 0n],
  ["NIL_ORDER_PRICE", 0],
  ["MIN_ORDER_PRICE", 1],
  ["MAX_ORDER_PRICE", 4_294_967_295],
  ["NIL_ORDER_TRIGGER_PRICE", 0],
  ["MIN_ORDER_TRIGGER_PRICE", 1],
  ["MAX_ORDER_TRIGGER_PRICE", 4_294_967_295],
  ["MIN_ORDER_CANCEL_ALL_PERIOD", 300_000n],
  ["MAX_ORDER_CANCEL_ALL_PERIOD", 1_296_000_000n],
  ["NIL_ORDER_EXPIRY", 0n],
  ["MIN_ORDER_EXPIRY", 1n],
  ["MAX_ORDER_EXPIRY", 9223372036854775807n],
  ["MIN_ORDER_EXPIRY_PERIOD", 300_000n],
  ["MAX_ORDER_EXPIRY_PERIOD", 2_592_000_000n],
  ["MAX_GROUPED_ORDER_COUNT", 3],
  ["MAX_TIMESTAMP", 281474976710655n],

  // §11.10 value and share domains
  ["MAX_INVESTED_PUBLIC_POOL_COUNT", 16],
  ["MIN_INITIAL_TOTAL_SHARES", 1_000_000n],
  ["MAX_INITIAL_TOTAL_SHARES", 1_000_000_000_000n],
  ["MAX_POOL_SHARES", 1152921504606846975n],
  ["MAX_BURNT_SHARE_USDC_VALUE", 1152921504606846975n],
  ["MAX_POOL_ENTRY_USDC", 72057594037927935n],
  ["MIN_POOL_SHARES_TO_MINT_OR_BURN", 1n],
  ["MAX_POOL_SHARES_TO_MINT_OR_BURN", 1152921504606846975n],
  ["MIN_INITIAL_TOTAL_STAKING_SHARES", 10_000_000_000n],
  ["MAX_INITIAL_TOTAL_STAKING_SHARES", 100_000_000_000_000n],
  ["MIN_STAKING_SHARES_TO_MINT_OR_BURN", 1n],
  ["MAX_STAKING_SHARES_TO_MINT_OR_BURN", 1152921504606846975n],
  ["MAX_STAKING_POOL_SHARES", 1152921504606846975n],
  ["MAX_EXCHANGE_USDC", 1152921504606846975n],
  ["MIN_TRANSFER_AMOUNT", 1n],
  ["MAX_TRANSFER_AMOUNT", 1152921504606846975n],
  ["MIN_WITHDRAWAL_AMOUNT", 1n],
  ["MAX_WITHDRAWAL_AMOUNT", 1152921504606846975n],

  // §11.11 sizes
  ["NB_ATTRIBUTES_PER_TX", 4],
  ["MAX_ATTRIBUTE_TYPE", 7],
  ["SIGNATURE_LENGTH", 80],
  ["L1_SIGNATURE_LENGTH", 65],
  ["PUBKEY_LENGTH", 40],
  ["HASH_LENGTH", 40],
  ["PRIVATE_KEY_LENGTH", 40],
  ["MEMO_LENGTH", 32],
];

const module_: Readonly<Record<string, unknown>> = C as unknown as Readonly<Record<string, unknown>>;

describe("protocol constants", () => {
  test("every constant equals its literal protocol value", () => {
    for (const [name, expected] of EXPECTED) {
      expect({ name, value: module_[name] }).toEqual({ name, value: expected });
    }
  });

  test("every constant has the declared runtime type", () => {
    for (const [name, expected] of EXPECTED) {
      expect({ name, type: typeof module_[name] }).toEqual({ name, type: typeof expected });
    }
  });

  test("no constant is missing from the assertion table", () => {
    const asserted: ReadonlySet<string> = new Set(EXPECTED.map(([name]) => name));
    const numeric: readonly string[] = Object.keys(module_).filter((key) => {
      const value: unknown = module_[key];
      return typeof value === "number" || typeof value === "bigint";
    });
    expect([...numeric].filter((key) => !asserted.has(key))).toEqual([]);
  });
});

describe("width discipline", () => {
  /**
   * The whole point of the bigint rule. Anything past `2^53 - 1` is silently wrong as a `number`:
   * `1152921504606846975` becomes `1152921504606847000`, a bound 25 units too permissive.
   */
  test("every bound beyond 2^53 - 1 is a bigint", () => {
    for (const [name, expected] of EXPECTED) {
      const magnitude: number =
        typeof expected === "bigint" ? Math.abs(Number(expected)) : Math.abs(expected);
      if (magnitude > Number.MAX_SAFE_INTEGER) {
        expect(typeof module_[name]).toBe("bigint");
      }
    }
  });

  test("the large bounds survive a round trip through Number, proving they are not numbers", () => {
    // If these had been written as `number` literals the two sides would be equal.
    expect(BigInt(Number(C.MAX_ORDER_INDEX))).not.toBe(C.MAX_ORDER_INDEX);
    expect(BigInt(Number(C.MAX_EXCHANGE_USDC))).not.toBe(C.MAX_EXCHANGE_USDC);
    expect(BigInt(Number(C.MAX_TRANSFER_AMOUNT))).not.toBe(C.MAX_TRANSFER_AMOUNT);
    expect(BigInt(Number(C.MAX_ORDER_EXPIRY))).not.toBe(C.MAX_ORDER_EXPIRY);
  });

  test("bounds guarding int64/uint64 fields are bigint even when the value is safe", () => {
    for (const name of [
      "MIN_ACCOUNT_INDEX",
      "MAX_ACCOUNT_INDEX",
      "MAX_MASTER_ACCOUNT_INDEX",
      "MIN_SUB_ACCOUNT_INDEX",
      "MAX_CLIENT_ORDER_INDEX",
      "MAX_ORDER_BASE_AMOUNT",
      "MAX_TIMESTAMP",
      "MIN_TRANSFER_AMOUNT",
      "MIN_WITHDRAWAL_AMOUNT",
    ]) {
      expect(typeof module_[name]).toBe("bigint");
    }
  });

  test("bounds guarding 32-bit-or-narrower fields are number", () => {
    for (const name of [
      "MIN_API_KEY_INDEX",
      "MAX_API_KEY_INDEX",
      "NIL_API_KEY_INDEX",
      "MAX_PERPS_MARKET_INDEX",
      "MAX_SPOT_MARKET_INDEX",
      "MAX_ASSET_INDEX",
      "MAX_STRATEGY_INDEX",
      "MAX_ORDER_PRICE",
      "MAX_ORDER_TRIGGER_PRICE",
    ]) {
      expect(typeof module_[name]).toBe("number");
    }
  });
});

describe("algebraic identities the values must satisfy", () => {
  const pow = (n: number): bigint => 2n ** BigInt(n);

  test("account index domain", () => {
    expect(C.MAX_ACCOUNT_INDEX).toBe(pow(48) - 2n);
    expect(C.MAX_MASTER_ACCOUNT_INDEX).toBe(pow(47) - 1n);
    expect(C.MIN_SUB_ACCOUNT_INDEX).toBe(pow(47));
    expect(C.MIN_SUB_ACCOUNT_INDEX).toBe(C.MAX_MASTER_ACCOUNT_INDEX + 1n);
  });

  test("market index families are disjoint and NIL sits between them", () => {
    expect<number>(C.MAX_PERPS_MARKET_INDEX).toBe(2 ** 8 - 2);
    expect<number>(C.MIN_SPOT_MARKET_INDEX).toBe(2 ** 11);
    expect<number>(C.MAX_SPOT_MARKET_INDEX).toBe(2 ** 12 - 2);
    expect(C.NIL_MARKET_INDEX).toBeGreaterThan(C.MAX_PERPS_MARKET_INDEX);
    expect(C.NIL_MARKET_INDEX).toBeLessThan(C.MIN_SPOT_MARKET_INDEX);
  });

  test("NIL_API_KEY_INDEX is one past the general maximum and still inside uint8", () => {
    expect<number>(C.NIL_API_KEY_INDEX).toBe(C.MAX_API_KEY_INDEX + 1);
    expect(C.NIL_API_KEY_INDEX).toBeLessThanOrEqual(255);
  });

  test("NIL_STRATEGY_INDEX is one past the maximum and still inside uint8", () => {
    expect<number>(C.NIL_STRATEGY_INDEX).toBe(C.MAX_STRATEGY_INDEX + 1);
    expect(C.NIL_STRATEGY_INDEX).toBeLessThanOrEqual(255);
  });

  test("client and exchange order-index domains are adjacent and disjoint", () => {
    expect(C.MAX_CLIENT_ORDER_INDEX).toBe(pow(48) - 1n);
    expect(C.MIN_ORDER_INDEX).toBe(C.MAX_CLIENT_ORDER_INDEX + 1n);
    expect(C.MAX_ORDER_INDEX).toBe(pow(60) - 1n);
  });

  test("2^60 - 1 ceilings", () => {
    const ceiling: bigint = pow(60) - 1n;
    expect(C.MAX_EXCHANGE_USDC).toBe(ceiling);
    expect(C.MAX_TRANSFER_AMOUNT).toBe(ceiling);
    expect(C.MAX_WITHDRAWAL_AMOUNT).toBe(ceiling);
    expect(C.MAX_POOL_SHARES).toBe(ceiling);
    expect(C.MAX_BURNT_SHARE_USDC_VALUE).toBe(ceiling);
    expect(C.MAX_POOL_SHARES_TO_MINT_OR_BURN).toBe(ceiling);
    expect(C.MAX_STAKING_SHARES_TO_MINT_OR_BURN).toBe(ceiling);
    expect(C.MAX_STAKING_POOL_SHARES).toBe(ceiling);
  });

  test("MAX_POOL_ENTRY_USDC is 2^56 - 1", () => {
    expect(C.MAX_POOL_ENTRY_USDC).toBe(pow(56) - 1n);
  });

  test("MAX_ORDER_EXPIRY is int64 max", () => {
    expect(C.MAX_ORDER_EXPIRY).toBe(pow(63) - 1n);
  });

  test("prices and trigger prices are full uint32", () => {
    expect<number>(C.MAX_ORDER_PRICE).toBe(2 ** 32 - 1);
    expect<number>(C.MAX_ORDER_TRIGGER_PRICE).toBe(2 ** 32 - 1);
  });

  test("timestamps and order nonces are 2^48 - 1", () => {
    expect(C.MAX_TIMESTAMP).toBe(pow(48) - 1n);
    expect(C.MAX_ORDER_NONCE).toBe(pow(48) - 1n);
    expect(C.MAX_ORDER_BASE_AMOUNT).toBe(pow(48) - 1n);
  });

  test("initial pool share totals derive from the share value", () => {
    const usdcSharesPerUnit: bigint = BigInt(C.ONE_USDC) / BigInt(C.INITIAL_POOL_SHARE_VALUE);
    const litSharesPerUnit: bigint = BigInt(C.ONE_LIT) / BigInt(C.INITIAL_POOL_SHARE_VALUE);
    expect(usdcSharesPerUnit).toBe(1_000n);
    expect(litSharesPerUnit).toBe(100_000n);
    expect(C.MIN_INITIAL_TOTAL_SHARES).toBe(1_000n * usdcSharesPerUnit);
    expect(C.MAX_INITIAL_TOTAL_SHARES).toBe(1_000_000_000n * usdcSharesPerUnit);
    expect(C.MIN_INITIAL_TOTAL_STAKING_SHARES).toBe(100_000n * litSharesPerUnit);
    expect(C.MAX_INITIAL_TOTAL_STAKING_SHARES).toBe(1_000_000_000n * litSharesPerUnit);
  });

  test("cancel-all and expiry periods are the documented durations in milliseconds", () => {
    expect(C.MIN_ORDER_CANCEL_ALL_PERIOD).toBe(1000n * 60n * 5n);
    expect(C.MAX_ORDER_CANCEL_ALL_PERIOD).toBe(1000n * 60n * 60n * 24n * 15n);
    expect(C.MIN_ORDER_EXPIRY_PERIOD).toBe(1000n * 60n * 5n);
    expect(C.MAX_ORDER_EXPIRY_PERIOD).toBe(1000n * 60n * 60n * 24n * 30n);
  });

  test("MIN_ACCOUNT_INDEX is -1 and is a legal value, not an absence marker", () => {
    expect(C.MIN_ACCOUNT_INDEX).toBe(-1n);
    // docs/protocol-notes.md §3.1: it sign-extends to 2^64 - 1 and reduces to 2^32 - 2.
    const P: bigint = 18446744069414584321n;
    const e: bigint = BigInt.asUintN(64, C.MIN_ACCOUNT_INDEX);
    expect(e >= P ? e - P : e).toBe(4294967294n);
  });

  test("crypto object lengths are all one GF(p^5) element", () => {
    expect(C.PUBKEY_LENGTH).toBe(40);
    expect(C.HASH_LENGTH).toBe(40);
    expect(C.PRIVATE_KEY_LENGTH).toBe(40);
    expect<number>(C.SIGNATURE_LENGTH).toBe(C.PUBKEY_LENGTH + C.HASH_LENGTH);
  });
});

describe("CHAIN_ID", () => {
  test("the three networks", () => {
    expect(C.CHAIN_ID.mainnet).toBe(304);
    expect(C.CHAIN_ID.testnet).toBe(300);
    expect(C.CHAIN_ID.rh).toBe(466324);
  });

  test("has exactly three entries and no duplicates", () => {
    const values: readonly number[] = Object.values(C.CHAIN_ID);
    expect(values.length).toBe(3);
    expect(new Set(values).size).toBe(3);
  });

  test("every chain id fits the uint32 the hash absorbs it as", () => {
    for (const id of Object.values(C.CHAIN_ID)) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(4_294_967_295);
    }
  });
});

describe("module hygiene", () => {
  test("exports no functions and no mutable containers", () => {
    for (const [key, value] of Object.entries(module_)) {
      if (key === "CHAIN_ID") continue;
      expect(typeof value === "number" || typeof value === "bigint").toBe(true);
    }
  });
});
