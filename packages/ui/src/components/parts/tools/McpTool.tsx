import { Show } from "solid-js"
import type { ToolState } from "@atelier/core"
import { parseMcpToolName, ToolError, toolOutput } from "../ToolPart.jsx"
import { ToolOutputPreview } from "./ToolOutputPreview.jsx"

export function McpToolView(props: { tool: string; state: ToolState }) {
  const mcpInfo = () => parseMcpToolName(props.tool ?? "")
  const output = () => toolOutput(props.state)
  const inputStr = () => {
    try {
      return JSON.stringify(props.state.input, null, 2)
    } catch {
      return String(props.state.input)
    }
  }
  return (
    <div class="space-y-1">
      <div class="text-xs text-vsc-description-fg">
        <span class="text-vsc-link font-mono">{mcpInfo().server}</span>
        <span class="text-vsc-disabled-fg"> / </span>
        <span class="font-mono">{mcpInfo().toolName}</span>
      </div>
      <Show when={inputStr() !== "null" && inputStr() !== "{}"}>
        <pre class="tool-input">{inputStr()}</pre>
      </Show>
      <Show when={output()}>
        <ToolOutputPreview content={output()} title={`${mcpInfo().server} / ${mcpInfo().toolName}`} />
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
