/**
 * LIT lease models and the `litLease` request body.
 *
 * Leasing LIT buys a fee tier without buying the token outright. The surface is three endpoints —
 * `GET /leaseOptions`, `GET /leases`, `POST /litLease` — and one trap:
 *
 * **`lease_amount` is a string on the request and an integer on the response.** The request field
 * is a decimal string of raw LIT units (`1 LIT = 100000000`); {@link LeaseEntry.lease_amount} and
 * {@link LeaseEntry.fee_amount} arrive as JSON integers in those same raw units. Both the vendored
 * schema and `spec/08-extras-and-dx.md` §A′5 state the split independently, so it is reproduced
 * rather than smoothed over: typing the response as a decimal string would be a lie that only
 * shows up at runtime, when `typeof entry.lease_amount === "number"`.
 *
 * `POST /litLease` does **not** go through `/sendTx`. Its `tx_info` is a signed transaction posted
 * as a form field, and the response is a `TxHash` — owned by `./transaction.js`.
 *
 * Types only. Nothing in this file runs.
 */

import type { Cursored, EpochMs, ResultCode } from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Entries                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Lifecycle of a lease. `waiting_fee` is the pre-settlement state; `canceled` populates `error`. */
export type LeaseStatus = "waiting_fee" | "leased" | "expired" | "canceled";

/**
 * One lease, most recent first from `GET /api/v1/leases`.
 *
 * **`lease_amount` and `fee_amount` are integers in raw LIT units**, where `1 LIT = 100000000`
 * (scale `1e-8`). They are a count of indivisible units, not a fractional quantity, so they are not
 * decimal strings — but they are `int64` on the server and `JSON.parse` rounds silently above
 * `2^53 − 1`, which a lease of more than ~90 million LIT would reach. Convert through the
 * fixed-point helpers in `src/util/decimal.ts` before displaying; never multiply them as floats
 * (`docs/decisions.md` D7, `spec/05-rest-api.md` §2.4).
 *
 * The server computes the fee itself, with integer arithmetic:
 * `fee = lease_amount × (annual_rate × 100) × duration_days / (360 × 10000)`.
 */
export interface LeaseEntry {
  id?: number;
  master_account_index?: number;
  /** Raw LIT units (`1 LIT = 1e8`), as an **integer**. See the note on {@link LeaseEntry}. */
  lease_amount?: number;
  /** Raw LIT units, as an **integer**. Computed server-side from the amount and duration. */
  fee_amount?: number;
  /**
   * Epoch milliseconds, per the server's own field annotation. `spec/08-extras-and-dx.md` §A′5
   * reads this as seconds; the annotation is first-party and wins, but the two disagree and a live
   * capture should settle it — a value near `1.7e12` is milliseconds, near `1.7e9` is seconds.
   */
  start?: EpochMs;
  /** Epoch milliseconds. Same caveat as {@link LeaseEntry.start}. */
  end?: EpochMs;
  status?: LeaseStatus;
  /** Why the lease was canceled. An empty string — not absent — when nothing went wrong. */
  error?: string;
}

/**
 * One available lease tier, from `GET /api/v1/leaseOptions`, sorted by duration descending.
 *
 * `annual_rate` is a **percentage as a float**: `25.0` means 25%. It is a rate, not an amount, and
 * the server multiplies by `annual_rate × 100` in integer arithmetic when it computes the fee — so
 * do not re-derive a fee from this in floating point.
 */
export interface LeaseOptionEntry {
  duration_days?: number;
  /** Float-derived percentage, e.g. `25.0` for 25%. Must not feed money arithmetic. */
  annual_rate?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Response envelopes                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `GET /api/v1/leases`. Paginates with `next_cursor`, and exhaustion is the key being **absent** —
 * not `""`, not `null` (`spec/05-rest-api.md` §6). `limit` is `1..100`, default `20`.
 */
export interface RespGetLeases extends ResultCode, Cursored {
  leases?: LeaseEntry[];
}

/** `GET /api/v1/leaseOptions` — public, unpaginated. */
export interface RespGetLeaseOptions extends ResultCode {
  options?: LeaseOptionEntry[];
  /** The account that collects the leasing fee. */
  lit_incentives_account_index?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Request body                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * `POST /api/v1/litLease` — form-encoded.
 *
 * Two fields carry structure inside a string, and both are protocol requirements
 * (`spec/05-rest-api.md` §2.3):
 *
 * - `tx_info` is the signed transfer as a JSON **string**. It must begin with `{`. It is produced
 *   by the transaction layer, not assembled here, and it is submitted through this endpoint rather
 *   than through `/sendTx`.
 * - `lease_amount` is a **string** of raw LIT units (`1 LIT = 100000000`) — never a number, and
 *   never a fractional LIT quantity. `"100000000"` leases one LIT.
 *
 * `duration_days` must match one of the {@link LeaseOptionEntry} tiers exactly; the server rejects
 * anything else with a bare `invalid param`.
 */
export interface ReqLITLease {
  /** The signed transfer, as a JSON string beginning with `{`. */
  tx_info: string;
  /** Raw LIT units as a decimal string, e.g. `"100000000"` for 1 LIT. Not a number. */
  lease_amount: string;
  duration_days: number;
}
