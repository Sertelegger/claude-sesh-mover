/**
 * The repository root whose memory Claude Code keys, or `null` when the path
 * is not inside a git working tree at all (which is the plain-directory case,
 * and the common one).
 *
 * The path is walked AS GIVEN — not `resolve`d, not `realpath`ed. Callers on
 * the write side are handed paths `cli.ts` has already turned physical
 * (#149), and a caller-typed path is also what the rest of the pipeline keys
 * folders on; resolving here would silently re-encode a path whose spelling
 * the transcript folder was filed under.
 */
export declare function canonicalGitRoot(projectPath: string): string | null;
/**
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, Claude Code's folder-name override (#152):
 * valid only when `CLAUDE_CONFIG_DIR` is set AND names the config dir in use,
 * and only when the value passes Claude Code's own two checks — its name regex
 * and the Windows reserved-device-name list. Mirrors the bundle exactly, so
 * that #150's memory folder and #152's session folder cannot come to disagree
 * about the name.
 */
export declare function projectFolderNameOverride(configDir: string): string | null;
/**
 * The directory Claude Code reads a project's memory from, and the directory a
 * bundle's `memory/` must therefore be read out of (export) or written into
 * (import, pull).
 *
 * `projectPath` is the PROJECT, not the transcript folder: a session started in
 * `repo/sub/dir` or in `repo/worktree` has its transcripts under the encoded
 * spelling of that path and its memory under the canonical root, which is what
 * this resolves. Nothing here consults a discovered session or an encoded
 * folder name, so the answer cannot drift from Claude Code's by construction.
 */
export declare function resolveMemoryDir(configDir: string, projectPath: string): string;
//# sourceMappingURL=memory-path.d.ts.map