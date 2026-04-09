/**
 * Push-based async iterable for bridging user messages to the Claude Agent SDK.
 * Push side pushes messages; iteration side pulls them as an async iterator.
 * Thread-safe within a single JS event loop (no mutex needed).
 */
export class AsyncChannel<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  private iteratorCreated = false

  push(value: T): void {
    if (this.closed) return
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter({ value, done: false })
    } else {
      this.queue.push(value)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) {
      waiter({ value: undefined as unknown as T, done: true })
    }
    this.waiters.length = 0
  }

  /** Whether there are queued messages waiting to be consumed. */
  get hasQueued(): boolean {
    return this.queue.length > 0
  }

  /** Discard all queued messages (for explicit user abort — stop everything). */
  drain(): void {
    this.queue.length = 0
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorCreated) throw new Error("AsyncChannel supports only one consumer")
    this.iteratorCreated = true
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false as const })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true as const })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}
