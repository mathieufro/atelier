import { For } from "solid-js"
import type { CompletedQuestion } from "../stores/interaction-store.js"

export function AnsweredQuestionCard(props: { completed: CompletedQuestion }) {
  return (
    <div class="bg-vsc-input-bg/50 border border-vsc-panel-border rounded-lg p-3 mb-2 opacity-75">
      <For each={props.completed.request.questions}>
        {(q, qIdx) => (
          <div class="mb-1.5 last:mb-0">
            <div class="text-xs text-vsc-description-fg mb-1">{q.question}</div>
            <div class="flex flex-wrap gap-1">
              {props.completed.rejected ? (
                <span class="px-2 py-0.5 text-xs text-vsc-description-fg italic">Dismissed</span>
              ) : (
                <For each={q.options}>
                  {(opt) => {
                    const isSelected = () => props.completed.answers?.[qIdx()]?.includes(opt.label) ?? false
                    return (
                      <span
                        class="px-2 py-0.5 text-xs rounded border"
                        classList={{
                          "border-vsc-focus-border bg-vsc-button-bg/30 text-vsc-editor-fg": isSelected(),
                          "border-transparent text-vsc-disabled-fg": !isSelected(),
                        }}
                      >
                        {opt.label}
                      </span>
                    )
                  }}
                </For>
              )}
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
