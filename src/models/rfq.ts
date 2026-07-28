/**
 * Request-for-quote models and the three RFQ request bodies.
 *
 * Three shapes on this surface are counter-intuitive and all three are reproduced deliberately:
 *
 * - **`metadata` is a structured object on the response and an opaque string on the request.**
 *   {@link RFQEntry.metadata} is an {@link RFQMetadata}; {@link ReqCreateRFQ.metadata} is a
 *   serialised blob. The asymmetry is real (`spec/08-extras-and-dx.md` §A′4).
 * - **`direction` is an integer on the response and the string `'0' | '1'` on the request.** The
 *   request is form-encoded, and the server declares the field's domain as those two string
 *   literals; the response reports it as a number with the same encoding as order side, `0` bid /
 *   `1` ask.
 * - **The four single-entry `Resp*RFQ` envelopes are one type.** `create`, `get`, `update` and
 *   `respond` all return the envelope plus a whole {@link RFQEntry}, field for field
 *   (`spec/05-rest-api.md` §10.1, family I). They are aliases of {@link RespRFQ} rather than four
 *   duplicate interfaces that would drift apart on the first schema change; all four names stay
 *   exported because the route table references them individually.
 *
 * Types only. Nothing in this file runs.
 */

import type { Cursored, DecimalString, EpochMs, ResultCode } from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Literal unions                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The status a responder may set on an RFQ, on both the request and the response entry. The server
 * declares this one as a closed enum in the schema, so it is modelled closed.
 */
export type RFQResponseStatus = "acknowledged" | "liquidity_provided" | "not_interested";

/** The status the RFQ's *owner* may move it to. Strictly smaller than {@link RFQListStatus}. */
export type RFQUpdateStatus = "order_created" | "closed";

/**
 * The `status` filter accepted by `GET /rfq/list`, and the three values observed on the wire.
 *
 * {@link RFQEntry.status} is **not** typed as this union: the server declares that field as a bare
 * string, and `spec/08-extras-and-dx.md` §A′4 is explicit that it is free-form on the wire. An
 * unknown value must not break decoding.
 */
export type RFQListStatus = "opened" | "order_created" | "closed";

/* -------------------------------------------------------------------------------------------- */
/* Entries                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** The quote parameters the requester attached to an RFQ. All four are decimal strings. */
export interface RFQMetadata {
  requested_est_price?: DecimalString;
  requested_max_slippage?: DecimalString;
  requested_slippage?: DecimalString;
  worst_price?: DecimalString;
}

/** One market maker's answer to an RFQ. */
export interface RFQResponseEntry {
  account_index?: number;
  status?: RFQResponseStatus;
  /** Epoch milliseconds. */
  responded_at?: EpochMs;
  /** Epoch milliseconds. */
  updated_at?: EpochMs;
}

/**
 * A request for quote.
 *
 * `base_amount` and `quote_amount` are decimal **strings** — one of them is set, depending on which
 * side the requester sized (`docs/decisions.md` D7).
 */
export interface RFQEntry {
  id?: number;
  account_index?: number;
  market_index?: number;
  /** `0` bid / buy, `1` ask / sell — the same encoding as order side, as an integer. */
  direction?: number;
  base_amount?: DecimalString;
  quote_amount?: DecimalString;
  /**
   * Free-form on the wire. {@link RFQListStatus} names the three values seen so far and keeps them
   * in autocomplete; the `string` arm keeps an unrecognised server value from breaking decoding,
   * which is what `spec/08-extras-and-dx.md` §A′4 asks for.
   */
  status?: RFQListStatus | (string & {});
  /** A structured object here; the *request* field of the same name is a serialised string. */
  metadata?: RFQMetadata;
  responses?: RFQResponseEntry[];
  /** Epoch milliseconds. */
  created_at?: EpochMs;
  /** Epoch milliseconds. */
  updated_at?: EpochMs;
}

/* -------------------------------------------------------------------------------------------- */
/* Response envelopes                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * The single-entry RFQ response: the envelope with an {@link RFQEntry} flattened into it — the
 * entry's fields sit at the top level, not under a key.
 *
 * `RespCreateRFQ`, `RespGetRFQ`, `RespUpdateRFQ` and `RespRespondToRFQ` are all aliases of this.
 */
export interface RespRFQ extends ResultCode, RFQEntry {}

/** `POST /api/v1/rfq/create`. Structurally identical to every other single-entry RFQ response. */
export type RespCreateRFQ = RespRFQ;

/** `GET /api/v1/rfq/get`. */
export type RespGetRFQ = RespRFQ;

/** `POST /api/v1/rfq/update`. */
export type RespUpdateRFQ = RespRFQ;

/** `POST /api/v1/rfq/respond`. */
export type RespRespondToRFQ = RespRFQ;

/**
 * `GET /api/v1/rfq/list`. Paginates with `next_cursor`; exhaustion is the key being **absent**
 * (`spec/05-rest-api.md` §6). `limit` defaults to `20` here, not to the usual `100`.
 */
export interface RespListRFQs extends ResultCode, Cursored {
  rfqs?: RFQEntry[];
}

/* -------------------------------------------------------------------------------------------- */
/* Request bodies                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * `POST /api/v1/rfq/create` — form-encoded.
 *
 * `direction` is the **string** `'0'` or `'1'`, not a number: that is the domain the server
 * declares for the form field, and the response reports the same value as an integer.
 * `metadata` is a serialised blob here, unlike {@link RFQEntry.metadata}.
 *
 * Exactly one of `base_amount` / `quote_amount` is meaningful — the server takes whichever side the
 * caller sized — and both are decimal strings.
 */
export interface ReqCreateRFQ {
  market_index: number;
  direction: "0" | "1";
  base_amount?: DecimalString;
  quote_amount?: DecimalString;
  metadata?: string;
}

/** `POST /api/v1/rfq/respond` — a market maker's answer. */
export interface ReqRespondToRFQ {
  rfq_id: number;
  status: RFQResponseStatus;
}

/**
 * `POST /api/v1/rfq/update` — the owner moves the RFQ on.
 *
 * `'opened'` is not accepted here: an RFQ opens on creation and can only move forward.
 */
export interface ReqUpdateRFQ {
  rfq_id: number;
  status: RFQUpdateStatus;
}
