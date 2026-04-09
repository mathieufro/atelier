import { createSignal, createEffect, Show, type JSX } from "solid-js"
import type { PipelineStage, StageStatus } from "@atelier/core"
import { usePostMessage } from "../stores/post-message.js"

const STAGE_LABELS: Record<string, { icon: string; label: string }> = {
  compile_brainstorm: { icon: "⚙", label: "Compiling brainstorm context" },
  brainstorm: { icon: "💬", label: "Brainstorm" },
  compile_plan: { icon: "⚙", label: "Compiling plan context" },
  write_plan: { icon: "📋", label: "Writing plan" },
  implement: { icon: "🔨", label: "Implementing" },
  review_spec: { icon: "🔍", label: "Reviewing spec" },
  fix_spec: { icon: "🔧", label: "Fixing spec" },
  establish_conventions: { icon: "📐", label: "Establishing conventions" },
  review_plan: { icon: "🔍", label: "Reviewing plan" },
  fix_plan: { icon: "🔧", label: "Fixing plan" },
  review_code: { icon: "🔍", label: "Reviewing code" },
  fix_code: { icon: "🔧", label: "Fixing code" },
  simplify: { icon: "✂", label: "Simplifying" },
  compile_task_brainstorm: { icon: "⚙", label: "Compiling task brainstorm context" },
  task_brainstorm: { icon: "💬", label: "Task Brainstorm" },
  review_task: { icon: "🔍", label: "Reviewing task plan" },
  fix_task: { icon: "🔧", label: "Fixing task plan" },
  quick_plan: { icon: "📋", label: "Quick Plan" },
  review_quick_plan: { icon: "🔍", label: "Reviewing plan" },
  fix_quick_plan: { icon: "🔧", label: "Fixing plan" },
  plan_gate: { icon: "🚪", label: "Plan Gate" },
  bugfix: { icon: "🔧", label: "Bugfix" },
}

interface StageBlockProps {
  stage: PipelineStage
  status: StageStatus
  interrupted?: boolean
  sessionId?: string
  defaultCollapsed?: boolean
  /** Last stage in the pipeline — stays expanded on completion so the user can keep reading/chatting. */
  isLast?: boolean
  children?: JSX.Element
}

export function StageBlock(props: StageBlockProps) {
  const info = () => STAGE_LABELS[props.stage] ?? { icon: "•", label: props.stage }
  const [collapsed, setCollapsed] = createSignal(props.defaultCollapsed ?? false)
  const postMessage = usePostMessage()

  createEffect(() => {
    // Auto-collapse completed stages, except the last one — the user is still
    // looking at it and may want to continue interacting after pipeline completion.
    if (props.status === "completed" && !props.isLast) {
      setCollapsed(true)
    }
  })

  return (
    <div class="my-1 first:mt-0" data-stage={props.stage}>
      <div class="flex items-center w-full px-4 py-1.5 text-xs gap-2">
        <button
          class="flex items-center gap-2 flex-1 min-w-0 hover:bg-vsc-list-hover-bg cursor-pointer"
          onClick={() => setCollapsed(c => !c)}
        >
          <svg
            class="shrink-0 text-vsc-disabled-fg"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            style={`transform: rotate(${collapsed() ? "0deg" : "90deg"}); transition: transform 0.15s ease`}
          >
            <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{info().icon}</span>
          <span class="font-medium">{info().label}</span>
          <span class="ml-auto" data-stage-status={props.interrupted ? "interrupted" : props.status}>
            <Show when={props.status === "completed"}>
              <span class="text-vsc-success">✓</span>
            </Show>
            <Show when={props.status === "running" && !props.interrupted}>
              <span class="text-vsc-warning animate-pulse">●</span>
            </Show>
            <Show when={props.status === "running" && props.interrupted}>
              <span class="text-vsc-description-fg">⏸</span>
            </Show>
            <Show when={props.status === "idle"}>
              <span class="text-vsc-description-fg">●</span>
            </Show>
            <Show when={props.status === "stuck"}>
              <span class="text-vsc-warning">⚠</span>
            </Show>
            <Show when={props.status === "skipped"}>
              <span class="text-vsc-description-fg opacity-50">⏭</span>
            </Show>
          </span>
        </button>
        <Show when={props.sessionId}>
          <button
            data-fork-button
            class="shrink-0 text-vsc-description-fg hover:text-vsc-fg cursor-pointer p-0.5"
            title="Fork to standalone chat"
            onClick={(e) => {
              e.stopPropagation()
              postMessage?.({ type: "forkStageSession", sessionId: props.sessionId! })
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 3.5V10a2.5 2.5 0 005 0V5" />
              <circle cx="5" cy="2" r="1.5" />
              <circle cx="10" cy="3.5" r="1.5" />
              <circle cx="5" cy="12.5" r="1.5" />
            </svg>
          </button>
        </Show>
      </div>

      <div data-stage-content data-collapsed={collapsed() ? "true" : "false"}>
        <Show when={!collapsed()}>
          <div class="pb-2">
            {props.children}
          </div>
        </Show>
      </div>
    </div>
  )
}
