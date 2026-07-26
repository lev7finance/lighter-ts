import { describe, expect, test } from "bun:test";

import { NAME, VERSION } from "../src/version.js";

/** Minimal ambient for reading the module source back. Tests run under Bun. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

describe("version", () => {
  test("exports plain string literals", () => {
    expect(NAME).toBe("lighter-ts");
    expect(VERSION).toBe("0.1.0");
    expect(typeof NAME).toBe("string");
    expect(typeof VERSION).toBe("string");
  });

  test("VERSION is semver-shaped, so a User-Agent built from it is well formed", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(`${NAME}/${VERSION}`).toBe("lighter-ts/0.1.0");
  });

  test("the module reads no file and imports nothing", async () => {
    const source: string = await Bun.file(
      new URL("../src/version.ts", import.meta.url).pathname,
    ).text();
    const code: string = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/readFile|node:|process\./);
  });
});
