/**
 * Every captured REST response, checked against the hand-authored model that types it.
 *
 * This is the only test that would have caught the drift recorded in `spec/05-rest-api.md` §9.2 —
 * the vendored OpenAPI document marks ~95% of response fields `required`, while the Go server's
 * `omitempty` omits every zero-valued one, so a live `Trade` arrived missing 13 fields the
 * document guarantees. A model generated from that document typechecks perfectly and lies at
 * runtime. Only a real captured body can tell the difference, so it has to be in the default test
 * path, not behind a network flag.
 *
 * How it works, and why it is shaped this way. `tsconfig.json` does not enable `resolveJsonModule`
 * — and this unit does not own `tsconfig.json` — so the fixture cannot be imported as a typed
 * value. Instead each captured body appears here twice:
 *
 *  - once as an object **literal** with `satisfies <Model>`, which the compiler checks in both
 *    directions: a missing field on the model is an excess-property error, and a field whose type
 *    the model gets wrong (a decimal string typed `number`, say) is an assignability error;
 *  - once at runtime, where the literal is asserted deep-equal to the body actually in
 *    `test/fixtures/rest/`.
 *
 * So a model that drifts from the wire fails to compile, and a literal that drifts from the
 * fixture fails to run. Neither half is sufficient alone. A `coverage` test additionally fails
 * when a new fixture file or a new case appears without an assertion, so evidence cannot be added
 * without being checked.
 *
 * Values are live market data and will not match a later capture. Assert on shape, never on
 * numbers — that instruction is in the fixture file itself.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

import type { ResultCode, UnmodelledResponse } from "../../src/models/common.js";
import type { DetailedAccount, DetailedAccounts } from "../../src/models/account.js";
import type { AssetDetails, OrderBooks, SystemConfig } from "../../src/models/market.js";
import type { Candles, OrderBookOrders, Trades } from "../../src/models/order.js";
import type { NextNonce } from "../../src/models/transaction.js";

/* -------------------------------------------------------------------------------------------- */
/* Fixture loading                                                                                */
/* -------------------------------------------------------------------------------------------- */

interface CapturedCase {
  why: string;
  request: { path: string; method?: string };
  status: number;
  contentType: string;
  bodyIsJson: boolean;
  apiCode: number | null;
  truncated: string[];
  body: unknown;
}

interface CapturedFile {
  capturedFromBase: string;
  note: string;
  cases: Record<string, CapturedCase>;
}

const FIXTURE_DIR = new URL("../fixtures/rest/", import.meta.url);

const fixtureFiles: string[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

const captured: CapturedFile = JSON.parse(
  readFileSync(new URL("responses.json", FIXTURE_DIR), "utf8"),
) as CapturedFile;

/* -------------------------------------------------------------------------------------------- */
/* Local types for shapes this unit does not own                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The vestigial `code`/`message` that the Go server's struct embedding leaks onto **nested**
 * models (`spec/05-rest-api.md` §2.5). They are always `0`/absent and never meaningful, so the
 * public model types strip them — a consumer who can see `code` on a sub-account will eventually
 * branch on it.
 *
 * The wire still sends them, so the fixture literal still has to be allowed to carry them. This
 * type is the seam: it exists only in the test, which is exactly where the discrepancy belongs.
 */
interface VestigialResultCode {
  code?: number;
  message?: string;
}

/** `DetailedAccounts` as it appears on the wire, with the vestigial nested envelope restored. */
type WireDetailedAccounts = Omit<DetailedAccounts, "accounts"> & {
  accounts?: Array<DetailedAccount & VestigialResultCode>;
};

/**
 * `GET /api/v1/withdrawalDelay` returns `200` with **no `code` field at all** — one of the three
 * endpoints that break the envelope (`docs/protocol-notes.md` §8.1). Its public model,
 * `RespWithdrawalDelay`, lands in `src/models/misc.ts` and belongs to `rest-models-aux` (#32);
 * declaring it here as well would be the duplicate definition that issue explicitly forbids.
 *
 * What matters for this unit is the negative fact, and it is asserted below: the body has no
 * `code`, so a transport whose success rule is `body.code === 200` rejects a perfectly good
 * response. The rule has to be "HTTP 2xx and (`code` absent or `code === 200`)".
 */
interface WithdrawalDelayBody {
  seconds?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* The captured bodies, as compiler-checked literals                                              */
/* -------------------------------------------------------------------------------------------- */

const orderBooks = {
  "code": 200,
  "order_books": [
    {
      "symbol": "MAGS",
      "market_id": 155,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "inactive",
      "taker_fee": "0.0000",
      "is_taker_fee_enabled": true,
      "maker_fee": "0.0000",
      "is_maker_fee_enabled": true,
      "liquidation_fee": "1.0000",
      "min_base_amount": "0.100",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "5000000.000000",
      "supported_size_decimals": 3,
      "supported_price_decimals": 3,
      "supported_quote_decimals": 6,
      "created_at": "1772570399858",
      "multiplier": "1.000000000000000000"
    },
    {
      "symbol": "RAIL",
      "market_id": 184,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "active",
      "taker_fee": "0.0000",
      "is_taker_fee_enabled": true,
      "maker_fee": "0.0000",
      "is_maker_fee_enabled": true,
      "liquidation_fee": "1.0000",
      "min_base_amount": "2.00",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "5000000.000000",
      "supported_size_decimals": 2,
      "supported_price_decimals": 4,
      "supported_quote_decimals": 6,
      "created_at": "1779749721522",
      "multiplier": "1.000000000000000000"
    },
    {
      "symbol": "DIA",
      "market_id": 152,
      "market_type": "perp",
      "base_asset_id": 0,
      "quote_asset_id": 0,
      "status": "inactive",
      "taker_fee": "0.0000",
      "is_taker_fee_enabled": true,
      "maker_fee": "0.0000",
      "is_maker_fee_enabled": true,
      "liquidation_fee": "1.0000",
      "min_base_amount": "0.0100",
      "min_quote_amount": "10.000000",
      "order_quote_limit": "5000000.000000",
      "supported_size_decimals": 4,
      "supported_price_decimals": 2,
      "supported_quote_decimals": 6,
      "created_at": "1772570399731",
      "multiplier": "1.000000000000000000"
    }
  ]
} satisfies OrderBooks;

const systemConfig = {
  "code": 200,
  "liquidity_pool_index": 281474976710654,
  "staking_pool_index": 281474976624800,
  "funding_fee_rebate_account_index": 713888,
  "market_maker_incentive_account_index": 723106,
  "liquidity_pool_cooldown_period": 300000,
  "staking_pool_lockup_period": 259200000,
  "max_integrator_spot_taker_fee": 10000,
  "max_integrator_spot_maker_fee": 10000,
  "max_integrator_perps_taker_fee": 1000,
  "max_integrator_perps_maker_fee": 1000
} satisfies SystemConfig;

const layer1BasicInfo = {
  "code": 200,
  "l1_providers": [
    {
      "chainId": 1,
      "networkId": 1,
      "latestBlockNumber": 0
    }
  ],
  "l1_providers_health": true,
  "validator_info": [],
  "contract_addresses": [
    {
      "name": "ZkLighterContract",
      "address": "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"
    },
    {
      "name": "USDCContract",
      "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    }
  ],
  "latest_l1_generic_block": 0,
  "latest_l1_governance_block": 0,
  "latest_l1_desert_block": 0
} satisfies UnmodelledResponse;

const nextNonce = {
  "code": 200,
  "nonce": 1
} satisfies NextNonce;

const account = {
  "code": 200,
  "total": 1,
  "accounts": [
    {
      "code": 0,
      "account_type": 0,
      "index": 1,
      "l1_address": "0x0000000000000000000000000000000000000000",
      "cancel_all_time": 0,
      "total_order_count": 0,
      "total_isolated_order_count": 0,
      "pending_order_count": 0,
      "available_balance": "0.000000",
      "status": 1,
      "collateral": "0.000000",
      "transaction_time": 1784665093666991,
      "account_trading_mode": 0,
      "account_index": 1,
      "name": "",
      "description": "",
      "can_invite": true,
      "referral_points_percentage": "",
      "can_rfq": true,
      "can_rfq_market_ids": [
        "0",
        "1",
        "2"
      ],
      "created_at": 0,
      "metadata": {
        "color": ""
      },
      "positions": [],
      "assets": [],
      "total_asset_value": "0",
      "cross_asset_value": "0",
      "cross_initial_margin_requirement": "0.000000",
      "cross_maintenance_margin_requirement": "0.000000",
      "shares": [],
      "pending_unlocks": []
    }
  ]
} satisfies WireDetailedAccounts;

const orderBookOrders = {
  "code": 200,
  "total_asks": 5,
  "asks": [
    {
      "order_index": 562952978921192,
      "order_id": "562952978921192",
      "owner_account_index": 702384,
      "initial_base_amount": "0.21328",
      "remaining_base_amount": "0.17551",
      "price": "64504.2",
      "order_expiry": 1785114051354,
      "transaction_time": 0
    },
    {
      "order_index": 562952978921214,
      "order_id": "562952978921214",
      "owner_account_index": 281474976510410,
      "initial_base_amount": "0.00077",
      "remaining_base_amount": "0.00077",
      "price": "64506.2",
      "order_expiry": 1785028251299,
      "transaction_time": 0
    },
    {
      "order_index": 562952978903166,
      "order_id": "562952978903166",
      "owner_account_index": 734999,
      "initial_base_amount": "0.18000",
      "remaining_base_amount": "0.18000",
      "price": "64506.4",
      "order_expiry": 1787446502572,
      "transaction_time": 0
    }
  ],
  "total_bids": 5,
  "bids": [
    {
      "order_index": 844421858182976,
      "order_id": "844421858182976",
      "owner_account_index": 281474976641952,
      "initial_base_amount": "0.02613",
      "remaining_base_amount": "0.02613",
      "price": "64500.1",
      "order_expiry": 1787446857399,
      "transaction_time": 0
    },
    {
      "order_index": 844421858182986,
      "order_id": "844421858182986",
      "owner_account_index": 7684,
      "initial_base_amount": "0.03720",
      "remaining_base_amount": "0.03336",
      "price": "64500.0",
      "order_expiry": 1787446856842,
      "transaction_time": 0
    },
    {
      "order_index": 844421858182985,
      "order_id": "844421858182985",
      "owner_account_index": 317087,
      "initial_base_amount": "0.07437",
      "remaining_base_amount": "0.07437",
      "price": "64500.0",
      "order_expiry": 1787446856841,
      "transaction_time": 0
    }
  ]
} satisfies OrderBookOrders;

const recentTrades = {
  "code": 200,
  "trades": [
    {
      "trade_id": 26101748593,
      "trade_id_str": "26101748593",
      "tx_hash": "0000001975dc1cb90000019f9bf07f52000000000000000000000000000000000000000000000000",
      "type": "trade",
      "market_id": 1,
      "size": "0.00009",
      "price": "64504.2",
      "usd_amount": "5.805378",
      "ask_id": 562952978921192,
      "ask_id_str": "562952978921192",
      "bid_id": 844421858182967,
      "bid_id_str": "844421858182967",
      "ask_client_id": 240200955866317,
      "ask_client_id_str": "240200955866317",
      "bid_client_id": 49029667912,
      "bid_client_id_str": "49029667912",
      "ask_account_id": 702384,
      "bid_account_id": 281474976516060,
      "is_maker_ask": true,
      "block_height": 299820553,
      "timestamp": 1785027657554,
      "taker_position_size_before": "0.13021",
      "taker_entry_quote_before": "8389.676672",
      "taker_initial_margin_fraction_before": 200,
      "maker_fee": 28,
      "maker_position_size_before": "0.50767",
      "maker_entry_quote_before": "32716.048238",
      "maker_initial_margin_fraction_before": 3333,
      "transaction_time": 1785027657572944,
      "taker_allocated_margin_usdc_before": 169033241,
      "taker_allocated_margin_usdc_after": 169149269
    },
    {
      "trade_id": 26101748592,
      "trade_id_str": "26101748592",
      "tx_hash": "884f61f34306eae31a339cb483385cda1565bf1f248b9cabfac279476142c0251c9528c2bb8dd03a",
      "type": "trade",
      "market_id": 1,
      "size": "0.00020",
      "price": "64500.2",
      "usd_amount": "12.900040",
      "ask_id": 562952978921342,
      "ask_id_str": "562952978921342",
      "bid_id": 844421858182967,
      "bid_id_str": "844421858182967",
      "ask_client_id": 197453804626182,
      "ask_client_id_str": "197453804626182",
      "bid_client_id": 49029667912,
      "bid_client_id_str": "49029667912",
      "ask_account_id": 27927,
      "bid_account_id": 281474976516060,
      "is_maker_ask": true,
      "block_height": 299820553,
      "timestamp": 1785027657554,
      "taker_position_size_before": "0.13001",
      "taker_entry_quote_before": "8376.776632",
      "taker_initial_margin_fraction_before": 200,
      "maker_fee": 38,
      "maker_position_size_before": "34.35917",
      "maker_entry_quote_before": "2211380.547741",
      "maker_initial_margin_fraction_before": 500,
      "transaction_time": 1785027657572884,
      "taker_allocated_margin_usdc_before": 168776201,
      "taker_allocated_margin_usdc_after": 169033241
    },
    {
      "trade_id": 26101748568,
      "trade_id_str": "26101748568",
      "tx_hash": "0000001975dc1c3c0000019f9bf07dc3000000000000000000000000000000000000000000000000",
      "type": "trade",
      "market_id": 1,
      "size": "0.00020",
      "price": "64504.2",
      "usd_amount": "12.900840",
      "ask_id": 562952978921192,
      "ask_id_str": "562952978921192",
      "bid_id": 844421858182971,
      "bid_id_str": "844421858182971",
      "ask_client_id": 240200955866317,
      "ask_client_id_str": "240200955866317",
      "bid_client_id": 0,
      "bid_client_id_str": "0",
      "ask_account_id": 702384,
      "bid_account_id": 734091,
      "is_maker_ask": true,
      "block_height": 299820552,
      "timestamp": 1785027657155,
      "taker_fee": 50,
      "taker_position_size_before": "0.00135",
      "taker_entry_quote_before": "87.076258",
      "taker_initial_margin_fraction_before": 500,
      "maker_fee": 28,
      "maker_position_size_before": "0.50787",
      "maker_entry_quote_before": "32728.936945",
      "maker_initial_margin_fraction_before": 3333,
      "transaction_time": 1785027657515706,
      "integrator_taker_fee": 150,
      "integrator_taker_fee_collector_index": 724927
    }
  ]
} satisfies Trades;

const candles = {
  "code": 200,
  "r": "1h",
  "c": [
    {
      "t": 1750003200000,
      "o": 105622.8,
      "h": 105736.6,
      "l": 105361.5,
      "c": 105594.2,
      "v": 602.98999,
      "V": 63632159.996563,
      "i": 35162587
    },
    {
      "t": 1750006800000,
      "o": 105594.2,
      "h": 105856.3,
      "l": 105506.2,
      "c": 105754,
      "v": 874.07621,
      "V": 92361280.515111,
      "i": 35183466
    },
    {
      "t": 1750010400000,
      "o": 105754,
      "h": 105760.3,
      "l": 105494.6,
      "c": 105520.2,
      "v": 615.68089,
      "V": 64992406.998387,
      "i": 35203586
    }
  ]
} satisfies Candles;

const assetDetails = {
  "code": 200,
  "asset_details": [
    {
      "asset_id": 9,
      "symbol": "LDO",
      "l1_decimals": 18,
      "decimals": 8,
      "min_transfer_amount": "2.00000000",
      "min_withdrawal_amount": "2.00000000",
      "margin_mode": "disabled",
      "index_price": "0.371043",
      "price_decimals": 6,
      "l1_address": "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
      "loan_to_value": "0.0000",
      "liquidation_threshold": "0.0000",
      "liquidation_factor": "0.0000",
      "liquidation_fee": "0.000000",
      "global_supply_cap": "0.00000000",
      "user_supply_cap": "0.00000000",
      "total_supplied": "0.00000000",
      "multiplier": "1.000000000000000000"
    },
    {
      "asset_id": 3,
      "symbol": "USDC",
      "l1_decimals": 6,
      "decimals": 6,
      "min_transfer_amount": "1.000000",
      "min_withdrawal_amount": "1.000000",
      "margin_mode": "enabled",
      "index_price": "1.000000",
      "price_decimals": 6,
      "l1_address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "loan_to_value": "1.0000",
      "liquidation_threshold": "1.0000",
      "liquidation_factor": "1.0000",
      "liquidation_fee": "0.000000",
      "global_supply_cap": "0.000000",
      "user_supply_cap": "0.000000",
      "total_supplied": "0.000000",
      "multiplier": "1.000000000000000000"
    },
    {
      "asset_id": 6,
      "symbol": "UNI",
      "l1_decimals": 18,
      "decimals": 8,
      "min_transfer_amount": "0.20000000",
      "min_withdrawal_amount": "0.20000000",
      "margin_mode": "disabled",
      "index_price": "3.670438",
      "price_decimals": 6,
      "l1_address": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      "loan_to_value": "0.0000",
      "liquidation_threshold": "0.0000",
      "liquidation_factor": "0.0000",
      "liquidation_fee": "0.000000",
      "global_supply_cap": "0.00000000",
      "user_supply_cap": "0.00000000",
      "total_supplied": "0.00000000",
      "multiplier": "1.000000000000000000"
    }
  ]
} satisfies AssetDetails;

const withdrawalDelay = {
  "seconds": 1805
} satisfies WithdrawalDelayBody;

const errorInvalidParam = {
  "code": 20001,
  "message": "invalid param "
} satisfies ResultCode;

const errorNotFound = {
  "code": 29404,
  "message": "not found"
} satisfies ResultCode;

const errorMissingAuth = {
  "code": 20001,
  "message": "invalid param : auth query param and Authorization header are empty"
} satisfies ResultCode;

const errorGeoRestricted = {
  "code": 20558,
  "message": "You are accessing Lighter from a restricted jurisdiction. For more information, see the https://lighter.xyz/terms"
} satisfies ResultCode;

/* -------------------------------------------------------------------------------------------- */
/* Assertions                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Case name in `responses.json` → the literal above that the compiler checked against a model. */
const asserted: Record<string, unknown> = {
  orderBooks,
  systemConfig,
  layer1BasicInfo,
  nextNonce,
  account,
  orderBookOrders,
  recentTrades,
  candles,
  assetDetails,
  "withdrawalDelay-no-code-field": withdrawalDelay,
  "error-invalid-param": errorInvalidParam,
  "error-not-found": errorNotFound,
  "error-missing-auth": errorMissingAuth,
  "error-geo-restricted": errorGeoRestricted,
};

describe("REST fixture coverage", () => {
  test("every JSON file in test/fixtures/rest/ is loaded", () => {
    // A new capture file must not slip in unchecked: adding one fails here until it is read.
    expect(fixtureFiles).toEqual(["responses.json"]);
  });

  test("every captured case has a compiler-checked literal", () => {
    expect(Object.keys(captured.cases).sort()).toEqual(Object.keys(asserted).sort());
  });

  test("the capture is from mainnet and carries its own caveat", () => {
    expect(captured.capturedFromBase).toContain("zklighter");
    expect(captured.note).toContain("SHAPE");
  });
});

describe("captured bodies match their models", () => {
  for (const [name, literal] of Object.entries(asserted)) {
    test(`${name} literal is byte-identical to the captured body`, () => {
      const capturedCase = captured.cases[name];
      expect(capturedCase).toBeDefined();
      expect(literal).toEqual(capturedCase?.body);
    });
  }
});

describe("envelope facts the transport depends on", () => {
  test("success bodies carry code 200", () => {
    for (const name of ["orderBooks", "systemConfig", "nextNonce", "account", "candles"]) {
      const body = captured.cases[name]?.body as ResultCode | undefined;
      expect(body?.code).toBe(200);
    }
  });

  test("withdrawalDelay succeeds with no code field at all", () => {
    const body = captured.cases["withdrawalDelay-no-code-field"];
    expect(body?.status).toBe(200);
    expect(Object.keys(body?.body as object)).toEqual(["seconds"]);
    expect("code" in (body?.body as object)).toBe(false);
    // The predicate `body.code === 200` would reject this. See WithdrawalDelayBody above.
  });

  test("every error fixture is a bare ResultCode with a non-200 code", () => {
    for (const name of [
      "error-invalid-param",
      "error-not-found",
      "error-missing-auth",
      "error-geo-restricted",
    ]) {
      const c = captured.cases[name];
      expect(c?.status).toBe(400);
      const body = c?.body as ResultCode;
      expect(typeof body.code).toBe("number");
      expect(body.code).not.toBe(200);
      expect(typeof body.message).toBe("string");
    }
  });

  test("geo-restriction arrives as HTTP 400 code 20558, not as a validation error", () => {
    // docs/protocol-notes.md §8.3: reads succeed, writes and the WebSocket do not. Flattening this
    // into a generic 400 is what costs a developer an afternoon.
    const c = captured.cases["error-geo-restricted"];
    expect(c?.status).toBe(400);
    expect((c?.body as ResultCode).code).toBe(20558);
    expect((c?.body as ResultCode).message).toContain("restricted jurisdiction");
  });

  test("error messages carry trailing whitespace, so codes are the only safe discriminator", () => {
    const body = captured.cases["error-invalid-param"]?.body as ResultCode;
    expect(body.message).toBe("invalid param ");
  });
});

describe("numeric domains held by the models", () => {
  test("market money fields are strings on the wire", () => {
    const books = captured.cases["orderBooks"]?.body as OrderBooks;
    const first = books.order_books?.[0];
    expect(first).toBeDefined();
    for (const field of [
      "taker_fee",
      "maker_fee",
      "liquidation_fee",
      "min_base_amount",
      "min_quote_amount",
      "order_quote_limit",
      "multiplier",
    ] as const) {
      expect(typeof first?.[field]).toBe("string");
    }
    // created_at is epoch ms held in a STRING, which no other timestamp on this API does.
    expect(typeof first?.created_at).toBe("string");
  });

  test("candle OHLCV really are JSON numbers, and C/H/L/O are absent", () => {
    const body = captured.cases["candles"]?.body as Candles;
    const candle = body.c?.[0];
    expect(candle).toBeDefined();
    for (const field of ["t", "o", "h", "l", "c", "v", "V", "i"] as const) {
      expect(typeof candle?.[field]).toBe("number");
    }
    for (const field of ["C", "H", "L", "O"] as const) {
      expect(candle?.[field]).toBeUndefined();
    }
  });

  test("trade identity fields have canonical _str twins", () => {
    const body = captured.cases["recentTrades"]?.body as Trades;
    const trade = body.trades?.[0];
    expect(trade).toBeDefined();
    for (const field of [
      "trade_id_str",
      "ask_id_str",
      "bid_id_str",
      "ask_client_id_str",
      "bid_client_id_str",
    ] as const) {
      expect(typeof trade?.[field]).toBe("string");
    }
    // The numeric twins are int64-domain and lossy above 2^53; they are still on the wire.
    expect(typeof trade?.trade_id).toBe("number");
    expect(trade?.trade_id_str).toBe(String(trade?.trade_id));
  });

  test("a live trade omits fields the OpenAPI document marks required (§9.2)", () => {
    const body = captured.cases["recentTrades"]?.body as Trades;
    const first = body.trades?.[0];
    expect(first).toBeDefined();
    // taker_fee was absent on the first captured trade and present on the third: proof that
    // optionality here is measured, not stylistic.
    expect(first?.taker_fee).toBeUndefined();
    expect(body.trades?.[2]?.taker_fee).toBe(50);
    expect(body.next_cursor).toBeUndefined();
  });

  test("order book depth is individual resting orders, with string prices and sizes", () => {
    const body = captured.cases["orderBookOrders"]?.body as OrderBookOrders;
    const ask = body.asks?.[0];
    expect(typeof ask?.price).toBe("string");
    expect(typeof ask?.initial_base_amount).toBe("string");
    expect(typeof ask?.remaining_base_amount).toBe("string");
    // order_id is the canonical identity; order_index is its lossy int64 twin.
    expect(ask?.order_id).toBe(String(ask?.order_index));
    // total_asks is the returned count, bounded by `limit` — never a book total.
    expect(body.total_asks).toBe(5);
    expect(body.asks?.length).toBeLessThanOrEqual(body.total_asks ?? 0);
  });

  test("asset details keep every amount as a decimal string", () => {
    const body = captured.cases["assetDetails"]?.body as AssetDetails;
    const asset = body.asset_details?.[0];
    for (const field of [
      "min_transfer_amount",
      "min_withdrawal_amount",
      "index_price",
      "loan_to_value",
      "liquidation_threshold",
      "liquidation_factor",
      "liquidation_fee",
      "global_supply_cap",
      "user_supply_cap",
      "total_supplied",
      "multiplier",
    ] as const) {
      expect(typeof asset?.[field]).toBe("string");
    }
    expect(asset?.margin_mode).toBe("disabled");
  });

  test("systemConfig sentinels stay inside the safe integer range", () => {
    const body = captured.cases["systemConfig"]?.body as SystemConfig;
    expect(body.liquidity_pool_index).toBe(281474976710654);
    expect(Number.isSafeInteger(body.liquidity_pool_index)).toBe(true);
  });

  test("an account's transaction_time is microseconds, not milliseconds", () => {
    const body = captured.cases["account"]?.body as WireDetailedAccounts;
    const acct = body.accounts?.[0];
    // ~1.78e15: three decimal digits wider than the epoch-ms fields beside it. Nothing in the
    // payload says so, which is why the model uses the EpochMicros alias.
    expect(acct?.transaction_time).toBeGreaterThan(1e15);
    expect(typeof acct?.collateral).toBe("string");
    expect(typeof acct?.available_balance).toBe("string");
  });

  test("nested accounts carry the vestigial code the public model strips", () => {
    const body = captured.cases["account"]?.body as WireDetailedAccounts;
    const acct = body.accounts?.[0] as (DetailedAccount & VestigialResultCode) | undefined;
    expect(acct?.code).toBe(0);
    // Always 0, never meaningful (§2.5). DetailedAccount deliberately has no `code` member, so a
    // consumer cannot reach for it.
  });

  test("can_rfq_market_ids are strings, not numbers", () => {
    const body = captured.cases["account"]?.body as WireDetailedAccounts;
    for (const id of body.accounts?.[0]?.can_rfq_market_ids ?? []) {
      expect(typeof id).toBe("string");
    }
  });
});

describe("unmodelled responses", () => {
  test("layer1BasicInfo flows through UnmodelledResponse (docs/decisions.md D10)", () => {
    // No hand-authored model exists for this endpoint in this unit; D10 cuts the generated long
    // tail and routes the remainder through the permissive envelope instead of a guessed shape.
    const body = captured.cases["layer1BasicInfo"]?.body as UnmodelledResponse;
    expect(body.code).toBe(200);
    expect(Object.keys(body)).toContain("contract_addresses");
  });
});
