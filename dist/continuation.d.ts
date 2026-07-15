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
export declare function buildContinuationJsonl(input: ContinuationInput): string;
export interface ContinuationStreamInput extends Omit<ContinuationInput, "originalJsonl"> {
    sourceJsonlPath: string;
    outputPath: string;
}
export declare function buildContinuationStream(input: ContinuationStreamInput): Promise<{
    entryCount: number;
    integrityHash: string;
}>;
//# sourceMappingURL=continuation.d.ts.map