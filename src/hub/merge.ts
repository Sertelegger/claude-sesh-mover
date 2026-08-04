import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_WORKSPACE_EXCLUDES, isExcluded, readHubignore } from "./workspace.js";

/** A file was left alone and the incoming copy parked beside it. */
export type SidecarReason =
  /** NUL byte in the first 8 KB on either side — `git merge-file` refuses these. */
  | "binary"
  /**
   * No usable `git merge-file` on this machine: missing, too old for our
   * invocation, or unable to run at all (a broken global/system git config
   * makes it exit 128 before it ever looks at the operands). All three are
   * properties of the machine, not of the file, so the rest of the tree
   * degrades with it instead of re-spawning a doomed process per file.
   */
  | "git-unavailable"
  /**
   * The 3-way merge did not complete for this one file: `git merge-file` was
   * reachable but failed on it, or the merge succeeded and its result could not
   * be written back. `detail` carries git's stderr, or the write's error.
   */
  | "merge-failed";

/**
 * A file the merge deliberately did not touch — and, unlike a sidecar case,
 * one where **nothing at all was written near that path**.
 *
 * That is deliberate, not an oversight — but the reasons differ in strength,
 * so don't restate this as "a sidecar would always escape too". It holds
 * outright when the obstruction is at a PARENT segment: parking
 * `docs/note.md.theirs-…` beside a `docs -> ~/notes` symlink writes outside the
 * project exactly as the original write would have, and parking beside a file
 * that occupies a directory's path just raises `ENOTDIR` in a different place.
 * When the obstruction is the destination itself — a symlinked file inside a
 * real directory, or `name-collision`, where `classifyDestination` already
 * approved the whole path and the `EEXIST` is itself proof of what's there —
 * a sidecar would in fact be safe, and parking one is a defensible future
 * change (`name-collision` is the likely one in practice: a case-folding
 * filesystem where a peer's `README.md` meets a local `readme.md`).
 *
 * Uniform "park nothing" is the conservative choice while the two cases are
 * indistinguishable in `SkipReason`: it is safe in every case, and the incoming
 * copy stays recoverable from the bundle on the hub either way.
 */
export type SkipReason =
  /** A symlink occupies the path (or one of its parents) locally — never written through. */
  | "local-symlink"
  /** A directory sits where a file should go, or vice versa. */
  | "local-not-a-file"
  /** The destination already existed although the tree scan said it did not
   *  (case-insensitive filesystem fold, or a concurrent create). */
  | "name-collision"
  /** Reading or writing this one file failed; the rest of the merge continued. */
  | "io-error";

export interface WorkspaceMergeReport {
  /** incoming changed, local didn't -> incoming written */
  taken: string[];
  /** local changed, incoming didn't -> local left alone */
  kept: string[];
  /** absent locally -> created */
  created: string[];
  /** both changed, 3-way merged cleanly */
  merged: string[];
  /** both changed, conflict markers written — the user must resolve these */
  conflicted: string[];
  /** local kept, incoming parked beside it (binary or unmergeable) */
  sidecars: Array<{ path: string; sidecar: string; reason: SidecarReason; detail?: string }>;
  /** gone upstream, deliberately kept locally (this merge never deletes) */
  upstreamDeleted: string[];
  /** paths the merge refused to touch, with why */
  skipped: Array<{ path: string; reason: SkipReason; detail?: string }>;
  /**
   * True when at least one file needed a 3-way merge and no usable
   * `git merge-file` was found. Those files are in `sidecars` with reason
   * "git-unavailable"; nothing was lost, but nothing was merged either.
   * False also means "no file ever needed the merge engine".
   */
  gitUnavailable: boolean;
}

/**
 * Thrown when `mergeWorkspaceTrees` is called without an ancestor tree.
 *
 * A 3-way merge with no ancestor degenerates into "every shared file whose
 * content differs is a both-added conflict", which would write conflict
 * markers across a user's whole working tree. That is not a merge, it is
 * damage. Callers with no known ancestor must use no-ancestor mode instead
 * (design §5.4: unpack an empty target, otherwise skip unless
 * `--force-workspace`).
 */
export class MergeAncestorRequiredError extends Error {
  constructor() {
    super(
      "a 3-way workspace merge needs an ancestor tree; with no known ancestor use " +
      "no-ancestor mode (unpack into an empty target, else skip unless --force-workspace)"
    );
    this.name = "MergeAncestorRequiredError";
  }
}

const BINARY_SNIFF_BYTES = 8192;
const MERGE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_SIDECAR_ATTEMPTS = 100;
const MAX_TMP_ATTEMPTS = 10;
/** Scratch-slot mode: readable and writable by us, and by nobody else. */
const SCRATCH_MODE = 0o600;

/**
 * The exact `git merge-file` invocation this module uses, minus the three file
 * operands. Every token is load-bearing:
 *
 * - `--diff3` is NOT cosmetic. Two reasons. (1) Determinism: `git merge-file`
 *   honors `merge.conflictStyle` from whatever repository the process happens
 *   to be standing in (verified — a repo-local `merge.conflictStyle=diff3`
 *   changes the output of a merge on files outside that repo), so without an
 *   explicit style the markers a user sees depend on ambient config. An
 *   explicit flag wins over config (verified against `zdiff3`). (2) There is no
 *   repository here, so the `||||||| ancestor` section is the ONLY place the
 *   user can see what the common ancestor said. It costs nothing and it is
 *   what makes a conflict resolvable by hand.
 * - `--` terminates option parsing. The file operands are paths this module
 *   generates, so nothing untrusted reaches argv today; `--` is the guard that
 *   keeps that true if a caller ever passes a path of its own. Without it a
 *   leading-dash filename is parsed as a switch (verified: `-weird.txt` ->
 *   "error: unknown switch `w'", exit 129).
 * - The labels are what the tests and the user-facing conflict guidance pin.
 */
const GIT_MERGE_ARGS = [
  "merge-file", "--diff3", "-L", "local", "-L", "ancestor", "-L", "incoming", "--",
];

/**
 * Probe whether this machine has a `git merge-file` we can actually use.
 *
 * Runs a real 3-way merge with the exact argument vector `mergeWorkspaceTrees`
 * uses, in a private temp dir, and checks both the exit status and the markers.
 * That is deliberately stronger than a version check:
 *
 * - `git <cmd> --help` is NOT a safe probe. It delegates to `git help <cmd>`,
 *   which spawns `man` on Unix and opens the HTML docs in the user's default
 *   BROWSER on Git for Windows. A capability probe must never open a window.
 * - `git merge-file -h` exits 129, so "no error" is not a usable signal either.
 * - Running the real thing also catches a git too old for `--diff3`, and a
 *   `git` on PATH that is a broken wrapper rather than git.
 *
 * The marker assertions below cannot be broken by a project's own git settings.
 * `cwd` is the probe's private temp dir, so no repository-local config is in
 * scope (same reason the merge spawn in `mergeWorkspaceTrees` sets it — see the
 * comment there), and `.gitattributes`' `conflict-marker-size` does
 * not reach `git merge-file` at all — verified: `* conflict-marker-size=15` in a
 * repo still produces 7-character markers, because merge-file takes three plain
 * paths and never consults the attribute stack. Same for
 * `merge.conflictMarkerSize`.
 *
 * Not memoized: the caller decides how often to ask (design §5.3 probes once
 * per pull, like `isZstdAvailable`), and a module-level cache would make the
 * degraded path untestable.
 */
export async function isGitMergeFileAvailable(): Promise<boolean> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "sesh-merge-probe-"));
  } catch {
    return false;
  }
  try {
    const current = join(dir, "current");
    const base = join(dir, "base");
    const other = join(dir, "other");
    writeFileSync(base, "1\n2\n3\n");
    writeFileSync(current, "1\nLOCAL\n3\n");
    writeFileSync(other, "1\nINCOMING\n3\n");
    const status = await new Promise<number | null>((resolve) => {
      execFile(
        "git",
        [...GIT_MERGE_ARGS, current, base, other],
        { cwd: dir, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err) => {
          if (err === null) return resolve(0);
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve(typeof code === "number" ? code : null);
        }
      );
    });
    // Exactly one conflict, marked up in diff3 style.
    if (status !== 1) return false;
    const out = readFileSync(current, "utf-8");
    return out.includes("<<<<<<< local")
      && out.includes("||||||| ancestor")
      && out.includes(">>>>>>> incoming");
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A NUL byte in the first 8 KB means "binary" — the same blunt heuristic git
 * itself uses. We pre-detect rather than parsing git's output because
 * `git merge-file` reports binary input as an error (exit 255,
 * "error: Cannot merge binary files"), which is indistinguishable at the exit
 * status from a genuine failure.
 */
export function isBinaryFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Content equality by sha256 (design §5.3 — never mtime), short-circuited on
 * size. Differing sizes cannot share a hash, and skipping the read matters
 * here: a workspace holds whatever the user keeps in their project, so the
 * files most likely to differ are also the ones most expensive to hash.
 */
function sameContent(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return hashFile(a) === hashFile(b);
}

/**
 * Every path in a `WorkspaceMergeReport` is workspace-relative and
 * forward-slash separated, on every platform — the same convention the hub's
 * own layout uses. `join()` normalizes them back to native separators.
 */
function listTree(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isExcluded(entry.name, patterns)) continue;
      if (entry.isSymbolicLink()) continue; // never follow (archiver/workspace posture)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

/**
 * Decide whether `rel` is safe to write inside `targetDir`.
 *
 * `rel` is built from real directory entries, so it can never contain a
 * separator, `..`, or a NUL — but what already sits at that path locally is
 * another matter. Two hazards, both of which write OUTSIDE the project or
 * destroy unrelated data if ignored:
 *
 * - A symlink at the path (or at any parent) — `copyFileSync` follows symlinks
 *   on the destination, so writing "docs/note.md" through a `docs -> ~/notes`
 *   link silently overwrites a file the merge was never asked to touch.
 * - A directory where a file belongs (or a file where a directory belongs) —
 *   `copyFileSync` raises EISDIR and `mkdirSync` raises ENOTDIR/EEXIST, which
 *   without this check aborts the whole merge halfway through a tree.
 */
function classifyDestination(
  targetDir: string,
  rel: string
): { ok: true } | { ok: false; reason: SkipReason } {
  const segments = rel.split("/");
  let current = targetDir;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return { ok: true }; // nothing there yet: we create it (and everything under it)
    }
    if (st.isSymbolicLink()) return { ok: false, reason: "local-symlink" };
    const isLast = i === segments.length - 1;
    if (isLast ? !st.isFile() : !st.isDirectory()) {
      return { ok: false, reason: "local-not-a-file" };
    }
  }
  return { ok: true };
}

/**
 * Replace `destPath`'s content with `contentFrom`'s via a same-directory
 * temp file and a rename.
 *
 * A plain `copyFileSync` over a user's file is not atomic: a crash mid-copy
 * leaves a truncated file, and by then this module holds the only other copy
 * of the local content in a temp dir it is about to delete. Same posture as
 * the hub backend's `writeAtomic`. The temp file is created by copying, so it
 * inherits `contentFrom`'s mode: for `taken` that is the incoming file's, and
 * for a merge result it is the local file's, because the caller chmods the
 * scratch copy back to the local mode immediately before calling in.
 *
 * The temp path is the one write in this module that does NOT go through
 * `classifyDestination`, so it carries its own two guards:
 *
 * - **`COPYFILE_EXCL`.** A plain `copyFileSync` follows a symlink at the
 *   destination, so a symlink planted at the temp path writes straight through
 *   it — outside the project — and then `renameSync` installs that symlink as
 *   the user's file. Verified on macOS and by libuv's `O_CREAT | O_EXCL` on
 *   Linux: `COPYFILE_EXCL` raises `EEXIST` on a symlink at the destination,
 *   live or dangling, so the escape is refused rather than followed.
 * - **A random component in the name.** A fixed `.<name>.sesh-merge.tmp` is
 *   both predictable (so the symlink above can be planted deliberately) and
 *   shared, so two merges into one tree would fight over one path — this layer
 *   holds no lock. It also collided with an incoming file that happened to
 *   carry that exact name: it was reported in `created` and then silently
 *   consumed by the next atomic write.
 *
 * `EEXIST` therefore means "something else is at this name": retry under a new
 * one rather than fail, since the name is ours to choose.
 */
function replaceFileAtomically(destPath: string, contentFrom: string): void {
  const dir = dirname(destPath);
  const stem = `.${basename(destPath)}.sesh-merge`;
  for (let n = 0; n < MAX_TMP_ATTEMPTS; n++) {
    const tmpPath = join(dir, `${stem}.${process.pid.toString(36)}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      copyFileSync(contentFrom, tmpPath, fsConstants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      // A failed copy leaves no partial file on the platforms measured here,
      // but that is libuv's behaviour rather than a guarantee this code holds —
      // and the name we would leave behind is one `snapshotWorkspace` would push
      // to the hub. Clean up unconditionally rather than relying on it.
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      throw e;
    }
    try {
      renameSync(tmpPath, destPath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      throw e;
    }
    return;
  }
  throw new Error(
    `could not create a temp file beside ${destPath} after ${MAX_TMP_ATTEMPTS} attempts`
  );
}

/** `sub/dir/img.bin` + `img.bin.theirs-…` -> `sub/dir/img.bin.theirs-…` */
function siblingRel(rel: string, name: string): string {
  const cut = rel.lastIndexOf("/");
  return cut === -1 ? name : `${rel.slice(0, cut + 1)}${name}`;
}

/**
 * Park the incoming copy beside the local file. Uses COPYFILE_EXCL so an
 * existing sidecar — from an earlier pull in the same second, or a user file
 * that happens to match — is never overwritten; the name is uniquified
 * instead.
 */
function writeSidecar(
  targetDir: string,
  rel: string,
  incomingPath: string,
  stamp: string
): string | null {
  const stem = `${basename(rel)}.theirs-${stamp}`;
  for (let n = 0; n < MAX_SIDECAR_ATTEMPTS; n++) {
    const name = n === 0 ? stem : `${stem}-${n + 1}`;
    const sidecarRel = siblingRel(rel, name);
    try {
      copyFileSync(incomingPath, join(targetDir, sidecarRel), fsConstants.COPYFILE_EXCL);
      return sidecarRel;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  return null;
}

/**
 * 3-way merge of two workspace generations against their common ancestor,
 * with no git repository anywhere in sight: `git merge-file` operates on three
 * plain files.
 *
 * Resolution table (design §5.3); comparison is by sha256 content hash, never
 * mtime. This function **never deletes a file** and never resolves a conflict
 * by discarding one side: the worst case for any file it *resolves* is "local
 * kept, incoming parked beside it" or "both sides present between conflict
 * markers". A file it refuses to touch at all lands in `skipped` and nothing is
 * written near it — see `SkipReason` for why parking a copy there would
 * reproduce the very hazard the skip exists to avoid.
 *
 * Excludes default to the standard workspace excludes plus the *target's*
 * `.claude-sesh-mover/hubignore` — so a file this machine deliberately keeps
 * out of the hub can never be overwritten by an incoming copy of the same name.
 *
 * `git merge-file` is spawned once per file that needs a real 3-way merge, and
 * spawned synchronously: the merge writes into the user's working tree in a
 * fixed order, and interleaving those writes buys nothing in a CLI.
 */
export async function mergeWorkspaceTrees(opts: {
  /** Common ancestor tree. `null` is rejected — see `MergeAncestorRequiredError`. */
  ancestorDir: string | null;
  incomingDir: string;
  targetDir: string;
  /** Override the exclude patterns; defaults to workspace excludes + target hubignore. */
  excludePatterns?: string[];
  /**
   * Test seam: the timestamp baked into sidecar names, defaulting to now.
   * Never set in production code.
   *
   * It exists because sidecar-name collisions are unreachable from a single
   * run — one file is sidecarred at most once, so the `-2` uniquification and
   * the `MAX_SIDECAR_ATTEMPTS` exhaustion path can only fire against sidecars
   * left by an *earlier* run carrying the same millisecond-precision stamp.
   * Without a fixed stamp a test can only try to race the clock, which is not
   * evidence: with `COPYFILE_EXCL` deleted, "two merges produce different
   * sidecar names" still passed 8 runs in 10, because the names differed by
   * milliseconds rather than by the guard.
   */
  __sidecarStamp?: string;
}): Promise<WorkspaceMergeReport> {
  if (opts.ancestorDir === null) throw new MergeAncestorRequiredError();

  const report: WorkspaceMergeReport = {
    taken: [], kept: [], created: [], merged: [], conflicted: [],
    sidecars: [], upstreamDeleted: [], skipped: [], gitUnavailable: false,
  };

  const patterns = opts.excludePatterns
    ?? [...DEFAULT_WORKSPACE_EXCLUDES, ...readHubignore(opts.targetDir)];
  const ancestorFiles = new Set(listTree(opts.ancestorDir, patterns));
  const incomingFiles = new Set(listTree(opts.incomingDir, patterns));
  const localFiles = new Set(listTree(opts.targetDir, patterns));
  const all = new Set<string>([...ancestorFiles, ...incomingFiles, ...localFiles]);

  // One stamp for the whole run, so every sidecar from one pull sorts together.
  const stamp = opts.__sidecarStamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const work = mkdtempSync(join(tmpdir(), "sesh-merge-"));
  const current = join(work, "current");
  const base = join(work, "base");
  const other = join(work, "other");

  const sidecar = (rel: string, incomingPath: string, reason: SidecarReason, detail?: string): void => {
    const written = writeSidecar(opts.targetDir, rel, incomingPath, stamp);
    if (written === null) {
      report.skipped.push({
        path: rel, reason: "io-error",
        detail: `could not park the incoming copy beside it after ${MAX_SIDECAR_ATTEMPTS} attempts`,
      });
      return;
    }
    report.sidecars.push({ path: rel, sidecar: written, reason, ...(detail ? { detail } : {}) });
  };

  try {
    for (const rel of [...all].sort()) {
      try {
        const ancestorPath = ancestorFiles.has(rel) ? join(opts.ancestorDir, rel) : null;
        const incomingPath = incomingFiles.has(rel) ? join(opts.incomingDir, rel) : null;
        const localPath = localFiles.has(rel) ? join(opts.targetDir, rel) : null;

        if (incomingPath === null) {
          // Gone upstream (or never there). Never delete a user's file.
          if (localPath !== null && ancestorPath !== null) report.upstreamDeleted.push(rel);
          continue;
        }

        const destination = classifyDestination(opts.targetDir, rel);
        if (!destination.ok) {
          report.skipped.push({ path: rel, reason: destination.reason });
          continue;
        }

        if (localPath === null) {
          const dest = join(opts.targetDir, rel);
          mkdirSync(dirname(dest), { recursive: true });
          try {
            // COPYFILE_EXCL, not a plain copy: the tree scan said this path was
            // free, so anything already there is something the scan could not
            // see — on a case-insensitive filesystem, a differently-cased local
            // file we would otherwise silently overwrite.
            copyFileSync(incomingPath, dest, fsConstants.COPYFILE_EXCL);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            report.skipped.push({ path: rel, reason: "name-collision" });
            continue;
          }
          report.created.push(rel);
          continue;
        }

        if (sameContent(localPath, incomingPath)) continue; // incl. the same edit on both sides

        // Absent from the ancestor means "added", which counts as changed on
        // whichever sides have it.
        const localChanged = ancestorPath === null || !sameContent(localPath, ancestorPath);
        const incomingChanged = ancestorPath === null || !sameContent(incomingPath, ancestorPath);

        if (!localChanged && incomingChanged) {
          try {
            replaceFileAtomically(localPath, incomingPath);
          } catch (e) {
            // Same reasoning as the merge path's write-back failure below: the
            // rename is atomic so the local file is exactly as it was, and the
            // destination directory is one `classifyDestination` already
            // approved — so park the incoming copy instead of letting this fall
            // through to `io-error`, which parks nothing.
            sidecar(rel, incomingPath, "merge-failed",
              `the incoming copy could not be written back: ${(e as Error).message}`);
            continue;
          }
          report.taken.push(rel);
          continue;
        }
        if (localChanged && !incomingChanged) {
          report.kept.push(rel);
          continue;
        }

        // Both sides changed, or the file is absent from the ancestor and
        // differs on both sides (both-added -> merged against an empty base,
        // which correctly yields whole-file conflict markers).
        if (isBinaryFile(localPath) || isBinaryFile(incomingPath)) {
          sidecar(rel, incomingPath, "binary");
          continue;
        }
        if (report.gitUnavailable) {
          sidecar(rel, incomingPath, "git-unavailable", "no usable git merge-file on this machine");
          continue;
        }

        // Reset the three scratch slots before every reuse. `copyFileSync`
        // propagates the SOURCE's mode onto the destination it creates, so a
        // single 0444 file in ANY of the three trees would otherwise leave the
        // slot read-only for good, and every later copy into it would fail
        // EACCES — one read-only file silently disabling the merge engine for
        // an arbitrary suffix of the tree, in whatever order the sort produced,
        // with the affected files landing in `skipped` (which parks nothing)
        // and a detail string naming a temp path the user cannot act on. Modes
        // survive snapshot -> tar -> unpack, so the trigger can arrive in a
        // peer's bundle.
        for (const slot of [current, base, other]) rmSync(slot, { force: true });
        copyFileSync(localPath, current);
        // git writes the merge RESULT into `current`, so it must be writable
        // whatever the local file's mode is — a read-only local file must not
        // make its own merge impossible. The local file's mode is handed back
        // below, before the result is copied into the user's tree, so this
        // never reaches them.
        const localMode = statSync(localPath).mode & 0o7777;
        chmodSync(current, SCRATCH_MODE);
        if (ancestorPath !== null) copyFileSync(ancestorPath, base);
        else writeFileSync(base, "");
        copyFileSync(incomingPath, other);

        // Verified against git 2.50.1: exit 0 = clean, 1..127 = conflict count
        // CLAMPED at 127 (128 hunks -> 127, 600 hunks -> 127), 128 = fatal
        // (git could not run at all — e.g. a bad config variable), 129 = usage
        // error (an option this git does not know), 255 = refusal (binary
        // input, unreadable operand). A spawn failure surfaces as ENOENT with
        // status null, never as an exit code — so 127 is unambiguously a
        // conflict count here and not the shell's "command not found".
        //
        // `cwd` is the scratch dir, NOT the inherited one. `git merge-file`
        // reads config from whatever repository the process is standing in even
        // though it takes three plain paths, and the caller's cwd is normally
        // the user's project — i.e. normally a repo. `--diff3` overrides
        // `merge.conflictStyle`, but config is VALIDATED before the flag
        // applies, so an invalid repo-local `merge.conflictStyle` makes
        // merge-file exit 128 with the flag passed (verified — and it really is
        // repo-LOCAL only: the same bogus value in global config exits 1 and
        // merges fine). Standing in the scratch dir removes the CALLER's
        // repo-local influence — the same run that exits 128 from inside the
        // repo exits 1 and merges correctly from here. It is not absolute: the
        // scratch dir is `mkdtemp(tmpdir())`, so a `TMPDIR` pointing inside
        // some other broken repo still reaches us. That degrades honestly
        // rather than silently, because 128 is handled below as an
        // engine-level failure. It also closes `diff.algorithm`, which cannot be pinned by
        // a flag (`--diff-algorithm` is far newer than `--diff3`) and which
        // shifts hunk boundaries, i.e. the clean/conflict outcome itself.
        let status: number | null = 0;
        let spawnCode: string | number | undefined;
        let signal: string | undefined;
        let stderr = "";
        try {
          execFileSync("git", [...GIT_MERGE_ARGS, current, base, other], {
            cwd: work,
            stdio: ["ignore", "ignore", "pipe"],
            timeout: MERGE_TIMEOUT_MS,
            windowsHide: true,
          });
        } catch (e) {
          const err = e as {
            status?: number | null; code?: string | number;
            signal?: string | null; stderr?: Buffer | string;
          };
          status = typeof err.status === "number" ? err.status : null;
          spawnCode = err.code;
          signal = err.signal ?? undefined;
          stderr = (err.stderr?.toString() ?? "").split("\n")[0]!.trim();
        }

        if (status !== null && status >= 0 && status <= 127) {
          // Hand the local file its own mode back before the result travels
          // into the user's tree (replaceFileAtomically copies, so the scratch
          // file's mode is what the user would otherwise end up with).
          chmodSync(current, localMode);
          try {
            replaceFileAtomically(localPath, current);
          } catch (e) {
            // The merge itself succeeded; only the write back failed, and
            // `renameSync` is atomic, so the local file is exactly as it was.
            // Park the incoming copy rather than letting this land in
            // `skipped`, which parks nothing — the destination directory is one
            // `classifyDestination` already approved, so a sidecar is safe here
            // in a way it is not for a genuine skip.
            sidecar(rel, incomingPath, "merge-failed",
              `the merge succeeded but its result could not be written back: ${(e as Error).message}`);
            continue;
          }
          (status === 0 ? report.merged : report.conflicted).push(rel);
          continue;
        }

        if (spawnCode === "ENOENT" || status === 128 || status === 129) {
          // git is missing, cannot run at all (128 — a broken git config is
          // rejected before merge-file looks at its operands), or is too old to
          // understand our invocation (129). All three are properties of the
          // machine rather than of this file, so degrade for the rest of the
          // tree instead of spawning once per file, and say so in the report
          // rather than failing opaquely.
          report.gitUnavailable = true;
          sidecar(rel, incomingPath, "git-unavailable",
            spawnCode === "ENOENT"
              ? "git was not found on PATH"
              : status === 128
                ? `git merge-file could not run: ${stderr || "fatal error"}`
                : `git merge-file rejected our invocation: ${stderr || "usage error"}`);
          continue;
        }
        sidecar(rel, incomingPath, "merge-failed",
          stderr
          || (signal !== undefined
            ? `git merge-file was killed by ${signal} (timed out after ${MERGE_TIMEOUT_MS}ms?)`
            : `git merge-file exited with status ${String(status ?? spawnCode ?? "unknown")}`));
      } catch (e) {
        // One unreadable/unwritable file must not abandon a half-merged tree.
        report.skipped.push({
          path: rel, reason: "io-error", detail: (e as Error).message,
        });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return report;
}
