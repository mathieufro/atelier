import { describe, it, expect } from "vitest"
import { AsyncChannel } from "../../src/engine/async-channel.js"

describe("AsyncChannel", () => {
  it("delivers pushed messages to async iterator", async () => {
    const channel = new AsyncChannel<string>()
    channel.push("hello")
    channel.push("world")
    channel.close()

    const results: string[] = []
    for await (const msg of channel) {
      results.push(msg)
    }
    expect(results).toEqual(["hello", "world"])
  })

  it("delivers message immediately when iterator is waiting", async () => {
    const channel = new AsyncChannel<string>()

    const iterPromise = (async () => {
      const results: string[] = []
      for await (const msg of channel) {
        results.push(msg)
        if (results.length === 2) break
      }
      return results
    })()

    // Push after iterator is waiting
    await Promise.resolve() // yield to let iterator start
    channel.push("first")
    await Promise.resolve()
    channel.push("second")

    const results = await iterPromise
    expect(results).toEqual(["first", "second"])
  })

  it("queues messages when iterator is not consuming", async () => {
    const channel = new AsyncChannel<string>()
    channel.push("a")
    channel.push("b")
    channel.push("c")

    // Now start consuming
    const iter = channel[Symbol.asyncIterator]()
    const r1 = await iter.next()
    expect(r1.value).toBe("a")
    const r2 = await iter.next()
    expect(r2.value).toBe("b")
    const r3 = await iter.next()
    expect(r3.value).toBe("c")

    // Close and verify done
    channel.close()
    const r4 = await iter.next()
    expect(r4.done).toBe(true)
  })

  it("close causes pending next() to resolve with done", async () => {
    const channel = new AsyncChannel<string>()
    const iter = channel[Symbol.asyncIterator]()

    const pending = iter.next()
    channel.close()

    const result = await pending
    expect(result.done).toBe(true)
  })

  it("push after close is silently dropped", async () => {
    const channel = new AsyncChannel<string>()
    channel.push("before")
    channel.close()
    channel.push("after") // should not throw

    const results: string[] = []
    for await (const msg of channel) {
      results.push(msg)
    }
    expect(results).toEqual(["before"])
  })

  it("throws on second iterator creation (single consumer guard)", () => {
    const channel = new AsyncChannel<string>()
    channel[Symbol.asyncIterator]() // first — ok
    expect(() => channel[Symbol.asyncIterator]()).toThrow("AsyncChannel supports only one consumer")
  })

  it("supports multiple concurrent waiters via same iterator", async () => {
    const channel = new AsyncChannel<number>()
    const iter = channel[Symbol.asyncIterator]()

    // Two concurrent next() calls
    const p1 = iter.next()
    const p2 = iter.next()

    channel.push(1)
    channel.push(2)

    const r1 = await p1
    const r2 = await p2
    expect(r1.value).toBe(1)
    expect(r2.value).toBe(2)
  })
})
