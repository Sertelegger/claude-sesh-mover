function keyOf(c) {
    return `${c.filename}\0${c.existingHash}\0${c.incomingHash}\0${c.parkedAs ?? ""}`;
}
/** Fold one bundle's import result into the pull-wide accumulator. */
export function recordSharedLayers(acc, found) {
    if (found.memoryDir !== undefined)
        acc.memoryDir = found.memoryDir;
    for (const c of found.memoryConflicts ?? []) {
        if (!acc.memoryConflicts.some((seen) => keyOf(seen) === keyOf(c))) {
            acc.memoryConflicts.push(c);
        }
    }
    for (const c of found.planConflicts ?? []) {
        if (!acc.planConflicts.some((seen) => keyOf(seen) === keyOf(c))) {
            acc.planConflicts.push(c);
        }
    }
    const idx = found.memoryIndex;
    if (!idx)
        return;
    acc.sawMemoryLayer = true;
    for (const target of idx.added) {
        if (!acc.addedIndexEntries.includes(target))
            acc.addedIndexEntries.push(target);
    }
    for (const f of idx.unindexed) {
        if (!acc.unindexed.includes(f))
            acc.unindexed.push(f);
    }
    acc.alreadyPresent += idx.alreadyPresent;
    acc.droppedProse ||= idx.droppedProse;
}
/**
 * Project the accumulator onto the shape the result carries. SPREAD into
 * `HubPullResult` at the one assembly site, never copied field by field, for the
 * same reason `HubPullFindings` is: a field added to `SharedLayerFindings`
 * reaches the pull with no edit here, which is the defect class (#59 item 3, and
 * #49 before it) this whole path exists to close.
 */
export function sharedLayerFindings(acc) {
    // A file left unindexed by an EARLIER bundle can be indexed by a LATER one's
    // union, in which case it is no longer unindexed and reporting it would be a
    // false alarm. `addedIndexEntries` is exactly the set of targets the chain
    // appended, and a single bundle already computes `unindexed` after its own
    // union — so subtracting it here applies the same rule across the chain.
    const unindexed = acc.unindexed.filter((f) => !acc.addedIndexEntries.includes(f));
    return {
        memoryConflicts: acc.memoryConflicts.length > 0 ? acc.memoryConflicts : undefined,
        memoryIndex: acc.sawMemoryLayer
            ? {
                added: acc.addedIndexEntries,
                alreadyPresent: acc.alreadyPresent,
                droppedProse: acc.droppedProse,
                unindexed,
            }
            : undefined,
        memoryDir: acc.memoryDir,
        planConflicts: acc.planConflicts.length > 0 ? acc.planConflicts : undefined,
        // `plansSkipped` is DELIBERATELY not projected, and this is not an
        // oversight to tidy up: no hub bundle has ever carried `plans/`. The
        // exporter gates that copy on `!incremental` and `hub push` passes a
        // truthy `incremental` unconditionally, so the field could only ever be
        // `undefined` here. A field that cannot be populated is worse than an
        // absent one — it tells a reader the pull considered plans and found none,
        // when the truth is that plans never reach this transport at all.
        //
        // Restore it in the same change that lets plans travel to the hub, and not
        // before. That change is gated on fixing the payload's SCOPE first
        // (`<configDir>/plans` has no project filter, so it ships every plan on the
        // machine) — see the shared-layers section in CLAUDE.md.
    };
}
/**
 * An undecided divergence stopped the chain, so a payload out of a bundle
 * the user is about to pull AGAIN stops with it: applying or saving it now
 * would leave a second copy of the same working tree beside the one the
 * re-run delivers, and "nothing was applied" has to mean the whole bundle.
 *
 * That rationale reaches exactly as far as re-runnability, and no further.
 * `lastCarry` is chosen from the newest carrying bundle anywhere in
 * `0..abortIndex`, while the abort only defers `abortIndex` onward — so a
 * payload from an earlier bundle belongs to one this pull already recorded.
 * Suppressing that one deleted the only reachable copy of another machine's
 * uncommitted work (`selectNeededBundles` drops the bundle on the re-run;
 * the archive is left on the hub, extractable only by hand) while the
 * warning claimed it had been left in its bundle for next time. Gate on
 * WHERE the payload came from, not on whether an abort happened.
 *
 * ONE computation site, deliberately: the carry stage decides whether to apply
 * on this predicate and the sessions disclosure decides whether to SAY the
 * payload was left behind on it. Two copies is how those two answer
 * differently, which is the shape the data loss above took.
 */
export function isCarrySuppressed(st) {
    return st.divergenceAborted && st.lastCarry !== null && st.lastCarry.bundleIndex >= st.abortIndex;
}
/**
 * Build the per-pull apply state. Called once, immediately before the
 * per-bundle loop; every accumulator starts here at its "nothing has happened
 * yet" value.
 */
export function initApplyState(input) {
    const { needed } = input;
    // Which bundle in this chain carries the workspace generation to apply:
    // the NEWEST one that has a payload, not needed[0].
    //
    // A chain is pulled in one pass and every bundle is recorded as received
    // by the end of it, so any generation that isn't applied now is never
    // offered again. Applying the OLDEST would therefore leave the tree
    // permanently behind the hub after two unpulled pushes — and, worse, would
    // record that stale generation as this machine's ancestor. Falls back to
    // index 0 when NO record claims a payload, which keeps the manifest check
    // in the loop the sole authority in that case (Slice-1 behavior).
    //
    // That fallback is index 0 rather than "the newest bundle whose manifest
    // has one" because the manifests aren't read yet here. It can only disagree
    // with the manifests if a record's `hasWorkspace` is wrong, and the one
    // write site sets both from the same push (hub/push.ts), so the two cannot
    // drift in practice. If they ever did — a record claiming a payload whose
    // manifest lacks one — the gate would fire on that bundle, find no
    // `manifest.workspace`, and do nothing, suppressing an earlier bundle's
    // genuine payload for that pull.
    let workspaceBundleIndex = 0;
    for (let i = needed.length - 1; i >= 0; i--) {
        if (needed[i].hasWorkspace) {
            workspaceBundleIndex = i;
            break;
        }
    }
    // Every generation the bundles in this chain declare they descend from,
    // oldest first, EACH STAMPED WITH THE MACHINE THAT DECLARED IT — the peer's
    // half of the "common to both trees" test that `chooseMergeAncestor`
    // intersects with our own generation history. See `ChainWorkspaceBase` for
    // why the stamp is load-bearing once a chain can span machines.
    const chainWorkspaceBases = [];
    const importedSessions = [];
    const skippedSessions = [];
    const appended = [];
    /**
     * Where THIS pull's own writes to a given local transcript begin: the file's
     * byte size immediately before the first splice or adoption it performed
     * there. Absent for a transcript this pull has not written to.
     *
     * Used to keep `localEntriesSinceAnchor` honest. That field answers "how far
     * has the user's own copy run past the shared anchor", and a later bundle in
     * the same chain measures it on a file an EARLIER bundle of the same pull
     * just appended to — so without this the pull counts its own delivery as the
     * user's divergence and reports a fork twice as wide as the real one.
     */
    const ourWritesFrom = new Map();
    /**
     * What this pull had ALREADY applied and recorded when a divergence stopped
     * the chain at bundle `upTo`. Empty at `upTo === 0`, where the abort really
     * does mean nothing happened.
     *
     * Measured on an aborted `--on-divergence skip` pull at `upTo === 1`: the
     * base transcript went 5 -> 7 lines, `peers[...].received` gained an entry,
     * the hub-peer ledger recorded a new head and this machine's index file was
     * republished — while the shipped warning said "skipped, nothing changed".
     * The skill layer repeats these sentences verbatim, so they have to be true
     * on both sides of the boundary.
     *
     * Closes over the LIVE containers above, not over copies of them: it is
     * called from inside the loop, after those have been pushed to.
     */
    const describeApplied = (upTo) => {
        if (upTo <= 0)
            return "";
        const bits = [];
        const entries = appended.reduce((n, a) => n + a.entriesAppended, 0);
        if (entries > 0) {
            const targets = [...new Set(appended.map((a) => a.baseSessionId))];
            bits.push(`${entries} entr${entries === 1 ? "y" : "ies"} spliced into session${targets.length === 1 ? "" : "s"} ${targets.join(", ")}`);
        }
        if (importedSessions.length > 0) {
            bits.push(`${importedSessions.length} session${importedSessions.length === 1 ? "" : "s"} imported`);
        }
        if (skippedSessions.length > 0) {
            bits.push(`${skippedSessions.length} session${skippedSessions.length === 1 ? "" : "s"} already present`);
        }
        const what = bits.length > 0 ? bits.join(", ") : "no session content landed from them";
        return `the ${upTo} earlier bundle${upTo === 1 ? "" : "s"} in this chain ${upTo === 1 ? "was" : "were"} already applied and recorded (${what})`;
    };
    /** Earliest wins: our writes to a transcript start at the first of them. */
    const rememberOurWrite = (path, from) => {
        const prior = ourWritesFrom.get(path);
        ourWritesFrom.set(path, prior === undefined ? from : Math.min(prior, from));
    };
    return {
        workspaceUnpacked: null,
        workspaceMerge: undefined,
        workspaceRefused: undefined,
        // Set when a manifest declares a workspace payload the bundle does not
        // contain (see the guard in the loop). A FIELD, not just the warning,
        // because it is field-indistinguishable from the routine no-ancestor skip
        // otherwise — same null workspaceUnpacked, same absent workspaceMerge —
        // and the two want opposite advice (that skip's remedies cannot deliver a
        // payload that was never in the bundle).
        workspaceDeclaredMissing: undefined,
        workspaceBundleIndex,
        chainWorkspaceBases,
        importedSessions,
        skippedSessions,
        appended,
        lastImportedNewId: null,
        lastBundleManifest: null,
        // The local session THIS pull has landed content in (imported or extended)
        // — null until something lands. It is both the thread mapping written at
        // the end and the preferred splice target for later bundles in the same
        // chain, since the mapping itself isn't written until the loop is done.
        threadLandedSessionId: null,
        // The last two-sided fork this pull ran into, and whether a bundle was
        // deliberately left unapplied because of one. A chain is pulled in order,
        // so a later bundle's divergence supersedes an earlier one's.
        lastDivergence: undefined,
        skippedByDivergence: false,
        /**
         * A divergence left this thread undecided, so the WHOLE chain stops here.
         *
         * Skipping only the diverged bundle and carrying on was the eighth
         * foreclosure of this milestone, and the second to survive a guard built
         * for the class. The mechanism: the next bundle in the chain is anchored on
         * the head the skipped one would have installed, so it can never chain onto
         * the local session either — it reaches the divergence branch with
         * `adoptAvailable: false`, is fragment-imported, and IS recorded. That
         * flips `appliedNothing`, the index is republished, `divergence.resolution`
         * (one field for the whole pull) is overwritten "skip" -> "fragment", and
         * the user who asked to adopt silently gets a third transcript with no
         * indication their answer was dropped. Every remedy is then foreclosed:
         * "Nothing to pull" / "the latest copy is already local".
         *
         * A skip is a promise that this pull applied and recorded NOTHING for this
         * thread. That promise is only keepable at the granularity of the thread,
         * because the bundles in a chain are not independent — so the loop breaks.
         */
        divergenceAborted: false,
        /** How many bundles of the chain were left unfetched by that break. */
        deferredBundles: 0,
        /**
         * Which bundle the break landed on, or -1 for "the chain ran to the end".
         *
         * The abort is thread-wide, but it is NOT a rollback, and the difference is
         * the whole reason this index exists. A chain is walked in order, so bundles
         * `0..abortIndex - 1` were spliced or imported AND RECORDED before the fork
         * was discovered; only `abortIndex` onward is still on offer. Everything
         * that phrases the abort — the warnings, the carry gate, the thread mapping
         * — has to split on that boundary instead of treating the whole thread as
         * untouched, which is only true at `abortIndex === 0`.
         */
        abortIndex: -1,
        ourWritesFrom,
        sharedLayers: {
            memoryConflicts: [],
            planConflicts: [],
            addedIndexEntries: [],
            unindexed: [],
            alreadyPresent: 0,
            droppedProse: false,
            sawMemoryLayer: false,
            memoryDir: undefined,
        },
        // The newest carry payload in this chain, if any — see the loop.
        lastCarry: null,
        /**
         * The index of the last bundle this pull actually finished handling, and its
         * manifest (`lastBundleManifest`). Distinct from "the last bundle in
         * `needed`" once a divergence can stop the chain early — see the
         * thread-mapping block at the end, which used to name a bundle that was
         * never fetched.
         */
        lastAppliedIndex: -1,
        describeApplied,
        rememberOurWrite,
    };
}
//# sourceMappingURL=pull-apply-state.js.map