import { computeEffectiveConfig } from "../config.js";
import { resolveHubPath } from "./init.js";
import { readLocalProjectId } from "./identity.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
// Hook payloads arrive on stdin as JSON. A malformed payload must never crash
// the hook — the endpoints exit 0 no matter what, so parsing failures degrade
// to "no context" and the gate declines. The shape check is load-bearing:
// JSON.parse("null") succeeds and `typeof null === "object"`, and
// JSON.parse("42") yields a number — either would flow on as a "payload".
export function readHookPayload(stdin) {
    try {
        const parsed = JSON.parse(stdin);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
// Cheapest checks first: this runs on every session start/end, so it must cost
// approximately nothing when the hub isn't in use. Order is
// cwd -> hub configured -> project linked -> flag enabled, and every decline
// is a silent no-op for the caller (no stdout, no non-zero exit).
export function evaluateHookGate(payload, key) {
    const projectPath = payload.cwd;
    // The typeof check is not redundant with the falsiness check: the payload is
    // untrusted JSON, so `cwd` can be a number/object/array/boolean that is
    // perfectly truthy and then throws ERR_INVALID_ARG_TYPE inside join(). This
    // function is documented and consumed as a pure data result (both hook
    // endpoints call it), so a hostile payload must decline, not throw.
    if (typeof projectPath !== "string" || !projectPath)
        return { ok: false, reason: "no-cwd" };
    // Same call shape hub/status.ts uses: computeEffectiveConfig reads the raw
    // override files itself, so an absent layer contributes nothing.
    const config = computeEffectiveConfig(userSeshMoverDir(), projectSeshMoverDir(projectPath));
    const hubPath = resolveHubPath(config);
    if (!hubPath)
        return { ok: false, reason: "no-hub" };
    if (!readLocalProjectId(projectPath))
        return { ok: false, reason: "unlinked" };
    // Indexed rather than dotted so a key not yet present in SeshMoverConfig
    // (see HookGateKey) still type-checks and reads as "not explicitly false".
    const flags = config.hub;
    if (flags[key] === false)
        return { ok: false, reason: "disabled" };
    return { ok: true, hubPath, projectPath };
}
//# sourceMappingURL=hooks.js.map