import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";

export interface ContinuationInput {
  originalJsonl: string;
  fromEntryIndex: number;
  fromEntryUuid: string;
  newSessionId: string;
  sourceSessionId: string;
  sourceMachineId: string;
  sourceMachineName: string;
  previousLocalSessionId?: string;
  targetProjectPath?: string;
  claudeVersion: string;
}

// Shared by string and stream builders so header text can never drift.
function buildContinuationHeader(
  input: Omit<ContinuationInput, "originalJsonl">,
  previousCount: number,
  newCount: number
): Record<string, unknown> {
  const priorLocation = input.previousLocalSessionId
    ? `live in session \`${input.previousLocalSessionId}\` on this machine`
    : "are not present on this machine; see the originating machine for context";

  const content =
    `[sesh-mover continuation]\n` +
    `This session continues session \`${input.sourceSessionId}\` from machine \`${input.sourceMachineName}\` (\`${input.sourceMachineId}\`). ` +
    `The earlier ${previousCount} message(s) ${priorLocation}. ` +
    `The entries below are the ${newCount} new message(s) appended on the other machine since the last sync.`;

  return {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: input.newSessionId,
    cwd: input.targetProjectPath ?? "",
    version: input.claudeVersion,
    type: "user",
    message: { role: "user", content },
  };
}

export function buildContinuationJsonl(input: ContinuationInput): string {
  const { originalJsonl, fromEntryIndex, fromEntryUuid } = input;

  const lines = originalJsonl.trim().split("\n").filter(Boolean);
  if (fromEntryIndex < 0 || fromEntryIndex >= lines.length) {
    throw new Error(
      `fromEntryIndex ${fromEntryIndex} out of range (session has ${lines.length} entries)`
    );
  }

  let actualUuid: string | undefined;
  try {
    actualUuid = (JSON.parse(lines[fromEntryIndex]) as { uuid?: string }).uuid;
  } catch {
    actualUuid = undefined;
  }
  if (actualUuid !== fromEntryUuid) {
    throw new Error(
      `Continuation uuid mismatch: entry at index ${fromEntryIndex} has uuid ${actualUuid ?? "(unparseable)"}, expected ${fromEntryUuid}. The session file changed between diff and slice.`
    );
  }

  const sliced = lines.slice(fromEntryIndex);
  const newCount = sliced.length;
  const previousCount = fromEntryIndex;

  const header = buildContinuationHeader(input, previousCount, newCount);
  return [JSON.stringify(header), ...sliced].join("\n") + "\n";
}

export interface ContinuationStreamInput
  extends Omit<ContinuationInput, "originalJsonl"> {
  sourceJsonlPath: string;
  outputPath: string;
}

// Two-pass streaming continuation build. Pass 1 counts lines and verifies
// the uuid at fromEntryIndex (the header text needs the tail count before
// any tail line is written). Pass 2 writes header + tail, hashing exactly
// the written bytes. O(longest line) memory.
export async function buildContinuationStream(
  input: ContinuationStreamInput
): Promise<{ entryCount: number; integrityHash: string }> {
  const { sourceJsonlPath, outputPath, fromEntryIndex, fromEntryUuid } = input;

  // Pass 1: count + verify
  let total = 0;
  let uuidAtIndex: string | undefined;
  {
    const src = createReadStream(sourceJsonlPath, { encoding: "utf-8" });
    const rl = createInterface({ input: src, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        if (total === fromEntryIndex) {
          try {
            uuidAtIndex = (JSON.parse(line) as { uuid?: string }).uuid;
          } catch {
            uuidAtIndex = undefined;
          }
        }
        total++;
      }
    } finally {
      rl.close();
      src.destroy();
    }
  }

  if (fromEntryIndex < 0 || fromEntryIndex >= total) {
    throw new Error(
      `fromEntryIndex ${fromEntryIndex} out of range (session has ${total} entries)`
    );
  }
  if (uuidAtIndex !== fromEntryUuid) {
    throw new Error(
      `Continuation uuid mismatch: entry at index ${fromEntryIndex} has uuid ${uuidAtIndex ?? "(unparseable)"}, expected ${fromEntryUuid}. The session file changed between diff and slice.`
    );
  }

  const newCount = total - fromEntryIndex;
  const header = buildContinuationHeader(input, fromEntryIndex, newCount);

  // Pass 2: write header + tail
  const hash = createHash("sha256");
  const out = createWriteStream(outputPath, { encoding: "utf-8" });
  const src = createReadStream(sourceJsonlPath, { encoding: "utf-8" });
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  let index = 0;
  let entryCount = 0;
  // A write-stream failure (bad output dir, disk full, EACCES) needs three
  // guards, or it either crashes the process or hangs forever — mirrors
  // rewriter.ts's rewriteJsonlStream (see the comment there for the full
  // rationale):
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
  //     can't happen before the first tail line (or the header write) is
  //     reached. If the output errors first, Node sees a rejected promise
  //     with no handler yet and crashes with an unhandled-rejection error.
  //     The no-op catch marks it handled immediately without swallowing the
  //     rejection for the real race later.
  const outErrored: Promise<never> = new Promise<never>((_, reject) =>
    out.once("error", reject)
  );
  outErrored.catch(() => {});

  try {
    const headerLine = JSON.stringify(header) + "\n";
    hash.update(headerLine);
    if (!out.write(headerLine)) {
      await Promise.race([once(out, "drain"), outErrored]);
    }
    entryCount++;

    for await (const line of rl) {
      if (!line) continue;
      // Pass-1's count is the snapshot: cap here so lines appended to the
      // live session between passes are never written, keeping header prose,
      // written tail, entryCount, and hash mutually consistent.
      if (index >= total) break;
      if (index >= fromEntryIndex) {
        const chunk = line + "\n";
        hash.update(chunk);
        if (!out.write(chunk)) {
          await Promise.race([once(out, "drain"), outErrored]);
        }
        entryCount++;
      }
      index++;
    }
    out.end();
    await Promise.race([finished(out), outErrored]);
  } catch (e) {
    out.destroy();
    throw e;
  } finally {
    rl.close();
    src.destroy();
  }

  return { entryCount, integrityHash: `sha256:${hash.digest("hex")}` };
}
