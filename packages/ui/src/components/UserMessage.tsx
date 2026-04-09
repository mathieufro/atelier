import { createMemo, createSignal, For, Show } from "solid-js"
import type { CompactionPart, Part, TextPart, FilePart } from "@atelier/core"
import { FilePartView } from "./parts/FilePart.jsx"

const MAX_LINES = 25

function CollapsibleText(props: { text: string }) {
  const lineCount = createMemo(() => props.text.split("\n").length)
  const needsCollapse = createMemo(() => lineCount() > MAX_LINES)
  const [expanded, setExpanded] = createSignal(false)
  const displayText = createMemo(() => {
    if (!needsCollapse() || expanded()) return props.text
    return props.text.split("\n").slice(0, MAX_LINES).join("\n")
  })

  return (
    <div>
      <div class="text-[13px] text-vsc-editor-fg whitespace-pre-wrap" style={!needsCollapse() || expanded() ? undefined : { "mask-image": "linear-gradient(to bottom, black 85%, transparent)", "-webkit-mask-image": "linear-gradient(to bottom, black 85%, transparent)" }}>{displayText()}</div>
      <Show when={needsCollapse()}>
        <button class="flex items-center gap-1 mt-1 text-xs text-vsc-link hover:underline" onClick={() => setExpanded((e) => !e)}>
          <svg class="shrink-0" width="10" height="10" viewBox="0 0 10 10" style={`transform: rotate(${expanded() ? "180deg" : "0deg"}); transition: transform 0.15s ease`}><path d="M2 3.5L5 7L8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {expanded() ? "Show less" : `Show all (${lineCount()} lines)`}
        </button>
      </Show>
    </div>
  )
}

// Match [context: ...] at the start or end of the text
const CONTEXT_START_RE = /^\[context: ([^\]]+)\]\n/
const CONTEXT_END_RE = /\n\[context: ([^\]]+)\]$/

export function UserMessageView(props: { parts: Part[]; skillName?: string; fileContext?: string }) {
  // Strip [context: ...] tag from text parts and extract it for display
  const parsed = createMemo(() => {
    const parts = props.parts.filter((p) => p.type === "text" || p.type === "file" || p.type === "compaction")
    if (props.fileContext) return { parts, context: props.fileContext }
    // Check last text part for trailing context (preferred), then first for leading
    const last = parts[parts.length - 1]
    if (last?.type === "text") {
      const match = (last as TextPart).text.match(CONTEXT_END_RE)
      if (match) {
        const cleaned = [...parts.slice(0, -1), { ...last, text: (last as TextPart).text.slice(0, -(match[0].length)) } as Part]
        return { parts: cleaned, context: match[1] }
      }
    }
    const first = parts[0]
    if (first?.type === "text") {
      const match = (first as TextPart).text.match(CONTEXT_START_RE)
      if (match) {
        const cleaned = [{ ...first, text: (first as TextPart).text.slice(match[0].length) } as Part, ...parts.slice(1)]
        return { parts: cleaned, context: match[1] }
      }
    }
    return { parts, context: undefined }
  })
  const visibleParts = () => parsed().parts

  return (
    <Show when={visibleParts().length > 0}>
      <div class="mb-4">
        <Show when={props.skillName}>
          <div class="flex items-baseline gap-2 leading-5 mb-1">
            <span class="text-vsc-disabled-fg text-sm font-medium shrink-0">/{props.skillName}</span>
          </div>
        </Show>
        <div class="inline-block bg-vsc-input-bg rounded-lg px-2.5 py-1 max-w-[85%]">
          <For each={visibleParts()}>
          {(part) => {
            if (part.type === "text") return <CollapsibleText text={(part as TextPart).text} />
            if (part.type === "file") return <FilePartView part={part as FilePart} />
            if (part.type === "compaction") {
              const compaction = part as CompactionPart
              return (
                <div class="text-xs text-vsc-description-fg italic">
                  {compaction.auto ? "Context compacted automatically" : "Context compacted"}
                </div>
              )
            }
            return null
          }}
          </For>
        </div>
        <Show when={parsed().context}>
          <div class="text-[11px] italic text-vsc-description-fg/60 mt-0.5 ml-1">{parsed().context}</div>
        </Show>
      </div>
    </Show>
  )
}
