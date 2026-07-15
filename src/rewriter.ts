import { createReadStream, createWriteStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { applyAdapters } from "./version-adapters.js";
import type { PathMapping, RewriteReport, Platform, VersionAdapter } from "./types.js";
import { samePlatformFamily, translatePath } from "./platform.js";

export interface RewriteContext {
  mappings: PathMapping[];
  sourcePlatform: Platform;
  targetPlatform: Platform;
  sourceUser: string;
  targetUser: string;
}

// Characters that terminate a path token embedded in free text.
// (?<!\/) — a token immediately preceded by "/" is URL-context
// (http://mnt/..., protocol-relative //tmp/..., file:///mnt/...) and is
// never translated. (?<![A-Za-z0-9.-]) protects paths following domain names
// (https://example.com/mnt/...). Together these prevent URL corruption while
// still translating bare filesystem paths. Leaving text unchanged is the
// preferred failure mode.
const UNIX_TOKEN = /(?<![A-Za-z0-9.-])(?<!\/)(?:\/[A-Za-z0-9._@+~-]+)+\/?/g;
const WIN_TOKEN = /(?<![A-Za-z0-9.-])(?<!\/)[A-Za-z]:\\[^\s"'`)\]}>,;]*/g;
const TAIL = /[^\s"'`)\]}>,;:]*/;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSeparators(tail: string, targetPlatform: Platform): string {
  return targetPlatform === "win32"
    ? tail.replace(/\//g, "\\")
    : tail.replace(/\\/g, "/");
}

export function rewriteString(input: string, ctx: RewriteContext): string {
  const crossFamily = !samePlatformFamily(ctx.sourcePlatform, ctx.targetPlatform);
  let result = input;

  // Stage 1: exact mappings (project path, config dir, home), longest first.
  // Cross-family, the tail after the replacement gets its separators
  // normalized up to a token boundary; same-family tails are left alone.
  for (const mapping of ctx.mappings) {
    // Only replace when mapping.from ends at a path-component boundary: the
    // next char is a separator, or the match ends at a token terminator / EOS.
    // Prevents `/home/me/app` from rewriting inside `/home/me/app-backup`.
    const re = new RegExp(
      escapeRegex(mapping.from) + "(?![^\\s\"'`)\\]}>,;:/\\\\])" + "(" + TAIL.source + ")",
      "g"
    );
    result = result.replace(re, (_m, tail: string) =>
      mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail)
    );
  }

  // Stage 2 (cross-family only): translate remaining path-like tokens through
  // the platform engine (/mnt/<drive>, /tmp, /home, /Users, drive letters).
  if (crossFamily) {
    const tokenRe = ctx.sourcePlatform === "win32" ? WIN_TOKEN : UNIX_TOKEN;
    result = result.replace(tokenRe, (token) =>
      translatePath(token, ctx.sourcePlatform, ctx.targetPlatform, {
        sourceUser: ctx.sourceUser,
        targetUser: ctx.targetUser,
      })
    );
  }

  return result;
}

// Like rewriteString, but for fields that are a path in their entirety (cwd,
// trackedFileBackups keys) rather than free text that may merely *contain*
// paths. Stage-1 exact mappings normalize their WHOLE tail (not just up to
// the first token boundary), so spaces and other non-token characters in the
// tail still get separator-normalized cross-family. Falls through to the
// same token-translation engine as rewriteString when no mapping matches.
export function rewriteWholePath(input: string, ctx: RewriteContext): string {
  const crossFamily = !samePlatformFamily(ctx.sourcePlatform, ctx.targetPlatform);
  for (const mapping of ctx.mappings) {
    if (
      input === mapping.from ||
      input.startsWith(mapping.from + "/") ||
      input.startsWith(mapping.from + "\\")
    ) {
      const tail = input.slice(mapping.from.length);
      return mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail);
    }
  }
  if (crossFamily) {
    return translatePath(input, ctx.sourcePlatform, ctx.targetPlatform, {
      sourceUser: ctx.sourceUser,
      targetUser: ctx.targetUser,
    });
  }
  return input;
}

export function buildPathMappings(
  sourcePlatform: Platform,
  targetPlatform: Platform,
  sourceProjectPath: string,
  targetProjectPath: string,
  sourceConfigDir: string,
  targetConfigDir: string,
  sourceUser: string,
  targetUser: string
): PathMapping[] {
  const mappings: PathMapping[] = [];

  // Project path mapping (most specific first)
  if (sourceProjectPath !== targetProjectPath) {
    mappings.push({
      from: sourceProjectPath,
      to: targetProjectPath,
      description: `Project path: ${sourceProjectPath} -> ${targetProjectPath}`,
    });
  }

  // Config dir mapping
  if (sourceConfigDir !== targetConfigDir) {
    mappings.push({
      from: sourceConfigDir,
      to: targetConfigDir,
      description: `Config dir: ${sourceConfigDir} -> ${targetConfigDir}`,
    });
  }

  // Home dir mapping — cross-platform or same-platform different user
  if (!samePlatformFamily(sourcePlatform, targetPlatform)) {
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `Home dir: ${sourceHome} -> ${targetHome}`,
      });
    }
  } else if (sourceUser !== targetUser) {
    // Same platform family, different user
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `User home: ${sourceHome} -> ${targetHome}`,
      });
    }
  }

  // Sort longest-from first to prevent prefix collisions
  mappings.sort((a, b) => b.from.length - a.from.length);

  return mappings;
}

function getHomePath(platform: Platform, user: string): string {
  if (platform === "win32") return `C:\\Users\\${user}`;
  if (platform === "darwin") return `/Users/${user}`;
  return `/home/${user}`;
}

export function rewriteEntry(
  entry: Record<string, unknown>,
  ctx: RewriteContext,
  newSessionId?: string
): Record<string, unknown> {
  const result = structuredClone(entry);

  // Rewrite sessionId
  if (newSessionId) {
    result.sessionId = newSessionId;
  }

  // Rewrite cwd (always) — whole-path field, not free text.
  if (typeof result.cwd === "string") {
    result.cwd = rewriteWholePath(result.cwd, ctx);
  }

  // Rewrite tool_result content and toolUseResult for user entries
  if (result.type === "user" && result.message) {
    const msg = result.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((item: Record<string, unknown>) => {
        if (item.type === "tool_result" && typeof item.content === "string") {
          return { ...item, content: rewriteString(item.content, ctx) };
        }
        if (item.type === "tool_result" && Array.isArray(item.content)) {
          return {
            ...item,
            content: (item.content as Array<Record<string, unknown>>).map((block) =>
              block?.type === "text" && typeof block.text === "string"
                ? { ...block, text: rewriteString(block.text as string, ctx) }
                : block
            ),
          };
        }
        return item;
      });
    }
    // Do NOT rewrite plain string user message content

    // Rewrite toolUseResult stdout/stderr
    if (result.toolUseResult) {
      const tr = result.toolUseResult as Record<string, unknown>;
      if (typeof tr.stdout === "string") {
        tr.stdout = rewriteString(tr.stdout, ctx);
      }
      if (typeof tr.stderr === "string") {
        tr.stderr = rewriteString(tr.stderr, ctx);
      }
    }
  }

  // Rewrite file-history-snapshot trackedFileBackups keys
  if (result.type === "file-history-snapshot" && result.snapshot) {
    const snapshot = result.snapshot as Record<string, unknown>;
    if (snapshot.trackedFileBackups) {
      const backups = snapshot.trackedFileBackups as Record<string, unknown>;
      const newBackups: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(backups)) {
        const newKey = rewriteWholePath(key, ctx);
        newBackups[newKey] = value;
      }
      snapshot.trackedFileBackups = newBackups;
    }
  }

  return result;
}

export interface TransformLineOptions {
  adapters?: VersionAdapter[];
  newSessionId?: string;
}

export interface TransformLineResult {
  line: string;
  changed: boolean;
  fieldsChanged: number;
  adaptationsApplied: string[];
  parseFailed: boolean;
  parseError?: string;
}

// The single per-line transform both the string API (rewriteJsonl) and the
// streaming API (rewriteJsonlStream) are built on: parse once, apply version
// adapters, rewrite, stringify. Replaces the importer's old double-parse
// (adapter pass + rewrite pass).
export function transformLine(
  line: string,
  ctx: RewriteContext,
  opts: TransformLineOptions = {}
): TransformLineResult {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch (e) {
    return {
      line,
      changed: false,
      fieldsChanged: 0,
      adaptationsApplied: [],
      parseFailed: true,
      parseError: (e as Error).message,
    };
  }

  let adaptationsApplied: string[] = [];
  if (opts.adapters && opts.adapters.length > 0) {
    const { entry: adapted, applied } = applyAdapters(entry, opts.adapters);
    entry = adapted;
    adaptationsApplied = applied;
  }

  const original = JSON.stringify(entry);
  const rewritten = rewriteEntry(entry, ctx, opts.newSessionId);
  const rewrittenStr = JSON.stringify(rewritten);

  let fieldsChanged = 0;
  if (rewrittenStr !== original) {
    for (const key of Object.keys(entry)) {
      if (
        JSON.stringify(entry[key]) !==
        JSON.stringify((rewritten as Record<string, unknown>)[key])
      ) {
        fieldsChanged++;
      }
    }
  }

  return {
    line: rewrittenStr,
    changed: rewrittenStr !== original,
    fieldsChanged,
    adaptationsApplied,
    parseFailed: false,
  };
}

export function rewriteJsonl(
  jsonlContent: string,
  ctx: RewriteContext,
  newSessionId?: string
): { rewritten: string; report: RewriteReport } {
  const lines = jsonlContent.trim().split("\n").filter(Boolean);
  let entriesRewritten = 0;
  let fieldsRewritten = 0;
  const warnings: string[] = [];

  const rewrittenLines = lines.map((line) => {
    const r = transformLine(line, ctx, { newSessionId });
    if (r.parseFailed) {
      warnings.push(`Failed to parse JSONL line: ${r.parseError}`);
      return line; // preserve unparseable lines
    }
    if (r.changed) {
      entriesRewritten++;
      fieldsRewritten += r.fieldsChanged;
    }
    return r.line;
  });

  return {
    rewritten: rewrittenLines.join("\n") + "\n",
    report: { mappings: ctx.mappings, entriesRewritten, fieldsRewritten, warnings },
  };
}

export interface RewriteStreamOptions {
  adapters?: VersionAdapter[];
  newSessionId?: string;
  onProgress?: (bytesProcessed: number, bytesTotal: number) => void;
  computeHash?: boolean;
}

export interface RewriteStreamReport extends RewriteReport {
  outputHash?: string;
  adaptationsApplied: string[];
  parseFailures: number;
}

// Streaming twin of rewriteJsonl: O(longest line) memory instead of O(file).
// outputPath null = report-only (dry-run preview): full transform + report,
// nothing written. Backpressure honored (awaits drain). Unparseable lines are
// passed through verbatim with a warning, mirroring rewriteJsonl; import-level
// strictness on parse failures is the CALLER's job (see importer.ts).
export async function rewriteJsonlStream(
  inputPath: string,
  outputPath: string | null,
  ctx: RewriteContext,
  opts: RewriteStreamOptions = {}
): Promise<RewriteStreamReport> {
  const bytesTotal = statSync(inputPath).size;
  let bytesProcessed = 0;
  let entriesRewritten = 0;
  let fieldsRewritten = 0;
  let parseFailures = 0;
  const warnings: string[] = [];
  const adaptationsApplied: string[] = [];
  const hash = opts.computeHash && outputPath ? createHash("sha256") : null;

  const input = createReadStream(inputPath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const out = outputPath ? createWriteStream(outputPath, { encoding: "utf-8" }) : null;
  // A write-stream failure (bad output dir, disk full, EACCES) needs three
  // guards, or it either crashes the process or hangs forever:
  // (1) With zero 'error' listeners it's an "unhandled error event" that
  //     crashes the process outright — out.once("error", reject) below
  //     doubles as that listener.
  // (2) once(out, "drain") only reacts to an 'error' that fires *after* we
  //     start waiting on it — if the stream already errored (and destroyed
  //     itself, e.g. on open failure) before we reach that await, the wait
  //     hangs forever. Latching the first 'error' into a promise and racing
  //     it at every await point fixes this: once rejected, it stays
  //     rejected, so racing it after the fact still wins instantly.
  // (3) The promise from (2) is only "consumed" once raced below, which
  //     can't happen before the input stream yields its first line. If the
  //     output errors first, Node sees a rejected promise with no handler
  //     yet and crashes with an unhandled-rejection error. The no-op catch
  //     marks it handled immediately without swallowing the rejection for
  //     the real race later.
  const outErrored: Promise<never> | null = out
    ? new Promise<never>((_, reject) => out.once("error", reject))
    : null;
  outErrored?.catch(() => {});

  try {
    for await (const line of rl) {
      // readline strips the terminator; count it back for progress (LF assumed).
      bytesProcessed += Buffer.byteLength(line, "utf8") + 1;
      if (!line) continue; // mirror rewriteJsonl's filter(Boolean)

      const r = transformLine(line, ctx, {
        adapters: opts.adapters,
        newSessionId: opts.newSessionId,
      });
      let outLine: string;
      if (r.parseFailed) {
        parseFailures++;
        warnings.push(`Failed to parse JSONL line: ${r.parseError}`);
        outLine = line; // preserve unparseable lines
      } else {
        if (r.changed) {
          entriesRewritten++;
          fieldsRewritten += r.fieldsChanged;
        }
        adaptationsApplied.push(...r.adaptationsApplied);
        outLine = r.line;
      }

      const chunk = outLine + "\n";
      hash?.update(chunk);
      if (out && !out.write(chunk)) {
        await Promise.race([once(out, "drain"), outErrored as Promise<never>]);
      }
      opts.onProgress?.(Math.min(bytesProcessed, bytesTotal), bytesTotal);
    }

    if (out) {
      out.end();
      await Promise.race([finished(out), outErrored as Promise<never>]);
    }
  } catch (e) {
    out?.destroy();
    throw e;
  } finally {
    rl.close();
    input.destroy();
  }

  return {
    mappings: ctx.mappings,
    entriesRewritten,
    fieldsRewritten,
    warnings,
    adaptationsApplied,
    parseFailures,
    outputHash: hash ? `sha256:${hash.digest("hex")}` : undefined,
  };
}
