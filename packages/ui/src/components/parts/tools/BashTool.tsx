import { Show } from "solid-js"
import type { BashToolInput, ToolState } from "@atelier/core"
import { ToolError, toolOutput } from "../ToolPart.jsx"
import { ToolOutputPreview } from "./ToolOutputPreview.jsx"

export function BashToolView(props: { state: ToolState }) {
  const command = () => (props.state.input as unknown as BashToolInput).command ?? ""
  const output = () => toolOutput(props.state)
  return (
    <div class="space-y-1">
      <div class="font-mono text-xs text-vsc-editor-fg"><span class="text-vsc-disabled-fg">$ </span>{command()}</div>
      <Show when={output()}><ToolOutputPreview content={output()} language="shellscript" title="bash output" /></Show>
      <ToolError state={props.state} />
    </div>
  )
}
