/**
 * `src/tx/l1/eip191.ts` — the `personal_sign` framing.
 *
 * There is no vector to check against on this side: `l1Messages[].eip191HashHex` is the digest of
 * these bytes, and producing it needs an L1 hash function this package deliberately does not ship
 * (`docs/decisions.md` D6, D10). So the framing is pinned structurally — prefix, decimal byte
 * length, payload — which is exactly what the digest would be taken over.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { EIP191_PREFIX, eip191Message } from "../../../src/tx/l1/eip191.js";
import { bytesToHex, bytesToUtf8, utf8ToBytes } from "../../../src/util/bytes.js";

const vectorsUrl = new URL("../../../conformance/vectors/tx.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, "utf8")) as {
  readonly l1Messages: readonly { readonly body: string; readonly bodyUtf8Hex: string }[];
};

describe("EIP191_PREFIX", () => {
  test("starts with the single 0x19 control byte", () => {
    expect(EIP191_PREFIX.charCodeAt(0)).toBe(0x19);
    expect(EIP191_PREFIX).toBe("\x19Ethereum Signed Message:\n");
    expect(utf8ToBytes(EIP191_PREFIX)[0]).toBe(0x19);
  });
});

describe("eip191Message", () => {
  test('"abc" frames as the 3-byte form', () => {
    expect(bytesToUtf8(eip191Message("abc"))).toBe("\x19Ethereum Signed Message:\n3abc");
  });

  test("the empty message still carries a decimal 0", () => {
    expect(bytesToUtf8(eip191Message(""))).toBe("\x19Ethereum Signed Message:\n0");
  });

  test("the length is the UTF-8 byte count, not the character count", () => {
    // Four characters, ten bytes: é is 2, € is 3, 𝔊 is 4 (one astral character, two UTF-16 units).
    const text: string = "aé€𝔊";
    expect(text.length).toBe(5); // UTF-16 code units — the wrong answer
    expect([...text].length).toBe(4); // characters — also the wrong answer
    const framed: string = bytesToUtf8(eip191Message(text));
    expect(framed).toBe(`\x19Ethereum Signed Message:\n10${text}`);
    expect(framed).not.toContain(":\n4");
    expect(framed).not.toContain(":\n5");
  });

  test("the payload is the message bytes, appended unchanged", () => {
    const row = vectors.l1Messages[0];
    if (row === undefined) throw new Error("no l1Messages vectors");
    const framed: Uint8Array = eip191Message(row.body);
    const header: Uint8Array = utf8ToBytes(
      `${EIP191_PREFIX}${(row.bodyUtf8Hex.length / 2).toString(10)}`,
    );
    expect(bytesToHex(framed.subarray(0, header.length))).toBe(bytesToHex(header));
    expect(bytesToHex(framed.subarray(header.length))).toBe(row.bodyUtf8Hex);
  });

  test("every vector body frames to prefix + its own byte length + body", () => {
    for (const row of vectors.l1Messages) {
      const byteLength: number = row.bodyUtf8Hex.length / 2;
      expect(bytesToUtf8(eip191Message(row.body))).toBe(
        `${EIP191_PREFIX}${byteLength.toString(10)}${row.body}`,
      );
    }
  });

  test("returns a fresh array each call", () => {
    const a: Uint8Array = eip191Message("abc");
    const b: Uint8Array = eip191Message("abc");
    expect(a).not.toBe(b);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});
