/** Severity levels in decreasing order of importance */
export const LOG_LEVELS = ["error", "info", "debug", "trace"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface LogEvent {
  /** ISO-8601 timestamp with millisecond precision */
  ts: string
  /** Monotonically increasing sequence number */
  seq: number
  /** Severity level */
  level: LogLevel
  /** Which system layer produced this event */
  layer: "atelier" | "opencode"
  /** Functional grouping within the layer */
  category:
    | "pipeline" | "stage" | "compile" | "signal" | "watchdog"
    | "message" | "recovery" | "server"
    | "session" | "assistant" | "tool" | "git" | "idle_detector"
  /** Specific action that occurred */
  action: string
  /** What component/subsystem produced this event */
  source: string
  /** Pipeline context */
  pipelineId?: string
  /** Stage context */
  stageId?: string
  /** Stage name for human readability */
  stageName?: string
  /** OpenCode session context */
  sessionId?: string
  /** Action-specific payload */
  data?: Record<string, unknown>
  /** Error message for error-level events */
  error?: string
}

export interface LogFilter {
  level?: LogLevel
  layer?: LogEvent["layer"]
  category?: LogEvent["category"]
  pipelineId?: string
  sessionId?: string
  source?: string
}

/** Index of level in LOG_LEVELS — lower index = higher severity */
function levelIndex(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level)
}

/** Returns true if `eventLevel` is at or above `threshold` in severity. */
export function meetsLevel(eventLevel: LogLevel, threshold: LogLevel): boolean {
  return levelIndex(eventLevel) <= levelIndex(threshold)
}

/** Pure filter function: returns events matching all specified criteria. */
export function filterEvents(events: LogEvent[], filter: LogFilter): LogEvent[] {
  return events.filter(e => {
    if (filter.level && !meetsLevel(e.level, filter.level)) return false
    if (filter.layer && e.layer !== filter.layer) return false
    if (filter.category && e.category !== filter.category) return false
    if (filter.pipelineId && e.pipelineId !== filter.pipelineId) return false
    if (filter.sessionId && e.sessionId !== filter.sessionId) return false
    if (filter.source && e.source !== filter.source) return false
    return true
  })
}

/**
 * Logger interface — generic log method with level shorthands and child bindings.
 * Core package provides the interface only; implementation lives in server/.
 */
export interface Logger {
  log(level: LogLevel, layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  error(layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  warn(layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  info(layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  debug(layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  trace(layer: LogEvent["layer"], category: LogEvent["category"], action: string, context?: Partial<LogEvent>): void
  /** Returns a child logger with context fields pre-bound. */
  child(bindings: Partial<Pick<LogEvent, "pipelineId" | "stageId" | "stageName" | "sessionId" | "source">>): Logger
}

/** No-op logger for tests and optional injection. */
export const noopLogger: Logger = {
  log() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() { return noopLogger },
}
