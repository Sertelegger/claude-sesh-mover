import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalProjectId {
  projectId: string;
  name: string;
  createdAt: string;
  createdByMachine: string;
}

export function localProjectIdPath(projectPath: string): string {
  return join(projectPath, ".claude-sesh-mover", "project.json");
}

export function readLocalProjectId(projectPath: string): LocalProjectId | null {
  const p = localProjectIdPath(projectPath);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as LocalProjectId;
    if (!parsed.projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}
