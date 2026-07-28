/**
 * Size gate for the published subpaths.
 *
 *   bun run size                # measure and compare against size-budget.json
 *   bun run size -- --calibrate # rewrite size-budget.json from the current build
 *
 * Three jobs, in order of how much they matter:
 *
 * 1. **Resolve every `exports` target against `dist/`.** An exports map pointing at a file no unit
 *    emitted is invisible until a consumer types `import … from "lighter-ts/thing"` and gets
 *    `ERR_MODULE_NOT_FOUND`; `bun test` does not catch it, because the tests import source. This is
 *    the cheapest possible check for it, so it runs first and fails loudly.
 * 2. **Measure each subpath's own module graph.** The build is unbundled — `tsc` emits one `.js`
 *    per source file — so "the size of `lighter-ts/crypto`" is the gzipped size of every module
 *    reachable from `dist/crypto/index.js` through relative imports, not the size of that one file.
 *    Modules shared by two subpaths are counted in both, which is what a consumer importing exactly
 *    one subpath actually pays.
 * 3. **Compare against `size-budget.json` and exit non-zero on an overage.** A subpath present in
 *    `exports` and absent from the budget is also a failure: a new entry must not be able to dodge
 *    the gate by not being listed.
 *
 * `scripts/` is build tooling, not part of the published import graph, so `Bun.gzipSync` and
 * `node:zlib` are both fair game here. The no-Node-built-ins rule applies to `src/**`
 * (`scripts/check-no-deps.ts` enforces it there).
 *
 * The numbers are gzip, not brotli, and they are the *compressed transfer* cost of the module
 * graph — not what survives a consumer's tree-shaker, which for a subpath import is usually far
 * less. Treat them as a regression tripwire, not as a promise about bundle output.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const BUDGET_FILE = join(ROOT, 'size-budget.json');

/** ~15 % headroom over the measured value, rounded up to the next 256 bytes. */
const HEADROOM = 1.15;
const ROUND_TO = 256;

const calibrate = process.argv.includes('--calibrate');

// ------------------------------------------------------------------ types

interface Budget {
  readonly budgets: Record<string, number>;
  readonly measured?: Record<string, number>;
  readonly measuredAt?: string;
  readonly note?: readonly string[];
}

/**
 * Written into `size-budget.json` by `--calibrate`, so the file explains itself to whoever opens it
 * after a CI failure. The comment-free figures are a fixed, dated measurement — see the note.
 */
const NOTE: readonly string[] = [
  "Gzipped bytes of each subpath's transitive relative-import graph in dist/, as emitted.",
  'budgets = measured + ~15% headroom, rounded up to 256 B. Regenerate with',
  '`bun run size -- --calibrate` and review the diff: a jump means a subpath pulled in a module',
  'graph it did not have before.',
  'These numbers include JSDoc, which tsc preserves and which is roughly two thirds of the bytes.',
  'Measured 2026-07-26, the same graphs built with `tsc --removeComments` gzip to 108.1 KB at the',
  'root, 16.5 KB for ./crypto, 28.7 KB for ./tx, 31.1 KB for ./ws, 12.6 KB for ./rest and',
  '101.0 KB for ./client — closer to what a consumer bundles after minification.',
  'docs/spec/08-extras-and-dx.md B4 proposed ceilings of 24 KB for ./crypto, 16 KB for ./tx,',
  '20 KB for ./rest, 8 KB for ./ws and 60 KB for the root barrel. Those were guesses made before',
  'any code existed; ./tx, ./ws and the root exceed them even comment-free. These budgets are',
  'measured, so they gate regressions rather than aspirations.',
];

interface Measurement {
  readonly subpath: string;
  readonly entry: string;
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

// ------------------------------------------------------------------ exports map

type ExportTarget = string | { readonly types?: string; readonly default?: string };

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, ExportTarget>;
};

const failures: string[] = [];

/** Every file the exports map points at, subpath by subpath. */
const targets: { subpath: string; condition: string; file: string }[] = [];
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target === 'string') {
    targets.push({ subpath, condition: 'default', file: target });
    continue;
  }
  for (const condition of ['types', 'default'] as const) {
    const file = target[condition];
    if (file === undefined) {
      failures.push(`exports["${subpath}"] has no "${condition}" condition`);
      continue;
    }
    targets.push({ subpath, condition, file });
  }
  for (const condition of Object.keys(target)) {
    if (condition !== 'types' && condition !== 'default') {
      failures.push(
        `exports["${subpath}"] declares a "${condition}" condition; this package is ESM-only ` +
          '(docs/ARCHITECTURE.md ADR-4/ADR-8: a require condition reintroduces the dual-package hazard)',
      );
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

for (const { subpath, condition, file } of targets) {
  if (!file.startsWith('./')) {
    failures.push(`exports["${subpath}"].${condition} = "${file}" is not a relative path`);
    continue;
  }
  if (!(await exists(join(ROOT, file)))) {
    failures.push(
      `exports["${subpath}"].${condition} -> ${file} does not exist (run \`bun run build\` first)`,
    );
  }
}

if (failures.length > 0) {
  console.error(`report-size: ${failures.length} problem(s) with the exports map\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// ------------------------------------------------------------------ module graph

/**
 * Relative specifiers in emitted JavaScript: `import … from "./x.js"`, `export … from "./x.js"`,
 * bare `import "./x.js"`, and `import("./x.js")`. `tsc` with `module: nodenext` writes extensions
 * verbatim, so no resolution guessing is needed — but a specifier that does not resolve is still
 * reported rather than skipped.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g;

async function graphOf(entryAbs: string): Promise<string[]> {
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue = [normalize(entryAbs)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      missing.push(file);
      continue;
    }
    seen.add(file);
    for (const m of source.matchAll(SPECIFIER)) {
      queue.push(normalize(resolve(dirname(file), m[1]!)));
    }
  }

  if (missing.length > 0) {
    console.error('report-size: unresolved relative imports in the emitted output\n');
    for (const m of missing) console.error(`  ${relative(ROOT, m)}`);
    process.exit(1);
  }
  return [...seen].sort();
}

async function measure(subpath: string, entryFile: string): Promise<Measurement> {
  const files = await graphOf(join(ROOT, entryFile));
  const sources = await Promise.all(files.map((f) => readFile(f)));
  const concatenated = Buffer.concat(sources);
  return {
    subpath,
    entry: entryFile,
    files: files.length,
    rawBytes: concatenated.byteLength,
    gzipBytes: gzipSync(concatenated, { level: 9 }).byteLength,
  };
}

const measurements: Measurement[] = [];
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (subpath === './package.json') continue; // not code, nothing to walk
  const entry = typeof target === 'string' ? target : target.default!;
  measurements.push(await measure(subpath, entry));
}

// ------------------------------------------------------------------ calibrate or compare

function ceilTo(n: number, step: number): number {
  return Math.ceil(n / step) * step;
}

if (calibrate) {
  const budgets: Record<string, number> = {};
  const measured: Record<string, number> = {};
  for (const m of measurements) {
    budgets[m.subpath] = ceilTo(m.gzipBytes * HEADROOM, ROUND_TO);
    measured[m.subpath] = m.gzipBytes;
  }
  const next: Budget = {
    note: NOTE,
    measuredAt: new Date().toISOString().slice(0, 10),
    budgets,
    measured,
  };
  await writeFile(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`report-size: wrote ${relative(ROOT, BUDGET_FILE)}`);
}

const budget = JSON.parse(await readFile(BUDGET_FILE, 'utf8')) as Budget;

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const rows = [...measurements].sort((a, b) => b.gzipBytes - a.gzipBytes);

console.log('subpath          files      raw     gzip    budget');
for (const m of rows) {
  const limit = budget.budgets[m.subpath];
  console.log(
    `${m.subpath.padEnd(15)} ${String(m.files).padStart(5)} ${kb(m.rawBytes).padStart(9)} ` +
      `${kb(m.gzipBytes).padStart(8)} ${(limit === undefined ? '—' : kb(limit)).padStart(9)}`,
  );
}

const overages: string[] = [];
for (const m of measurements) {
  const limit = budget.budgets[m.subpath];
  if (limit === undefined) {
    overages.push(
      `${m.subpath} is in the exports map but not in size-budget.json ` +
        `(measured ${m.gzipBytes} B gz; add a budget rather than removing the gate)`,
    );
  } else if (m.gzipBytes > limit) {
    overages.push(
      `${m.subpath} is ${m.gzipBytes} B gz, over its ${limit} B budget by ` +
        `${m.gzipBytes - limit} B (${((m.gzipBytes / limit - 1) * 100).toFixed(1)} %)`,
    );
  }
}

const measuredSubpaths = new Set(measurements.map((m) => m.subpath));
for (const subpath of Object.keys(budget.budgets)) {
  if (!measuredSubpaths.has(subpath)) {
    overages.push(`size-budget.json budgets "${subpath}", which the exports map no longer has`);
  }
}

if (overages.length > 0) {
  console.error(`\nreport-size: ${overages.length} budget problem(s)\n`);
  for (const o of overages) console.error(`  ${o}`);
  console.error(
    '\nA subpath grew. Either the growth is justified — in which case run ' +
      '`bun run size -- --calibrate` and review the diff — or something imported a module graph it ' +
      'should not have.',
  );
  process.exit(1);
}

console.log(
  `\nreport-size: ok (${targets.length} exports targets resolved, ${measurements.length} subpaths within budget)`,
);
