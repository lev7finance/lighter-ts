// Does BigInt Goldilocks arithmetic fit in a Cloudflare Workers CPU budget?
//
// A Schnorr signature needs roughly one scalar multiplication over ECgFp5.
// Each ECgFp5 point op is a handful of GF(p^5) ops; each GF(p^5) multiply is
// ~25 base-field multiplies plus reductions. The architecture's estimate is
// ~85,000 base-field multiplications per signature.
//
// This measures the base-field primitive directly and extrapolates, comparing
// three candidate reduction strategies.

const P = 0xffffffff00000001n; // 2^64 - 2^32 + 1
const MASK64 = (1n << 64n) - 1n;
const EPSILON = (1n << 32n) - 1n;

/** Strategy A: the obvious one. Multiply, then a single modulo. */
function mulPlain(a: bigint, b: bigint): bigint {
  return (a * b) % P;
}

/** Strategy B: Goldilocks-specific folding, mirroring the reference's shape. */
function mulFold(a: bigint, b: bigint): bigint {
  const x = a * b;
  const lo = x & MASK64;
  const hi = x >> 64n;
  const hiHi = hi >> 32n;
  const hiLo = hi & EPSILON;

  let t0 = lo - hiHi;
  if (t0 < 0n) t0 += P;

  const t1 = hiLo * EPSILON;
  let r = t0 + t1;
  if (r >= P) r -= P;
  if (r >= P) r -= P;
  return r;
}

/** Strategy C: fold, but finish with % instead of conditional subtractions. */
function mulFoldMod(a: bigint, b: bigint): bigint {
  const x = a * b;
  const lo = x & MASK64;
  const hi = x >> 64n;
  return (lo + (hi & EPSILON) * EPSILON - (hi >> 32n)) % P;
}

function correctness() {
  // splitmix64-ish deterministic inputs
  let s = 0x1337c0de5eed0001n;
  const next = () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) % P;
  };
  let bad = 0;
  for (let i = 0; i < 20000; i++) {
    const a = next();
    const b = next();
    const want = mulPlain(a, b);
    let got = mulFold(a, b);
    if (got !== want) bad++;
    got = ((mulFoldMod(a, b) % P) + P) % P;
    if (got !== want) bad++;
  }
  return bad;
}

function bench(name: string, fn: (a: bigint, b: bigint) => bigint, iters: number) {
  let a = 0x123456789abcdefn % P;
  const b = 0xfedcba987654321n % P;
  // warm up the JIT
  for (let i = 0; i < 200_000; i++) a = fn(a, b) | 1n;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) a = fn(a, b) | 1n;
  const dt = performance.now() - t0;
  const nsPerOp = (dt * 1e6) / iters;
  const perSig = (nsPerOp * 85_000) / 1e6; // ms for ~85k muls
  console.log(
    `  ${name.padEnd(12)} ${(dt).toFixed(1).padStart(8)} ms / ${iters.toLocaleString()} ops` +
      `  = ${nsPerOp.toFixed(1).padStart(6)} ns/op` +
      `  -> ~${perSig.toFixed(1).padStart(6)} ms per signature`,
  );
  if (a === 0n) console.log('unreachable');
  return perSig;
}

const runtime =
  typeof (globalThis as any).Bun !== 'undefined'
    ? `Bun ${(globalThis as any).Bun.version}`
    : typeof (globalThis as any).Deno !== 'undefined'
      ? `Deno ${(globalThis as any).Deno.version.deno}`
      : `Node ${process.versions.node}`;

console.log(`runtime: ${runtime}`);
const bad = correctness();
console.log(`correctness: ${bad === 0 ? 'all three strategies agree over 20,000 random pairs' : `${bad} MISMATCHES`}`);
console.log('');
const ITERS = 2_000_000;
const a = bench('mulPlain', mulPlain, ITERS);
const b = bench('mulFold', mulFold, ITERS);
const c = bench('mulFoldMod', mulFoldMod, ITERS);
console.log('');
const best = Math.min(a, b, c);
console.log(`best: ~${best.toFixed(1)} ms per signature (~85k base-field muls)`);
console.log(
  `Cloudflare Workers CPU budget is 10 ms (free) / 30 s (paid, unbound): ` +
    `${best < 10 ? 'fits free tier' : best < 50 ? 'needs paid tier, fits comfortably' : 'PROBLEM'}`,
);
