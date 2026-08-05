import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __scanPatchBytesForTests as scanPatchBytes } from "../src/hub/carry.js";
import { isNeverIncludable } from "../src/hub/workspace.js";

/**
 * # The carry patch header scan, cross-checked against real `git apply`
 *
 * Three review rounds each closed a hand-listed family of `diff --git` /
 * `rename from` / … spellings, and each one missed the next family. The
 * spellings are not a list anyone can finish by hand, so this file stops
 * transcribing them: it GENERATES them over the axes that have actually
 * produced holes and asks **git itself** what each one means.
 *
 * The property under test is the only one the scan owes `applyCarry`:
 *
 * > If `git apply` resolves a header spelling to a path the `NEVER_INCLUDABLE`
 * > floor forbids, the byte scan produces a candidate the floor forbids.
 *
 * and its counterweight, without which the property is satisfiable by refusing
 * everything:
 *
 * > If a patch's text names no forbidden path at all, the scan flags nothing.
 *
 * The scan is deliberately an OVER-approximation of `git_header_name`, so an
 * exact set comparison would be wrong. Three places where git and the scan
 * legitimately differ are encoded as rules rather than skipped:
 *
 * 1. **git rejects the spelling outright** (`\v`/`\f` between the names, a
 *    malformed escape): git then names nothing and applies nothing, so the scan
 *    is unconstrained. Counted, and required to be non-empty — if a git version
 *    ever accepted all of them, the count says so.
 * 2. **`--numstat` is blind to a rename's or copy's SOURCE.** For those
 *    keywords the oracle reads `--summary` instead, and the test ASSERTS the
 *    blindness (no floor path among the `--numstat` records) rather than
 *    quietly working around it — that blindness is the whole reason the byte
 *    scan exists beside git's own parse.
 * 3. **`-p1` can strip the forbidden component away.** `diff --git
 *    .claude-sesh-mover/x .claude-sesh-mover/x` resolves to `x` for git, while
 *    the scan still sees the spelling and refuses. Counted as an over-refusal,
 *    which is the safe direction, and excluded from the false-refusal rule.
 *
 * Runtime is dominated by one `git apply` per DISTINCT generated spelling: 634
 * cases, 600 spawns, **1.9 s in isolation and 40 s under full-suite load**
 * (37 files in parallel, where every spawn costs ~60 ms instead of ~3 ms). It
 * is not on the suite's critical path — `hub-carry.test.ts` is longer — but it
 * is far past vitest's 20 s default, hence the explicit per-test timeout.
 *
 * Every axis below is an array: adding a value is a one-line change, which is
 * the point of the file. Set `SESH_HEADER_STATS=<file>` to dump the coverage
 * counters (how many spellings git accepted, how many it resolved onto the
 * floor, how many were expected differences) — that is where the numbers in
 * the task report come from.
 */

/** The receiver-side file every hostile spelling is aiming at. */
const FLOOR = ".claude-sesh-mover/hubinclude";
/** Its innocent twin: same shape, nothing the floor forbids. */
const SAFE = "docs/notes.txt";

/**
 * The real `git` executable, resolved ONCE.
 *
 * This harness spawns git several hundred times, and on macOS `/usr/bin/git`
 * is Xcode's `xcrun` shim: measured inside a vitest worker it costs **68 ms**
 * per call against **3 ms** for the binary it eventually execs. Resolving it
 * up front is the difference between a ~45 s test and a ~3 s one. `git
 * --exec-path` is the portable way to ask, and the fallback is the plain name,
 * so an installation whose exec path holds no `git` binary still works — just
 * more slowly. Production code deliberately keeps calling `git` by name; this
 * is a test-harness cost, not a behaviour.
 */
const GIT_BIN = ((): string => {
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
    const candidate = join(execPath, process.platform === "win32" ? "git.exe" : "git");
    return existsSync(candidate) ? candidate : "git";
  } catch {
    return "git";
  }
})();

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(GIT_BIN, args, {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: (err.stderr ?? "").trim().split("\n")[0]! };
  }
}

/** A throwaway repo holding both paths, committed. NEVER the checkout. */
function oracleRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sesh-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true });
  writeFileSync(join(dir, ".claude-sesh-mover", "hubinclude"), "v1\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "notes.txt"), "v1\n");
  writeFileSync(join(dir, "decoy.txt"), "v1\n");
  git(dir, ["add", "-A", "-f"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

// --- the axes ---------------------------------------------------------------

/** How ONE path can be written on ONE header half. */
interface Spelling {
  id: string;
  of(path: string): string;
}

/** `.` → `\056` (or `\56` at two digits, which git rejects). */
function octalHead(path: string, digits = 3): string {
  const octal = path.charCodeAt(0).toString(8).padStart(3, "0");
  return `\\${digits === 3 ? octal : octal.slice(-digits)}${path.slice(1)}`;
}

const SPELLINGS: Spelling[] = [
  { id: "plain", of: (p) => p },
  { id: "quoted", of: (p) => `"${p}"` },
  // Trailing bytes after the closing quote — `unquote_c_style` ignores them.
  { id: "quoted+X", of: (p) => `"${p}"X` },
  { id: "quoted+JUNK", of: (p) => `"${p}"JUNK` },
  // Escape spelling: the forbidden segment only exists after decoding.
  { id: "octal", of: (p) => `"${octalHead(p)}"` },
  { id: "octal+X", of: (p) => `"${octalHead(p)}"X` },
  // Escapes git REFUSES to decode, so it falls back to the literal bytes.
  { id: "octal2", of: (p) => `"${octalHead(p, 2)}"` },
  { id: "unknown-esc", of: (p) => `"\\z${p.slice(1)}"` },
  { id: "unterminated", of: (p) => `"${p}` },
  // An escaped quote INSIDE the name: a decoder that stopped at the first `"`
  // of any kind would end the path early here.
  { id: "escaped-dq", of: (p) => `"${p}\\""` },
];

/** The subset used for the separator sweep — quoting symmetry × trailing bytes. */
const SYMMETRY_SPELLINGS = SPELLINGS.filter((s) => ["plain", "quoted", "quoted+X"].includes(s.id));

/**
 * What can sit between the two names of a `diff --git` line. Git's own
 * `isspace` (its sane ctype) accepts SP/TAB/CR and rejects VT/FF.
 */
const SEPARATORS: Array<{ id: string; text: string }> = [
  { id: "SP", text: " " },
  { id: "TAB", text: "\t" },
  { id: "CR", text: "\r" },
  { id: "SP-SP", text: "  " },
  { id: "SP-TAB", text: " \t" },
  { id: "TAB-SP", text: "\t " },
  { id: "CR-TAB", text: "\r\t" },
  { id: "TAB-CR", text: "\t\r" },
  { id: "CR-CR", text: "\r\r" },
  { id: "VT", text: "\v" },
  { id: "FF", text: "\f" },
  { id: "VT-SP", text: "\v " },
  { id: "SP-VT", text: " \v" },
];

/** `a/`/`b/` is what git emits; the rest are `--src-prefix`/`mnemonicPrefix`/`--no-prefix`. */
const PREFIX_PAIRS: Array<[string, string]> = [
  ["a/", "b/"], ["c/", "d/"], ["i/", "w/"], ["", ""],
];

// --- the corpus -------------------------------------------------------------

interface Case {
  /** `<generator>/<axis values>` — what a failure message has to name. */
  id: string;
  /** Which path-bearing keyword this case exercises. */
  keyword: string;
  patch: string;
  /** Does the patch text name the forbidden path at all? */
  intent: "floor" | "safe";
  /** Source side of a rename/copy: `--numstat` cannot see it, by design. */
  numstatBlind: boolean;
}

/**
 * A mode-only entry: no `---`/`+++`, no rename/copy lines, so the `diff --git`
 * line is the entry's ONLY path reference — which is exactly the shape that
 * walked past this scan in round 3 and applies with no runnable `git` at all.
 */
function diffGitCase(id: string, left: string, sep: string, right: string, intent: "floor" | "safe"): Case {
  return {
    id,
    keyword: "diff --git",
    patch: `diff --git ${left}${sep}${right}\nold mode 100644\nnew mode 100755\n`,
    intent,
    numstatBlind: false,
  };
}

function diffGitCases(): Case[] {
  const out: Case[] = [];
  for (const [path, intent] of [[FLOOR, "floor"], [SAFE, "safe"]] as const) {
    // Separator sweep, crossed with quoting symmetry and trailing bytes.
    for (const sep of SEPARATORS) {
      for (const l of SYMMETRY_SPELLINGS) {
        for (const r of SYMMETRY_SPELLINGS) {
          out.push(diffGitCase(
            `diff-git/sep=${sep.id}/l=${l.id}/r=${r.id}/${intent}`,
            l.of(`a/${path}`), sep.text, r.of(`b/${path}`), intent
          ));
        }
      }
    }
    // Escape spellings, crossed with prefix pairs — each spelling on the left,
    // on the right, and on both, against a plain quoted twin.
    for (const spelling of SPELLINGS) {
      for (const [lp, rp] of PREFIX_PAIRS) {
        const quoted = SPELLINGS.find((s) => s.id === "quoted")!;
        const sides: Array<[string, Spelling, Spelling]> = [
          ["left", spelling, quoted], ["right", quoted, spelling], ["both", spelling, spelling],
        ];
        for (const [side, l, r] of sides) {
          out.push(diffGitCase(
            `diff-git/esc=${spelling.id}/side=${side}/prefix=${lp || "none"}/${intent}`,
            l.of(`${lp}${path}`), " ", r.of(`${rp}${path}`), intent
          ));
        }
      }
    }
  }
  return out;
}

/**
 * The eight single-name header keywords. Each entry puts the generated spelling
 * on exactly ONE line and keeps every other path in the patch innocent, so a
 * hit can only have come from the line under test.
 *
 * `prefix` is what git strips from that particular line: `---`/`+++` are read
 * at `-p1`, while `rename`/`copy` lines are read at `-p0` (git passes
 * `p_value - 1` for them, because they carry no `a/`/`b/`).
 */
const KEYWORDS: Array<{
  id: string;
  prefix: string;
  numstatBlind: boolean;
  build(spelled: string): string;
}> = [
  {
    id: "---", prefix: "a/", numstatBlind: false,
    build: (s) => `--- ${s}\n+++ /dev/null\n@@ -1 +0,0 @@\n-v1\n`,
  },
  {
    id: "+++", prefix: "b/", numstatBlind: false,
    build: (s) => `--- /dev/null\n+++ ${s}\n@@ -0,0 +1 @@\n+hi\n`,
  },
  {
    id: "rename from", prefix: "", numstatBlind: true,
    build: (s) => `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
      `rename from ${s}\nrename to moved.txt\n`,
  },
  {
    id: "rename to", prefix: "", numstatBlind: false,
    build: (s) => `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
      `rename from decoy.txt\nrename to ${s}\n`,
  },
  {
    id: "rename old", prefix: "", numstatBlind: true,
    build: (s) => `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
      `rename old ${s}\nrename new moved.txt\n`,
  },
  {
    id: "rename new", prefix: "", numstatBlind: false,
    build: (s) => `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
      `rename old decoy.txt\nrename new ${s}\n`,
  },
  {
    id: "copy from", prefix: "", numstatBlind: true,
    build: (s) => `diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n` +
      `copy from ${s}\ncopy to stolen.txt\n`,
  },
  {
    id: "copy to", prefix: "", numstatBlind: false,
    build: (s) => `diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n` +
      `copy from decoy.txt\ncopy to ${s}\n`,
  },
];

function keywordCases(): Case[] {
  const out: Case[] = [];
  for (const [path, intent] of [[FLOOR, "floor"], [SAFE, "safe"]] as const) {
    for (const keyword of KEYWORDS) {
      for (const spelling of SPELLINGS) {
        out.push({
          id: `keyword/${keyword.id}/${spelling.id}/${intent}`,
          keyword: keyword.id,
          patch: keyword.build(spelling.of(`${keyword.prefix}${path}`)),
          intent,
          numstatBlind: keyword.numstatBlind,
        });
      }
    }
  }
  return out;
}

// --- the oracle -------------------------------------------------------------

interface Oracle {
  accepted: boolean;
  /** Every path git names, destinations and rename/copy sources alike. */
  paths: string[];
  /** Only the `--numstat` records — used to assert the documented blindness. */
  numstatPaths: string[];
}

/**
 * ` rename docs/{notes.txt => other.txt} (100%)` — `--summary` compacts a
 * shared prefix/suffix, so the two paths have to be reassembled.
 */
function expandRenameSummary(body: string): string[] {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(body);
  if (brace) return [brace[1]! + brace[2]! + brace[4]!, brace[1]! + brace[3]! + brace[4]!];
  const halves = body.split(" => ");
  return halves.length === 2 ? halves : [body];
}

/**
 * What git says this patch means. `--numstat -z` and `--summary` in ONE
 * invocation: the NUL-terminated numstat records come first, the summary lines
 * after the last NUL. `core.quotePath=false` so the answer is raw UTF-8 rather
 * than re-quoted.
 */
function oracle(repo: string, patchFile: string): Oracle {
  const r = git(repo, ["-c", "core.quotePath=false", "apply", "--numstat", "-z", "--summary", patchFile]);
  if (!r.ok) return { accepted: false, paths: [], numstatPaths: [] };
  const records = r.stdout.split("\0");
  const summary = records.pop() ?? "";
  const numstatPaths = records
    .filter((rec) => rec.length > 0)
    .map((rec) => rec.split("\t").slice(2).join("\t"));
  const paths = [...numstatPaths];
  for (const line of summary.split("\n")) {
    const m = /^ (?:rename|copy) (.*) \(\d+%\)$/.exec(line);
    if (m) paths.push(...expandRenameSummary(m[1]!));
  }
  return { accepted: true, paths, numstatPaths };
}

/** Exactly what `applyCarry` computes as `scanUnsafe`, for one patch file. */
function scanRefuses(patchFile: string): { refuses: boolean; paths: string[] } {
  const scan = scanPatchBytes(patchFile);
  if (scan === null) return { refuses: true, paths: [] };
  return {
    refuses: scan.symlink !== null || scan.paths.some(isNeverIncludable),
    paths: scan.paths,
  };
}

const CASES = [...diffGitCases(), ...keywordCases()];

describe("carry patch header scan — differential against real `git apply`", () => {
  it(
    "flags every generated spelling git resolves onto the floor, and no innocent one",
    { timeout: 180_000 },
    () => {
      const repo = oracleRepo("hdrdiff");
      const patchFile = join(repo, "..", "hdrdiff.patch");
      try {
        /** git resolves a forbidden path, the scan does not flag it. THE bug class. */
        const holes: string[] = [];
        /** The patch names nothing forbidden, the scan flags it anyway. */
        const falseRefusals: string[] = [];
        /** `--numstat` saw a forbidden path on a line documented as blind to it. */
        const blindnessBroken: string[] = [];
        const stats = {
          total: 0, accepted: 0, gitRejected: 0, floorResolved: 0, overRefusedByStrip: 0,
          gitCalls: 0,
        };
        const floorKeywords = new Set<string>();
        // Both answers are pure functions of the patch bytes, and the axes
        // overlap (a `quoted`/`quoted` pair is generated as "left", "right" and
        // "both"), so identical spellings are asked once. Deduplication is what
        // keeps the git-spawn count meaningfully below the case count.
        const answers = new Map<string, { o: Oracle; scan: ReturnType<typeof scanRefuses> }>();

        for (const c of CASES) {
          stats.total++;
          let answer = answers.get(c.patch);
          if (answer === undefined) {
            stats.gitCalls++;
            writeFileSync(patchFile, c.patch, "latin1");
            answer = { o: oracle(repo, patchFile), scan: scanRefuses(patchFile) };
            answers.set(c.patch, answer);
          }
          const { o, scan } = answer;
          const detail = `${c.id}\n    patch=${JSON.stringify(c.patch)}` +
            `\n    git=${JSON.stringify(o.paths)}\n    scan=${JSON.stringify(scan.paths)}`;

          if (!o.accepted) {
            // Rule 1: git names nothing and applies nothing. Unconstrained.
            stats.gitRejected++;
            continue;
          }
          stats.accepted++;
          const gitFloor = o.paths.filter((p) => isNeverIncludable(p));
          if (gitFloor.length > 0) {
            stats.floorResolved++;
            floorKeywords.add(c.keyword);
            if (!scan.refuses) holes.push(detail);
            // Rule 2: the source side of a rename/copy is invisible to
            // `--numstat`, which is why the byte scan exists at all.
            if (c.numstatBlind && o.numstatPaths.some((p) => isNeverIncludable(p))) {
              blindnessBroken.push(detail);
            }
          } else if (c.intent === "safe") {
            if (scan.refuses) falseRefusals.push(detail);
          } else {
            // Rule 3: `-p1` stripped the forbidden component off git's reading.
            // The scan still sees the spelling; over-refusing is the safe side.
            stats.overRefusedByStrip++;
          }
        }

        // Coverage counters, for the report and for the next round's baseline.
        if (process.env.SESH_HEADER_STATS) {
          writeFileSync(process.env.SESH_HEADER_STATS, JSON.stringify(stats, null, 2));
        }
        expect(holes).toEqual([]);
        expect(falseRefusals).toEqual([]);
        expect(blindnessBroken).toEqual([]);

        // The corpus has to stay meaningful: a generator that silently stopped
        // producing appliable floor spellings would satisfy everything above.
        expect(stats.total).toBe(CASES.length);
        expect(stats.floorResolved).toBeGreaterThan(100);
        expect(stats.gitRejected).toBeGreaterThan(0); // the VT/FF and bad-escape axes
        expect([...floorKeywords].sort()).toEqual(
          ["diff --git", ...KEYWORDS.map((k) => k.id)].sort()
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(join(repo, "..", "hdrdiff.patch"), { force: true });
      }
    }
  );

  it("the cheap oracle agrees with what a real `git apply` does to the floor file", () => {
    // `--numstat`/`--summary` are a PARSE, not an apply, so the harness above
    // rests on them meaning what they say. These four spellings — one per way
    // the oracle learns a path — are applied for real by a bare `git apply`
    // with none of this module's guards, and the receiver's own
    // `.claude-sesh-mover/hubinclude` is inspected afterwards.
    const sample: Array<{ id: string; patch: string; check(dir: string): boolean }> = [
      {
        id: "rename from, quoted with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
          `rename from "${FLOOR}"X\nrename to moved.txt\n`,
        check: (d) => !existsSync(join(d, FLOOR)) && readFileSync(join(d, "moved.txt"), "utf-8") === "v1\n",
      },
      {
        id: "rename from, octal-escaped with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
          `rename from "${octalHead(FLOOR)}"X\nrename to moved.txt\n`,
        check: (d) => !existsSync(join(d, FLOOR)) && readFileSync(join(d, "moved.txt"), "utf-8") === "v1\n",
      },
      {
        id: "copy from, quoted with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n` +
          `copy from "${FLOOR}"X\ncopy to stolen.txt\n`,
        check: (d) => existsSync(join(d, FLOOR)) &&
          readFileSync(join(d, "stolen.txt"), "utf-8") === "v1\n",
      },
      {
        id: "diff --git, CR separator + asymmetric quoting (--numstat destination)",
        patch: `diff --git a/${FLOOR}\r"b/${FLOOR}"\nold mode 100644\nnew mode 100755\n`,
        check: (d) => (statSync(join(d, FLOOR)).mode & 0o111) !== 0,
      },
    ];
    const seed = oracleRepo("hdrreal");
    try {
      for (const s of sample) {
        const twin = mkdtempSync(join(tmpdir(), "sesh-hdrtwin-"));
        try {
          cpSync(seed, twin, { recursive: true });
          const patchFile = join(twin, "..", "real.patch");
          writeFileSync(patchFile, s.patch, "latin1");
          // The cheap oracle first…
          const o = oracle(twin, patchFile);
          expect(o.accepted, s.id).toBe(true);
          expect(o.paths.some((p) => isNeverIncludable(p)), s.id).toBe(true);
          // …then the real thing, with no guards in the way.
          const applied = git(twin, ["apply", patchFile]);
          expect(applied.ok, `${s.id}: ${applied.stderr}`).toBe(true);
          expect(s.check(twin), s.id).toBe(true);
          // And the scan — the only line of defence for the two `--summary`
          // shapes on a receiver whose git works perfectly.
          expect(scanRefuses(patchFile).refuses, s.id).toBe(true);
          rmSync(patchFile, { force: true });
        } finally {
          rmSync(twin, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  });

  it("flags nothing in a real `git diff` of exotic but ordinary tracked names", () => {
    // The false-refusal side, measured against git's OWN output rather than
    // against generated spellings: every name here is one git C-quotes,
    // pads with spaces, or otherwise renders in a shape the scan has to
    // survive. A single flag here is a peer's ordinary edit reported to the
    // user as a security refusal naming them.
    const repo = oracleRepo("hdrnegative");
    try {
      const names = [
        "docs/notes.txt",
        "docs/my notes.txt",
        "docs/two  spaces.txt",
        "docs/tab\there.txt",
        "docs/café.txt",
        "docs/naïve — dash.txt",
        "docs/quote\"inside.txt",
        "docs/back\\slash.txt",
        "docs/dollar$sign.txt",
        "docs/.claude-sesh-mover notes.md",
        "docs/.claude-sesh-moverX/notes.md",
        "docs/not.claude-sesh-mover/notes.md",
        "docs/a b/c d/e f.txt",
        "docs/=> arrow.txt",
        "docs/percent%20.txt",
        "docs/新しい.txt",
        "docs/trailing .txt",
        "docs/#hash.txt",
        "docs/semi;colon.txt",
        "docs/pipe|bar.txt",
      ];
      for (const name of names) {
        mkdirSync(join(repo, name, ".."), { recursive: true });
        writeFileSync(join(repo, name), "v1\n");
      }
      // Renamed, not edited, and long enough for git's similarity detection to
      // emit `rename from`/`rename to` rather than a delete plus a create.
      const movable = "docs/moved  café.txt";
      writeFileSync(join(repo, movable), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "exotic"]);
      for (const name of names) writeFileSync(join(repo, name), "v2\n");
      git(repo, ["mv", movable, "docs/renamed \"quoted\".txt"]);

      const patchFile = join(repo, "..", "negative.patch");
      const diff = git(repo, ["diff", "HEAD", "--src-prefix=a/", "--dst-prefix=b/"]);
      expect(diff.ok).toBe(true);
      writeFileSync(patchFile, diff.stdout, "utf-8");
      // The corpus really did reach the scan's hard shapes.
      expect(diff.stdout).toContain('diff --git "a/docs/caf');
      expect(diff.stdout).toContain("rename from ");

      const scan = scanRefuses(patchFile);
      expect(scan.refuses).toBe(false);
      rmSync(patchFile, { force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
