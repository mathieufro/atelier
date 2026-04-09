import * as vscode from "vscode"
import type { LogEvent, LogLevel } from "@atelier/core"
import { LOG_LEVELS } from "@atelier/core"

/** Format a LogEvent for human-readable Output Channel display. */
export function formatLogEvent(event: LogEvent): string {
  // Extract local time HH:MM:SS
  const date = new Date(event.ts)
  const time = date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })

  const level = `[${event.level.toUpperCase()}]`.padEnd(8)

  const parts = [
    `${time} ${level}`,
    event.action,
  ]

  // Add stage name if present
  if (event.stageName) parts.push(`| ${event.stageName}`)

  // Add truncated IDs (8 characters for readability)
  if (event.pipelineId) parts.push(`| pipeline=${event.pipelineId.slice(0, 8)}`)
  if (event.sessionId) parts.push(`| session=${event.sessionId.slice(0, 8)}`)

  // Add error message
  if (event.error) parts.push(`| "${event.error}"`)

  // Add data fields (key=value)
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      if (value !== undefined && value !== null) {
        const str = typeof value === "string" ? value : JSON.stringify(value)
        // Truncate long values
        const display = str.length > 80 ? str.slice(0, 80) + "..." : str
        parts.push(`| ${key}=${display}`)
      }
    }
  }

  return parts.join(" ")
}

export class OutputChannelController {
  private channel: vscode.OutputChannel
  private currentLevel: LogLevel = "info"
  private abortController: AbortController | null = null
  private retries = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private baseUrl: string
  private disposed = false
  /** Generation counter to detect stale reconnection attempts after setLevel. */
  private generation = 0

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.channel = vscode.window.createOutputChannel("Atelier")
  }

  /** Write an extension-side log line directly to the Output Channel. */
  log(level: LogLevel, action: string, detail?: string): void {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    const tag = `[${level.toUpperCase()}]`.padEnd(8)
    const line = detail ? `${time} ${tag} ${action} | ${detail}` : `${time} ${tag} ${action}`
    this.channel.appendLine(line)
  }

  /** Update the server URL (e.g. after server restart). */
  updateBaseUrl(url: string): void {
    this.baseUrl = url
  }

  /** Start subscribing to log events. */
  async connect(): Promise<void> {
    this.disposed = false
    this.retries = 0
    await this.doConnect()
  }

  /** Change the log level filter. Reconnects with the new level. */
  async setLevel(level: LogLevel): Promise<void> {
    const oldLevel = this.currentLevel
    this.currentLevel = level
    this.log("debug", "log_level_changed", `${oldLevel} → ${level}`)
    this.disconnect()
    this.retries = 0
    const gen = ++this.generation
    await this.doConnect(gen)
  }

  getLevel(): LogLevel {
    return this.currentLevel
  }

  /** Stop subscribing and dispose the Output Channel. */
  dispose(): void {
    this.disposed = true
    this.disconnect()
    this.channel.dispose()
  }

  private disconnect(): void {
    this.abortController?.abort()
    this.abortController = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private async doConnect(gen?: number): Promise<void> {
    if (this.disposed || !this.baseUrl) return
    // If a generation was provided, check it is still current
    if (gen !== undefined && gen !== this.generation) return
    this.abortController = new AbortController()

    try {
      this.log("debug", "log_stream_connecting", `${this.baseUrl}/log-events?level=${this.currentLevel}`)
      const res = await fetch(`${this.baseUrl}/log-events?level=${this.currentLevel}`, {
        signal: this.abortController.signal,
      })

      if (!res.ok || !res.body) {
        this.log("debug", "log_stream_failed", `status=${res.status}`)
        this.scheduleReconnect(gen)
        return
      }

      // Check generation again after async fetch
      if (gen !== undefined && gen !== this.generation) return

      this.log("info", "log_stream_connected", `level=${this.currentLevel}`)
      this.retries = 0
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // Bail if generation changed while reading
        if (gen !== undefined && gen !== this.generation) break

        buffer += decoder.decode(value, { stream: true })
        const messages = buffer.split("\n\n")
        buffer = messages.pop()!

        for (const message of messages) {
          if (!message.trim() || message.startsWith(":")) continue

          let data: string | null = null
          for (const line of message.split("\n")) {
            if (line.startsWith("data: ")) data = line.slice(6)
          }
          if (!data) continue

          try {
            const event = JSON.parse(data) as LogEvent
            const formatted = formatLogEvent(event)
            this.channel.appendLine(formatted)

            // Auto-show on error events
            if (event.level === "error") {
              this.channel.show(true) // preserveFocus
            }
          } catch { /* skip malformed */ }
        }
      }

      if (!this.disposed) this.scheduleReconnect(gen)
    } catch {
      if (!this.disposed) this.scheduleReconnect(gen)
    }
  }

  private scheduleReconnect(gen?: number): void {
    if (this.disposed) return
    if (gen !== undefined && gen !== this.generation) return
    const delay = Math.min(1000 * Math.pow(2, this.retries), 30000)
    this.retries++
    this.log("debug", "log_stream_reconnect", `generation=${gen ?? this.generation}`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.disposed) this.doConnect(gen)
    }, delay)
  }
}
