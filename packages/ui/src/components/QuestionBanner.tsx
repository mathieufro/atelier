import { For, createSignal } from "solid-js"
import type { QuestionRequest } from "@atelier/core"

export function QuestionBanner(props: {
  request: QuestionRequest
  onReply: (sessionId: string, id: string, answers: string[][]) => void
  onReject: (sessionId: string, id: string) => void
}) {
  const [selected, setSelected] = createSignal<string[][]>(props.request.questions.map(() => []))

  function toggleOption(qIdx: number, label: string) {
    setSelected((prev) => {
      const copy = prev.map((a) => [...a])
      const q = props.request.questions[qIdx]!
      if (q.multiple) {
        const idx = copy[qIdx]!.indexOf(label)
        if (idx >= 0) copy[qIdx]!.splice(idx, 1)
        else copy[qIdx]!.push(label)
      } else {
        copy[qIdx] = [label]
      }
      return copy
    })
  }

  return (
    <div class="bg-vsc-input-bg border border-vsc-panel-border rounded-lg p-3 mx-4 mb-2">
      <For each={props.request.questions}>
        {(q, qIdx) => (
          <div class="mb-2">
            <div class="text-sm text-vsc-editor-fg mb-1">{q.question}</div>
            <div class="flex flex-wrap gap-1">
              <For each={q.options}>
                {(opt) => (
                  <button
                    class="px-2 py-1 text-xs rounded border"
                    classList={{
                      "border-vsc-focus-border bg-vsc-button-bg/30 text-vsc-editor-fg": selected()[qIdx()]!.includes(opt.label),
                      "border-vsc-panel-border text-vsc-description-fg hover:border-vsc-focus-border": !selected()[qIdx()]!.includes(opt.label),
                    }}
                    onClick={() => toggleOption(qIdx(), opt.label)}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
      <div class="flex gap-2 mt-2">
        <button class="px-3 py-1 text-xs bg-vsc-button-bg text-vsc-button-fg rounded hover:opacity-90" onClick={() => props.onReply(props.request.sessionID, props.request.id, selected())}>Submit</button>
        <button class="px-3 py-1 text-xs bg-vsc-sidebar-bg text-vsc-editor-fg rounded border border-vsc-panel-border hover:opacity-90" onClick={() => props.onReject(props.request.sessionID, props.request.id)}>Dismiss</button>
      </div>
    </div>
  )
}
