/**
 * Shared gating primitive for the Claude Code hook endpoints
 * (`hub hook-session-end`, `hub hook-session-start`).
 *
 * Consent model (owner decision): **linking a project IS the consent gate.**
 * The automation flags default to enabled, but every one of them is inert
 * until a hub is configured AND this project is linked to a hub project — so a
 * user who never touches the hub never has a hook do anything at all.
 */
/** The subset of a Claude Code hook's stdin payload these endpoints use. */
export interface HookPayload {
    cwd?: string;
    session_id?: string;
    source?: string;
    reason?: string;
}
export declare function readHookPayload(stdin: string): HookPayload;
export interface HookGate {
    ok: boolean;
    reason?: "no-cwd" | "no-hub" | "unlinked" | "disabled";
    hubPath?: string;
    projectPath?: string;
}
/**
 * Which automation flag under `hub` in config gates this hook.
 *
 * Both keys are in the config defaults (`getDefaultConfig`), which is what
 * makes them settable at all — `configure --set` rejects a dot-path the
 * defaults don't contain. The read below is indexed rather than dotted anyway,
 * so a key MISSING from an older on-disk config reads as `undefined`, which is
 * not `false` and therefore enabled: the default-on consent model either way.
 */
export type HookGateKey = "autoPush" | "startupNotice";
export declare function evaluateHookGate(payload: HookPayload, key: HookGateKey): HookGate;
//# sourceMappingURL=hooks.d.ts.map