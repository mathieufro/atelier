import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/**
 * Atelier settings — persisted to `settings.json` in the per-workspace state dir.
 * The VS Code extension writes this file; the server reads it.
 *
 * All fields are optional — missing fields use defaults.
 */
export interface AtelierSettings {
  /** Fixed port for the Atelier server. `null` or omitted = automatic assignment. */
  serverPort?: number | null
  /** Connect to an external Atelier server URL instead of spawning a local one. */
  serverUrl?: string | null
  /** Enable git branch/commit lifecycle in pipelines. Default: `false`. */
  gitEnabled?: boolean
}

const DEFAULTS: Required<AtelierSettings> = {
  serverPort: null,
  serverUrl: null,
  gitEnabled: false,
}

const SETTINGS_FILENAME = "settings.json"

/** Resolve the settings file path for a given state directory. */
export function settingsPath(stateDir: string): string {
  return path.join(stateDir, SETTINGS_FILENAME)
}

/**
 * Read settings from the state dir.
 * Returns defaults on missing or malformed file — never throws.
 */
export function readSettings(stateDir: string): Required<AtelierSettings> {
  try {
    const raw = fs.readFileSync(settingsPath(stateDir), "utf-8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULTS }
    }
    return {
      serverPort: "serverPort" in parsed && isValidPort(parsed.serverPort) ? (parsed.serverPort ?? null) : DEFAULTS.serverPort,
      serverUrl: typeof parsed.serverUrl === "string" && parsed.serverUrl.trim() ? parsed.serverUrl.trim() : DEFAULTS.serverUrl,
      gitEnabled: typeof parsed.gitEnabled === "boolean" ? parsed.gitEnabled : DEFAULTS.gitEnabled,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Write settings to the state dir (atomic: write tmp then rename).
 * Creates the directory if it doesn't exist.
 */
export function writeSettings(stateDir: string, settings: AtelierSettings): void {
  fs.mkdirSync(stateDir, { recursive: true })
  const filePath = settingsPath(stateDir)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8")
  fs.renameSync(tmpPath, filePath)
}

function isValidPort(value: unknown): value is number | null {
  if (value === null || value === undefined) return true
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
}
