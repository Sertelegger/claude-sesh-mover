import { isSafeSessionId } from "../manifest.js";

// ---- Hub file schema types (Slice 1, schemaVersion 1 everywhere) ----

export interface HubJson { schemaVersion: 1; hubId: string; createdAt: string; }
export interface HubMachineJson { id: string; name: string; platform: string; lastSeenAt: string; }
export interface HubProjectJson {
  schemaVersion: 1;
  projectId: string;
  name: string;
  matchers: { gitRemotes: string[] };
  createdAt: string;
  createdByMachine: string;
}
export interface HubBundleRecord {
  bundleId: string;
  file: string; // hub-relative path to the bundle archive
  type: "full" | "continuation";
  sessionIdInBundle: string;
  fromEntryUuid: string | null;
  headEntryUuid: string;
  messageCount: number;
  pushedAt: string;
  hasWorkspace: boolean;
}
export interface HubThreadEntry {
  localSessionId: string;
  slug: string;
  summary: string;
  headEntryUuid: string;
  messageCount: number;
  lastActiveAt: string;
  bundles: HubBundleRecord[];
}
export interface HubIndexJson {
  schemaVersion: 1;
  agent: "claude-code";
  projectId: string;
  machineId: string;
  updatedAt: string;
  projectPath: string;
  threads: Record<string, HubThreadEntry>;
}

// ---- Validation ----

// Hub ids (project/machine/thread/bundle ids and session ids read from hub
// JSON) share the session-id safety rules: no separators, no dot-segments.
export function assertSafeHubId(id: unknown, what: string): asserts id is string {
  if (!isSafeSessionId(id)) {
    throw new Error(`unsafe ${what} in hub data: ${JSON.stringify(id)}`);
  }
}

// Backend paths are hub-relative, forward-slash, no traversal. This is the
// chokepoint that keeps hostile hub records from steering reads outside the
// hub directory (same defense class as the archiver's tar validation).
export function assertHubRelPath(relPath: string): void {
  const bad =
    relPath.length === 0 ||
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

export function machinePath(machineId: string): string {
  assertSafeHubId(machineId, "machineId");
  return `machines/${machineId}.json`;
}

export function projectDir(projectId: string): string {
  assertSafeHubId(projectId, "projectId");
  return `projects/${projectId}`;
}

export function projectJsonPath(projectId: string): string {
  return `${projectDir(projectId)}/project.json`;
}

export function indexDirPath(projectId: string): string {
  return `${projectDir(projectId)}/index`;
}

export function indexPath(projectId: string, machineId: string): string {
  assertSafeHubId(machineId, "machineId");
  return `${indexDirPath(projectId)}/${machineId}.json`;
}

export function bundleDir(projectId: string, machineId: string): string {
  assertSafeHubId(machineId, "machineId");
  return `${projectDir(projectId)}/bundles/${machineId}`;
}

// ':' is invalid in Windows file names — sanitize the ISO timestamp.
export function bundleFileName(pushedAtIso: string, bundleId: string): string {
  assertSafeHubId(bundleId, "bundleId");
  const ts = pushedAtIso.replace(/:/g, "-");
  assertSafeHubId(ts, "bundle timestamp");
  return `${ts}-${bundleId}.tar.gz`;
}
