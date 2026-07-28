/**
 * Evidence-only WebSocket capture harness for issue #1.
 *
 * This file intentionally imports neither the SDK nor any package. Network I/O
 * is performed with the two web globals and filesystem I/O with Bun's built-ins.
 *
 *   bun run scripts/capture-ws-fixtures.ts --host mainnet.zklighter.elliot.ai
 *   bun run scripts/capture-ws-fixtures.ts --verify
 */

export {};

const SCRIPT_VERSION = "2";
const DEFAULT_OUT = "test/fixtures/ws";
const PUBLIC_FAMILIES = [
  "order_book",
  "ticker",
  "market_stats",
  "spot_market_stats",
  "trade",
  "candle",
  "mark_price_candle",
  "height",
  "account_all",
  "user_stats",
  "account_all_trades",
  "account_all_positions",
] as const;
const AUTH_FAMILIES = [
  "account_market",
  "account_tx",
  "account_all_orders",
  "account_orders",
  "account_all_assets",
  "account_spot_avg_entry_prices",
  "pool_data",
  "pool_info",
  "notification",
  "rfq",
] as const;
const ERROR_CASES = [
  "duplicate-subscribe",
  "unknown-unsubscribe",
  "unknown-channel",
  "invalid-type",
  "invalid-json",
  "invalid-auth",
] as const;

type Direction = "in" | "out";
type Frame = {
  dir: Direction;
  tMs: number;
  wallMs: number;
  raw: string;
};
type CloseObservation = {
  tMs: number;
  wallMs: number;
  code: number;
  reason: string;
  wasClean: boolean;
};
type Session = {
  label: string;
  url: string;
  opened: boolean;
  frames: Frame[];
  close: CloseObservation | null;
  binaryFrames: Array<{ tMs: number; wallMs: number; byteLength: number }>;
  errorEvent: boolean;
  expectedDurationMs: number;
  observedDurationMs: number;
  endCause: "duration" | "stop-condition" | "server-close" | "binary";
};
type SessionHooks = {
  onOpen?: (session: ActiveSession) => void;
  onConnected?: (session: ActiveSession) => void;
  onMessage?: (raw: string, session: ActiveSession) => void;
  stopWhen?: (raw: string, session: ActiveSession) => boolean;
};
type SessionOptions = SessionHooks & {
  label: string;
  url: string;
  durationMs: number;
  answerPings?: boolean;
};
type ActiveSession = {
  readonly frames: Frame[];
  sendRaw(raw: string, persistedRaw?: string): void;
  sendJson(value: Record<string, unknown>, authToken?: string): void;
  schedule(callback: () => void, delayMs: number): void;
  repeat(callback: () => void, intervalMs: number): void;
  finish(): void;
};
type ChannelSpec = {
  family: string;
  channels: string[];
  authRequired: boolean;
};

const Socket = globalThis.WebSocket;
const fetch_ = globalThis.fetch;

function parseCli(argv: readonly string[]): {
  flags: Set<string>;
  values: Map<string, string>;
} {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(key);
    } else {
      values.set(key, next);
      i++;
    }
  }
  return { flags, values };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function messageType(raw: string): string | undefined {
  const value = parseObject(raw);
  return typeof value?.["type"] === "string" ? value["type"] : undefined;
}

function messageChannel(raw: string): string | undefined {
  const value = parseObject(raw);
  return typeof value?.["channel"] === "string" ? value["channel"] : undefined;
}

function redactWire(raw: string, token?: string): string {
  if (token === undefined || token.length === 0) return raw;
  return raw.split(token).join("<redacted>");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, json(value));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

function streamUrl(host: string, encoded: boolean): string {
  return `wss://${host}/stream${encoded ? "?encoding=json" : ""}`;
}

function httpsStreamUrl(host: string): string {
  return `https://${host}/stream?encoding=json`;
}

function startSession(options: SessionOptions): Promise<Session> {
  return new Promise((resolve) => {
    const startedMono = performance.now();
    const frames: Frame[] = [];
    const binaryFrames: Session["binaryFrames"] = [];
    const timers: number[] = [];
    let opened = false;
    let close: CloseObservation | null = null;
    let errorEvent = false;
    let done = false;
    let endCause: Session["endCause"] = "duration";
    const ws = new Socket(options.url);

    const nowT = (): number => Math.round(performance.now() - startedMono);
    const addFrame = (dir: Direction, raw: string): void => {
      frames.push({ dir, tMs: nowT(), wallMs: Date.now(), raw });
    };
    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
    };
    const finish = (cause: Session["endCause"] = "stop-condition"): void => {
      if (done) return;
      done = true;
      endCause = cause;
      clearTimers();
      if (ws.readyState === Socket.OPEN || ws.readyState === Socket.CONNECTING) {
        try {
          ws.close(1000, "probe complete");
        } catch {
          // A concurrent server close is already captured by the close listener.
        }
      }
      setTimeout(() => {
        resolve({
          label: options.label,
          url: options.url,
          opened,
          frames,
          close,
          binaryFrames,
          errorEvent,
          expectedDurationMs: options.durationMs,
          observedDurationMs: nowT(),
          endCause,
        });
      }, 100);
    };
    const active: ActiveSession = {
      frames,
      sendRaw(raw, persistedRaw = raw): void {
        if (ws.readyState !== Socket.OPEN) return;
        addFrame("out", persistedRaw);
        ws.send(raw);
      },
      sendJson(value, authToken): void {
        const raw = JSON.stringify(value);
        this.sendRaw(raw, redactWire(raw, authToken));
      },
      schedule(callback, delayMs): void {
        timers.push(setTimeout(callback, delayMs) as unknown as number);
      },
      repeat(callback, intervalMs): void {
        timers.push(setInterval(callback, intervalMs) as unknown as number);
      },
      finish: () => finish("stop-condition"),
    };

    ws.addEventListener("open", () => {
      opened = true;
      options.onOpen?.(active);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        let byteLength = 0;
        if (event.data instanceof ArrayBuffer) byteLength = event.data.byteLength;
        else if (typeof Blob !== "undefined" && event.data instanceof Blob) byteLength = event.data.size;
        binaryFrames.push({ tMs: nowT(), wallMs: Date.now(), byteLength });
        addFrame("in", `<binary frame: ${byteLength} bytes>`);
        finish("binary");
        return;
      }
      const raw = event.data;
      addFrame("in", raw);
      const type = messageType(raw);
      if (type === "connected") options.onConnected?.(active);
      if (type === "ping" && options.answerPings !== false) {
        active.sendRaw('{"type":"pong"}');
      }
      options.onMessage?.(raw, active);
      if (options.stopWhen?.(raw, active) === true) finish("stop-condition");
    });
    ws.addEventListener("error", () => {
      errorEvent = true;
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      close = {
        tMs: nowT(),
        wallMs: Date.now(),
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };
      if (!done) finish("server-close");
    });
    timers.push(setTimeout(() => finish("duration"), options.durationMs) as unknown as number);
  });
}

async function egressIp(): Promise<string | null> {
  try {
    const response = await fetch_("https://api.ipify.org?format=json");
    const body = (await response.json()) as { ip?: unknown };
    return typeof body.ip === "string" ? body.ip : null;
  } catch {
    return null;
  }
}

async function streamPreflight(host: string): Promise<{
  status: number | null;
  raw: string | null;
  code: number | null;
  message: string | null;
}> {
  try {
    const response = await fetch_(httpsStreamUrl(host));
    const raw = await response.text();
    const body = parseObject(raw);
    return {
      status: response.status,
      raw,
      code: typeof body?.["code"] === "number" ? body["code"] : null,
      message: typeof body?.["message"] === "string" ? body["message"] : null,
    };
  } catch {
    return { status: null, raw: null, code: null, message: null };
  }
}

async function discoverSpotMarket(host: string): Promise<string | null> {
  try {
    const response = await fetch_(`https://${host}/api/v1/orderBooks`);
    const body = (await response.json()) as { order_books?: unknown };
    if (!Array.isArray(body.order_books)) return null;
    const found = body.order_books.find((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const market = entry as Record<string, unknown>;
      return market["market_type"] === "spot" && Number(market["market_id"]) >= 2048;
    }) as Record<string, unknown> | undefined;
    const id = found?.["market_id"];
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  } catch {
    return null;
  }
}

async function discoverPoolAccount(host: string): Promise<string | null> {
  try {
    const response = await fetch_(
      `https://${host}/api/v1/publicPoolsMetadata?filter=all&index=0&limit=100`,
    );
    const body: unknown = await response.json();
    const root = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const candidates = [root["public_pools"], root["pools"], root["items"]];
    const list = candidates.find(Array.isArray) as unknown[] | undefined;
    const first = list?.[0];
    if (first === null || typeof first !== "object") return null;
    const record = first as Record<string, unknown>;
    const id = record["account_index"] ?? record["account_id"] ?? record["index"];
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  } catch {
    return null;
  }
}

function channelSpecs(
  market: string,
  spot: string,
  account: string,
  poolAccount: string,
): ChannelSpec[] {
  return [
    { family: "order_book", channels: [`order_book/${market}`], authRequired: false },
    { family: "ticker", channels: [`ticker/${market}`], authRequired: false },
    {
      family: "market_stats",
      channels: [`market_stats/${market}`, "market_stats/all"],
      authRequired: false,
    },
    { family: "spot_market_stats", channels: [`spot_market_stats/${spot}`], authRequired: false },
    { family: "trade", channels: [`trade/${market}`], authRequired: false },
    { family: "candle", channels: [`candle/${market}/1m`], authRequired: false },
    {
      family: "mark_price_candle",
      channels: [`mark_price_candle/${market}/1m`],
      authRequired: false,
    },
    { family: "height", channels: ["height"], authRequired: false },
    { family: "account_all", channels: [`account_all/${account}`], authRequired: false },
    { family: "user_stats", channels: [`user_stats/${account}`], authRequired: false },
    {
      family: "account_all_trades",
      channels: [`account_all_trades/${account}`],
      authRequired: false,
    },
    {
      family: "account_all_positions",
      channels: [`account_all_positions/${account}`],
      authRequired: false,
    },
    {
      family: "account_market",
      channels: [`account_market/${market}/${account}`],
      authRequired: true,
    },
    { family: "account_tx", channels: [`account_tx/${account}`], authRequired: true },
    {
      family: "account_all_orders",
      channels: [`account_all_orders/${account}`],
      authRequired: true,
    },
    {
      family: "account_orders",
      channels: [`account_orders/${market}/${account}`],
      authRequired: true,
    },
    {
      family: "account_all_assets",
      channels: [`account_all_assets/${account}`],
      authRequired: true,
    },
    {
      family: "account_spot_avg_entry_prices",
      channels: [`account_spot_avg_entry_prices/${account}`],
      authRequired: true,
    },
    { family: "pool_data", channels: [`pool_data/${poolAccount}`], authRequired: true },
    { family: "pool_info", channels: [`pool_info/${poolAccount}`], authRequired: true },
    { family: "notification", channels: [`notification/${account}`], authRequired: true },
    { family: "rfq", channels: ["rfq"], authRequired: true },
  ];
}

async function captureOneChannel(
  url: string,
  spec: ChannelSpec,
  durationMs: number,
  authToken: string | undefined,
): Promise<{
  family: string;
  authMode: string;
  probes: Array<{ channel: string; session: Session; observation: Record<string, unknown> }>;
}> {
  const probes: Array<{
    channel: string;
    session: Session;
    observation: Record<string, unknown>;
  }> = [];
  for (const channel of spec.channels) {
    const session = await startSession({
      label: `channel:${channel}`,
      url,
      durationMs,
      answerPings: true,
      onConnected(active) {
        const subscription: Record<string, unknown> = { type: "subscribe", channel };
        if (spec.authRequired && authToken !== undefined) subscription["auth"] = authToken;
        active.sendJson(subscription, authToken);
      },
    });
    const subscribeIndex = session.frames.findIndex(
      (frame) =>
        frame.dir === "out" &&
        messageType(frame.raw) === "subscribe" &&
        parseObject(frame.raw)?.["channel"] === channel,
    );
    const inboundData = session.frames
      .map((frame, frameIndex) => ({ frame, frameIndex, type: messageType(frame.raw) }))
      .filter(
        ({ frame, type }) =>
          frame.dir === "in" && type !== undefined && type !== "connected" && type !== "ping",
      );
    const updateIndices = inboundData
      .filter(({ type }) => type?.startsWith("update/") === true)
      .slice(0, 3)
      .map(({ frameIndex }) => frameIndex);
    const first = inboundData[0];
    probes.push({
      channel,
      session,
      observation: {
        outboundSubscribeFrameIndex: subscribeIndex,
        firstInboundFrameIndex: first?.frameIndex ?? -1,
        firstInboundType: first?.type ?? null,
        firstInboundChannel: first === undefined ? null : messageChannel(first.frame.raw) ?? null,
        nextThreeUpdateFrameIndices: updateIndices,
        totalInboundDataFrames: inboundData.length,
        fixedWindowMs: durationMs,
      },
    });
  }
  return {
    family: spec.family,
    authMode: spec.authRequired ? (authToken === undefined ? "refusal-probe" : "authenticated") : "none",
    probes,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) results[index] = await fn(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function integerText(raw: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}"\\s*:\\s*"?(-?\\d+)"?`).exec(raw);
  return match?.[1] ?? null;
}

function countLevelArray(raw: string, key: "asks" | "bids"): number | null {
  const body = parseObject(raw);
  const direct = body?.[key];
  if (Array.isArray(direct)) return direct.length;
  for (const candidate of ["order_book", "orderBook", "data"]) {
    const nested = body?.[candidate];
    if (nested !== null && typeof nested === "object") {
      const levels = (nested as Record<string, unknown>)[key];
      if (Array.isArray(levels)) return levels.length;
    }
  }
  return null;
}

async function captureOrderBookChain(
  url: string,
  host: string,
  market: string,
  durationMs: number,
): Promise<Record<string, unknown>> {
  let updates = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let lastNonce: string | null = null;
  const session = await startSession({
    label: "orderbook-chain",
    url,
    durationMs,
    answerPings: true,
    onConnected(active) {
      active.sendRaw(JSON.stringify({ type: "subscribe", channel: `order_book/${market}` }));
    },
    stopWhen(raw) {
      if (messageType(raw) !== "update/order_book") return false;
      updates++;
      const beginNonce = integerText(raw, "begin_nonce");
      if (lastNonce === null || (beginNonce !== null && BigInt(beginNonce) === BigInt(lastNonce))) {
        consecutive++;
      } else {
        consecutive = 1;
      }
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      lastNonce = integerText(raw, "nonce");
      return consecutive >= 500;
    },
  });
  const entries: Array<Record<string, unknown>> = [];
  let previousNonce: string | null = null;
  let gaps = 0;
  session.frames.forEach((frame, frameIndex) => {
    if (frame.dir !== "in" || messageType(frame.raw) !== "update/order_book") return;
    const nonce = integerText(frame.raw, "nonce");
    const beginNonce = integerText(frame.raw, "begin_nonce");
    const contiguous =
      previousNonce !== null && beginNonce !== null ? BigInt(beginNonce) === BigInt(previousNonce) : null;
    if (contiguous === false) gaps++;
    entries.push({
      frameIndex,
      nonce,
      beginNonce,
      previousNonce,
      contiguous,
      offset: integerText(frame.raw, "offset"),
      askLevels: countLevelArray(frame.raw, "asks"),
      bidLevels: countLevelArray(frame.raw, "bids"),
    });
    if (nonce !== null) previousNonce = nonce;
  });
  const snapshotIndex = session.frames.findIndex(
    (frame) => frame.dir === "in" && messageType(frame.raw) === "subscribed/order_book",
  );
  let restComparison: Record<string, unknown>;
  try {
    const response = await fetch_(
      `https://${host}/api/v1/orderBookOrders?market_id=${encodeURIComponent(market)}&limit=250`,
    );
    const raw = await response.text();
    const body = parseObject(raw);
    restComparison = {
      status: response.status,
      raw,
      asks: Array.isArray(body?.["asks"]) ? body["asks"].length : null,
      bids: Array.isArray(body?.["bids"]) ? body["bids"].length : null,
    };
  } catch {
    restComparison = { status: null, raw: null, asks: null, bids: null };
  }
  const snapshot = snapshotIndex >= 0 ? session.frames[snapshotIndex] : undefined;
  return {
    market,
    stopCondition: "500 updates or configured duration, whichever comes first",
    session,
    entries,
    updateCount: entries.length,
    maxConsecutiveUpdates: maxConsecutive,
    observedDurationMs: session.observedDurationMs,
    gapCount: gaps,
    snapshot: {
      frameIndex: snapshotIndex,
      asks: snapshot === undefined ? null : countLevelArray(snapshot.raw, "asks"),
      bids: snapshot === undefined ? null : countLevelArray(snapshot.raw, "bids"),
    },
    restComparison,
  };
}

function incomingTypeIndices(session: Session, type: string): number[] {
  const indices: number[] = [];
  session.frames.forEach((frame, index) => {
    if (frame.dir === "in" && messageType(frame.raw) === type) indices.push(index);
  });
  return indices;
}

async function captureKeepalive(
  url: string,
  healthyMs: number,
  otherMs: number,
): Promise<Record<string, unknown>> {
  const unsolicitedPongIndices: number[] = [];
  const subscribeHeight = (active: ActiveSession): void => {
    active.sendRaw('{"type":"subscribe","channel":"height"}');
  };
  const [healthy, unsolicited, silent] = await Promise.all([
    startSession({
      label: "keepalive:answer-pings",
      url,
      durationMs: healthyMs,
      answerPings: true,
      onConnected: subscribeHeight,
    }),
    startSession({
      label: "keepalive:unsolicited-pong",
      url,
      durationMs: otherMs,
      answerPings: true,
      onConnected(active) {
        subscribeHeight(active);
        active.repeat(() => {
          unsolicitedPongIndices.push(active.frames.length);
          active.sendRaw('{"type":"pong"}');
        }, 45_000);
      },
    }),
    startSession({
      label: "keepalive:silent",
      url,
      durationMs: otherMs,
      answerPings: false,
      onConnected: subscribeHeight,
    }),
  ]);
  const pingIndices = incomingTypeIndices(healthy, "ping");
  const pingTimes = pingIndices.map((index) => healthy.frames[index]?.tMs ?? 0);
  const pingGapsMs = pingTimes.slice(1).map((time, index) => time - (pingTimes[index] ?? 0));
  return {
    answerPings: { session: healthy, pingFrameIndices: pingIndices, pingGapsMs },
    unsolicitedPong: { session: unsolicited, outboundFrameIndices: unsolicitedPongIndices },
    silent: { session: silent },
  };
}

async function captureErrors(
  url: string,
  market: string,
  account: string,
  durationMs: number,
): Promise<Record<string, unknown>> {
  const cases: Array<{
    name: string;
    outboundFrameIndex: number | null;
    inboundFrameIndices?: number[];
  }> = ERROR_CASES.map((name) => ({ name, outboundFrameIndex: null }));
  // A Lighter Schnorr signature is 80 bytes, so this is syntactically valid but
  // cryptographically garbage. It must be redacted before persistence.
  const invalidToken = `9999999999:${account}:0:${"ab".repeat(80)}`;
  let unsubscribeAckOutboundFrameIndex: number | null = null;
  const session = await startSession({
    label: "errors",
    url,
    durationMs,
    answerPings: true,
    onConnected(active) {
      const action = (index: number, callback: () => void): void => {
        active.schedule(() => {
          cases[index]!.outboundFrameIndex = active.frames.length;
          callback();
        }, index * 1_500);
      };
      action(0, () => {
        active.sendRaw('{"type":"subscribe","channel":"height"}');
        active.sendRaw('{"type":"subscribe","channel":"height"}');
      });
      action(1, () =>
        active.sendRaw(JSON.stringify({ type: "unsubscribe", channel: `trade/${market}` })),
      );
      action(2, () =>
        active.sendRaw(JSON.stringify({ type: "subscribe", channel: "not_a_channel/0" })),
      );
      action(3, () => active.sendRaw('{"type":"nonsense"}'));
      action(4, () => active.sendRaw("not json at all"));
      action(5, () =>
        active.sendJson(
          { type: "subscribe", channel: `account_tx/${account}`, auth: invalidToken },
          invalidToken,
        ),
      );
      active.schedule(() => {
        unsubscribeAckOutboundFrameIndex = active.frames.length;
        active.sendRaw('{"type":"unsubscribe","channel":"height"}');
      }, 10_000);
    },
  });
  for (let index = 0; index < cases.length; index++) {
    const current = cases[index];
    const next = cases[index + 1];
    if (current === undefined || current.outboundFrameIndex === null) continue;
    const start = current.outboundFrameIndex + 1;
    const end = next?.outboundFrameIndex ?? session.frames.length;
    current.inboundFrameIndices = session.frames
      .map((frame, frameIndex) => ({ frame, frameIndex }))
      .filter(
        ({ frame, frameIndex }) =>
          frameIndex >= start &&
          frameIndex < end &&
          frame.dir === "in" &&
          !["ping", "connected"].includes(messageType(frame.raw) ?? ""),
      )
      .map(({ frameIndex }) => frameIndex);
  }
  const unsubscribeAckInboundFrameIndices =
    unsubscribeAckOutboundFrameIndex === null
      ? []
      : session.frames
          .map((frame, frameIndex) => ({ frame, frameIndex }))
          .filter(
            ({ frame, frameIndex }) =>
              frameIndex > unsubscribeAckOutboundFrameIndex! &&
              frame.dir === "in" &&
              !["ping", "connected"].includes(messageType(frame.raw) ?? ""),
          )
          .map(({ frameIndex }) => frameIndex);
  return {
    cases,
    unsubscribeAckProbe: "height",
    unsubscribeAckOutboundFrameIndex,
    unsubscribeAckInboundFrameIndices,
    session,
  };
}

function renderFindings(input: {
  blocked?: string;
  channels?: Array<{
    family: string;
    authMode: string;
    probes: Array<{ channel: string; session: Session; observation: Record<string, unknown> }>;
  }>;
  chain?: Record<string, unknown>;
  keepalive?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  handshake: { encoded: Session; defaultEncoding: Session };
}): string {
  const blockedSuffix =
    input.blocked === undefined
      ? ""
      : ` The upgrade was blocked before any wire frame arrived: ${input.blocked}`;
  const lines = [
    "# WebSocket findings",
    "",
    "Each question below mirrors `docs/spec/06-websocket.md` §15. A claim is only marked",
    "**answered** when a committed raw frame or close observation supports it.",
    "",
  ];
  const add = (number: number, title: string, answer: string): void => {
    lines.push(`## ${number}. ${title}`, "", answer, "");
  };
  if (input.blocked !== undefined) {
    const titles = [
      "sendtx acknowledgement envelope",
      "account update replacement semantics",
      "subscription survival after auth expiry",
      "channels requiring auth",
      "WebSocket error envelope",
      "market_stats/all fan-out",
      "snapshot type names",
      "unsubscribe acknowledgement",
      "unsolicited pong",
      "server ping interval",
      "encoding negotiation",
      "server close codes",
      "timestamp units",
      "order-book depth",
      "account_orders inbound key",
    ];
    titles.forEach((title, index) => {
      add(
        index + 1,
        title,
        `**Unanswered.**${blockedSuffix} See \`handshake.json\` sessions and \`close.json\`.`,
      );
    });
    return lines.join("\n");
  }

  const channels = input.channels ?? [];
  const familyCapture = (family: string) => channels.find((capture) => capture.family === family);
  const familySession = (family: string): Session | undefined =>
    familyCapture(family)?.probes[0]?.session;
  const dataFrame = (
    session: Session | undefined,
    predicate: (raw: string) => boolean = () => true,
  ): { frame: Frame; index: number } | undefined => {
    if (session === undefined) return undefined;
    const index = session.frames.findIndex((frame) => {
      if (frame.dir !== "in") return false;
      const type = messageType(frame.raw);
      return type !== "connected" && type !== "ping" && predicate(frame.raw);
    });
    const frame = session.frames[index];
    return index < 0 || frame === undefined ? undefined : { frame, index };
  };
  const errors = input.errors as
    | {
        session?: Session;
        unsubscribeAckInboundFrameIndices?: number[];
        unsubscribeAckOutboundFrameIndex?: number;
      }
    | undefined;
  const keepalive = input.keepalive as
    | {
        answerPings?: { session?: Session; pingFrameIndices?: number[]; pingGapsMs?: number[] };
        unsolicitedPong?: { session?: Session; outboundFrameIndices?: number[] };
        silent?: { session?: Session };
      }
    | undefined;
  add(1, "sendtx acknowledgement envelope", "**Unanswered.** This evidence-only run submits no transaction.");
  add(
    2,
    "account update replacement semantics",
    "**Unanswered.** Determining partial-versus-full needs an account whose state changes during capture.",
  );
  add(
    3,
    "subscription survival after auth expiry",
    "**Unanswered.** No deliberately short-lived valid auth token was supplied.",
  );
  const policyFamilies = [
    "account_all",
    "user_stats",
    "account_all_trades",
    "account_all_positions",
    ...AUTH_FAMILIES,
  ];
  const missingPolicyEvidence = policyFamilies.filter(
    (family) => dataFrame(familySession(family)) === undefined,
  );
  add(
    4,
    "channels requiring auth",
    missingPolicyEvidence.length > 0
      ? `**Unanswered.** No policy response was captured for: ${missingPolicyEvidence.join(", ")}.`
      : "**Answered.** All fourteen ambiguous/account families have a response in their corresponding `channels/<family>.json`; the exact subscribe and response frames show which succeed without auth and which return a refusal.",
  );
  const refusalCapture = channels.find((capture) => capture.authMode === "refusal-probe");
  let refusal:
    | { family: string; session: Session; frame: Frame; index: number }
    | undefined;
  if (refusalCapture !== undefined) {
    for (const probe of refusalCapture.probes) {
      const evidence = dataFrame(probe.session);
      if (evidence !== undefined) {
        refusal = {
          family: refusalCapture.family,
          session: probe.session,
          frame: evidence.frame,
          index: evidence.index,
        };
        break;
      }
    }
  }
  const errorEnvelope =
    refusal ??
    (() => {
      const evidence = dataFrame(errors?.session);
      return evidence === undefined || errors?.session === undefined
        ? undefined
        : {
            family: "errors",
            session: errors.session,
            frame: evidence.frame,
            index: evidence.index,
          };
    })();
  add(
    5,
    "WebSocket error envelope",
    errorEnvelope === undefined
      ? "**Unanswered.** No refusal or deliberately-provoked error frame was returned."
      : `**Answered.** Exact shape from \`${
          errorEnvelope.family === "errors"
            ? "errors.json"
            : `channels/${errorEnvelope.family}.json`
        }\` frame ${errorEnvelope.index}:\n\n\`\`\`json\n${errorEnvelope.frame.raw}\n\`\`\``,
  );
  const marketStatsAll = familyCapture("market_stats")?.probes[1]?.session;
  const marketStatsAllEvidence = dataFrame(marketStatsAll);
  add(
    6,
    "market_stats/all fan-out",
    marketStatsAllEvidence === undefined
      ? "**Unanswered.** No market_stats/all session exists."
      : `**Answered.** \`channels/market_stats.json\` second probe, frame ${marketStatsAllEvidence.index}, is the first fan-out frame; the probe's observation records the total frame count.`,
  );
  const snapshotFamilies = [
    "ticker",
    "market_stats",
    "spot_market_stats",
    "trade",
    "height",
    "user_stats",
    "account_tx",
    "account_all_orders",
    "account_orders",
    "account_market",
    "rfq",
  ];
  const missingSnapshotEvidence = snapshotFamilies.filter(
    (family) =>
      dataFrame(
        familySession(family),
        (raw) =>
          messageType(raw)?.startsWith("subscribed/") === true ||
          messageType(raw)?.startsWith("update/") === true,
      ) === undefined,
  );
  add(
    7,
    "snapshot type names",
    missingSnapshotEvidence.length > 0
      ? `**Unanswered.** A valid subscription snapshot/update was not captured for: ${missingSnapshotEvidence.join(", ")}.`
      : "**Answered.** The first inbound type for every questioned family is recorded under `observation.firstInboundType` in `channels/<family>.json`, with the cited raw frame beside it.",
  );
  const unsubscribeAckIndices = errors?.unsubscribeAckInboundFrameIndices ?? [];
  add(
    8,
    "unsubscribe acknowledgement",
    errors?.session === undefined || errors.unsubscribeAckOutboundFrameIndex === undefined
      ? "**Unanswered.** No unsubscribe probe exists."
      : `**Answered.** The known-subscription unsubscribe is \`errors.json\` frame ${errors.unsubscribeAckOutboundFrameIndex}; subsequent non-keepalive response frames are ${unsubscribeAckIndices.join(", ") || "none (no acknowledgement during the capture window)"}.`,
  );
  const unsolicited = keepalive?.unsolicitedPong;
  const firstUnsolicited = unsolicited?.outboundFrameIndices?.[0];
  const pongError =
    unsolicited?.session === undefined || firstUnsolicited === undefined
      ? undefined
      : dataFrame(
          unsolicited.session,
          (raw) =>
            (integerText(raw, "code") === "30001" ||
              parseObject(raw)?.["message"] === "Invalid Type") &&
            (unsolicited.session?.frames.findIndex((frame) => frame.raw === raw) ?? 0) >
              firstUnsolicited,
        );
  add(
    9,
    "unsolicited pong",
    unsolicited?.session === undefined || firstUnsolicited === undefined
      ? "**Unanswered.** No keepalive session exists."
      : pongError === undefined
        ? `**Answered.** Unsolicited pongs at \`keepalive.json\` frames ${unsolicited.outboundFrameIndices?.join(", ")} received no Invalid Type response during ${unsolicited.session.observedDurationMs} ms.`
        : `**Answered.** The server rejected the probe; see \`keepalive.json\` frame ${pongError.index}.`,
  );
  const healthy = keepalive?.answerPings;
  add(
    10,
    "server ping interval",
    healthy?.session === undefined || (healthy.pingFrameIndices?.length ?? 0) < 2
      ? "**Unanswered.** Fewer than two server pings arrived."
      : `**Answered.** See \`keepalive.json\` frames ${healthy.pingFrameIndices?.join(", ")}; monotonic gaps were ${healthy.pingGapsMs?.join(", ")} ms.`,
  );
  const encodedEvidence = dataFrame(input.handshake.encoded);
  const defaultEvidence = dataFrame(input.handshake.defaultEncoding);
  add(
    11,
    "encoding negotiation",
    encodedEvidence === undefined || defaultEvidence === undefined
      ? "**Unanswered.** One or both handshake variants returned no application frame."
      : `**Answered.** Compare \`handshake.json\` encoded frame ${encodedEvidence.index} and defaultEncoding frame ${defaultEvidence.index}; binary-frame observations are recorded separately.`,
  );
  const silentSession = keepalive?.silent?.session;
  const silentClose = silentSession?.close;
  add(
    12,
    "server close codes",
    silentClose === undefined || silentClose === null || silentSession?.endCause !== "server-close"
      ? "**Unanswered for idle timeout.** The silent session did not close during the window."
      : `**Answered for idle timeout.** \`keepalive.json\` silent.session.close records code ${silentClose.code}, reason \`${silentClose.reason}\`, elapsed ${silentClose.tMs} ms.`,
  );
  const height = familySession("height");
  const heightTimestampEvidence =
    height === undefined
      ? undefined
      : dataFrame(height, (raw) => integerText(raw, "timestamp") !== null);
  const heightTimestamp =
    heightTimestampEvidence === undefined
      ? null
      : integerText(heightTimestampEvidence.frame.raw, "timestamp");
  add(
    13,
    "timestamp units",
    heightTimestampEvidence === undefined || heightTimestamp === null
      ? "**Unanswered.** No height timestamp frame exists."
      : `**Answered for height only.** \`channels/height.json\` frame ${heightTimestampEvidence.index} contains timestamp \`${heightTimestamp}\` (${heightTimestamp.length >= 13 ? "milliseconds" : "seconds"} by magnitude). PositionFunding still needs account funding activity.`,
  );
  const chain = input.chain as
    | {
        snapshot?: { frameIndex?: unknown; asks?: unknown; bids?: unknown };
        restComparison?: { status?: unknown; asks?: unknown; bids?: unknown };
        updateCount?: unknown;
        gapCount?: unknown;
      }
    | undefined;
  const hasDepthEvidence =
    Number(chain?.snapshot?.frameIndex ?? -1) >= 0 &&
    Number(chain?.restComparison?.status ?? 0) === 200;
  add(
    14,
    "order-book depth",
    !hasDepthEvidence
      ? "**Unanswered.** A WebSocket snapshot and successful REST comparison were not both captured."
      : `**Answered.** \`orderbook-chain.json\` snapshot frame ${String(chain?.snapshot?.frameIndex)} has ${String(chain?.snapshot?.asks)} asks/${String(chain?.snapshot?.bids)} bids; REST has ${String(chain?.restComparison?.asks)} asks/${String(chain?.restComparison?.bids)} bids. The chain records ${String(chain?.updateCount)} updates and ${String(chain?.gapCount)} gaps.`,
  );
  const accountOrders = familySession("account_orders");
  const accountOrdersEvidence =
    accountOrders === undefined
      ? undefined
      : dataFrame(accountOrders, (raw) => messageChannel(raw) !== undefined);
  const accountOrdersChannel =
    accountOrdersEvidence === undefined ? undefined : messageChannel(accountOrdersEvidence.frame.raw);
  add(
    15,
    "account_orders inbound key",
    accountOrdersEvidence === undefined
      ? "**Unanswered.** No account_orders data frame with an inbound channel key exists."
      : `**Answered.** \`channels/account_orders.json\` frame ${accountOrdersEvidence.index} carries inbound channel \`${String(accountOrdersChannel)}\` verbatim.`,
  );
  return lines.join("\n");
}

async function captureHandshake(host: string): Promise<{
  encoded: Session;
  defaultEncoding: Session;
  observation: Record<string, unknown>;
}> {
  const early = (active: ActiveSession): void => {
    active.sendRaw('{"type":"subscribe","channel":"height"}');
  };
  const [encoded, defaultEncoding] = await Promise.all([
    startSession({
      label: "handshake:encoding=json",
      url: streamUrl(host, true),
      durationMs: 5_000,
      answerPings: true,
      onOpen: early,
    }),
    startSession({
      label: "handshake:no-query",
      url: streamUrl(host, false),
      durationMs: 5_000,
      answerPings: true,
      onOpen: early,
    }),
  ]);
  const summarize = (session: Session): Record<string, unknown> => {
    const connectedIndex = session.frames.findIndex(
      (frame) => frame.dir === "in" && messageType(frame.raw) === "connected",
    );
    const earlySubscribeIndex = session.frames.findIndex(
      (frame) => frame.dir === "out" && messageType(frame.raw) === "subscribe",
    );
    const responseIndex = session.frames.findIndex((frame, index) => {
      if (index <= earlySubscribeIndex || frame.dir !== "in") return false;
      const type = messageType(frame.raw);
      return type !== "connected" && type !== "ping";
    });
    return {
      connectedFrameIndex: connectedIndex,
      earlySubscribeFrameIndex: earlySubscribeIndex,
      earlySubscribeWasBeforeConnected:
        earlySubscribeIndex >= 0 && (connectedIndex < 0 || earlySubscribeIndex < connectedIndex),
      earlySubscriptionResponseFrameIndex: responseIndex,
      earlySubscriptionHonored: responseIndex >= 0,
      binaryFrameCount: session.binaryFrames.length,
    };
  };
  return {
    encoded,
    defaultEncoding,
    observation: {
      encoded: summarize(encoded),
      defaultEncoding: summarize(defaultEncoding),
    },
  };
}

async function writeReadme(
  out: string,
  metadata: Record<string, unknown>,
  blocked: boolean,
): Promise<void> {
  const status = blocked
    ? "The committed run was blocked before WebSocket upgrade; it is evidence of the blocker, not protocol fixtures."
    : "The committed files are raw protocol evidence from a completed capture run.";
  await Bun.write(
    `${out}/README.md`,
    `# Lighter WebSocket fixtures

${status}

- Host: \`${String(metadata["host"])}\`
- UTC start: \`${String(metadata["startedAt"])}\`
- Script version: \`${SCRIPT_VERSION}\`
- Egress IP: \`${String(metadata["egressIp"] ?? "unavailable")}\`

Every frame has \`dir\`, monotonic \`tMs\`, wall-clock \`wallMs\`, and verbatim wire
text in \`raw\`. The only permitted wire mutation is auth-token redaction.

Re-capture from a permitted jurisdiction:

\`\`\`sh
bun run scripts/capture-ws-fixtures.ts --host ${String(metadata["host"])} --market ${String(metadata["market"])} --account ${String(metadata["account"])}
bun run scripts/capture-ws-fixtures.ts --verify
\`\`\`
`,
  );
}

async function writeRunMetadata(out: string, metadata: Record<string, unknown>): Promise<string> {
  const stamp = String(metadata["startedAt"]).replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const path = `${out}/run-${stamp}.json`;
  await writeJson(path, metadata);
  return path;
}

async function writeBlockedCapture(
  out: string,
  metadata: Record<string, unknown>,
  handshake: { encoded: Session; defaultEncoding: Session },
  preflight: Awaited<ReturnType<typeof streamPreflight>>,
): Promise<void> {
  const reason =
    preflight.message ??
    "The WebSocket upgrade failed before the server delivered any application frame.";
  await writeJson(`${out}/handshake.json`, { ...handshake, preflight });
  await writeJson(`${out}/close.json`, {
    observations: [
      { session: handshake.encoded.label, close: handshake.encoded.close },
      { session: handshake.defaultEncoding.label, close: handshake.defaultEncoding.close },
    ],
    preflight,
  });
  await writeJson(`${out}/orderbook-chain.json`, {
    status: "not-captured",
    reason,
    frames: [],
    entries: [],
    updateCount: 0,
    gapCount: 0,
  });
  await writeJson(`${out}/keepalive.json`, { status: "not-captured", reason, sessions: [] });
  await writeJson(`${out}/errors.json`, { status: "not-captured", reason, cases: [], frames: [] });
  // Compatibility for the existing downstream replay tests. The structured
  // files above are canonical; this legacy file remains until those tests move
  // to the issue #1 layout.
  await writeJson(`${out}/capture.json`, {
    capturedFromUrl: handshake.encoded.url,
    frames: [],
    captureFailed: {
      reason: "geo-restricted",
      apiCode: preflight.code,
      apiMessage: preflight.message,
      observedCloseCode: handshake.encoded.close?.code ?? null,
      observedCloseReason: handshake.encoded.close?.reason ?? null,
    },
  });
  for (const family of [...PUBLIC_FAMILIES, ...AUTH_FAMILIES]) {
    await writeJson(`${out}/channels/${family}.json`, {
      family,
      status: "not-captured",
      reason,
      probes: [],
    });
  }
  await Bun.write(`${out}/findings.md`, renderFindings({ blocked: reason, handshake }));
  await writeReadme(out, metadata, true);
}

function collectFrames(value: unknown, frames: Frame[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFrames(item, frames);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (
    (object["dir"] === "in" || object["dir"] === "out") &&
    typeof object["tMs"] === "number" &&
    typeof object["wallMs"] === "number"
  ) {
    frames.push(object as Frame);
  }
  for (const item of Object.values(object)) collectFrames(item, frames);
}

async function verifyFixtures(out: string): Promise<void> {
  const failures: string[] = [];
  const required = [
    "README.md",
    "findings.md",
    "handshake.json",
    "orderbook-chain.json",
    "keepalive.json",
    "errors.json",
    "close.json",
    ...[...PUBLIC_FAMILIES, ...AUTH_FAMILIES].map((family) => `channels/${family}.json`),
  ];
  for (const relative of required) {
    if (!(await Bun.file(`${out}/${relative}`).exists())) failures.push(`missing ${relative}`);
  }
  const runs: string[] = [];
  for await (const path of new Bun.Glob("run-*.json").scan(out)) runs.push(path);
  if (runs.length === 0) failures.push("missing run-<utc>.json");

  const jsonPaths: string[] = [];
  for await (const path of new Bun.Glob("**/*.json").scan(out)) jsonPaths.push(path);
  for (const relative of jsonPaths) {
    const path = `${out}/${relative}`;
    const text = await Bun.file(path).text();
    if (/\d{10,}:\d+:\d+:[0-9a-fA-F]{32,}/.test(text)) {
      failures.push(`${relative}: contains a live-looking auth token`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${String(error)})`);
      continue;
    }
    const frames: Frame[] = [];
    collectFrames(value, frames);
    frames.forEach((frame, index) => {
      if (typeof frame.raw !== "string") failures.push(`${relative}: frame ${index} has no string raw`);
    });
  }

  for (const family of PUBLIC_FAMILIES) {
    const path = `${out}/channels/${family}.json`;
    if (!(await Bun.file(path).exists())) continue;
    const value = await readJson(path);
    const frames: Frame[] = [];
    collectFrames(value, frames);
    const inboundTypes = frames
      .filter((frame) => frame.dir === "in")
      .map((frame) => messageType(frame.raw))
      .filter((type): type is string => type !== undefined);
    const dataTypes = inboundTypes.filter((type) => type !== "connected" && type !== "ping");
    // Several documented channels may use update/* for both the initial state
    // and subsequent changes (the point of §15 Q7). Do not incorrectly require
    // a subscribed/* spelling; require a first data frame plus an update.
    if (dataTypes.length === 0) failures.push(`channels/${family}.json: no snapshot/initial data frame`);
    if (!inboundTypes.some((type) => type.startsWith("update/"))) {
      failures.push(`channels/${family}.json: no update frame`);
    }
  }
  if (await Bun.file(`${out}/channels/market_stats.json`).exists()) {
    const marketStats = (await readJson(`${out}/channels/market_stats.json`)) as Record<
      string,
      unknown
    >;
    if (!Array.isArray(marketStats["probes"]) || marketStats["probes"].length < 2) {
      failures.push("channels/market_stats.json: missing distinct market and all probes");
    }
  }

  for (const family of AUTH_FAMILIES) {
    const path = `${out}/channels/${family}.json`;
    if (!(await Bun.file(path).exists())) continue;
    const value = (await readJson(path)) as Record<string, unknown>;
    const frames: Frame[] = [];
    collectFrames(value, frames);
    const hasInbound = frames.some((frame) => {
      if (frame.dir !== "in") return false;
      const type = messageType(frame.raw);
      return type !== undefined && type !== "connected" && type !== "ping";
    });
    if (!hasInbound) failures.push(`channels/${family}.json: no capture or refusal frame`);
  }

  if (await Bun.file(`${out}/orderbook-chain.json`).exists()) {
    const chain = (await readJson(`${out}/orderbook-chain.json`)) as Record<string, unknown>;
    const entries = Array.isArray(chain["entries"])
      ? (chain["entries"] as Array<Record<string, unknown>>)
      : [];
    const observedDurationMs = Number(chain["observedDurationMs"] ?? 0);
    const maxConsecutiveUpdates = Number(chain["maxConsecutiveUpdates"] ?? 0);
    if (maxConsecutiveUpdates < 500 && observedDurationMs < 120_000) {
      failures.push("orderbook-chain.json: neither 500 updates nor 120 seconds captured");
    }
    const chainFrames: Frame[] = [];
    collectFrames(chain["session"], chainFrames);
    let computedGaps = 0;
    let prior: string | null = null;
    entries.forEach((entry, index) => {
      const nonce = typeof entry["nonce"] === "string" ? entry["nonce"] : null;
      const begin = typeof entry["beginNonce"] === "string" ? entry["beginNonce"] : null;
      const persistedPrior = typeof entry["previousNonce"] === "string" ? entry["previousNonce"] : null;
      if (persistedPrior !== prior) failures.push(`orderbook-chain.json: entry ${index} previousNonce mismatch`);
      const expected = prior !== null && begin !== null ? BigInt(begin) === BigInt(prior) : null;
      if (entry["contiguous"] !== expected) {
        failures.push(`orderbook-chain.json: entry ${index} contiguous mismatch`);
      }
      const frameIndex = Number(entry["frameIndex"]);
      const source = chainFrames[frameIndex];
      if (
        source === undefined ||
        source.dir !== "in" ||
        integerText(source.raw, "nonce") !== nonce ||
        integerText(source.raw, "begin_nonce") !== begin
      ) {
        failures.push(`orderbook-chain.json: entry ${index} does not match its source frame`);
      }
      if (expected === false) computedGaps++;
      prior = nonce;
    });
    if (Number(chain["gapCount"]) !== computedGaps) {
      failures.push("orderbook-chain.json: gapCount mismatch");
    }
  }

  if (await Bun.file(`${out}/errors.json`).exists()) {
    const errors = (await readJson(`${out}/errors.json`)) as Record<string, unknown>;
    const cases = Array.isArray(errors["cases"]) ? errors["cases"] : [];
    const names = new Set(
      cases
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((item) => item["name"]),
    );
    for (const requiredCase of ERROR_CASES) {
      if (!names.has(requiredCase)) failures.push(`errors.json: missing ${requiredCase}`);
    }
    for (const item of cases) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const name = String(entry["name"]);
      if (!Number.isInteger(entry["outboundFrameIndex"])) {
        failures.push(`errors.json: ${name} has no outbound frame index`);
      }
      if (!Array.isArray(entry["inboundFrameIndices"]) || entry["inboundFrameIndices"].length === 0) {
        failures.push(`errors.json: ${name} has no inbound response frame`);
      }
    }
    const frames: Frame[] = [];
    collectFrames(errors, frames);
    if (!frames.some((frame) => frame.dir === "in")) failures.push("errors.json: no inbound error evidence");
  }

  if (await Bun.file(`${out}/handshake.json`).exists()) {
    const handshake = (await readJson(`${out}/handshake.json`)) as Record<string, unknown>;
    for (const key of ["encoded", "defaultEncoding"]) {
      const session = handshake[key];
      if (session === null || typeof session !== "object") {
        failures.push(`handshake.json: missing ${key} session`);
        continue;
      }
      const frames: Frame[] = [];
      collectFrames(session, frames);
      if (!frames.some((frame) => frame.dir === "in")) {
        failures.push(`handshake.json: ${key} has no inbound frame`);
      }
    }
  }

  if (await Bun.file(`${out}/keepalive.json`).exists()) {
    const keepalive = (await readJson(`${out}/keepalive.json`)) as Record<string, unknown>;
    const answer = keepalive["answerPings"] as Record<string, unknown> | undefined;
    const unsolicited = keepalive["unsolicitedPong"] as Record<string, unknown> | undefined;
    const silent = keepalive["silent"] as Record<string, unknown> | undefined;
    const answerSession = answer?.["session"] as Record<string, unknown> | undefined;
    if (Number(answerSession?.["observedDurationMs"] ?? 0) < 360_000) {
      failures.push("keepalive.json: ping-answering session is shorter than six minutes");
    }
    if (!Array.isArray(answer?.["pingFrameIndices"]) || answer["pingFrameIndices"].length < 2) {
      failures.push("keepalive.json: fewer than two server pings captured");
    }
    if (
      !Array.isArray(unsolicited?.["outboundFrameIndices"]) ||
      unsolicited["outboundFrameIndices"].length === 0
    ) {
      failures.push("keepalive.json: no unsolicited pong captured");
    }
    const silentSession = silent?.["session"] as Record<string, unknown> | undefined;
    if (
      silentSession?.["close"] === null ||
      silentSession?.["close"] === undefined ||
      silentSession["endCause"] !== "server-close"
    ) {
      failures.push("keepalive.json: silent session has no observed close");
    }
  }

  if (await Bun.file(`${out}/findings.md`).exists()) {
    const findings = await Bun.file(`${out}/findings.md`).text();
    for (let question = 1; question <= 15; question++) {
      if (!findings.includes(`## ${question}.`)) failures.push(`findings.md: missing question ${question}`);
    }
    const statusCount = (findings.match(/\*\*(?:Answered|Unanswered)[^*]*\*\*/g) ?? []).length;
    if (statusCount < 15) failures.push("findings.md: every question must be marked answered or unanswered");
  }

  if (failures.length > 0) {
    console.error(`fixture verification failed (${failures.length}):`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    throw new Error("WebSocket fixtures are incomplete or internally inconsistent");
  }
  console.log(`verified ${jsonPaths.length} JSON fixtures and ${PUBLIC_FAMILIES.length + AUTH_FAMILIES.length} channel families`);
}

async function main(): Promise<void> {
  const cli = parseCli(Bun.argv.slice(2));
  const out = cli.values.get("out") ?? DEFAULT_OUT;
  if (cli.flags.has("verify")) {
    await verifyFixtures(out);
    return;
  }

  const host = cli.values.get("host") ?? "mainnet.zklighter.elliot.ai";
  const market = cli.values.get("market") ?? "1";
  const account = cli.values.get("account") ?? "1";
  const chainMs = Number(cli.values.get("seconds") ?? "120") * 1_000;
  const channelMs = Number(cli.values.get("channel-seconds") ?? "20") * 1_000;
  const healthyKeepaliveMs = Number(cli.values.get("keepalive-seconds") ?? "360") * 1_000;
  const otherKeepaliveMs = Number(cli.values.get("idle-seconds") ?? "180") * 1_000;
  const authToken = Bun.env["LIGHTER_WS_AUTH_TOKEN"];
  const startedAt = new Date().toISOString();
  const metadata: Record<string, unknown> = {
    scriptVersion: SCRIPT_VERSION,
    host,
    market,
    account,
    argv: Bun.argv.slice(2).map((arg) => redactWire(arg, authToken)),
    startedAt,
    endedAt: null,
    egressIp: await egressIp(),
    authTokenSupplied: authToken !== undefined,
  };

  console.error(`capturing handshake from ${host}`);
  const handshake = await captureHandshake(host);
  const preflight = await streamPreflight(host);
  await writeJson(`${out}/handshake.json`, { ...handshake, preflight });
  if (!handshake.encoded.opened || preflight.code === 20558) {
    metadata["endedAt"] = new Date().toISOString();
    metadata["status"] = "blocked-before-upgrade";
    metadata["preflight"] = preflight;
    await writeBlockedCapture(out, metadata, handshake, preflight);
    const runPath = await writeRunMetadata(out, metadata);
    console.error(`capture blocked before upgrade; evidence written to ${runPath}`);
    throw new Error(preflight.message ?? "WebSocket upgrade failed");
  }

  const spotMarket = (await discoverSpotMarket(host)) ?? "2048";
  const poolAccount = authToken === undefined ? account : (await discoverPoolAccount(host)) ?? account;
  metadata["spotMarket"] = spotMarket;
  metadata["poolAccount"] = poolAccount;
  const specs = channelSpecs(market, spotMarket, account, poolAccount);
  const selected = cli.flags.has("authed-only") ? specs.filter((spec) => spec.authRequired) : specs;
  console.error(`capturing ${selected.length} channel families`);
  const channelPromise = mapConcurrent(selected, 4, (spec) =>
    captureOneChannel(streamUrl(host, true), spec, channelMs, authToken),
  );
  const chainPromise = cli.flags.has("authed-only")
    ? Promise.resolve(undefined)
    : captureOrderBookChain(streamUrl(host, true), host, market, chainMs);
  const keepalivePromise = cli.flags.has("authed-only")
    ? Promise.resolve(undefined)
    : captureKeepalive(streamUrl(host, true), healthyKeepaliveMs, otherKeepaliveMs);
  const errorsPromise = cli.flags.has("authed-only")
    ? Promise.resolve(undefined)
    : captureErrors(streamUrl(host, true), market, account, 15_000);

  const [channels, chain, keepalive, errors] = await Promise.all([
    channelPromise,
    chainPromise,
    keepalivePromise,
    errorsPromise,
  ]);
  for (const channel of channels) {
    await writeJson(`${out}/channels/${channel.family}.json`, channel);
  }
  await writeJson(`${out}/capture.json`, {
    capturedFromUrl: streamUrl(host, true),
    note: "Legacy aggregate for downstream replay tests; structured issue #1 fixtures are canonical.",
    frames: channels.flatMap((channel) =>
      channel.probes.flatMap((probe) =>
        probe.session.frames
          .filter((frame) => frame.dir === "in")
          .map((frame) => frame.raw),
      ),
    ),
  });
  if (chain !== undefined) await writeJson(`${out}/orderbook-chain.json`, chain);
  if (keepalive !== undefined) await writeJson(`${out}/keepalive.json`, keepalive);
  if (errors !== undefined) await writeJson(`${out}/errors.json`, errors);
  const closes = [
    handshake.encoded,
    handshake.defaultEncoding,
    ...channels.flatMap((channel) => channel.probes.map((probe) => probe.session)),
  ].map((session) => ({ session: session.label, close: session.close }));
  await writeJson(`${out}/close.json`, { observations: closes });
  const findingsInput: Parameters<typeof renderFindings>[0] = { channels, handshake };
  if (chain !== undefined) findingsInput.chain = chain;
  if (keepalive !== undefined) findingsInput.keepalive = keepalive;
  if (errors !== undefined) findingsInput.errors = errors;
  await Bun.write(`${out}/findings.md`, renderFindings(findingsInput));
  metadata["endedAt"] = new Date().toISOString();
  metadata["status"] = "capture-complete";
  await writeRunMetadata(out, metadata);
  await writeReadme(out, metadata, false);
  await verifyFixtures(out);
}

await main();
