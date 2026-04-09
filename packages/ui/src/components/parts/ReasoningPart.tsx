import { createSignal, Show, onCleanup, createEffect } from "solid-js"
import { formatDuration } from "@atelier/core"
import { createStreamingRenderer } from "../../markdown/renderer.js"
import { usePostMessage } from "../../stores/post-message.js"
import type { ReasoningPart } from "@atelier/core"
import { ChevronIcon } from "./ToolPart.jsx"

export function ReasoningPartView(props: { part: ReasoningPart; stopped?: boolean }) {
  const postMessage = usePostMessage()
  const [expanded, setExpanded] = createSignal(false)
  const duration = () => formatDuration(props.part.time.start, props.part.time.end)

  let container!: HTMLDivElement
  let renderer: ReturnType<typeof createStreamingRenderer> | null = null
  let lastText = ""

  createEffect(() => {
    if (!expanded()) {
      if (renderer) { renderer.end(); renderer.cleanup(); renderer = null; lastText = "" }
      return
    }
    const text = props.part.text
    if (!container) return
    if (!renderer) {
      renderer = createStreamingRenderer(container, { postMessage })
      renderer.write(text)
      lastText = text
    } else if (text.length > lastText.length) {
      renderer.write(text.slice(lastText.length))
      lastText = text
    } else if (text !== lastText) {
      container.innerHTML = ""
      renderer.cleanup()
      renderer = createStreamingRenderer(container)
      renderer.write(text)
      lastText = text
    }
  })

  onCleanup(() => { renderer?.end(); renderer?.cleanup() })

  return (
    <div>
      <button class="flex items-center gap-1.5 text-sm leading-5 text-vsc-description-fg italic" onClick={() => setExpanded((e) => !e)}>
        <ChevronIcon expanded={expanded()} />
        <span>Thinking<Show when={!duration() && !props.stopped}><span class="dots" /></Show></span>
        <Show when={duration()}><span class="text-vsc-disabled-fg text-xs">({duration()})</span></Show>
      </button>
      <Show when={expanded()}>
        <div ref={container} class="mt-1 rounded-lg bg-vsc-sidebar-bg px-3 py-2 markdown-body text-vsc-description-fg" />
      </Show>
    </div>
  )
}
