import { Show } from "solid-js"
import type { FilePart } from "@atelier/core"

export function FilePartView(props: { part: FilePart }) {
  const isImage = () => props.part.mime.startsWith("image/")
  return (
    <div>
      <Show when={isImage()} fallback={<div class="flex items-center gap-2 text-xs text-vsc-link"><span>📎</span><span class="font-mono">{props.part.filename ?? "attachment"}</span></div>}>
        <img src={props.part.url} alt={props.part.filename ?? "image"} class="max-w-md rounded border border-vsc-panel-border" />
      </Show>
    </div>
  )
}
