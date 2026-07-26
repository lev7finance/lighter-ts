/**
 * Fakes shared by the nine `src/client/write/` test files.
 *
 * The seam is the **network and nothing else**: every test drives a real `LighterClient`, a real
 * `LighterAccount`, the real nonce path, the real transaction codec and the real serialiser over an
 * injected `fetch`. So an assertion about a `tx_info` document is an assertion about the bytes that
 * would have gone to the sequencer, not about a mock's opinion of them.
 *
 * Two consequences worth stating:
 *
 * - Every request the write path makes is recorded, in order, in {@link Harness.calls}. The
 *   fast-withdraw acceptance test is entirely a statement about that list.
 * - Asset metadata comes from `test/fixtures/rest/responses.json` — a real capture — so `USDC` has
 *   the exponent the exchange actually publishes rather than one written into a test. ETH is absent
 *   from the capture, which is useful: it exercises the offline seed fallback on the same path.
 */

import { readFileSync } from "node:fs";

import { LighterClient } from "../../../src/client/lighter-client.js";
import type { LighterAccount } from "../../../src/client/account.js";
import { AssetRegistry, toAssetInfo } from "../../../src/client/assets.js";
import type { AssetInfo } from "../../../src/client/assets.js";
import { SystemConfigCache, toSystemConfigInfo } from "../../../src/client/system-config.js";
import type { Asset, AssetDetails, SystemConfig } from "../../../src/models/market.js";
import type { EthPersonalSigner } from "../../../src/tx/l1/signer.js";
import type {
  AuthTokenProvider,
  FastWithdrawContext,
} from "../../../src/client/write/fast-withdraw.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

interface FixtureCase {
  readonly request: { readonly path: string };
  readonly status: number;
  readonly body: unknown;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../fixtures/rest/responses.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, FixtureCase> };

function fixtureBody(name: string): unknown {
  const found: FixtureCase | undefined = fixtures.cases[name];
  if (found === undefined) throw new Error(`no fixture named ${name}`);
  return found.body;
}

/** The captured `/assetDetails` body: LDO (8 decimals), USDC (6), UNI (8). */
export function goldenAssets(): readonly AssetInfo[] {
  const body: AssetDetails = fixtureBody("assetDetails") as AssetDetails;
  return (body.asset_details ?? []).map((a: Asset): AssetInfo => toAssetInfo(a));
}

/** `conformance/vectors/tx.json`'s signing key, recovered in `test/tx/pipeline.test.ts`. */
export const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

/** The vectors' chain id: mainnet. */
export const CHAIN_ID: 304 = 304;

/** A fixed `ExpiredAt`, so no test depends on a clock. */
export const EXPIRED_AT: bigint = 1_893_456_000_000n;

/** A syntactically valid 65-byte signature. No key produced it; nothing here verifies one. */
export const FAKE_L1_SIG: `0x${string}` = `0x${"ab".repeat(64)}1b`;

/** A plausible auth token. Every test that can leak one asserts this string does not appear. */
export const FAKE_AUTH_TOKEN: string = "1750000000:1:253:0123456789abcdef";

/* ---------------------------------------------------------------------------------------------- */
/* The transport fake                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** One recorded request. */
export interface Call {
  readonly method: string;
  /** Path only — the query string is kept separately so an auth token cannot hide in an assertion. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly url: string;
  readonly body: string;
  readonly authHeader: string | undefined;
}

/** What a route handler returns. */
export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

/** `path → handler`. Overrides are merged over {@link defaultRoutes}. */
export type Routes = Record<string, (call: Call, index: number) => Answer>;

/** The responses every harness starts with. Each one is overridable per test. */
export function defaultRoutes(accountIndex: bigint): Routes {
  const index: number = parseInt(accountIndex.toString(10), 10);
  return {
    "/api/v1/nextNonce": (): Answer => ({ body: { code: 200, nonce: 7 } }),
    "/api/v1/sendTx": (): Answer => ({
      body: { code: 200, predicted_execution_time_ms: 0, volume_quota_remaining: 0 },
    }),
    "/api/v1/account": (): Answer => ({
      body: {
        code: 200,
        accounts: [{ index, account_index: index, l1_address: OWNER_ADDRESS }],
      },
    }),
    "/api/v1/accountsByL1Address": (): Answer => ({
      body: {
        code: 200,
        l1_address: OWNER_ADDRESS,
        sub_accounts: [{ index }, { index: SIBLING_ACCOUNT_INDEX }],
      },
    }),
    "/api/v1/transferFeeInfo": (): Answer => ({ body: { code: 200, transfer_fee_usdc: 10_000 } }),
    "/api/v1/fastwithdraw/info": (): Answer => ({
      body: {
        code: 200,
        to_account_index: FASTWITHDRAW_POOL_INDEX,
        withdraw_limit: "100000.000000",
        max_withdrawal_amount: "50000.000000",
      },
    }),
    "/api/v1/fastwithdraw": (): Answer => ({ body: { code: 200 } }),
  };
}

/** The L1 address every account in the harness reports. */
export const OWNER_ADDRESS: string = "0x1111111111111111111111111111111111111111";

/** A second account under {@link OWNER_ADDRESS} — the same-master destination. */
export const SIBLING_ACCOUNT_INDEX: 5 = 5;

/** An account under nobody the harness knows about — the cross-owner destination. */
export const STRANGER_ACCOUNT_INDEX: 2 = 2;

/** The bridge pool `fastwithdraw/info` reports. */
export const FASTWITHDRAW_POOL_INDEX: 999 = 999;

/* ---------------------------------------------------------------------------------------------- */
/* The harness                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** What {@link harness} hands back. */
export interface Harness {
  readonly client: LighterClient;
  readonly account: LighterAccount;
  /** A context wide enough for every function in the directory, including fast withdrawal. */
  readonly ctx: FastWithdrawContext;
  /** Every request, in order. */
  readonly calls: Call[];
  /** Paths only, in order — what most call-sequence assertions want. */
  paths(): readonly string[];
  /** The `tx_info` field of the nth `POST /api/v1/sendTx`, parsed. */
  submitted(n?: number): Record<string, unknown>;
  readonly assets: AssetRegistry;
}

/** Options for {@link harness}. */
export interface HarnessOptions {
  readonly accountIndex?: bigint;
  readonly l1Signer?: EthPersonalSigner;
  readonly routes?: Routes;
  readonly authToken?: AuthTokenProvider;
  /** Seed the system-config cache, for the integrator fee-cap check. */
  readonly systemConfig?: SystemConfig;
  /** Leave the asset registry empty, so every lookup falls through to the offline seed. */
  readonly noAssets?: boolean;
}

/** Build a client, an account and a write context over an injected `fetch`. */
export function harness(o: HarnessOptions = {}): Harness {
  const accountIndex: bigint = o.accountIndex ?? 1n;
  const calls: Call[] = [];
  const routes: Routes = { ...defaultRoutes(accountIndex), ...o.routes };

  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url: URL = new URL(String(input));
    const headers: Record<string, string> = (init?.headers ?? {}) as Record<string, string>;
    const authHeader: string | undefined = Object.entries(headers).find(
      ([name]: [string, string]): boolean => name.toLowerCase() === "authorization",
    )?.[1];
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      url: url.toString(),
      body: typeof init?.body === "string" ? init.body : "",
      ...(authHeader === undefined ? {} : { authHeader }),
    } as Call;
    calls.push(call);
    const handler: ((call: Call, index: number) => Answer) | undefined = routes[url.pathname];
    if (handler === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 29404, message: "no fake route" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const answer: Answer = handler(call, calls.length - 1);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const client: LighterClient = new LighterClient({
    endpoint: "mainnet",
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    // `transferFeeInfo` is an authenticated read, so a client that does cross-owner transfers has
    // to carry a token. It rides on the `Authorization` header, never the query string.
    auth: FAKE_AUTH_TOKEN,
  });
  const account: LighterAccount = client.account({
    accountIndex,
    keys: { 0: KEY_HEX },
    ...(o.l1Signer === undefined ? {} : { l1Signer: o.l1Signer }),
  });

  const assets: AssetRegistry = new AssetRegistry();
  if (o.noAssets !== true) {
    assets.restore({ version: 1, loadedAt: Date.now(), assets: goldenAssets() });
  }

  const systemConfig: SystemConfigCache = new SystemConfigCache();
  if (o.systemConfig !== undefined) {
    // `restore` takes the JSON snapshot shape; going through `toSystemConfigInfo` first keeps the
    // fixture in wire form, which is what a caller would actually have.
    systemConfig.restore({
      version: 1,
      loadedAt: Date.now(),
      config: {
        liquidityPoolIndex: toSystemConfigInfo(o.systemConfig).liquidityPoolIndex.toString(),
        stakingPoolIndex: toSystemConfigInfo(o.systemConfig).stakingPoolIndex.toString(),
        fundingFeeRebateAccountIndex: toSystemConfigInfo(
          o.systemConfig,
        ).fundingFeeRebateAccountIndex.toString(),
        marketMakerIncentiveAccountIndex: toSystemConfigInfo(
          o.systemConfig,
        ).marketMakerIncentiveAccountIndex.toString(),
        liquidityPoolCooldownPeriodMs: toSystemConfigInfo(o.systemConfig)
          .liquidityPoolCooldownPeriodMs,
        stakingPoolLockupPeriodMs: toSystemConfigInfo(o.systemConfig).stakingPoolLockupPeriodMs,
        maxIntegratorPerpsMakerFeeTicks: toSystemConfigInfo(o.systemConfig)
          .maxIntegratorPerpsMakerFeeTicks,
        maxIntegratorPerpsTakerFeeTicks: toSystemConfigInfo(o.systemConfig)
          .maxIntegratorPerpsTakerFeeTicks,
        maxIntegratorSpotMakerFeeTicks: toSystemConfigInfo(o.systemConfig)
          .maxIntegratorSpotMakerFeeTicks,
        maxIntegratorSpotTakerFeeTicks: toSystemConfigInfo(o.systemConfig)
          .maxIntegratorSpotTakerFeeTicks,
      },
    });
  }

  const ctx: FastWithdrawContext = {
    account,
    chainId: CHAIN_ID,
    rest: client.rest,
    assets,
    systemConfig,
    authToken: o.authToken ?? ((): string => FAKE_AUTH_TOKEN),
  };

  return {
    client,
    account,
    ctx,
    calls,
    assets,
    paths: (): readonly string[] => calls.map((c: Call): string => c.path),
    submitted: (n: number = 0): Record<string, unknown> => {
      const posts: Call[] = calls.filter((c: Call): boolean => c.path === "/api/v1/sendTx");
      const call: Call | undefined = posts[n];
      if (call === undefined) throw new Error(`no sendTx call at index ${String(n)}`);
      const info: string | null = new URLSearchParams(call.body).get("tx_info");
      if (info === null) throw new Error("sendTx body carried no tx_info");
      return JSON.parse(info) as Record<string, unknown>;
    },
  };
}

/** A signer that records what it was asked to sign and returns a fixed signature. */
export function recordingSigner(sig: `0x${string}` = FAKE_L1_SIG): {
  signer: EthPersonalSigner;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    messages,
    signer: {
      signMessage: (message: string): Promise<`0x${string}`> => {
        messages.push(message);
        return Promise.resolve(sig);
      },
    },
  };
}

/** The `l1Messages` row named `name`, from the conformance vectors. */
export function l1MessageVector(name: string): {
  readonly name: string;
  readonly fields: Record<string, string>;
  readonly body: string;
} {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../conformance/vectors/tx.json", import.meta.url),
      "utf8",
    ),
  ) as {
    l1Messages: readonly { name: string; fields: Record<string, string>; body: string }[];
  };
  const row = vectors.l1Messages.find((r: { name: string }): boolean => r.name === name);
  if (row === undefined) throw new Error(`no l1Messages vector named ${name}`);
  return row;
}
