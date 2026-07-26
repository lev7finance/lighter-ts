/**
 * Transaction, block and submission models.
 *
 * `RespSendTx` is on the write hot path: it is the only thing the SDK learns about a submitted
 * transaction synchronously, and `volume_quota_remaining` is the only quota telemetry the API
 * emits anywhere — a better rate-limit proxy than any response header.
 *
 * `Tx`, `EnrichedTx` and `Block` are not enumerated in `spec/05-rest-api.md`; they are taken from
 * `spec/openapi.snapshot.json` with every response field forced optional, which is what the Go
 * server's `omitempty` actually does (§9.2). No live capture of these exists in
 * `test/fixtures/rest/`, so the field *set* is document-derived while the optionality is not.
 *
 * Types only. Nothing in this file runs.
 */

import type { EpochMicros, EpochMs, ResultCode } from "./common.js";

/* -------------------------------------------------------------------------------------------- */
/* Transactions                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * A transaction as the chain recorded it.
 *
 * **`info` and `event_info` are JSON documents carried as strings.** They are not objects, and
 * they must never be parsed eagerly inside a model or a transport: block and account listings
 * return them by the hundred, most callers read none of them, and a failed parse on one row should
 * not fail the response.
 */
export interface Tx {
  hash?: string;
  /**
   * The transaction type discriminator — `14` create-order, `15` cancel-order, and so on. The
   * authoritative table is owned by the transaction codec (`src/tx/constants.ts`), not by this
   * file.
   */
  type?: number;
  /** A JSON document **as a string**. Parse lazily, never eagerly. */
  info?: string;
  /** A JSON document **as a string**. Parse lazily, never eagerly. */
  event_info?: string;
  status?: number;
  transaction_index?: number;
  l1_address?: string;
  account_index?: number;
  nonce?: number;
  /** Epoch milliseconds. */
  expire_at?: EpochMs;
  block_height?: number;
  /** Epoch milliseconds. */
  queued_at?: EpochMs;
  /** Epoch milliseconds. */
  executed_at?: EpochMs;
  sequence_index?: number;
  parent_hash?: string;
  api_key_index?: number;
  /** Epoch **microseconds**. */
  transaction_time?: EpochMicros;
}

/**
 * A transaction plus its L1 settlement timestamps, returned as a **top-level** response by
 * `GET /api/v1/tx`. It carries the envelope `code` for that reason — unlike the nested `Tx`
 * objects inside {@link Txs} and {@link Block}, whose embedded `code` is vestigial (§2.5).
 */
export interface EnrichedTx extends ResultCode, Tx {
  /** Epoch milliseconds. Absent until the containing block is committed on L1. */
  committed_at?: EpochMs;
  /** Epoch milliseconds. Absent until the containing block is verified on L1. */
  verified_at?: EpochMs;
}

export interface Txs extends ResultCode {
  txs?: Tx[];
}

/* -------------------------------------------------------------------------------------------- */
/* Blocks                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** A rollup block. */
export interface Block {
  commitment?: string;
  height?: number;
  state_root?: string;
  priority_operations?: number;
  on_chain_l2_operations?: number;
  pending_on_chain_operations_pub_data?: string;
  committed_tx_hash?: string;
  /** Epoch milliseconds. */
  committed_at?: EpochMs;
  verified_tx_hash?: string;
  /** Epoch milliseconds. */
  verified_at?: EpochMs;
  txs?: Tx[];
  status?: number;
  /** Transaction count. The document's `"format": "uin16"` is a typo; it is a plain integer. */
  size?: number;
}

export interface Blocks extends ResultCode {
  total?: number;
  blocks?: Block[];
}

/* -------------------------------------------------------------------------------------------- */
/* Single-value responses                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `GET /api/v1/currentHeight`. Served by the CDN on some paths — see `docs/protocol-notes.md` §8.2. */
export interface CurrentHeight extends ResultCode {
  height?: number;
}

/**
 * `GET /api/v1/nextNonce?account_index&api_key_index`.
 *
 * The nonce the *next* transaction signed by that API key must carry. It is per `(account_index,
 * api_key_index)` pair, not per account.
 */
export interface NextNonce extends ResultCode {
  nonce?: number;
}

/** A bare transaction hash response. */
export interface TxHash extends ResultCode {
  tx_hash?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Submission                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** `POST /api/v1/sendTx`. */
export interface RespSendTx extends ResultCode {
  tx_hash?: string;
  /**
   * Milliseconds. The server's estimate of how long execution will take; whether it is an absolute
   * epoch or a delay is undocumented and no capture disambiguates it. Treat it as opaque telemetry
   * rather than as a deadline.
   */
  predicted_execution_time_ms?: number;
  /**
   * The remaining volume quota for the submitting account. Undocumented, and the only quota signal
   * the API emits — surface it rather than dropping it; it is a better rate-limit proxy than
   * anything in the response headers.
   */
  volume_quota_remaining?: number;
}

/**
 * `POST /api/v1/sendTxBatch`.
 *
 * **`tx_hash` is an array here** despite the singular name — one hash per submitted transaction,
 * in submission order. This is the single most likely place to write `resp.tx_hash.slice(0, 8)`
 * and get a hash-shaped string that is actually the first eight *hashes*.
 */
export interface RespSendTxBatch extends ResultCode {
  /** One entry per transaction in the batch. Singular name, plural value. */
  tx_hash?: string[];
  /** Milliseconds; see {@link RespSendTx.predicted_execution_time_ms}. */
  predicted_execution_time_ms?: number;
  /** See {@link RespSendTx.volume_quota_remaining}. */
  volume_quota_remaining?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Request bodies                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * `POST /api/v1/sendTx`, form-encoded.
 *
 * Carries **no auth token**: authentication is the Schnorr signature inside `tx_info`. Sending an
 * `auth` field here is meaningless.
 */
export interface ReqSendTx {
  /** The transaction type discriminator; must match the type encoded inside `tx_info`. */
  tx_type: number;
  /** The signed transaction as a JSON **string**. Must begin with `{`. */
  tx_info: string;
  /**
   * Undocumented; appears on no other operation. Pass through when the caller sets it, and leave
   * the field off entirely otherwise — the server distinguishes absent from `false` on several
   * endpoints.
   */
  price_protection?: boolean;
}

/**
 * `POST /api/v1/sendTxBatch`, form-encoded.
 *
 * Both fields are **JSON encoded into strings**, and they are not the same shape: `tx_types` is a
 * JSON array of integers (`"[14,15]"`) while `tx_infos` is a JSON array of **strings**, each of
 * which is itself a JSON object (`"[\"{…}\",\"{…}\"]"`).
 *
 * The lengths must match and the batch must be non-empty. The server's error for a mismatch is
 * unhelpful, so validate locally before spending the round-trip.
 */
export interface ReqSendTxBatch {
  /** JSON array of integers, encoded as a string. */
  tx_types: string;
  /** JSON array of strings, encoded as a string. */
  tx_infos: string;
}
