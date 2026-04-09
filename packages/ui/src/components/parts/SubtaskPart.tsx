import { createSignal, Show } from "solid-js"
import type { SubtaskPart } from "@atelier/core"
import { ChevronIcon } from "./ToolPart.jsx"

interface SubtaskPartProps {
  part: SubtaskPart
}

export function SubtaskPartView(props: SubtaskPartProps) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div>
      <button class="flex items-center gap-2 w-full text-sm leading-5" onClick={() => setExpanded((e) => !e)}>
        <span class="text-vsc-editor-fg font-mono">{props.part.agent}</span>
        <span class="text-vsc-disabled-fg text-xs truncate">{props.part.description}</span>
        <ChevronIcon expanded={expanded()} class="ml-auto shrink-0 text-vsc-disabled-fg" />
      </button>
      <Show when={expanded()}>
        <div class="mt-1 rounded-lg bg-vsc-sidebar-bg overflow-hidden">
          <div class="px-3 py-2 text-xs text-vsc-description-fg whitespace-pre-wrap">{props.part.prompt}</div>
        </div>
      </Show>
    </div>
  )
}
