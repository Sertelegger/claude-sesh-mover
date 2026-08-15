/**
  * Extraction guard — the refuse-and-throw must reach the caller unswallowed.
 *
 * append.ts refuses to roll back (and THROWS) when the base's on-disk size is
 * not exactly bytes-before + bytesWritten. Nothing between that throw and
 * cli.ts may catch it.
 */
import { describe, it, expect, vi } from "vitest";
import { hubPull } from "../src/hub/pull.js";
import { arrangeContinuation } from "./helpers/hub-fixtures.js";

vi.mock("../src/hub/append.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hub/append.js")>();
  const { appendFileSync } = await import("node:fs");
  return {
    ...actual,
    tryAppendContinuation: (a: Parameters<typeof actual.tryAppendContinuation>[0]) =>
      actual.tryAppendContinuation({
        ...a,
        // A live Claude Code session writes a line mid-splice, then our write
        // faults. The base is now larger than our own arithmetic accounts for,
        // so the rollback must be REFUSED and the refusal thrown.
        __injectFailure: (): never => {
          appendFileSync(a.basePath, '{"uuid":"other-writer","parentUuid":null}\n', "utf-8");
          throw new Error("simulated mid-splice fault");
        },
      }),
  };
});

describe("PROBE: rollback refusal propagates out of hubPull", () => {
  it("rejects instead of returning a result", async () => {
    const a = await arrangeContinuation();
    try {
      await expect(
        hubPull({
          configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
          latest: true, claudeVersion: "2.1.81",
        })
      ).rejects.toThrow(/rollback was REFUSED/);
    } finally {
      a.cleanup();
    }
  });
});
