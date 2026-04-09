import { Show, For } from "solid-js"
import { usePostMessage } from "../../../stores/post-message.jsx"
import { highlightTokens, langFromPath } from "../../../highlight/highlighter.js"

const MAX_LINES = 5

export function ToolOutputPreview(props: { content: string; language?: string; title?: string }) {
  const post = usePostMessage()

  const lang = () => langFromPath(props.title ?? "") ?? props.language
  const lines = () => props.content.split("\n")
  const previewLines = () => lines().slice(0, MAX_LINES).join("\n")
  const isTruncated = () => lines().length > MAX_LINES
  const tokens = () => highlightTokens(previewLines(), lang())

  const handleClick = () => {
    if (!isTruncated()) return
    post?.({ type: "openContent", content: props.content, language: lang(), title: props.title })
  }

  return (
    <div
      class="relative"
      classList={{ "cursor-pointer": isTruncated() }}
      onClick={handleClick}
    >
      <pre class="tool-preview">
        <For each={tokens()}>
          {(line, i) => (
            <>
              {i() > 0 && "\n"}
              <For each={line}>
                {(token) => (
                  <span style={token.color ? { color: token.color } : {}}>{token.content}</span>
                )}
              </For>
            </>
          )}
        </For>
      </pre>
      <Show when={isTruncated()}>
        <div class="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-vsc-editor-bg to-transparent" />
      </Show>
    </div>
  )
}
