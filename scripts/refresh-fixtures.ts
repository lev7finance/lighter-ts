/**
 * Capture live REST responses as golden fixtures.
 *
 * Uses only `fetch` — no SDK code — because the model layer is written FROM
 * these fixtures. A fixture produced by the code it is meant to validate proves
 * only that the code agrees with itself.
 *
 *   bun run scripts/refresh-fixtures.ts
 *   bun run scripts/refresh-fixtures.ts --base https://testnet.zklighter.elliot.ai --out test/fixtures/rest
 *
 * Large list responses are truncated to a few entries so fixtures stay
 * reviewable in a diff; the truncation is recorded in the file.
 *
 * Some endpoints are geo-restricted (API code 20558 — see docs/protocol-notes.md
 * section 8.3). Those are captured as fixtures too: the error shape is exactly
 * what the transport layer has to classify correctly.
 */

const argv = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (flag === undefined || value === undefined) break;
  argv.set(flag.replace(/^--/, ''), value);
}

const BASE = argv.get('base') ?? 'https://mainnet.zklighter.elliot.ai';
const OUT = argv.get('out') ?? 'test/fixtures/rest';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Trim big arrays so a fixture stays reviewable. Records what it cut. */
function truncate(value: unknown, keep = 3): { value: unknown; truncated: string[] } {
  const cuts: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) {
      if (v.length > keep) {
        cuts.push(`${path}: ${v.length} entries -> ${keep}`);
        return v.slice(0, keep).map((x, i) => walk(x, `${path}[${i}]`));
      }
      return v.map((x, i) => walk(x, `${path}[${i}]`));
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]),
      );
    }
    return v;
  };
  return { value: walk(value, ''), truncated: cuts };
}

const CASES: Array<{ name: string; path: string; why: string }> = [
  { name: 'orderBooks', path: '/api/v1/orderBooks', why: 'market metadata: per-market decimals drive all client-side sizing' },
  { name: 'systemConfig', path: '/api/v1/systemConfig', why: 'pool indices and integrator fee caps' },
  { name: 'layer1BasicInfo', path: '/api/v1/layer1BasicInfo', why: 'L1 chain id and contract addresses' },
  { name: 'nextNonce', path: '/api/v1/nextNonce?account_index=1&api_key_index=0', why: 'smallest success envelope' },
  { name: 'account', path: '/api/v1/account?by=index&value=1', why: 'account shape' },
  { name: 'orderBookOrders', path: '/api/v1/orderBookOrders?market_id=1&limit=5', why: 'book levels as decimal strings' },
  { name: 'recentTrades', path: '/api/v1/recentTrades?market_id=1&limit=5', why: 'trade shape' },
  {
    name: 'candles',
    path: '/api/v1/candles?market_id=1&resolution=1h&start_timestamp=1750000000&end_timestamp=1750100000&count_back=5',
    why: 'single-letter candle keys',
  },
  { name: 'assetDetails', path: '/api/v1/assetDetails', why: 'asset decimals and margin mode' },
  {
    name: 'withdrawalDelay-no-code-field',
    path: '/api/v1/withdrawalDelay?account_index=1',
    why: 'THE envelope counterexample: a success response carrying no `code` field at all',
  },
  {
    name: 'error-invalid-param',
    path: '/api/v1/orderBookOrders?market_id=99999&limit=5',
    why: 'error code 20001, and note the trailing space in the message',
  },
  {
    name: 'error-not-found',
    path: '/api/v1/account?by=index&value=999999999999',
    why: 'error code 29404 delivered inside an HTTP 400',
  },
  {
    name: 'error-missing-auth',
    path: '/api/v1/transferFeeInfo?account_index=1',
    why: 'reveals that auth is accepted as either an `auth` query param or an Authorization header',
  },
  {
    name: 'error-geo-restricted',
    path: '/api/v1/sendTx',
    why: 'API code 20558 in an HTTP 400 — reads succeed while writes fail, see protocol-notes 8.3',
  },
];

const captured: Record<string, unknown> = {};

for (const c of CASES) {
  const url = `${BASE}${c.path}`;
  let entry: Record<string, unknown>;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const text = await res.text();
    const ctype = res.headers.get('content-type') ?? '';
    let body: unknown;
    let parsed = true;
    try {
      body = JSON.parse(text);
    } catch {
      parsed = false;
      body = text.slice(0, 400);
    }
    const { value, truncated } = parsed ? truncate(body) : { value: body, truncated: [] };
    entry = {
      why: c.why,
      request: { path: c.path },
      status: res.status,
      contentType: ctype,
      bodyIsJson: parsed,
      apiCode: parsed && body && typeof body === 'object' ? (body as Record<string, unknown>)['code'] ?? null : null,
      truncated,
      body: value,
    };
    console.error(
      `  ${String(res.status).padEnd(3)} ${c.name.padEnd(32)} ${parsed ? 'json' : 'NON-JSON'}` +
        `${truncated.length ? `  (truncated ${truncated.length})` : ''}`,
    );
  } catch (err) {
    entry = { why: c.why, request: { path: c.path }, transportError: String(err) };
    console.error(`  ERR ${c.name}: ${err}`);
  }
  captured[c.name] = entry;
}

const out = {
  capturedFromBase: BASE,
  note:
    'Captured with fetch only, no SDK code. Large arrays are truncated (see each entry\'s ' +
    '`truncated` list). Error responses are fixtures too — classifying them correctly is the ' +
    'transport layer\'s job. Values are live market data and will not match a later capture; ' +
    'assert on SHAPE, not on numbers.',
  cases: captured,
};

const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/responses.json`, JSON.stringify(out, null, 1) + '\n');
console.error(`\nwrote ${OUT}/responses.json  (${CASES.length} cases)`);
