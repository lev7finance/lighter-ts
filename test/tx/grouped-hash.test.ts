/**
 * `src/tx/grouped-hash.ts` — the per-leg fold behind `L2CreateGroupedOrders`.
 *
 * The end-to-end proof that the fold is right lives in `test/tx/schemas-orders.test.ts`, where the
 * three `create_grouped_orders/*` vector rows are hashed in full. What is tested here is the
 * *shape* of the fold, and in particular the two ways to build something that reproduces no vector
 * but looks entirely reasonable:
 *
 * 1. seeding the accumulator with `EMPTY_HASH_OUT` and folding leg 0 into it — the reference
 *    initialises exactly that value and then never reads it (`docs/protocol-notes.md` §4);
 * 2. transposing two of the ten leaf elements, which is invisible unless the leaf order is compared
 *    against `L2CreateOrder`'s tail, where the same ten appear (`spec/04-tx-types.md` §7.12).
 *
 * The legs come from the OCO and OTOCO vector rows rather than from literals, so the fixtures are
 * the same orders the oracle hashed.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { Fp } from "../../src/crypto/field/fp.js";
import {
  EMPTY_HASH_OUT,
  type HashOut,
  hashNoPad,
  hashToQuinticExtension,
  hashTwoToOne,
} from "../../src/crypto/poseidon2/index.js";
import { LighterValidationError } from "../../src/errors.js";
import { i16, i64, u8, u32 } from "../../src/tx/brands.js";
import { TxType } from "../../src/tx/enums.js";
import {
  ORDER_LEAF_ELEMENT_COUNT,
  aggregateOrderHash,
  groupedOrderElements,
  orderLeafElements,
  orderLeafHash,
  ordersToJson,
} from "../../src/tx/grouped-hash.js";
import { txHashElements } from "../../src/tx/hash.js";
import { CREATE_ORDER_SCHEMA } from "../../src/tx/schemas/orders.js";
import type { TxLike } from "../../src/tx/schema.js";
import type { CreateOrderTx, OrderInfo } from "../../src/tx/types/orders.js";

interface TxHashRow {
  readonly name: string;
  readonly txType: number;
  readonly fields: Readonly<Record<string, string>>;
}

const vectorsUrl = new URL("../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly chainId: number;
  readonly txHashes: readonly TxHashRow[];
};

const CHAIN_ID: number = vectors.chainId;

function rowNamed(name: string): TxHashRow {
  const row: TxHashRow | undefined = vectors.txHashes.find((r) => r.name === name);
  if (row === undefined) throw new Error(`vector row ${name} is missing`);
  return row;
}

/** Read leg `i` out of a code-28 row's flattened `Order<i>.<Field>` keys. */
function legOf(row: TxHashRow, i: number): OrderInfo {
  const at = (key: string): string => {
    const value: string | undefined = row.fields[`Order${String(i)}.${key}`];
    if (value === undefined) throw new Error(`row ${row.name} has no Order${String(i)}.${key}`);
    return value;
  };
  return {
    marketIndex: i16(Number(at("MarketIndex"))),
    clientOrderIndex: i64(BigInt(at("ClientOrderIndex"))),
    baseAmount: i64(BigInt(at("BaseAmount"))),
    price: u32(Number(at("Price"))),
    isAsk: u8(Number(at("IsAsk"))),
    type: u8(Number(at("Type"))),
    timeInForce: u8(Number(at("TimeInForce"))),
    reduceOnly: u8(Number(at("ReduceOnly"))),
    triggerPrice: u32(Number(at("TriggerPrice"))),
    orderExpiry: i64(BigInt(at("OrderExpiry"))),
  };
}

const ocoRow: TxHashRow = rowNamed("create_grouped_orders/oco");
const otocoRow: TxHashRow = rowNamed("create_grouped_orders/otoco");

const OCO: readonly OrderInfo[] = [legOf(ocoRow, 0), legOf(ocoRow, 1)];
const OTOCO: readonly OrderInfo[] = [legOf(otocoRow, 0), legOf(otocoRow, 1), legOf(otocoRow, 2)];

function thrown(fn: () => unknown): LighterValidationError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LighterValidationError) return e;
    throw e;
  }
  throw new Error("expected a LighterValidationError, but nothing was thrown");
}

describe("orderLeafElements", () => {
  test("a leg contributes exactly ten elements", () => {
    expect(ORDER_LEAF_ELEMENT_COUNT).toBe(10);
    for (const leg of OTOCO) {
      expect(orderLeafElements(leg)).toHaveLength(ORDER_LEAF_ELEMENT_COUNT);
    }
  });

  test("the elements are the §7.7 fields in declaration order", () => {
    const leg: OrderInfo = OCO[0] as OrderInfo;
    expect(orderLeafElements(leg)).toEqual([
      BigInt(leg.marketIndex),
      leg.clientOrderIndex,
      leg.baseAmount,
      BigInt(leg.price),
      BigInt(leg.isAsk),
      BigInt(leg.type),
      BigInt(leg.timeInForce),
      BigInt(leg.reduceOnly),
      BigInt(leg.triggerPrice),
      leg.orderExpiry,
    ] as unknown as Fp[]);
  });

  test("it is the last ten elements of an L2CreateOrder built from the same OrderInfo", () => {
    // `spec/04-tx-types.md` §7.12: "identical to the order-specific tail of L2CreateOrder's hash".
    // One table drives the leaf and another drives code 14, so this is the assertion that keeps
    // them from drifting apart — and the fastest way to catch a transposition in either.
    for (const leg of OTOCO) {
      const tx: CreateOrderTx = {
        type: TxType.L2CreateOrder,
        accountIndex: i64(1n),
        apiKeyIndex: u8(0),
        marketIndex: leg.marketIndex,
        clientOrderIndex: leg.clientOrderIndex,
        baseAmount: leg.baseAmount,
        price: leg.price,
        isAsk: leg.isAsk,
        orderType: leg.type,
        timeInForce: leg.timeInForce,
        reduceOnly: leg.reduceOnly,
        triggerPrice: leg.triggerPrice,
        orderExpiry: leg.orderExpiry,
        expiredAt: i64(1893456000000n),
        nonce: i64(42n),
      };
      const elements: readonly Fp[] = txHashElements(CREATE_ORDER_SCHEMA, tx as TxLike, CHAIN_ID);
      expect(elements).toHaveLength(16);
      expect(elements.slice(6)).toEqual(orderLeafElements(leg) as Fp[]);
    }
  });

  test("a leg field that is not an integer names itself", () => {
    const broken = { ...(OCO[0] as OrderInfo), price: "4000" } as unknown as OrderInfo;
    const error: LighterValidationError = thrown(() => orderLeafElements(broken));
    expect(error.code).toBe("FIELD_TYPE_INVALID");
    expect(error.message).toContain("Price");
  });
});

describe("orderLeafHash", () => {
  test("it is hashNoPad over the ten elements — four outputs, not five", () => {
    const leg: OrderInfo = OCO[0] as OrderInfo;
    const leaf: HashOut = orderLeafHash(leg);
    expect(leaf).toHaveLength(4);
    expect(leaf).toEqual(hashNoPad(orderLeafElements(leg)));
  });

  test("it is not hashToQuinticExtension over the same elements", () => {
    // The plausible wrong primitive: five coefficients instead of four lanes. `hashNoPad` squeezes
    // lanes 0..3 of the same state, so the first four values coincide — the arity is the tell.
    const leg: OrderInfo = OCO[0] as OrderInfo;
    const quintic = hashToQuinticExtension(orderLeafElements(leg));
    expect(quintic).toHaveLength(5);
    expect(orderLeafHash(leg)).toHaveLength(4);
  });

  test("distinct legs hash distinctly", () => {
    expect(orderLeafHash(OCO[0] as OrderInfo)).not.toEqual(orderLeafHash(OCO[1] as OrderInfo));
  });
});

describe("aggregateOrderHash", () => {
  test("one leg is that leg's hash, unfolded", () => {
    const leg: OrderInfo = OCO[0] as OrderInfo;
    expect(aggregateOrderHash([leg])).toEqual(orderLeafHash(leg));
  });

  test("two legs fold left, seeded with leg 0", () => {
    const [a, b] = OCO as readonly [OrderInfo, OrderInfo];
    expect(aggregateOrderHash([a, b])).toEqual(hashTwoToOne(orderLeafHash(a), orderLeafHash(b)));
  });

  test("three legs fold left again, not as a balanced tree", () => {
    const [a, b, c] = OTOCO as readonly [OrderInfo, OrderInfo, OrderInfo];
    const left: HashOut = hashTwoToOne(
      hashTwoToOne(orderLeafHash(a), orderLeafHash(b)),
      orderLeafHash(c),
    );
    expect(aggregateOrderHash([a, b, c])).toEqual(left);
    // The balanced reading — hashTwoToOne(leaf(a), hashTwoToOne(leaf(b), leaf(c))) — is a different
    // digest, and there is no vector shape that would distinguish them if it were not asserted.
    const right: HashOut = hashTwoToOne(
      orderLeafHash(a),
      hashTwoToOne(orderLeafHash(b), orderLeafHash(c)),
    );
    expect(aggregateOrderHash([a, b, c])).not.toEqual(right);
  });

  test("REGRESSION: the fold is not seeded from the empty hash", () => {
    // `docs/protocol-notes.md` §4. The reference initialises acc = EMPTY_HASH_OUT and then assigns
    // leg 0's hash over it. Folding leg 0 into the empty accumulator instead produces a different,
    // plausible-looking digest for every group.
    const [a, b] = OCO as readonly [OrderInfo, OrderInfo];
    const seededFromEmpty: HashOut = hashTwoToOne(
      hashTwoToOne(EMPTY_HASH_OUT, orderLeafHash(a)),
      orderLeafHash(b),
    );
    expect(aggregateOrderHash([a, b])).not.toEqual(seededFromEmpty);

    // Same for one leg, where the mistake is even easier to make and even easier to miss.
    expect(aggregateOrderHash([a])).not.toEqual(hashTwoToOne(EMPTY_HASH_OUT, orderLeafHash(a)));
  });

  test("leg order is load-bearing: swapping legs 0 and 1 of the OCO group changes the hash", () => {
    const [a, b] = OCO as readonly [OrderInfo, OrderInfo];
    expect(aggregateOrderHash([b, a])).not.toEqual(aggregateOrderHash([a, b]));
  });

  test("an empty group throws rather than returning the empty hash", () => {
    const error: LighterValidationError = thrown(() => aggregateOrderHash([]));
    expect(error.code).toBe("ORDER_GROUP_SIZE_INVALID");
    expect(error.message).toContain("leg 0");
  });

  test("a hole or a non-object leg is rejected, not hashed as zeros", () => {
    const holed = [OCO[0], undefined] as unknown as readonly OrderInfo[];
    expect(thrown(() => aggregateOrderHash(holed)).code).toBe("FIELD_TYPE_INVALID");
    expect(thrown(() => aggregateOrderHash("nope" as unknown as readonly OrderInfo[])).code).toBe(
      "FIELD_TYPE_INVALID",
    );
  });
});

describe("groupedOrderElements", () => {
  test("it is the aggregate, spread into four elements", () => {
    const aggregate: HashOut = aggregateOrderHash(OTOCO);
    const elements: readonly Fp[] = groupedOrderElements(OTOCO);
    expect(elements).toHaveLength(4);
    expect(elements).toEqual([aggregate[0], aggregate[1], aggregate[2], aggregate[3]]);
  });

  test("it propagates the empty-group error", () => {
    expect(thrown(() => groupedOrderElements([])).code).toBe("ORDER_GROUP_SIZE_INVALID");
  });
});

describe("ordersToJson", () => {
  test("an array of objects with the §7.7 key order, nothing omitted", () => {
    expect(ordersToJson(OCO)).toBe(
      `[{"MarketIndex":1,"ClientOrderIndex":2003,"BaseAmount":0,"Price":4000,"IsAsk":1,` +
        `"Type":2,"TimeInForce":0,"ReduceOnly":1,"TriggerPrice":4100,"OrderExpiry":1893456000000},` +
        `{"MarketIndex":1,"ClientOrderIndex":2004,"BaseAmount":0,"Price":6000,"IsAsk":1,` +
        `"Type":4,"TimeInForce":0,"ReduceOnly":1,"TriggerPrice":5900,"OrderExpiry":1893456000000}]`,
    );
  });

  test("nil values are emitted as 0 — nothing in the protocol uses omitempty", () => {
    expect(ordersToJson(OCO)).toContain(`"BaseAmount":0`);
  });

  test("a 64-bit value is exact and never exponent notation", () => {
    const leg: OrderInfo = {
      ...(OCO[0] as OrderInfo),
      clientOrderIndex: i64(281474976710655n),
      orderExpiry: i64(9223372036854775807n),
    };
    const json: string = ordersToJson([leg]);
    expect(json).toContain(`"ClientOrderIndex":281474976710655`);
    expect(json).toContain(`"OrderExpiry":9223372036854775807`);
    expect(json).not.toContain("e+");
  });

  test("the empty array is [] — the hash path is where an empty group is refused", () => {
    expect(ordersToJson([])).toBe("[]");
  });

  test("a non-integer field is rejected rather than stringified", () => {
    const broken = { ...(OCO[0] as OrderInfo), price: 1.5 } as unknown as OrderInfo;
    expect(thrown(() => ordersToJson([broken])).code).toBe("UNSAFE_INTEGER");
  });
});
