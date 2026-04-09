import { Show, createSignal } from "solid-js"
import type { ToolState } from "@atelier/core"
import { ToolError, toolOutput } from "../ToolPart.jsx"
import { ToolOutputPreview } from "./ToolOutputPreview.jsx"

export function GenericToolView(props: { tool: string; state: ToolState }) {
  const [showInput, setShowInput] = createSignal(false)
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
      <div class="flex items-center gap-2">
        <span class="text-xs font-mono text-vsc-description-fg">{props.tool}</span>
        <button
          class="text-xs text-vsc-disabled-fg hover:text-vsc-description-fg"
          onClick={() => setShowInput((v) => !v)}
        >
          {showInput() ? "hide input" : "show input"}
        </button>
      </div>
      <Show when={showInput()}>
        <pre class="tool-input">{inputStr()}</pre>
      </Show>
      <Show when={output()}>
        <ToolOutputPreview content={output()} title={props.tool} />
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
