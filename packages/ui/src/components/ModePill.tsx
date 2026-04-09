import { onMount, onCleanup } from "solid-js"
import type { Mode } from "@atelier/core"

interface ModePillProps {
  mode: Mode
  onModeChange: (mode: Mode) => void
  locked?: boolean
}

const MODE_ORDER: Mode[] = ["build", "plan", "feature", "bugfix"]
const MODE_LABELS: Record<Mode, string> = {
  build: "Build",
  plan: "Plan",
  feature: "Feature",
  bugfix: "Bugfix",
}

export function ModePill(props: ModePillProps) {
  function cycleMode() {
    if (props.locked) return
    const idx = MODE_ORDER.indexOf(props.mode)
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length]!
    props.onModeChange(next)
  }

  function handleGlobalKeyDown(e: KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      if (props.locked) return
      e.preventDefault()
      cycleMode()
    }
  }
  onMount(() => document.addEventListener("keydown", handleGlobalKeyDown))
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown))

  return (
    <button
      data-testid="mode-pill"
      data-mode={props.mode}
      class="flex items-center gap-1 h-6 px-1.5 rounded text-xs transition-colors"
      classList={{
        "text-vsc-description-fg hover:text-vsc-editor-fg": props.mode === "build" && !props.locked,
        "text-vsc-description-fg/50": props.mode === "build" && props.locked,
        "text-vsc-link": props.mode === "plan" && !props.locked,
        "text-vsc-link/50": props.mode === "plan" && props.locked,
        "text-vsc-warning": props.mode === "feature" && !props.locked,
        "text-vsc-warning/50": props.mode === "feature" && props.locked,
        "text-vsc-error": props.mode === "bugfix" && !props.locked,
        "text-vsc-error/50": props.mode === "bugfix" && props.locked,
      }}
      onClick={cycleMode}
      tabIndex={props.locked ? -1 : 0}
    >
      {MODE_LABELS[props.mode]}
    </button>
  )
}
