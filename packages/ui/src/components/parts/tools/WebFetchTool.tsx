import { Show } from "solid-js"
import type { WebFetchToolInput, ToolState } from "@atelier/core"
import { ToolError, toolOutput } from "../ToolPart.jsx"
import { ToolOutputPreview } from "./ToolOutputPreview.jsx"

export function WebFetchToolView(props: { state: ToolState }) {
  const url = () => (props.state.input as unknown as WebFetchToolInput).url ?? ""
  const output = () => toolOutput(props.state)
  return (
    <div class="space-y-1">
      <Show when={url()}>
        <div class="font-mono text-xs text-vsc-link break-all">{url()}</div>
      </Show>
      <Show when={output()}>
        <ToolOutputPreview content={output()} title={`webfetch — ${url()}`} />
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
