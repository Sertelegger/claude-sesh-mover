import { isSafeSessionId } from "../manifest.js";
// ---- Validation ----
// Hub ids (project/machine/thread/bundle ids and session ids read from hub
// JSON) share the session-id safety rules: no separators, no dot-segments.
export function assertSafeHubId(id, what) {
    if (!isSafeSessionId(id)) {
        throw new Error(`unsafe ${what} in hub data: ${JSON.stringify(id)}`);
    }
}
// Backend paths are hub-relative, forward-slash, no traversal. This is the
// chokepoint that keeps hostile hub records from steering reads outside the
// hub directory (same defense class as the archiver's tar validation).
export function assertHubRelPath(relPath) {
    const bad = relPath.length === 0 ||
        relPath.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(relPath) ||
        relPath.includes("\\") ||
        relPath.includes("\0") ||
        relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
    if (bad) {
        throw new Error(`not a safe hub-relative path: ${JSON.stringify(relPath)}`);
    }
}
// ---- Path builders ----
export const HUB_JSON = "hub.json";
export function machinePath(machineId) {
    assertSafeHubId(machineId, "machineId");
    return `machines/${machineId}.json`;
}
export function projectDir(projectId) {
    assertSafeHubId(projectId, "projectId");
    return `projects/${projectId}`;
}
export function projectJsonPath(projectId) {
    return `${projectDir(projectId)}/project.json`;
}
export function indexDirPath(projectId) {
    return `${projectDir(projectId)}/index`;
}
export function indexPath(projectId, machineId) {
    assertSafeHubId(machineId, "machineId");
    return `${indexDirPath(projectId)}/${machineId}.json`;
}
export function tombstoneDirPath(projectId) {
    return `${projectDir(projectId)}/tombstones`;
}
export function tombstonePath(projectId, machineId) {
    assertSafeHubId(machineId, "machineId");
    return `${tombstoneDirPath(projectId)}/${machineId}.json`;
}
export function bundleDir(projectId, machineId) {
    assertSafeHubId(machineId, "machineId");
    return `${projectDir(projectId)}/bundles/${machineId}`;
}
/**
 * Where a machine's WORKSPACE SNAPSHOTS live — beside its bundles rather than
 * inside them (#91).
 *
 * **The split exists because the two payloads have opposite lifetimes.** A
 * transcript is small and is kept forever; a workspace snapshot is the whole
 * project tree and is superseded by the next generation. Welded into one
 * archive, reclaiming a stale snapshot means deleting the transcript that rode
 * with it, so bundle-granularity compaction (#92) has no good move. Split, the
 * snapshot can be retired without touching a byte of history.
 *
 * Three properties this directory inherits rather than re-states:
 *
 * - **Per-machine ownership.** `<machineId>` is the last segment for the same
 *   reason `bundleDir`'s is: a machine writes only its own files, so two
 *   machines never contend and no distributed lock is needed.
 * - **The same naming rule as a bundle** (`bundleFileName`), so
 *   `isEncryptedBundleFile` is the whole of the reader's encryption branch here
 *   too. A workspace artifact goes through `fetchBundleArchive` — the one seam
 *   where hub bytes are decrypted — and needs no reader of its own.
 * - **A separate directory, not a second name inside `bundles/`.** `hub
 *   reindex` lists `bundleDir` and refuses any name `BUNDLE_FILE_RE` does not
 *   parse; parking workspace artifacts there would make every one of them an
 *   "unrecognized bundle file" warning on every rebuild, including on plugin
 *   versions that predate this split. Under `workspaces/` they are simply
 *   invisible to it.
 *
 * Deletion needs no new code: `hub delete` enumerates `backend.list(projectDir(…))`,
 * which recurses, so this subtree is swept with the rest.
 */
export function workspaceDir(projectId, machineId) {
    assertSafeHubId(machineId, "machineId");
    return `${projectDir(projectId)}/workspaces/${machineId}`;
}
/**
 * The suffix an ENCRYPTED bundle carries, appended to the plaintext one.
 *
 * **This is the whole of the reader's branch.** A hub is permanently MIXED —
 * enabling encryption never rewrites an existing bundle (that would be one
 * machine rewriting another machine's files, which per-machine ownership
 * forbids outright), so plaintext and ciphertext sit side by side forever. The
 * reader therefore decides per FILE, from the name the index recorded, and
 * never from local config: a reader that consulted `hub.json.encrypt` or the
 * local `hub.encrypt` preference would strand its own history the moment the
 * switch was flipped, and would fail in the other direction on a machine that
 * has not enabled it yet.
 *
 * `.tar.gz` remains the plaintext spelling, so an older plugin's
 * `BUNDLE_FILE_RE` still parses the bundles it can actually read and simply
 * does not recognise the ones it cannot.
 */
export const ENCRYPTED_BUNDLE_SUFFIX = ".age";
/**
 * Is this bundle file encrypted? **Suffix only — see `ENCRYPTED_BUNDLE_SUFFIX`.**
 *
 * Takes any hub-relative path or bare file name, because the three readers that
 * ask (the pull fetch, the merge-ancestor fetch, and `hub reindex`) hold it in
 * different shapes and must not each grow their own copy of the rule.
 */
export function isEncryptedBundleFile(fileOrPath) {
    return fileOrPath.endsWith(ENCRYPTED_BUNDLE_SUFFIX);
}
// ':' is invalid in Windows file names — sanitize the ISO timestamp.
//
// Shared with the WORKSPACE ARTIFACT (`workspaceDir`), deliberately and not
// merely conveniently: the artifact is fetched by `fetchBundleArchive`, whose
// only encryption branch is `isEncryptedBundleFile`, so its name has to end the
// same way a bundle's does. One naming rule keeps that true by construction
// instead of by two functions currently agreeing.
export function bundleFileName(pushedAtIso, bundleId, opts = {}) {
    assertSafeHubId(bundleId, "bundleId");
    const ts = pushedAtIso.replace(/:/g, "-");
    assertSafeHubId(ts, "bundle timestamp");
    return `${ts}-${bundleId}.tar.gz${opts.encrypted ? ENCRYPTED_BUNDLE_SUFFIX : ""}`;
}
//# sourceMappingURL=layout.js.map