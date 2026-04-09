import { describe, it, expect, vi } from "vitest"
import { wireClientToWebview } from "../src/extension-wiring.js"

describe("test_command event handling in wireClientToWebview", () => {
  it("does not forward test_command events to webview", () => {
    const posted: any[] = []
    let eventHandler: ((event: any) => void) | null = null

    const mockClient = {
      onEvent: vi.fn((handler: any) => {
        eventHandler = handler
        return () => {}
      }),
      onConnectionStateChange: vi.fn(() => () => {}),
      onRefreshNeeded: vi.fn(() => () => {}),
    }

    wireClientToWebview(mockClient as any, (msg) => posted.push(msg))

    eventHandler!({ type: "test_command", command: "atelier.openChat", seq: 1 })

    expect(posted).toHaveLength(0)
  })

  it("still forwards regular events to webview", () => {
    const posted: any[] = []
    let eventHandler: ((event: any) => void) | null = null

    const mockClient = {
      onEvent: vi.fn((handler: any) => {
        eventHandler = handler
        return () => {}
      }),
      onConnectionStateChange: vi.fn(() => () => {}),
      onRefreshNeeded: vi.fn(() => () => {}),
    }

    wireClientToWebview(mockClient as any, (msg) => posted.push(msg))

    eventHandler!({ type: "stage_started", pipelineId: "p1", seq: 3 })

    expect(posted).toHaveLength(1)
    expect(posted[0].event.type).toBe("stage_started")
  })
})
