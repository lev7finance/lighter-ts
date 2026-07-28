/**
 * The captured REST responses that belong to the auxiliary models, plus the compile-time facts
 * those models exist to state.
 *
 * `test/models/fixtures.test.ts` covers the trading core and is owned by `rest-models-core`. This
 * file covers the same evidence from the other side: of the fourteen captured cases, exactly two
 * are typed by a model in `referral.ts` / `rfq.ts` / `lease.ts` / `pool.ts` / `misc.ts` —
 * `layer1BasicInfo` and `withdrawalDelay-no-code-field`. Both are asserted here twice:
 *
 *  - once as an object **literal** with `satisfies <Model>`, which the compiler checks in both
 *    directions — a field missing from the model is an excess-property error, and a field whose
 *    type the model gets wrong is an assignability error;
 *  - once at runtime, deep-equal against the body actually in `test/fixtures/rest/`.
 *
 * So a model that drifts from the wire fails to compile, and a literal that drifts from the capture
 * fails to run. A coverage test fails when a new fixture file or case appears, so evidence cannot
 * be added without someone deciding whether it types one of these models.
 *
 * The rest of this unit has no capture behind it — the referral, RFQ, lease and pool endpoints are
 * all auth-gated or write-gated, and writes are geo-blocked from the capture host
 * (`docs/protocol-notes.md` §8, API code 20558). Fabricating literals for them would assert only
 * that this file agrees with itself. Instead the structural claims the issue makes — which models
 * carry no `code`, that every response field but `code` is optional, that the four `Resp*RFQ`
 * envelopes are one type, that no amount is a `number` — are asserted as **type-level** tests,
 * which fail at `tsc` rather than at `bun test`. `expectTypes` below keeps them from being
 * silently deleted.
 *
 * Values are live market data and will not match a later capture. Assert on shape, never on
 * numbers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

import type { ResultCode } from "../../src/models/common.js";
import type { L1Metadata, PartnerStats, ReferralPoints } from "../../src/models/referral.js";
import type {
  ReqCreateRFQ,
  RespCreateRFQ,
  RespGetRFQ,
  RespListRFQs,
  RespRFQ,
  RespRespondToRFQ,
  RespUpdateRFQ,
} from "../../src/models/rfq.js";
import type { LeaseEntry, ReqLITLease, RespGetLeases } from "../../src/models/lease.js";
import type { PublicPoolMetadata, SharePrice } from "../../src/models/pool.js";
import type {
  Announcement,
  DepositHistoryItem,
  Layer1BasicInfo,
  RespGetExecuteStats,
  RespWithdrawalDelay,
  Status,
  TransferHistoryItem,
  WithdrawHistoryItem,
} from "../../src/models/misc.js";

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
const SRC_DIR = new URL("../../src/models/", import.meta.url);

const fixtureFiles: string[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

const captured: CapturedFile = JSON.parse(
  readFileSync(new URL("responses.json", FIXTURE_DIR), "utf8"),
) as CapturedFile;

/** The five files this unit owns. Read as text so the mechanical rules can be checked, not claimed. */
const OWNED_FILES = ["referral.ts", "rfq.ts", "lease.ts", "pool.ts", "misc.ts"] as const;

const source: Record<string, string> = Object.fromEntries(
  OWNED_FILES.map((name) => [name, readFileSync(new URL(name, SRC_DIR), "utf8")]),
);

/* -------------------------------------------------------------------------------------------- */
/* The captured bodies, as compiler-checked literals                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/layer1BasicInfo`.
 *
 * The three keys inside `l1_providers` are **camelCase** — the only place on this API where the
 * "every key is snake_case" rule (`spec/05-rest-api.md` §2.1) is false. This literal is where that
 * is proved: spell them `chain_id` and the `satisfies` below stops compiling.
 */
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
} satisfies Layer1BasicInfo;

/**
 * `GET /api/v1/withdrawalDelay` — the envelope counterexample, and the one piece of *captured*
 * evidence that the three envelope-less endpoints are real rather than a schema artefact.
 *
 * `RespWithdrawalDelay` has no `code` member, so this literal cannot grow one by accident.
 */
const withdrawalDelay = {
  "seconds": 1805
} satisfies RespWithdrawalDelay;

/* -------------------------------------------------------------------------------------------- */
/* Type-level assertions                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** Exact type equality, invariant in both directions — `Equal<string, any>` is `false`. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The keys of `T` that are **not** declared with `?:`. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** `true` when `T` declares no member named `K` at all — not "declares it optionally". */
type Lacks<T, K extends string> = K extends keyof T ? false : true;

/* Three endpoints return 200 with no `code` field (docs/protocol-notes.md §8). Two are in this
 * unit, plus the two root endpoints whose schemas likewise embed no envelope. A model that grows a
 * `code` here makes the transport's success rule — 2xx AND (code absent OR code === 200) — look
 * like a workaround instead of the rule. */
type _NoCodeOnWithdrawalDelay = Assert<Equal<Lacks<RespWithdrawalDelay, "code">, true>>;
type _NoCodeOnExecuteStats = Assert<Equal<Lacks<RespGetExecuteStats, "code">, true>>;
type _NoCodeOnReferralPoints = Assert<Equal<Lacks<ReferralPoints, "code">, true>>;
type _NoCodeOnStatus = Assert<Equal<Lacks<Status, "code">, true>>;
type _NoCodeOnL1Metadata = Assert<Equal<Lacks<L1Metadata, "code">, true>>;

/* …and nothing on those models is required either, because the Go server's `omitempty` omits every
 * zero-valued field (§9.2). */
type _WithdrawalDelayAllOptional = Assert<
  [RequiredKeys<RespWithdrawalDelay>] extends [never] ? true : false
>;
type _ExecuteStatsAllOptional = Assert<
  [RequiredKeys<RespGetExecuteStats>] extends [never] ? true : false
>;
type _ReferralPointsAllOptional = Assert<
  [RequiredKeys<ReferralPoints>] extends [never] ? true : false
>;

/* On every model that *does* carry the envelope, `code` is the one required key. */
type _OnlyCodeRequiredOnPartnerStats = Assert<Equal<RequiredKeys<PartnerStats>, "code">>;
type _OnlyCodeRequiredOnLeases = Assert<Equal<RequiredKeys<RespGetLeases>, "code">>;
type _OnlyCodeRequiredOnListRFQs = Assert<Equal<RequiredKeys<RespListRFQs>, "code">>;
type _OnlyCodeRequiredOnLayer1 = Assert<Equal<RequiredKeys<Layer1BasicInfo>, "code">>;
type _NothingRequiredOnNestedModels = Assert<
  [RequiredKeys<PublicPoolMetadata> | RequiredKeys<LeaseEntry>] extends [never] ? true : false
>;

/* The four single-entry RFQ envelopes are one type wearing four names (§10.1, family I). */
type _RFQCreateIsRespRFQ = Assert<Equal<RespCreateRFQ, RespRFQ>>;
type _RFQGetIsRespRFQ = Assert<Equal<RespGetRFQ, RespRFQ>>;
type _RFQUpdateIsRespRFQ = Assert<Equal<RespUpdateRFQ, RespRFQ>>;
type _RFQRespondIsRespRFQ = Assert<Equal<RespRespondToRFQ, RespRFQ>>;

/* `direction` is the string '0' | '1' on the request and a number on the response. */
type _RFQRequestDirectionIsString = Assert<Equal<ReqCreateRFQ["direction"], "0" | "1">>;
type _RFQResponseDirectionIsNumber = Assert<Equal<RespRFQ["direction"], number | undefined>>;

/* Money is a decimal string. This is the rule that costs real value when it is broken
 * (docs/decisions.md D7), so it is asserted rather than commented. */
type _AmountsAreStrings = Assert<
  Equal<
    | NonNullable<DepositHistoryItem["amount"]>
    | NonNullable<WithdrawHistoryItem["amount"]>
    | NonNullable<TransferHistoryItem["amount"]>
    | NonNullable<TransferHistoryItem["fee"]>
    | NonNullable<PublicPoolMetadata["total_asset_value"]>
    | NonNullable<PartnerStats["total_fees_earned"]>
    | NonNullable<RespRFQ["base_amount"]>,
    string
  >
>;

/* The LIT lease request carries raw units as a string; three fields, all required. */
type _LeaseAmountIsString = Assert<Equal<ReqLITLease["lease_amount"], string>>;
type _LeaseRequestRequired = Assert<
  Equal<RequiredKeys<ReqLITLease>, "tx_info" | "lease_amount" | "duration_days">
>;

/* Statistics are floats, and saying so is the point — a decimal string here would be a lie. */
type _SharePriceIsFloat = Assert<Equal<SharePrice["share_price"], number | undefined>>;

/* Timestamps that are seconds rather than milliseconds are still numbers; the aliases document the
 * unit, they do not brand it. Asserted so a future brand does not land unnoticed. */
type _AnnouncementSeconds = Assert<Equal<Announcement["created_at"], number | undefined>>;

/**
 * Keeps the assertions above reachable. They are types, so nothing at runtime references them; this
 * tuple makes a deletion show up as an unused-type diff rather than as silence.
 */
const expectTypes = [
  "no code: RespWithdrawalDelay, RespGetExecuteStats, ReferralPoints, Status, L1Metadata",
  "only code required on enveloped models",
  "four Resp*RFQ names, one type",
  "amounts are decimal strings",
] as const;

/* -------------------------------------------------------------------------------------------- */
/* Assertions                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Captured case → the literal above that the compiler checked against one of this unit's models. */
const asserted: Record<string, unknown> = {
  layer1BasicInfo,
  "withdrawalDelay-no-code-field": withdrawalDelay,
};

/**
 * Every other captured case, and the unit that types it. Listed so that adding a fixture forces a
 * decision here rather than silently belonging to nobody.
 */
const ownedElsewhere = [
  "orderBooks",
  "systemConfig",
  "nextNonce",
  "account",
  "orderBookOrders",
  "recentTrades",
  "candles",
  "assetDetails",
  "error-invalid-param",
  "error-not-found",
  "error-missing-auth",
  "error-geo-restricted",
];

describe("auxiliary REST fixture coverage", () => {
  test("every JSON file in test/fixtures/rest/ is accounted for", () => {
    expect(fixtureFiles).toEqual(["responses.json"]);
  });

  test("every captured case is either typed here or owned by the core models", () => {
    expect(Object.keys(captured.cases).sort()).toEqual(
      [...Object.keys(asserted), ...ownedElsewhere].sort(),
    );
  });

  test("the type-level assertions are still present", () => {
    expect(expectTypes).toHaveLength(4);
  });
});

describe("captured bodies match their auxiliary models", () => {
  for (const [name, literal] of Object.entries(asserted)) {
    test(`${name} literal is byte-identical to the captured body`, () => {
      const capturedCase = captured.cases[name];
      expect(capturedCase).toBeDefined();
      expect(literal).toEqual(capturedCase?.body);
    });
  }
});

describe("layer1BasicInfo", () => {
  test("l1_providers keys are camelCase, unlike every other key on the API", () => {
    const body = captured.cases["layer1BasicInfo"]?.body as Layer1BasicInfo;
    const provider = body.l1_providers?.[0];
    expect(provider).toBeDefined();
    expect(Object.keys(provider as object).sort()).toEqual([
      "chainId",
      "latestBlockNumber",
      "networkId",
    ]);
  });

  test("contract addresses are name/address pairs, not a map", () => {
    const body = captured.cases["layer1BasicInfo"]?.body as Layer1BasicInfo;
    expect(body.contract_addresses?.length).toBeGreaterThan(0);
    for (const entry of body.contract_addresses ?? []) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.address).toBe("string");
    }
    // An empty validator list is a live value, not a missing field: `[]` survives `omitempty`
    // for slices only when the server explicitly initialises them.
    expect(body.validator_info).toEqual([]);
  });

  test("the envelope is present here, so the two signals agree", () => {
    const body = captured.cases["layer1BasicInfo"]?.body as ResultCode;
    expect(captured.cases["layer1BasicInfo"]?.status).toBe(200);
    expect(body.code).toBe(200);
  });
});

describe("withdrawalDelay breaks the envelope", () => {
  test("the body is one key, and it is not `code`", () => {
    const c = captured.cases["withdrawalDelay-no-code-field"];
    expect(c?.status).toBe(200);
    expect(Object.keys(c?.body as object)).toEqual(["seconds"]);
    expect("code" in (c?.body as object)).toBe(false);
  });

  test("`seconds` is a duration in seconds, not a timestamp", () => {
    const body = captured.cases["withdrawalDelay-no-code-field"]?.body as RespWithdrawalDelay;
    expect(typeof body.seconds).toBe("number");
    // ~1805, i.e. half an hour. A timestamp would be ~1.7e9 or ~1.7e12.
    expect(body.seconds).toBeLessThan(1e6);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Mechanical rules on the source itself                                                          */
/* -------------------------------------------------------------------------------------------- */

describe("the auxiliary model files obey the packaging rules", () => {
  test("no Node built-in, no Buffer, no process, no require", () => {
    for (const name of OWNED_FILES) {
      const text = source[name] ?? "";
      expect(text).not.toContain('"node:');
      expect(text).not.toContain("Buffer");
      expect(text).not.toContain("process.");
      expect(text).not.toContain("require(");
    }
  });

  test("nothing runs: the files declare no value, so importing one is free", () => {
    for (const name of OWNED_FILES) {
      const text = source[name] ?? "";
      // `export const`, `export function` and `export enum` would each emit runtime code; `enum` is
      // additionally forbidden outright by `erasableSyntaxOnly`.
      expect(text).not.toMatch(/^export (const|function|class|enum|let|var) /m);
    }
  });

  test("pool.ts imports the account-embedded pool types instead of redeclaring them", () => {
    const text = source["pool.ts"] ?? "";
    for (const name of [
      "PublicPoolInfo",
      "PublicPoolShare",
      "PendingUnlock",
      "ApprovedIntegrator",
    ]) {
      expect(text).toMatch(new RegExp(`^\\s*${name},$`, "m"));
      expect(text).not.toMatch(new RegExp(`interface ${name}\\b`));
    }
    expect(text).toContain('from "./account.js"');
  });

  test("every relative import spells the .js extension", () => {
    for (const name of OWNED_FILES) {
      const text = source[name] ?? "";
      for (const match of text.matchAll(/from "(\.[^"]*)"/g)) {
        expect(match[1]?.endsWith(".js")).toBe(true);
      }
    }
  });
});
