import { homedir } from "node:os";
import { join } from "node:path";
import { computeEffectiveConfig } from "../config.js";
import { resolveHubPath } from "./init.js";
import { readLocalProjectId } from "./identity.js";

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

// Hook payloads arrive on stdin as JSON. A malformed payload must never crash
// the hook — the endpoints exit 0 no matter what, so parsing failures degrade
// to "no context" and the gate declines. The shape check is load-bearing:
// JSON.parse("null") succeeds and `typeof null === "object"`, and
// JSON.parse("42") yields a number — either would flow on as a "payload".
export function readHookPayload(stdin: string): HookPayload {
  try {
    const parsed: unknown = JSON.parse(stdin);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as HookPayload)
      : {};
  } catch {
    return {};
  }
}

export interface HookGate {
  ok: boolean;
  reason?: "no-cwd" | "no-hub" | "unlinked" | "disabled";
  hubPath?: string;
  projectPath?: string;
}

/**
 * Which automation flag under `hub` in config gates this hook.
 *
 * `startupNotice` is part of this union before it exists in the config
 * defaults (it ships with the SessionStart endpoint): an absent key reads as
 * `undefined`, which is not `false`, so it is treated as enabled — matching
 * the default-on consent model either way.
 */
export type HookGateKey = "autoPush" | "startupNotice";

// Cheapest checks first: this runs on every session start/end, so it must cost
// approximately nothing when the hub isn't in use. Order is
// cwd -> hub configured -> project linked -> flag enabled, and every decline
// is a silent no-op for the caller (no stdout, no non-zero exit).
export function evaluateHookGate(payload: HookPayload, key: HookGateKey): HookGate {
  const projectPath: unknown = payload.cwd;
  // The typeof check is not redundant with the falsiness check: the payload is
  // untrusted JSON, so `cwd` can be a number/object/array/boolean that is
  // perfectly truthy and then throws ERR_INVALID_ARG_TYPE inside join(). This
  // function is documented and consumed as a pure data result (both hook
  // endpoints call it), so a hostile payload must decline, not throw.
  if (typeof projectPath !== "string" || !projectPath) return { ok: false, reason: "no-cwd" };

  // Same call shape hub/status.ts uses: computeEffectiveConfig reads the raw
  // override files itself, so an absent layer contributes nothing.
  const config = computeEffectiveConfig(
    join(homedir(), ".claude-sesh-mover"),
    join(projectPath, ".claude-sesh-mover")
  );
  const hubPath = resolveHubPath(config);
  if (!hubPath) return { ok: false, reason: "no-hub" };
  if (!readLocalProjectId(projectPath)) return { ok: false, reason: "unlinked" };
  // Indexed rather than dotted so a key not yet present in SeshMoverConfig
  // (see HookGateKey) still type-checks and reads as "not explicitly false".
  const flags = config.hub as unknown as Record<string, unknown>;
  if (flags[key] === false) return { ok: false, reason: "disabled" };

  return { ok: true, hubPath, projectPath };
}
