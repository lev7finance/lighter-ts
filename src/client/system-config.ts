/**
 * Exchange-wide constants from `GET /api/v1/systemConfig`, cached on the instance.
 *
 * Small, quasi-static, and needed before any pool, staking or integrator flow can be built: the
 * pool indexes are transaction fields, and the four `max_integrator_*_fee` caps bound what
 * `approve_integrator` may ask for.
 *
 * Two things are deliberate here:
 *
 * 1. **The account and pool indexes are `bigint`.** They are `int64` in the protocol — the live
 *    values already sit at `281474976710654` (2^48−2) — and every transaction field that consumes
 *    them is a `U64`/`I64` in `src/tx/brands.ts`. Handing a `number` to the codec puts a
 *    float-shaped value on the signing path, which is the class of defect `docs/decisions.md` D7
 *    exists to stop. Anything above `Number.MAX_SAFE_INTEGER` is rejected loudly rather than
 *    quietly widened, because by then `JSON.parse` has already lost the digits.
 * 2. **The fee caps stay integers.** They are fee *ticks* (`FeeTick = 1_000_000`, so
 *    `value / 1e6` is the fraction), typed `U32` by the transaction codec. They are counts, not
 *    money, and converting them to a decimal here would invent a precision the wire does not have.
 *
 * Same load/TTL/snapshot policy as `./markets.ts`: idempotent concurrency-safe `load()`, a TTL that
 * never blocks a read, background refresh via `setTimeout` only, and `stop()` leaves no timer.
 *
 * No module-level mutable state (`docs/decisions.md` D8). Importing this module performs no I/O,
 * schedules no timer and reads no clock.
 */

import type { Diagnostic } from "../config/config.js";
import { LighterConfigError } from "../errors.js";
import type { SystemConfig } from "../models/market.js";
import type { CallOptions, LighterRestClient } from "../rest/client.js";
import type { LoadOptions, RegistryOptions } from "./assets.js";
import { DEFAULT_METADATA_TTL_MS } from "./assets.js";

/* -------------------------------------------------------------------------------------------- */
/* Shapes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `/api/v1/systemConfig`, normalised. */
export interface SystemConfigInfo {
  /** `int64`. The public liquidity pool's account index. */
  readonly liquidityPoolIndex: bigint;
  /** `int64`. */
  readonly stakingPoolIndex: bigint;
  /** `int64`. */
  readonly fundingFeeRebateAccountIndex: bigint;
  /** `int64`. */
  readonly marketMakerIncentiveAccountIndex: bigint;
  /** Milliseconds. */
  readonly liquidityPoolCooldownPeriodMs: number;
  /** Milliseconds. */
  readonly stakingPoolLockupPeriodMs: number;
  /** Fee **ticks** (`U32`), not a decimal: `value / 1_000_000` is the fraction. */
  readonly maxIntegratorPerpsMakerFeeTicks: number;
  /** Fee **ticks** (`U32`). */
  readonly maxIntegratorPerpsTakerFeeTicks: number;
  /** Fee **ticks** (`U32`). */
  readonly maxIntegratorSpotMakerFeeTicks: number;
  /** Fee **ticks** (`U32`). */
  readonly maxIntegratorSpotTakerFeeTicks: number;
}

/**
 * {@link SystemConfigInfo} with the `int64` indexes as decimal **strings**.
 *
 * `JSON.stringify` throws on `bigint`, so the JSON-safe snapshot cannot hold one. Strings, not
 * numbers: round-tripping a 64-bit index through a double is exactly the loss this whole layer is
 * built to avoid.
 */
export interface SystemConfigJson {
  readonly liquidityPoolIndex: string;
  readonly stakingPoolIndex: string;
  readonly fundingFeeRebateAccountIndex: string;
  readonly marketMakerIncentiveAccountIndex: string;
  readonly liquidityPoolCooldownPeriodMs: number;
  readonly stakingPoolLockupPeriodMs: number;
  readonly maxIntegratorPerpsMakerFeeTicks: number;
  readonly maxIntegratorPerpsTakerFeeTicks: number;
  readonly maxIntegratorSpotMakerFeeTicks: number;
  readonly maxIntegratorSpotTakerFeeTicks: number;
}

/** A serialisable {@link SystemConfigCache}. JSON-safe: no `bigint`, no `undefined` holes. */
export interface SystemConfigSnapshot {
  readonly version: 1;
  /** Epoch milliseconds, or `null` when never populated from the wire. */
  readonly loadedAt: number | null;
  readonly config: SystemConfigJson | null;
}

/* -------------------------------------------------------------------------------------------- */
/* Ingest                                                                                         */
/* -------------------------------------------------------------------------------------------- */

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  return String(v);
}

/** A required non-negative integer count. */
function requireCount(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new LighterConfigError(`systemConfig: \`${field}\` is missing or not a non-negative integer (${describe(v)})`);
  }
  return v;
}

/**
 * A required `int64` index, as `bigint`.
 *
 * A JSON number beyond `Number.MAX_SAFE_INTEGER` has already been rounded by the parser, so
 * widening it to `bigint` would launder a wrong value into the signing path. That case throws.
 */
function requireIndex(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    if (!/^-?[0-9]+$/.test(v)) {
      throw new LighterConfigError(`systemConfig: \`${field}\` is not an integer string (${describe(v)})`);
    }
    return BigInt(v);
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new LighterConfigError(`systemConfig: \`${field}\` is missing or not an integer (${describe(v)})`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new LighterConfigError(
      `systemConfig: \`${field}\` (${String(v)}) exceeds Number.MAX_SAFE_INTEGER — the JSON parser has already lost digits`,
    );
  }
  return BigInt(v);
}

/** Normalise the wire body. Throws {@link LighterConfigError} on any missing or malformed field. */
export function toSystemConfigInfo(raw: SystemConfig): SystemConfigInfo {
  if (raw === null || typeof raw !== "object") {
    throw new LighterConfigError("systemConfig: response is not an object");
  }
  return Object.freeze({
    liquidityPoolIndex: requireIndex(raw.liquidity_pool_index, "liquidity_pool_index"),
    stakingPoolIndex: requireIndex(raw.staking_pool_index, "staking_pool_index"),
    fundingFeeRebateAccountIndex: requireIndex(
      raw.funding_fee_rebate_account_index,
      "funding_fee_rebate_account_index",
    ),
    marketMakerIncentiveAccountIndex: requireIndex(
      raw.market_maker_incentive_account_index,
      "market_maker_incentive_account_index",
    ),
    liquidityPoolCooldownPeriodMs: requireCount(raw.liquidity_pool_cooldown_period, "liquidity_pool_cooldown_period"),
    stakingPoolLockupPeriodMs: requireCount(raw.staking_pool_lockup_period, "staking_pool_lockup_period"),
    maxIntegratorPerpsMakerFeeTicks: requireCount(raw.max_integrator_perps_maker_fee, "max_integrator_perps_maker_fee"),
    maxIntegratorPerpsTakerFeeTicks: requireCount(raw.max_integrator_perps_taker_fee, "max_integrator_perps_taker_fee"),
    maxIntegratorSpotMakerFeeTicks: requireCount(raw.max_integrator_spot_maker_fee, "max_integrator_spot_maker_fee"),
    maxIntegratorSpotTakerFeeTicks: requireCount(raw.max_integrator_spot_taker_fee, "max_integrator_spot_taker_fee"),
  });
}

/** {@link SystemConfigInfo} → its JSON-safe twin. */
export function toSystemConfigJson(info: SystemConfigInfo): SystemConfigJson {
  return Object.freeze({
    liquidityPoolIndex: info.liquidityPoolIndex.toString(),
    stakingPoolIndex: info.stakingPoolIndex.toString(),
    fundingFeeRebateAccountIndex: info.fundingFeeRebateAccountIndex.toString(),
    marketMakerIncentiveAccountIndex: info.marketMakerIncentiveAccountIndex.toString(),
    liquidityPoolCooldownPeriodMs: info.liquidityPoolCooldownPeriodMs,
    stakingPoolLockupPeriodMs: info.stakingPoolLockupPeriodMs,
    maxIntegratorPerpsMakerFeeTicks: info.maxIntegratorPerpsMakerFeeTicks,
    maxIntegratorPerpsTakerFeeTicks: info.maxIntegratorPerpsTakerFeeTicks,
    maxIntegratorSpotMakerFeeTicks: info.maxIntegratorSpotMakerFeeTicks,
    maxIntegratorSpotTakerFeeTicks: info.maxIntegratorSpotTakerFeeTicks,
  });
}

/** The JSON-safe twin → {@link SystemConfigInfo}. Inverse of {@link toSystemConfigJson}. */
export function fromSystemConfigJson(json: SystemConfigJson): SystemConfigInfo {
  if (json === null || typeof json !== "object") {
    throw new LighterConfigError("systemConfig snapshot: `config` is not an object");
  }
  return Object.freeze({
    liquidityPoolIndex: requireIndex(json.liquidityPoolIndex, "liquidityPoolIndex"),
    stakingPoolIndex: requireIndex(json.stakingPoolIndex, "stakingPoolIndex"),
    fundingFeeRebateAccountIndex: requireIndex(json.fundingFeeRebateAccountIndex, "fundingFeeRebateAccountIndex"),
    marketMakerIncentiveAccountIndex: requireIndex(
      json.marketMakerIncentiveAccountIndex,
      "marketMakerIncentiveAccountIndex",
    ),
    liquidityPoolCooldownPeriodMs: requireCount(json.liquidityPoolCooldownPeriodMs, "liquidityPoolCooldownPeriodMs"),
    stakingPoolLockupPeriodMs: requireCount(json.stakingPoolLockupPeriodMs, "stakingPoolLockupPeriodMs"),
    maxIntegratorPerpsMakerFeeTicks: requireCount(json.maxIntegratorPerpsMakerFeeTicks, "maxIntegratorPerpsMakerFeeTicks"),
    maxIntegratorPerpsTakerFeeTicks: requireCount(json.maxIntegratorPerpsTakerFeeTicks, "maxIntegratorPerpsTakerFeeTicks"),
    maxIntegratorSpotMakerFeeTicks: requireCount(json.maxIntegratorSpotMakerFeeTicks, "maxIntegratorSpotMakerFeeTicks"),
    maxIntegratorSpotTakerFeeTicks: requireCount(json.maxIntegratorSpotTakerFeeTicks, "maxIntegratorSpotTakerFeeTicks"),
  });
}

/* -------------------------------------------------------------------------------------------- */
/* The cache                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * A one-value cache over `/api/v1/systemConfig`, with the same lifetime rules as the market and
 * asset registries.
 */
export class SystemConfigCache {
  #rest: LighterRestClient | undefined;
  readonly #ttlMs: number;
  readonly #nowFn: (() => number) | undefined;
  readonly #sink: ((d: Diagnostic) => void) | undefined;

  #value: SystemConfigInfo | undefined;
  #loadedAt: number | undefined;

  #inflight: Promise<void> | undefined;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #stopped: boolean = false;

  constructor(opts?: RegistryOptions) {
    this.#rest = opts?.rest;
    this.#ttlMs = opts?.ttlMs ?? DEFAULT_METADATA_TTL_MS;
    this.#nowFn = opts?.now;
    this.#sink = opts?.onDiagnostic;
  }

  /** Synchronous, zero I/O, no transport required. Safe at Cloudflare Worker module scope. */
  static fromSnapshot(snapshot: SystemConfigSnapshot, opts?: RegistryOptions): SystemConfigCache {
    const cache: SystemConfigCache = new SystemConfigCache(opts);
    cache.restore(snapshot);
    return cache;
  }

  /** Adopt a snapshot into an existing cache. */
  restore(snapshot: SystemConfigSnapshot): void {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new LighterConfigError("systemConfig snapshot: not an object");
    }
    if (snapshot.version !== 1) {
      throw new LighterConfigError(
        `systemConfig snapshot: unsupported version ${describe(snapshot.version)} (expected 1)`,
      );
    }
    this.#value = snapshot.config === null ? undefined : fromSystemConfigJson(snapshot.config);
    this.#loadedAt = typeof snapshot.loadedAt === "number" ? snapshot.loadedAt : undefined;
  }

  /** Attach a transport after construction. */
  setTransport(rest: LighterRestClient): void {
    this.#rest = rest;
  }

  /** JSON-safe and versioned. Survives `JSON.parse(JSON.stringify(...))` unchanged. */
  toSnapshot(): SystemConfigSnapshot {
    return Object.freeze({
      version: 1 as const,
      loadedAt: this.#loadedAt ?? null,
      config: this.#value === undefined ? null : toSystemConfigJson(this.#value),
    });
  }

  /** Epoch milliseconds of the last successful load, or `undefined`. */
  get loadedAt(): number | undefined {
    return this.#loadedAt;
  }

  /** `true` before the first load, and once `now() - loadedAt > ttlMs`. */
  get stale(): boolean {
    if (this.#loadedAt === undefined) return true;
    return this.#now() - this.#loadedAt > this.#ttlMs;
  }

  /** `true` while a background refresh timer is pending. Test seam and disposal check. */
  get refreshScheduled(): boolean {
    return this.#timer !== undefined;
  }

  /** Idempotent and concurrency-safe: overlapping calls share one in-flight request. */
  load(opts?: LoadOptions): Promise<void> {
    if (opts?.force !== true && this.#loadedAt !== undefined && !this.stale) return Promise.resolve();
    if (this.#inflight !== undefined) return this.#inflight;
    // The in-flight slot is cleared by the run itself, so a rejected load does not wedge the
    // registry. `run` is declared before `started` and closes over it: the `finally` only observes
    // it after the first `await`, by which point it is assigned.
    const run = async (): Promise<void> => {
      try {
        await this.#fetch(opts?.signal);
      } finally {
        if (this.#inflight === started) this.#inflight = undefined;
      }
    };
    const started: Promise<void> = run();
    this.#inflight = started;
    return started;
  }

  /** The cached config. Throws when it has never been loaded — there is no safe default. */
  get(): SystemConfigInfo {
    const value: SystemConfigInfo | undefined = this.tryGet();
    if (value !== undefined) return value;
    throw new LighterConfigError("system config has not been loaded; call load() first");
  }

  /** The cached config, `undefined` when it has never been loaded. Serves stale, never blocks. */
  tryGet(): SystemConfigInfo | undefined {
    if (this.#value !== undefined && this.stale) this.#scheduleRefresh();
    return this.#value;
  }

  /** Clear any pending background refresh and stop scheduling new ones. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      globalThis.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Backing method for `Symbol.dispose`; see the attachment below the class. */
  disposeSync(): void {
    this.stop();
  }

  /* -- internals ----------------------------------------------------------------------------- */

  #now(): number {
    const fn: (() => number) | undefined = this.#nowFn ?? this.#rest?.config.now;
    return fn !== undefined ? fn() : Date.now();
  }

  #emit(d: Diagnostic): void {
    const sink: ((d: Diagnostic) => void) | undefined = this.#sink ?? this.#rest?.config.onDiagnostic;
    if (sink === undefined) return;
    try {
      sink(d);
    } catch {
      /* a broken diagnostics sink must never take down a metadata load */
    }
  }

  #scheduleRefresh(): void {
    if (this.#stopped || this.#rest === undefined) return;
    if (this.#timer !== undefined || this.#inflight !== undefined) return;
    this.#timer = globalThis.setTimeout((): void => {
      this.#timer = undefined;
      void this.load({ force: true }).catch((err: unknown): void => {
        this.#emit({
          level: "warn",
          event: "systemConfig.refresh_failed",
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, 0);
  }

  async #fetch(signal?: AbortSignal): Promise<void> {
    const rest: LighterRestClient | undefined = this.#rest;
    if (rest === undefined) {
      throw new LighterConfigError(
        "SystemConfigCache.load() needs a REST transport — construct with `{ rest }` or call setTransport()",
      );
    }
    const callOpts: CallOptions = signal !== undefined ? { signal } : {};
    const body: SystemConfig = await rest.info.systemConfig(undefined, callOpts);
    const value: SystemConfigInfo = toSystemConfigInfo(body);
    this.#value = value;
    this.#loadedAt = this.#now();
  }
}

/*
 * Explicit resource management, attached defensively — see the identical note in `./assets.ts` and
 * in `src/ws/subscription.ts`.
 */
const disposeSym: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
if (typeof disposeSym === "symbol") {
  Object.defineProperty(SystemConfigCache.prototype, disposeSym, {
    value: function dispose(this: SystemConfigCache): void {
      this.disposeSync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}
