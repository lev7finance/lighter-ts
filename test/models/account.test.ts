/**
 * `signedPositionSize` — the one function in `src/models/`.
 *
 * `AccountPosition.position` is an unsigned magnitude and `sign` carries the direction
 * (`spec/05-rest-api.md` §10.8). The obvious wrong implementation, `Number(position) * sign`,
 * passes every test written with tidy numbers and loses precision on real ones, so these cases
 * pin the string behaviour instead: the output is the input with a `-` prefixed, or the input
 * unchanged. No digit is ever re-rendered.
 */

import { describe, expect, test } from "bun:test";

import { signedPositionSize } from "../../src/models/account.js";

describe("signedPositionSize", () => {
  test("negates a short by prefixing, preserving every digit and the trailing zero", () => {
    expect(signedPositionSize({ sign: -1, position: "0.04220" })).toBe("-0.04220");
  });

  test("leaves a long untouched — no '+' prefix", () => {
    expect(signedPositionSize({ sign: 1, position: "0.04220" })).toBe("0.04220");
  });

  test("zero stays zero under either sign — never '-0', never '+0'", () => {
    expect(signedPositionSize({ sign: 1, position: "0" })).toBe("0");
    expect(signedPositionSize({ sign: -1, position: "0" })).toBe("0");
    expect(signedPositionSize({ sign: -1, position: "0.000000" })).toBe("0.000000");
    expect(signedPositionSize({ sign: -1, position: "0.00" })).toBe("0.00");
  });

  test("preserves precision far beyond what a double can hold", () => {
    // 9007199254740993 is 2^53 + 1: unrepresentable as a double, so any implementation that
    // touched Number would return ...992 here.
    expect(signedPositionSize({ sign: -1, position: "9007199254740993.00000001" })).toBe(
      "-9007199254740993.00000001",
    );
    expect(signedPositionSize({ sign: -1, position: "0.000000000000000000001" })).toBe(
      "-0.000000000000000000001",
    );
  });

  test("an absent position reads as zero rather than throwing", () => {
    // Every response field is optional (§9.2); a position with no `position` key is possible.
    expect(signedPositionSize({ sign: -1 })).toBe("0");
    expect(signedPositionSize({})).toBe("0");
  });

  test("an absent sign is treated as long, matching the wire's own default of 0", () => {
    expect(signedPositionSize({ position: "1.5" })).toBe("1.5");
    expect(signedPositionSize({ sign: 0, position: "1.5" })).toBe("1.5");
  });

  test("an already-negative magnitude is not double-negated", () => {
    // The API documents `position` as unsigned. If that ever changes, silently producing "--1.5"
    // is worse than passing the value through.
    expect(signedPositionSize({ sign: -1, position: "-1.5" })).toBe("-1.5");
  });

  test("an empty string passes through unchanged", () => {
    expect(signedPositionSize({ sign: -1, position: "" })).toBe("");
  });

  test("the implementation never reaches for Number, parseFloat or Math", async () => {
    // A regression guard with teeth: the failure mode this function exists to prevent is silent,
    // so the prohibition is checked against the source rather than only against outputs.
    const source = await Bun.file(
      new URL("../../src/models/account.ts", import.meta.url),
    ).text();
    // Doc comments are stripped first: they *name* the forbidden calls in order to forbid them.
    const body = source
      .slice(source.indexOf("function isZeroMagnitude"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).not.toContain("Number(");
    expect(body).not.toContain("parseFloat");
    expect(body).not.toContain("parseInt");
    expect(body).not.toContain("Math.");
  });
});
