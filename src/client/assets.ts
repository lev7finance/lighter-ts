/**
 * The asset registry: `asset_id → decimals`, and the shared caching policy the whole metadata
 * layer runs on.
 *
 * Asset decimals are the scaling exponent for every transfer and withdrawal — a transfer's wire
 * amount is `human × 10^decimals`. Three fields on the wire look interchangeable and are not:
 *
 * - `decimals` — Lighter's own balance scale. **This is the one transfers and withdrawals use.**
 * - `l1_decimals` — the ERC-20 contract's scale (18 for ETH, 6 for USDC). Bridge-side only.
 * - `price_decimals` — the scale of `index_price`. Never an amount scale.
 *
 * Picking the wrong one is a silent 10^n error, which is why all three are carried under distinct
 * names and none of them is defaulted.
 *
 * {@link ASSET_DECIMALS_SEED} reproduces the reference signer's hard-coded table, and it exists
 * **only** as an offline fallback and a cross-check. The reference gates on that table and raises
 * "Unsupported asset id" for anything outside it, so it breaks on every new listing
 * (`spec/07-high-level-client.md` §11 defect 13). Here the server always wins: an unknown asset id
 * resolves normally, and a seeded value that disagrees with the server produces a diagnostic and
 * the server's number.
 *
 * No module-level mutable state (`docs/decisions.md` D8) — every registry hangs off its own
 * instance, so N clients on N chains coexist. Importing this module performs no I/O, schedules no
 * timer and reads no clock.
 */

import type { Diagnostic } from "../config/config.js";
import { LighterConfigError } from "../errors.js";
import type { AssetMarginMode } from "../models/common.js";
import type { Asset, AssetDetails } from "../models/market.js";
import type { CallOptions, LighterRestClient } from "../rest/client.js";
import { parseDecimal } from "../util/decimal.js";

/* -------------------------------------------------------------------------------------------- */
/* Shared vocabulary                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * A base-10 scaling exponent — `supported_price_decimals`, an asset's `decimals`, and friends.
 *
 * It is deliberately a distinct name rather than a bare `number`. `docs/decisions.md` D7 forbids
 * `number` for anything monetary, and a field literally called `priceDecimals` is the one place
 * where `number` is not only allowed but correct: it is a `u8` exponent, a count of digits, not a
 * price. Naming the domain keeps that legitimate exception from reading like a violation, and
 * keeps a genuine `somePrice: number` violation visible.
 */
export type Decimals = number;

/** Largest exponent this layer will accept from the wire. Well above anything the protocol uses. */
const MAX_DECIMALS: 36 = 36;

/** Metadata is quasi-static; five minutes is the spec's default (§8.2). */
export const DEFAULT_METADATA_TTL_MS: 300_000 = 300_000;

/**
 * What every registry in this directory accepts.
 *
 * `rest` is optional because the snapshot path constructs a fully usable registry with no
 * transport at all — that is the Cloudflare Worker cold-start case, and it must not require a
 * client that does not exist yet. {@link AssetRegistry.setTransport} attaches one later.
 */
export interface RegistryOptions {
  readonly rest?: LighterRestClient;
  /** Default {@link DEFAULT_METADATA_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock, epoch milliseconds. Defaults to the transport's clock, then to `Date.now`. */
  readonly now?: () => number;
  /** Diagnostics sink. Defaults to the transport's sink, then to a no-op. */
  readonly onDiagnostic?: (d: Diagnostic) => void;
}

/** What a `load()` accepts. */
export interface LoadOptions {
  /** Refetch even when the cached copy is fresh. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

/* -------------------------------------------------------------------------------------------- */
/* The seed table                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** One row of {@link ASSET_DECIMALS_SEED}. */
export interface SeededAsset {
  readonly symbol: string;
  readonly decimals: Decimals;
}

/**
 * The reference signer's hard-coded `asset_id → decimals` table, verbatim
 * (`spec/07-high-level-client.md` §1.7).
 *
 * `asset_id` 4 does not exist, and its absence here is the table being faithful rather than an
 * omission. Everything else about this constant is a fallback: it is a seed for offline scaling
 * and a cross-check against the server, never a gate on which asset ids are acceptable.
 */
export const ASSET_DECIMALS_SEED: Readonly<Record<number, SeededAsset>> = Object.freeze({
  1: Object.freeze({ symbol: "ETH", decimals: 8 }),
  2: Object.freeze({ symbol: "LIT", decimals: 8 }),
  3: Object.freeze({ symbol: "USDC", decimals: 6 }),
  5: Object.freeze({ symbol: "LINK", decimals: 8 }),
  6: Object.freeze({ symbol: "UNI", decimals: 8 }),
  7: Object.freeze({ symbol: "AAVE", decimals: 8 }),
  8: Object.freeze({ symbol: "SKY", decimals: 8 }),
  9: Object.freeze({ symbol: "LDO", decimals: 8 }),
});

/* -------------------------------------------------------------------------------------------- */
/* AssetInfo                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * One asset, normalised.
 *
 * Every monetary field is the decimal string the wire sent, unchanged (`docs/decisions.md` D7,
 * `docs/protocol-notes.md` §8.4). Nothing here has been through `Number`.
 */
export interface AssetInfo {
  readonly assetId: number;
  readonly symbol: string;
  /** Lighter's balance scale. Transfers and withdrawals scale by `10^decimals`. */
  readonly decimals: Decimals;
  /** The L1 ERC-20 contract's scale. Not an L2 amount scale. */
  readonly l1Decimals: Decimals;
  /** The scale of {@link indexPrice}. Not an amount scale. */
  readonly priceDecimals: Decimals;
  readonly marginMode: AssetMarginMode;
  /** Decimal string, e.g. `"1.000000"`. */
  readonly minTransferAmount: string;
  /** Decimal string, e.g. `"2.00000000"`. */
  readonly minWithdrawalAmount: string;
  readonly l1Address?: string;
  /** Oracle price at load time, decimal string. A cached quote — never price anything live off it. */
  readonly indexPrice?: string;
  /**
   * Undocumented and risk R21. Surfaced raw and verbatim, folded into nothing. If a conversion ever
   * needs it, that is a protocol decision, not a registry decision.
   */
  readonly multiplier?: string;
}

/** A serialisable {@link AssetRegistry}. JSON-safe: no `bigint`, no `undefined` holes. */
export interface AssetSnapshot {
  readonly version: 1;
  /** Epoch milliseconds, or `null` when the snapshot was never populated from the wire. */
  readonly loadedAt: number | null;
  readonly assets: readonly AssetInfo[];
}

/* -------------------------------------------------------------------------------------------- */
/* Ingest                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `Object.prototype.toString`-free shape description, for error messages only. */
function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  return String(v);
}

/** A required integer field. Absence and `NaN` are both loud. */
function requireInt(v: unknown, field: string, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new LighterConfigError(`${where}: \`${field}\` is missing or not an integer (${describe(v)})`);
  }
  return v;
}

/** A required scaling exponent: an integer in `0..36`. */
function requireDecimals(v: unknown, field: string, where: string): Decimals {
  const n: number = requireInt(v, field, where);
  if (n < 0 || n > MAX_DECIMALS) {
    throw new LighterConfigError(`${where}: \`${field}\` out of range (${String(n)}, expected 0..${String(MAX_DECIMALS)})`);
  }
  return n;
}

/** A required non-empty string field. */
function requireString(v: unknown, field: string, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new LighterConfigError(`${where}: \`${field}\` is missing or not a non-empty string (${describe(v)})`);
  }
  return v;
}

/**
 * A required decimal string, validated by the same parser the money layer uses.
 *
 * Validated and then handed on **unchanged** — normalising here would quietly re-scale a value the
 * order-math layer is entitled to read at the precision the server chose.
 */
function requireDecimalString(v: unknown, field: string, where: string): string {
  if (typeof v !== "string") {
    throw new LighterConfigError(`${where}: \`${field}\` is missing or not a string (${describe(v)})`);
  }
  try {
    parseDecimal(v);
  } catch {
    throw new LighterConfigError(`${where}: \`${field}\` is not a plain decimal string (${describe(v)})`);
  }
  return v;
}

/** An optional decimal string: validated when present, omitted when absent. */
function optionalDecimalString(v: unknown, field: string, where: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return requireDecimalString(v, field, where);
}

/** `margin_mode` is a closed two-value union; anything else is a protocol change, not a default. */
function requireMarginMode(v: unknown, where: string): AssetMarginMode {
  if (v === "enabled" || v === "disabled") return v;
  throw new LighterConfigError(`${where}: \`margin_mode\` is missing or unrecognised (${describe(v)})`);
}

/** Normalise one wire asset. Throws {@link LighterConfigError} naming the asset on any bad field. */
export function toAssetInfo(raw: Asset): AssetInfo {
  const idHint: string = raw.asset_id === undefined ? (raw.symbol ?? "?") : String(raw.asset_id);
  const where: string = `asset ${idHint}`;
  const assetId: number = requireInt(raw.asset_id, "asset_id", where);
  const indexPrice: string | undefined = optionalDecimalString(raw.index_price, "index_price", where);
  const multiplier: string | undefined = optionalDecimalString(raw.multiplier, "multiplier", where);
  return Object.freeze({
    assetId,
    symbol: requireString(raw.symbol, "symbol", where),
    decimals: requireDecimals(raw.decimals, "decimals", where),
    l1Decimals: requireDecimals(raw.l1_decimals, "l1_decimals", where),
    priceDecimals: requireDecimals(raw.price_decimals, "price_decimals", where),
    marginMode: requireMarginMode(raw.margin_mode, where),
    minTransferAmount: requireDecimalString(raw.min_transfer_amount, "min_transfer_amount", where),
    minWithdrawalAmount: requireDecimalString(raw.min_withdrawal_amount, "min_withdrawal_amount", where),
    ...(typeof raw.l1_address === "string" && raw.l1_address.length > 0 ? { l1Address: raw.l1_address } : {}),
    ...(indexPrice !== undefined ? { indexPrice } : {}),
    ...(multiplier !== undefined ? { multiplier } : {}),
  });
}

/* -------------------------------------------------------------------------------------------- */
/* The registry                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** Upper-cased so `asset("usdc")` and `asset("USDC")` are the same lookup. */
function symbolKey(s: string): string {
  return s.toUpperCase();
}

/**
 * `asset_id → AssetInfo`, cached on the instance.
 *
 * Lifetime and refresh policy, identical to {@link MarketRegistry}:
 *
 * - `load()` is idempotent and concurrency-safe — two overlapping calls share one in-flight
 *   promise, so exactly one request reaches the wire.
 * - a TTL expiry never blocks a call. `get()` on stale data returns the stale value and schedules a
 *   background refresh; a failed background refresh is a diagnostic, not a throw.
 * - background refreshes use `setTimeout` only, and {@link stop} clears the pending one. Nothing
 *   may keep a Durable Object awake after its owner is disposed.
 */
export class AssetRegistry {
  #rest: LighterRestClient | undefined;
  readonly #ttlMs: number;
  readonly #nowFn: (() => number) | undefined;
  readonly #sink: ((d: Diagnostic) => void) | undefined;

  #byId: Map<number, AssetInfo> = new Map<number, AssetInfo>();
  #bySymbol: Map<string, AssetInfo> = new Map<string, AssetInfo>();
  #ordered: readonly AssetInfo[] = Object.freeze([]);
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
  static fromSnapshot(snapshot: AssetSnapshot, opts?: RegistryOptions): AssetRegistry {
    const registry: AssetRegistry = new AssetRegistry(opts);
    registry.restore(snapshot);
    return registry;
  }

  /**
   * Adopt a snapshot into an existing registry.
   *
   * Public because {@link MarketRegistry} embeds an {@link AssetSnapshot} in its own snapshot and
   * has to hand it to the asset registry it owns.
   */
  restore(snapshot: AssetSnapshot): void {
    if (snapshot === null || typeof snapshot !== "object") {
      throw new LighterConfigError("asset snapshot: not an object");
    }
    if (snapshot.version !== 1) {
      throw new LighterConfigError(`asset snapshot: unsupported version ${describe(snapshot.version)} (expected 1)`);
    }
    if (!Array.isArray(snapshot.assets)) {
      throw new LighterConfigError("asset snapshot: `assets` is not an array");
    }
    this.#index(snapshot.assets.map((a: AssetInfo): AssetInfo => Object.freeze({ ...a })));
    this.#loadedAt = typeof snapshot.loadedAt === "number" ? snapshot.loadedAt : undefined;
  }

  /** Attach a transport after construction — the snapshot path builds the registry first. */
  setTransport(rest: LighterRestClient): void {
    this.#rest = rest;
  }

  /** JSON-safe and versioned. Survives `JSON.parse(JSON.stringify(...))` unchanged. */
  toSnapshot(): AssetSnapshot {
    return Object.freeze({
      version: 1 as const,
      loadedAt: this.#loadedAt ?? null,
      assets: this.#ordered,
    });
  }

  /** Epoch milliseconds of the last successful load, or `undefined` if there has never been one. */
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

  /**
   * Fetch and cache `/api/v1/assetDetails`.
   *
   * A no-op when a fresh copy is already present and `force` is not set. Two overlapping calls
   * share one in-flight promise and therefore one request.
   */
  load(opts?: LoadOptions): Promise<void> {
    if (opts?.force !== true && this.#loadedAt !== undefined && !this.stale) return Promise.resolve();
    if (this.#inflight !== undefined) return this.#inflight;
    // The in-flight slot is cleared by the run itself, so a rejected load does not wedge the
    // registry. `run` is declared before `started` and closes over it: the `finally` only observes
    // it after the first `await`, by which point it is assigned.
    const run = async (): Promise<void> => {
      try {
        await this.#fetchAll(opts?.signal);
      } finally {
        if (this.#inflight === started) this.#inflight = undefined;
      }
    };
    const started: Promise<void> = run();
    this.#inflight = started;
    return started;
  }

  /** Every asset, ordered by `assetId`. Frozen. */
  list(): readonly AssetInfo[] {
    this.#touch();
    return this.#ordered;
  }

  /** Lookup by id or symbol. Throws {@link LighterConfigError} on a miss — there is no safe guess. */
  get(idOrSymbol: number | string): AssetInfo {
    const found: AssetInfo | undefined = this.tryGet(idOrSymbol);
    if (found !== undefined) return found;
    throw new LighterConfigError(
      `unknown asset ${describe(idOrSymbol)}${
        this.#loadedAt === undefined ? " — the asset registry has never been loaded; call load() first" : ""
      }`,
    );
  }

  /** Lookup by id or symbol, `undefined` on a miss. */
  tryGet(idOrSymbol: number | string): AssetInfo | undefined {
    this.#touch();
    if (typeof idOrSymbol === "number") return this.#byId.get(idOrSymbol);
    return this.#bySymbol.get(symbolKey(idOrSymbol));
  }

  /**
   * The scaling exponent for an asset's L2 amounts, preferring the server and falling back to
   * {@link ASSET_DECIMALS_SEED}.
   *
   * This is the one place the seed is load-bearing, and only when the registry has nothing better:
   * a Worker that must scale a USDC transfer before its first round trip. Falling back emits a
   * diagnostic, so an offline scale is never silent.
   */
  decimalsFor(idOrSymbol: number | string): Decimals | undefined {
    const loaded: AssetInfo | undefined = this.tryGet(idOrSymbol);
    if (loaded !== undefined) return loaded.decimals;
    const seeded: SeededAsset | undefined = seedLookup(idOrSymbol);
    if (seeded === undefined) return undefined;
    this.#emit({
      level: "warn",
      event: "assets.seed_fallback",
      detail: { asset: idOrSymbol, decimals: seeded.decimals },
    });
    return seeded.decimals;
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
    // A broken diagnostics sink must never take down a metadata load.
    try {
      sink(d);
    } catch {
      /* ignored on purpose */
    }
  }

  /** Called by every read: if the cache has gone stale, refresh it out of band. Never blocks. */
  #touch(): void {
    if (!this.stale) return;
    if (this.#loadedAt === undefined) return; // nothing to serve stale; the caller's `get` will throw
    this.#scheduleRefresh();
  }

  #scheduleRefresh(): void {
    if (this.#stopped || this.#rest === undefined) return;
    if (this.#timer !== undefined || this.#inflight !== undefined) return;
    this.#timer = globalThis.setTimeout((): void => {
      this.#timer = undefined;
      void this.load({ force: true }).catch((err: unknown): void => {
        this.#emit({
          level: "warn",
          event: "assets.refresh_failed",
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }, 0);
  }

  async #fetchAll(signal?: AbortSignal): Promise<void> {
    const rest: LighterRestClient | undefined = this.#rest;
    if (rest === undefined) {
      throw new LighterConfigError(
        "AssetRegistry.load() needs a REST transport — construct with `{ rest }` or call setTransport()",
      );
    }
    const callOpts: CallOptions = signal !== undefined ? { signal } : {};
    const body: AssetDetails = await rest.order.assetDetails({}, callOpts);
    const raw: readonly Asset[] = body.asset_details ?? [];
    const infos: AssetInfo[] = raw.map(toAssetInfo);
    this.#index(infos);
    this.#loadedAt = this.#now();
    this.#crossCheckSeed(infos);
  }

  /** Build both indexes from a complete list, or throw without touching the previous state. */
  #index(infos: readonly AssetInfo[]): void {
    const byId: Map<number, AssetInfo> = new Map<number, AssetInfo>();
    const bySymbol: Map<string, AssetInfo> = new Map<string, AssetInfo>();
    // Sorted first, so "the lower id wins a symbol clash" is a property of the data and not of the
    // order the server happened to serialise in.
    const ordered: AssetInfo[] = [...infos].sort((a: AssetInfo, b: AssetInfo): number => a.assetId - b.assetId);
    for (const info of ordered) {
      requireInt(info.assetId, "assetId", "asset snapshot entry");
      requireString(info.symbol, "symbol", `asset ${String(info.assetId)}`);
      if (byId.has(info.assetId)) {
        throw new LighterConfigError(`duplicate asset id ${String(info.assetId)} in the asset response`);
      }
      byId.set(info.assetId, info);
      const key: string = symbolKey(info.symbol);
      const clash: AssetInfo | undefined = bySymbol.get(key);
      if (clash !== undefined) {
        // Two ids sharing a symbol is a server-side surprise, not a client bug: keep the lower id
        // reachable by symbol and say so. Both remain reachable by id.
        this.#emit({
          level: "warn",
          event: "assets.duplicate_symbol",
          detail: { symbol: info.symbol, kept: clash.assetId, ignored: info.assetId },
        });
        continue;
      }
      bySymbol.set(key, info);
    }
    this.#byId = byId;
    this.#bySymbol = bySymbol;
    this.#ordered = Object.freeze(ordered);
  }

  /**
   * Compare the fetched decimals against {@link ASSET_DECIMALS_SEED}.
   *
   * One diagnostic per disagreeing asset, and the fetched value is what gets stored — the seed is
   * documentation of a past state of the exchange, not a contract.
   */
  #crossCheckSeed(infos: readonly AssetInfo[]): void {
    for (const info of infos) {
      const seeded: SeededAsset | undefined = ASSET_DECIMALS_SEED[info.assetId];
      if (seeded === undefined) continue;
      if (seeded.decimals === info.decimals) continue;
      this.#emit({
        level: "warn",
        event: "assets.seed_mismatch",
        detail: {
          assetId: info.assetId,
          symbol: info.symbol,
          seeded: seeded.decimals,
          fetched: info.decimals,
        },
      });
    }
  }
}

/** Seed lookup by id or symbol; the symbol form is case-insensitive. */
function seedLookup(idOrSymbol: number | string): SeededAsset | undefined {
  if (typeof idOrSymbol === "number") return ASSET_DECIMALS_SEED[idOrSymbol];
  const wanted: string = symbolKey(idOrSymbol);
  for (const key of Object.keys(ASSET_DECIMALS_SEED)) {
    const row: SeededAsset | undefined = ASSET_DECIMALS_SEED[Number(key)];
    if (row !== undefined && symbolKey(row.symbol) === wanted) return row;
  }
  return undefined;
}

/*
 * Explicit resource management, attached defensively — the same reasoning as `src/ws/subscription.ts`.
 *
 * `Symbol.dispose` is `undefined` on Node 20 and older Safari, and a class body containing a
 * computed `[Symbol.dispose]()` member throws `TypeError: Cannot convert undefined to a property
 * key` at *import* time there. So it is read defensively and attached only when it exists.
 * `Symbol.dispose ??= …` is not used: mutating a global at module scope is an import side effect,
 * and this package ships `"sideEffects": false`. Defining a property on our own class is not
 * observable outside this module.
 */
const disposeSym: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
if (typeof disposeSym === "symbol") {
  Object.defineProperty(AssetRegistry.prototype, disposeSym, {
    value: function dispose(this: AssetRegistry): void {
      this.disposeSync();
    },
    configurable: true,
    writable: true,
    enumerable: false,
  });
}
