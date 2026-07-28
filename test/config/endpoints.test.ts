import { describe, expect, test } from "bun:test";

import { LighterConfigError, isLighterError } from "../../src/errors.js";
import type { EndpointProfile, ProfileName } from "../../src/config/endpoints.js";
import { defineProfile, getProfile, profiles } from "../../src/config/endpoints.js";

/** Minimal ambient for the vector loader. Tests run under Bun; `src/` uses no runtime globals. */
declare const Bun: { file(path: string): { text(): Promise<string> } };

interface TxVectors {
  readonly chainId: number;
}

const vectorPath: string = new URL("../../conformance/vectors/tx.json", import.meta.url).pathname;
const tx: TxVectors = JSON.parse(await Bun.file(vectorPath).text()) as TxVectors;

describe("built-in profiles", () => {
  test("carry exactly the four documented triples, string for string", () => {
    expect(profiles.mainnet).toEqual({
      name: "mainnet",
      restBase: "https://mainnet.zklighter.elliot.ai",
      wsBase: "wss://mainnet.zklighter.elliot.ai/stream",
      chainId: 304,
    });
    expect(profiles.testnet).toEqual({
      name: "testnet",
      restBase: "https://testnet.zklighter.elliot.ai",
      wsBase: "wss://testnet.zklighter.elliot.ai/stream",
      chainId: 300,
    });
    expect(profiles.robinhood).toEqual({
      name: "robinhood",
      restBase: "https://api.rh.lighter.xyz",
      wsBase: "wss://api.rh.lighter.xyz/stream",
      chainId: 466324,
    });
    expect(profiles.robinhood_testnet).toEqual({
      name: "robinhood_testnet",
      restBase: "https://api.rh-testnet.lighter.xyz",
      wsBase: "wss://api.rh-testnet.lighter.xyz/stream",
      chainId: 300,
    });
  });

  test("mainnet's chain id is the one the transaction vectors were generated with", () => {
    // Read from the vector rather than restated as a literal on both sides: the point of the
    // assertion is that the SDK signs for the chain the oracle pinned, which is 304.
    expect(profiles.mainnet.chainId).toBe(tx.chainId);
  });

  test("testnet and robinhood_testnet share chain id 300 — an upstream fact, not a typo", () => {
    expect(profiles.testnet.chainId).toBe(300);
    expect(profiles.robinhood_testnet.chainId).toBe(300);
    // Which is exactly why there is no chainId -> profile reverse lookup to test: a chain id does
    // not identify a profile. Signatures are cross-valid between these two environments.
    expect(profiles.testnet.chainId).toBe(profiles.robinhood_testnet.chainId);
    expect(profiles.testnet.restBase).not.toBe(profiles.robinhood_testnet.restBase);
  });

  test("carry no policy fields — timeouts and retries belong to the config", () => {
    for (const name of Object.keys(profiles) as ProfileName[]) {
      expect(Object.keys(profiles[name]).sort()).toEqual(["chainId", "name", "restBase", "wsBase"]);
    }
  });

  test("REST bases are origins with no /api/v1 and no trailing slash", () => {
    for (const name of Object.keys(profiles) as ProfileName[]) {
      const p: EndpointProfile = profiles[name];
      // Two operations (`GET /` and `GET /info`) live at the origin root; a baked-in /api/v1 would
      // make them unreachable.
      expect(p.restBase).not.toContain("/api/v1");
      expect(p.restBase.endsWith("/")).toBe(false);
      expect(new URL(p.restBase).pathname).toBe("/");
      expect(p.wsBase.endsWith("/stream")).toBe(true);
    }
  });

  test("the map and every profile in it are frozen", () => {
    expect(Object.isFrozen(profiles)).toBe(true);
    for (const name of Object.keys(profiles) as ProfileName[]) {
      expect(Object.isFrozen(profiles[name])).toBe(true);
    }
  });

  test("assigning to a profile field throws — test modules are strict mode", () => {
    expect(() => {
      (profiles.mainnet as { chainId: number }).chainId = 1;
    }).toThrow(TypeError);
    expect(() => {
      (profiles as { mainnet: EndpointProfile }).mainnet = profiles.testnet;
    }).toThrow(TypeError);
    expect(profiles.mainnet.chainId).toBe(304);
  });
});

describe("getProfile", () => {
  test("returns the same frozen instance for each known name", () => {
    expect(getProfile("mainnet")).toBe(profiles.mainnet);
    expect(getProfile("testnet")).toBe(profiles.testnet);
    expect(getProfile("robinhood")).toBe(profiles.robinhood);
    expect(getProfile("robinhood_testnet")).toBe(profiles.robinhood_testnet);
  });

  test("an unknown name throws LighterConfigError naming all four valid ones", () => {
    // The name routinely arrives from an env var or JSON, where the type says nothing.
    const call = (): EndpointProfile => getProfile("nope" as ProfileName);
    expect(call).toThrow(LighterConfigError);
    try {
      call();
      expect.unreachable();
    } catch (e: unknown) {
      expect(isLighterError(e)).toBe(true);
      expect((e as LighterConfigError).kind).toBe("config");
      const message: string = (e as Error).message;
      for (const name of ["mainnet", "testnet", "robinhood", "robinhood_testnet"]) {
        expect(message).toContain(name);
      }
    }
  });

  test("does not resolve inherited Object properties", () => {
    expect(() => getProfile("toString" as ProfileName)).toThrow(LighterConfigError);
    expect(() => getProfile("constructor" as ProfileName)).toThrow(LighterConfigError);
  });
});

describe("defineProfile", () => {
  test("strips trailing slashes from both bases", () => {
    const p: EndpointProfile = defineProfile({
      name: "x",
      restBase: "https://h/",
      wsBase: "wss://h/stream/",
      chainId: 1,
    });
    expect(p.restBase).toBe("https://h");
    expect(p.wsBase).toBe("wss://h/stream");
    expect(p.name).toBe("x");
    expect(p.chainId).toBe(1);
  });

  test("normalisation makes the slashed and unslashed forms identical", () => {
    const withSlash: EndpointProfile = defineProfile({
      name: "x",
      restBase: "https://host///",
      wsBase: "wss://host/stream//",
      chainId: 7,
    });
    const without: EndpointProfile = defineProfile({
      name: "x",
      restBase: "https://host",
      wsBase: "wss://host/stream",
      chainId: 7,
    });
    expect(withSlash).toEqual(without);
  });

  test("returns a frozen copy, not the caller's object", () => {
    const input = { name: "x", restBase: "https://h", wsBase: "wss://h/stream", chainId: 2 };
    const p: EndpointProfile = defineProfile(input);
    expect(p).not.toBe(input);
    expect(Object.isFrozen(p)).toBe(true);
    input.chainId = 99;
    expect(p.chainId).toBe(2);
  });

  test("a missing chain id throws rather than defaulting to 304", () => {
    // The whole hazard: a silently-defaulted chain id produces signatures that look valid and are
    // rejected everywhere but mainnet.
    const call = (): EndpointProfile =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/stream" } as EndpointProfile);
    expect(call).toThrow(LighterConfigError);
    try {
      call();
      expect.unreachable();
    } catch (e: unknown) {
      expect((e as Error).message).toContain("chainId");
      expect((e as LighterConfigError).kind).toBe("config");
    }
  });

  test("chain id 0 is accepted; negative and fractional are not", () => {
    expect(defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/s", chainId: 0 }).chainId).toBe(0);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/s", chainId: -1 }),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/s", chainId: 1.5 }),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/s", chainId: "304" as unknown as number }),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "wss://h/s", chainId: Number.NaN }),
    ).toThrow(LighterConfigError);
  });

  test("rejects unparseable and wrongly-schemed URLs", () => {
    expect(() =>
      defineProfile({ name: "x", restBase: "not a url", wsBase: "wss://h/s", chainId: 1 }),
    ).toThrow(LighterConfigError);
    // A ws:// REST base and an https:// stream URL are the two swaps a copy-paste produces.
    expect(() =>
      defineProfile({ name: "x", restBase: "wss://h", wsBase: "wss://h/s", chainId: 1 }),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "https://h/s", chainId: 1 }),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "x", restBase: "https://h", wsBase: "", chainId: 1 }),
    ).toThrow(LighterConfigError);
  });

  test("accepts http:// and ws:// for a local sequencer", () => {
    const p: EndpointProfile = defineProfile({
      name: "local",
      restBase: "http://127.0.0.1:8080/",
      wsBase: "ws://127.0.0.1:8080/stream",
      chainId: 300,
    });
    expect(p.restBase).toBe("http://127.0.0.1:8080");
    expect(p.wsBase).toBe("ws://127.0.0.1:8080/stream");
  });

  test("rejects a missing or empty name", () => {
    expect(() =>
      defineProfile({ restBase: "https://h", wsBase: "wss://h/s", chainId: 1 } as EndpointProfile),
    ).toThrow(LighterConfigError);
    expect(() =>
      defineProfile({ name: "", restBase: "https://h", wsBase: "wss://h/s", chainId: 1 }),
    ).toThrow(LighterConfigError);
    expect(() => defineProfile(null as unknown as EndpointProfile)).toThrow(LighterConfigError);
  });

  test("round-trips the built-in profiles unchanged", () => {
    for (const name of Object.keys(profiles) as ProfileName[]) {
      expect(defineProfile(profiles[name])).toEqual(profiles[name]);
    }
  });
});
