import { For, Show } from "solid-js"
import type { TodoToolInput, ToolState } from "@atelier/core"
import { ToolError } from "../ToolPart.jsx"

interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

function TodoCheckbox(props: { status: string }) {
  return (
    <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] border shrink-0 mt-px" classList={{
      "border-vsc-disabled-fg/50": props.status === "pending",
      "border-vsc-disabled-fg": props.status === "in_progress",
      "border-vsc-disabled-fg bg-vsc-disabled-fg/20": props.status === "completed",
    }}>
      <Show when={props.status === "in_progress"}>
        <span class="w-1.5 h-1.5 rounded-full bg-vsc-disabled-fg animate-pulse" />
      </Show>
      <Show when={props.status === "completed"}>
        <svg class="w-2.5 h-2.5 text-vsc-disabled-fg" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 6.5L5 9L9.5 3.5" />
        </svg>
      </Show>
    </span>
  )
}

export function TodoToolView(props: { state: ToolState }) {
  const todos = (): TodoItem[] => {
    if (props.state.status === "completed" || props.state.status === "error") {
      const meta = props.state.metadata
      if (meta && "todos" in meta && Array.isArray(meta.todos)) return meta.todos as TodoItem[]
    }
    const input = props.state.input as TodoToolInput
    return (input.todos as TodoItem[] | undefined) ?? []
  }

  return (
    <div class="space-y-0.5">
      <Show when={todos().length > 0} fallback={
        <Show when={props.state.status === "running"} fallback={
          <div class="text-xs text-vsc-disabled-fg italic">No todos</div>
        }>
          <div class="text-xs text-vsc-description-fg italic">Generating<span class="dots" /></div>
        </Show>
      }>
        <For each={todos()}>
          {(todo) => (
            <div class="flex items-start gap-2 text-xs leading-5">
              <TodoCheckbox status={todo.status} />
              <span classList={{
                "text-vsc-disabled-fg": todo.status === "completed",
                "text-vsc-editor-fg": todo.status !== "completed",
              }}>
                {todo.status === "in_progress" ? todo.activeForm ?? todo.content : todo.content}
              </span>
            </div>
          )}
        </For>
      </Show>
      <ToolError state={props.state} />
    </div>
  )
}
