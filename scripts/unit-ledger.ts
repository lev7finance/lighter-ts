interface Unit {
  key: string;
  title: string;
  wave: number;
  labels: string[];
  files: string[];
  dependsOn: string[];
  risk: "low" | "medium" | "high";
  intent: string;
}

export {};

interface LedgerInput {
  units: readonly Unit[];
}

interface DuplicateFileCollision {
  file: string;
  ownerA: string;
  ownerB: string;
}

interface BadDependency {
  key: string;
  dependsOn: string;
}

const ledgers = JSON.parse(await Bun.file("docs/unit-ledger.json").text()) as LedgerInput;
const units = [...ledgers.units];

const seen = new Map<string, string>();
const dupes: DuplicateFileCollision[] = [];

for (const unit of units) {
  for (const file of unit.files) {
    const previousOwner = seen.get(file);
    if (previousOwner !== undefined) {
      dupes.push({ file, ownerA: previousOwner, ownerB: unit.key });
      continue;
    }
    seen.set(file, unit.key);
  }
}

const unitKeys = new Set(units.map((unit) => unit.key));
const badDeps: BadDependency[] = [];
for (const unit of units) {
  for (const dep of unit.dependsOn) {
    if (!unitKeys.has(dep)) {
      badDeps.push({ key: unit.key, dependsOn: dep });
    }
  }
}

const byWave = new Map<number, number>();
for (const unit of units) {
  byWave.set(unit.wave, (byWave.get(unit.wave) ?? 0) + 1);
}

const indeg = new Map<string, number>();
const adj = new Map<string, string[]>();

for (const unit of units) {
  if (!indeg.has(unit.key)) {
    indeg.set(unit.key, 0);
  }
  for (const dep of unit.dependsOn) {
    adj.set(dep, [...(adj.get(dep) ?? []), unit.key]);
    indeg.set(unit.key, (indeg.get(unit.key) ?? 0) + 1);
  }
}

const q: string[] = [];
for (const [key, deg] of indeg) {
  if (deg === 0) q.push(key);
}

const order: string[] = [];
while (q.length > 0) {
  const n = q.pop()!;
  order.push(n);
  const neighbors = adj.get(n);
  if (neighbors === undefined) continue;
  for (const m of neighbors) {
    indeg.set(m, (indeg.get(m) ?? 0) - 1);
    if ((indeg.get(m) ?? 0) === 0) {
      q.push(m);
    }
  }
}

const report = [
  `units: ${units.length}   owned paths: ${seen.size}`,
  `by wave: ${JSON.stringify(Object.fromEntries([...byWave.entries()].sort((a, b) => a[0] - b[0])))}`,
];

if (dupes.length > 0) {
  report.push("\nFILE OWNERSHIP COLLISIONS:");
  for (const { file, ownerA, ownerB } of dupes) {
    report.push(`  ${file}  claimed by ${ownerA} AND ${ownerB}`);
  }
}

if (badDeps.length > 0) {
  report.push("\nUNKNOWN DEPENDENCIES:");
  for (const { key, dependsOn } of badDeps) {
    report.push(`  ${key} -> ${dependsOn}`);
  }
}

report.push(`\ncycles: ${order.length === units.length ? "NONE" : "CYCLE DETECTED"}`);

if (dupes.length === 0 && badDeps.length === 0 && order.length === units.length) {
  await Bun.write("ledger.json", JSON.stringify({ units }, null, 1));
  report.push("\nwrote ledger.json");
  console.log(report.join("\n"));
} else {
  console.error(report.join("\n"));
  process.exit(1);
}
