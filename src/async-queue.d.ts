export declare class AsyncQueueClosedError extends Error {
    constructor();
}
export declare class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
    #private;
    get closed(): boolean;
    push(value: T): void;
    close(): void;
    fail(error: unknown): void;
    discard(error?: unknown): void;
    next(): Promise<IteratorResult<T>>;
    return(): Promise<IteratorResult<T>>;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=async-queue.d.ts.map