/**
 * The `./crypto` subpath barrel.
 *
 * Two things are worth testing about a barrel, and only two:
 *
 * 1. **It re-exports the surface**, with no name lost to a collision. `export *` silently drops a
 *    binding that two modules both export, so the presence check is not ceremony — it is the only
 *    thing that catches a name disappearing from the public API when a sibling module grows an
 *    export.
 * 2. **Importing it does nothing.** No network call, no timer, no mutated global, and above all no
 *    randomness: Cloudflare Workers forbids `crypto.getRandomValues` in the isolate's global scope,
 *    so a module-scope draw anywhere in this dependency tree makes the whole SDK fail to load on
 *    the primary target runtime (`docs/protocol-notes.md` §5.1). That cannot be observed in-process
 *    — the modules are already loaded — so it runs in a subprocess with every side-effecting global
 *    booby-trapped.
 */

import { describe, expect, test } from "bun:test";

import * as crypto from "../../src/crypto/index.js";

describe("surface", () => {
  test("re-exports every layer", () => {
    const expected: readonly string[] = [
      //  field
      "P",
      "EPSILON",
      "fpAdd",
      "fpMul",
      "fpSqrt",
      "fp5Mul",
      "fp5Sqrt",
      "fp5ToBytes",
      "fp5FromBytes",
      "fp5FromBytesStrict",
      "recodeSigned5",
      "recodeSignedDigits",
      //  poseidon2
      "permute",
      "hashNoPad",
      "hashTwoToOne",
      "hashToQuinticExtension",
      //  scalar
      "N",
      "modN",
      "scalarToBytes",
      "scalarFromBytes",
      "scalarFromBytesStrict",
      "scalarFromFp5",
      //  group
      "GENERATOR",
      "NEUTRAL",
      "pointAdd",
      "encodePoint",
      "decodePoint",
      "mulScalar",
      "mulGenerator",
      "mulAddG",
      //  nonce
      "deriveNonceHedged",
      "randomNonce",
      "chooseNonce",
      //  schnorr + key
      "SIGNATURE_BYTES",
      "PUBKEY_BYTES",
      "HASH_BYTES",
      "publicKeyFromPrivateKey",
      "challenge",
      "signHashed",
      "signatureToBytes",
      "signatureFromBytes",
      "verify",
      "ApiKey",
    ];
    const missing: string[] = expected.filter((name) => !(name in crypto));
    expect(missing).toEqual([]);
  });

  test("the barrel's verify is the signer's verify, with no options parameter", () => {
    expect(crypto.verify.length).toBe(3);
    expect(typeof crypto.ApiKey.fromPrivateKey).toBe("function");
    expect(typeof crypto.ApiKey.generate).toBe("function");
  });
});

describe("importing the barrel has no side effects", () => {
  test("no randomness, no timer, no fetch, no global mutation at import time", () => {
    const url: string = new URL("../../src/crypto/index.ts", import.meta.url).href;
    const code: string = [
      //  Any of these being touched during import is a load-time failure on Workers, a hidden
      //  dependency in a test, or a network call in a crypto library. All three are defects.
      "Object.defineProperty(globalThis, 'crypto', {",
      "  value: new Proxy({}, { get() { throw new Error('module-scope randomness'); } }),",
      "  configurable: true,",
      "});",
      "globalThis.fetch = () => { throw new Error('module-scope fetch'); };",
      "globalThis.setTimeout = () => { throw new Error('module-scope timer'); };",
      "globalThis.setInterval = () => { throw new Error('module-scope timer'); };",
      "const before = new Set(Reflect.ownKeys(globalThis).map(String));",
      `const m = await import(${JSON.stringify(url)});`,
      "const added = Reflect.ownKeys(globalThis).map(String).filter((k) => !before.has(k));",
      "if (added.length !== 0) throw new Error('globals added: ' + added.join(','));",
      "if (typeof m.verify !== 'function') throw new Error('bad module shape');",
      "if (typeof m.ApiKey !== 'function') throw new Error('bad module shape');",
      "console.log('IMPORTED-CLEAN');",
    ].join("\n");

    const proc = Bun.spawnSync(["bun", "-e", code]);
    const stdout: string = new TextDecoder().decode(proc.stdout);
    const stderr: string = new TextDecoder().decode(proc.stderr);
    expect(`${stdout}${stderr}`).toContain("IMPORTED-CLEAN");
    expect(proc.exitCode).toBe(0);
  });
});
