/**
 * `src/client/submit.ts` — the lifecycle, the wire shapes, and the four outcomes.
 *
 * The assertions here are deliberately byte-level. A structural assertion cannot tell `[14,15]`
 * from `"[14,15]"`, and the difference between those two is a batch the server rejects; likewise a
 * `tx_info` that is an object on one envelope and a string on another. So the HTTP body is compared
 * as an exact string and the WebSocket frames are inspected for the *type* of each field.
 *
 * The nonce assertions are counts, not shapes: "exactly one rollback", "zero resyncs". The failure
 * this unit exists to prevent — rolling a lease back after a network timeout, so the next
 * transaction reuses a nonce that may already be sequenced — is invisible to any assertion that
 * only checks the error that came out.
 *
 * Nothing here touches the network: `fetch` is injected into a real `LighterRestClient`, so the
 * real form encoder, the real success rule and the real retry policy are all exercised.
 */

import { describe, expect, test } from "bun:test";

import { ApiKey } from "../../src/crypto/key.js";
import {
  LighterApiError,
  LighterConfigError,
  LighterTransportError,
  LighterValidationError,
} from "../../src/errors.js";
import { LighterRestClient } from "../../src/rest/client.js";
import { i16, i64, u8, u32 } from "../../src/tx/brands.js";
import type { UnsignedTx } from "../../src/tx/build.js";
import { buildCancelOrder, buildCreateOrder } from "../../src/tx/build.js";
import { toTxInfo, txHashHex } from "../../src/tx/pipeline.js";
import type { WsFrameChannel } from "../../src/ws/client.js";
import { createTxDispatcher } from "../../src/ws/send-tx.js";
import { createLease } from "../../src/client/nonce/types.js";
import type {
  NonceLease,
  NonceSnapshot,
  NonceSource,
  NonceSourceKind,
} from "../../src/client/nonce/types.js";
import { createOutcomeClassifier } from "../../src/client/nonce/types.js";
import type { TxReceipt } from "../../src/client/receipt.js";
import type { SubmitContext, WsTxSubmitter } from "../../src/client/submit.js";
import {
  parseTxInfoDocument,
  prepareTx,
  submit,
  submitBatch,
} from "../../src/client/submit.js";

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** `conformance/vectors/tx.json`'s signing key, recovered in `test/tx/pipeline.test.ts`. */
const KEY_HEX: string =
  "8ab9c4b4c64520db1a401ab8b355b12daf8c2e1d344069b3b4d1ca6770dde7ce593aa7f95f44bb6a";

const CHAIN_ID: 304 = 304;

/** A domain code chosen by the *caller*, since no capture has produced the real one yet. */
const INVALID_NONCE_CODE: 21_120 = 21_120;

const KEY: ApiKey = ApiKey.fromPrivateKey(KEY_HEX);

/** A fixed expiry, so nothing here depends on a clock. */
const EXPIRED_AT: bigint = 1_893_456_000_000n;

function anOrder(clientOrderIndex: bigint = 100n): UnsignedTx {
  return buildCreateOrder(
    {
      marketIndex: i16(1),
      clientOrderIndex: i64(clientOrderIndex),
      baseAmount: i64(1_000_000n),
      price: u32(250_000),
      isAsk: u8(0),
      orderType: u8(0),
      timeInForce: u8(1),
      reduceOnly: u8(0),
      triggerPrice: u32(0),
      orderExpiry: i64(EXPIRED_AT),
    },
    { accountIndex: i64(1n), apiKeyIndex: u8(0), nonce: i64(0n), expiredAt: i64(EXPIRED_AT) },
  );
}

/** A cancel, whose `Index` is above 2^53 — the value `JSON.parse` would round. */
function aWideCancel(): UnsignedTx {
  return buildCancelOrder(
    { marketIndex: i16(1), index: i64(1_152_921_504_606_846_975n) },
    { accountIndex: i64(1n), apiKeyIndex: u8(0), nonce: i64(0n), expiredAt: i64(EXPIRED_AT) },
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Fakes                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

interface FakeHttp {
  readonly rest: LighterRestClient;
  readonly calls: Call[];
}

/** A `LighterRestClient` over an injected `fetch`, so the real encoder and classifier both run. */
function fakeHttp(
  respond: (call: Call, index: number) => { status?: number; body: unknown } | Error,
): FakeHttp {
  const calls: Call[] = [];
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = (init?.headers ?? {}) as Record<string, string>;
    // Header names are case-insensitive on the wire; the transport spells this one `Content-Type`.
    const contentType: string | undefined = Object.entries(headers).find(
      ([name]: [string, string]): boolean => name.toLowerCase() === "content-type",
    )?.[1];
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      contentType,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const answer: { status?: number; body: unknown } | Error = respond(call, calls.length - 1);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    calls,
    rest: new LighterRestClient({
      endpoint: "mainnet",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }),
  };
}

/**
 * A nonce source that counts what was done to it.
 *
 * The three counters are the acceptance criteria: one rollback on a rejection, one resync and no
 * rollback on an invalid nonce, neither on a timeout.
 */
class CountingNonceSource implements NonceSource {
  readonly kind: NonceSourceKind = "optimistic";
  next: bigint = 0n;
  key: number = 3;
  leases: number = 0;
  commits: number = 0;
  rollbacks: number = 0;
  resyncs: number = 0;
  releases: number = 0;
  /** Set to make the second and later allocations jump, i.e. an interleaving caller. */
  stride: bigint = 1n;

  lease(preferKey?: number): Promise<NonceLease> {
    this.leases += 1;
    const nonce: bigint = this.next;
    this.next += this.stride;
    return Promise.resolve(
      createLease({
        apiKeyIndex: preferKey ?? this.key,
        nonce,
        onCommit: (): void => {
          this.commits += 1;
        },
        onRollback: (): void => {
          this.rollbacks += 1;
          this.next -= this.stride;
        },
        onRelease: (): void => {
          this.releases += 1;
        },
      }),
    );
  }

  resync(_apiKeyIndex: number): Promise<void> {
    this.resyncs += 1;
    return Promise.resolve();
  }

  snapshot(): NonceSnapshot {
    return { version: 1, kind: this.kind, accountIndex: 1, keys: [] };
  }

  restore(_s: NonceSnapshot): void {
    /* nothing to restore */
  }
}

interface Ctx {
  readonly ctx: SubmitContext;
  readonly http: FakeHttp;
  readonly nonces: CountingNonceSource;
}

function contextOver(http: FakeHttp, overrides: Partial<SubmitContext> = {}): Ctx {
  const nonces: CountingNonceSource =
    (overrides.nonces as CountingNonceSource | undefined) ?? new CountingNonceSource();
  return {
    http,
    nonces,
    ctx: {
      chainId: CHAIN_ID,
      accountIndex: 1n,
      rest: http.rest,
      nonces,
      keys: new Map<number, ApiKey>([
        [0, KEY],
        [3, KEY],
      ]),
      channel: "http",
      classify: createOutcomeClassifier([INVALID_NONCE_CODE]),
      ...overrides,
    },
  };
}

/** A `sendTx` response that accepts, echoing no hash — the local digest is authoritative. */
function acceptingSendTx(): { body: unknown } {
  return {
    body: {
      code: 200,
      predicted_execution_time_ms: 120,
      volume_quota_remaining: 9_000,
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* HTTP request shapes                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe("sendTx over HTTP", () => {
  test("posts a form body whose tx_type is a decimal string and tx_info the serialized JSON", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx } = contextOver(http);
    const receipt: TxReceipt = await submit(ctx, anOrder());

    expect(http.calls).toHaveLength(1);
    const call: Call = http.calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://mainnet.zklighter.elliot.ai/api/v1/sendTx");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");

    // The exact bytes: `tx_type` first, then the percent-encoded document. Nothing else.
    const params: URLSearchParams = new URLSearchParams(call.body);
    expect([...params.keys()]).toEqual(["tx_type", "tx_info"]);
    expect(params.get("tx_type")).toBe("14");
    expect(params.get("tx_info")).toBe(receipt.txInfo);
    expect(receipt.txInfo.startsWith("{")).toBe(true);
    expect(call.body.startsWith("tx_type=14&tx_info=%7B")).toBe(true);
  });

  test("price_protection is absent unless the caller sets it", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx } = contextOver(http);
    await submit(ctx, anOrder());
    expect(http.calls[0]?.body).not.toContain("price_protection");

    await submit(ctx, anOrder(), { priceProtection: true });
    expect(http.calls[1]?.body).toContain("price_protection=true");
  });

  test("the receipt carries the locally computed hash and the server's telemetry", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    const receipt: TxReceipt = await submit(ctx, anOrder());
    expect(receipt.txHash).toMatch(/^0x[0-9a-f]{80}$/);
    expect(receipt.predictedExecutionTimeMs).toBe(120);
    expect(receipt.volumeQuotaRemaining).toBe(9_000n);
    expect(receipt.nonce).toBe(0n);
    expect(receipt.apiKeyIndex).toBe(nonces.key);
  });

  test("the lease's nonce and key are what the transaction is signed with", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    nonces.next = 41n;
    nonces.key = 0;
    const receipt: TxReceipt = await submit(ctx, anOrder());
    const document: Record<string, unknown> = parseTxInfoDocument(receipt.txInfo);
    expect(document["Nonce"]).toBe(41n);
    expect(document["ApiKeyIndex"]).toBe(0n);
  });
});

describe("sendTxBatch over HTTP", () => {
  test("tx_types is \"[14,15]\" and tx_infos a JSON array of strings", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: { code: 200, tx_hash: [], predicted_execution_time_ms: 1, volume_quota_remaining: 2 },
    }));
    const { ctx } = contextOver(http);
    const receipts: TxReceipt[] = await submitBatch(ctx, [anOrder(), aWideCancel()]);

    expect(http.calls).toHaveLength(1);
    const call: Call = http.calls[0] as Call;
    expect(call.url).toBe("https://mainnet.zklighter.elliot.ai/api/v1/sendTxBatch");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");

    const params: URLSearchParams = new URLSearchParams(call.body);
    expect(params.get("tx_types")).toBe("[14,15]");

    const infos: unknown = JSON.parse(params.get("tx_infos") ?? "");
    expect(Array.isArray(infos)).toBe(true);
    // An array of *strings*, each of which is itself a JSON object.
    expect((infos as unknown[]).every((i: unknown): boolean => typeof i === "string")).toBe(true);
    expect(infos).toEqual([receipts[0]?.txInfo, receipts[1]?.txInfo]);
  });

  test("one key, consecutive nonces — structurally, not by documentation", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200, tx_hash: [] } }));
    const { ctx, nonces } = contextOver(http);
    nonces.next = 7n;
    const receipts: TxReceipt[] = await submitBatch(ctx, [anOrder(1n), anOrder(2n), anOrder(3n)]);
    expect(receipts.map((r: TxReceipt): bigint => r.nonce)).toEqual([7n, 8n, 9n]);
    expect(new Set(receipts.map((r: TxReceipt): number => r.apiKeyIndex)).size).toBe(1);
    expect(nonces.commits).toBe(3);
  });

  test("a source that cannot produce consecutive slots aborts before anything is signed", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx, nonces } = contextOver(http);
    // Two allocations that jump: exactly what the `server` strategy does, and what an interleaving
    // caller looks like.
    nonces.stride = 2n;
    await expect(submitBatch(ctx, [anOrder(1n), anOrder(2n)])).rejects.toThrow(/consecutive/);
    expect(http.calls).toHaveLength(0);
    // Both slots handed back, newest first.
    expect(nonces.rollbacks).toBe(2);
    expect(nonces.next).toBe(0n);
  });

  test("an empty batch and an over-long one are refused locally", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx } = contextOver(http);
    await expect(submitBatch(ctx, [])).rejects.toThrow(LighterValidationError);
    const sixteen: UnsignedTx[] = Array.from({ length: 16 }, (_v, i: number) => anOrder(BigInt(i + 1)));
    await expect(submitBatch(ctx, sixteen)).rejects.toThrow(/at most 15/);
    expect(http.calls).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* WebSocket request shapes                                                                         */
/* ---------------------------------------------------------------------------------------------- */

interface FakeWs {
  readonly submitter: WsTxSubmitter;
  readonly frames: Record<string, unknown>[];
  readonly timers: number;
}

/**
 * A real `createTxDispatcher` over a fake frame channel.
 *
 * Using the real dispatcher is the point: the frame spelling is its decision, and asserting against
 * a hand-built frame would only test the test.
 */
function fakeWs(ack: (frame: Record<string, unknown>) => Record<string, unknown>): FakeWs {
  const frames: Record<string, unknown>[] = [];
  let tap: ((f: Record<string, unknown>) => boolean) | undefined;
  const channel: WsFrameChannel = {
    readOnly: false,
    sendFrame(frame: object): void {
      frames.push(frame as Record<string, unknown>);
      // Answered on the microtask queue, so the dispatcher has finished registering — the same
      // ordering a real socket produces.
      queueMicrotask((): void => {
        tap?.(ack(frame as Record<string, unknown>));
      });
    },
    onFrame(handler: (f: Record<string, unknown>) => boolean): () => void {
      tap = handler;
      return (): void => {
        tap = undefined;
      };
    },
    onReconnect(): () => void {
      return (): void => undefined;
    },
  };
  return {
    frames,
    timers: 0,
    submitter: createTxDispatcher(channel, {
      // No wall-clock timer is left behind by a test.
      timers: {
        setTimeout: (): number => 0,
        clearTimeout: (): void => undefined,
      },
    }),
  };
}

/** Read `data.<key>` off a frame the dispatcher built. */
function frameData(frame: Record<string, unknown>): Record<string, unknown> {
  return frame["data"] as Record<string, unknown>;
}

describe("sendTx over WebSocket", () => {
  test("nests tx_info as a parsed object, not a string", async () => {
    const ws: FakeWs = fakeWs((frame: Record<string, unknown>) => ({
      type: "jsonapi/sendtx",
      data: { id: frameData(frame)["id"], code: 200 },
    }));
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx } = contextOver(http, { channel: "ws", ws: (): WsTxSubmitter => ws.submitter });

    await submit(ctx, anOrder());
    expect(http.calls).toHaveLength(0);
    expect(ws.frames).toHaveLength(1);

    const data: Record<string, unknown> = frameData(ws.frames[0] as Record<string, unknown>);
    expect(ws.frames[0]?.["type"]).toBe("jsonapi/sendtx");
    expect(data["tx_type"]).toBe(14);
    expect(typeof data["tx_info"]).toBe("object");
    expect(typeof data["tx_info"]).not.toBe("string");
  });

  test("an int64 field survives the object embedding as a bigint, not a rounded double", async () => {
    const ws: FakeWs = fakeWs((frame: Record<string, unknown>) => ({
      type: "jsonapi/sendtx",
      data: { id: frameData(frame)["id"], code: 200 },
    }));
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx } = contextOver(http, { channel: "ws", ws: (): WsTxSubmitter => ws.submitter });

    await submit(ctx, aWideCancel());
    const info: Record<string, unknown> = frameData(ws.frames[0] as Record<string, unknown>)[
      "tx_info"
    ] as Record<string, unknown>;
    expect(info["Index"]).toBe(1_152_921_504_606_846_975n);
    // What `JSON.parse` would have produced instead.
    expect(info["Index"]).not.toBe(1_152_921_504_606_847_000 as unknown as bigint);
  });

  test("a non-200 ack becomes a typed API error carrying the raw code", async () => {
    const ws: FakeWs = fakeWs((frame: Record<string, unknown>) => ({
      type: "jsonapi/sendtx",
      data: { id: frameData(frame)["id"], code: 20001, message: "invalid param " },
    }));
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx, nonces } = contextOver(http, {
      channel: "ws",
      ws: (): WsTxSubmitter => ws.submitter,
    });
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterApiError);
    expect(nonces.rollbacks).toBe(1);
  });
});

describe("sendTxBatch over WebSocket", () => {
  test("passes both fields as JSON-encoded strings", async () => {
    const ws: FakeWs = fakeWs((frame: Record<string, unknown>) => ({
      type: "jsonapi/sendtxbatch",
      data: { id: frameData(frame)["id"], code: 200 },
    }));
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx } = contextOver(http, { channel: "ws", ws: (): WsTxSubmitter => ws.submitter });

    await submitBatch(ctx, [anOrder(1n), anOrder(2n)]);
    const data: Record<string, unknown> = frameData(ws.frames[0] as Record<string, unknown>);
    expect(ws.frames[0]?.["type"]).toBe("jsonapi/sendtxbatch");
    expect(typeof data["tx_types"]).toBe("string");
    expect(typeof data["tx_infos"]).toBe("string");
    expect(data["tx_types"]).toBe("[14,14]");
  });

  test("the batch payload's inner shape is the WS unit's, and is pinned here so a change is visible", async () => {
    const ws: FakeWs = fakeWs((frame: Record<string, unknown>) => ({
      type: "jsonapi/sendtxbatch",
      data: { id: frameData(frame)["id"], code: 200 },
    }));
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200 } }));
    const { ctx } = contextOver(http, { channel: "ws", ws: (): WsTxSubmitter => ws.submitter });

    await submitBatch(ctx, [anOrder(1n)]);
    const infos: string = frameData(ws.frames[0] as Record<string, unknown>)["tx_infos"] as string;
    // `spec/06-websocket.md` §8.2 renders `tx_infos` as an array of *objects*; §5.2 of
    // `spec/07-high-level-client.md` renders it as an array of *strings*, mirroring the form
    // encoding. The two specs disagree, neither is backed by a capture, and the frame's spelling
    // belongs to `src/ws/send-tx.ts` — which chose §8.2. Pinned rather than argued: if a capture
    // settles it the other way, this assertion is the thing that has to change.
    expect(infos.startsWith('[{"')).toBe(true);
    // Either way the int64 fields survive: they are bare integer literals, not rounded doubles.
    expect(infos).toContain('"OrderExpiry":1893456000000');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Outcome classification — the reason this unit is high risk                                       */
/* ---------------------------------------------------------------------------------------------- */

describe("outcome classification", () => {
  test("a rejection rolls back exactly one slot and resyncs nothing", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 400,
      body: { code: 20001, message: "invalid param " },
    }));
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterApiError);
    expect(nonces.rollbacks).toBe(1);
    expect(nonces.resyncs).toBe(0);
    expect(nonces.commits).toBe(0);
    expect(nonces.releases).toBe(1);
    // The slot went back, so the next send reuses it.
    expect(nonces.next).toBe(0n);
  });

  test("an invalid nonce resyncs exactly once and rolls nothing back", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 400,
      body: { code: INVALID_NONCE_CODE, message: "invalid nonce" },
    }));
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterApiError);
    expect(nonces.resyncs).toBe(1);
    expect(nonces.rollbacks).toBe(0);
    expect(nonces.commits).toBe(0);
  });

  test("a network timeout rolls back nothing, resyncs nothing, and burns the slot", async () => {
    const http: FakeHttp = fakeHttp((): Error => new TypeError("network error"));
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterTransportError);
    expect(nonces.rollbacks).toBe(0);
    expect(nonces.resyncs).toBe(0);
    expect(nonces.commits).toBe(0);
    // The transaction may already be in the mempool, so the next send must move on.
    expect(nonces.next).toBe(1n);
  });

  test("the send after a timeout uses the following nonce", async () => {
    let first: boolean = true;
    const http: FakeHttp = fakeHttp((): { body: unknown } | Error => {
      if (first) {
        first = false;
        return new TypeError("connection reset");
      }
      return { body: { code: 200 } };
    });
    const { ctx } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterTransportError);
    const receipt: TxReceipt = await submit(ctx, anOrder());
    expect(receipt.nonce).toBe(1n);
  });

  test("an abort is indeterminate too — the request may already have been written", async () => {
    const http: FakeHttp = fakeHttp((): Error => {
      const abort: Error = new Error("aborted");
      abort.name = "AbortError";
      return abort;
    });
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow();
    expect(nonces.rollbacks).toBe(0);
    expect(nonces.resyncs).toBe(0);
  });

  test("a local validation failure rolls back: nothing was ever sent", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    // No key for the index the lease will hand out.
    const stripped: SubmitContext = { ...ctx, keys: new Map<number, ApiKey>([[9, KEY]]) };
    await expect(submit(stripped, anOrder())).rejects.toThrow(/no private key/);
    expect(http.calls).toHaveLength(0);
    expect(nonces.rollbacks).toBe(1);
    expect(nonces.releases).toBe(1);
  });

  test("success commits, and releases exactly once", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    await submit(ctx, anOrder());
    expect(nonces.commits).toBe(1);
    expect(nonces.rollbacks).toBe(0);
    expect(nonces.releases).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The success rule, and retries                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("success is HTTP-status-first", () => {
  test("a 200 body with no code field at all is success", async () => {
    // The `/withdrawalDelay` shape: measured, and the reason "code === 200" cannot be the rule.
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { seconds: 1542 } }));
    const { ctx, nonces } = contextOver(http);
    const receipt: TxReceipt = await submit(ctx, anOrder());
    expect(receipt.txHash).toMatch(/^0x[0-9a-f]{80}$/);
    expect(nonces.commits).toBe(1);
  });

  test("a 200 body carrying code 20001 is an error", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 200,
      body: { code: 20001, message: "invalid param " },
    }));
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterApiError);
    expect(nonces.rollbacks).toBe(1);
  });
});

describe("sendTx is never retried", () => {
  test("a retryable transport failure produces exactly one fetch", async () => {
    const http: FakeHttp = fakeHttp((): Error => new TypeError("fetch failed"));
    const { ctx } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterTransportError);
    expect(http.calls).toHaveLength(1);
  });

  test("a 503 — the most retryable status there is — produces exactly one fetch", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 503,
      body: { code: 50000, message: "unavailable" },
    }));
    const { ctx } = contextOver(http);
    await expect(submit(ctx, anOrder())).rejects.toThrow(LighterApiError);
    expect(http.calls).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Integrity                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe("the returned tx_hash is asserted against the local digest", () => {
  test("a matching hash in the other spelling is accepted", async () => {
    // The server echoes 0x-prefixed uppercase; the SDK computes bare lowercase.
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: { code: 200, tx_hash: `0x${hashOfSubmittedOrder().toUpperCase()}` },
    }));
    const { ctx } = contextOver(http);
    const receipt: TxReceipt = await submit(ctx, anOrder());
    expect(receipt.txHash).toBe(`0x${hashOfSubmittedOrder()}` as `0x${string}`);
  });

  test("a different hash raises, and the error names both", async () => {
    const wrong: string = `f${"0".repeat(79)}`;
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({
      body: { code: 200, tx_hash: wrong },
    }));
    const { ctx, nonces } = contextOver(http);
    let message: string = "";
    try {
      await submit(ctx, anOrder());
    } catch (e: unknown) {
      message = (e as Error).message;
    }
    expect(message).toContain(wrong);
    expect(message).toContain(hashOfSubmittedOrder());
    // The server accepted it; a hash mismatch is a local integrity failure, and the classifier
    // reads a validation error as "never reached the sequencer's state".
    expect(nonces.rollbacks).toBe(1);
  });
});

/** The hash of `anOrder()` as the submit path stamps it: nonce 0, key 3. */
function hashOfSubmittedOrder(): string {
  const stamped: UnsignedTx = Object.freeze({
    ...(anOrder() as object),
    nonce: i64(0n),
    apiKeyIndex: u8(3),
  }) as unknown as UnsignedTx;
  return txHashHex(stamped, CHAIN_ID);
}

/* ---------------------------------------------------------------------------------------------- */
/* Caller-managed mode                                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe("caller-managed mode", () => {
  test("an explicit nonce and key bypass the source entirely", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    const receipt: TxReceipt = await submit(ctx, anOrder(), { nonce: 22n, apiKeyIndex: 0 });
    expect(receipt.nonce).toBe(22n);
    expect(receipt.apiKeyIndex).toBe(0);
    expect(nonces.leases).toBe(0);
    expect(nonces.commits).toBe(0);
    expect(nonces.rollbacks).toBe(0);
  });

  test("half-managed is refused: one of the two is never enough", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx } = contextOver(http);
    await expect(submit(ctx, anOrder(), { nonce: 22n })).rejects.toThrow(LighterConfigError);
    await expect(submit(ctx, anOrder(), { apiKeyIndex: 0 })).rejects.toThrow(LighterConfigError);
    expect(http.calls).toHaveLength(0);
  });

  test("a batch's explicit nonce is the first of a consecutive run", async () => {
    const http: FakeHttp = fakeHttp((): { body: unknown } => ({ body: { code: 200, tx_hash: [] } }));
    const { ctx, nonces } = contextOver(http);
    const receipts: TxReceipt[] = await submitBatch(ctx, [anOrder(1n), anOrder(2n)], {
      nonce: 22n,
      apiKeyIndex: 0,
    });
    expect(receipts.map((r: TxReceipt): bigint => r.nonce)).toEqual([22n, 23n]);
    expect(nonces.leases).toBe(0);
  });

  test("an invalid nonce in caller-managed mode still resyncs exactly once", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 400,
      body: { code: INVALID_NONCE_CODE, message: "invalid nonce" },
    }));
    const { ctx, nonces } = contextOver(http);
    await expect(submit(ctx, anOrder(), { nonce: 5n, apiKeyIndex: 0 })).rejects.toThrow(
      LighterApiError,
    );
    expect(nonces.resyncs).toBe(1);
    expect(nonces.rollbacks).toBe(0);
  });
});

describe("prepare", () => {
  test("signs with the leased identity and spends the slot", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    nonces.next = 12n;
    const signed = await prepareTx(ctx, anOrder());
    expect(signed.sig).toBeInstanceOf(Uint8Array);
    expect(signed.nonce as bigint).toBe(12n);
    // Released without a commit or a rollback: the caller holds a transaction carrying that nonce.
    expect(nonces.releases).toBe(1);
    expect(nonces.commits).toBe(0);
    expect(nonces.rollbacks).toBe(0);
    expect(nonces.next).toBe(13n);
    expect(http.calls).toHaveLength(0);
  });

  test("a signing failure returns the slot", async () => {
    const http: FakeHttp = fakeHttp(acceptingSendTx);
    const { ctx, nonces } = contextOver(http);
    const stripped: SubmitContext = { ...ctx, keys: new Map<number, ApiKey>() };
    await expect(prepareTx(stripped, anOrder())).rejects.toThrow(/no private key/);
    expect(nonces.rollbacks).toBe(1);
    expect(nonces.releases).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* tx_info decoding                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

describe("parseTxInfoDocument", () => {
  test("round-trips every field of a real document, integers included", () => {
    const info: string = toTxInfo(
      Object.freeze({ ...(aWideCancel() as object), sig: new Uint8Array(80).fill(7) }) as never,
    );
    const document: Record<string, unknown> = parseTxInfoDocument(info);
    expect(document["Index"]).toBe(1_152_921_504_606_846_975n);
    expect(document["ExpiredAt"]).toBe(EXPIRED_AT);
    expect(typeof document["Sig"]).toBe("string");
    expect(document["L2TxAttributes"]).toBeNull();
  });

  test("keeps a base64 signature and a byte array intact", () => {
    const parsed: Record<string, unknown> = parseTxInfoDocument(
      '{"Sig":"AAA/+w==","Memo":[1,0,255],"L1Sig":"0xab","Nested":{"A":1}}',
    );
    expect(parsed["Sig"]).toBe("AAA/+w==");
    expect(parsed["Memo"]).toEqual([1n, 0n, 255n]);
    expect(parsed["L1Sig"]).toBe("0xab");
    expect(parsed["Nested"]).toEqual({ A: 1n } as unknown as Record<string, unknown>);
  });

  test("handles escapes and negative integers", () => {
    const parsed: Record<string, unknown> = parseTxInfoDocument(
      '{"A":"a\\"b\\\\","B":-42,"C":null,"D":true}',
    );
    expect(parsed["A"]).toBe('a"b\\');
    expect(parsed["B"]).toBe(-42n);
    expect(parsed["C"]).toBeNull();
    expect(parsed["D"]).toBe(true);
  });

  test("refuses anything that is not a single JSON object", () => {
    expect(() => parseTxInfoDocument("[1,2]")).toThrow(LighterValidationError);
    expect(() => parseTxInfoDocument('"a string"')).toThrow(LighterValidationError);
    expect(() => parseTxInfoDocument("{} {}")).toThrow(LighterValidationError);
    expect(() => parseTxInfoDocument("{")).toThrow(LighterValidationError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Secrets                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("no secret material escapes", () => {
  test("neither the message nor toJSON of any raised error contains a private key", async () => {
    const http: FakeHttp = fakeHttp((): { status: number; body: unknown } => ({
      status: 400,
      body: { code: 20001, message: "invalid param " },
    }));
    const { ctx } = contextOver(http);
    const raised: unknown[] = [];
    for (const attempt of [
      (): Promise<unknown> => submit(ctx, anOrder()),
      (): Promise<unknown> => submit(ctx, anOrder(), { nonce: 1n }),
      (): Promise<unknown> => submit({ ...ctx, keys: new Map() }, anOrder()),
      (): Promise<unknown> => submitBatch(ctx, []),
    ]) {
      await attempt().catch((e: unknown): void => {
        raised.push(e);
      });
    }
    expect(raised).toHaveLength(4);
    for (const error of raised) {
      const text: string = `${(error as Error).message}\n${JSON.stringify(
        (error as { toJSON?: () => unknown }).toJSON?.() ?? {},
      )}`;
      expect(text).not.toContain(KEY_HEX);
      expect(text).not.toContain(KEY_HEX.slice(0, 16));
    }
  });
});
