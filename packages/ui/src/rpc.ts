import { debug } from "./debug.js"

type PendingRequest = { resolve: (data: unknown) => void; reject: (err: Error) => void }

export function createRpc(post: (msg: Record<string, unknown>) => void) {
  const pending = new Map<string, PendingRequest>()

  function request(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const _rpcId = crypto.randomUUID()
    const type = msg.type as string
    debug("rpc_request", { id: _rpcId, type })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(_rpcId)
        debug("rpc_timeout", { id: _rpcId, type })
        reject(new Error("Request timed out"))
      }, timeoutMs)
      pending.set(_rpcId, {
        resolve: (data) => { clearTimeout(timer); debug("rpc_response", { id: _rpcId }); resolve(data) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      post({ ...msg, _rpcId })
    })
  }

  /** Handle an incoming host message. Returns true if consumed by the RPC layer. */
  function handleResponse(msg: Record<string, unknown>): boolean {
    if (msg.type !== "_rpc" || !msg._rpcId) return false
    const req = pending.get(msg._rpcId as string)
    if (!req) return false
    pending.delete(msg._rpcId as string)
    if (msg.error) req.reject(new Error(msg.error as string))
    else req.resolve(msg)
    return true
  }

  /** Reject all pending requests and clear timers. */
  function dispose() {
    for (const [id, req] of pending) {
      req.reject(new Error("RPC disposed"))
    }
    pending.clear()
  }

  return { request, handleResponse, dispose }
}
