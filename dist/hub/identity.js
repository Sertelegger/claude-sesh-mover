import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function localProjectIdPath(projectPath) {
    return join(projectPath, ".claude-sesh-mover", "project.json");
}
export function readLocalProjectId(projectPath) {
    const p = localProjectIdPath(projectPath);
    if (!existsSync(p))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        if (!parsed.projectId)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=identity.js.map