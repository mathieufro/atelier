import { Show } from "solid-js"
import type { WriteToolInput, ToolState } from "@atelier/core"
import { ToolError } from "../ToolPart.jsx"
import { ToolOutputPreview } from "./ToolOutputPreview.jsx"

export function WriteToolView(props: { state: ToolState; onFileClick?: (path: string, line?: number) => void }) {
  const content = () => (props.state.input as unknown as WriteToolInput).content ?? ""
  const lineCount = () => content() ? content().split("\n").length : 0
  const filePath = () => (props.state.input as unknown as WriteToolInput).filePath ?? ""

  return (
    <div class="space-y-1">
      <Show when={lineCount() > 0}>
        <div class="text-xs text-vsc-description-fg">{lineCount()} {lineCount() === 1 ? "line" : "lines"}</div>
      </Show>
      <Show when={content()}>
        <ToolOutputPreview content={content()} title={filePath() || "write"} />
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
