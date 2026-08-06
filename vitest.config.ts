import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
    // Vitest's 5s default is wrong for this suite and was making it flaky.
    // Testing conventions here forbid mocking the filesystem and archive
    // layers, so the heaviest tests really do run `git`, `tar` and the built
    // CLI against real temp trees — the slowest measure 3-5s in isolation and
    // then lose to a 5s deadline under full-suite load (~36 files in parallel,
    // ~170s of test time in ~40s of wall clock). The failure was not just a red
    // test either: a timed-out test's `finally` block runs INSIDE the next
    // test, so one timeout knocked over unrelated tests that shared a
    // process-wide HOME override. Raised for hooks too, since fixture setup and
    // recursive temp-tree cleanup are the same kind of work.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
