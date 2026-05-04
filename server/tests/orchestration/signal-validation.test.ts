import { describe, it, expect, vi } from "vitest"
import { createApp, type AppOptions } from "../../src/app.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import { BackendRegistry } from "../../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

function makeApp(captured: any[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-validation-"))
  const registry = new BackendRegistry()
  const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
  registry.setMetadataStore(metadataStore)

  const stub = {
    handleSignal: async (sig: any) => { captured.push(sig) },
  } as any

  const opts: AppOptions = {
    registry,
    metadataStore,
    workspacePath: tmpDir,
    eventMerger: createEventMerger(),
    getOrchestrator: () => stub,
    getStatus: () => "ready",
  }
  return createApp(opts)
}

describe("POST /pipeline/signal — verdict: partial", () => {
  it("accepts verdict=partial without rejecting on validation", async () => {
    const captured: any[] = []
    const app = makeApp(captured)

    const res = await app.request("/pipeline/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stage_complete",
        sessionId: "ses_test_123",
        verdict: "partial",
        outputPath: "/tmp/progress.md",
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].verdict).toBe("partial")
  })

  it("rejects unknown verdict 'banana'", async () => {
    const captured: any[] = []
    const app = makeApp(captured)
    const res = await app.request("/pipeline/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "stage_complete",
        sessionId: "ses_test_123",
        verdict: "banana",
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(captured).toHaveLength(0)
  })
})
