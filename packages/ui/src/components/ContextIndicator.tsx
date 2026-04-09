import { createMemo, Show } from "solid-js"

interface ContextIndicatorProps {
  inputTokens: number | undefined
  contextLimit: number | undefined
}

export function ContextIndicator(props: ContextIndicatorProps) {
  const pct = createMemo(() => {
    if (props.inputTokens === undefined || !props.contextLimit || props.contextLimit <= 0) return null
    return Math.min(Math.round((props.inputTokens / props.contextLimit) * 100), 100)
  })

  const barColor = () => {
    const p = pct()
    if (p === null) return ""
    if (p >= 90) return "bg-vsc-error"
    if (p >= 70) return "bg-vsc-warning"
    return "bg-vsc-focus-border"
  }

  // Derive a value that is either the percentage (when >= 5) or false,
  // so the Show callback receives the number and we avoid repeated pct() calls.
  const visiblePct = createMemo(() => {
    const val = pct()
    return val !== null && val >= 5 ? val : false as const
  })

  return (
    <Show when={visiblePct()}>
      {(val) => (
        <div class="flex items-center gap-1.5 h-6 px-1">
          <div class="w-16 h-1.5 rounded-full bg-vsc-panel-border overflow-hidden">
            <div class={`h-full rounded-full transition-all ${barColor()}`} style={{ width: `${val()}%` }} />
          </div>
          <span class="text-[10px] text-vsc-description-fg tabular-nums">{val()}%</span>
        </div>
      )}
    </Show>
  )
}
