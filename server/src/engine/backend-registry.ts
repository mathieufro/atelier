import type { AgentEngine } from "@atelier/core/agent-engine"
import type { BackendProxy } from "./backend-proxy.js"
import type { BackendId, ModelRef } from "@atelier/core"
import type { Logger } from "@atelier/core"

export class BackendRegistry {
  private engines = new Map<BackendId, AgentEngine>()
  private proxies = new Map<BackendId, BackendProxy>()
  private engineFactories = new Map<BackendId, () => Promise<AgentEngine>>()
  private proxyFactories = new Map<BackendId, () => Promise<BackendProxy>>()
  private initPromises = new Map<string, Promise<unknown>>()
  private log?: Logger

  constructor(logger?: Logger) {
    this.log = logger?.child({ source: "backend-registry" })
  }

  resolveBackend(model: ModelRef): BackendId {
    const result = model.providerID === "anthropic" ? "claude-code" : "opencode"
    this.log?.debug("atelier", "server", "backend_resolved", { data: { providerID: model.providerID, backendId: result } })
    return result
  }

  registerEngine(backendId: BackendId, engine: AgentEngine): void {
    this.engines.set(backendId, engine)
  }

  registerProxy(backendId: BackendId, proxy: BackendProxy): void {
    this.proxies.set(backendId, proxy)
  }

  registerEngineFactory(backendId: BackendId, factory: () => Promise<AgentEngine>): void {
    this.engineFactories.set(backendId, factory)
  }

  registerProxyFactory(backendId: BackendId, factory: () => Promise<BackendProxy>): void {
    this.proxyFactories.set(backendId, factory)
  }

  async getEngine(backendId: BackendId): Promise<AgentEngine> {
    const cached = this.engines.get(backendId)
    if (cached) {
      this.log?.debug("atelier", "server", "engine_cache_hit", { data: { backendId } })
      return cached
    }

    const key = `engine:${backendId}`
    const existing = this.initPromises.get(key)
    if (existing) return existing as Promise<AgentEngine>

    const factory = this.engineFactories.get(backendId)
    if (!factory) throw new Error(`Backend "${backendId}" is not registered`)

    this.log?.debug("atelier", "server", "engine_factory_started", { data: { backendId } })
    const promise = factory().then((engine) => {
      this.engines.set(backendId, engine)
      this.initPromises.delete(key)
      this.log?.debug("atelier", "server", "engine_factory_completed", { data: { backendId } })
      return engine
    }).catch((err) => {
      this.initPromises.delete(key)
      throw err
    })
    this.initPromises.set(key, promise)
    return promise
  }

  async getProxy(backendId: BackendId): Promise<BackendProxy> {
    const cached = this.proxies.get(backendId)
    if (cached) {
      this.log?.debug("atelier", "server", "proxy_cache_hit", { data: { backendId } })
      return cached
    }

    const key = `proxy:${backendId}`
    const existing = this.initPromises.get(key)
    if (existing) return existing as Promise<BackendProxy>

    const factory = this.proxyFactories.get(backendId)
    if (!factory) throw new Error(`Backend "${backendId}" proxy is not registered`)

    this.log?.debug("atelier", "server", "proxy_factory_started", { data: { backendId } })
    const promise = factory().then((proxy) => {
      this.proxies.set(backendId, proxy)
      this.initPromises.delete(key)
      this.log?.debug("atelier", "server", "proxy_factory_completed", { data: { backendId } })
      return proxy
    }).catch((err) => {
      this.initPromises.delete(key)
      throw err
    })
    this.initPromises.set(key, promise)
    return promise
  }

  getEngineIfReady(backendId: BackendId): AgentEngine | null {
    return this.engines.get(backendId) ?? null
  }

  getProxyIfReady(backendId: BackendId): BackendProxy | null {
    return this.proxies.get(backendId) ?? null
  }

  listReadyBackends(): BackendId[] {
    const ready: BackendId[] = []
    for (const id of this.engines.keys()) {
      if (this.proxies.has(id)) ready.push(id)
    }
    return ready
  }

  /** Returns true if any backend can serve requests (instantiated or has a lazy factory). */
  hasAnyBackend(): boolean {
    return this.engines.size > 0 || this.engineFactories.size > 0
  }

  /** All registered backend IDs (both ready and lazy factories). */
  listAllBackendIds(): BackendId[] {
    const ids = new Set<BackendId>([...this.engines.keys(), ...this.engineFactories.keys()])
    return [...ids]
  }

  private metadataStore: { getBackendForSession(id: string): BackendId | null } | null = null

  setMetadataStore(store: { getBackendForSession(id: string): BackendId | null }): void {
    this.metadataStore = store
  }

  resolveBackendForSession(sessionId: string): BackendId | null {
    const result = this.metadataStore?.getBackendForSession(sessionId) ?? null
    this.log?.debug("atelier", "session", "session_backend_lookup", { sessionId, data: { backendId: result } })
    return result
  }
}
