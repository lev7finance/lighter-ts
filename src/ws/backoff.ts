/**
 * Reconnect policy: close-code classification and full-jitter exponential backoff.
 *
 * Lighter disconnects healthy clients as a matter of routine — the published documentation says
 * *"deployments without downtime may disconnect your connection, so implementing proper
 * reconnection logic along with ping/pong mechanisms is recommended"*
 * (`docs/spec/06-websocket.md` §9.4). A server-initiated close is therefore a **normal, frequent
 * event**, not an error, and the reference Python client's policy — raise from `on_close` and from
 * `on_error`, so one dropped socket ends the session — is the single largest functional gap this
 * package closes (`docs/protocol-notes.md` §10.2).
 *
 * This module is the *decision* half of that. It holds no socket, opens nothing, schedules nothing,
 * and reads no clock: it answers "should we reconnect after this close, and how long should we
 * wait". The transport unit owns the socket and the waiting.
 *
 * Three things here are easy to get subtly wrong, and each one has a live failure mode:
 *
 * 1. **Full jitter, not equal jitter and not decorrelated jitter.** `delay = random() * cap`, so a
 *    delay near zero is correct and expected. Many isolates reconnecting after one Lighter deploy is
 *    exactly the thundering herd full jitter exists for; halving the spread to `cap/2 + rand*cap/2`
 *    doubles the peak reconnect rate seen by the server for no benefit.
 * 2. **The attempt counter resets on *stability*, not on `open`.** A socket that opens and dies
 *    immediately, forever, would otherwise reconnect at attempt 0 — full speed — forever. It resets
 *    only after the connection has been continuously OPEN for `stableAfterMs`, which is why
 *    {@link BackoffController.noteOpen} and {@link BackoffController.noteClose} take timestamps
 *    rather than the controller reading a clock of its own.
 * 3. **A client-initiated `1000` must be terminal.** The code alone cannot distinguish our own
 *    `close()` from a deploy drain, so the caller states it via `ctx.clientInitiated`. If that case
 *    ever classifies as reconnectable, the client can never be shut down.
 *
 * Evidence status: the close-code table is `[DESIGN]` `[INFER]` in `docs/spec/06-websocket.md`
 * §9.4 — Lighter documents no close codes, and the live capture that would confirm them is blocked
 * (`docs/spec/06-websocket.md` §0). The unknown-code fallback is what makes that safe: any code not
 * in the table reconnects as `network` rather than stalling the client. `4000` and `4001` are ours,
 * not the server's.
 *
 * Side-effect free at import. No timers, no clock, no I/O.
 */

import { LighterConfigError } from "../errors.js";

/** Tuning for {@link BackoffController}. Every field has a default; all of them are milliseconds. */
export interface BackoffOptions {
  /** Delay scale at attempt 0, before jitter. Default `250`. */
  readonly baseDelayMs?: number;
  /** Ceiling on the pre-jitter cap. Default `30_000`. */
  readonly maxDelayMs?: number;
  /** Give up after this many reconnect attempts. Default `Infinity`. */
  readonly maxAttempts?: number;
  /** How long a connection must stay OPEN before the attempt counter resets. Default `30_000`. */
  readonly stableAfterMs?: number;
  /** Jitter source in `[0, 1)`. Default `Math.random`; injected in tests for determinism. */
  readonly random?: () => number;
}

/**
 * Why the socket closed, coarse enough to drive policy.
 *
 * - `client-initiated` — our own `close()`. The only terminal class.
 * - `drain` — deploy or restart. Expected, frequent, not an error.
 * - `network` — no close frame, or a code we do not recognise.
 * - `policy` — `1008`; likely auth or rate-limit enforcement.
 * - `server-error` — server fault or "try again later".
 * - `stale` — our staleness watchdog fired (`4000`).
 * - `protocol` — binary frame or unparseable-JSON storm (`4001`).
 */
export type CloseClass =
  | "client-initiated"
  | "drain"
  | "network"
  | "policy"
  | "server-error"
  | "stale"
  | "protocol";

/** The verdict on one close event. Frozen; safe to hand to a subscriber. */
export interface CloseClassification {
  readonly code: number;
  readonly cls: CloseClass;
  readonly reconnect: boolean;
  /** Backoff floor for this class, in ms. `0` for the ordinary cases. */
  readonly minDelayMs: number;
  /** Emitted by the caller as a diagnostic; not logged here. */
  readonly diagnostic?: "auth-suspect" | "drain";
}

/** Extra context the close code cannot carry on its own. */
export interface CloseContext {
  /**
   * True when *we* asked for this close. Only meaningful for `1000`: our staleness watchdog closes
   * with `4000` and our protocol guard with `4001`, and both of those must still reconnect.
   */
  readonly clientInitiated?: boolean;
  /** How many `1008` closes have happened in a row, including this one. */
  readonly consecutivePolicyCloses?: number;
}

/** `1001 Going Away` floor: a deploy takes seconds, so retrying inside a second is pointless. */
const DRAIN_FLOOR_MS: 1000 = 1000;

/** Floor once `1008` repeats — the credential, not the timing, is the likely problem. */
const POLICY_FLOOR_MS: 5000 = 5000;

/** `1008` closes in a row before the floor is raised and `auth-suspect` is emitted. */
const POLICY_REPEAT_THRESHOLD: 2 = 2;

/**
 * Largest exponent used in `base * 2 ** n`.
 *
 * `250 * 2 ** 1030` is `Infinity`, and `Infinity * random()` is `Infinity`. A caller that waits for
 * that many milliseconds either never reconnects or — on engines that clamp an out-of-range delay to
 * zero — spins. Clamping the exponent first keeps the product finite for every attempt; the
 * `maxDelayMs` clamp then does the real work. `250 * 2 ** 31 ≈ 5.4e11`, far under any sane cap.
 */
const MAX_SHIFT: 31 = 31;

const DEFAULT_BASE_DELAY_MS: 250 = 250;
const DEFAULT_MAX_DELAY_MS: 30_000 = 30_000;
const DEFAULT_STABLE_AFTER_MS: 30_000 = 30_000;

function requireNonNegativeFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LighterConfigError(`${name} must be a finite number >= 0`, { code: "BACKOFF_OPTION" });
  }
  return value;
}

function requirePositiveFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LighterConfigError(`${name} must be a finite number > 0`, { code: "BACKOFF_OPTION" });
  }
  return value;
}

/**
 * Classify a WebSocket close code.
 *
 * The table is `docs/spec/06-websocket.md` §9.4. Codes outside it are deliberately **not** fatal:
 * an unrecognised code reconnects as `network`, because a client that stalls on a code nobody
 * anticipated is worse than one that retries with backoff.
 *
 * Pure: the same arguments always give the same verdict.
 */
export function classifyCloseCode(code: number, ctx?: CloseContext): CloseClassification {
  const clientInitiated = ctx !== undefined && ctx.clientInitiated === true;
  const policyCloses = ctx !== undefined && typeof ctx.consecutivePolicyCloses === "number"
    ? ctx.consecutivePolicyCloses
    : 0;

  switch (code) {
    case 1000:
      // The only branch where the caller's intent, not the code, decides.
      return clientInitiated
        ? freeze({ code, cls: "client-initiated", reconnect: false, minDelayMs: 0 })
        : freeze({ code, cls: "drain", reconnect: true, minDelayMs: 0, diagnostic: "drain" });

    case 1001:
      // Going Away: server restart or deploy.
      return freeze({ code, cls: "drain", reconnect: true, minDelayMs: DRAIN_FLOOR_MS, diagnostic: "drain" });

    case 1006:
      // Abnormal closure — no close frame was received. The common case on mobile and behind NAT.
      return freeze({ code, cls: "network", reconnect: true, minDelayMs: 0 });

    case 1008:
      // Policy violation: auth or rate-limit enforcement. One is noise; a run of them is a signal.
      return policyCloses >= POLICY_REPEAT_THRESHOLD
        ? freeze({ code, cls: "policy", reconnect: true, minDelayMs: POLICY_FLOOR_MS, diagnostic: "auth-suspect" })
        : freeze({ code, cls: "policy", reconnect: true, minDelayMs: 0 });

    case 1011: // Internal Error
    case 1012: // Service Restart
    case 1013: // Try Again Later
      return freeze({ code, cls: "server-error", reconnect: true, minDelayMs: 0 });

    case 4000:
      // Ours: the inbound staleness watchdog fired on a half-open socket.
      return freeze({ code, cls: "stale", reconnect: true, minDelayMs: 0 });

    case 4001:
      // Ours: binary frame or an unparseable-JSON storm.
      return freeze({ code, cls: "protocol", reconnect: true, minDelayMs: 0 });

    default:
      return freeze({ code, cls: "network", reconnect: true, minDelayMs: 0 });
  }
}

function freeze(c: CloseClassification): CloseClassification {
  return Object.freeze(c);
}

/**
 * Attempt counter and delay schedule for one socket.
 *
 * Owns exactly two pieces of mutable state — the attempt number, and the timestamp the socket last
 * reached OPEN — for the lifetime of the transport that constructed it. It never reads a clock:
 * timestamps arrive as arguments so a test can advance time by assignment.
 */
export class BackoffController {
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxAttempts: number;
  readonly #stableAfterMs: number;
  readonly #random: () => number;

  #attempt = 0;
  /** Timestamp of the last {@link noteOpen}, or `null` while not open. */
  #openedAtMs: number | null = null;

  constructor(opts?: BackoffOptions) {
    const o = opts ?? {};
    this.#baseDelayMs = requirePositiveFinite("baseDelayMs", o.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.#maxDelayMs = requirePositiveFinite("maxDelayMs", o.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.#stableAfterMs = requireNonNegativeFinite("stableAfterMs", o.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS);

    const maxAttempts = o.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (typeof maxAttempts !== "number" || Number.isNaN(maxAttempts) || maxAttempts < 0) {
      throw new LighterConfigError("maxAttempts must be a number >= 0 (Infinity for unlimited)", {
        code: "BACKOFF_OPTION",
      });
    }
    this.#maxAttempts = maxAttempts;

    const random = o.random ?? Math.random;
    if (typeof random !== "function") {
      throw new LighterConfigError("random must be a function returning a number in [0, 1)", {
        code: "BACKOFF_OPTION",
      });
    }
    this.#random = random;
  }

  /** Reconnect attempts made since the last reset. `0` means the next delay is the first one. */
  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Delay before the next connect, in ms, consuming one attempt — or `null` for "do not reconnect"
   * (terminal class, or attempts exhausted).
   *
   * ```text
   * cap   = min(maxDelayMs, baseDelayMs * 2 ** min(attempt, 31))
   * delay = max(classification.minDelayMs, random() * cap)      // FULL jitter
   * ```
   *
   * The return is always a finite, non-negative number. A jitter source that misbehaves (returns
   * `NaN`, a negative, or something above 1) is clamped rather than propagated, because the value
   * flows straight into a scheduled wait where `NaN` degrades into a busy loop.
   */
  nextDelayMs(c: CloseClassification): number | null {
    if (!c.reconnect) return null;
    if (this.#attempt >= this.#maxAttempts) return null;

    const shift = Math.min(this.#attempt, MAX_SHIFT);
    const cap = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** shift);

    const raw = this.#random();
    const jitter = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

    const floor = Number.isFinite(c.minDelayMs) && c.minDelayMs > 0 ? c.minDelayMs : 0;
    const delay = Math.max(floor, jitter * cap);

    this.#attempt += 1;
    return delay;
  }

  /**
   * Record the moment the socket reached OPEN.
   *
   * Deliberately does **not** reset the attempt counter — see {@link noteClose}.
   */
  noteOpen(nowMs: number): void {
    this.#openedAtMs = nowMs;
  }

  /**
   * Record a close at `nowMs`, resetting the attempt counter **iff** the socket had been OPEN for
   * at least `stableAfterMs`.
   *
   * A close without a preceding {@link noteOpen} (a connect that never succeeded) never resets.
   */
  noteClose(nowMs: number): void {
    const openedAt = this.#openedAtMs;
    this.#openedAtMs = null;
    if (openedAt === null) return;
    if (nowMs - openedAt >= this.#stableAfterMs) this.#attempt = 0;
  }

  /** Forget every attempt and any open interval. For a caller reconnecting on a fresh intent. */
  reset(): void {
    this.#attempt = 0;
    this.#openedAtMs = null;
  }
}
