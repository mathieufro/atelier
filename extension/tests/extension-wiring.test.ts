import { describe, it, expect, vi } from "vitest"
import { wireClientToWebview } from "../src/extension-wiring.js"

describe("Extension SSE event forwarding", () => {
  it("client.onEvent forwards events to webview via postMessage", () => {
    const posted: any[] = []
    const mockClient = {
      onEvent: vi.fn((handler: any) => {
        handler({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", seq: 1 })
        return () => {}
      }),
      onConnectionStateChange: vi.fn(() => () => {}),
      onRefreshNeeded: vi.fn(() => () => {}),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    const postMessage = (msg: any) => posted.push(msg)

    wireClientToWebview(mockClient as any, postMessage)

    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe("event")
    expect(posted[0].event.type).toBe("stage_started")
  })

  it("connection state changes are forwarded as connectionState HostMessage", () => {
    const posted: any[] = []
    const mockClient = {
      onEvent: vi.fn(() => () => {}),
      onConnectionStateChange: vi.fn((handler: any) => {
        handler("reconnecting")
        return () => {}
      }),
      onRefreshNeeded: vi.fn(() => () => {}),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    const postMessage = (msg: any) => posted.push(msg)

    wireClientToWebview(mockClient as any, postMessage)

    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe("connectionState")
    expect(posted[0].state).toBe("reconnecting")
  })

  it("returns cleanup function that unsubscribes", () => {
    const unsubEvent = vi.fn()
    const unsubState = vi.fn()
    const unsubRefresh = vi.fn()
    const mockClient = {
      onEvent: vi.fn(() => unsubEvent),
      onConnectionStateChange: vi.fn(() => unsubState),
      onRefreshNeeded: vi.fn(() => unsubRefresh),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }

    const cleanup = wireClientToWebview(mockClient as any, () => {})
    cleanup()

    expect(unsubEvent).toHaveBeenCalled()
    expect(unsubState).toHaveBeenCalled()
    expect(unsubRefresh).toHaveBeenCalled()
  })
})
