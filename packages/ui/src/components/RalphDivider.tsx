import type { RalphDividerEvent } from "../stores/ralph-store.js"

function formatIterationDivider(event: Extract<RalphDividerEvent, { type: "iteration" }>): string {
  const iter = event.maxIterations > 0 ? `${event.iteration}/${event.maxIterations}` : `${event.iteration}`
  return `Iteration ${iter}`
}

function formatCompleteDivider(event: Extract<RalphDividerEvent, { type: "complete" }>): string {
  switch (event.reason) {
    case "promise_fulfilled":
      return `Loop complete: promise fulfilled (iteration ${event.iteration})`
    case "max_iterations":
      return `Loop complete: max iterations reached (${event.iteration})`
    case "cancelled":
      return `Loop cancelled (iteration ${event.iteration})`
    case "error":
      return `Loop error (iteration ${event.iteration})${event.detail ? `: ${event.detail}` : ""}`
    default:
      return `Loop ended (iteration ${event.iteration})`
  }
}

export function RalphDivider(props: { event: RalphDividerEvent }) {
  const label = () =>
    props.event.type === "iteration"
      ? formatIterationDivider(props.event as Extract<RalphDividerEvent, { type: "iteration" }>)
      : formatCompleteDivider(props.event as Extract<RalphDividerEvent, { type: "complete" }>)

  return (
    <div class="flex items-center gap-3 py-2 text-xs text-vsc-description-fg select-none">
      <div class="flex-1 border-t border-vsc-panel-border" />
      <span>{label()}</span>
      <div class="flex-1 border-t border-vsc-panel-border" />
    </div>
  )
}
