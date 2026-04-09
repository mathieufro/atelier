import type { AgentPart } from "@atelier/core"

export function AgentPartView(props: { part: AgentPart }) {
  return (
    <div class="text-sm text-vsc-description-fg">
      Agent: <span class="font-mono">{props.part.name}</span>
    </div>
  )
}
