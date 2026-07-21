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
export function bundleDir(projectId, machineId) {
    assertSafeHubId(machineId, "machineId");
    return `${projectDir(projectId)}/bundles/${machineId}`;
}
// ':' is invalid in Windows file names — sanitize the ISO timestamp.
export function bundleFileName(pushedAtIso, bundleId) {
    assertSafeHubId(bundleId, "bundleId");
    const ts = pushedAtIso.replace(/:/g, "-");
    assertSafeHubId(ts, "bundle timestamp");
    return `${ts}-${bundleId}.tar.gz`;
}
//# sourceMappingURL=layout.js.map