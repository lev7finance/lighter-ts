/**
 * Merged per-account asset state, as a pure state machine over the `account_all_assets` channel.
 *
 * It consumes decoded messages, not a client: nothing here imports the transport, the client or the
 * socket, so the whole merge policy is testable in-process — which matters more than usual, because
 * the evidence that would settle that policy does not exist yet (below). No timers, no I/O, no
 * globals mutated, no `node:` import.
 *
 * ## Are `update/account_*` frames partial or full? — the open question, answered as far as the
 * ## evidence allows
 *
 * `docs/spec/06-websocket.md` §15 item 2 asks this, and the wave-0 capture cannot answer it:
 * **`test/fixtures/ws/capture.json` contains zero frames.** The capture was refused at the
 * WebSocket upgrade from a restricted jurisdiction (API code 20558, `docs/protocol-notes.md` §8.3);
 * its `captureFailed` block records the refusal and its `frames` array is empty. So the capture is
 * not merely inconclusive — it is absent.
 *
 * **The assumption this file makes, stated explicitly so it can be checked the moment a capture
 * lands: `update/account_all_assets` is merged by `asset_id`, never wholesale-replaced.** A balance
 * that falls to zero is delivered as the string `"0"`, not by omitting the asset, so an asset absent
 * from an update means "unchanged" rather than "gone" (`docs/spec/06-websocket.md` §6.2.9 and §3.2,
 * where exact zero detection exists for precisely this reason).
 *
 * Merging is the safe direction under both possible server behaviours. If updates turn out to be
 * full, merging a full frame reproduces it exactly and the assumption costs nothing. If updates are
 * partial — which is what §6.2.8 infers — replacing would discard every asset that simply did not
 * change in that frame. That is defect 8 of the reference Python client
 * (`docs/spec/06-websocket.md` §12.1), which replaces its whole cached account message on every
 * update. The asymmetry is what decides it: merging is wrong only in the harmless direction.
 *
 * The one case merging cannot express is an asset being *removed* from an account. No such delivery
 * is documented, and a zeroed balance is the documented spelling, so this is accepted knowingly. A
 * fresh `subscribed/*` snapshot replaces the map wholesale and clears any such residue.
 *
 * ## Why the account index is a constructor argument
 *
 * `account_all_assets` payloads carry **no `account` field**. The index exists only inside the
 * `channel` string (`account_all_assets:{A}`), so a state machine that tried to learn it from a
 * payload would never learn it (`docs/spec/06-websocket.md` §6.2.9, `[REF]`). It is passed in, and
 * `ChannelSpec.accountIndex` is where a caller gets it from.
 *
 * ## Money never touches a float
 *
 * `available = balance − locked_balance` is computed on scaled `bigint`s via `src/util/decimal.ts`.
 * `"1"` and `"1.0000"` are the same balance and both appear in real payloads
 * (`docs/spec/06-websocket.md` §3.1); subtracting two decimal strings through binary64 is the exact
 * hazard `docs/protocol-notes.md` §9 exists to prevent — `8.2 − 0.000001` is not what a float says
 * it is. The raw strings are kept alongside the scaled values so display fidelity survives too.
 */

import { toScaled } from "../util/decimal.js";
import type { AccountAsset, AccountAssetsMessage } from "./types.js";

/**
 * Fixed scale for asset balances.
 *
 * 18 covers every documented Lighter field with room to spare (`docs/spec/06-websocket.md` §3.2) and
 * makes every balance directly comparable as a `bigint`, regardless of how many trailing zeros the
 * server happened to print. Pair it with `fromScaled` to render an exact decimal string back:
 * `fromScaled(state.available(3), ASSET_DECIMALS)`.
 */
export const ASSET_DECIMALS: 18 = 18;

/** One asset's balance, exactly as delivered and exactly as scaled. */
export interface AssetBalance {
  readonly assetId: number;
  /** Ticker, as delivered. Empty string when the frame omitted it. */
  readonly symbol: string;
  /** Total balance, the decimal string as delivered. `"1"` and `"1.0000"` both occur. */
  readonly balance: string;
  /** Reserved portion, the decimal string as delivered. */
  readonly lockedBalance: string;
  /** {@link balance} scaled by `10^ASSET_DECIMALS`. Exact. */
  readonly balanceScaled: bigint;
  /** {@link lockedBalance} scaled by `10^ASSET_DECIMALS`. Exact. */
  readonly lockedScaled: bigint;
}

/**
 * Merged view of one account's asset balances.
 *
 * Mutable by design — it is a cache of the newest server state, and the client owns exactly one per
 * subscription. `status` is the only thing a consumer needs to check before trusting it.
 */
export class AccountAssetsState {
  /** The account these balances belong to. Supplied at construction; never present in a payload. */
  readonly accountIndex: number;

  /** Keyed by numeric asset id: 1 ETH, 2 LIT, 3 USDC, 5 LINK, 6 UNI, 7 AAVE, 8 SKY, 9 LDO. */
  private readonly balances: Map<number, AssetBalance> = new Map<number, AssetBalance>();

  private state: "empty" | "synced" | "stale" = "empty";

  private lastTimestampMs: number | undefined = undefined;

  constructor(accountIndex: number) {
    this.accountIndex = accountIndex;
  }

  /**
   * - `empty` — nothing applied yet, and nothing will be until a snapshot arrives.
   * - `synced` — a snapshot has been applied and every update since has been merged onto it.
   * - `stale` — the socket dropped. The last known balances are still readable, deliberately (a
   *   greyed-out figure is more honest than a fabricated zero), but they are **not** current and
   *   updates are refused until the next snapshot.
   *
   * Read-only from outside: only {@link applySnapshot}, {@link applyUpdate} and {@link reset} move
   * it, which is what makes the transitions auditable in one place.
   */
  get status(): "empty" | "synced" | "stale" {
    return this.state;
  }

  /** `timestamp` of the last applied frame, epoch **milliseconds**. `undefined` until one arrives. */
  get timestampMs(): number | undefined {
    return this.lastTimestampMs;
  }

  /** The current balances. Read-only to callers; the instance is reused across frames. */
  get assets(): ReadonlyMap<number, AssetBalance> {
    return this.balances;
  }

  /**
   * `balance − locked_balance` for one asset, as an exact `bigint` scaled by `10^ASSET_DECIMALS`.
   *
   * Zero for an asset that has never been seen, which is indistinguishable from a genuine zero
   * balance — check {@link assets} when the difference matters. Never negative in practice, but the
   * subtraction is signed and is not clamped: a server that reported `locked > balance` would be
   * reporting something the caller needs to see, not something this class should hide.
   */
  available(assetId: number): bigint {
    const entry: AssetBalance | undefined = this.balances.get(assetId);
    if (entry === undefined) return 0n;
    return entry.balanceScaled - entry.lockedScaled;
  }

  /**
   * Apply a `subscribed/account_all_assets` frame: **replaces** the map wholesale.
   *
   * A snapshot is by definition the complete current state, so anything not in it is genuinely gone
   * — this is the only path that removes an asset, and the reason merging updates is safe.
   *
   * A frame whose `channel` names a *different* account is ignored (see {@link namesAnotherAccount}).
   * Never throws.
   */
  applySnapshot(msg: AccountAssetsMessage): void {
    if (namesAnotherAccount(msg, this.accountIndex)) return;
    this.balances.clear();
    this.mergeAssets(msg);
    this.state = "synced";
    this.noteTimestamp(msg);
  }

  /**
   * Apply an `update/account_all_assets` frame: **merges** by asset id.
   *
   * Refused unless the state is `synced`. An update arriving before any snapshot — on a fresh
   * instance, or after {@link reset} — is dropped rather than used to conjure state out of a frame
   * that may only describe what changed. Silently building a "balance sheet" from deltas whose base
   * is unknown is worse than having none.
   *
   * Never throws.
   */
  applyUpdate(msg: AccountAssetsMessage): void {
    if (this.state !== "synced") return;
    if (namesAnotherAccount(msg, this.accountIndex)) return;
    this.mergeAssets(msg);
    this.noteTimestamp(msg);
  }

  /**
   * Mark the state void: called on reconnect, before any post-reconnect snapshot arrives.
   *
   * `status` becomes `stale` and updates are refused until the next snapshot. The balances and the
   * timestamp are **kept** on purpose, mirroring `OrderBookState` (`docs/spec/06-websocket.md`
   * §6.3.5): a consumer that checks `status` can keep showing the last known figures while flagging
   * them, whereas clearing would hand it a set of zeros that look exactly like real balances.
   */
  reset(): void {
    this.state = "stale";
  }

  /** Fold a frame's `assets` map into the cache. Shared by both apply paths. */
  private mergeAssets(msg: AccountAssetsMessage): void {
    const assets: unknown = msg.assets;
    if (typeof assets !== "object" || assets === null || Array.isArray(assets)) return;
    for (const [key, value] of Object.entries(assets as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const asset: AccountAsset = value as AccountAsset;
      const id: number | undefined = assetId(key, asset);
      if (id === undefined) continue;
      this.balances.set(id, toBalance(id, asset));
    }
  }

  /** Record the frame's `timestamp`, in milliseconds, when it carried a usable one. */
  private noteTimestamp(msg: AccountAssetsMessage): void {
    const t: unknown = msg.timestamp;
    if (typeof t === "number" && Number.isFinite(t)) this.lastTimestampMs = t;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The asset id, from the payload's own `asset_id` first and the map key second.
 *
 * The map key is the fallback rather than the primary source because it is a *string* in the JSON
 * document and the payload field is the server's own typed value; they have always agreed in the
 * documented examples. `undefined` when neither yields a non-negative integer, in which case the
 * entry is skipped — an entry filed under a bogus id is worse than an entry that is missing, because
 * `available()` would answer for it.
 */
function assetId(key: string, asset: AccountAsset): number | undefined {
  const declared: unknown = asset.asset_id;
  if (typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0) {
    return declared;
  }
  if (/^[0-9]+$/.test(key)) {
    const parsed: number = Number.parseInt(key, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

/** Build an {@link AssetBalance}, keeping the delivered strings and scaling them exactly. */
function toBalance(id: number, asset: AccountAsset): AssetBalance {
  const balance: string = typeof asset.balance === "string" ? asset.balance : "0";
  const locked: string = typeof asset.locked_balance === "string" ? asset.locked_balance : "0";
  return {
    assetId: id,
    symbol: typeof asset.symbol === "string" ? asset.symbol : "",
    balance,
    lockedBalance: locked,
    balanceScaled: scaleExact(balance),
    lockedScaled: scaleExact(locked),
  };
}

/**
 * Decimal string → exact scaled `bigint`, total.
 *
 * `toScaled(…, "EXACT")` throws on anything that is not a plain decimal — exponent notation, an
 * empty string, more than 18 fraction digits. None of those appear on this wire, and if one ever
 * does, a read loop is the wrong place to discover it: this path must not throw (this whole module
 * follows `decodeFrame`'s rule). The scaled value falls back to zero while the **raw string is
 * preserved verbatim** on {@link AssetBalance.balance}, so the discrepancy stays visible to anyone
 * who looks rather than being erased.
 *
 * `"EXACT"` and not a rounding mode: at 18 decimals nothing legitimate needs rounding, and silently
 * rounding a balance is precisely the class of defect `docs/protocol-notes.md` §9 catalogues.
 */
function scaleExact(s: string): bigint {
  try {
    return toScaled(s, ASSET_DECIMALS, "EXACT");
  } catch {
    return 0n;
  }
}

/**
 * Whether a frame's `channel` names an account other than this one.
 *
 * The payload has no `account` field, but the channel string does — `account_all_assets:{A}`, or the
 * slash spelling once normalised. This is the only cross-check available, and it can only ever
 * reject: a frame whose channel is missing, unparsable, or carries no trailing index returns `false`
 * and is applied. Routing in `src/ws/protocol.ts` should already have made this impossible; a
 * balance merged from the wrong account would be invisible, so the cheap belt-and-braces check
 * stays.
 *
 * It doubles as the null guard for both apply paths, which is what keeps them total: a `null` or
 * non-object frame is "not ours" and is dropped rather than throwing on a read loop.
 */
function namesAnotherAccount(msg: AccountAssetsMessage, accountIndex: number): boolean {
  if (typeof msg !== "object" || msg === null) return true;
  const channel: unknown = msg.channel;
  if (typeof channel !== "string" || channel.length === 0) return false;
  const tail: string = channel.slice(Math.max(channel.lastIndexOf(":"), channel.lastIndexOf("/")) + 1);
  if (!/^[0-9]+$/.test(tail)) return false;
  const parsed: number = Number.parseInt(tail, 10);
  return Number.isSafeInteger(parsed) && parsed !== accountIndex;
}
