import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { finished } from "node:stream/promises";
import { assertHubRelPath } from "./layout.js";

// Thrown by orchestrators (pull) when index records reference files the sync
// client hasn't materialized yet. Defined here because it is part of the
// backend's consumer contract, not because backends throw it.
export class HubNotSyncedError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`hub files not yet synced: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export interface HubWriteStream {
  stream: NodeJS.WritableStream;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface HubBackend {
  read(relPath: string): Promise<Buffer>;
  writeAtomic(relPath: string, data: Buffer | string): Promise<void>;
  list(relPrefix: string): Promise<string[]>;
  exists(relPath: string): Promise<boolean>;
  delete(relPath: string): Promise<void>;
  readStream(relPath: string): Promise<NodeJS.ReadableStream>;
  writeStreamAtomic(relPath: string): Promise<HubWriteStream>;
}

export function createFsBackend(rootDir: string): HubBackend {
  const abs = (relPath: string): string => {
    assertHubRelPath(relPath);
    return join(rootDir, ...relPath.split("/"));
  };

  return {
    async read(relPath) {
      return readFileSync(abs(relPath));
    },

    async writeAtomic(relPath, data) {
      const target = abs(relPath);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      writeFileSync(tmp, data);
      renameSync(tmp, target);
    },

    async list(relPrefix) {
      assertHubRelPath(relPrefix);
      const root = join(rootDir, ...relPrefix.split("/"));
      if (!existsSync(root)) return [];
      const out: string[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const childRel = `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
          else if (entry.isFile() && !entry.name.includes(".tmp-")) out.push(childRel);
        }
      };
      if (!statSync(root).isDirectory()) return [relPrefix];
      walk(root, relPrefix);
      return out;
    },

    async exists(relPath) {
      return existsSync(abs(relPath));
    },

    async delete(relPath) {
      rmSync(abs(relPath), { force: true });
    },

    async readStream(relPath) {
      return createReadStream(abs(relPath));
    },

    async writeStreamAtomic(relPath) {
      const target = abs(relPath);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      const stream = createWriteStream(tmp);
      // A stream error occurring before commit()/abort() is called would
      // otherwise be an unhandled 'error' event with zero listeners
      // attached, which crashes the process outright (same hazard as
      // rewriter.ts's rewriteJsonlStream). Latch it here immediately so
      // commit() can surface it as a rejection instead.
      let streamError: Error | null = null;
      stream.once("error", (err) => {
        streamError = err;
      });
      return {
        stream,
        async commit() {
          if (streamError) throw streamError;
          if (!stream.writableEnded) stream.end();
          await finished(stream);
          if (streamError) throw streamError;
          renameSync(tmp, target);
        },
        async abort() {
          stream.destroy();
          rmSync(tmp, { force: true });
        },
      };
    },
  };
}
