import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import type { Session, PipelineSummary } from "@atelier/core"
import { createClickOutside } from "../utils/click-outside.js"

interface SessionDropdownProps {
  sessions: Session[]
  activeSessionId?: string | null
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  pipelines?: PipelineSummary[]
  activePipelineId?: string | null
  onSelectPipeline?: (id: string) => void
  isLoopActive?: (sessionId: string) => boolean
}

type DropdownEntry =
  | { kind: "session"; id: string; title: string; time: number; session: Session }
  | { kind: "pipeline"; id: string; title: string; time: number; pipeline: PipelineSummary }

function groupEntriesByDate(entries: DropdownEntry[]): { label: string; entries: DropdownEntry[] }[] {
  const now = Date.now()
  const day = 86400000
  const groups: Record<string, DropdownEntry[]> = {}
  for (const e of entries) {
    const age = now - e.time
    const label = age < day ? "Today" : age < 2 * day ? "Yesterday" : age < 7 * day ? "This Week" : "Older"
    ;(groups[label] ??= []).push(e)
  }
  const order = ["Today", "Yesterday", "This Week", "Older"]
  return order.filter((l) => groups[l]).map((l) => ({
    label: l,
    entries: groups[l]!.sort((a, b) => b.time - a.time),
  }))
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

export function SessionDropdown(props: SessionDropdownProps) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  let containerRef!: HTMLDivElement
  const { startListening, stopListening } = createClickOutside(
    () => containerRef,
    () => setOpen(false),
  )

  const headerLabel = () => {
    if (props.activePipelineId) {
      const p = props.pipelines?.find(p => p.id === props.activePipelineId)
      return p ? (truncate(p.title ?? p.prompt, 30) || "Untitled") : "Pipeline"
    }
    const session = props.sessions.find(s => s.id === props.activeSessionId)
    return session?.title || "New Chat"
  }

  const allEntries = createMemo((): DropdownEntry[] => {
    const q = search().toLowerCase()
    const sessionEntries: DropdownEntry[] = props.sessions.map(s => ({
      kind: "session" as const,
      id: s.id,
      title: s.title || "Untitled",
      time: s.time.updated ?? s.time.created,
      session: s,
    }))
    const pipelineEntries: DropdownEntry[] = (props.pipelines ?? []).map(p => ({
      kind: "pipeline" as const,
      id: p.id,
      title: truncate(p.title ?? p.prompt, 60) || "Untitled",
      time: p.updatedAt ?? p.createdAt,
      pipeline: p,
    }))
    let all = [...sessionEntries, ...pipelineEntries]
    if (q) {
      all = all.filter(e => e.title.toLowerCase().includes(q))
    }
    return all
  })

  onCleanup(stopListening)

  function toggle() {
    const next = !open()
    setOpen(next)
    setSearch("")
    if (next) startListening()
    else stopListening()
  }

  function selectEntry(entry: DropdownEntry) {
    if (entry.kind === "session") props.onSelectSession(entry.id)
    else props.onSelectPipeline?.(entry.id)
    setOpen(false)
    stopListening()
  }

  function isActive(entry: DropdownEntry): boolean {
    if (entry.kind === "session") return entry.id === props.activeSessionId
    return entry.id === props.activePipelineId
  }

  return (
    <div data-testid="session-dropdown" ref={containerRef} class="relative">
      <button
        class="flex items-center gap-1 text-sm truncate max-w-[200px] px-2 py-1 rounded hover:bg-vsc-list-hover text-vsc-editor-fg"
        onClick={toggle}
      >
        <span class="truncate">{headerLabel()}</span>
        <svg class="w-3 h-3 shrink-0 opacity-60" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="absolute top-full left-0 mt-1 w-72 bg-vsc-sidebar-bg border border-vsc-panel-border rounded shadow-lg z-20 max-h-80 flex flex-col">
          <div class="p-2 border-b border-vsc-panel-border">
            <input
              type="text"
              class="w-full bg-vsc-input-bg border border-vsc-input-border rounded px-2 py-1 text-xs text-vsc-editor-fg focus:outline-none focus:border-vsc-focus-border"
              placeholder="Search..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
          <div class="flex-1 overflow-y-auto">
            <div class="px-2 py-1.5 border-b border-vsc-panel-border/40">
              <button
                class="w-full text-left px-2 py-1.5 rounded text-xs text-vsc-link hover:bg-vsc-list-hover"
                onClick={() => {
                  props.onNewSession()
                  setOpen(false)
                  stopListening()
                }}
              >
                + New Chat
              </button>
            </div>
            <Show when={allEntries().length === 0}>
              <div class="px-3 py-4 text-xs text-vsc-disabled-fg text-center">No conversations yet</div>
            </Show>
            <For each={groupEntriesByDate(allEntries())}>
              {(group) => (
                <>
                  <div class="px-3 py-1 text-[10px] text-vsc-disabled-fg uppercase tracking-wider">{group.label}</div>
                  <For each={group.entries}>
                    {(entry) => (
                      <div
                        class="group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-vsc-list-hover text-xs"
                        classList={{ "bg-vsc-list-active text-vsc-list-active-fg": isActive(entry) }}
                        onClick={() => selectEntry(entry)}
                      >
                        <Show when={entry.kind === "pipeline" ? entry : undefined}>
                          {(pipelineEntry) => (
                            <span class="inline-block w-1.5 h-1.5 rounded-full shrink-0" classList={{
                              "bg-vsc-warning animate-pulse": pipelineEntry().pipeline.status === "running",
                              "bg-vsc-success": pipelineEntry().pipeline.status === "completed",
                              "bg-vsc-description-fg opacity-50": pipelineEntry().pipeline.status === "idle",
                              "bg-vsc-warning": pipelineEntry().pipeline.status === "stuck",
                            }} />
                          )}
                        </Show>
                        <span class="flex-1 truncate text-vsc-editor-fg">{entry.title}</span>
                        <Show when={entry.kind === "pipeline" && entry.pipeline.status === "completed" && entry.pipeline.completionOutcome ? entry.pipeline.completionOutcome : undefined}>
                          {(outcome) => {
                            const badges: Record<string, { label: string; cls: string }> = {
                              plan_only: { label: "Plan", cls: "text-blue-400" },
                              implemented: { label: "Implemented", cls: "text-green-400" },
                              fixed: { label: "Fixed", cls: "text-green-400" },
                              fixed_unverified: { label: "Unverified Fix", cls: "text-yellow-400" },
                              inconclusive: { label: "Inconclusive", cls: "text-vsc-description-fg" },
                            }
                            const badge = () => badges[outcome()]
                            return <Show when={badge()}>{(b) => <span class={`text-[10px] ml-1 ${b().cls}`}>{b().label}</span>}</Show>
                          }}
                        </Show>
                        <Show when={entry.kind === "session" && props.isLoopActive?.(entry.id)}>
                          <span class="text-[10px] text-purple-400 ml-1 shrink-0">Loop</span>
                        </Show>
                        <Show when={entry.kind === "session"}>
                          <button
                            class="text-vsc-disabled-fg hover:text-vsc-error text-xs opacity-0 group-hover:opacity-100"
                            onClick={(e) => { e.stopPropagation(); props.onDeleteSession(entry.id) }}
                          >
                            ×
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
