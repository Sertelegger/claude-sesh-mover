import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";

/**
 * THE FORECLOSURE GUARD — a checklist, not a verifier.
 *
 * This milestone produced the same defect NINE times: a message that names a
 * CLI flag (or a config key) as the way out of the situation it is describing,
 * in a branch that has already recorded the bundle — so the named re-run
 * answers "already up to date" and the advice is impossible. Seven were found
 * reactively. This file was built after the seventh, and the eighth and ninth
 * went straight past it.
 *
 * ## What this file DOES
 *
 * It sweeps every non-comment message line under `src/` (minus `SWEEP_EXCLUDES`
 * — see there) that names a flag the CLI declares or a key `getDefaultConfig()`
 * declares, and fails until each one is classified here. A new or reworded
 * message fails until someone decides which class it is in and writes down why.
 * That is its real value: it forces a decision, and it caught reworded messages
 * during the milestone.
 *
 * Three of its checks are mechanical rather than editorial, and those are the
 * ones worth relying on:
 *
 * - `provenBy` — a `retry-works` entry must name a test that calls the
 *   operation TWICE. See `RetryProof`.
 * - the cross-command check — a message may not advise a flag that one of the
 *   commands SURFACING it does not accept. `src/importer.ts` is why: three
 *   commands call `importSession` and two of them re-emit its text verbatim, so
 *   a bare `--allow-duplicates` there was advice a `pull` could not follow.
 * - the `--force-workspace`-is-not-a-merge check, which is the only one that
 *   reaches into `commands/*.md`, `README.md` and the skill doc.
 *
 * The docs are deliberately NOT swept for registry entries: a reference doc
 * names every flag of its command by definition, so per-line classification
 * there would be one entry per documented flag and no signal.
 *
 * ## What this file CANNOT DO — read this before trusting it
 *
 * **It reads strings, not behaviour.** The eighth and ninth foreclosures both
 * shipped text that was ACCURATE ABOUT ITS OWN BRANCH. What was false was the
 * loop's behaviour two iterations later: the bundle the warning described was
 * protected, while an EARLIER bundle in the same chain had already been applied
 * and recorded. No amount of tightening a regex over prose can see that.
 *
 * Only a fixture with **three or more pending bundles** discriminates, because
 * with the fork on the LAST bundle `break` and `continue` are semantically
 * identical — there is nothing after it either way — so a two-bundle fixture
 * passes under both. That fixture exists, and it is the thing that actually
 * guards this defect class:
 *
 *   `tests/hub-pull.test.ts` → describe("hub pull — a divergence that stops the
 *   chain part-way"), fixture `arrangeSpliceThenFork`.
 *
 * When a `retry-works` claim depends on loop behaviour, PIN IT THERE via
 * `provenBy` (below) and not with a better sentence here.
 *
 * ## The classes, and how much each is really checked
 *
 * - `retry-works`  — the operation applied and recorded NOTHING for this item,
 *                    so re-running with the named flag genuinely reaches it.
 *                    Only this class may say "re-run".
 *                    CHECKED: must carry `provenBy`, naming a test that calls
 *                    the operation at least TWICE and asserts something. That
 *                    is the one class whose claim is executable.
 * - `future-only`  — this item is foreclosed (its bundle is recorded by the end
 *                    of the operation). The flag applies to a LATER operation,
 *                    and the text must scope it that way.
 *                    CHECKED, WEAKLY: one word from a five-alternative regex,
 *                    anywhere on the line, plus the "may not say re-run" rule.
 *                    A message that scopes one clause and forecloses in another
 *                    passes. Treat the `why:` as the real argument.
 * - `descriptive`  — the flag is named as the cause of an outcome, as something
 *                    that already happened, or as an argument of the invocation
 *                    itself. Not advice, so no scoping is needed.
 *                    CHECKED, WEAKLY: may not say "re-run", and may not put an
 *                    imperative remedy verb (pass/use/try/run/set) directly in
 *                    front of the flag — which is what turns it into advice and
 *                    out of this class.
 *
 * So: a reviewer who plants a genuine foreclosure and labels it can still get
 * it past two of the three classes. `provenBy` closes that for `retry-works`.
 * For the other two, this file records the decision; it does not verify it.
 *
 * Keep `match` a distinctive substring of the line. Rewording the message
 * breaks this test on purpose: the rewording is exactly when the class needs
 * re-checking.
 */

/**
 * The executable half of a `retry-works` claim.
 *
 * "Re-running reaches this item" is a statement about behaviour, and until this
 * existed it was a sentence in a `why:` that nothing ran. An entry now has to
 * point at a test that performs the second invocation, and this file checks the
 * test exists, calls `reruns` at least twice inside that one `it(...)`, asserts
 * something, and mentions the flag (or its camelCase option name) that the
 * warning advised — so the retry demonstrably passes the advised flag.
 *
 * What it still does not check, and a reviewer has to: that the named test
 * TRIGGERS THE WARNING IN QUESTION before it retries, and that its assertions
 * are the right ones. A test that calls the operation twice, asserts something,
 * and happens to mention the flag satisfies every mechanical condition here.
 * Vitest running the named test is what covers the rest, which is why the test
 * has to be a real one and not a stub.
 */
interface RetryProof {
  /** Test file, relative to `tests/`. */
  test: string;
  /** The `it(...)` title, verbatim. */
  name: string;
  /** Operation the named test must invoke at least twice. */
  reruns: string;
}

interface FlagUse {
  /** Repo-relative path with `/` separators, e.g. `src/hub/push.ts`. */
  file: string;
  match: string;
  klass: "retry-works" | "future-only" | "descriptive";
  why: string;
  /** REQUIRED when `klass` is `retry-works`. */
  provenBy?: RetryProof;
}

/**
 * The three-bundle divergence fixture, reused by every `retry-works` entry
 * whose claim is really a claim about the pull loop. Named once so that moving
 * or renaming it fails here loudly instead of quietly unpinning six entries.
 */
const SPLICE_THEN_FORK: RetryProof = {
  test: "hub-pull.test.ts",
  name: "applies and records the bundles before the fork, and says so instead of 'nothing changed'",
  reruns: "hubPull",
};

const REGISTRY: FlagUse[] = [
  // ---- the pull pipeline (src/hub/pull*.ts) --------------------------------
  {
    file: "src/hub/pull-apply-workspace.ts",
    match: "re-pull the next workspace payload with --target-path",
    klass: "future-only",
    why: "A successful merge withheld a file. This pull recorded its bundles, so the remedies are aimed at the NEXT payload from that machine.",
  },
  {
    file: "src/hub/pull-apply-carry.ts",
    match: "Pass --apply-carry on a future pull",
    klass: "future-only",
    why: "The carry decision cannot be revisited for this bundle; the saved payload is the remedy for THIS one.",
  },
  {
    file: "src/hub/pull-resolve.ts",
    match: "Pass --project-id <id> to link to an existing hub project.",
    klass: "retry-works",
    why: "The pull refused before touching anything (unlinked project); the same invocation plus --project-id runs from the top. The escape returns before registerMachine and before any hub write, so 'touching anything' stayed true when the resolve stage moved out of pull.ts.",
    provenBy: {
      test: "hub-pull-stages.test.ts",
      name: "refuses an unlinked project, and --project-id links it on the re-run",
      reruns: "runResolveStage",
    },
  },
  {
    file: "src/hub/pull-apply-workspace.ts",
    match: "no common point to merge from and NOTHING was written",
    klass: "future-only",
    why: "The no-ancestor workspace skip. Sessions imported and the bundles are recorded, so this pull cannot be re-run for the payload — and because a skip records no generation, the state is sticky until a later payload is applied with one of the named flags.",
  },
  {
    file: "src/hub/pull-apply-workspace.ts",
    match: "travels as its own file on the hub",
    klass: "future-only",
    why: "The split workspace artifact (#91) could not be fetched. It reads like a transient — a synced folder mid-delivery — and it is not re-runnable for that reason: this pull imported the sessions and RECORDED its bundles, so `selectNeededBundles` drops them on a repeat and the pull answers 'already up to date' without ever reaching the artifact. Nor does it self-heal, for the same reason the no-ancestor skip above does not: no generation is recorded for a payload that was not applied, so the next snapshot from that machine also finds nothing common to merge against and needs --force-workspace on a directory with content. The message states both, because 'give it a moment and pull again' was the obvious wording and would have been a tenth foreclosure.",
  },
  {
    file: "src/hub/pull-apply-workspace.ts",
    match: "no 3-way merge was attempted even though this machine has workspace generations",
    klass: "descriptive",
    why: "Restates what --force-workspace just did. Nothing is being asked of the user.",
  },
  {
    file: "src/hub/pull-apply-workspace.ts",
    match: "To use this destination anyway, re-run with --force-workspace",
    klass: "retry-works",
    why: "An explicit --target-path that is not empty aborts the pull before this bundle's session import, so nothing is recorded and the re-run reaches the same payload.",
    provenBy: {
      test: "hub-pull.test.ts",
      name: "refuses a non-empty --target-path, and --force-workspace overrides it",
      reruns: "hubPull",
    },
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "skipped, nothing changed. Re-run with --on-divergence",
    klass: "retry-works",
    why: "--on-divergence skip is the mode that deliberately applies and records nothing, precisely so the choice can be made on a re-run. Only true because the skip ABORTS THE WHOLE THREAD's chain (`divergenceAborted`): skipping just the diverged bundle left the next one in the chain to fragment-import and be recorded, which republished the index and foreclosed the re-run.",
    provenBy: {
      test: "hub-pull.test.ts",
      name: "--on-divergence skip leaves everything untouched",
      reruns: "hubPull",
    },
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "this bundle was skipped and the fork is still undecided, but",
    klass: "retry-works",
    why: "The same divergence skip, worded for a break part-way through a chain. Still retry-works, and for the same reason: nothing is applied or recorded for THIS bundle or any later one, so the re-run reaches the fork. What changed is the honesty of the rest of the sentence — the bundles BEFORE it in the chain were applied and recorded, and the old text claimed the whole pull had changed nothing. This is the EIGHTH foreclosure's wording, and no string check found it: only the three-bundle fixture named in `provenBy` can tell this break from a continue.",
    provenBy: SPLICE_THEN_FORK,
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "adopt-hub refused for thread",
    klass: "retry-works",
    why: "The liveness refusal was given SKIP semantics for this exact reason (Task 4 fix round 2), and thread-wide ABORT semantics for the second half of it (final round): nothing applied, nothing recorded, no later bundle of the chain fetched, so --force-append on the re-run reaches the adoption. With a per-bundle skip the promise held only for a single-bundle chain.",
    provenBy: {
      test: "hub-pull.test.ts",
      name: "a refused adoption stops the whole chain, so a two-bundle re-run still adopts",
      reruns: "hubPull",
    },
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "was adopted anyway because --force-append was passed",
    klass: "descriptive",
    why: "Restates the consequence the user consented to, after the fact.",
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "close the Claude Code session writing to that transcript before pulling",
    klass: "future-only",
    why: "The plain-append liveness decline. THIS bundle is fragment-imported and recorded, so no re-run reaches it — but --force-append on the NEXT pull of the thread does splice that pull's continuation (measured), so the flag is named with that scoping rather than withheld.",
  },
  {
    file: "src/hub/pull-apply-sessions.ts",
    match: "that decision stands for it — adopt-hub cannot be applied to it afterwards",
    klass: "future-only",
    why: "The default `fragment` resolution. The fragment import records the bundle, so adopt-hub can never be applied to it; --on-divergence skip (and its config key hub.onDivergence) is named only as the mode to run the NEXT divergence under.",
  },
  // ---- src/hub/push.ts -----------------------------------------------------
  {
    file: "src/hub/push.ts",
    match: "Pass --project-id <id> to link to an existing hub project, or --create-project",
    klass: "retry-works",
    why: "The push refused before writing anything.",
    provenBy: {
      test: "hub-push.test.ts",
      name: "refuses an unlinked project, and --create-project then links and pushes it",
      reruns: "hubPush",
    },
  },
  // ---- src/payload/capture.ts ----------------------------------------------
  // The capture decision and its disclosures, shared by `hub push` and
  // `sesh-mover export` since #47. Both commands surface every line here
  // verbatim, so the two trackedIgnored sentences are worded per transport and
  // each names its own command — which is also what keeps them out of the
  // cross-command check.
  {
    file: "src/payload/capture.ts",
    match: "untrack them (git rm --cached), or export without --include-carry, to keep the next one from carrying them",
    klass: "future-only",
    why: "The files are already in the bundle this export just wrote; both remedies — untracking and dropping the flag — are about what the NEXT export carries. Names `export` explicitly because `push` surfaces this file too and does not declare --include-carry.",
  },
  {
    file: "src/payload/capture.ts",
    match: "untrack them (git rm --cached) or push with --no-carry",
    klass: "future-only",
    why: "The files are already on the hub; both remedies are about what the NEXT push carries. Names `push` explicitly because `export` surfaces this file too and does not declare --no-carry.",
  },
  {
    file: "src/hub/push.ts",
    match: "on a later push to link to that one instead of minting a second",
    klass: "future-only",
    why: "A push that failed AFTER committing the identity link now rolls the local link back and reports the orphaned hub project by id. That hub project cannot be removed (there is no backend.delete call anywhere in src/), so this push cannot be repaired in place — --project-id is how the NEXT push links to the orphan instead of minting a second one. The existing 'Pass --project-id <id> to link to an existing hub project, or --create-project' entry does not fit: this message has to name the specific orphaned id.",
  },
  // ---- src/hub/unlink.ts ---------------------------------------------------
  {
    file: "src/hub/unlink.ts",
    match: "Re-link with a later push passing --project-id",
    klass: "future-only",
    why: "The unlink succeeded and removed the link; --project-id belongs to a LATER push, and there is nothing about THIS operation to re-run. It has to name the specific id because that is the whole reason the id is returned rather than discarded — the kept sync bookkeeping is only true for that one project.",
  },
  {
    file: "src/hub/unlink.ts",
    match: "or pass --force to unlink without waiting for it",
    klass: "retry-works",
    why: "The lock-busy refusal happened before anything was read or removed, so both remedies genuinely reach the same operation: waiting, or the same invocation plus --force. This is the one command where waiting may not be an option — a wedged push holds the lock for ten minutes and the point of unlinking is often that push.",
    provenBy: {
      test: "hub-unlink.test.ts",
      name: "refuses while the project lock is held, and --force unlinks anyway",
      reruns: "hubUnlink",
    },
  },
  {
    file: "src/hub/unlink.ts",
    match: "The project lock was skipped (--force)",
    klass: "descriptive",
    why: "Names the flag as the cause of an outcome the caller already chose. Nothing is being asked of the user beyond checking afterwards.",
  },
  // ---- src/hub/retire.ts + src/hub/tombstone.ts (#43) ----------------------
  {
    file: "src/hub/retire.ts",
    match: "or name the hub project with --project-id <id>",
    klass: "retry-works",
    why: "The unlinked refusal is the first thing either verb decides — before the hub is probed, before the project lock, before any read of the hub. The same invocation plus --project-id runs from the top, which is the whole reason the flag exists (an orphaned hub project has no local link to be run from).",
    provenBy: {
      test: "hub-retire.test.ts",
      name: "refuses an unlinked directory, and --project-id names the project on the re-run",
      reruns: "hubRetire",
    },
  },
  {
    file: "src/hub/retire.ts",
    match: "It can be withdrawn later, from this machine only",
    klass: "future-only",
    why: "The retire succeeded; there is nothing about THIS operation to re-run. --undo is a later, separate operation, and it is scoped that way in the sentence. Naming it here is the point of phase 1 being reversible at all — a user who has just retired a project needs to know the way back before the grace window makes the next step irreversible.",
  },
  {
    file: "src/hub/retire.ts",
    match: "Write a fresh assertion with `sesh-mover hub retire --undo`",
    klass: "future-only",
    why: "The unreadable-timestamp arm of the grace refusal. The delete refused and changed nothing, but the named remedy is not a re-run of the delete: it is two retire operations, and the delete only becomes possible a grace window LATER. Saying 'run this again' here would be the foreclosure defect in reverse — advice that appears to work now and cannot.",
  },
  {
    file: "src/hub/tombstone.ts",
    match: "to pull this once without retracting it",
    klass: "retry-works",
    why: "The retirement gate refuses in the pull's resolve stage, before registerMachine and before any link write, so nothing is applied or recorded for any bundle — the same pull with --ignore-retirement reaches all of it. Both remedies on the line are true for the same reason; --undo is the one available to the machine that made the assertion, which is the branch this sentence belongs to.",
    provenBy: {
      test: "hub-retire.test.ts",
      name: "refuses a pull of a retired project, and --ignore-retirement pulls it anyway",
      reruns: "hubPull",
    },
  },
  {
    file: "src/hub/tombstone.ts",
    match: "fetches it anyway — do that before",
    klass: "retry-works",
    why: "The same refusal, worded for a machine that did NOT assert the retirement and therefore cannot withdraw it. Retry-works for the same reason (the pull refused before doing anything), and this is the arm where it matters most: it is the only route this user has to work that is on the hub before the owner machine deletes it.",
    provenBy: {
      test: "hub-retire.test.ts",
      name: "refuses a pull of a retired project, and --ignore-retirement pulls it anyway",
      reruns: "hubPull",
    },
  },
  // ---- src/hub/preflight.ts (#75) ------------------------------------------
  //
  // These four lines were in `src/cli.ts` until #75 and so were outside this
  // sweep (see SWEEP_EXCLUDES). Moving the gate into a hub module — which is
  // what makes a library caller of hubPush/hubPull get the same refusal —
  // brought them in, unchanged in wording.
  {
    file: "src/hub/preflight.ts",
    match: "Pick one of the ",
    klass: "retry-works",
    why: "The whole point of the gate is that it decides before anything happens: no lock write, no link, no machine registration, no thread minted, no export. The same invocation with a corrected --project-id runs from the top.",
    provenBy: {
      test: "hub-pull-stages.test.ts",
      name: "refuses an unknown --project-id, then links and resolves with the right one",
      reruns: "runResolveStage",
    },
  },
  {
    file: "src/hub/preflight.ts",
    match: ", or pass --create-project to mint a new one.",
    klass: "retry-works",
    why: "Push's half of the same refusal, and reachable for the same reason — the refusal is before the export and before every hub write. --create-project is the answer when the pick list holds nothing the user wants.",
    provenBy: {
      test: "hub-push.test.ts",
      name: "refuses an unknown --project-id before any write, and --create-project then pushes",
      reruns: "hubPush",
    },
  },
  {
    file: "src/hub/preflight.ts",
    match: " — pass --create-project to mint one.",
    klass: "retry-works",
    why: "The same push remedy worded for an EMPTY hub, where there is no pick list to choose from and minting is the only move. Same branch, same 'nothing has happened yet' guarantee, so the same proof covers it.",
    provenBy: {
      test: "hub-push.test.ts",
      name: "refuses an unknown --project-id before any write, and --create-project then pushes",
      reruns: "hubPush",
    },
  },
  {
    file: "src/hub/preflight.ts",
    match: "hub.path names a directory this machine cannot see",
    klass: "descriptive",
    why: "A config-key line of exactly status.ts's shape, and for the same reason: hub.path is the SUBJECT — it names what is inconsistent, not something to change. Nothing is asked of the user beyond checking the mount, and the refusal happens before any read or write, so there is nothing for the foreclosure question to bite on.",
  },
  {
    file: "src/hub/preflight.ts",
    match: "so checking hub.path will not help",
    klass: "descriptive",
    why: "The THIRD arm of the same refusal (#71's `unresponsive`), and the only one that names hub.path in order to tell the user NOT to touch it: the mount is hung, so the path is almost certainly right and editing it is the wrong move. That makes it descriptive in the strongest sense the class has — the key is named as a thing explicitly ruled out as the remedy, not offered as one. Nothing is foreclosed either: the probe writes nothing, and the refusal happens before every hub write, so a retry once the mount is back runs from the top.",
  },
  {
    file: "src/hub/io-timeout.ts",
    match: "looks like a mount that has stopped responding",
    klass: "descriptive",
    why: "HubIoTimeoutError's own message, which reaches a user only on the paths that do NOT convert it into the typed `hub-unreachable` refusal — a mid-pull timeout, `hub init` on a hung share, reindex/status/whereis. Same judgement as preflight.ts's arms: hub.path is the SUBJECT of the sentence (this is what your configured hub is doing), not advice to change it. It also deliberately carries no path of its own, for the reason #75 stripped the ENOENT's: this string can land in an untyped ErrorResult, and the hub's absolute path is not something to volunteer there.",
  },
  {
    file: "src/hub/preflight.ts",
    match: "otherwise hub.path is set to a directory that is not a sesh-mover hub",
    klass: "descriptive",
    why: "The other arm of the same refusal, and the same judgement: the key is named as the state that explains the outcome. Deliberately not phrased as 'point hub.path at ...' — that would make it advice and put it back in front of the foreclosure question.",
  },
  // ---- everything else in src/hub/ -----------------------------------------
  {
    file: "src/hub/init.ts",
    match: "Point --path at an empty directory or a valid sesh-mover hub.",
    klass: "retry-works",
    why: "hub init wrote nothing; --path is the invocation's own argument.",
    provenBy: {
      test: "hub-init.test.ts",
      name: "refuses a directory it cannot use as a hub, and a re-run at a good --path succeeds",
      reruns: "hubInit",
    },
  },
  {
    file: "src/hub/reindex.ts",
    match: "Run push (with --create-project or --project-id)",
    klass: "retry-works",
    why: "reindex found no link and did nothing; the named push is a different command that has not been foreclosed. Names `push` explicitly, which is also what keeps it out of the cross-command check below — reindex does not declare either flag.",
    provenBy: {
      test: "hub-reindex.test.ts",
      name: "refuses an unlinked project, and reindex works once push has linked it",
      reruns: "hubReindex",
    },
  },
  {
    file: "src/hub/rekey.ts",
    match: "Run push (with --create-project or --project-id) to link and publish this project",
    klass: "retry-works",
    why: "rekey found no link and did nothing — the refusal is the first thing it decides, before the hub is probed, before the lock and before registerMachine. The named push is a different command that has not been foreclosed. Names `push` explicitly, which is also what keeps it out of the cross-command check below: rekey declares neither flag. Same shape and same reasoning as reindex's entry above.",
    provenBy: {
      test: "hub-rekey.test.ts",
      name: "refuses an unlinked project, and rekeys once a push with --create-project has linked it",
      reruns: "hubRekey",
    },
  },
  {
    file: "src/hub/merge.ts",
    match: "no-ancestor mode (unpack into an empty target, else skip unless --force-workspace)",
    klass: "descriptive",
    why: "A boundary assertion aimed at callers of the library, not a user-facing remedy.",
  },
  {
    file: "src/payload/carry.ts",
    match: "the pull did not ask for carried changes to be applied (--apply-carry)",
    klass: "descriptive",
    why: "Names the flag as the CAUSE of this decline. pull.ts turns it into advice, and that line is classified above.",
  },
  // `captureCarry`'s budget-disabled detail used to appear here. It now
  // interpolates `budgetKey(scope, "carry")`, because #47 gave the module a
  // SECOND key block (`export.carryMaxMb` beside `hub.carryMaxMb`) and a message
  // naming one of them was wrong for the other transport. Both spellings are
  // still literals, in `workspace.ts`'s `budgetKey`, which is what keeps them
  // greppable — and the sweep classifies a bare string literal as an argument
  // rather than as prose, which is exactly what they are there.
  // `src/hub/status.ts` used to carry an entry here for
  //   "hub.path is set (${hubPath}) but hub.json is missing — run hub init."
  // It is gone because the line is: `hub status` now pushes
  // `describeHubUnreachable(probe.state)` — the SAME sentence the push/pull
  // refusal carries, classified above under `src/hub/preflight.ts` — instead of
  // wording its own. Two things went with it, and both were defects rather than
  // prose: status and the gate no longer disagree about what "reachable" means,
  // and the `run hub init` remedy no longer fires for a hub directory that is
  // merely NOT MOUNTED, where following it mints a competing hub at the mount
  // point. status.ts names no flag or key of its own any more, so it has no
  // entry; its SURFACES row below stays, because the map is about which
  // commands COULD surface that file's messages.
  // ONE remedy sentence, two transports (`noPayloadRemedy`). #47 made this
  // module shared, so the sentence has to name a flag its reader's command
  // actually declares — and naming the command in it is also what satisfies the
  // cross-command check, since `--no-workspace` is push's and
  // `--include-workspace` is export's.
  {
    file: "src/payload/workspace.ts",
    match: "or drop --include-workspace from the next `sesh-mover export` if that is what you meant",
    klass: "future-only",
    why: "Both callers of this sentence (an empty snapshot, and a budget of 0) describe a capture that already happened and carried nothing. The remedy is about the NEXT export, and the wording says so.",
  },
  {
    file: "src/payload/workspace.ts",
    match: "or pass --no-workspace on a later `sesh-mover push` if that is what you meant",
    klass: "future-only",
    why: "Same sentence, push's spelling. The bundle is already written and recorded by the time either caller emits it, so the flag applies to a later push.",
  },
  // ---- src/importer.ts -----------------------------------------------------
  // The sharpest gap the widened sweep closed. `importSession` is called by
  // THREE commands (cli.ts's `import`, migrator.ts, pull-apply-sessions.ts),
  // and both migrate and pull re-emit its `warnings` verbatim and return its
  // ErrorResult (with its `suggestion`) unchanged. So every flag named here is
  // read by users of commands that do not declare it — see the cross-command
  // check below, which is what forced these lines to name `sesh-mover import`.
  {
    file: "src/importer.ts",
    match: "pass --session-id with their ids to `sesh-mover import`",
    klass: "retry-works",
    why: "The bundle-integrity refusal is before the dedup filters and before any write — the file says so, and the target config dir is byte-identical afterwards. Naming the command is not decoration: a `pull` surfaces this suggestion verbatim and `pull` has no --session-id.",
    provenBy: {
      test: "importer.test.ts",
      name: "refuses a bundle whose manifest declares an absent session, and --session-id imports the rest",
      reruns: "importSession",
    },
  },
  {
    file: "src/importer.ts",
    // The escaped backtick is real: the shipped string is a template literal,
    // so the source text carries `\`` where the message shows a backtick.
    match: "--no-register\\`; importing a registered copy",
    klass: "descriptive",
    why: "Names the flag as the cause of a PAST import, not as advice. It has to name the command because migrate and pull re-emit this warning and neither declares --no-register.",
  },
  {
    file: "src/importer.ts",
    match: "sesh-mover import --allow-duplicates",
    klass: "retry-works",
    why: "The duplicate skip records nothing new, so the named command genuinely re-imports. It is emitted verbatim by pull and migrate, and NEITHER declares --allow-duplicates — advising a bare flag here was a live instance of the defect this file exists for (issue #45), which is why the advice names the command that owns it rather than being withheld.",
    provenBy: {
      test: "importer.test.ts",
      name: "--allow-duplicates re-imports an already-present bundle",
      reruns: "importSession",
    },
  },
  {
    file: "src/importer.ts",
    // The escaped backticks are real: the shipped string is a template literal,
    // so the source text carries `\\``\`` where the message shows a backtick.
    match: "re-run with \\`sesh-mover import --include-plans\\`",
    klass: "retry-works",
    why: "The plans layer is opt-in on the receive side because <configDir>/plans is config-dir-GLOBAL, so applying it writes files every project on this machine shares. Nothing about the payload is consumed by declining it — the bundle still holds every plan — and the re-run applies them even when it is a fully-duplicate import, which is the branch that returns before the session write loop. Names the command because migrate and pull re-emit this warning verbatim and neither declares --include-plans.",
    provenBy: {
      test: "importer.test.ts",
      name: "does not write a bundle's plans by default, and --include-plans on the re-run lands them",
      reruns: "runImport",
    },
  },
  {
    file: "src/importer.ts",
    // The escaped backticks are real: the shipped string is a template literal,
    // so the source text carries `\`` where the message shows a backtick.
    match: "\\`sesh-mover import --no-memory\\` was passed",
    klass: "retry-works",
    why: "The memory layer is opt-OUT (#36) — the opposite default from plans, because it lands in the target project's own directory and is add-only. Declining consumes nothing: every file stays in the bundle, and the re-run reconciles the shared layers even when the sessions are now all duplicates, which is the branch that returns before the session write loop. Names the command because migrate and pull re-emit this warning verbatim and neither declares --no-memory (neither can reach it either — both leave noMemory unset — but the sweep's rule is about what a reader of the sentence can follow).",
    provenBy: {
      test: "importer.test.ts",
      name: "does not write a bundle's memory when --no-memory is passed, and the re-run without it lands them",
      reruns: "runImport",
    },
  },
  // The post-rewrite validation failure at src/importer.ts:~930 used to advise
  // `--no-register` and had an entry here reading `retry-works`. Writing the
  // proof test is what disproved it: the second run returns the IDENTICAL
  // object, because that branch never consults `noRegister`. The suggestion now
  // names no flag, so there is deliberately no entry for it — the sweep will
  // ask for one again the moment a flag comes back.
  // ---- src/importer.ts, the file payload (#47) -----------------------------
  // The ONLY messages in importer.ts that `migrate` and `pull` never surface:
  // both call `importSession` without `filePayload`, so the whole block that
  // emits them is unreachable for them. They name `sesh-mover import` anyway,
  // because the SURFACES map is per FILE and the cross-command check reads it
  // that way — and because being explicit survives a future caller.
  {
    file: "src/importer.ts",
    match: "sesh-mover import --apply-workspace\\` was not passed",
    klass: "retry-works",
    why: "Nothing was written and nothing was consumed by declining: the payload is still in the bundle, which is a file the user has. The re-run genuinely reaches it even when every session is a duplicate by then, because the fully-duplicate branch of importSession reconciles the file payload too — the same reachability #53 established for the memory layer.",
    provenBy: {
      test: "importer.test.ts",
      name: "lands a declined workspace payload on a re-run, when every session is already a duplicate",
      // The local `runImport` wrapper, which is `importSession` plus this
      // suite's fixed target — counting the wrapper is what makes the proof
      // legible in a test that would otherwise repeat six arguments twice.
      reruns: "runImport",
    },
  },
  {
    file: "src/importer.ts",
    match: "sesh-mover import --apply-carry\\` was not passed",
    klass: "retry-works",
    why: "Same argument as the workspace line above, and it is why this path deliberately does NOT save the payload the way a pull's decline does: a pull records its bundles as received and deletes its extraction directory, so its re-run is foreclosed and parking is the only remedy left. An import's bundle is a file the user still has.",
    provenBy: {
      test: "importer.test.ts",
      name: "applies a declined carry payload on a re-run, when every session is already a duplicate",
      reruns: "importSession",
    },
  },
  {
    file: "src/importer.ts",
    match: "This import unpacked the workspace payload over the existing directory",
    klass: "descriptive",
    why: "Names the flag as the CAUSE of what just happened, not as advice. It is the disclosure that a bootstrap unpack over an occupied directory replaced files, which is the one thing --force-workspace buys.",
  },
  {
    file: "src/importer.ts",
    match: "Re-run this import against an empty directory with --target-project-path <dir>",
    klass: "retry-works",
    why: "The emptiness check is a PRECONDITION: it runs before the session write loop and before any shared-layer write, so the target config dir and the project directory are both byte-identical afterwards. All three remedies it names — a different destination, --force-workspace, or dropping --apply-workspace — are reached by re-running the same invocation.",
    provenBy: {
      test: "importer.test.ts",
      name: "refuses a non-empty workspace target before writing anything, and --force-workspace then unpacks over it",
      reruns: "runImport",
    },
  },
  // ---- src/migrator.ts -----------------------------------------------------
  {
    file: "src/migrator.ts",
    match: "--rename-dir was requested, but the source and target project paths are identical",
    klass: "descriptive",
    why: "A dry-run note naming the flag the caller already passed, as the cause of a no-op. Nothing is asked of the user.",
  },
  {
    file: "src/migrator.ts",
    match: "It will cease to exist after --rename-dir is applied.",
    klass: "descriptive",
    why: "The self-migration warning restating what the flag the caller already passed will do.",
  },
  {
    file: "src/migrator.ts",
    match: "Override (unsafe): pass --force",
    klass: "retry-works",
    why: "The self-migration block returns before export, import or any delete — migrate is export+import+cleanup and none of it has run — so the same invocation plus --force reaches the migration. That it is UNSAFE is a separate matter from whether it is reachable; the message says so.",
    provenBy: {
      test: "migrator.test.ts",
      name: "blocks self-migration by default, and --force overrides the block",
      reruns: "migrateSession",
    },
  },
  {
    file: "src/migrator.ts",
    match: "Migrate with --scope current requires --session-id",
    klass: "descriptive",
    why: "States the argument rule that was violated. The remedy is the next line, which is classified separately.",
  },
  {
    file: "src/migrator.ts",
    match: "Pass --session-id <id> to move one session, or --scope all",
    klass: "retry-works",
    why: "Argument validation, before any read or write; the same invocation with either flag runs from the top.",
    provenBy: {
      test: "migrator.test.ts",
      name: "requires --session-id for scope current, and migrates once it is supplied",
      reruns: "migrateSession",
    },
  },

  // ---- encryption at rest (src/hub/encryption.ts, src/hub/pull-fetch.ts) ----
  {
    file: "src/hub/encryption.ts",
    match: "Seal the hub with `sesh-mover hub encrypt --enable`",
    klass: "future-only",
    why: "Emitted on a SUCCESSFUL push whose bundle has already reached the hub as plaintext. Sealing the hub cannot un-send it — nothing ever rewrites a bundle in place — so the flag applies strictly to later pushes, and the sentence scopes it that way. It names `encrypt` because --enable is that command's flag, not push's.",
  },
  {
    file: "src/hub/encryption.ts",
    match: "re-run with --force-unkeyed",
    klass: "retry-works",
    why: "The refusal is taken immediately after the preflight and before the export, the hub-side project, the bundle and the local link — nothing is exported, uploaded or recorded — so the same invocation plus the flag runs from the top and reaches the upload. That the upload then permanently excludes a machine is a separate matter from whether it is reachable; the sentence says so.",
    provenBy: {
      test: "hub-encryption-wiring.test.ts",
      name: "refuses to push into a sealed hub when a registered machine publishes no key, and --force-unkeyed uploads anyway",
      reruns: "hubPush",
    },
  },
  {
    file: "src/hub/encryption.ts",
    match: "--force-unkeyed: this bundle was encrypted WITHOUT",
    klass: "descriptive",
    why: "Names the flag as the cause of an outcome the caller explicitly chose, on a push that succeeded. Nothing is being asked; the sentence exists so the permanence of the exclusion is on the record.",
  },
  {
    file: "src/hub/encrypt.ts",
    match: "local hub.encrypt preference could not be recorded",
    klass: "descriptive",
    why: "Reports an outcome of the run that just happened — the hub-wide switch landed, the local preference file did not — on a command that SUCCEEDED. `configure --show` is named as the thing that would report the stale value, not as a remedy to apply, and the key is the subject of the sentence rather than something the user is told to set. It names `configure` because --show is that command's flag, not this one's.",
  },
  {
    file: "src/hub/pull-fetch.ts",
    match: "re-send the thread whole with `sesh-mover push --full`",
    klass: "future-only",
    why: "This bundle is foreclosed for this machine in the strongest sense available: an encrypted bundle is never re-wrapped, so no pull ever reaches it. The remedy is a different command on a different machine producing a NEW bundle, which a later pull finds — which is exactly what the sentence scopes it to. It names `push` because --full is that command's flag, not pull's.",
  },
];

const ROOT = join(import.meta.dirname, "..");

/** Flags the CLI actually declares — the mechanical source of truth. */
function declaredFlags(): string[] {
  const cli = readFileSync(join(ROOT, "src", "cli.ts"), "utf-8");
  return [...new Set(cli.match(/"--[a-z][a-z-]*/g) ?? [])].map((m) => m.slice(1));
}

/**
 * Which flags each CLI command declares.
 *
 * Derived the same way `declaredFlags` is, and for the same reason: a hand-kept
 * copy is how a message ends up advising a flag that was moved to another
 * command. Sub-commands are keyed by their own name (`init`, `push`, …) — the
 * `hub` prefix is not part of what Commander matches an option against.
 */
function flagsByCommand(): Map<string, Set<string>> {
  // Scanned over the whole file, not line by line: prettier wraps a long
  // `.option(` so the flag lands on the NEXT line, and a per-line scan silently
  // dropped `--force-workspace` from `pull` — which reads exactly like the
  // violation this map exists to detect.
  const src = readFileSync(join(ROOT, "src", "cli.ts"), "utf-8");
  const re = /\.command\("([a-z][a-z-]*)"\)|\.(?:option|requiredOption)\(\s*"(--[a-z][a-z-]*)/g;
  const out = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) {
      current = m[1];
      if (!out.has(current)) out.set(current, new Set());
    } else if (current) {
      out.get(current)!.add(m[2]);
    }
  }
  return out;
}

/**
 * Config keys, derived from `getDefaultConfig()` — the same source `configure
 * --set` validates against (`assertKnownConfigPath` calls the defaults "the
 * schema"). A remedy phrased as `hub.onDivergence=skip` is exactly as
 * foreclosable as one phrased as `--on-divergence skip`, and a flag-name
 * matcher cannot see it; that gap is why pull.ts's fragment message went
 * unclassified for its config half.
 */
function configKeys(): string[] {
  const walk = (obj: Record<string, unknown>, prefix: string): string[] =>
    Object.entries(obj).flatMap(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === "object" && !Array.isArray(v)
        ? walk(v as Record<string, unknown>, path)
        : [path];
    });
  return walk(getDefaultConfig() as unknown as Record<string, unknown>, "");
}

/**
 * The one file under `src/` this sweep skips, and why — stated here rather than
 * left as a silent gap.
 *
 * `src/cli.ts` is where the flags are DECLARED; `declaredFlags()` reads it, so
 * it is the sweep's own source of truth. Its messages are also a different
 * animal: with one exception they are argument validation raised while Commander
 * parses options, BEFORE the command's `.action` does any work at all, so there
 * is no recorded state for them to foreclose — which is the whole defect this
 * file exists for.
 *
 * The exception is real and is a known hole: cli.ts renders push's
 * orphaned-hub-project note ("a later push can pass --project-id …"). It is a
 * verbatim twin of `src/hub/push.ts`'s "on a later push to link to that one
 * instead of minting a second", which IS classified below (future-only), so the
 * judgement exists — it is only the mechanical pin that stops at the file
 * boundary. If cli.ts is ever brought into the sweep, its "No hub configured.
 * Run: sesh-mover hub init --path <dir>" and "Run a full export to this peer
 * first, or use --since <path>" are the two lines that will need `provenBy`
 * tests in tests/cli.test.ts.
 */
const SWEEP_EXCLUDES = new Set(["src/cli.ts"]);

/** Every `.ts` under src/, repo-relative, `/`-separated, sorted. */
function srcFiles(): string[] {
  const walk = (rel: string): string[] =>
    readdirSync(join(ROOT, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) =>
        e.isDirectory()
          ? walk(`${rel}/${e.name}`)
          : e.name.endsWith(".ts")
            ? [`${rel}/${e.name}`]
            : []
      );
  return walk("src").filter((f) => !SWEEP_EXCLUDES.has(f));
}

interface MessageLine {
  file: string;
  line: number;
  text: string;
  /** Flags named on this line. */
  flags: string[];
  /** Config keys named on this line. */
  keys: string[];
}

/**
 * Escape EVERY regex metacharacter, not the one this guard's current inputs
 * happen to contain.
 *
 * The three dynamic regexes below interpolate values derived from live source —
 * flag names from `cli.ts`'s `.option(` declarations, config keys from
 * `getDefaultConfig()`, command names from the Commander tree. Earlier versions
 * escaped only `-` (flags) and `.` (keys), which is correct for today's inputs
 * and silently wrong for the first one that carries a `$`, `(`, `?` or `\`: the
 * derived pattern changes meaning or throws, and a guard that mis-derives its
 * own pattern reports "no violations" for a reason that has nothing to do with
 * the code it is auditing. That failure mode is not hypothetical here — a
 * line-by-line scan in this same file already missed a prettier-wrapped
 * `.option(` and reported five false violations.
 *
 * CodeQL flags the partial form as `js/incomplete-sanitization`; it is right,
 * and the fix is completeness rather than adding whichever character it named.
 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * Every non-comment line under `src/` that names a declared flag or a config
 * key. The sweep used to stop at `src/hub/`, which is how `src/importer.ts` —
 * whose warnings THREE commands re-emit verbatim — stayed outside it.
 *
 * Three things are deliberately not messages, and each removes a whole class of
 * noise rather than one line:
 *
 * - **A bare string literal that is nothing but the token** (`"--version"`,
 *   `"hub.path"`) is an argument, not prose: an argv element for a child
 *   process (`zstd --version`), or a key name passed to `setConfigOverride`.
 * - **A Commander declaration line** is where the flags come FROM.
 * - **A trailing `//` comment**, when no quote precedes it on the line, is a
 *   comment like any other — comments carry the reasoning ABOUT these messages.
 *   The conservative half matters: if a quote does precede the `//`, nothing is
 *   stripped, because that `//` may be inside the message.
 */
function messageLines(): MessageLine[] {
  const flagRe = new RegExp(
    declaredFlags().map((f) => `${escapeRe(f)}(?![-\\w])`).join("|"),
    "g"
  );
  const keyRe = new RegExp(
    `(?<![\\w.$])(?:${configKeys().map(escapeRe).join("|")})(?![\\w.])`,
    "g"
  );
  const out: MessageLine[] = [];
  for (const file of srcFiles()) {
    for (const [i, raw] of readFileSync(join(ROOT, file), "utf-8").split("\n").entries()) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (/\.(?:option|requiredOption|argument|alias)\(/.test(trimmed)) continue;
      const text = /^[^"'`]*\/\//.test(raw) ? raw.slice(0, raw.indexOf("//")) : raw;

      const isBareLiteral = (at: number, token: string): boolean =>
        /["']/.test(text.slice(Math.max(0, at - 1), at)) &&
        text.slice(at - 1, at) === text.slice(at + token.length, at + token.length + 1);

      const flags = [...text.matchAll(flagRe)]
        .filter((m) => !isBareLiteral(m.index, m[0]))
        .map((m) => m[0]);
      const keys = [...text.matchAll(keyRe)]
        .filter((m) => !isBareLiteral(m.index, m[0]))
        .map((m) => m[0]);
      if (flags.length || keys.length) {
        out.push({ file, line: i + 1, text, flags: [...new Set(flags)], keys: [...new Set(keys)] });
      }
    }
  }
  return out;
}

/**
 * Which CLI commands can surface a source file's messages.
 *
 * The point of this map is `src/importer.ts`: three commands call
 * `importSession`, and both `migrate` (migrator.ts: `...imported.warnings`) and
 * `pull` (pull-apply-sessions.ts: `reasons.push(...importResult.warnings)`, and
 * `{ kind: "fail", result: importResult }` for its ErrorResult) re-emit what it
 * says WORD FOR WORD. A flag named there is read by a user running a command
 * that never declared it.
 *
 * What this does NOT derive is the map itself: a file that starts calling
 * `importSession` tomorrow adds a surface nobody records here. The completeness
 * assertion below catches a new FILE, not a new CALLER.
 */
const SURFACES: Record<string, string[]> = {
  "src/importer.ts": ["import", "migrate", "pull"],
  "src/migrator.ts": ["migrate"],
  // Both halves of this module now have two commands each: `captureCarry` is
  // reached by `hub push` and by `sesh-mover export` (#47), `applyCarry` by
  // `hub pull` and by `sesh-mover import`.
  "src/payload/carry.ts": ["push", "pull", "export", "import"],
  "src/payload/capture.ts": ["push", "export"],
  "src/hub/init.ts": ["init"],
  // The widest surface in the map, and it is not hedging: `HubIoTimeoutError`
  // is thrown from inside `HubBackend`, which every hub verb constructs, and
  // only push converts it to a typed refusal. Everywhere else it escapes as the
  // message of an ErrorResult. `unlink` is absent because it builds no backend
  // at all — the disarm path must not depend on the thing being disarmed.
  "src/hub/io-timeout.ts": ["push", "pull", "init", "reindex", "status", "whereis"],
  "src/hub/merge.ts": ["pull"],
  "src/hub/pull-apply-carry.ts": ["pull"],
  "src/hub/pull-apply-sessions.ts": ["pull"],
  "src/hub/pull-apply-workspace.ts": ["pull"],
  "src/hub/pull-fetch.ts": ["pull"],
  "src/hub/pull-resolve.ts": ["pull"],
  // The one file BOTH verbs surface verbatim: `preflightHub` is called by
  // `hub/push.ts` and `hub/pull-resolve.ts` alike, so a flag named here is read
  // by a user running either. `--create-project` is push's, which is why both
  // lines that name it also say "push".
  "src/hub/preflight.ts": ["push", "pull"],
  // `planBundleEncryption` is a pure decision function whose sentences are
  // returned to `hub/push.ts` and surfaced as that verb's refusal or warnings.
  // `hub rekey` surfaces the OTHER half of the module — `checkSelfIsRecipient`,
  // the self/no-recipient check the two verbs share — so its refusals are read
  // by a user running either. Still nothing on the READ path: a reader branches
  // on the bundle file's suffix and consults this module not at all, which is
  // the property `bundle-io.ts` exists to keep, so a `pull` here would be a
  // sign that it had been lost.
  "src/hub/encryption.ts": ["push", "rekey"],
  // `hub encrypt`'s own verb, keyed by the sub-command name the CLI declares
  // (`.command("encrypt")`), not by "hub encrypt".
  "src/hub/encrypt.ts": ["encrypt"],
  "src/hub/push.ts": ["push"],
  "src/hub/reindex.ts": ["reindex"],
  "src/hub/rekey.ts": ["rekey"],
  // Retirement's two verbs share one module, so a flag named there is read by a
  // user running either — which is why the `--project-id` line has to work for
  // both (it does; both declare it) and the `--undo` lines name `retire`
  // explicitly, since `delete` has no such flag.
  "src/hub/retire.ts": ["retire", "delete"],
  // `retiredPullRefusal` is built in tombstone.ts and returned by the pull's
  // resolve stage. Only `pull` ever surfaces it — `hub retire`'s own results are
  // composed in retire.ts.
  "src/hub/tombstone.ts": ["pull"],
  "src/hub/status.ts": ["status"],
  "src/hub/unlink.ts": ["unlink"],
  // `snapshotWorkspace` is reached by push and export; `unpackWorkspace` by pull
  // and import. One module, four surfaces.
  "src/payload/workspace.ts": ["push", "export", "pull", "import"],
};

/**
 * The docs the model actually reads: every slash-command doc, the skill doc and
 * the README.
 *
 * These are NOT swept for registry entries, and that is a judgement rather than
 * an omission: a reference doc names every flag of its command by definition, so
 * a per-line registry over them would be one entry per documented flag and would
 * carry no signal. What they ARE checked for is a claim about a flag's MEANING,
 * which does more damage here than in a warning string — the fifth instance of
 * the "--force-workspace merges" defect shipped in commands/pull.md's
 * AskUserQuestion label.
 */
function docLines(): Array<{ file: string; line: number; text: string }> {
  const files = [
    ...readdirSync(join(ROOT, "commands"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join("commands", f)),
    "README.md",
    join("skills", "session-porter", "SKILL.md"),
  ];
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const rel of files) {
    for (const [i, text] of readFileSync(join(ROOT, rel), "utf-8").split("\n").entries()) {
      out.push({ file: rel, line: i + 1, text });
    }
  }
  return out;
}

/**
 * The body of one `it(...)` in a test file, or `null` if the title is not there.
 *
 * Delimited by indentation rather than by paren matching: this repo is
 * uniformly formatted, so an `it(` opened at column n closes on the first later
 * line whose content starts at column n with `}`. A paren matcher would have to
 * understand template literals, and every test in this suite is full of them.
 */
function testBody(file: string, title: string): string | null {
  const path = join(ROOT, "tests", file);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split("\n");
  const quoted = [`"${title}"`, `'${title}'`, `\`${title}\``];
  for (const [i, text] of lines.entries()) {
    if (!quoted.some((q) => text.includes(q))) continue;
    // Walk back to the `it(` / `test(` that opened this call (the title may sit
    // on its own line when prettier wrapped it).
    let open = i;
    while (open >= 0 && !/\b(?:it|test)(?:\.\w+)?\(/.test(lines[open])) open--;
    if (open < 0) continue;
    const indent = lines[open].length - lines[open].trimStart().length;
    for (let end = open + 1; end < lines.length; end++) {
      const l = lines[end];
      if (l.length - l.trimStart().length === indent && l.trimStart().startsWith("}")) {
        return lines.slice(open, end + 1).join("\n");
      }
    }
  }
  return null;
}

/** `--force-append` -> `forceAppend`; how a flag reads at the API boundary. */
function camel(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe("every shipped message naming a CLI flag or config key is classified", () => {
  it("has a registry entry for each one", () => {
    const unclassified = messageLines()
      .filter((l) => !REGISTRY.some((r) => r.file === l.file && l.text.includes(r.match)))
      .map(
        (l) =>
          `${l.file}:${l.line} (${[...l.flags, ...l.keys].join(", ")}) ${l.text.trim().slice(0, 120)}`
      );
    expect(
      unclassified,
      "A message under src/ names a CLI flag or a config key and is not classified in tests/hub-warning-flags.test.ts.\n" +
        "Decide, for the branch that emits it: does the next invocation with that flag actually reach this item, " +
        "or has this run already recorded it? Then add an entry (retry-works / future-only / descriptive)."
    ).toEqual([]);
  });

  it("has no stale registry entries", () => {
    const lines = messageLines();
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
    for (const line of messageLines()) {
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
    const lines = messageLines();
    const unscoped = REGISTRY.filter((r) => r.klass === "future-only").filter((r) => {
      const line = lines.find((l) => l.file === r.file && l.text.includes(r.match));
      return !line || !SCOPING.test(line.text);
    });
    expect(
      unscoped.map((r) => `${r.file}: ${r.match}`),
      "A future-only remedy must say so in the message itself, or the user reads it as something to do now."
    ).toEqual([]);
  });

  it("keeps a descriptive line from being phrased as advice", () => {
    // `descriptive` means the flag is named as a cause or as an argument the
    // caller already passed. An imperative verb standing directly in front of
    // the flag is what turns it into a remedy — and a remedy has to answer the
    // foreclosure question, i.e. be retry-works or future-only instead.
    const ADVICE = /\b(?:pass|use|try|run|set|point)\b(?:\s+\S+){0,3}\s+(--[a-z][a-z-]*|[a-z]+\.[a-zA-Z]+)/i;
    const offenders: string[] = [];
    for (const line of messageLines()) {
      const entry = REGISTRY.find((r) => r.file === line.file && line.text.includes(r.match));
      if (!entry || entry.klass !== "descriptive") continue;
      const m = ADVICE.exec(line.text);
      if (m && (line.flags.includes(m[1]) || line.keys.includes(m[1]))) {
        offenders.push(`${line.file}:${line.line} is descriptive but reads as advice: "${m[0]}"`);
      }
    }
    expect(
      offenders,
      "A descriptive entry may name a flag as a cause, not tell the user to pass it. " +
        "If it is advice, reclassify it as retry-works or future-only and answer the foreclosure question."
    ).toEqual([]);
  });

  it("proves every retry-works claim with a test that actually re-runs", () => {
    // THE point of this file's rework (#45). "Re-running reaches this item" was
    // a human assertion in a `why:` string that nothing executed; seven of the
    // nine foreclosures were exactly that assertion being wrong. An entry now
    // has to name a test, and the test has to invoke the operation twice.
    const lines = messageLines();
    const problems: string[] = [];
    for (const r of REGISTRY) {
      if (r.klass !== "retry-works") {
        if (r.provenBy) problems.push(`${r.file}: ${r.match} — only retry-works entries take provenBy`);
        continue;
      }
      if (!r.provenBy) {
        problems.push(`${r.file}: ${r.match} — retry-works with no provenBy`);
        continue;
      }
      const { test, name, reruns } = r.provenBy;
      const body = testBody(test, name);
      if (body === null) {
        problems.push(`${r.file}: ${r.match} — tests/${test} has no it(${JSON.stringify(name)})`);
        continue;
      }
      const calls = body.split(`${reruns}(`).length - 1;
      if (calls < 2) {
        problems.push(
          `${r.file}: ${r.match} — tests/${test} "${name}" calls ${reruns}() ${calls}x, needs >= 2 (the retry IS the proof)`
        );
      }
      if (!body.includes("expect(")) {
        problems.push(`${r.file}: ${r.match} — tests/${test} "${name}" asserts nothing`);
      }
      // The re-run has to pass the flag the message advised, or it proves a
      // different retry than the one the user was told to run.
      const line = lines.find((l) => l.file === r.file && l.text.includes(r.match));
      const advised = [...(line?.flags ?? []), ...(line?.keys ?? [])];
      if (
        advised.length > 0 &&
        !advised.some((f) => body.includes(f) || body.includes(camel(f)))
      ) {
        problems.push(
          `${r.file}: ${r.match} — tests/${test} "${name}" never mentions ${advised.join("/")}, so the retry it performs is not the advised one`
        );
      }
    }
    expect(
      problems,
      "A retry-works entry claims a re-run reaches the item. Name a test that performs that re-run:\n" +
        "  provenBy: { test: \"<file under tests/>\", name: \"<exact it() title>\", reruns: \"<fn called twice>\" }"
    ).toEqual([]);
  });

  it("never advises a flag the command surfacing the message does not accept", () => {
    // Issue #45's sharpest gap. importer.ts's warnings and ErrorResults are
    // re-emitted verbatim by migrate and pull, so a bare `--allow-duplicates`
    // there is advice a pull cannot follow — the flag exists only on `import`.
    // A message may still name such a flag: it just has to say whose it is.
    const byCommand = flagsByCommand();
    const lines = messageLines();
    const missingSurface = [
      ...new Set(lines.map((l) => l.file).filter((f) => !(f in SURFACES))),
    ];
    expect(
      missingSurface,
      "A file under src/ emits a message naming a flag and has no SURFACES entry — say which commands can surface it."
    ).toEqual([]);

    const unknownCommand = Object.entries(SURFACES).flatMap(([file, cmds]) =>
      cmds.filter((c) => !byCommand.has(c)).map((c) => `${file}: "${c}" is not a CLI command`)
    );
    expect(unknownCommand).toEqual([]);

    const offenders: string[] = [];
    for (const line of lines) {
      const surfaces = SURFACES[line.file] ?? [];
      for (const flag of line.flags) {
        const declaring = [...byCommand].filter(([, fs]) => fs.has(flag)).map(([c]) => c);
        const missing = surfaces.filter((c) => !byCommand.get(c)!.has(flag));
        if (missing.length === 0) continue;
        // Naming the owning command makes the advice followable from anywhere.
        // This is a word-presence test, not a grammatical one: a line that says
        // "this push carries no project files" satisfies it for a push-only
        // flag without the two being in the same clause. Measured on the
        // current tree that is always true anyway (workspace.ts's two budget
        // lines are the case), and the strict alternative — requiring the
        // command adjacent to the flag — rejects them wrongly.
        if (declaring.some((c) => new RegExp(`\\b${escapeRe(c)}\\b`).test(line.text))) continue;
        offenders.push(
          `${line.file}:${line.line} names ${flag}, but ${missing.join("/")} do${missing.length > 1 ? "" : "es"} not declare it (only ${declaring.join("/") || "no command"} does)`
        );
      }
    }
    expect(
      offenders,
      "A message names a flag that one of the commands surfacing it does not accept. " +
        "Either the flag is wrong, or the message has to name the command that owns it (e.g. `sesh-mover import --allow-duplicates`)."
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
    const entry = execFileSync("git", ["ls-files", "-s", "dist/cli.js"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    expect(entry.split(" ")[0]).toBe("100755");
  });

  it("never describes --force-workspace as a merge", () => {
    // Critical 3: four shipped strings called an overwrite a "merge", including
    // one emitted at the exact point chooseMergeAncestor had ruled a merge out.
    // The flag skips the 3-way merge by definition — it means "give me the
    // hub's copy wholesale".
    //
    // The FIFTH instance hid in commands/pull.md's AskUserQuestion label, which
    // this guard could not see while it read src/hub/ only — so the sweep now
    // covers the docs too. That needs tuning, because a markdown "line" is a
    // whole paragraph and the flag legitimately appears next to the word merge
    // all over them ("--force-workspace overrides the 3-way merge", "overwrite,
    // not merge", "it is not a merge and never becomes one") — all of which
    // must pass, so a bare co-occurrence is not the test. Two shapes are:
    //   1. a merge/combine verb reaching a TARGET within the same clause —
    //      "merge into the existing tree", "merge the hub copy into your
    //      current files" (the AskUserQuestion shape that got through),
    //      "combines with your local files";
    //   2. the original src/ pattern kept verbatim: a bare "merge into" /
    //      "merging into" in the same sentence as the flag (no `.` between).
    // The bounded gap is what admits an object between the verb and its
    // preposition without letting the match wander into the next clause. It
    // reads the CLAIM's shape, not its polarity, so a negation spelled "does
    // not merge it into your tree" would trip it — negate the way this file's
    // subjects already do ("it is not a merge") and that never comes up.
    const MERGEY = [
      /\bmerg(?:e|es|ed|ing)\b[^.]{0,30}?\b(?:into|with)\s+(?:the\s+)?(?:existing|current|local|your)\b/i,
      /\bcombine(?:s|d)?\b[^.]{0,30}?\bwith\s+(?:the\s+)?(?:existing|current|local|your)\b/i,
      /--force-workspace[^.]{0,120}?\bmerg(e|ing) (into|it into|the existing)\b|\bmerge into the existing\b/i,
    ];
    const offenders = [
      ...messageLines().map((l) => ({ file: l.file, line: l.line, text: l.text })),
      ...docLines(),
    ]
      .filter((l) => l.text.includes("--force-workspace") && MERGEY.some((r) => r.test(l.text)))
      .map((l) => `${l.file}:${l.line}`);
    expect(
      offenders,
      "--force-workspace OVERWRITES on collision — it is not a merge into the existing tree. " +
        "Reword the line, or tighten MERGEY if this is a false positive."
    ).toEqual([]);
  });
});
