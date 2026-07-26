/**
 * The `./rest` subpath barrel.
 *
 * Two things are asserted, and both are the kind of thing that is true until someone adds a line:
 *
 * 1. **Everything this subpath promises is actually reachable through it** — including the bare
 *    `request`, which is the tree-shakeable escape hatch that justifies the facade referencing all
 *    78 routes.
 * 2. **Importing it is inert.** `"sideEffects": false` is a claim a bundler acts on: it will hoist,
 *    reorder and drop this import. If loading the barrel opened a socket, read a clock, scheduled a
 *    timer or called `crypto.getRandomValues` — which Cloudflare Workers forbids at module scope
 *    (`docs/decisions.md` D2) — that claim would be a lie and the failure would appear only in
 *    production, in one runtime. So it is measured in a subprocess with every relevant global
 *    booby-trapped, not assumed.
 */

import { describe, expect, test } from "bun:test";

import * as rest from "../../src/rest/index.js";
import type {
  ItemOf,
  ParamsOf,
  ResponseOf,
  RestAuth,
  RestEncoding,
  RestGroup,
  RestMethod,
  RouteDef,
} from "../../src/rest/index.js";

/** Minimal ambient for the import-purity subprocess check. */
declare const Bun: {
  file(path: string): { text(): Promise<string> };
  spawnSync(cmd: string[], opts?: { stdout?: "pipe"; stderr?: "pipe" }): {
    exitCode: number;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

/* ---------------------------------------------------------------------------------------------- */
/* Surface                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe("the barrel re-exports the whole subpath", () => {
  test("the transport, unwrapped, for size-sensitive consumers", () => {
    expect(typeof rest.request).toBe("function");
    // The rest of the transport's surface rides along, including the geo-restriction class that a
    // caller in a restricted jurisdiction has to be able to name.
    expect(typeof rest.LighterGeoRestrictedError).toBe("function");
    expect(typeof rest.isLighterGeoRestrictedError).toBe("function");
    expect(typeof rest.buildUrl).toBe("function");
    expect(typeof rest.isSuccess).toBe("function");
  });

  test("the route table", () => {
    expect(typeof rest.routes).toBe("object");
    expect(Object.keys(rest.routes).length).toBe(78);
  });

  test("the grouped client", () => {
    expect(typeof rest.LighterRestClient).toBe("function");
    expect(new rest.LighterRestClient().order.orderBooks).toBeInstanceOf(Function);
  });

  test("pagination", () => {
    expect(typeof rest.paginate).toBe("function");
    expect(typeof rest.paginateItems).toBe("function");
    expect(typeof rest.nextCursor).toBe("function");
    expect(rest.DEFAULT_MAX_PAGES).toBe(1000);
  });

  test("the candle mapping", () => {
    expect(typeof rest.mapCandle).toBe("function");
    expect(typeof rest.mapCandles).toBe("function");
    expect(typeof rest.expandExponent).toBe("function");
  });

  test("the route type vocabulary — compile-time only, so the assertion is the annotation", () => {
    type Books = typeof rest.routes.orderBooks;
    const method: RestMethod = "GET";
    const auth: RestAuth = "none";
    const encoding: RestEncoding = "form";
    const group: RestGroup = "order";
    const def: RouteDef = rest.routes.orderBooks;
    const params: ParamsOf<Books> = { filter: "perp" };
    const response: ResponseOf<Books> = { code: 200 };
    const item: ItemOf<typeof rest.routes.trades> = { trade_id_str: "1" };

    expect([method, auth, encoding, group]).toEqual(["GET", "none", "form", "order"]);
    expect(def.path).toBe("/api/v1/orderBooks");
    expect(params.filter).toBe("perp");
    expect(response.code).toBe(200);
    expect(item.trade_id_str).toBe("1");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Import purity                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

describe("import purity", () => {
  test("importing the barrel touches no global, clock, timer, network or crypto", () => {
    const entry: string = new URL("../../src/rest/index.ts", import.meta.url).pathname;
    const probe: string = [
      "const touched = [];",
      'for (const k of ["fetch","WebSocket","document","window","navigator","crypto","XMLHttpRequest","localStorage"]) {',
      '  try { Object.defineProperty(globalThis, k, { configurable: true, get() { touched.push(k); throw new Error("read global " + k); } }); }',
      '  catch { touched.push("unstubbable:" + k); }',
      "}",
      'Date.now = () => { touched.push("Date.now"); throw new Error("clock"); };',
      'for (const k of ["setTimeout","setInterval","queueMicrotask"]) {',
      "  const original = globalThis[k];",
      "  globalThis[k] = (...args) => { touched.push(k); return original(...args); };",
      "}",
      `const m = await import(${JSON.stringify(entry)});`,
      'const required = ["request","routes","LighterRestClient","paginate","paginateItems","mapCandle","mapCandles"];',
      "const missing = required.filter((n) => m[n] === undefined);",
      'if (missing.length > 0) console.log("MISSING_EXPORTS:" + missing.join(","));',
      'else console.log(touched.length === 0 ? "CLEAN" : "TOUCHED:" + touched.join(","));',
    ].join("\n");

    const proc = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
    const stdout: string = proc.stdout.toString().trim();
    const stderr: string = proc.stderr.toString().trim();
    expect(`${stdout}${stderr === "" ? "" : ` | stderr: ${stderr}`}`).toBe("CLEAN");
    expect(proc.exitCode).toBe(0);
  });

  test("no Node built-in and no runtime dependency in this unit's files", async () => {
    for (const file of ["client.ts", "paginate.ts", "candles.ts", "index.ts"]) {
      const source: string = await Bun.file(
        new URL(`../../src/rest/${file}`, import.meta.url).pathname,
      ).text();
      for (const forbidden of ["node:", "Buffer", "process.", "require("]) {
        expect(`${file}: ${String(source.includes(forbidden))}`).toBe(`${file}: false`);
      }
    }
  });

  test("every re-export target is a sibling module inside src/rest", async () => {
    const source: string = await Bun.file(
      new URL("../../src/rest/index.ts", import.meta.url).pathname,
    ).text();
    const targets: string[] = [...source.matchAll(/^\s*export .*? from "([^"]+)";$/gm)].map(
      (m: RegExpMatchArray) => m[1] as string,
    );
    expect(targets.length).toBe(6);
    for (const target of targets) {
      // No `../`: the barrel owns its own directory and reaches into nothing above it — not the
      // root barrel, not another unit's module (`docs/decisions.md` D8).
      expect(target.startsWith("./")).toBe(true);
      expect(target).not.toContain("..");
      // Explicit `.js` extension on every relative import, as the package requires.
      expect(target.endsWith(".js")).toBe(true);
    }
    expect([...targets].sort()).toEqual([
      "./candles.js",
      "./client.js",
      "./paginate.js",
      "./route-types.js",
      "./routes.js",
      "./transport.js",
    ]);
  });
});
