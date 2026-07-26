/**
 * Capture real WebSocket frames from the Lighter stream.
 *
 * Deliberately uses no SDK code — only the global WebSocket — because the WS
 * layer is designed FROM these fixtures. If this script imported the thing it
 * is meant to validate, the fixtures would only prove the SDK agrees with
 * itself.
 *
 * Records, per channel: the subscribe frame, the ack, the first snapshot, and a
 * run of updates, plus keepalive timing and close behaviour.
 *
 *   bun run scripts/capture-ws-fixtures.ts
 *   bun run scripts/capture-ws-fixtures.ts --seconds 60 --market 1 --out test/fixtures/ws
 *
 * Payloads may contain account data if you subscribe to account channels. Review
 * before committing.
 */

// Marks this file as a module. Without a top-level import or export, `bundler`
// resolution treats it as a script and its top-level consts collide with DOM globals.
export {};

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (flag === undefined || value === undefined) break;
  args.set(flag.replace(/^--/, ''), value);
}

const URL_ = args.get('url') ?? 'wss://mainnet.zklighter.elliot.ai/stream';
const SECONDS = Number(args.get('seconds') ?? 45);
const MARKET = args.get('market') ?? '1';
const OUT = args.get('out') ?? 'test/fixtures/ws';
const MAX_PER_TYPE = Number(args.get('maxPerType') ?? 6);

/** Channels worth capturing that need no authentication. */
const CHANNELS = [
  `order_book/${MARKET}`,
  `trade/${MARKET}`,
  `market_stats/${MARKET}`,
];

type Frame = {
  atMs: number;
  direction: 'recv' | 'send';
  type: string;
  channel?: string;
  raw: unknown;
};

const frames: Frame[] = [];
const perType = new Map<string, number>();
const start = Date.now();
const pingTimes: number[] = [];

function record(direction: 'recv' | 'send', raw: unknown): void {
  const obj = raw as Record<string, unknown> | null;
  const type = typeof obj?.['type'] === 'string' ? (obj['type'] as string) : '<no-type>';
  const channel = typeof obj?.['channel'] === 'string' ? (obj['channel'] as string) : undefined;

  // Cap per (type, channel) so a busy book does not drown out rare frames,
  // while still capturing enough updates to study the delta format.
  const key = `${direction}:${type}:${channel ?? ''}`;
  const n = perType.get(key) ?? 0;
  if (n >= MAX_PER_TYPE) return;
  perType.set(key, n + 1);

  const frame: Frame = { atMs: Date.now() - start, direction, type, raw };
  if (channel !== undefined) frame.channel = channel;
  frames.push(frame);
}

console.error(`connecting to ${URL_}`);
const ws = new WebSocket(URL_);
let closeInfo: { code: number; reason: string; wasClean: boolean } | null = null;

ws.addEventListener('open', () => {
  console.error('open — waiting for the server to say "connected" before subscribing');
});

ws.addEventListener('message', (ev: MessageEvent) => {
  const text = typeof ev.data === 'string' ? ev.data : '<binary>';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    record('recv', { type: '<unparseable>', text: text.slice(0, 2000) });
    return;
  }

  record('recv', parsed);
  const msg = parsed as Record<string, unknown>;

  if (msg['type'] === 'connected') {
    for (const channel of CHANNELS) {
      const frame = { type: 'subscribe', channel };
      record('send', frame);
      ws.send(JSON.stringify(frame));
      console.error(`  subscribed ${channel}`);
    }
    return;
  }

  if (msg['type'] === 'ping') {
    pingTimes.push(Date.now() - start);
    const pong = { type: 'pong' };
    record('send', pong);
    ws.send(JSON.stringify(pong));
    return;
  }
});

ws.addEventListener('error', () => console.error('socket error'));
ws.addEventListener('close', (ev: CloseEvent) => {
  closeInfo = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
  console.error(`closed code=${ev.code} reason=${ev.reason || '<none>'}`);
});

setTimeout(async () => {
  try {
    ws.close(1000, 'capture complete');
  } catch {
    /* already closed */
  }

  const byType: Record<string, number> = {};
  for (const f of frames) byType[`${f.direction}/${f.type}`] = (byType[`${f.direction}/${f.type}`] ?? 0) + 1;

  const pingGaps = pingTimes.slice(1).map((t, i) => t - (pingTimes[i] ?? 0));

  const out = {
    capturedFromUrl: URL_,
    durationSeconds: SECONDS,
    subscribedChannels: CHANNELS,
    note:
      'Captured with the global WebSocket only, no SDK code. Frame counts are capped per ' +
      `(direction, type, channel) at ${MAX_PER_TYPE} so rare frames are not drowned out by book updates.`,
    summary: {
      frameCountsByType: byType,
      keepalive: {
        pingCount: pingTimes.length,
        pingTimesMs: pingTimes,
        gapsMs: pingGaps,
        note: 'Application-level JSON ping/pong, not WebSocket control frames.',
      },
      close: closeInfo,
    },
    frames,
  };

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(OUT, { recursive: true });
  const path = `${OUT}/capture.json`;
  await writeFile(path, JSON.stringify(out, null, 1) + '\n');

  console.error(`\nwrote ${path}`);
  console.error(`frames: ${frames.length}`);
  for (const [k, v] of Object.entries(byType).sort()) console.error(`  ${k}: ${v}`);
  console.error(`pings: ${pingTimes.length}${pingGaps.length ? ` gaps ${pingGaps.join(', ')} ms` : ''}`);
  process.exit(0);
}, SECONDS * 1000);
