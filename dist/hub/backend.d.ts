export declare class HubNotSyncedError extends Error {
    readonly missing: string[];
    constructor(missing: string[]);
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
export declare function createFsBackend(rootDir: string): HubBackend;
//# sourceMappingURL=backend.d.ts.map