// extension/tests/rpc-edge-cases.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRpc } from "@atelier/ui/rpc"

describe("RPC Edge Cases", () => {
  let posted: Array<Record<string, unknown>>
  let rpc: ReturnType<typeof createRpc>

  beforeEach(() => {
    vi.useFakeTimers()
    posted = []
    rpc = createRpc((msg) => posted.push(msg))
  })

  afterEach(() => {
    rpc.dispose()
    vi.useRealTimers()
  })

  it("44. RPC timeout — request times out after 30s", async () => {
    const promise = rpc.request({ type: "send" })
    // Advance past the 30s timeout
    vi.advanceTimersByTime(31_000)
    await expect(promise).rejects.toThrow("Request timed out")
    // Verify the request was sent
    expect(posted).toHaveLength(1)
    expect(posted[0]._rpcId).toBeDefined()
  })

  it("45. concurrent RPCs — each resolved independently via UUID matching", async () => {
    const p1 = rpc.request({ type: "sessions" })
    const p2 = rpc.request({ type: "config" })
    const p3 = rpc.request({ type: "messages" })

    // Each should get a unique _rpcId
    const ids = posted.map(m => m._rpcId as string)
    expect(new Set(ids).size).toBe(3)

    // Resolve them out of order
    rpc.handleResponse({ type: "_rpc", _rpcId: ids[2], data: "third" })
    rpc.handleResponse({ type: "_rpc", _rpcId: ids[0], data: "first" })
    rpc.handleResponse({ type: "_rpc", _rpcId: ids[1], data: "second" })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect((r1 as any).data).toBe("first")
    expect((r2 as any).data).toBe("second")
    expect((r3 as any).data).toBe("third")
  })

  it("46. RPC response mismatch — unknown _rpcId silently ignored", async () => {
    // Send an RPC response with a _rpcId that doesn't match any pending request
    const consumed = rpc.handleResponse({ type: "_rpc", _rpcId: "unknown-id", data: "stale" })
    // Should return false (not consumed) — no crash, no unhandled rejection
    expect(consumed).toBe(false)
  })
})
