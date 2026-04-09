import type { PermissionRequest } from "@atelier/core"

export function PermissionBanner(props: {
  request: PermissionRequest
  onReply: (sessionId: string, id: string, reply: "once" | "always" | "reject") => void
}) {
  return (
    <div class="bg-vsc-input-bg border border-vsc-panel-border rounded-lg p-3 mx-4 mb-2">
      <div class="text-sm text-vsc-warning mb-2">
        Permission requested: <span class="font-mono">{props.request.permission}</span>
      </div>
      <div class="flex gap-2">
        <button class="px-3 py-1 text-xs bg-vsc-success text-vsc-button-fg rounded hover:opacity-90" onClick={() => props.onReply(props.request.sessionID, props.request.id, "once")}>Allow</button>
        <button class="px-3 py-1 text-xs bg-vsc-button-bg text-vsc-button-fg rounded hover:opacity-90" onClick={() => props.onReply(props.request.sessionID, props.request.id, "always")}>Always</button>
        <button class="px-3 py-1 text-xs bg-vsc-error text-vsc-button-fg rounded hover:opacity-90" onClick={() => props.onReply(props.request.sessionID, props.request.id, "reject")}>Deny</button>
      </div>
    </div>
  )
}
