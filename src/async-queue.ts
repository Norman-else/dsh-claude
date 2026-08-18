export class AsyncQueueClosedError extends Error {
  constructor() {
    super('Async queue is closed')
    this.name = 'AsyncQueueClosedError'
  }
}

interface Pending<T> {
  resolve: (result: IteratorResult<T>) => void
  reject: (error: unknown) => void
}

export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = []
  readonly #pending: Pending<T>[] = []
  #closed = false
  #failure: unknown

  get closed(): boolean {
    return this.#closed
  }

  push(value: T): void {
    if (this.#closed) throw new AsyncQueueClosedError()
    const waiter = this.#pending.shift()
    if (waiter !== undefined) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#pending.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    for (const waiter of this.#pending.splice(0)) waiter.reject(error)
  }

  discard(error?: unknown): void {
    this.#values.splice(0)
    if (this.#closed) return
    this.#closed = true
    if (error === undefined) {
      for (const waiter of this.#pending.splice(0)) waiter.resolve({ value: undefined, done: true })
      return
    }
    this.#failure = error
    for (const waiter of this.#pending.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.#closed) {
      return this.#failure === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.#failure)
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#pending.push({ resolve, reject })
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
