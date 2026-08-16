import { applyCarry, type ApplyResult, type CarryMeta } from "./carry.js";
import { isCarrySuppressed, type PulledCarry } from "./pull-apply-state.js";
import { isReadableDir } from "./fs-probe.js";
import { stageOk, stageSkip, type StageOutcome } from "./pull-stages.js";

/**
 * Exactly the three apply-loop fields this stage reads — a structural subset of
 * `ApplyState`, so the call site is `apply: st` and nothing here depends on the
 * other twenty accumulators.
 *
 * `deferredBundles` is deliberately ABSENT. It belongs to the divergence-abort
 * disclosure, which is a *sessions* statement (its first clause fires with no
 * carry present at all) and stays out of this module.
 */
export interface CarryApplyView {
  readonly lastCarry: PulledCarry | null;
  readonly divergenceAborted: boolean;
  readonly abortIndex: number;
}

export interface ApplyCarryStageInput {
  /**
   * Where the project lives on THIS machine: the pull's `effectiveProjectPath`
   * (`--target-path` if given, else the project path), never the raw
   * `projectPath`. It decides both where a payload is applied and where a
   * declined one is saved, so the two must not disagree.
   */
  targetPath: string;
  /** Did the invocation ask for carried changes to be applied? See the doc below. */
  applyRequested: boolean;
  readonly apply: CarryApplyView;
}

export interface ApplyCarryStageResult {
  /**
   * The payload the bundle DECLARED, identity and never a copy. Present even
   * when `carryApplied` is not: a bundle that declares a carry it does not
   * contain still reports what it claimed.
   */
  carryAvailable: CarryMeta;
  /** What became of it, or `undefined` when the bundle held nothing to act on. */
  carryApplied: ApplyResult | undefined;
}

/**
 * What happened to a carried payload, in sentences a user can act on.
 *
 * Every branch here has to be honest about ONE fact that shapes all of them:
 * this pull records its bundles as received before it returns, so re-running it
 * — with or without `--apply-carry` — answers "Already up to date" and never
 * offers this payload again. Naming that re-run as a remedy is the foreclosure
 * this milestone keeps producing, so no branch below names it. What is named
 * instead is the saved directory, which is a copy the user already has.
 */
function describeCarryApply(
  result: ApplyResult,
  meta: CarryMeta,
  bundleFile: string
): string[] {
  const out: string[] = [];
  const origin = `branch ${meta.branch} at commit ${meta.baseCommit.slice(0, 8)}`;
  if (!result.applied) {
    const lost =
      `The uncommitted changes this pull carried (${origin}) were not applied: ${result.detail}. ` +
      (result.savedTo === null
        ? `They could not be saved beside the project either, so the only remaining copy is inside ${bundleFile} on the hub — extract that archive by hand to recover them.`
        : `The whole payload — patch, untracked files and a README ${
            // Two declines withhold the commands on purpose (a refused payload,
            // and a patch git could not parse here), so promising them on every
            // decline sends the user looking for something that is not there.
            result.savedCommands
              ? "with the exact commands"
              : "explaining what was found and what was withheld"
          } — is saved at ${result.savedTo}. Nothing was written to your working tree.`);
    out.push(
      result.reason === "not-requested"
        ? lost + " Pass --apply-carry on a future pull to have them applied straight into the tree instead."
        : lost
    );
    if (result.refused.length > 0) {
      // The saved copy is the ONLY remedy on every decline, and its README
      // tells the user to `cp -R '<saved>/untracked/.' .` — which copies
      // dot-entries. So the floor runs on the save too, and what it dropped has
      // to be said here as well as in that README: the user reads this first.
      out.push(
        `${result.refused.length} path(s) in that payload were left out of the saved copy because they name plugin or VCS internals that never travel (${result.refused.slice(0, 5).join(", ")}). They are not in the saved directory, so the commands in its README cannot write them here. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`
      );
    }
    if (result.reason === "unsafe-payload") {
      // The same disclosure `workspaceRefused` carries, and the same rule: do
      // not accuse the sender. An older sesh-mover, on a case-insensitive
      // filesystem, legitimately produced payloads this guard now refuses.
      out.push(
        "That payload tried to write paths that never travel (plugin or VCS internals such as .sesh-mover-include, which decides what this machine's NEXT push uploads), or to create a symbolic link, or it described its own changes in a way git's output could not be read back unambiguously. It was refused whole rather than partly applied. Read the saved copy before doing anything with it."
      );
    }
    return out;
  }
  out.push(
    `Applied the uncommitted changes this pull carried (${origin}): ${result.filesChanged} file(s) from the patch, ${result.untrackedCopied} untracked file(s) copied. They are uncommitted here too — \`git status\` shows them, and \`git checkout -- .\` undoes the patch half.`
  );
  if (meta.inProgress) {
    out.push(
      `Those changes were captured during an in-progress ${meta.inProgress} on the other machine, so the patch contained conflict markers as ordinary file content and the ${meta.inProgress} itself did not travel — search for <<<<<<< before working on them.`
    );
  }
  if (result.collisions.length > 0) {
    out.push(
      `${result.collisions.length} carried file(s) already existed here with different content, so yours were left alone and the incoming copies were written beside them as *.incoming-*: ${result.collisions.slice(0, 5).join(", ")}. Reconcile and delete the sidecars — they are untracked files, so a later push would carry them too.`
    );
  }
  if (result.refused.length > 0) {
    out.push(
      `${result.refused.length} carried file(s) were refused because they name plugin or VCS internals that never travel (${result.refused.slice(0, 5).join(", ")}). Nothing from them was written. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`
    );
  }
  if (result.blocked.length > 0) {
    out.push(
      `${result.blocked.length} carried file(s) were not written because of what already occupies their path here (${[...new Set(result.blocked.map((b) => b.reason))].join(", ")}): ${result.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them.`
    );
  }
  return out;
}

/**
 * Deliver the newest carried payload in the chain — by applying it, or by
 * SAVING it.
 *
 * **`applyRequested: false` does not mean skip. It means save.** The
 * not-requested path runs the whole stage and reaches `applyCarry` with
 * `saveOnly: true`, which parks patch, untracked tree, `carry.json` and a
 * README under the project before declining. Short-circuiting to a skip before
 * that call destroys another machine's uncommitted work permanently: by the
 * time this stage runs the pull has already recorded its bundles as received,
 * so a re-run — with or without the flag — answers "Already up to date", and
 * `hubPull`'s `finally` deletes the extraction directory the payload was read
 * from. There is no second chance to take.
 *
 * **Two `applied`s that mean different things.** `StageOutcome.status ===
 * "applied"` says *this stage did its work*; `ApplyResult.applied === true`
 * says *the working tree was written*. The save path is status-applied with
 * `applied: false` — the stage did exactly what it should, and the tree was
 * deliberately untouched. Reviewers read this backwards; the outcomes are:
 *
 * | situation | outcome |
 * |---|---|
 * | nothing in the chain carried a payload | `skipped`, zero reasons, no value |
 * | a divergence abort defers this payload | `skipped`, zero reasons, no value |
 * | the bundle declares a carry it lacks | `skipped`, one reason, value with `carryAvailable` only |
 * | applied, or declined and saved | `applied`, `describeCarryApply`'s reasons |
 *
 * The third row is why the result is not a `StageOutcome<ApplyResult>`:
 * `carryAvailable` is the SENDER's claim, read from the manifest before the
 * bundle is inspected, and it reaches `HubPullResult` even when nothing could
 * be done with it.
 *
 * **No `try`/`catch` here, on purpose.** `applyCarry` can reject
 * (`listPayloadFiles` sits outside its own try). Today that propagates past
 * `hubPull`'s `finally`, which still releases the lock and clears the temp
 * dir. Catching it would turn a hard failure into a warning on a pull that
 * then reports `success: true`.
 */
export async function runApplyCarryStage(
  input: ApplyCarryStageInput
): Promise<StageOutcome<ApplyCarryStageResult>> {
  const { targetPath, applyRequested, apply: st } = input;

  const carry = st.lastCarry;
  if (carry === null) return stageSkip<ApplyCarryStageResult>([]);
  // The one predicate, shared with the sessions disclosure that reports it.
  if (isCarrySuppressed(st)) return stageSkip<ApplyCarryStageResult>([]);

  const carryAvailable = carry.meta;
  // isDirectory, not exists — see the workspace guard in `pull.ts`.
  if (!isReadableDir(carry.dir)) {
    return stageSkip<ApplyCarryStageResult>(
      [
        "The bundle's manifest declares carried uncommitted changes but the bundle does not contain them, so there was nothing to apply. The bundle is damaged or was not produced by sesh-mover.",
      ],
      { carryAvailable, carryApplied: undefined }
    );
  }

  const carryApplied = await applyCarry({
    carryDir: carry.dir,
    targetPath,
    meta: carry.meta,
    saveOnly: !applyRequested,
  });
  return stageOk<ApplyCarryStageResult>(
    { carryAvailable, carryApplied },
    describeCarryApply(carryApplied, carry.meta, carry.bundleFile)
  );
}
