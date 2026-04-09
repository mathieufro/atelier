import { Show } from "solid-js"
import type { EditToolInput, ToolState, ToolStateCompleted } from "@atelier/core"
import { ToolError, toolOutput as getToolOutput } from "../ToolPart.jsx"
import { DiffView, computeLineDiff } from "./DiffView.jsx"
import { langFromPath } from "../../../highlight/highlighter.js"

export function EditToolView(props: { state: ToolState; onFileClick?: (path: string, line?: number) => void }) {
  const metadata = () => props.state.status === "completed" ? (props.state as ToolStateCompleted).metadata : undefined
  const diff = () => metadata()?.diff as string | undefined
  const additions = () => (metadata()?.additions as number) ?? 0
  const removals = () => (metadata()?.removals as number) ?? 0
  const hasSummary = () => props.state.status === "completed" && (additions() > 0 || removals() > 0)
  const output = () => getToolOutput(props.state)

  // Fallback: if no metadata.diff, compute a proper diff from oldString → newString
  // Support both camelCase (OpenCode) and snake_case (Claude Code) input formats
  const rawInput = () => props.state.input as Record<string, unknown>
  const input = (): EditToolInput => ({
    filePath: (rawInput().filePath ?? rawInput().file_path ?? "") as string,
    oldString: (rawInput().oldString ?? rawInput().old_string ?? "") as string,
    newString: (rawInput().newString ?? rawInput().new_string ?? "") as string,
  })
  const hasInputDiff = () => !diff() && (input().oldString || input().newString)
  const language = () => langFromPath(input().filePath ?? "")

  // Compute a real unified diff from old/new strings so context lines render correctly
  const fallbackDiff = () => {
    const inp = input()
    return computeLineDiff(inp.oldString ?? "", inp.newString ?? "", inp.filePath)
  }

  return (
    <div class="space-y-1">
      <Show when={hasSummary()}>
        <div class="text-xs">
          <Show when={additions() > 0}><span class="text-green-400">+{additions()}</span></Show>
          <Show when={additions() > 0 && removals() > 0}><span class="text-vsc-disabled-fg"> </span></Show>
          <Show when={removals() > 0}><span class="text-red-400">-{removals()}</span></Show>
        </div>
      </Show>
      <Show when={diff()}>
        <DiffView diff={diff()!} language={language()} />
      </Show>
      <Show when={hasInputDiff()}>
        <DiffView diff={fallbackDiff()} language={language()} />
      </Show>
      <Show when={!diff() && !hasInputDiff() && output()}>
        <pre class="tool-output max-h-[160px]">{output()}</pre>
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
