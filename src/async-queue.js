export class AsyncQueueClosedError extends Error {
    constructor() {
        super('Async queue is closed');
        this.name = 'AsyncQueueClosedError';
    }
}
export class AsyncQueue {
    #values = [];
    #pending = [];
    #closed = false;
    #failure;
    get closed() {
        return this.#closed;
    }
    push(value) {
        if (this.#closed)
            throw new AsyncQueueClosedError();
        const waiter = this.#pending.shift();
        if (waiter !== undefined)
            waiter.resolve({ value, done: false });
        else
            this.#values.push(value);
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const waiter of this.#pending.splice(0))
            waiter.resolve({ value: undefined, done: true });
    }
    fail(error) {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#failure = error;
        for (const waiter of this.#pending.splice(0))
            waiter.reject(error);
    }
    discard(error) {
        this.#values.splice(0);
        if (this.#closed)
            return;
        this.#closed = true;
        if (error === undefined) {
            for (const waiter of this.#pending.splice(0))
                waiter.resolve({ value: undefined, done: true });
            return;
        }
        this.#failure = error;
        for (const waiter of this.#pending.splice(0))
            waiter.resolve({ value: undefined, done: true });
    }
    next() {
        const value = this.#values.shift();
        if (value !== undefined)
            return Promise.resolve({ value, done: false });
        if (this.#closed) {
            return this.#failure === undefined
                ? Promise.resolve({ value: undefined, done: true })
                : Promise.reject(this.#failure);
        }
        return new Promise((resolve, reject) => {
            this.#pending.push({ resolve, reject });
        });
    }
    return() {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
        return this;
    }
}
//# sourceMappingURL=async-queue.js.map