import { createMemo, For, Show } from "solid-js"
import { isUserMessage } from "@atelier/core"
import type { Message } from "@atelier/core"
import { useStores } from "../stores/context.jsx"
import { AssistantMessageView } from "./AssistantMessage.jsx"
import { UserMessageView } from "./UserMessage.jsx"
import { RalphDivider } from "./RalphDivider.jsx"
import { AnsweredQuestionCard } from "./AnsweredQuestionCard.jsx"
import type { RalphDividerEvent } from "../stores/ralph-store.js"
import type { CompletedQuestion } from "../stores/interaction-store.js"

/** Type guard: returns true when the message was interrupted (aborted). */
function isInterruptedMessage(msg: Message): boolean {
  if (msg.role !== "assistant") return false
  return msg.error?.name === "MessageAbortedError"
}

/** Exported for testing — finds dividers that should appear before the message at index `i`. */
export function findPrecedingDividers(
  dividers: RalphDividerEvent[],
  messages: Array<{ time?: { created: number } }>,
  index: number
): RalphDividerEvent[] {
  if (!dividers.length) return []
  const msgTime = messages[index]?.time?.created ?? 0
  const prevMsgTime = index > 0 ? (messages[index - 1]?.time?.created ?? 0) : 0
  return dividers.filter(d => d.timestamp > prevMsgTime && d.timestamp <= msgTime)
}

/** Exported for testing — finds dividers that appear after the last message. */
export function findTrailingDividers(
  dividers: RalphDividerEvent[],
  messages: Array<{ time?: { created: number } }>
): RalphDividerEvent[] {
  if (!dividers.length) return []
  const lastMsgTime = messages.length > 0 ? (messages[messages.length - 1]?.time?.created ?? 0) : 0
  return dividers.filter(d => d.timestamp > lastMsgTime)
}

export function MessageList(props: {
  onFileClick?: (path: string, line?: number) => void
  loading?: boolean
  /** When provided, renders messages from this specific session instead of the active session */
  sessionId?: string
  /** When true, suppresses the "Start a conversation" empty state (used inside pipeline stage blocks) */
  hideEmptyPrompt?: boolean
  /** Completed questions to render inline after the message that triggered them */
  completedQuestions?: CompletedQuestion[]
}) {
  const { messageStore, sessionStore, ralphStore } = useStores()

  const resolvedSessionId = () => props.sessionId ?? sessionStore.activeSessionId() ?? ""
  const entries = () => messageStore.messages(resolvedSessionId())
  const isBusy = () => {
    const id = resolvedSessionId()
    if (!id) return false
    const status = sessionStore.getStatus(id)
    return status.type === "busy" || status.type === "stalled"
  }
  const isStalled = () => {
    const id = resolvedSessionId()
    return id ? sessionStore.getStatus(id).type === "stalled" : false
  }

  // True when busy but the last entry is still a user message (assistant hasn't replied yet).
  // This happens with backends that don't emit message.created immediately (e.g. Claude).
  const showPendingPlaceholder = () => {
    if (!isBusy()) return false
    const msgs = entries()
    return msgs.length === 0 || isUserMessage(msgs[msgs.length - 1]!.message)
  }

  const dividers = () => ralphStore.getEvents(resolvedSessionId())

  /** Map from messageID → completed questions that belong after that message. */
  const questionsByMessageId = createMemo(() => {
    const map = new Map<string, CompletedQuestion[]>()
    const orphans: CompletedQuestion[] = []
    for (const cq of props.completedQuestions ?? []) {
      const mid = cq.request.tool?.messageID
      if (mid) {
        const list = map.get(mid)
        if (list) list.push(cq)
        else map.set(mid, [cq])
      } else {
        orphans.push(cq)
      }
    }
    return { map, orphans }
  })

  return (
    <div data-testid="message-list" class="px-4 pt-2">
      <Show when={props.loading}>
        <div class="space-y-4 animate-pulse">
          <div class="h-8 bg-vsc-input-bg rounded w-3/4" />
          <div class="h-20 bg-vsc-input-bg rounded" />
          <div class="h-8 bg-vsc-input-bg rounded w-1/2" />
          <div class="h-16 bg-vsc-input-bg rounded" />
        </div>
      </Show>
      <Show when={!props.loading && !entries().length && !props.hideEmptyPrompt}>
        <div class="flex items-center justify-center h-full text-vsc-description-fg text-sm">Start a conversation</div>
      </Show>
      <Show when={!props.loading}>
        <For each={entries()}>
          {(entry, i) => {
            const precedingDividers = createMemo(() =>
              findPrecedingDividers(dividers(), entries().map(e => e.message), i())
            )

            const parts = () => messageStore.getParts(resolvedSessionId(), entry.message.id)
            const isLast = () => i() === entries().length - 1

            const inlineQuestions = createMemo(() =>
              questionsByMessageId().map.get(entry.message.id) ?? []
            )

            return (
              <>
                <For each={precedingDividers()}>
                  {(divider) => <RalphDivider event={divider} />}
                </For>
                <div data-message>
                  <Show when={isUserMessage(entry.message)}
                    fallback={
                      <AssistantMessageView
                        parts={parts()}
                        onFileClick={props.onFileClick}
                        isStreaming={isLast() && isBusy()}
                        isStalled={isLast() && isStalled()}
                        interrupted={isInterruptedMessage(entry.message)}
                      />
                    }
                  >
                    <UserMessageView parts={parts()} skillName={messageStore.getSkill(resolvedSessionId(), entry.message.id)} fileContext={messageStore.getFileContext(resolvedSessionId(), entry.message.id)} />
                  </Show>
                </div>
                <For each={inlineQuestions()}>
                  {(cq) => <AnsweredQuestionCard completed={cq} />}
                </For>
              </>
            )
          }}
        </For>
        {/* Trailing Ralph dividers (after all messages) */}
        {(() => {
          const trailing = createMemo(() =>
            findTrailingDividers(dividers(), entries().map(e => e.message))
          )
          return (
            <For each={trailing()}>
              {(divider) => <RalphDivider event={divider} />}
            </For>
          )
        })()}
        <Show when={showPendingPlaceholder()}>
          <AssistantMessageView parts={[]} isStreaming={true} />
        </Show>
      </Show>
      {/* Orphan completed questions (no tool.messageID) — outside loading guard */}
      <For each={questionsByMessageId().orphans}>
        {(cq) => <AnsweredQuestionCard completed={cq} />}
      </For>
    </div>
  )
}
