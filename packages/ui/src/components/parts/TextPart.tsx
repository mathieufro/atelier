import { onCleanup, createEffect } from "solid-js"
import { createStreamingRenderer } from "../../markdown/renderer.js"
import { usePostMessage } from "../../stores/post-message.js"
import type { TextPart } from "@atelier/core"

export function TextPartView(props: { part: TextPart; onFileClick?: (path: string, line?: number) => void }) {
  const postMessage = usePostMessage()
  let container!: HTMLDivElement
  let renderer: ReturnType<typeof createStreamingRenderer> | null = null

  createEffect(() => {
    const text = props.part.text
    container.innerHTML = ""
    renderer?.cleanup()
    renderer = createStreamingRenderer(container, { onFileClick: props.onFileClick, postMessage })
    if (text) renderer.write(text)
    renderer.end()
  })

  onCleanup(() => { renderer?.cleanup() })

  return <div ref={container} class="markdown-body" />
}
