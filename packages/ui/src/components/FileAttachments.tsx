import { For, Show } from "solid-js"

interface AttachedFile {
  name: string
  mime: string
  url: string
}

interface FileAttachmentsProps {
  files: AttachedFile[]
  onRemove: (index: number) => void
}

export function FileAttachments(props: FileAttachmentsProps) {
  return (
    <Show when={props.files.length > 0}>
      <div class="flex gap-2 px-3 py-1 overflow-x-auto">
        <For each={props.files}>
          {(file, i) => (
            <div class="flex items-center gap-1 bg-vsc-input-bg rounded px-2 py-1 text-xs text-vsc-editor-fg">
              <Show when={file.mime.startsWith("image/")} fallback={<span>📎</span>}>
                <img src={file.url} alt={file.name} class="w-6 h-6 rounded object-cover" />
              </Show>
              <span class="truncate max-w-[100px]">{file.name}</span>
              <button class="text-vsc-description-fg hover:text-vsc-error ml-1" onClick={() => props.onRemove(i())}>×</button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
