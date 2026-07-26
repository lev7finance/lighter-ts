/**
 * `src/client/assets.ts`.
 *
 * The property under test is *scale fidelity*: an asset's `decimals` is the exponent every transfer
 * and withdrawal is scaled by, so a wrong or guessed value is a silent 10^n error on real money.
 * Three fields on the wire could each plausibly be "the decimals" (`decimals`, `l1_decimals`,
 * `price_decimals`), and the golden capture happens to disagree on all three for LDO — 8, 18 and 6 —
 * which makes it a genuine discriminator rather than a shape check.
 *
 * Everything asserted about a captured asset is read out of the fixture at run time, per the
 * fixture's own instruction to assert on shape rather than on live numbers. The one exception is the
 * seed table, which is a frozen historical constant and is asserted literally on purpose.
 */

import { describe, expect, test } from "bun:test";

import type { Diagnostic } from "../../src/config/config.js";
import type { AssetInfo, AssetSnapshot } from "../../src/client/assets.js";
import { ASSET_DECIMALS_SEED, AssetRegistry, toAssetInfo } from "../../src/client/assets.js";
import { LighterConfigError } from "../../src/errors.js";
import type { Asset, AssetDetails } from "../../src/models/market.js";
import {
  PATH_ASSET_DETAILS,
  fakeClock,
  fakeServer,
  goldenAssetDetails,
  jsonResponse,
  recordTimers,
} from "./harness.js";
import type { FakeServer } from "./harness.js";

function goldenAssets(): readonly Asset[] {
  const list: readonly Asset[] | undefined = goldenAssetDetails().asset_details;
  if (list === undefined || list.length === 0) throw new Error("assetDetails fixture has no assets");
  return list;
}

function goldenAsset(symbol: string): Asset {
  const found: Asset | undefined = goldenAssets().find((a: Asset): boolean => a.symbol === symbol);
  if (found === undefined) throw new Error(`no captured asset named ${symbol}`);
  return found;
}

interface Rig {
  readonly registry: AssetRegistry;
  readonly server: FakeServer;
  readonly diagnostics: Diagnostic[];
}

function rig(body: AssetDetails = goldenAssetDetails(), ttlMs: number = 300_000): Rig {
  const diagnostics: Diagnostic[] = [];
  const server: FakeServer = fakeServer({ [PATH_ASSET_DETAILS]: (): Response => jsonResponse(body) });
  const registry: AssetRegistry = new AssetRegistry({
    rest: server.client,
    ttlMs,
    onDiagnostic: (d: Diagnostic): void => {
      diagnostics.push(d);
    },
  });
  return { registry, server, diagnostics };
}

/* ---------------------------------------------------------------------------------------------- */

describe("toAssetInfo — the three decimal fields are not interchangeable", () => {
  test("LDO's decimals, l1_decimals and price_decimals land in three distinct places", () => {
    const raw: Asset = goldenAsset("LDO");
    const info: AssetInfo = toAssetInfo(raw);

    // The captured record disagrees on all three, which is the whole point of picking LDO.
    expect(raw.decimals).not.toBe(raw.l1_decimals);
    expect(raw.decimals).not.toBe(raw.price_decimals);

    expect(info.decimals).toBe(raw.decimals as number);
    expect(info.l1Decimals).toBe(raw.l1_decimals as number);
    expect(info.priceDecimals).toBe(raw.price_decimals as number);
  });

  test("monetary fields survive as the exact strings the wire sent", () => {
    const raw: Asset = goldenAsset("LDO");
    const info: AssetInfo = toAssetInfo(raw);
    expect(info.minTransferAmount).toBe(raw.min_transfer_amount as string);
    expect(info.minWithdrawalAmount).toBe(raw.min_withdrawal_amount as string);
    expect(info.indexPrice).toBe(raw.index_price as string);
    // Not re-normalised: trailing zeros carry the market's declared precision.
    expect(info.minTransferAmount).toBe("2.00000000");
  });

  test("`multiplier` is carried verbatim and folded into nothing (R21)", () => {
    const info: AssetInfo = toAssetInfo(goldenAsset("USDC"));
    expect(info.multiplier).toBe("1.000000000000000000");
  });

  test("a missing required field throws, naming the asset", () => {
    const raw: Asset = { ...goldenAsset("USDC") };
    delete (raw as { decimals?: number }).decimals;
    expect((): AssetInfo => toAssetInfo(raw)).toThrow(LighterConfigError);
    expect((): AssetInfo => toAssetInfo(raw)).toThrow(/asset 3: `decimals`/);
  });

  test("a monetary field that is not a plain decimal string throws rather than becoming NaN", () => {
    const raw: Asset = { ...goldenAsset("USDC"), min_transfer_amount: "1e6" };
    expect((): AssetInfo => toAssetInfo(raw)).toThrow(/not a plain decimal string/);
  });
});

describe("the seed table", () => {
  test("reproduces the reference's ids exactly, including the absence of 4", () => {
    expect(Object.keys(ASSET_DECIMALS_SEED).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(ASSET_DECIMALS_SEED[3]).toEqual({ symbol: "USDC", decimals: 6 });
    expect(ASSET_DECIMALS_SEED[1]).toEqual({ symbol: "ETH", decimals: 8 });
    expect(ASSET_DECIMALS_SEED[4]).toBeUndefined();
  });

  test("is frozen, so no consumer can edit the fallback out from under another", () => {
    expect(Object.isFrozen(ASSET_DECIMALS_SEED)).toBe(true);
    expect(Object.isFrozen(ASSET_DECIMALS_SEED[3])).toBe(true);
  });

  test("agrees with the golden capture for every captured asset", async () => {
    const { registry, diagnostics } = rig();
    await registry.load();
    const mismatches = diagnostics.filter((d: Diagnostic): boolean => d.event === "assets.seed_mismatch");
    expect(mismatches).toEqual([]);
  });

  test("a server value that disagrees emits exactly one diagnostic and the server wins", async () => {
    // USDC is seeded at 6. Serve 7 and nothing else changes.
    const body: AssetDetails = {
      code: 200,
      asset_details: goldenAssets().map((a: Asset): Asset => (a.symbol === "USDC" ? { ...a, decimals: 7 } : a)),
    };
    const { registry, diagnostics } = rig(body);
    await registry.load();

    const mismatches = diagnostics.filter((d: Diagnostic): boolean => d.event === "assets.seed_mismatch");
    expect(mismatches.length).toBe(1);
    expect(mismatches[0]?.detail).toEqual({ assetId: 3, symbol: "USDC", seeded: 6, fetched: 7 });
    expect(registry.get(3).decimals).toBe(7);
  });

  test("an asset the seed has never heard of resolves normally", async () => {
    // The reference raises "Unsupported asset id" here and breaks on every new listing.
    const invented: Asset = { ...goldenAsset("UNI"), asset_id: 42, symbol: "NEWCOIN", decimals: 12 };
    const { registry } = rig({ code: 200, asset_details: [...goldenAssets(), invented] });
    await registry.load();
    expect(registry.get(42).symbol).toBe("NEWCOIN");
    expect(registry.get("NEWCOIN").decimals).toBe(12);
  });

  test("decimalsFor falls back to the seed offline, and says so", () => {
    const seen: Diagnostic[] = [];
    const registry: AssetRegistry = new AssetRegistry({
      onDiagnostic: (d: Diagnostic): void => {
        seen.push(d);
      },
    });
    expect(registry.decimalsFor("usdc")).toBe(6);
    expect(registry.decimalsFor(1)).toBe(8);
    expect(registry.decimalsFor(4)).toBeUndefined();
    expect(seen.map((d: Diagnostic): string => d.event)).toEqual([
      "assets.seed_fallback",
      "assets.seed_fallback",
    ]);
  });

  test("decimalsFor prefers the loaded value over the seed and stays silent", async () => {
    const body: AssetDetails = {
      code: 200,
      asset_details: goldenAssets().map((a: Asset): Asset => (a.symbol === "USDC" ? { ...a, decimals: 7 } : a)),
    };
    const { registry, diagnostics } = rig(body);
    await registry.load();
    expect(registry.decimalsFor("USDC")).toBe(7);
    expect(diagnostics.filter((d: Diagnostic): boolean => d.event === "assets.seed_fallback")).toEqual([]);
  });
});

describe("lookup", () => {
  test("by id and by symbol, case-insensitively", async () => {
    const { registry } = rig();
    await registry.load();
    const usdc: Asset = goldenAsset("USDC");
    expect(registry.get(usdc.asset_id as number).symbol).toBe("USDC");
    expect(registry.get("usdc").assetId).toBe(usdc.asset_id as number);
    expect(registry.get("USDC")).toBe(registry.get(usdc.asset_id as number));
  });

  test("a miss throws; there is no guessed scale", async () => {
    const { registry } = rig();
    await registry.load();
    expect((): AssetInfo => registry.get("NOPE")).toThrow(LighterConfigError);
    expect((): AssetInfo => registry.get(9999)).toThrow(/unknown asset/);
    expect(registry.tryGet("NOPE")).toBeUndefined();
  });

  test("a miss before any load says so, rather than looking like an unlisted asset", () => {
    const { registry } = rig();
    expect((): AssetInfo => registry.get("USDC")).toThrow(/never been loaded/);
  });

  test("list() is ordered by assetId and frozen", async () => {
    const { registry } = rig();
    await registry.load();
    const ids: number[] = registry.list().map((a: AssetInfo): number => a.assetId);
    expect(ids).toEqual([...ids].sort((a: number, b: number): number => a - b));
    expect(Object.isFrozen(registry.list())).toBe(true);
  });
});

describe("load policy", () => {
  test("two overlapping loads issue exactly one request", async () => {
    const { registry, server } = rig();
    await Promise.all([registry.load(), registry.load()]);
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(1);
  });

  test("a second load inside the TTL is a no-op; force refetches", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: AssetRegistry = new AssetRegistry({ rest: server.client, ttlMs: 1000, now: clock.now });
    await registry.load();
    await registry.load();
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(1);

    await registry.load({ force: true });
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(2);

    clock.advance(1001);
    expect(registry.stale).toBe(true);
    await registry.load();
    expect(server.countOf(PATH_ASSET_DETAILS)).toBe(3);
    registry.stop();
  });

  test("a failed load clears the in-flight slot rather than wedging the registry", async () => {
    let fail: boolean = true;
    const server: FakeServer = fakeServer({
      [PATH_ASSET_DETAILS]: (): Response =>
        fail ? jsonResponse({ code: 20001, message: "nope" }, 400) : jsonResponse(goldenAssetDetails()),
    });
    // Constructed with no transport, then given one — the seam `LighterClient` uses.
    const registry: AssetRegistry = new AssetRegistry();
    registry.setTransport(server.client);
    await expect(registry.load()).rejects.toThrow();
    fail = false;
    await registry.load();
    expect(registry.list().length).toBe(goldenAssets().length);
  });

  test("load() without a transport throws a config error naming the fix", async () => {
    const registry: AssetRegistry = new AssetRegistry();
    await expect(registry.load()).rejects.toThrow(/setTransport/);
  });
});

describe("snapshot", () => {
  test("round-trips through JSON deep-equal, with no bigint and no undefined holes", async () => {
    const { registry } = rig();
    await registry.load();
    const snapshot: AssetSnapshot = registry.toSnapshot();
    const text: string = JSON.stringify(snapshot);
    const revived: AssetSnapshot = JSON.parse(text) as AssetSnapshot;
    expect(revived).toEqual(snapshot as unknown as AssetSnapshot);

    const restored: AssetRegistry = AssetRegistry.fromSnapshot(revived);
    expect(restored.list()).toEqual(registry.list() as AssetInfo[]);
    expect(restored.loadedAt).toBe(registry.loadedAt as number);
    // Same bytes out again: the snapshot is a fixed point.
    expect(JSON.stringify(restored.toSnapshot())).toBe(text);
  });

  test("fromSnapshot needs no transport and performs no I/O", () => {
    const snapshot: AssetSnapshot = {
      version: 1,
      loadedAt: null,
      assets: goldenAssets().map(toAssetInfo),
    };
    const restored: AssetRegistry = AssetRegistry.fromSnapshot(snapshot);
    expect(restored.get("USDC").decimals).toBe(goldenAsset("USDC").decimals as number);
    expect(restored.loadedAt).toBeUndefined();
  });

  test("an unknown snapshot version is refused rather than half-read", () => {
    const bad = { version: 2, loadedAt: null, assets: [] } as unknown as AssetSnapshot;
    expect((): AssetRegistry => AssetRegistry.fromSnapshot(bad)).toThrow(/unsupported version/);
  });
});

describe("disposal", () => {
  test("stop() leaves no timer scheduled", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: AssetRegistry = new AssetRegistry({ rest: server.client, ttlMs: 1000, now: clock.now });
    await registry.load();
    clock.advance(5000);

    recordTimers((log): void => {
      registry.get("USDC"); // stale read: serves the stale value and schedules a refresh
      expect(registry.refreshScheduled).toBe(true);
      expect(log.created.length).toBe(1);

      registry.stop();
      expect(registry.refreshScheduled).toBe(false);
      expect(log.outstanding()).toEqual([]);
    });

    // And no new one is scheduled after disposal.
    registry.get("USDC");
    expect(registry.refreshScheduled).toBe(false);
  });

  test("a stale read never blocks and never throws", async () => {
    const clock = fakeClock();
    const server: FakeServer = fakeServer({
      [PATH_ASSET_DETAILS]: (): Response => jsonResponse(goldenAssetDetails()),
    });
    const registry: AssetRegistry = new AssetRegistry({ rest: server.client, ttlMs: 1, now: clock.now });
    await registry.load();
    clock.advance(1000);
    expect(registry.stale).toBe(true);
    expect(registry.get("USDC").symbol).toBe("USDC"); // the stale value, synchronously
    registry.stop();
  });
});
