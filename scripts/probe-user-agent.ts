export {};

type EnvironmentId = "local" | "dev" | "deployed";
type Classification = "CDN-HTML" | "API-JSON" | "other";

interface UaSetting {
  readonly id: "default" | "browser" | "library" | "curl";
  readonly label: string;
  readonly value: string | null;
}

interface ProbeTarget {
  readonly id: "trace" | "orderBooks" | "systemConfig" | "currentHeight" | "blocks";
  readonly label: string;
  readonly url: string;
}

interface TraceObservation {
  readonly sentUserAgent: string | null;
  readonly egressIp: string | null;
}

interface ProbeRecord extends TraceObservation {
  readonly environment: EnvironmentId;
  readonly userAgent: UaSetting["id"];
  readonly userAgentLabel: string;
  readonly requestedUserAgent: string | null;
  readonly target: ProbeTarget["id"];
  readonly targetUrl: string;
  readonly repeat: number;
  readonly timestamp: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly byteLength: number;
  readonly parsesAsJson: boolean;
  readonly htmlPrefix: string | null;
  readonly xAmzCfId: string | null;
  readonly xCache: string | null;
  readonly elapsedMs: number;
  readonly classification: Classification | null;
}

interface EnvironmentRun {
  readonly environment: EnvironmentId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly records: readonly ProbeRecord[];
}

interface ProbeOutput {
  readonly generatedAt: string;
  readonly repeats: number;
  readonly environments: readonly EnvironmentId[];
  readonly conclusion: string;
  readonly d5Conclusion: string;
  readonly runs: readonly EnvironmentRun[];
}

interface CliOptions {
  readonly environments: readonly EnvironmentId[];
  readonly repeats: number;
  readonly json: boolean;
  readonly out: string | null;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const API_ORIGIN = "https://mainnet.zklighter.elliot.ai";
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const DEFAULT_REPEATS = 3;
const WORKER_REQUEST_TIMEOUT_MS = 5 * 60_000;

const UA_SETTINGS: readonly UaSetting[] = [
  { id: "default", label: "not set", value: null },
  {
    id: "browser",
    label: "Chrome",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  },
  { id: "library", label: "lighter-ts", value: "lighter-ts/0.0.0" },
  { id: "curl", label: "curl", value: "curl/8.7.1" },
];

// Trace goes first so its observed uag/ip can be attached to every target in the same repeat.
const TARGETS: readonly ProbeTarget[] = [
  { id: "trace", label: "cdn-cgi/trace", url: TRACE_URL },
  { id: "orderBooks", label: "orderBooks", url: `${API_ORIGIN}/api/v1/orderBooks` },
  { id: "systemConfig", label: "systemConfig", url: `${API_ORIGIN}/api/v1/systemConfig` },
  { id: "currentHeight", label: "currentHeight", url: `${API_ORIGIN}/api/v1/currentHeight` },
  { id: "blocks", label: "blocks", url: `${API_ORIGIN}/api/v1/blocks?index=1&limit=1` },
];

function parseTrace(body: string): TraceObservation {
  let sentUserAgent: string | null = null;
  let egressIp: string | null = null;
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith("uag=")) sentUserAgent = line.slice(4);
    if (line.startsWith("ip=")) egressIp = line.slice(3);
  }
  return { sentUserAgent, egressIp };
}

function classify403(status: number, contentType: string | null): Classification | null {
  if (status !== 403) return null;
  const normalized = contentType?.toLowerCase() ?? "";
  if (normalized.includes("html")) return "CDN-HTML";
  if (normalized.includes("json")) return "API-JSON";
  return "other";
}

async function probeTarget(
  environment: EnvironmentId,
  userAgent: UaSetting,
  target: ProbeTarget,
  repeat: number,
  trace: TraceObservation | null,
): Promise<ProbeRecord> {
  const timestamp = new Date().toISOString();
  const started = performance.now();
  // Deliberately omit the entire init object for the default cell. It must measure the runtime's
  // untouched fetch behaviour, without even an empty Headers instance.
  const response =
    userAgent.value === null
      ? await globalThis.fetch(target.url)
      : await globalThis.fetch(target.url, { headers: { "User-Agent": userAgent.value } });
  const body = await response.text();
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  const contentType = response.headers.get("content-type");
  const ownTrace = target.id === "trace" ? parseTrace(body) : trace;

  // Read as text first and probe with JSON.parse. In particular, no 403 response is ever passed to
  // Response.json(), so a CloudFront HTML interstitial remains useful evidence.
  let parsesAsJson = false;
  try {
    JSON.parse(body);
    parsesAsJson = true;
  } catch {
    // The boolean is the observation.
  }

  return {
    environment,
    userAgent: userAgent.id,
    userAgentLabel: userAgent.label,
    requestedUserAgent: userAgent.value,
    target: target.id,
    targetUrl: target.url,
    repeat,
    timestamp,
    status: response.status,
    contentType,
    byteLength: new TextEncoder().encode(body).byteLength,
    parsesAsJson,
    htmlPrefix: contentType?.toLowerCase().includes("html") === true ? body.slice(0, 200) : null,
    xAmzCfId: response.headers.get("x-amz-cf-id"),
    xCache: response.headers.get("x-cache"),
    elapsedMs,
    classification: classify403(response.status, contentType),
    sentUserAgent: ownTrace?.sentUserAgent ?? null,
    egressIp: ownTrace?.egressIp ?? null,
  };
}

async function runEnvironment(environment: EnvironmentId, repeats: number): Promise<EnvironmentRun> {
  const startedAt = new Date().toISOString();
  const records: ProbeRecord[] = [];
  for (const userAgent of UA_SETTINGS) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      let trace: TraceObservation | null = null;
      for (const target of TARGETS) {
        const record = await probeTarget(environment, userAgent, target, repeat, trace);
        records.push(record);
        if (target.id === "trace") {
          trace = { sentUserAgent: record.sentUserAgent, egressIp: record.egressIp };
          if (trace.sentUserAgent === null || trace.egressIp === null) {
            throw new Error(
              `${environment}/${userAgent.id}/repeat-${String(repeat)}: trace omitted uag= or ip=`,
            );
          }
        }
      }
    }
  }
  return {
    environment,
    startedAt,
    completedAt: new Date().toISOString(),
    records,
  };
}

function workerSource(): string {
  return `
const UA_SETTINGS = ${JSON.stringify(UA_SETTINGS)};
const TARGETS = ${JSON.stringify(TARGETS)};
${parseTrace.toString()}
${classify403.toString()}
${probeTarget.toString()}
${runEnvironment.toString()}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/probe") return new Response("not found", { status: 404 });
    const environment = url.searchParams.get("environment");
    const repeats = Number(url.searchParams.get("repeats"));
    if ((environment !== "dev" && environment !== "deployed") ||
        !Number.isInteger(repeats) || repeats < 1) {
      return Response.json({ error: "invalid probe request" }, { status: 400 });
    }
    try {
      return Response.json(await runEnvironment(environment, repeats));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
`;
}

function parseArgs(args: readonly string[]): CliOptions | null {
  const selected = new Set<EnvironmentId>();
  let all = false;
  let repeats = DEFAULT_REPEATS;
  let json = false;
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--env") {
      const value = args[index + 1];
      if (value !== "local" && value !== "dev" && value !== "deployed") {
        throw new Error("--env must be local, dev, or deployed");
      }
      selected.add(value);
      index += 1;
    } else if (arg === "--repeats") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--repeats must be an integer in [1, 100]");
      }
      repeats = value;
      index += 1;
    } else if (arg === "--out") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) throw new Error("--out requires a path");
      out = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/probe-user-agent.ts " +
          "[--all | --env local|dev|deployed] [--repeats N] [--json] [--out PATH]",
      );
      return null;
    } else {
      throw new Error(`unknown argument: ${arg ?? ""}`);
    }
  }

  if (all && selected.size > 0) throw new Error("--all and --env are mutually exclusive");
  const environments: readonly EnvironmentId[] = all
    ? ["local", "dev", "deployed"]
    : selected.size > 0
      ? (["local", "dev", "deployed"] as const).filter((item) => selected.has(item))
      : ["local", "dev", "deployed"];
  return { environments, repeats, json, out };
}

async function runCommand(command: readonly string[], cwd?: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  return { exitCode, stdout, stderr };
}

async function checkedCommand(command: readonly string[], cwd?: string): Promise<CommandResult> {
  const result = await runCommand(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${String(result.exitCode)}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function makeTemporaryDirectory(): Promise<string> {
  const result = await checkedCommand(["mktemp", "-d", "-t", "lighter-ts-ua-probe"]);
  const directory = result.stdout.trim();
  if (directory.length === 0 || !directory.split("/").at(-1)?.startsWith("lighter-ts-ua-probe")) {
    throw new Error(`mktemp returned an unexpected path: ${directory}`);
  }
  return directory;
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  if (!directory.split("/").at(-1)?.startsWith("lighter-ts-ua-probe")) {
    throw new Error(`refusing to remove unexpected temporary path: ${directory}`);
  }
  await checkedCommand(["rm", "-rf", "--", directory]);
}

async function writeWorkerFiles(directory: string, name: string): Promise<void> {
  await Bun.write(`${directory}/worker.mjs`, workerSource());
  await Bun.write(
    `${directory}/wrangler.jsonc`,
    `${JSON.stringify(
      {
        name,
        main: "worker.mjs",
        compatibility_date: "2026-07-28",
        workers_dev: true,
      },
      null,
      2,
    )}\n`,
  );
}

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (): Response => new Response(),
  });
  const port = reservation.port;
  if (port === undefined) throw new Error("Bun did not report its reserved port");
  await reservation.stop(true);
  return port;
}

async function requestWorker(
  origin: string,
  environment: "dev" | "deployed",
  repeats: number,
): Promise<EnvironmentRun> {
  const response = await globalThis.fetch(
    `${origin}/probe?environment=${environment}&repeats=${String(repeats)}`,
    { signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS) },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${environment} worker returned HTTP ${String(response.status)}: ${body.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(body) as EnvironmentRun;
  } catch {
    throw new Error(`${environment} worker returned non-JSON output: ${body.slice(0, 500)}`);
  }
}

async function waitForDeployedWorker(origin: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastObservation = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${origin}/health`);
      const body = await response.text();
      if (response.ok && body === "ok") return;
      lastObservation = `HTTP ${String(response.status)}: ${body.slice(0, 200)}`;
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`deployed worker did not become reachable within 60s: ${lastObservation}`);
}

async function waitForDevWorker(
  child: ReturnType<typeof Bun.spawn>,
  origin: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(0).then(() => null),
    ]);
    if (exited !== null) {
      throw new Error(`wrangler dev exited before becoming ready (${String(exited.exitCode)})`);
    }
    try {
      const response = await globalThis.fetch(`${origin}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `wrangler dev did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function runDev(repeats: number): Promise<EnvironmentRun> {
  const directory = await makeTemporaryDirectory();
  const name = `lighter-ts-ua-probe-dev-${crypto.randomUUID().slice(0, 8)}`;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stdoutPromise: Promise<string> | null = null;
  let stderrPromise: Promise<string> | null = null;
  try {
    await writeWorkerFiles(directory, name);
    const port = await reservePort();
    child = Bun.spawn(
      [
        "bunx",
        "wrangler@4",
        "dev",
        "--config",
        `${directory}/wrangler.jsonc`,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "error",
      ],
      { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    stdoutPromise = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    stderrPromise = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const origin = `http://127.0.0.1:${String(port)}`;
    await waitForDevWorker(child, origin);
    return await requestWorker(origin, "dev", repeats);
  } finally {
    if (child !== null) {
      child.kill("SIGTERM");
      await child.exited;
      await Promise.all([stdoutPromise, stderrPromise]);
    }
    await removeTemporaryDirectory(directory);
  }
}

async function runDeployed(repeats: number): Promise<EnvironmentRun> {
  const directory = await makeTemporaryDirectory();
  const name = `lighter-ts-ua-probe-${crypto.randomUUID().slice(0, 12)}`;
  let deployed = false;
  let deploymentAttempted = false;
  let failure: unknown = null;
  try {
    await writeWorkerFiles(directory, name);
    deploymentAttempted = true;
    const deploy = await checkedCommand(
      ["bunx", "wrangler@4", "deploy", "--config", `${directory}/wrangler.jsonc`],
      directory,
    );
    deployed = true;
    const output = `${deploy.stdout}\n${deploy.stderr}`;
    const workerUrl = output.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/u)?.[0];
    if (workerUrl === undefined) {
      throw new Error(`could not find the workers.dev URL in wrangler output:\n${output}`);
    }
    await waitForDeployedWorker(workerUrl);
    return await requestWorker(workerUrl, "deployed", repeats);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (deploymentAttempted) {
      const deletion = await runCommand(
        [
          "bunx",
          "wrangler@4",
          "delete",
          "--config",
          `${directory}/wrangler.jsonc`,
          "--name",
          name,
          "--force",
        ],
        directory,
      );
      if (deletion.exitCode !== 0 && deployed) {
        cleanupErrors.push(deletion.stderr || deletion.stdout);
      }
    }
    try {
      await removeTemporaryDirectory(directory);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length > 0) {
      const message = `probe cleanup failed: ${cleanupErrors.join("\n")}`;
      if (failure === null) throw new Error(message);
      console.error(message);
    }
  }
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function summarizeStatuses(records: readonly ProbeRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key =
      record.classification === null
        ? String(record.status)
        : `${String(record.status)} ${record.classification}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}×${String(count)}`).join(", ");
}

function range(values: readonly number[], suffix = ""): string {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return minimum === maximum
    ? `${String(minimum)}${suffix}`
    : `${String(minimum)}–${String(maximum)}${suffix}`;
}

function markdownValue(value: string | null): string {
  if (value === null) return "—";
  if (value.length === 0) return "_(empty string)_";
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("`", "\\`");
}

function markdownList(values: readonly (string | null)[]): string {
  return unique(values).map(markdownValue).join(", ");
}

function isFlapping(records: readonly ProbeRecord[]): boolean {
  return unique(records.map((record) => `${String(record.status)}:${record.classification ?? ""}`))
    .length > 1;
}

function buildConclusion(
  runs: readonly EnvironmentRun[],
  repeats: number,
): { readonly conclusion: string; readonly d5Conclusion: string } {
  const deployed = runs.find((run) => run.environment === "deployed");
  if (deployed === undefined) {
    return {
      conclusion:
        "The deployed Worker default-User-Agent question was not executed in this selected run.",
      d5Conclusion: "D5 cannot be updated from a run that does not include the deployed environment.",
    };
  }
  const records = deployed.records.filter(
    (record) => record.userAgent === "default" && record.target === "orderBooks",
  );
  const successes = records.filter((record) => record.status === 200).length;
  let transitions = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (previous.status !== current.status || previous.classification !== current.classification)
    ) {
      transitions += 1;
    }
  }
  const conclusion =
    successes === repeats
      ? `Yes — a deployed Worker's default User-Agent returned HTTP 200 on /api/v1/orderBooks in all ${String(repeats)} repeats.`
      : successes === 0
        ? `No — a deployed Worker's default User-Agent returned HTTP 200 on /api/v1/orderBooks in 0/${String(repeats)} repeats.`
        : `No, not consistently — a deployed Worker's default User-Agent returned HTTP 200 on /api/v1/orderBooks in ${String(successes)}/${String(repeats)} repeats.`;
  const d5Conclusion =
    successes === repeats
      ? `D5 remains correct, but its browser-like non-browser User-Agent is belt-and-braces on Workers; the default orderBooks cell had ${String(transitions)}/${String(Math.max(0, records.length - 1))} status/classification transitions.`
      : `D5's configurable browser-like User-Agent on non-browser runtimes is mandatory, not defensive; the transport unit needs this requirement, and the default orderBooks cell had ${String(transitions)}/${String(Math.max(0, records.length - 1))} status/classification transitions.`;
  return { conclusion, d5Conclusion };
}

function renderMarkdown(output: ProbeOutput): string {
  const lines = [
    "# User-Agent probe",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    output.conclusion,
    "",
    output.d5Conclusion,
    "",
    "## Environment observations",
    "",
    "| Environment | UTC window | Egress IP(s) | Default UA actually sent | Flapping cells |",
    "|---|---|---|---|---:|",
  ];

  for (const run of output.runs) {
    const ips = unique(run.records.map((record) => record.egressIp).filter((value) => value !== null));
    const defaultUas = unique(
      run.records
        .filter((record) => record.userAgent === "default")
        .map((record) => record.sentUserAgent)
        .filter((value) => value !== null),
    );
    let flappingCells = 0;
    for (const userAgent of UA_SETTINGS) {
      for (const target of TARGETS) {
        const records = run.records.filter(
          (record) => record.userAgent === userAgent.id && record.target === target.id,
        );
        if (isFlapping(records)) flappingCells += 1;
      }
    }
    lines.push(
      `| ${run.environment} | ${run.startedAt} – ${run.completedAt} | ` +
        `${markdownValue(ips.join(", "))} | ${markdownValue(defaultUas.join(", "))} | ` +
        `${String(flappingCells)}/${String(UA_SETTINGS.length * TARGETS.length)} |`,
    );
  }

  lines.push(
    "",
    "## Matrix",
    "",
    "| Env | UA setting | Target | UTC observations | Status / 403 class | Content-Type | Bytes | JSON | HTML prefix (first 200 chars) | x-amz-cf-id | x-cache | Elapsed | UA actually sent | Egress IP | Flap |",
    "|---|---|---|---|---|---|---:|---|---|---|---|---:|---|---|---|",
  );
  for (const run of output.runs) {
    for (const userAgent of UA_SETTINGS) {
      for (const target of TARGETS) {
        const records = run.records.filter(
          (record) => record.userAgent === userAgent.id && record.target === target.id,
        );
        const jsonValues = unique(records.map((record) => record.parsesAsJson));
        lines.push(
          `| ${run.environment} | ${userAgent.label} | ${target.label} | ` +
            `${markdownValue(records.map((record) => record.timestamp).join(", "))} | ` +
            `${summarizeStatuses(records)} | ` +
            `${markdownList(records.map((record) => record.contentType))} | ` +
            `${range(records.map((record) => record.byteLength))} | ` +
            `${jsonValues.length === 1 ? (jsonValues[0] === true ? "yes" : "no") : "mixed"} | ` +
            `${markdownList(records.map((record) => record.htmlPrefix))} | ` +
            `${markdownList(records.map((record) => record.xAmzCfId))} | ` +
            `${markdownList(records.map((record) => record.xCache))} | ` +
            `${range(records.map((record) => record.elapsedMs), " ms")} | ` +
            `${markdownList(records.map((record) => record.sentUserAgent))} | ` +
            `${markdownList(records.map((record) => record.egressIp))} | ` +
            `${isFlapping(records) ? "YES" : "no"} |`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options === null) return;
  const runs: EnvironmentRun[] = [];
  for (const environment of options.environments) {
    console.error(`Running ${environment} User-Agent matrix (${String(options.repeats)} repeats)…`);
    if (environment === "local") runs.push(await runEnvironment("local", options.repeats));
    if (environment === "dev") runs.push(await runDev(options.repeats));
    if (environment === "deployed") runs.push(await runDeployed(options.repeats));
  }
  const conclusions = buildConclusion(runs, options.repeats);
  const output: ProbeOutput = {
    generatedAt: new Date().toISOString(),
    repeats: options.repeats,
    environments: options.environments,
    ...conclusions,
    runs,
  };
  const rendered = options.json ? `${JSON.stringify(output, null, 2)}\n` : renderMarkdown(output);
  console.log(rendered.trimEnd());
  if (options.out !== null) await Bun.write(options.out, rendered);
}

await main().catch((error: unknown) => {
  throw new Error(
    `User-Agent probe harness failure: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
});
