import { createApp, type AppOptions } from "@atelier/server/app"
import { createEventMerger } from "@atelier/server/engine/event-merger"
import { BackendRegistry } from "@atelier/server/engine/backend-registry"
import { SessionMetadataStore } from "@atelier/server/engine/session-metadata-store"
import { RalphLoopController } from "@atelier/server/ralph-loop-controller"
import { TestAgentEngine, type ScenarioStep } from "./test-agent-engine.js"
import { TestBackendProxy } from "./test-backend-proxy.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface TestHarness {
  engine: TestAgentEngine
  proxy: TestBackendProxy
  eventMerger: ReturnType<typeof createEventMerger>
  app: ReturnType<typeof createApp>
  events: Array<Record<string, unknown>>
  registry: BackendRegistry
  ralphController: RalphLoopController
  /** The temp workspace directory used by the harness. */
  workspacePath: string
  /** Wait until at least `count` events have been captured, or timeout. */
  waitForEvents(count: number, timeoutMs?: number): Promise<void>
  teardown(): Promise<void>
}

export async function createTestHarness(
  scenario: ScenarioStep[],
  opts?: {
    proxy?: TestBackendProxy
    bufferSize?: number
  },
): Promise<TestHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-integ-harness-"))
  const engine = new TestAgentEngine(scenario)
  const proxy = opts?.proxy ?? new TestBackendProxy()
  const eventMerger = createEventMerger({ bufferSize: opts?.bufferSize ?? 300 })
  const registry = new BackendRegistry()
  const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))

  engine.metadataStore = metadataStore
  registry.registerProxy("opencode", proxy)
  registry.registerEngine("opencode", engine)

  const ralphController = new RalphLoopController(eventMerger)

  // Wire engine events → EventMerger
  // IMPORTANT: forwardEvent() normalizes AtelierEvent types through normalizeForUI()
  // producing events with shape { type, properties, seq }. If this path changes,
  // all event shape assertions in Tasks 4-6 will need updating.
  engine.onEvent((event) => {
    eventMerger.forwardEvent(event)
  })

  const app = createApp({
    registry,
    metadataStore,
    workspacePath: tmpDir,
    eventMerger,
    ralphController,
    getOrchestrator: () => null,
    getStatus: () => "ready",
  })

  const events: Array<Record<string, unknown>> = []
  const unsubscribe = eventMerger.subscribe((event) => {
    events.push(event)
  })

  return {
    engine,
    proxy,
    eventMerger,
    app,
    events,
    registry,
    ralphController,
    workspacePath: tmpDir,
    async waitForEvents(count: number, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (events.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async teardown() {
      unsubscribe()
      eventMerger.stopThrottle()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
