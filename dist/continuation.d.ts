export interface ContinuationInput {
    originalJsonl: string;
    fromEntryIndex: number;
    newSessionId: string;
    sourceSessionId: string;
    sourceMachineId: string;
    sourceMachineName: string;
    previousLocalSessionId?: string;
    targetProjectPath?: string;
    claudeVersion: string;
}
export declare function buildContinuationJsonl(input: ContinuationInput): string;
//# sourceMappingURL=continuation.d.ts.map