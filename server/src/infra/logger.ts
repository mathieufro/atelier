import type { Logger as LoggerInterface, LogEvent, LogLevel } from "@atelier/core"
import { workspaceHash } from "@atelier/core/state-dir"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/** Max length for string values in the data field. */
const MAX_DATA_STRING_LENGTH = 4096

/** Truncate string values in a shallow object to MAX_DATA_STRING_LENGTH. */
function truncateData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > MAX_DATA_STRING_LENGTH) {
      result[key] = value.slice(0, MAX_DATA_STRING_LENGTH) + "... (truncated)"
    } else {
      result[key] = value
    }
  }
  return result
}

export interface CreateLoggerOptions {
  /** Directory to write log files. If not provided, uses $TMPDIR/atelier/logs/<workspace-hash>/ */
  logDir?: string
  /** Workspace path — used to compute the log directory hash when logDir is not provided */
  workspacePath?: string
}

export interface ServerLogger extends LoggerInterface {
  /** Flush pending writes to disk without closing the file descriptor. */
  flush(): Promise<void>
  /** Close the log file descriptor. Call once during final shutdown after flush(). */
  close(): void
  /** Subscribe to log events (for SSE transport). Returns unsubscribe function. */
  onEvent(handler: (event: LogEvent) => void): () => void
}

/** Resolve the log directory path. */
function resolveLogDir(options: CreateLoggerOptions): string {
  if (options.logDir) return options.logDir
  const hash = options.workspacePath ? workspaceHash(options.workspacePath) : "default"
  return path.join(os.tmpdir(), "atelier", "logs", hash)
}

/** Delete log files older than 7 days. */
function cleanupOldLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const file of fs.readdirSync(logDir)) {
      if (!file.endsWith(".log")) continue
      const filePath = path.join(logDir, file)
      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath)
      } catch { /* skip files that can't be stat'd/deleted */ }
    }
  } catch { /* log dir doesn't exist yet — nothing to clean */ }
}

export function createLogger(options: CreateLoggerOptions = {}): ServerLogger {
  const logDir = resolveLogDir(options)

  // Ensure log directory exists
  fs.mkdirSync(logDir, { recursive: true })

  // Run cleanup on creation (server startup)
  cleanupOldLogs(logDir)

  // Direct file writes — simple, synchronous, Bun-compatible.
  // pino-roll would add rotation but at Atelier's event volume (~30 events/sec max)
  // a single file with daily rotation via filename is sufficient.
  const destPath = path.join(logDir, "atelier.log")
  const fd = fs.openSync(destPath, "a")

  let seq = 0
  const eventSubscribers: Array<(event: LogEvent) => void> = []

  function buildEvent(
    level: LogLevel,
    layer: LogEvent["layer"],
    category: LogEvent["category"],
    action: string,
    bindings: Partial<LogEvent>,
    context?: Partial<LogEvent>,
  ): LogEvent {
    const event: LogEvent = {
      ts: new Date().toISOString(),
      seq: ++seq,
      level,
      layer,
      category,
      action,
      source: context?.source ?? bindings.source ?? "",
      pipelineId: context?.pipelineId ?? bindings.pipelineId,
      stageId: context?.stageId ?? bindings.stageId,
      stageName: context?.stageName ?? bindings.stageName,
      sessionId: context?.sessionId ?? bindings.sessionId,
      data: context?.data ? truncateData(context.data) : truncateData(bindings.data),
      error: context?.error ?? bindings.error,
    }
    // Strip undefined optional fields for clean JSONL output
    const eventRecord = event as unknown as Record<string, unknown>
    for (const key of Object.keys(event) as (keyof LogEvent)[]) {
      if (event[key] === undefined) delete eventRecord[key]
    }
    // Strip empty source
    if (event.source === "") delete eventRecord.source
    return event
  }

  function createChild(parentBindings: Partial<LogEvent>): ServerLogger {
    const logger: ServerLogger = {
      log(level, layer, category, action, context?) {
        const event = buildEvent(level, layer, category, action, parentBindings, context)
        // Write JSONL directly to the file
        try {
          fs.writeSync(fd, JSON.stringify(event) + "\n")
        } catch { /* file transport errors must not block pipeline execution */ }
        // Notify SSE subscribers (synchronous, <1μs per subscriber)
        for (const sub of eventSubscribers) {
          try { sub(event) } catch { /* subscriber errors must not block */ }
        }
      },
      error(layer, category, action, context?) { logger.log("error", layer, category, action, context) },
      warn(layer, category, action, context?) { logger.log("info", layer, category, action, context) },
      info(layer, category, action, context?) { logger.log("info", layer, category, action, context) },
      debug(layer, category, action, context?) { logger.log("debug", layer, category, action, context) },
      trace(layer, category, action, context?) { logger.log("trace", layer, category, action, context) },
      child(bindings) {
        return createChild({ ...parentBindings, ...bindings })
      },
      async flush() {
        try { fs.fsyncSync(fd) } catch { /* best-effort */ }
      },
      close() {
        try { fs.closeSync(fd) } catch { /* best-effort */ }
      },
      onEvent(handler) {
        eventSubscribers.push(handler)
        return () => {
          const i = eventSubscribers.indexOf(handler)
          if (i >= 0) eventSubscribers.splice(i, 1)
        }
      },
    }
    return logger
  }

  return createChild({})
}
