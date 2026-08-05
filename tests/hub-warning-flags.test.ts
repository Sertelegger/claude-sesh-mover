import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FORECLOSURE GUARD.
 *
 * This milestone produced the same defect seven times: a message that names a
 * CLI flag as the way out of the situation it is describing, in a branch that
 * has already recorded the bundle — so the named re-run answers "already up to
 * date" and the advice is impossible. Four instances were caught reactively
 * during the work and three more shipped to the whole-branch review.
 *
 * Reviewing prose does not stop the eighth. This does: every line in `src/hub/`
 * that names a flag the CLI actually declares must be classified here, and a
 * new or reworded one fails until someone says which class it is in. The
 * classes are not decoration — each carries a rule the text is checked against.
 *
 * - `retry-works`   — the operation applied and recorded NOTHING for this item,
 *                     so re-running with the named flag genuinely reaches it.
 *                     Only this class may say "re-run".
 * - `future-only`   — this item is foreclosed (its bundle is recorded by the
 *                     end of the operation). The flag applies to a LATER
 *                     operation, and the text must scope it that way.
 * - `descriptive`   — the flag is named as the cause of an outcome, as
 *                     something that already happened, or as an argument of the
 *                     invocation itself. Not advice, so no scoping is needed —
 *                     but it may not be phrased as a re-run either.
 *
 * Keep `match` a distinctive substring of the line. Rewording the message
 * breaks this test on purpose: the rewording is exactly when the class needs
 * re-checking.
 */

interface FlagUse {
  file: string;
  match: string;
  klass: "retry-works" | "future-only" | "descriptive";
  why: string;
}

const REGISTRY: FlagUse[] = [
  // ---- src/hub/pull.ts -----------------------------------------------------
  {
    file: "pull.ts",
    match: "re-pull the next workspace payload with --target-path",
    klass: "future-only",
    why: "A successful merge withheld a file. This pull recorded its bundles, so the remedies are aimed at the NEXT payload from that machine.",
  },
  {
    file: "pull.ts",
    match: "Pass --apply-carry on a future pull",
    klass: "future-only",
    why: "The carry decision cannot be revisited for this bundle; the saved payload is the remedy for THIS one.",
  },
  {
    file: "pull.ts",
    match: "Pass --project-id <id> to link to an existing hub project.",
    klass: "retry-works",
    why: "The pull refused before touching anything (unlinked project); the same invocation plus --project-id runs from the top.",
  },
  {
    file: "pull.ts",
    match: "no common point to merge from and NOTHING was written",
    klass: "future-only",
    why: "The no-ancestor workspace skip. Sessions imported and the bundles are recorded, so this pull cannot be re-run for the payload — and because a skip records no generation, the state is sticky until a later payload is applied with one of the named flags.",
  },
  {
    file: "pull.ts",
    match: "no 3-way merge was attempted even though this machine has workspace generations",
    klass: "descriptive",
    why: "Restates what --force-workspace just did. Nothing is being asked of the user.",
  },
  {
    file: "pull.ts",
    match: "To use this destination anyway, re-run with --force-workspace",
    klass: "retry-works",
    why: "An explicit --target-path that is not empty aborts the pull before this bundle's session import, so nothing is recorded and the re-run reaches the same payload.",
  },
  {
    file: "pull.ts",
    match: "skipped, nothing changed. Re-run with --on-divergence",
    klass: "retry-works",
    why: "--on-divergence skip is the mode that deliberately applies and records nothing, precisely so the choice can be made on a re-run.",
  },
  {
    file: "pull.ts",
    match: "adopt-hub refused for thread",
    klass: "retry-works",
    why: "The liveness refusal was given SKIP semantics for this exact reason (Task 4 fix round 2): nothing applied, nothing recorded, so --force-append on the re-run reaches the adoption.",
  },
  {
    file: "pull.ts",
    match: "was adopted anyway because --force-append was passed",
    klass: "descriptive",
    why: "Restates the consequence the user consented to, after the fact.",
  },
  {
    file: "pull.ts",
    match: "that decision stands for it — adopt-hub cannot be applied to it afterwards",
    klass: "future-only",
    why: "The default `fragment` resolution. The fragment import records the bundle, so adopt-hub can never be applied to it; --on-divergence skip is named only as the mode to run the NEXT divergence under.",
  },
  // ---- src/hub/push.ts -----------------------------------------------------
  {
    file: "push.ts",
    match: "Pass --project-id <id> to link to an existing hub project, or --create-project",
    klass: "retry-works",
    why: "The push refused before writing anything.",
  },
  {
    file: "push.ts",
    match: "untrack them (git rm --cached) or push with --no-carry",
    klass: "future-only",
    why: "The files are already on the hub; both remedies are about what the NEXT push carries.",
  },
  // ---- everything else -----------------------------------------------------
  {
    file: "init.ts",
    match: "Point --path at an empty directory or a valid sesh-mover hub.",
    klass: "retry-works",
    why: "hub init wrote nothing; --path is the invocation's own argument.",
  },
  {
    file: "reindex.ts",
    match: "Run push (with --create-project or --project-id)",
    klass: "retry-works",
    why: "reindex found no link and did nothing; the named push is a different command that has not been foreclosed.",
  },
  {
    file: "merge.ts",
    match: "no-ancestor mode (unpack into an empty target, else skip unless --force-workspace)",
    klass: "descriptive",
    why: "A boundary assertion aimed at callers of the library, not a user-facing remedy.",
  },
  {
    file: "carry.ts",
    match: "the pull did not ask for carried changes to be applied (--apply-carry)",
    klass: "descriptive",
    why: "Names the flag as the CAUSE of this decline. pull.ts turns it into advice, and that line is classified above.",
  },
  {
    file: "workspace.ts",
    match: "or pass --no-workspace on future pushes",
    klass: "future-only",
    why: "The snapshot was empty, not skipped; --no-workspace is about how the user pushes from now on.",
  },
];

const HUB_DIR = join(import.meta.dirname, "..", "src", "hub");

/** Flags the CLI actually declares — the mechanical source of truth. */
function declaredFlags(): string[] {
  const cli = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf-8");
  return [...new Set(cli.match(/"--[a-z][a-z-]*/g) ?? [])].map((m) => m.slice(1));
}

/** Every non-comment line in src/hub/ that names one of those flags. */
function flagLines(): Array<{ file: string; line: number; text: string; flag: string }> {
  // Whole-token boundary: `--exclude` must not match git's `--exclude-standard`,
  // and `--name` must not match `--name-only`.
  const pattern = new RegExp(
    declaredFlags().map((f) => `${f.replace(/[-]/g, "\\-")}(?![-\\w])`).join("|")
  );
  const out: Array<{ file: string; line: number; text: string; flag: string }> = [];
  for (const file of readdirSync(HUB_DIR).filter((f) => f.endsWith(".ts")).sort()) {
    const lines = readFileSync(join(HUB_DIR, file), "utf-8").split("\n");
    for (const [i, text] of lines.entries()) {
      const trimmed = text.trim();
      // Comments carry the reasoning ABOUT these messages; only shipped text is
      // under test here.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const m = pattern.exec(text);
      if (m) out.push({ file, line: i + 1, text, flag: m[0] });
    }
  }
  return out;
}

describe("every shipped message naming a CLI flag is classified", () => {
  it("has a registry entry for each one", () => {
    const unclassified = flagLines()
      .filter((l) => !REGISTRY.some((r) => r.file === l.file && l.text.includes(r.match)))
      .map((l) => `${l.file}:${l.line} (${l.flag}) ${l.text.trim().slice(0, 120)}`);
    expect(
      unclassified,
      "A message in src/hub/ names a CLI flag and is not classified in tests/hub-warning-flags.test.ts.\n" +
        "Decide, for the branch that emits it: does the next invocation with that flag actually reach this item, " +
        "or has this run already recorded it? Then add an entry (retry-works / future-only / descriptive)."
    ).toEqual([]);
  });

  it("has no stale registry entries", () => {
    const lines = flagLines();
    const stale = REGISTRY.filter(
      (r) => !lines.some((l) => l.file === r.file && l.text.includes(r.match))
    ).map((r) => `${r.file}: ${r.match}`);
    expect(stale, "Registry entries that no longer match any shipped line — reword or remove them.").toEqual(
      []
    );
  });

  it("keeps a foreclosed remedy from being phrased as a re-run of THIS operation", () => {
    // The exact shape of the defect: "Re-run with --x" in a branch where the
    // bundle is already recorded. Only `retry-works` may say it.
    const offenders: string[] = [];
    for (const line of flagLines()) {
      const entry = REGISTRY.find((r) => r.file === line.file && line.text.includes(r.match));
      if (!entry || entry.klass === "retry-works") continue;
      if (/\bre-?run (?:with|it with|the)\b/i.test(line.text)) {
        offenders.push(`${line.file}:${line.line} is ${entry.klass} but tells the user to re-run`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scopes every future-only remedy to a later operation", () => {
    const SCOPING = /\bfuture\b|\bnext\b|\blater\b|\bfrom now on\b|cannot be re-run|stands for it/i;
    const unscoped = REGISTRY.filter((r) => r.klass === "future-only").filter((r) => {
      const line = flagLines().find((l) => l.file === r.file && l.text.includes(r.match));
      return !line || !SCOPING.test(line.text);
    });
    expect(
      unscoped.map((r) => `${r.file}: ${r.match}`),
      "A future-only remedy must say so in the message itself, or the user reads it as something to do now."
    ).toEqual([]);
  });

  // Not a flag question, but the same class of "the shipped artifact, not the
  // source": dist/ is committed so `/plugin install` works with no build step,
  // and package.json's `bin` points straight at dist/cli.js. It carries a
  // shebang and is meant to be run directly, so the mode git records for it has
  // to say so. Read from the INDEX, which is portable — a Windows checkout has
  // no exec bit in the working tree.
  it("keeps the committed dist/cli.js executable", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = join(import.meta.dirname, "..");
    const entry = execFileSync("git", ["ls-files", "-s", "dist/cli.js"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(entry.split(" ")[0]).toBe("100755");
  });

  it("never describes --force-workspace as a merge", () => {
    // Critical 3: four shipped strings called an overwrite a "merge", including
    // one emitted at the exact point chooseMergeAncestor had ruled a merge out.
    // The flag skips the 3-way merge by definition — it means "give me the
    // hub's copy wholesale".
    const MERGEY = /--force-workspace[^.]{0,120}?\bmerg(e|ing) (into|it into|the existing)\b|\bmerge into the existing\b/i;
    const offenders = flagLines()
      .filter((l) => l.text.includes("--force-workspace") && MERGEY.test(l.text))
      .map((l) => `${l.file}:${l.line}`);
    expect(offenders).toEqual([]);
  });
});
