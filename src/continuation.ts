import { randomUUID } from "node:crypto";

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

export function buildContinuationJsonl(input: ContinuationInput): string {
  const {
    originalJsonl,
    fromEntryIndex,
    fromEntryUuid,
    newSessionId,
    sourceSessionId,
    sourceMachineId,
    sourceMachineName,
    previousLocalSessionId,
    targetProjectPath,
    claudeVersion,
  } = input;

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

  const priorLocation = previousLocalSessionId
    ? `live in session \`${previousLocalSessionId}\` on this machine`
    : "are not present on this machine; see the originating machine for context";

  const content =
    `[sesh-mover continuation]\n` +
    `This session continues session \`${sourceSessionId}\` from machine \`${sourceMachineName}\` (\`${sourceMachineId}\`). ` +
    `The earlier ${previousCount} message(s) ${priorLocation}. ` +
    `The entries below are the ${newCount} new message(s) appended on the other machine since the last sync.`;

  const header = {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: newSessionId,
    cwd: targetProjectPath ?? "",
    version: claudeVersion,
    type: "user",
    message: { role: "user", content },
  };

  return [JSON.stringify(header), ...sliced].join("\n") + "\n";
}
