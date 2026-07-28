/**
 * The small Bun surface used by this repository's tests and build tooling.
 *
 * The published package has no Bun dependency, and package.json deliberately keeps the exact
 * four development dependencies assigned by issue #52. Tests execute under Bun, so the runtime
 * remains authoritative; this ambient only lets TypeScript parse the runner imports and the
 * handful of `Bun.*` calls used by tests and scripts.
 */
declare namespace Bun {
  interface Subprocess {
    readonly exited: Promise<number>;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    kill(signal?: number | NodeJS.Signals): void;
  }

  interface BunStatic {
    readonly argv: string[];
    readonly env: Record<string, string | undefined>;
    readonly version: string;
    readonly Glob: {
      new (pattern: string): {
        scan(directory?: string): AsyncIterable<string>;
      };
    };
    file(path: string | URL): {
      exists(): Promise<boolean>;
      text(): Promise<string>;
    };
    gzipSync(input: Uint8Array): Uint8Array;
    serve(options: Record<string, unknown>): {
      readonly port: number;
      stop(closeActiveConnections?: boolean): void;
    };
    sleep(milliseconds: number): Promise<void>;
    spawn(command: readonly string[], options?: Record<string, unknown>): Subprocess;
    spawnSync(command: readonly string[], options?: Record<string, unknown>): {
      readonly exitCode: number;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
    };
    write(path: string | URL, data: string | Uint8Array): Promise<number>;
  }
}

declare const Bun: Bun.BunStatic;

declare module "bun:test" {
  type TestBody = () => unknown | Promise<unknown>;
  type Suite = (name: string, body: TestBody, timeout?: number) => void;

  interface Matchers {
    readonly not: Matchers;
    readonly rejects: Matchers;
    readonly resolves: Matchers;
    toBe<T = unknown>(expected: T, message?: string): void;
    toBeDefined(message?: string): void;
    toBeGreaterThan(expected: number | bigint, message?: string): void;
    toBeGreaterThanOrEqual(expected: number | bigint, message?: string): void;
    toBeInstanceOf(expected: abstract new (...args: never[]) => unknown, message?: string): void;
    toBeLessThan(expected: number | bigint, message?: string): void;
    toBeLessThanOrEqual(expected: number | bigint, message?: string): void;
    toBeNull(message?: string): void;
    toBeUndefined(message?: string): void;
    toContain(expected: unknown, message?: string): void;
    toEqual<T = unknown>(expected: T, message?: string): void;
    toHaveLength(expected: number, message?: string): void;
    toHaveProperty(path: string | readonly (string | number)[], value?: unknown): void;
    toMatch(expected: string | RegExp, message?: string): void;
    toMatchObject(expected: object, message?: string): void;
    toThrow(
      expected?: string | RegExp | Error | (abstract new (...args: never[]) => Error),
      message?: string,
    ): void;
  }

  interface Expect {
    <T = unknown>(actual: T, message?: string): Matchers;
    unreachable(message?: string): never;
  }

  interface Test extends Suite {
    each<T extends readonly unknown[]>(
      rows: readonly T[],
    ): (name: string, body: (...args: T) => unknown | Promise<unknown>, timeout?: number) => void;
  }

  export const afterEach: (body: TestBody) => void;
  export const beforeEach: (body: TestBody) => void;
  export const describe: Suite;
  export const expect: Expect;
  export const test: Test;
}
