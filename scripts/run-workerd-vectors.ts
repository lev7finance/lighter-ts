interface Failure {
  readonly detail: string;
}

export {};

interface HarnessSummary {
  readonly total: number;
  readonly failures: number;
  readonly failed: readonly Failure[];
}

interface WorkerSummary {
  readonly runtime: string;
  readonly vectors: HarnessSummary;
  readonly behaviour: HarnessSummary;
}

const configuredPort = process.env["LIGHTER_WORKER_PORT"];
let port: number;
if (configuredPort === undefined) {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (): Response => new Response(),
  });
  const reservedPort = reservation.port;
  if (reservedPort === undefined) throw new Error("Bun did not report its reserved port");
  port = reservedPort;
  await reservation.stop(true);
} else {
  port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LIGHTER_WORKER_PORT must be an integer in [1, 65535]");
  }
}

const args = [
  "bunx",
  "wrangler",
  "dev",
  "--config",
  "test/portability/wrangler.jsonc",
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
  "--log-level",
  "error",
];
if (process.env["NODEJS_COMPAT"] === "1") {
  args.push("--compatibility-flag", "nodejs_compat");
}

const wrangler = Bun.spawn(args, {
  cwd: process.cwd(),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

async function requestSummary(): Promise<WorkerSummary> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (await Promise.race([wrangler.exited.then(() => true), Bun.sleep(0).then(() => false)])) {
      throw new Error(`wrangler exited before becoming ready (exit ${String(await wrangler.exited)})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(`worker returned HTTP ${String(response.status)}: ${JSON.stringify(body)}`);
      }
      return body as WorkerSummary;
    } catch (error: unknown) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw new Error(
    `workerd did not return a summary within 60s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function report(label: string, summary: HarnessSummary): void {
  console.log(`${label}: ${String(summary.total)} checks, ${String(summary.failures)} failures`);
  for (const failure of summary.failed) console.error(`  ${failure.detail}`);
}

try {
  const summary = await requestSummary();
  report("vectors", summary.vectors);
  report("behaviour", summary.behaviour);
  if (summary.runtime !== "workerd") {
    throw new Error(`unexpected runtime label: ${summary.runtime}`);
  }
  if (summary.vectors.failures !== 0 || summary.behaviour.failures !== 0) process.exitCode = 1;
} finally {
  wrangler.kill("SIGTERM");
  await wrangler.exited;
}
