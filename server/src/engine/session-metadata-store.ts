import * as fs from "node:fs"
import * as path from "node:path"
import type { BackendId, ModelRef } from "@atelier/core"
import type { Logger } from "@atelier/core"

export interface SessionMetadata {
  id: string
  title: string
  backend: BackendId
  model: ModelRef
  variant?: string
  workspacePath: string
  createdAt: number
  lastActiveAt: number
  parentId: string | null
  status: "idle" | "busy"
  /** SDK's own session ID (from system.init) — used for resume */
  sdkSessionId?: string
  /** Skill name when session was created via /skill endpoint */
  skillName?: string
  /** Source session ID when this session was created by forking */
  forkedFrom?: string
}

export class SessionMetadataStore {
  private sessions = new Map<string, SessionMetadata>()
  private filePath: string
  private log?: Logger

  constructor(filePath: string, logger?: Logger) {
    this.filePath = filePath
    this.log = logger?.child({ source: "metadata-store" })
    this.loadFromDisk()
  }

  create(metadata: SessionMetadata): void {
    this.sessions.set(metadata.id, { ...metadata })
    this.log?.debug("atelier", "session", "metadata_created", { sessionId: metadata.id, data: { backend: metadata.backend, model: metadata.model?.modelID } })
    this.saveToDisk()
  }

  update(id: string, patch: Partial<SessionMetadata>): void {
    const existing = this.sessions.get(id)
    if (!existing) return
    Object.assign(existing, patch)
    this.log?.debug("atelier", "session", "metadata_updated", { sessionId: id, data: { fields: Object.keys(patch).join(",") } })
    this.saveToDisk()
  }

  delete(id: string): void {
    this.sessions.delete(id)
    this.log?.debug("atelier", "session", "metadata_deleted", { sessionId: id })
    this.saveToDisk()
  }

  get(id: string): SessionMetadata | null {
    return this.sessions.get(id) ?? null
  }

  listRootSessions(workspacePath: string): SessionMetadata[] {
    const results: SessionMetadata[] = []
    for (const meta of this.sessions.values()) {
      if (meta.parentId === null && meta.workspacePath === workspacePath) {
        results.push(meta)
      }
    }
    return results
  }

  getBackendForSession(id: string): BackendId | null {
    return this.sessions.get(id)?.backend ?? null
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (SessionMetadataStore.isValidMetadata(entry)) {
            this.sessions.set(entry.id, entry)
          }
        }
      }
      this.log?.debug("atelier", "session", "metadata_loaded_from_disk", { data: { count: this.sessions.size } })
    } catch {
      // File missing or corrupt — start with empty store
    }
  }

  private static isValidMetadata(entry: unknown): entry is SessionMetadata {
    if (typeof entry !== "object" || entry === null) return false
    const e = entry as Record<string, unknown>
    return typeof e.id === "string" &&
      typeof e.backend === "string" &&
      typeof e.workspacePath === "string"
  }

  private writeChain: Promise<void> = Promise.resolve()

  flush(): Promise<void> { return this.writeChain }

  private saveToDisk(): void {
    const snapshot = JSON.stringify([...this.sessions.values()], null, 2)
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.dirname(this.filePath)
      await fs.promises.mkdir(dir, { recursive: true })
      const tmpPath = this.filePath + `.${process.pid}.tmp`
      await fs.promises.writeFile(tmpPath, snapshot, "utf-8")
      await fs.promises.rename(tmpPath, this.filePath)
    }).catch((err) => {
      this.log?.error("atelier", "session", "metadata_write_error", { error: String(err) })
    })
  }
}
