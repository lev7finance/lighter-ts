/**
 * `src/client/system-config.ts`.
 *
 * The interesting property is the `int64` boundary. `liquidity_pool_index` is already
 * `281474976710654` in the golden capture — 2^48−2 — and it is a transaction field, so the question
 * "what happens when this value stops fitting in a double?" is not hypothetical. The answer must be
 * a loud error, because by the time the value reaches this module `JSON.parse` has already rounded
 * it and there is nothing left to recover.
 *
 * Evidence is the captured `systemConfig` body in `test/fixtures/rest/responses.json`, which the
 * capture script did not truncate.
 */

import { describe, expect, test } from "bun:test";

import type { SystemConfigInfo, SystemConfigSnapshot } from "../../src/client/system-config.js";
import { SystemConfigCache, toSystemConfigInfo } from "../../src/client/system-config.js";
import { LighterConfigError } from "../../src/errors.js";
import type { SystemConfig } from "../../src/models/market.js";
import {
  PATH_SYSTEM_CONFIG,
  fakeClock,
  fakeServer,
  goldenSystemConfig,
  jsonResponse,
  recordTimers,
} from "./harness.js";
import type { FakeServer } from "./harness.js";

function rig(body: SystemConfig = goldenSystemConfig(), ttlMs: number = 300_000): {
  readonly cache: SystemConfigCache;
  readonly server: FakeServer;
} {
  const server: FakeServer = fakeServer({ [PATH_SYSTEM_CONFIG]: (): Response => jsonResponse(body) });
  return { cache: new SystemConfigCache({ rest: server.client, ttlMs }), server };
}

/* ---------------------------------------------------------------------------------------------- */

describe("toSystemConfigInfo", () => {
  test("the four account indexes come out as bigint, exactly", () => {
    const raw: SystemConfig = goldenSystemConfig();
    const info: SystemConfigInfo = toSystemConfigInfo(raw);
    expect(typeof info.liquidityPoolIndex).toBe("bigint");
    expect(info.liquidityPoolIndex).toBe(BigInt(raw.liquidity_pool_index as number));
    expect(info.stakingPoolIndex).toBe(BigInt(raw.staking_pool_index as number));
    expect(info.fundingFeeRebateAccountIndex).toBe(BigInt(raw.funding_fee_rebate_account_index as number));
    expect(info.marketMakerIncentiveAccountIndex).toBe(BigInt(raw.market_maker_incentive_account_index as number));
    // The captured liquidity pool index is 2^48−2; the value is already well past a u32.
    expect(info.liquidityPoolIndex).toBe(281474976710654n);
  });

  test("the cooldown and lockup periods are milliseconds, unconverted", () => {
    const raw: SystemConfig = goldenSystemConfig();
    const info: SystemConfigInfo = toSystemConfigInfo(raw);
    expect(info.liquidityPoolCooldownPeriodMs).toBe(raw.liquidity_pool_cooldown_period as number);
    expect(info.stakingPoolLockupPeriodMs).toBe(raw.staking_pool_lockup_period as number);
  });

  test("the four integrator caps are fee ticks, carried as integers", () => {
    const raw: SystemConfig = goldenSystemConfig();
    const info: SystemConfigInfo = toSystemConfigInfo(raw);
    expect(info.maxIntegratorPerpsMakerFeeTicks).toBe(raw.max_integrator_perps_maker_fee as number);
    expect(info.maxIntegratorPerpsTakerFeeTicks).toBe(raw.max_integrator_perps_taker_fee as number);
    expect(info.maxIntegratorSpotMakerFeeTicks).toBe(raw.max_integrator_spot_maker_fee as number);
    expect(info.maxIntegratorSpotTakerFeeTicks).toBe(raw.max_integrator_spot_taker_fee as number);
    // Ticks, not a fraction: 1000 ticks over FeeTick = 1e6 is 0.1%. Nothing here divides.
    expect(Number.isInteger(info.maxIntegratorPerpsTakerFeeTicks)).toBe(true);
  });

  test("an index past MAX_SAFE_INTEGER is refused, not laundered into a bigint", () => {
    const raw: SystemConfig = { ...goldenSystemConfig(), staking_pool_index: 2 ** 53 };
    expect((): SystemConfigInfo => toSystemConfigInfo(raw)).toThrow(LighterConfigError);
    expect((): SystemConfigInfo => toSystemConfigInfo(raw)).toThrow(/MAX_SAFE_INTEGER/);
  });

  test("a missing field throws rather than defaulting to zero", () => {
    const raw: SystemConfig = { ...goldenSystemConfig() };
    delete (raw as { staking_pool_index?: number }).staking_pool_index;
    expect((): SystemConfigInfo => toSystemConfigInfo(raw)).toThrow(/`staking_pool_index`/);
  });
});

describe("load policy", () => {
  test("two overlapping loads issue exactly one request", async () => {
    const { cache, server } = rig();
    await Promise.all([cache.load(), cache.load()]);
    expect(server.countOf(PATH_SYSTEM_CONFIG)).toBe(1);
    expect(cache.get().liquidityPoolIndex).toBe(281474976710654n);
  });

  test("a second load inside the TTL is a no-op; force refetches", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_SYSTEM_CONFIG]: (): Response => jsonResponse(goldenSystemConfig()),
    });
    const cache: SystemConfigCache = new SystemConfigCache({ rest: server.client, ttlMs: 1000, now: clock.now });
    await cache.load();
    await cache.load();
    expect(server.countOf(PATH_SYSTEM_CONFIG)).toBe(1);
    await cache.load({ force: true });
    expect(server.countOf(PATH_SYSTEM_CONFIG)).toBe(2);
    clock.advance(1001);
    await cache.load();
    expect(server.countOf(PATH_SYSTEM_CONFIG)).toBe(3);
    cache.stop();
  });

  test("get() before any load throws; there is no default pool index", () => {
    const { cache } = rig();
    expect((): SystemConfigInfo => cache.get()).toThrow(/has not been loaded/);
    expect(cache.tryGet()).toBeUndefined();
  });

  test("load() without a transport throws a config error naming the fix", async () => {
    const cache: SystemConfigCache = new SystemConfigCache();
    await expect(cache.load()).rejects.toThrow(/setTransport/);
  });
});

describe("snapshot", () => {
  test("round-trips through JSON — the bigints survive as decimal strings", async () => {
    const { cache } = rig();
    await cache.load();
    const snapshot: SystemConfigSnapshot = cache.toSnapshot();
    // `JSON.stringify` throws on a bigint, so this line is itself the assertion that none escaped.
    const text: string = JSON.stringify(snapshot);
    expect(text).toContain('"281474976710654"');
    const revived: SystemConfigSnapshot = JSON.parse(text) as SystemConfigSnapshot;
    expect(revived).toEqual(snapshot as unknown as SystemConfigSnapshot);

    const restored: SystemConfigCache = SystemConfigCache.fromSnapshot(revived);
    expect(restored.get()).toEqual(cache.get());
    expect(restored.get().liquidityPoolIndex).toBe(281474976710654n);
    expect(JSON.stringify(restored.toSnapshot())).toBe(text);
  });

  test("fromSnapshot needs no transport and performs no I/O", () => {
    const built: SystemConfigCache = SystemConfigCache.fromSnapshot({
      version: 1,
      loadedAt: null,
      config: null,
    });
    expect(built).toBeInstanceOf(SystemConfigCache);
    expect(built.tryGet()).toBeUndefined();
  });

  test("an unknown snapshot version is refused rather than half-read", () => {
    const bad = { version: 3, loadedAt: null, config: null } as unknown as SystemConfigSnapshot;
    expect((): SystemConfigCache => SystemConfigCache.fromSnapshot(bad)).toThrow(/unsupported version/);
  });
});

describe("disposal", () => {
  test("stop() leaves no timer scheduled", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_SYSTEM_CONFIG]: (): Response => jsonResponse(goldenSystemConfig()),
    });
    const cache: SystemConfigCache = new SystemConfigCache({ rest: server.client, ttlMs: 1000, now: clock.now });
    await cache.load();
    clock.advance(5000);

    recordTimers((log): void => {
      expect(cache.get().liquidityPoolIndex).toBe(281474976710654n); // stale read, served synchronously
      expect(cache.refreshScheduled).toBe(true);
      expect(log.created.length).toBe(1);

      cache.stop();
      expect(cache.refreshScheduled).toBe(false);
      expect(log.outstanding()).toEqual([]);
    });

    cache.get();
    expect(cache.refreshScheduled).toBe(false);
  });
});
