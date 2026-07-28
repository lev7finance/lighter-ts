/**
 * Tests for the merged per-account asset state.
 *
 * The two things worth failing a build over:
 *
 * 1. **`available` is exact.** `"1"` and `"1.0000"` are the same balance; `8.2 − 0.000001` through
 *    binary64 is not `8.199999`. Both are pinned below, because both are the hazards
 *    `docs/protocol-notes.md` §9 catalogues and both survive casual testing.
 * 2. **Updates merge; they do not replace.** Wholesale replacement is defect 8 of the reference
 *    client and discards assets that simply did not change in that frame. See the header of
 *    `src/ws/account-assets-stream.ts` for why that assumption is the safe one while the wave-0
 *    capture is empty.
 */

import { describe, expect, test } from "bun:test";

import { fromScaled } from "../../src/util/decimal.js";
import {
  ASSET_DECIMALS,
  AccountAssetsState,
} from "../../src/ws/account-assets-stream.js";
import type { AccountAssetsMessage } from "../../src/ws/types.js";

/** A snapshot frame for account 1234. */
function snapshot(
  assets: Record<string, { symbol?: string; asset_id?: number; balance?: string; locked_balance?: string }>,
  timestamp?: number,
): AccountAssetsMessage {
  const base = {
    type: "subscribed/account_all_assets",
    channel: "account_all_assets:1234",
    assets,
  };
  return timestamp === undefined ? base : { ...base, timestamp };
}

/** An update frame for account 1234. */
function update(
  assets: Record<string, { symbol?: string; asset_id?: number; balance?: string; locked_balance?: string }>,
  timestamp?: number,
): AccountAssetsMessage {
  const base = {
    type: "update/account_all_assets",
    channel: "account_all_assets:1234",
    assets,
  };
  return timestamp === undefined ? base : { ...base, timestamp };
}

describe("exact available balance", () => {
  test('"1" and "1.0000" are the same balance', () => {
    const a = new AccountAssetsState(1234);
    const b = new AccountAssetsState(1234);
    a.applySnapshot(snapshot({ "3": { asset_id: 3, symbol: "USDC", balance: "1", locked_balance: "0" } }));
    b.applySnapshot(
      snapshot({ "3": { asset_id: 3, symbol: "USDC", balance: "1.0000", locked_balance: "0.0000" } }),
    );
    expect(a.available(3)).toBe(b.available(3));
    expect(a.available(3)).toBe(10n ** 18n);
    // The delivered strings are preserved verbatim despite comparing equal.
    expect(a.assets.get(3)?.balance).toBe("1");
    expect(b.assets.get(3)?.balance).toBe("1.0000");
  });

  test("8.2 minus 0.000001 is exactly 8.199999, with no float anywhere on the path", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(
      snapshot({ "3": { asset_id: 3, symbol: "USDC", balance: "8.2", locked_balance: "0.000001" } }),
    );
    const available: bigint = state.available(3);
    expect(available).toBe(8_199_999_000_000_000_000n);
    expect(fromScaled(available, ASSET_DECIMALS)).toBe("8.199999000000000000");
    // The reference's `int(8.2 * 1e6)` is 8199999 — a whole micro-USDC lost before subtraction.
    // Ours is exact, so the scaled difference divides cleanly to 8199999 micro-units.
    expect(available / 10n ** 12n).toBe(8_199_999n);
  });

  test("an unknown asset is zero, not an exception", () => {
    const state = new AccountAssetsState(1234);
    expect(state.available(99)).toBe(0n);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "5", locked_balance: "0" } }));
    expect(state.available(99)).toBe(0n);
  });

  test("scaled and delivered values are both retained", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(
      snapshot({ "1": { asset_id: 1, symbol: "ETH", balance: "0.3285", locked_balance: "0.0100" } }),
    );
    const entry = state.assets.get(1);
    expect(entry?.symbol).toBe("ETH");
    expect(entry?.balance).toBe("0.3285");
    expect(entry?.lockedBalance).toBe("0.0100");
    expect(entry?.balanceScaled).toBe(328_500_000_000_000_000n);
    expect(entry?.lockedScaled).toBe(10_000_000_000_000_000n);
    expect(state.available(1)).toBe(318_500_000_000_000_000n);
  });
});

describe("lifecycle", () => {
  test("starts empty", () => {
    const state = new AccountAssetsState(1234);
    expect(state.status).toBe("empty");
    expect(state.accountIndex).toBe(1234);
    expect(state.assets.size).toBe(0);
    expect(state.timestampMs).toBeUndefined();
  });

  test("an applyUpdate before any snapshot does not silently create state", () => {
    const state = new AccountAssetsState(1234);
    state.applyUpdate(update({ "3": { asset_id: 3, balance: "100", locked_balance: "0" } }, 1));
    expect(state.status).toBe("empty");
    expect(state.assets.size).toBe(0);
    expect(state.available(3)).toBe(0n);
    expect(state.timestampMs).toBeUndefined();
  });

  test("a snapshot syncs, and records the millisecond timestamp", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "1", locked_balance: "0" } }, 1774884082326));
    expect(state.status).toBe("synced");
    expect(state.timestampMs).toBe(1774884082326);
  });

  test("reset marks the state stale and refuses further updates", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "1", locked_balance: "0" } }));
    state.reset();
    expect(state.status).toBe("stale");

    state.applyUpdate(update({ "3": { asset_id: 3, balance: "999", locked_balance: "0" } }));
    expect(state.status).toBe("stale");
    // The pre-reset value is still readable, deliberately — but it did not move.
    expect(state.available(3)).toBe(10n ** 18n);
  });

  test("a post-reconnect snapshot re-syncs and replaces wholesale", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(
      snapshot({
        "1": { asset_id: 1, balance: "1", locked_balance: "0" },
        "3": { asset_id: 3, balance: "2", locked_balance: "0" },
      }),
    );
    state.reset();
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "5", locked_balance: "0" } }));
    expect(state.status).toBe("synced");
    expect(state.assets.size).toBe(1);
    expect(state.assets.has(1)).toBe(false); // gone: a snapshot is the complete state
    expect(state.available(3)).toBe(5n * 10n ** 18n);
  });
});

describe("updates merge by asset id", () => {
  test("an asset absent from an update is left alone, not deleted", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(
      snapshot({
        "1": { asset_id: 1, symbol: "ETH", balance: "2", locked_balance: "0" },
        "3": { asset_id: 3, symbol: "USDC", balance: "100", locked_balance: "0" },
      }),
    );
    state.applyUpdate(update({ "3": { asset_id: 3, symbol: "USDC", balance: "150", locked_balance: "0" } }));

    expect(state.assets.size).toBe(2);
    expect(state.available(1)).toBe(2n * 10n ** 18n); // untouched
    expect(state.available(3)).toBe(150n * 10n ** 18n); // updated
  });

  test('a balance that falls to zero arrives as "0" and is applied as zero', () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "100", locked_balance: "0" } }));
    state.applyUpdate(update({ "3": { asset_id: 3, balance: "0", locked_balance: "0" } }));
    expect(state.assets.has(3)).toBe(true);
    expect(state.available(3)).toBe(0n);
    expect(state.assets.get(3)?.balance).toBe("0");
  });

  test("the timestamp advances with each applied frame", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "1", locked_balance: "0" } }, 1000));
    state.applyUpdate(update({ "3": { asset_id: 3, balance: "2", locked_balance: "0" } }, 2000));
    expect(state.timestampMs).toBe(2000);
  });
});

describe("tolerating whatever the wire delivers", () => {
  test("neither apply path throws on a degenerate frame", () => {
    const state = new AccountAssetsState(1234);
    expect(() => state.applySnapshot({} as AccountAssetsMessage)).not.toThrow();
    expect(() => state.applyUpdate({} as AccountAssetsMessage)).not.toThrow();
    expect(() =>
      state.applySnapshot({ type: "s", channel: "account_all_assets:1234", assets: [] as never }),
    ).not.toThrow();
    expect(() =>
      state.applyUpdate({
        type: "u",
        channel: "account_all_assets:1234",
        assets: { "3": null as never },
      }),
    ).not.toThrow();
  });

  test("a null or undefined frame is dropped, not thrown on", () => {
    const state = new AccountAssetsState(1234);
    expect(() => state.applySnapshot(null as unknown as AccountAssetsMessage)).not.toThrow();
    expect(() => state.applyUpdate(undefined as unknown as AccountAssetsMessage)).not.toThrow();
    expect(state.status).toBe("empty");
    expect(state.assets.size).toBe(0);
  });

  test("an unparsable balance keeps its raw string and scales to zero rather than throwing", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "1e6", locked_balance: "0" } }));
    expect(state.assets.get(3)?.balance).toBe("1e6"); // preserved for inspection
    expect(state.available(3)).toBe(0n);
  });

  test("a missing balance field reads as zero, and a missing symbol as empty", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "3": { asset_id: 3 } }));
    expect(state.assets.get(3)?.symbol).toBe("");
    expect(state.assets.get(3)?.balance).toBe("0");
    expect(state.available(3)).toBe(0n);
  });

  test("the asset id falls back to the map key when the payload omits asset_id", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ "9": { symbol: "LDO", balance: "3", locked_balance: "0" } }));
    expect(state.assets.get(9)?.symbol).toBe("LDO");
    expect(state.available(9)).toBe(3n * 10n ** 18n);
  });

  test("an entry with no usable id at all is skipped rather than filed under a bogus one", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot(snapshot({ notanumber: { symbol: "???", balance: "3" } }));
    expect(state.assets.size).toBe(0);
  });

  test("a frame whose channel names another account is ignored", () => {
    const state = new AccountAssetsState(1234);
    state.applySnapshot({
      type: "subscribed/account_all_assets",
      channel: "account_all_assets:9999",
      assets: { "3": { asset_id: 3, balance: "1", locked_balance: "0" } },
    });
    expect(state.status).toBe("empty");
    expect(state.assets.size).toBe(0);
  });

  test("both channel spellings are accepted for the right account", () => {
    const colon = new AccountAssetsState(1234);
    colon.applySnapshot(snapshot({ "3": { asset_id: 3, balance: "1", locked_balance: "0" } }));
    expect(colon.status).toBe("synced");

    const slash = new AccountAssetsState(1234);
    slash.applySnapshot({
      type: "subscribed/account_all_assets",
      channel: "account_all_assets/1234",
      assets: { "3": { asset_id: 3, balance: "1", locked_balance: "0" } },
    });
    expect(slash.status).toBe("synced");

    // A channel with no index at all cannot disprove anything, so it is applied.
    const bare = new AccountAssetsState(1234);
    bare.applySnapshot({
      type: "subscribed/account_all_assets",
      channel: "account_all_assets",
      assets: { "3": { asset_id: 3, balance: "1", locked_balance: "0" } },
    });
    expect(bare.status).toBe("synced");
  });
});
