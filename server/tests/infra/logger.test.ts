import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createLogger } from "../../src/infra/logger.js"
import type { Logger, LogEvent } from "@atelier/core"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

describe("createLogger", () => {
  let logDir: string
  let logger: ReturnType<typeof createLogger>

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-log-test-"))
  })

  afterEach(async () => {
    await logger?.flush()
    fs.rmSync(logDir, { recursive: true, force: true })
  })

  it("creates a logger that writes JSONL to the log directory", async () => {
    logger = createLogger({ logDir })
    logger.info("atelier", "pipeline", "pipeline_created", { pipelineId: "p1", data: { prompt: "test" } })
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    expect(files.length).toBeGreaterThanOrEqual(1)

    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim()
    const lines = content.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(1)

    const event = JSON.parse(lines[0])
    expect(event.level).toBe("info")
    expect(event.layer).toBe("atelier")
    expect(event.category).toBe("pipeline")
    expect(event.action).toBe("pipeline_created")
    expect(event.pipelineId).toBe("p1")
    expect(event.data.prompt).toBe("test")
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(event.seq).toBe(1)
    expect(event.source).toBeUndefined() // not bound yet
  })

  it("assigns monotonically increasing seq numbers", async () => {
    logger = createLogger({ logDir })
    logger.info("atelier", "pipeline", "pipeline_created")
    logger.debug("atelier", "stage", "stage_started")
    logger.error("atelier", "stage", "stage_idle_error", { error: "timeout" })
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    const lines = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim().split("\n")
    const seqs = lines.map(l => JSON.parse(l).seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it("child() pre-binds context fields", async () => {
    logger = createLogger({ logDir })
    const child = logger.child({ pipelineId: "p1", source: "orchestrator" })
    child.info("atelier", "pipeline", "pipeline_created")
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    const line = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim()
    const event = JSON.parse(line)
    expect(event.pipelineId).toBe("p1")
    expect(event.source).toBe("orchestrator")
  })

  it("child() bindings can be overridden per-call", async () => {
    logger = createLogger({ logDir })
    const child = logger.child({ pipelineId: "p1", source: "orchestrator" })
    child.info("atelier", "stage", "stage_started", { pipelineId: "override" })
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    const line = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim()
    const event = JSON.parse(line)
    expect(event.pipelineId).toBe("override")
  })

  it("truncates string values in data to 4KB", async () => {
    logger = createLogger({ logDir })
    const longString = "x".repeat(8192)
    logger.info("atelier", "stage", "stage_idle_error", { error: "test", data: { message: longString } })
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    const line = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim()
    const event = JSON.parse(line)
    expect(event.data.message.length).toBeLessThanOrEqual(4096 + 20) // allow for truncation marker
  })

  it("convenience methods fix the level", async () => {
    logger = createLogger({ logDir })
    logger.error("atelier", "pipeline", "pipeline_idle_error")
    logger.info("atelier", "pipeline", "pipeline_created")
    logger.debug("atelier", "stage", "stage_started")
    logger.trace("opencode", "session", "session_busy")
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    const lines = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim().split("\n")
    expect(lines.map(l => JSON.parse(l).level)).toEqual(["error", "info", "debug", "trace"])
  })

  it("notifies onEvent subscribers with LogEvent objects", async () => {
    logger = createLogger({ logDir })
    const received: LogEvent[] = []
    logger.onEvent((event) => received.push(event))
    logger.info("atelier", "pipeline", "pipeline_created", { pipelineId: "p1" })

    expect(received).toHaveLength(1)
    expect(received[0].action).toBe("pipeline_created")
    expect(received[0].pipelineId).toBe("p1")
  })

  it("cleanupOldLogs deletes files >7 days old and preserves younger files", async () => {
    // Create a "young" log file and an "old" log file before logger construction
    const youngPath = path.join(logDir, "young.log")
    const oldPath = path.join(logDir, "old.log")
    fs.writeFileSync(youngPath, "young\n")
    fs.writeFileSync(oldPath, "old\n")

    // Set old file mtime to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    fs.utimesSync(oldPath, eightDaysAgo, eightDaysAgo)

    // Creating the logger triggers cleanup
    logger = createLogger({ logDir })

    expect(fs.existsSync(youngPath)).toBe(true)
    expect(fs.existsSync(oldPath)).toBe(false)
  })
})
