import { For, Show } from "solid-js"

interface FileEntry {
  path: string
  name: string
}

interface FilePickerProps {
  visible: boolean
  files: FileEntry[]
  query: string
  loading?: boolean
  onSelect: (file: FileEntry) => void
  onClose?: () => void
}

function highlightMatch(text: string, query: string) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark class="bg-vsc-button-bg/30 text-inherit">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function FilePicker(props: FilePickerProps) {
  return (
    <Show when={props.visible}>
      <div class="absolute bottom-full left-0 mb-1 w-72 bg-vsc-sidebar-bg border border-vsc-panel-border rounded shadow-lg max-h-48 overflow-y-auto z-20">
        <Show when={props.loading}>
          <div class="px-3 py-3 text-xs text-vsc-disabled-fg text-center">Searching...</div>
        </Show>
        <Show when={!props.loading && props.files.length === 0}>
          <div class="px-3 py-3 text-xs text-vsc-disabled-fg text-center">No matching files</div>
        </Show>
        <For each={props.files}>
          {(file) => (
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-vsc-list-hover text-xs text-vsc-editor-fg flex flex-col"
              onClick={() => props.onSelect(file)}
            >
              <span>{highlightMatch(file.name, props.query)}</span>
              <span class="text-vsc-description-fg truncate">{file.path}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
