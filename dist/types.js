// --- Exit codes ---
/**
 * The CLI's process exit codes: **one per CLASS of outcome**, so a shell caller
 * can branch on `$?` without parsing the JSON body (#76).
 *
 * Before this existed the split was an accident of which output helper a call
 * site happened to reach — `output()` returned and every typed refusal exited
 * 0, `outputError()` exited 1 — so `success: false` did not imply non-zero and
 * `sesh-mover hub pull || handle_failure` was silently a no-op for the entire
 * refusal class. The classes below are the stated rule; `exitCodeForResult` is
 * the single place a result is mapped onto one.
 *
 * The class list is finite and deliberately small. It is a CONTRACT: adding a
 * fifth class, or moving a result between two of them, is a breaking change for
 * anyone scripting this CLI.
 *
 * **The two hook endpoints (`hub hook-session-end`, `hub hook-session-start`)
 * are outside this scheme entirely and ALWAYS exit 0**, whatever happens. That
 * is Claude Code's hook protocol, not a style choice — see the stdout-contract
 * comments on both endpoints in `src/cli.ts` and the guards in
 * `tests/hub-hooks.test.ts`. Neither endpoint calls the output helpers, which is
 * what keeps the two schemes from meeting.
 */
export const EXIT_OK = 0;
/**
 * The command did not run: a bad invocation, or an unexpected failure.
 *
 * Commander's own argument validation already exits 1, and so does every
 * exception that reaches a command's `catch` (`outputError` in `src/cli.ts`).
 * Retrying the same invocation unchanged is not expected to help.
 */
export const EXIT_FAILED = 1;
/**
 * The command was understood and declined: nothing was done, and the JSON body
 * says why. `unlinked`, `no-such-project`, "already up to date", and the
 * pick-required listing are this class.
 *
 * A refusal is not an error — the caller is meant to read the shape and decide
 * — but it is emphatically not a success either, which is the whole reason it
 * no longer shares an exit code with one.
 */
export const EXIT_REFUSED = 2;
/**
 * The invocation was fine and the machine simply is not ready: an unmounted
 * share, a synced folder mid-copy, another sesh-mover operation holding the
 * project lock.
 *
 * This is exactly the set worth RETRYING, unchanged, in a moment — which is the
 * property that makes it worth a code of its own rather than folding it into
 * the refusals.
 */
export const EXIT_NOT_READY = 3;
/**
 * The class each typed refusal belongs to.
 *
 * `Record<CliResultReason, ExitCode>` is load-bearing: it is EXHAUSTIVE over the
 * union above, so a new result type carrying a new `reason` fails to compile
 * until someone decides which class it is in. That is the guard against the
 * defect this whole scheme replaces — a result shape silently inheriting
 * whichever exit code its call site happened to produce.
 */
const REASON_EXIT_CODE = {
    // Refusals: the command was understood, and declined.
    unlinked: EXIT_REFUSED,
    "no-such-project": EXIT_REFUSED,
    // Environment-not-ready: same invocation, retry once the machine catches up.
    "hub-unreachable": EXIT_NOT_READY,
    "lock-busy": EXIT_NOT_READY,
    "not-yet-synced": EXIT_NOT_READY,
    /**
     * NOT a refusal, and the one class assignment #76's decision comment did not
     * name. `HubPushFailedResult` is a push that THREW after the identity
     * decision — it may have left the project linked, an orphan hub project, or a
     * bundle no index references. "I declined and nothing happened" is exactly
     * what it is not, and it is not retryable the way class 3 is either. It is a
     * failure, so it takes the failure code.
     */
    "failed-after-link": EXIT_FAILED,
};
/**
 * The single mapping from a result SHAPE to an exit code.
 *
 * Shape-driven on purpose (#76): the code is a property of what the command
 * produced, not of which helper printed it, so the two cannot drift apart again.
 *
 * Three rules, in order:
 *
 * 1. `success: true` exits 0 — **except** the pick-required listing, which is
 *    the one place a `success: true` result exits non-zero. `sesh-mover pull`
 *    with neither `--thread` nor `--latest` pulls nothing; it answers with the
 *    list of threads and waits to be told which. A caller that treats that as
 *    "the pull happened" is wrong, and `|| handle` catching it is the point of
 *    the whole change. The skill layer reads `pickRequired` from the JSON and is
 *    unaffected.
 * 2. A typed `reason` takes its class from `REASON_EXIT_CODE` above.
 * 3. Anything else that is `success: false` is a REFUSAL (2).
 *
 * Rule 3's default is 2 rather than 1 because of what reaches it: an
 * `ErrorResult` that a command RETURNED as a value, having got far enough to
 * describe the outcome — "already up to date with the source machine", "no
 * thread <id> found", the self-migration block. An exception never reaches here
 * at all; `outputError` handles those and always exits 1. So the line is "a
 * result the code composed" versus "a throw it did not".
 *
 * The imprecision that line leaves, stated rather than hidden: a few untyped
 * `ErrorResult`s are caught exceptions converted to results (`hubInit`'s mkdir
 * failure, `importSession`'s unreadable bundle) and are really class 1. Giving
 * them their right code needs a `reason` discriminator on the producing module,
 * not a smarter classifier here — matching on `error` text is forbidden
 * (`skills/session-porter/SKILL.md`) and would be exactly the fragility this
 * function exists to remove. They exit 2 today: non-zero, one class off.
 */
export function exitCodeForResult(result) {
    if (result.success) {
        return "pickRequired" in result && result.pickRequired ? EXIT_REFUSED : EXIT_OK;
    }
    if ("reason" in result)
        return REASON_EXIT_CODE[result.reason];
    return EXIT_REFUSED;
}
//# sourceMappingURL=types.js.map