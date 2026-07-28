/**
 * Enforce the two claims that make this package portable, rather than trusting
 * them to stay true.
 *
 *   1. No runtime dependencies of any kind.
 *   2. Nothing under src/ reaches for a Node built-in or a Node global.
 *
 * The second is the one that actually breaks users: an accidental `Buffer` or
 * `node:crypto` import typechecks, passes tests under Bun and Node, and then
 * fails at runtime in a Cloudflare Worker or a browser — the two targets nobody
 * runs locally.
 *
 *   bun run scripts/check-no-deps.ts
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const failures: string[] = [];

// ---------------------------------------------------------------- dependencies

const pkg = JSON.parse(await readFile('package.json', 'utf8')) as Record<string, unknown>;
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
  const v = pkg[field] as Record<string, string> | undefined;
  const names = v ? Object.keys(v) : [];
  if (names.length > 0) {
    failures.push(`package.json ${field} must be empty, found: ${names.join(', ')}`);
  }
}

// ---------------------------------------------------------------- src/ purity

/**
 * Node globals that have no counterpart in a Worker or a browser. `process` is
 * the subtle one — it exists in Bun and Node, is absent in workerd, and reading
 * `process.env` is the single most common way a library stops being portable.
 */
const BANNED_GLOBALS = [
  'Buffer',
  'process',
  '__dirname',
  '__filename',
  'require(',
  'globalThis.process',
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.ts')) yield p;
  }
}

let scanned = 0;
for await (const file of walk('src')) {
  scanned++;
  const raw = await readFile(file, 'utf8');
  // Strip block comments before scanning. Prose legitimately contains words like
  // "processed" and "buffered"; only real code should be able to trip this.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const code = line.replace(/\/\/.*$/, '');

    if (/from\s+['"]node:/.test(code) || /import\s*\(\s*['"]node:/.test(code)) {
      failures.push(`${at}  imports a Node built-in: ${line.trim()}`);
    }
    for (const g of BANNED_GLOBALS) {
      // Boundaries on BOTH sides, so `processOrder`, `processed` and `bufferSize`
      // do not trip it. `require(` carries its own trailing boundary.
      const body = g.replace(/[(]/g, '\\(');
      const trailing = g.endsWith('(') ? '' : '\\b';
      const re = new RegExp(`(^|[^\\w.$])${body}${trailing}`);
      if (re.test(code)) {
        failures.push(`${at}  uses the Node global \`${g.replace('(', '')}\`: ${line.trim()}`);
      }
    }
  });
}

// ---------------------------------------------------------------- report

if (scanned === 0) {
  console.log('check-no-deps: no files under src/ yet — dependency check only');
}

if (failures.length > 0) {
  console.error(`check-no-deps: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nsrc/ must run unmodified on Bun, Node, Deno, Cloudflare Workers and browsers.\n' +
      'Use globalThis.fetch, WebSocket, crypto.getRandomValues, TextEncoder and BigInt.\n' +
      'Tooling under scripts/, bench/ and test/ may use Node APIs freely.',
  );
  process.exit(1);
}

console.log(`check-no-deps: ok (${scanned} file(s) under src/, no deps, no Node built-ins)`);
