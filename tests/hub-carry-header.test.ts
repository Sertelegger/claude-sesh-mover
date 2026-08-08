import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __scanPatchBytesForTests as scanPatchBytes } from "../src/hub/carry.js";
import { isNeverIncludable } from "../src/hub/workspace.js";
import { readTextLf } from "./helpers/eol.js";
import { copyTreeSync } from "./helpers/copy-tree.js";

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
 *    .sesh-mover/x .sesh-mover/x` resolves to `x` for git, while
 *    the scan still sees the spelling and refuses. Counted as an over-refusal,
 *    which is the safe direction, and excluded from the false-refusal rule.
 *
 * Rule 3 is the only branch that asserts nothing, so it is where a weakened
 * ORACLE would silently drain the corpus — measured: an oracle that stops
 * reading `--summary` moves 60 floor resolutions into it. `FLOOR_RESOLVED` is
 * therefore pinned exactly and rule 3 bounded, and a `--summary` line that
 * cannot be read back to exactly one source is a FAILURE rather than a guess.
 *
 * Runtime is dominated by one `git apply` per DISTINCT generated spelling: 834
 * cases, 800 spawns, **2.8 s in isolation and 43 s under full-suite load**
 * (37 files in parallel, where every spawn costs ~60 ms instead of ~3 ms). It
 * is not on the suite's critical path — `hub-carry.test.ts` is longer — but it
 * is far past vitest's 20 s default, hence the explicit per-test timeout.
 *
 * Every axis below is an array: adding a value is a one-line change, which is
 * the point of the file. Set `SESH_HEADER_STATS=<file>` to dump the coverage
 * counters (how many spellings git accepted, how many it resolved onto the
 * floor, how many were expected differences) — that is where the numbers in
 * the task report come from.
 *
 * The axes are still ENUMERATED, and every one of them was added after a
 * reviewer found the family it would have caught. The two that generalise
 * furthest are worth naming, because they are what a new axis should look like:
 * `SEPARATORS` and `TERMINATION_SPELLINGS` are not lists of exploits, they are
 * the two byte-classification decisions git's parser makes (what separates two
 * names, what ends one) swept over their whole plausible domain.
 */

/**
 * The receiver-side file every hostile spelling is aiming at.
 *
 * Deliberately the DIRECTORY-shaped prize (`.sesh-mover/config.json` redirects
 * `hub.path`) rather than the root dotfile: two path components is what makes
 * the `-p1` strip axis and the middle-component axis mean anything, and the
 * measured baselines below were taken against a two-component floor. The root
 * dotfiles are covered where their shape actually differs — see
 * `ROOT_DOTFILE_FLOOR` at the end of this file.
 */
const FLOOR = ".sesh-mover/config.json";
/**
 * Since 0.7.0 the committed rule file is a ROOT DOTFILE, so a payload can name
 * it with no directory component in the way. One segment, so it adds no new
 * axis to the corpus above — but it is the file that decides what this
 * machine's next push uploads, so the scan has to meet it too.
 *
 * `LEGACY_ROOT_DOTFILE_FLOOR` is the 0.7.0 spelling, retired by 0.8.0 and kept
 * on the floor forever: bundles written by 0.7.0 name it, and they are on hubs
 * now. Both are seeded so a case can aim at either.
 */
const ROOT_DOTFILE_FLOOR = ".sesh-mover-include";
const LEGACY_ROOT_DOTFILE_FLOOR = ".sesh-mover-hubinclude";
/**
 * The same floor, reached at the LEAF instead of a middle component.
 *
 * A trailing timestamp is appended to the last component, so it is the only
 * position where git stripping one can uncover a forbidden segment that the
 * un-stripped reading of the line does not already show. Measured applying for
 * real: `+++ b/sub/.sesh-mover <timestamp>` creates that file.
 */
const FLOOR_TAIL = "sub/.sesh-mover";
/** Their innocent twin: same shape, nothing the floor forbids. */
const SAFE = "docs/notes.txt";
/** `\t2024-01-02 …` — the trailing timestamp GNU diff writes after a name. */
const TIMESTAMP = "2024-01-02 00:00:00.000000000 +0000";

/**
 * Corpus names Win32 cannot hold — with git's OWN rendering of each, so the
 * scan still meets the bytes on that platform.
 *
 * `< > : " / \ | ? *` and every byte below 0x20 are reserved in a Win32
 * filename, and five of the negative test's exotic names use one. Four of them
 * simply cannot be created (`ENOENT`/`EINVAL`); `back\slash.txt` is worse,
 * because it does not fail — Win32 reads the backslash as a separator and
 * silently creates `docs/back/slash.txt`, a name that is not the one under test
 * and whose rendering git does not quote at all. Both outcomes lose coverage the
 * negative test exists to have.
 *
 * The shapes are real and were each added after a reviewer found the hole it
 * covers, so they are SUBSTITUTED rather than dropped: the scan reads patch
 * bytes and has no idea whether a file exists, so on Windows these are appended
 * to the corpus as synthetic header blocks. `header`/`body` are the exact bytes
 * git prints — measured, then pinned by the drift guard in the test itself,
 * which asserts on every other platform that git's real rendering of the very
 * same name still contains them. A synthetic that stopped matching git would
 * therefore fail the POSIX run rather than quietly test a spelling git no longer
 * produces.
 */
const WIN32_RESERVED_NAMES: Array<{ name: string; why: string; header: string; body: string }> = [
  {
    name: "docs/=> arrow.txt",
    why: "`>` is reserved",
    // Unquoted (all bytes are printable ASCII), and the traditional lines carry
    // git's trailing TAB because the name holds a space.
    header: "diff --git a/docs/=> arrow.txt b/docs/=> arrow.txt",
    body: "--- a/docs/=> arrow.txt\t\n+++ b/docs/=> arrow.txt\t",
  },
  {
    name: "docs/pipe|bar.txt",
    why: "`|` is reserved",
    header: "diff --git a/docs/pipe|bar.txt b/docs/pipe|bar.txt",
    body: "--- a/docs/pipe|bar.txt\n+++ b/docs/pipe|bar.txt",
  },
  {
    name: "docs/back\\slash.txt",
    why: "`\\` is the Win32 path separator, so this name becomes docs/back/slash.txt",
    header: "diff --git \"a/docs/back\\\\slash.txt\" \"b/docs/back\\\\slash.txt\"",
    body: "--- \"a/docs/back\\\\slash.txt\"\n+++ \"b/docs/back\\\\slash.txt\"",
  },
  {
    name: "docs/quote\"inside.txt",
    why: "`\"` is reserved",
    header: "diff --git \"a/docs/quote\\\"inside.txt\" \"b/docs/quote\\\"inside.txt\"",
    body: "--- \"a/docs/quote\\\"inside.txt\"\n+++ \"b/docs/quote\\\"inside.txt\"",
  },
  {
    name: "docs/tab\there.txt",
    why: "every byte below 0x20 is reserved",
    header: "diff --git \"a/docs/tab\\there.txt\" \"b/docs/tab\\there.txt\"",
    body: "--- \"a/docs/tab\\there.txt\"\n+++ \"b/docs/tab\\there.txt\"",
  },
];

/**
 * The negative test's RENAME, whose destination Win32 cannot hold either.
 *
 * `docs/renamed "quoted".txt` is there for one shape: a `rename to` line git
 * C-quotes *and* whose body holds an escaped `"`, which is where a decoder that
 * ended the name at the first quote of any kind would stop early. Windows gets a
 * legal destination for the real `git mv` — still non-ASCII, so `rename to` is
 * still quoted — plus this block appended synthetically for the escaped-quote
 * spelling. Same drift guard as above.
 */
const WIN32_RESERVED_RENAME = {
  posixTo: "docs/renamed \"quoted\".txt",
  win32To: "docs/renamed café.txt",
  header: "diff --git \"a/docs/moved  caf\\303\\251.txt\" \"b/docs/renamed \\\"quoted\\\".txt\"",
  body: "rename from \"docs/moved  caf\\303\\251.txt\"\n" +
    "rename to \"docs/renamed \\\"quoted\\\".txt\"",
};

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

/**
 * A scratch file to write generated patches into, in a directory of its own.
 *
 * A fixed name under `$TMPDIR` (what this file used) races: two runs of the
 * suite on one machine — a watch-mode run beside a full one is the ordinary
 * case — would read each other's bytes and answer for the wrong patch. Not
 * inside the oracle repo either, where an untracked file would show up in the
 * negative test's own `git diff`.
 */
function patchSlot(name: string): { file: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `sesh-${name}-patch-`));
  return {
    file: join(dir, "patch.diff"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A throwaway repo holding both paths, committed. NEVER the checkout. */
function oracleRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sesh-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  mkdirSync(join(dir, ".sesh-mover"), { recursive: true });
  writeFileSync(join(dir, FLOOR), "v1\n");
  // The root dotfile floor lives beside it, so a case can name either shape —
  // in both the current and the retired 0.7.0 spelling.
  writeFileSync(join(dir, ROOT_DOTFILE_FLOOR), "docs/\n");
  writeFileSync(join(dir, LEGACY_ROOT_DOTFILE_FLOOR), "docs/\n");
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

/**
 * Spellings that exercise git's NAME TERMINATION rather than its quoting — the
 * axis a `diff --git` line has no branch for (a TAB there is a separator, and
 * the separator sweep already crosses every one of them), so these are added to
 * the single-name keywords only.
 *
 * They exist because the nine path-bearing keywords do NOT share one rule:
 * `---`/`+++` are read with `TERM_TAB`, and drop even that when a traditional
 * line carries a trailing timestamp; the six rename/copy keywords are read with
 * `terminate = 0`, where a TAB is an ordinary byte of the name. A scan that
 * truncated every keyword at the first TAB — what this one did — saw `["b"]` for
 * a line git resolves onto the floor and applies.
 */
const TERMINATION_SPELLINGS: Spelling[] = [
  // A TAB mid-name, with a further component after it: the six rename/copy
  // keywords keep the whole thing, and so does a timestamped `---`/`+++`.
  { id: "tab-inside", of: (p) => `X\t${p}` },
  { id: "tab-inside-sub", of: (p) => `X\tsub/${p}` },
  { id: "tab-inside+ts", of: (p) => `X\tsub/${p}\t${TIMESTAMP}` },
  // Timestamps on an otherwise plain name. The TAB form is terminated by
  // TERM_TAB anyway; the SPACE form is not, and git strips it all the same.
  { id: "ts-tab", of: (p) => `${p}\t${TIMESTAMP}` },
  { id: "ts-space", of: (p) => `${p} ${TIMESTAMP}` },
];

/** Every spelling a single-name header line is generated with. */
const NAME_LINE_SPELLINGS = [...SPELLINGS, ...TERMINATION_SPELLINGS];

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
  for (const [path, intent] of [[FLOOR, "floor"], [FLOOR_TAIL, "floor"], [SAFE, "safe"]] as const) {
    for (const keyword of KEYWORDS) {
      for (const spelling of NAME_LINE_SPELLINGS) {
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
  /** Summary bodies this file could not read back to exactly one source. */
  ambiguous: string[];
}

/**
 * ` rename docs/{a.txt => b.txt} (100%)` → the rename's SOURCE, `docs/a.txt`.
 *
 * `git apply --summary` is `show_rename_copy` in apply.c, **not** `git diff
 * --summary`'s `pprint_rename` — measured, and the difference matters: it
 * compacts only a common PREFIX (never a suffix) and it never C-quotes, so
 * every byte of both paths is present raw. What it does not do is escape `{`,
 * `}` or ` => `, which makes the line ambiguous on its face: a rename of
 * `d/.sesh-mover/{f.txt` to `d/out.txt` prints
 * ` rename d/{.sesh-mover/{f.txt => out.txt} (100%)`, and reading that
 * with a `(.*)\{(.*) => (.*)\}(.*)` regex yields `d/{.sesh-mover/f.txt`
 * — whose first segment is `{.sesh-mover`, so a genuine floor resolution
 * scores as an ordinary one and the case drains into rule 3 unnoticed.
 *
 * It is not ambiguous once the DESTINATION is known, and `--numstat` reports
 * that exactly. Both shapes are then anchored:
 *
 * - plain: `body === <src> " => " <dest>`;
 * - compacted: `body === <pfx> "{" <srcRest> " => " <dstRest> "}"`, where
 *   `<pfx>` ends in `/` and `<pfx><dstRest> === <dest>` — so every `/` in the
 *   destination is one candidate split and at most one of them can fit.
 *
 * A body that yields no reading, or more than one, is reported as AMBIGUOUS
 * rather than guessed at: the caller fails the suite on it, because a silently
 * mis-expanded source is exactly the failure this replaces.
 */
function renameSummarySource(body: string, dests: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dest of dests) {
    const plain = ` => ${dest}`;
    if (body.length > plain.length && body.endsWith(plain)) {
      found.add(body.slice(0, body.length - plain.length));
    }
    for (let i = 0; i < dest.length; i++) {
      if (dest[i] !== "/") continue;
      const open = `${dest.slice(0, i + 1)}{`;
      const close = ` => ${dest.slice(i + 1)}}`;
      if (body.length < open.length + close.length) continue;
      if (!body.startsWith(open) || !body.endsWith(close)) continue;
      found.add(dest.slice(0, i + 1) + body.slice(open.length, body.length - close.length));
    }
  }
  return [...found];
}

/**
 * What git says this patch means. `--numstat -z` and `--summary` in ONE
 * invocation: the NUL-terminated numstat records come first, the summary lines
 * after the last NUL. `core.quotePath=false` so the answer is raw UTF-8 rather
 * than re-quoted.
 */
function oracle(repo: string, patchFile: string): Oracle {
  const r = git(repo, ["-c", "core.quotePath=false", "apply", "--numstat", "-z", "--summary", patchFile]);
  if (!r.ok) return { accepted: false, paths: [], numstatPaths: [], ambiguous: [] };
  const records = r.stdout.split("\0");
  const summary = records.pop() ?? "";
  const numstatPaths = records
    .filter((rec) => rec.length > 0)
    // A numstat record is `<added>\t<deleted>\t<path>`, and the path may itself
    // hold TABs (`rename to X<TAB>sub/…` is a name git accepts), so the tail is
    // rejoined rather than taken as one field.
    .map((rec) => rec.split("\t").slice(2).join("\t"));
  const paths = [...numstatPaths];
  const ambiguous: string[] = [];
  for (const line of summary.split("\n")) {
    const m = /^ (?:rename|copy) (.*) \(\d+%\)$/.exec(line);
    if (!m) continue;
    const sources = renameSummarySource(m[1]!, numstatPaths);
    if (sources.length === 1) paths.push(sources[0]!);
    else ambiguous.push(`${line} [readings=${JSON.stringify(sources)} dests=${JSON.stringify(numstatPaths)}]`);
  }
  return { accepted: true, paths, numstatPaths, ambiguous };
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

/**
 * Measured coverage, pinned so the corpus cannot quietly drain.
 *
 * `FLOOR_RESOLVED` is how many generated cases git resolves onto the floor —
 * the only cases that constrain the scan at all. `OVER_REFUSED_BY_STRIP` bounds
 * rule 3, the one branch that asserts nothing. Both were read out of a real run
 * (`SESH_HEADER_STATS=<file> npx vitest run tests/hub-carry-header.test.ts`,
 * git 2.50.1).
 */
const FLOOR_RESOLVED = 247;
const OVER_REFUSED_BY_STRIP = 82;

describe("carry patch header scan — differential against real `git apply`", () => {
  it(
    "flags every generated spelling git resolves onto the floor, and no innocent one",
    { timeout: 180_000 },
    () => {
      const repo = oracleRepo("hdrdiff");
      const slot = patchSlot("hdrdiff");
      const patchFile = slot.file;
      try {
        /** git resolves a forbidden path, the scan does not flag it. THE bug class. */
        const holes: string[] = [];
        /** The patch names nothing forbidden, the scan flags it anyway. */
        const falseRefusals: string[] = [];
        /** `--numstat` saw a forbidden path on a line documented as blind to it. */
        const blindnessBroken: string[] = [];
        /** A `--summary` line the oracle could not read back to one source. */
        const oracleAmbiguous: string[] = [];
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
          if (o.ambiguous.length > 0) oracleAmbiguous.push(`${detail}\n    ambiguous=${JSON.stringify(o.ambiguous)}`);
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
        // An unreadable `--summary` line silently costs a floor resolution, so
        // it is a failure of the harness, not something to work around.
        expect(oracleAmbiguous).toEqual([]);

        // The corpus has to stay meaningful: a generator that silently stopped
        // producing appliable floor spellings would satisfy everything above.
        // Rule 3 is the one branch with no assertion inside it, so it is the one
        // a weakened oracle would drain into — `floorResolved` is therefore
        // pinned EXACTLY and rule 3 bounded, rather than both left loose. A
        // failure here means the corpus, the oracle or git's parser moved; the
        // answer is to find out which and re-measure, not to widen the numbers.
        expect(stats.total).toBe(CASES.length);
        expect(stats.floorResolved, "floor resolutions (pinned; see comment)").toBe(FLOOR_RESOLVED);
        expect(stats.overRefusedByStrip, "rule-3 sink (bounded; see comment)")
          .toBeLessThanOrEqual(OVER_REFUSED_BY_STRIP);
        expect(stats.gitRejected).toBeGreaterThan(0); // the VT/FF and bad-escape axes
        expect([...floorKeywords].sort()).toEqual(
          ["diff --git", ...KEYWORDS.map((k) => k.id)].sort()
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
        slot.dispose();
      }
    }
  );

  it("the cheap oracle agrees with what a real `git apply` does to the floor file", () => {
    // `--numstat`/`--summary` are a PARSE, not an apply, so the harness above
    // rests on them meaning what they say. These spellings — at least one per
    // way the oracle learns a path, and one per termination rule — are applied
    // for real by a bare `git apply` with none of this module's guards, and the
    // receiver's own `.sesh-mover` tree is inspected afterwards.
    //
    // Two of the eight state an OUTCOME Win32 cannot represent — an executable
    // bit, and a filename holding a TAB. `noApplyOnWin32` names the reason and
    // drops only the apply-and-inspect half there; the two halves that decide
    // whether the scan is sound (git's own `--numstat`/`--summary` reading of
    // the bytes, and the scan's) are pure parses and still run on every
    // platform. The count of dropped halves is asserted, so this cannot quietly
    // grow into "Windows checks nothing".
    interface Sample {
      id: string;
      patch: string;
      check(dir: string): boolean;
      /** Why the apply-and-inspect half cannot run on Windows. */
      noApplyOnWin32?: string;
    }
    const sample: Sample[] = [
      {
        id: "rename from, quoted with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
          `rename from "${FLOOR}"X\nrename to moved.txt\n`,
        check: (d) => !existsSync(join(d, FLOOR)) && readTextLf(join(d, "moved.txt")) === "v1\n",
      },
      {
        id: "rename from, octal-escaped with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n` +
          `rename from "${octalHead(FLOOR)}"X\nrename to moved.txt\n`,
        check: (d) => !existsSync(join(d, FLOOR)) && readTextLf(join(d, "moved.txt")) === "v1\n",
      },
      {
        id: "copy from, quoted with a trailing byte (--summary source)",
        patch: `diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n` +
          `copy from "${FLOOR}"X\ncopy to stolen.txt\n`,
        check: (d) => existsSync(join(d, FLOOR)) &&
          readTextLf(join(d, "stolen.txt")) === "v1\n",
      },
      {
        id: "diff --git, CR separator + asymmetric quoting (--numstat destination)",
        patch: `diff --git a/${FLOOR}\r"b/${FLOOR}"\nold mode 100644\nnew mode 100755\n`,
        check: (d) => (statSync(join(d, FLOOR)).mode & 0o111) !== 0,
        noApplyOnWin32: "no filesystem executable bit exists there, so a mode-only " +
          "change has no observable outcome to inspect",
      },
      // The four below are the TAB-termination family: a scan that truncated
      // every keyword's name at the first TAB saw `["b"]` or `["X"]` for each.
      {
        id: "copy to, TAB inside the name (rename/copy read with terminate = 0)",
        patch: `diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n` +
          `copy from decoy.txt\ncopy to X\tsub/${FLOOR}\n`,
        check: (d) => readTextLf(join(d, "X\tsub", ".sesh-mover", "config.json")) === "v1\n",
        noApplyOnWin32: "TAB is a reserved character in a Win32 filename, so the " +
          "directory this case creates cannot exist there",
      },
      {
        id: "--- traditional, TAB inside the name + timestamp (terminate = 0)",
        patch: `--- b\tQ/${FLOOR}\t${TIMESTAMP}\n+++ /dev/null\n@@ -1 +0,0 @@\n-v1\n`,
        // The TAB is in the `-p1`-stripped component, so nothing named with one
        // is ever created: this half runs everywhere.
        check: (d) => !existsSync(join(d, FLOOR)),
      },
      {
        id: "+++ traditional, TAB inside the name + timestamp (terminate = 0)",
        // A CREATION, so it must name a floor path the seed does NOT hold.
        patch: `--- /dev/null\n+++ b\tQ/.sesh-mover/planted.json\t${TIMESTAMP}\n@@ -0,0 +1 @@\n+{}\n`,
        check: (d) => readTextLf(join(d, ".sesh-mover", "planted.json")) === "{}\n",
      },
      {
        id: "+++ traditional, SPACE-separated timestamp, forbidden segment LAST",
        patch: `--- /dev/null\n+++ b/${FLOOR_TAIL} ${TIMESTAMP}\n@@ -0,0 +1 @@\n+pwned\n`,
        check: (d) => existsSync(join(d, "sub", ".sesh-mover")),
      },
    ];
    const seed = oracleRepo("hdrreal");
    const slot = patchSlot("hdrreal");
    let applyHalvesSkipped = 0;
    try {
      for (const s of sample) {
        const twin = mkdtempSync(join(tmpdir(), "sesh-hdrtwin-"));
        try {
          // `live` for the same reason as hub-carry's cleanTwin: the seed is a
          // real repository and git drops its own transient `.git` state
          // whenever it likes. This loop copies it once per sample, so it has
          // the most exposure of any caller.
          copyTreeSync(seed, twin, { live: true });
          const patchFile = slot.file;
          writeFileSync(patchFile, s.patch, "latin1");
          // The cheap oracle first…
          const o = oracle(twin, patchFile);
          expect(o.accepted, s.id).toBe(true);
          expect(o.paths.some((p) => isNeverIncludable(p)), s.id).toBe(true);
          // …then the real thing, with no guards in the way.
          if (process.platform === "win32" && s.noApplyOnWin32 !== undefined) {
            applyHalvesSkipped++;
          } else {
            const applied = git(twin, ["apply", patchFile]);
            expect(applied.ok, `${s.id}: ${applied.stderr}`).toBe(true);
            expect(s.check(twin), s.id).toBe(true);
          }
          // And the scan — the only line of defence for the two `--summary`
          // shapes on a receiver whose git works perfectly.
          expect(scanRefuses(patchFile).refuses, s.id).toBe(true);
          rmSync(patchFile, { force: true });
        } finally {
          rmSync(twin, { recursive: true, force: true });
        }
      }
      expect(applyHalvesSkipped, "apply halves dropped for Win32 (see noApplyOnWin32)")
        .toBe(process.platform === "win32" ? 2 : 0);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      slot.dispose();
    }
  });

  it("flags nothing in a real `git diff` of exotic but ordinary tracked names", () => {
    // The false-refusal side, measured against git's OWN output rather than
    // against generated spellings: every name here is one git C-quotes,
    // pads with spaces, or otherwise renders in a shape the scan has to
    // survive. A single flag here is a peer's ordinary edit reported to the
    // user as a security refusal naming them.
    const repo = oracleRepo("hdrnegative");
    const slot = patchSlot("hdrnegative");
    try {
      const names = [
        "docs/notes.txt",
        "docs/my notes.txt",
        "docs/two  spaces.txt",
        "docs/café.txt",
        "docs/naïve — dash.txt",
        "docs/dollar$sign.txt",
        "docs/.sesh-mover notes.md",
        // Digits after the space: the shape the trailing-timestamp strip must
        // NOT trim back to a forbidden segment (it refuses to strip a run
        // holding letters, and `2024.md` holds two).
        "docs/.sesh-mover 2024.md",
        "docs/.sesh-moverX/notes.md",
        "docs/not.sesh-mover/notes.md",
        "docs/a b/c d/e f.txt",
        "docs/percent%20.txt",
        "docs/新しい.txt",
        "docs/trailing .txt",
        "docs/#hash.txt",
        "docs/semi;colon.txt",
        // Created for real everywhere they CAN be; fed to the scan as synthetic
        // header blocks below on the one platform where they cannot.
        ...(process.platform === "win32" ? [] : WIN32_RESERVED_NAMES.map((n) => n.name)),
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
      const renameTo = process.platform === "win32"
        ? WIN32_RESERVED_RENAME.win32To
        : WIN32_RESERVED_RENAME.posixTo;
      const mv = git(repo, ["mv", movable, renameTo]);
      expect(mv.ok, `git mv ${renameTo}: ${mv.stderr}`).toBe(true);

      const patchFile = slot.file;
      const diff = git(repo, ["diff", "HEAD", "-M", "--src-prefix=a/", "--dst-prefix=b/"]);
      expect(diff.ok).toBe(true);
      // The names Win32 cannot hold are scanned as SYNTHETIC header blocks
      // instead of skipped — the scan reads bytes, and these are the exact bytes
      // git prints. On every other platform the same names are in the corpus for
      // real, and the drift guard below proves git still spells them this way,
      // so the substitute cannot drift away from what it substitutes for.
      const synthetic = WIN32_RESERVED_NAMES
        .map((n) => `${n.header}\nindex 1111111..2222222 100644\n${n.body}\n@@ -1 +1 @@\n-v1\n+v2\n`)
        .join("") +
        `${WIN32_RESERVED_RENAME.header}\nsimilarity index 100%\n${WIN32_RESERVED_RENAME.body}\n`;
      if (process.platform === "win32") {
        writeFileSync(patchFile, diff.stdout + synthetic, "utf-8");
      } else {
        for (const n of [...WIN32_RESERVED_NAMES, { name: "the rename", ...WIN32_RESERVED_RENAME }]) {
          expect(diff.stdout, `${n.name}: git's own rendering`).toContain(`${n.header}\n`);
          expect(diff.stdout, `${n.name}: git's own rendering`).toContain(`${n.body}\n`);
        }
        writeFileSync(patchFile, diff.stdout, "utf-8");
      }
      // The corpus really did reach the scan's hard shapes.
      expect(diff.stdout).toContain('diff --git "a/docs/caf');
      expect(diff.stdout).toContain("rename from ");

      const scan = scanRefuses(patchFile);
      expect(scan.refuses).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      slot.dispose();
    }
  });

  it("reads a rename's SOURCE back out of every shape `git apply --summary` prints", () => {
    // The oracle above learns a rename/copy source from `--summary` alone, so a
    // mis-read there does not fail — it quietly scores a floor resolution as an
    // ordinary one and the case drains into rule 3. These are real renames, made
    // with `git mv` and rendered by git itself, chosen so that every branch of
    // `show_rename_copy` and every character that makes its output ambiguous is
    // present: the `{…}` prefix compaction, a name holding ` => `, names holding
    // `{` and `}`, a name git C-quotes in `git diff` but NOT in `--summary`, and
    // — the one that matters — a floor path whose spelling makes the naive
    // `(.*)\{(.*) => (.*)\}(.*)` reading come out as `{.sesh-mover`,
    // i.e. innocent.
    //
    // `docs/a => b.txt` is the one Win32 cannot hold (`>` is reserved), and it
    // is also the case with the most to say: its summary line reads ` rename
    // docs/{a => b.txt => c.txt} (100%)`, where the ` => ` separator appears
    // twice and only the destination tells the two apart. Skipping it there
    // would silently drop the ambiguity this test is named for, so on Windows
    // the rename is not MADE — it is fed to the oracle as the exact patch text
    // git produces for it. `git apply --numstat --summary` is a parse: measured,
    // it reads that patch identically in a repo where neither path exists. The
    // POSIX run makes the same rename for real and asserts git still prints
    // these bytes, so the substitute cannot drift.
    const ARROW_RENAME = {
      from: "docs/a => b.txt",
      to: "docs/c.txt",
      patch: "diff --git a/docs/a => b.txt b/docs/c.txt\nsimilarity index 100%\n" +
        "rename from docs/a => b.txt\nrename to docs/c.txt\n",
    };
    const win32 = process.platform === "win32";
    const renames: Array<[from: string, to: string]> = [
      ["docs/deep/a.txt", "docs/deep/b.txt"],
      ["docs/one/name.txt", "docs/two/name.txt"],
      ["one/shared/name.txt", "two/shared/name.txt"],
      ["alpha.txt", "beta.txt"],
      ["docs/café.txt", "docs/naïve.txt"],
      ...(win32 ? [] : [[ARROW_RENAME.from, ARROW_RENAME.to] as [string, string]]),
      ["docs/{brace.txt", "docs/out.txt"],
      ["docs/}close.txt", "docs/out2.txt"],
      ["d/.sesh-mover/{f.txt", "d/out.txt"],
    ];
    const repo = oracleRepo("hdrsummary");
    const slot = patchSlot("hdrsummary");
    try {
      renames.forEach(([from], i) => {
        mkdirSync(join(repo, from, ".."), { recursive: true });
        // Distinct content per file: identical bodies let git pair the renames
        // any way it likes, and then the expected source is not what we asked.
        writeFileSync(join(repo, from), Array.from({ length: 30 }, (_, n) => `file ${i} line ${n}\n`).join(""));
      });
      git(repo, ["add", "-A", "-f"]);
      git(repo, ["commit", "-q", "-m", "renamable"]);
      for (const [from, to] of renames) {
        mkdirSync(join(repo, to, ".."), { recursive: true });
        const mv = git(repo, ["mv", "-f", from, to]);
        expect(mv.ok, `git mv ${from}: ${mv.stderr}`).toBe(true);
      }
      const diff = git(repo, ["diff", "HEAD", "-M", "--src-prefix=a/", "--dst-prefix=b/"]);
      expect(diff.ok).toBe(true);
      // The drift guard: where the rename could be made for real, git's own
      // rendering of it is the synthetic patch, byte for byte.
      if (!win32) expect(diff.stdout).toContain(ARROW_RENAME.patch);
      writeFileSync(slot.file, win32 ? diff.stdout + ARROW_RENAME.patch : diff.stdout, "utf-8");

      const o = oracle(repo, slot.file);
      expect(o.accepted).toBe(true);
      expect(o.ambiguous, "every summary line resolves to exactly one source").toEqual([]);
      // Every source, byte for byte — including the compacted, the
      // brace-bearing, and the ` => `-bearing one. `toContain` per entry so a
      // failure names the path.
      for (const [from] of [...renames, [ARROW_RENAME.from]]) expect(o.paths, from).toContain(from);
      // …and the floor one is scored as a floor resolution, which is the whole
      // point: the naive expansion returned `d/{.sesh-mover/f.txt` here,
      // whose first segment is not forbidden.
      expect(o.paths.filter((p) => isNeverIncludable(p)))
        .toEqual(["d/.sesh-mover/{f.txt"]);
      // The corpus really did exercise the compaction rather than nine plain
      // `<src> => <dst>` lines.
      expect(diff.stdout).toContain("rename from ");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      slot.dispose();
    }
  });
});
