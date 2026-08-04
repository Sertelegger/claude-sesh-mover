export declare function readFirstJsonlLine(path: string): string | null;
export declare function readLastJsonlLine(path: string): string | null;
export declare function countJsonlLines(path: string): number;
export declare function readLastEntryUuid(path: string): string | null;
export declare function readEntryUuids(jsonlPath: string): Promise<Array<{
    uuid: string;
}>>;
export declare function findEntryOffsetByUuid(jsonlPath: string, uuid: string): Promise<number | null>;
//# sourceMappingURL=jsonl.d.ts.map