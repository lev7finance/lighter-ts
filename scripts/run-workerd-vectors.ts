/**
 * Correctness harness and deployed Cloudflare Workers CPU benchmark for issue #3.
 *
 * Local:
 *   bun run scripts/run-workerd-vectors.ts --local
 *
 * Deployed gate:
 *   bun run scripts/run-workerd-vectors.ts --deployed --iters 200 --json
 *
 * The deployed run uses `wrangler tail --format json`. Its `cpuTime` and `wallTime`
 * fields are Cloudflare platform telemetry; no in-Worker clock is used.
 */

export {};

const CONFIG = "test/portability/wrangler.jsonc";
const WORKER_NAME = "lighter-ts-worker-benchmark-issue-3";
const TELEMETRY_SOURCE = "Cloudflare live tail (`wrangler tail --format json`)";
const COMPATIBILITY_DATE = "2026-07-28";

interface Cli {
  readonly mode: "local" | "deployed";
  readonly iters: number;
  readonly json: boolean;
  readonly planTier: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface WorkerResponse {
  readonly iters?: number;
  readonly checksum?: string;
  readonly isolateInvocation?: number;
  readonly sample?: string | null;
  readonly ok?: boolean;
  readonly failures?: readonly string[];
  readonly checks?: number;
}

interface DrivenRequest {
  readonly operation: "sign" | "verify";
  readonly sample: string;
  readonly ok: boolean;
  readonly status: number;
  readonly responseText: string;
  readonly checksum?: string;
  readonly isolateInvocation?: number;
  readonly clientRttMs: number;
}

interface TailEvent {
  readonly sample: string;
  readonly operation: "sign" | "verify";
  readonly isolateInvocation: number;
  readonly cpuMs: number;
  readonly platformWallMs: number;
  readonly outcome: string;
  readonly timestamp: number;
}

interface JoinedSample extends TailEvent {
  readonly checksum: string;
  readonly clientRttMs: number;
  readonly isolateInvocation: number;
  readonly cold: boolean;
}

interface Quantiles {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
}

interface OperationReport {
  readonly requestedWarmInvocations: number;
  readonly attemptedInvocations: number;
  readonly successfulResponses: number;
  readonly warm: {
    readonly cpuMs: Quantiles;
    readonly platformWallMs: Quantiles;
    readonly clientRttMs: Quantiles;
  };
  readonly cold: {
    readonly cpuMs: readonly number[];
    readonly platformWallMs: readonly number[];
    readonly clientRttMs: readonly number[];
  };
  readonly checksums: readonly string[];
  readonly failedResponseCount: number;
  readonly failedResponses: readonly {
    readonly status: number;
    readonly response: string;
  }[];
}

interface GateReport {
  readonly deploymentDate: string;
  readonly accountPlanTier: string;
  readonly compatibilityDate: string;
  readonly telemetrySource: string;
  readonly workerUrl: string;
  readonly selfcheck: WorkerResponse;
  readonly sign: OperationReport;
  readonly verify: OperationReport;
  readonly verdict: "pass" | "fallback" | "escalate" | "blocked";
  readonly deletionConfirmed: boolean;
}

function parsePositiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function parseCli(argv: readonly string[]): Cli {
  let mode: "local" | "deployed" = "local";
  let modeSeen = false;
  let iters = 200;
  let json = false;
  let planTier = process.env["CLOUDFLARE_WORKERS_PLAN"] ?? "unknown";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--local" || arg === "--deployed") {
      if (modeSeen) throw new Error("choose exactly one of --local or --deployed");
      mode = arg === "--local" ? "local" : "deployed";
      modeSeen = true;
    } else if (arg === "--iters") {
      iters = parsePositiveInteger(argv[++i], "--iters");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--plan") {
      const value = argv[++i];
      if (value === undefined || value.length === 0) throw new Error("--plan requires a value");
      planTier = value;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }

  if (mode === "deployed" && iters < 200) {
    throw new Error("--deployed requires --iters >= 200; the issue gate forbids smaller runs");
  }
  return { mode, iters, json, planTier };
}

async function command(args: readonly string[], inherit = false): Promise<CommandResult> {
  const child = Bun.spawn([...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function reservePort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (): Response => new Response(),
  });
  const port = reservation.port;
  void reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not report its reserved port");
  return port;
}

async function fetchJson(url: string, timeoutMs = 60_000): Promise<{
  readonly response: Response;
  readonly body: WorkerResponse;
}> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: WorkerResponse;
  try {
    body = JSON.parse(text) as WorkerResponse;
  } catch {
    throw new Error(
      `expected JSON from ${url}, got HTTP ${String(response.status)}: ${text.slice(0, 500)}`,
    );
  }
  return { response, body };
}

async function local(): Promise<void> {
  const port = reservePort();
  const wrangler = Bun.spawn(
    [
      "bunx",
      "wrangler@4",
      "dev",
      "--config",
      CONFIG,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "error",
    ],
    {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  try {
    while (Date.now() < deadline) {
      const exited = await Promise.race([
        wrangler.exited.then(() => true),
        Bun.sleep(0).then(() => false),
      ]);
      if (exited) {
        throw new Error(`wrangler exited before becoming ready (exit ${String(await wrangler.exited)})`);
      }
      try {
        const { response, body } = await fetchJson(
          `http://127.0.0.1:${String(port)}/selfcheck`,
          Math.max(1, deadline - Date.now()),
        );
        console.log(JSON.stringify(body, null, 2));
        if (!response.ok || body.ok !== true) {
          throw new Error(
            `local selfcheck failed (HTTP ${String(response.status)}): ${JSON.stringify(body)}`,
          );
        }
        return;
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("local selfcheck failed")) {
          throw error;
        }
        lastError = error;
        await Bun.sleep(100);
      }
    }
    throw new Error(
      `workerd did not pass /selfcheck within 60s: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  } finally {
    wrangler.kill("SIGTERM");
    await wrangler.exited;
  }
}

function records(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nested(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!records(current)) return undefined;
    current = current[key];
  }
  return current;
}

function telemetryInvocation(
  value: unknown,
  sample: string,
  operation: "sign" | "verify",
): number | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = telemetryInvocation(entry, sample, operation);
      if (found !== null) return found;
    }
    return null;
  }
  if (!records(value)) return null;
  if (
    value["benchmark"] === "lighter-ts-issue-3" &&
    value["sample"] === sample &&
    value["operation"] === operation &&
    typeof value["isolateInvocation"] === "number"
  ) {
    return value["isolateInvocation"];
  }
  for (const entry of Object.values(value)) {
    const found = telemetryInvocation(entry, sample, operation);
    if (found !== null) return found;
  }
  return null;
}

function tailEvent(value: unknown): TailEvent | null {
  const rawUrl = nested(value, "event", "request", "url");
  const cpuMs = nested(value, "cpuTime");
  const platformWallMs = nested(value, "wallTime");
  const outcome = nested(value, "outcome");
  const timestamp = nested(value, "eventTimestamp");
  if (
    typeof rawUrl !== "string" ||
    typeof cpuMs !== "number" ||
    typeof platformWallMs !== "number" ||
    typeof outcome !== "string" ||
    typeof timestamp !== "number"
  ) {
    return null;
  }
  const url = new URL(rawUrl);
  const operation =
    url.pathname === "/sign" ? "sign" : url.pathname === "/verify" ? "verify" : null;
  const sample = url.searchParams.get("sample");
  if (operation === null || sample === null) return null;
  const isolateInvocation = telemetryInvocation(nested(value, "logs"), sample, operation);
  if (isolateInvocation === null) return null;
  return {
    sample,
    operation,
    isolateInvocation,
    cpuMs,
    platformWallMs,
    outcome,
    timestamp,
  };
}

class JsonObjectStream {
  private buffer = "";
  private depth = 0;
  private start = -1;
  private inString = false;
  private escaped = false;

  push(chunk: string): unknown[] {
    const values: unknown[] = [];
    const offset = this.buffer.length;
    this.buffer += chunk;

    for (let i = offset; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === "{") {
        if (this.depth === 0) this.start = i;
        this.depth += 1;
      } else if (char === "}") {
        this.depth -= 1;
        if (this.depth === 0 && this.start >= 0) {
          const raw = this.buffer.slice(this.start, i + 1);
          try {
            values.push(JSON.parse(raw) as unknown);
          } catch {
            // Wrangler can write non-JSON status text around the JSON objects; ignore it.
          }
          this.buffer = this.buffer.slice(i + 1);
          i = -1;
          this.start = -1;
        }
      }
    }

    if (this.depth === 0 && this.buffer.length > 64 * 1024) this.buffer = this.buffer.slice(-4096);
    return values;
  }
}

function pumpTail(
  stream: ReadableStream<Uint8Array>,
  events: TailEvent[],
): Promise<void> {
  return (async (): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parser = new JsonObjectStream();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      for (const value of parser.push(decoder.decode(next.value, { stream: true }))) {
        const event = tailEvent(value);
        if (event !== null) events.push(event);
      }
    }
  })();
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function drive(
  baseUrl: string,
  operation: "sign" | "verify",
  sample: string,
): Promise<DrivenRequest> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/${operation}?iters=1&sample=${encodeURIComponent(sample)}`, {
    headers: { "cache-control": "no-store" },
    signal: AbortSignal.timeout(60_000),
  });
  const clientRttMs = performance.now() - started;
  const responseText = await response.text();
  let body: WorkerResponse = {};
  try {
    body = JSON.parse(responseText) as WorkerResponse;
  } catch {
    // Platform error pages are plain text and must be preserved verbatim in the report.
  }
  const result: DrivenRequest = {
    operation,
    sample,
    ok: response.ok && body.iters === 1 && typeof body.checksum === "string",
    status: response.status,
    responseText,
    clientRttMs,
  };
  if (body.checksum !== undefined) {
    (result as { checksum?: string }).checksum = body.checksum;
  }
  if (body.isolateInvocation !== undefined) {
    (result as { isolateInvocation?: number }).isolateInvocation = body.isolateInvocation;
  }
  return result;
}

function quantiles(values: readonly number[]): Quantiles {
  if (values.length === 0) return { count: 0, p50: null, p90: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.ceil(q * sorted.length) - 1] as number;
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

function operationReport(
  requested: number,
  requests: readonly DrivenRequest[],
  events: readonly TailEvent[],
): OperationReport {
  const bySample = new Map(requests.map((request) => [request.sample, request]));
  const failedRequests = requests.filter((request) => !request.ok);
  const joined: JoinedSample[] = [];
  for (const event of events) {
    const request = bySample.get(event.sample);
    if (
      request === undefined ||
      !request.ok ||
      request.checksum === undefined ||
      event.outcome !== "ok"
    ) {
      continue;
    }
    joined.push({
      ...event,
      checksum: request.checksum,
      clientRttMs: request.clientRttMs,
      cold: event.isolateInvocation === 1,
    });
  }
  const warm = joined.filter((sample) => !sample.cold);
  const cold = joined.filter((sample) => sample.cold);
  return {
    requestedWarmInvocations: requested,
    attemptedInvocations: requests.length,
    successfulResponses: requests.filter((request) => request.ok).length,
    warm: {
      cpuMs: quantiles(warm.map((sample) => sample.cpuMs)),
      platformWallMs: quantiles(warm.map((sample) => sample.platformWallMs)),
      clientRttMs: quantiles(warm.map((sample) => sample.clientRttMs)),
    },
    cold: {
      cpuMs: cold.map((sample) => sample.cpuMs),
      platformWallMs: cold.map((sample) => sample.platformWallMs),
      clientRttMs: cold.map((sample) => sample.clientRttMs),
    },
    checksums: [...new Set(joined.map((sample) => sample.checksum))],
    failedResponseCount: failedRequests.length,
    failedResponses: failedRequests
      .slice(0, 10)
      .map((request) => ({ status: request.status, response: request.responseText.slice(0, 500) })),
  };
}

function verdict(sign: OperationReport, verifyReport: OperationReport): GateReport["verdict"] {
  const p50 = sign.warm.cpuMs.p50;
  const p99 = sign.warm.cpuMs.p99;
  if (
    sign.warm.cpuMs.count < sign.requestedWarmInvocations ||
    verifyReport.warm.cpuMs.count < verifyReport.requestedWarmInvocations ||
    p50 === null ||
    p99 === null
  ) {
    return "blocked";
  }
  if (p50 <= 25 && p99 <= 50) return "pass";
  if (p99 > 50 && p99 <= 200) return "fallback";
  return "escalate";
}

function markdown(report: GateReport): string {
  const row = (name: string, operation: OperationReport): string =>
    `| ${name} | ${String(operation.warm.cpuMs.count)} | ${String(operation.warm.cpuMs.p50)} | ${String(operation.warm.cpuMs.p90)} | ${String(operation.warm.cpuMs.p99)} | ${operation.checksums.join(", ")} |`;
  return [
    `Deployment date: ${report.deploymentDate}`,
    `Account plan tier: ${report.accountPlanTier}`,
    `Compatibility date: ${report.compatibilityDate}`,
    `Telemetry source: ${report.telemetrySource}`,
    "",
    "| operation | warm invocations | CPU p50 ms | CPU p90 ms | CPU p99 ms | checksum |",
    "|---|---:|---:|---:|---:|---|",
    row("sign", report.sign),
    row("verify", report.verify),
    "",
    `Cold sign CPU ms: ${report.sign.cold.cpuMs.join(", ") || "none observed"}`,
    `Cold verify CPU ms: ${report.verify.cold.cpuMs.join(", ") || "none observed"}`,
    `Verdict: **${report.verdict}**`,
  ].join("\n");
}

async function waitForTelemetry(
  events: readonly TailEvent[],
  requests: readonly DrivenRequest[],
  requestedPerOperation: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const reports = {
      sign: operationReport(
        requestedPerOperation,
        requests.filter((request) => request.operation === "sign"),
        events.filter((event) => event.operation === "sign"),
      ),
      verify: operationReport(
        requestedPerOperation,
        requests.filter((request) => request.operation === "verify"),
        events.filter((event) => event.operation === "verify"),
      ),
    };
    if (
      reports.sign.warm.cpuMs.count >= requestedPerOperation &&
      reports.verify.warm.cpuMs.count >= requestedPerOperation
    ) {
      return;
    }
    await Bun.sleep(250);
  }
}

async function deployed(cli: Cli): Promise<GateReport> {
  let deployedWorker = false;
  let deleted = false;
  let tail: ReturnType<typeof Bun.spawn> | undefined;
  let tailPump: Promise<void> | undefined;
  let tailErrors: Promise<string> | undefined;
  const events: TailEvent[] = [];

  try {
    const deployment = await command(["bunx", "wrangler@4", "deploy", "--config", CONFIG]);
    if (deployment.exitCode !== 0) {
      throw new Error(`wrangler deploy failed:\n${deployment.stdout}\n${deployment.stderr}`);
    }
    deployedWorker = true;
    const workerUrl = deployment.stdout.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
    if (workerUrl === undefined) {
      throw new Error(`could not find workers.dev URL in deploy output:\n${deployment.stdout}`);
    }

    const startedTail = Bun.spawn(
      ["bunx", "wrangler@4", "tail", WORKER_NAME, "--format", "json"],
      { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    tail = startedTail;
    tailPump = pumpTail(startedTail.stdout, events);
    tailErrors = drain(startedTail.stderr);
    await Bun.sleep(2_000);

    // A complete signature first gives a fresh deployment a chance to expose a cold-sign sample.
    const requests: DrivenRequest[] = [];
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const firstSignDeadline = Date.now() + 60_000;
    let firstSignAttempt = 0;
    let firstSignPassed = false;
    while (Date.now() < firstSignDeadline) {
      const first = await drive(
        workerUrl,
        "sign",
        `${runId}-sign-prefight-${String(firstSignAttempt)}`,
      );
      requests.push(first);
      if (first.ok) {
        firstSignPassed = true;
        break;
      }
      firstSignAttempt += 1;
      await Bun.sleep(500);
    }
    if (!firstSignPassed) throw new Error("deployed /sign did not become ready within 60 seconds");

    let selfcheck: WorkerResponse | undefined;
    let selfcheckError = "";
    const selfcheckDeadline = Date.now() + 60_000;
    let selfcheckAttempt = 0;
    while (Date.now() < selfcheckDeadline) {
      try {
        const result = await fetchJson(
          `${workerUrl}/selfcheck?attempt=${String(selfcheckAttempt)}`,
        );
        if (result.response.ok && result.body.ok === true) {
          selfcheck = result.body;
          break;
        }
        selfcheckError = `HTTP ${String(result.response.status)}: ${JSON.stringify(result.body)}`;
      } catch (error: unknown) {
        selfcheckError = error instanceof Error ? error.message : String(error);
      }
      selfcheckAttempt += 1;
      await Bun.sleep(500);
    }
    if (selfcheck === undefined) throw new Error(`deployed /selfcheck did not pass: ${selfcheckError}`);

    const maxAttempts = cli.iters * 2 + 50;
    for (const operation of ["sign", "verify"] as const) {
      let attempts = requests.filter((request) => request.operation === operation).length;
      while (attempts < maxAttempts) {
        const successfulWarm = requests.filter(
          (request) =>
            request.operation === operation &&
            request.ok &&
            request.isolateInvocation !== undefined &&
            request.isolateInvocation > 1,
        ).length;
        if (successfulWarm >= cli.iters + 10) break;
        requests.push(await drive(workerUrl, operation, `${runId}-${operation}-${String(attempts)}`));
        attempts += 1;
      }
    }

    await waitForTelemetry(events, requests, cli.iters);
    const sign = operationReport(
      cli.iters,
      requests.filter((request) => request.operation === "sign"),
      events.filter((event) => event.operation === "sign"),
    );
    const verifyReport = operationReport(
      cli.iters,
      requests.filter((request) => request.operation === "verify"),
      events.filter((event) => event.operation === "verify"),
    );
    const report: GateReport = {
      deploymentDate: new Date().toISOString(),
      accountPlanTier: cli.planTier,
      compatibilityDate: COMPATIBILITY_DATE,
      telemetrySource: TELEMETRY_SOURCE,
      workerUrl,
      selfcheck,
      sign,
      verify: verifyReport,
      verdict: verdict(sign, verifyReport),
      deletionConfirmed: false,
    };
    return report;
  } finally {
    if (tail !== undefined) {
      tail.kill("SIGTERM");
      await tail.exited;
      await tailPump;
      const tailErrorText = await tailErrors;
      if (tailErrorText !== undefined && tailErrorText.trim().length > 0) {
        console.error(tailErrorText.trim());
      }
    }
    if (deployedWorker) {
      const removal = await command(["bunx", "wrangler@4", "delete", WORKER_NAME, "--force"]);
      deleted = removal.exitCode === 0;
      if (!deleted) {
        console.error(`worker deletion failed:\n${removal.stdout}\n${removal.stderr}`);
      }
    }
    deletionState = deleted;
  }
}

let deletionState = false;

const cli = parseCli(process.argv.slice(2));
if (cli.mode === "local") {
  await local();
} else {
  const report = await deployed(cli);
  const completed: GateReport = { ...report, deletionConfirmed: deletionState };
  console.log(markdown(completed));
  if (cli.json) console.log(JSON.stringify(completed, null, 2));
  if (!completed.deletionConfirmed || completed.verdict === "blocked") process.exitCode = 1;
}
