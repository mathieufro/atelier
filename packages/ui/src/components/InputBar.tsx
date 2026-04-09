import { createSignal, createEffect, createMemo, Show, For, on, onCleanup } from "solid-js"
import { ModePill } from "./ModePill.jsx"
import { ModelPill, modelKey } from "./ModelPill.jsx"
import { ReasoningPill } from "./ReasoningPill.jsx"
import { ContextIndicator } from "./ContextIndicator.jsx"
import { FilePicker } from "./FilePicker.jsx"
import { FileAttachments } from "./FileAttachments.jsx"
import { SkillPicker, filterSkills } from "./SkillPicker.jsx"
import type { Mode, Model, PromptParams, PipelineStage, FavoritePair, FavoriteRecord, SkillInfo, ActiveFileContext } from "@atelier/core"

/** Built-in commands handled locally by the UI (not sent to the backend as skills). */
const BUILTIN_COMMANDS: SkillInfo[] = [
  { name: "clear", description: "Start a new chat", stage: "built-in" },
  { name: "ralph-loop", description: "Start a Ralph loop", stage: "built-in" },
  { name: "cancel-ralph", description: "Cancel active Ralph loop", stage: "built-in" },
]

/** Tokenize a shell-like string, respecting double-quoted segments. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === " " && !inQuotes) {
      if (current) { tokens.push(current); current = "" }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function parseRalphLoopArgs(input: string): { promptPath: string; maxIterations?: number; completionPromise?: string } | { error: string } {
  const tokens = tokenize(input.trim())
  if (tokens.length === 0) {
    return { error: 'Usage: /ralph-loop <prompt-path> [--max-iterations N] [--completion-promise "TEXT"]' }
  }

  let promptPath: string | undefined
  let maxIterations: number | undefined
  let completionPromise: string | undefined
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]!
    if (token === "--max-iterations" && i + 1 < tokens.length) {
      maxIterations = parseInt(tokens[++i]!, 10)
    } else if (token === "--completion-promise" && i + 1 < tokens.length) {
      completionPromise = tokens[++i]!
    } else if (!token.startsWith("--") && promptPath === undefined) {
      promptPath = token
    }
    i++
  }

  if (!promptPath) {
    return { error: 'Usage: /ralph-loop <prompt-path> [--max-iterations N] [--completion-promise "TEXT"]' }
  }

  return { promptPath, maxIterations, completionPromise }
}

interface AttachedFile {
  name: string
  mime: string
  url: string
}

interface FileEntry {
  path: string
  name: string
}

/** Mode-specific style classes for the input bar border, send button, and disabled button. */
const MODE_STYLES: Record<string, { border: string; button: string; disabled: string }> = {
  plan: {
    border: "border-vsc-focus-border",
    button: "bg-vsc-button-bg text-vsc-button-fg hover:bg-vsc-button-hover",
    disabled: "bg-vsc-button-bg/30 text-vsc-button-fg/40 cursor-not-allowed",
  },
  feature: {
    border: "border-vsc-warning/60",
    button: "bg-vsc-warning/80 text-vsc-editor-bg hover:bg-vsc-warning",
    disabled: "bg-vsc-warning/20 text-vsc-warning/40 cursor-not-allowed",
  },
  default: {
    border: "border-vsc-input-border",
    button: "bg-vsc-description-fg/70 text-vsc-editor-bg hover:bg-vsc-description-fg/90",
    disabled: "bg-vsc-description-fg/20 text-vsc-description-fg/40 cursor-not-allowed",
  },
}

const noop = (..._args: unknown[]) => {}

interface InputBarProps {
  onSend: (content: string, attachments?: PromptParams["attachments"], fileContext?: string) => Promise<boolean> | boolean | void
  onAbort?: () => void
  disabled?: boolean
  isBusy?: boolean
  sending?: boolean
  sendError?: string | null
  mode: Mode
  onModeChange: (mode: Mode) => void
  models: Model[]
  selectedModel?: string
  onSelectModel: (id: string) => void
  favorites?: FavoriteRecord[]
  onUpsertFavorite?: (favorite: FavoritePair) => void
  onSelectFavorite?: (favorite: FavoriteRecord) => void
  onRemoveFavorite?: (favoriteKey: string) => void
  onReorderFavorites?: (favoriteKeys: string[]) => void
  inputTokens?: number
  fileResults?: FileEntry[]
  onRequestFiles?: (query: string) => void
  activeFileInsert?: { path: string; startLine?: number; endLine?: number }
  variants?: string[]
  selectedVariant?: string | undefined
  onVariantChange?: (variant: string | undefined) => void
  pipelineStage?: PipelineStage | null
  modeLocked?: boolean
  skills?: SkillInfo[]
  onInvokeSkill?: (skillName: string, content: string, attachments?: PromptParams["attachments"]) => Promise<boolean> | boolean
  onNewChat?: () => void
  onClearError?: () => void
  activeFileContext?: ActiveFileContext
  fileContextEnabled?: boolean
  onToggleFileContext?: () => void
  isLoopActive?: boolean
  onStartRalphLoop?: (args: { promptPath: string; maxIterations?: number; completionPromise?: string }) => void
  onCancelRalphLoop?: () => void
  onSendError?: (error: string) => void
}

export function InputBar(props: InputBarProps) {
  const [text, setText] = createSignal("")
  const [attachments, setAttachments] = createSignal<AttachedFile[]>([])
  const [showFilePicker, setShowFilePicker] = createSignal(false)
  const [fileQuery, setFileQuery] = createSignal("")
  const [fileLoading, setFileLoading] = createSignal(false)
  const [showSkillPicker, setShowSkillPicker] = createSignal(false)
  const [skillQuery, setSkillQuery] = createSignal("")
  const [activeSkill, setActiveSkill] = createSignal<string | null>(null)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let textareaRef!: HTMLTextAreaElement

  /** All available commands: built-ins + server skills, merged into a single list. */
  const allCommands = createMemo((): SkillInfo[] => [...BUILTIN_COMMANDS, ...(props.skills ?? [])])

  // Reset selection index when the query or visibility changes
  createEffect(on(skillQuery, () => setSelectedIndex(0)))
  createEffect(on(showSkillPicker, (visible) => { if (visible) setSelectedIndex(0) }))

  const formatLineRef = (base: string, startLine?: number, endLine?: number): string => {
    if (startLine == null || endLine == null) return base
    return startLine === endLine ? `${base}:${startLine}` : `${base}:${startLine}-${endLine}`
  }

  const fileContextLabel = () => {
    const ctx = props.activeFileContext
    if (!ctx) return ""
    const basename = ctx.relativePath.split("/").pop() ?? ctx.relativePath
    return formatLineRef(basename, ctx.startLine, ctx.endLine)
  }

  const selectedModelData = () => props.models.find((m) => modelKey(m) === props.selectedModel)
  const contextLimit = () => selectedModelData()?.limit?.context

  const canSend = () => !!text().trim() && !props.disabled && !props.sending

  const modeStyle = () => (MODE_STYLES[props.mode] ?? MODE_STYLES.default)!

  createEffect(on(() => props.fileResults, () => setFileLoading(false)))

  createEffect(on(() => props.activeFileInsert?.path, (path) => {
    if (!path) return
    const insert = props.activeFileInsert!
    const name = insert.path.split("/").pop() ?? insert.path
    const rangeLabel = insert.startLine
      ? `${name}:${insert.startLine}${insert.endLine ? `-${insert.endLine}` : ""}`
      : name
    setAttachments((prev) => {
      if (prev.some((a) => a.url === insert.path)) return prev
      return [...prev, { name: rangeLabel, mime: "text/plain", url: insert.path }]
    })
  }))

  async function handleSubmit() {
    const content = text().trim()
    if (!content || props.disabled || props.sending) return

    const skill = activeSkill()

    // Handle built-in commands locally (not sent to backend)
    if (skill && BUILTIN_COMMANDS.some((c) => c.name === skill)) {
      setText("")
      setAttachments([])
      setActiveSkill(null)
      setShowSkillPicker(false)
      setShowFilePicker(false)
      textareaRef.style.height = "auto"

      if (skill === "clear") {
        props.onNewChat?.()
      } else if (skill === "ralph-loop") {
        const parsed = parseRalphLoopArgs(content)
        if ("error" in parsed) {
          props.onSendError?.(parsed.error)
          return
        }
        props.onStartRalphLoop?.(parsed)
      } else if (skill === "cancel-ralph") {
        props.onCancelRalphLoop?.()
      }
      return
    }

    const files = attachments()
    const atts: PromptParams["attachments"] = files.length > 0
      ? files.map((f) => ({ mime: f.mime, url: f.url, filename: f.name }))
      : undefined

    // Clear input optimistically before the async send — the message is already
    // shown in chat via addOptimisticUserMessage, so keeping it in the input
    // during the RPC round-trip looks like a bug (duplicate text).
    const prevText = text()
    const prevAttachments = attachments()
    const prevSkill = activeSkill()
    setText("")
    setAttachments([])
    setActiveSkill(null)
    setShowSkillPicker(false)
    setShowFilePicker(false)
    textareaRef.style.height = "auto"

    let ok: boolean
    if (skill && props.onInvokeSkill) {
      // Strip /skillname from content wherever it appears
      const pattern = new RegExp(`(^|\\s)\\/${skill}\\s?`)
      const remainder = content.replace(pattern, "$1").trim()
      ok = await props.onInvokeSkill(skill, remainder, atts)
    } else {
      const ctx = props.fileContextEnabled !== false ? props.activeFileContext : null
      const ctxLabel = ctx ? formatLineRef(ctx.relativePath, ctx.startLine, ctx.endLine) : undefined
      ok = (await props.onSend(content, atts, ctxLabel)) ?? true
    }
    if (!ok) {
      // Restore input on failure so the user can retry
      setText(prevText)
      setAttachments(prevAttachments)
      setActiveSkill(prevSkill)
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (showSkillPicker()) {
      const filtered = filterSkills(allCommands(), skillQuery())
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((prev) => (filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0))
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        if (filtered.length > 0) handleSkillSelect(filtered[selectedIndex()]!)
        return
      }
      if (e.key === "Enter" && !e.shiftKey && filtered.length > 0) {
        e.preventDefault()
        handleSkillSelect(filtered[selectedIndex()]!)
        return
      }
      if (e.key === "Escape") {
        setShowSkillPicker(false)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      setShowFilePicker(false)
      handleSubmit()
    }
    if (e.key === "Escape") {
      if (showFilePicker()) setShowFilePicker(false)
    }
  }

  function handleSkillSelect(skill: SkillInfo) {
    const value = text()
    const cursorPos = textareaRef.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursorPos)
    const afterCursor = value.slice(cursorPos)
    // Replace the /query portion at cursor with /skillname + space
    const replaced = beforeCursor.replace(/(^|\s)\/\S*$/, `$1/${skill.name} `)
    setText(replaced + afterCursor)
    setActiveSkill(skill.name)
    setShowSkillPicker(false)
    textareaRef.focus()
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement
    const value = target.value
    setText(value)
    props.onClearError?.()
    target.style.height = "auto"
    target.style.height = `${target.scrollHeight}px`

    const cursorPos = target.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursorPos)

    // Slash command detection: /query at cursor position (after start-of-line or whitespace)
    const slashMatch = beforeCursor.match(/(^|\s)\/(\S*)$/)
    const commands = allCommands()
    if (slashMatch && commands.length) {
      const query = slashMatch[2]!
      setSkillQuery(query)
      setShowSkillPicker(true)
      setShowFilePicker(false)
      // Check if the typed slash command exactly matches a skill name
      const exactMatch = commands.find((s) => s.name === query)
      const afterMatch = value.slice(cursorPos)
      if (exactMatch && (afterMatch.length > 0 || value.charAt(cursorPos - 1) === " ")) {
        // Slash command fully typed and cursor moved past it — lock in the skill
        setActiveSkill(exactMatch.name)
        setShowSkillPicker(false)
      } else {
        setActiveSkill(exactMatch?.name ?? null)
      }
    } else {
      setShowSkillPicker(false)
      // Clear active skill if the /skillname was removed from text
      if (activeSkill()) {
        const skillName = activeSkill()!
        const pattern = new RegExp(`(^|\\s)\\/${skillName}(\\s|$)`)
        if (!pattern.test(value)) setActiveSkill(null)
      }

      // @ mention file picker
      const atMatch = beforeCursor.match(/@(\S*)$/)
      if (atMatch) {
        setFileQuery(atMatch[1]!)
        setShowFilePicker(true)
        setFileLoading(true)
        props.onRequestFiles?.(atMatch[1]!)
      } else {
        setShowFilePicker(false)
      }
    }
  }

  function handleFileSelect(file: FileEntry) {
    const value = text()
    const cursorPos = textareaRef.selectionStart ?? value.length
    const beforeCursor = value.slice(0, cursorPos)
    const afterCursor = value.slice(cursorPos)
    const replaced = beforeCursor.replace(/@\S*$/, `@${file.name} `)
    setText(replaced + afterCursor)
    setShowFilePicker(false)
    setAttachments((prev) => {
      if (prev.some((a) => a.url === file.path)) return prev
      return [...prev, { name: file.name, mime: "text/plain", url: file.path }]
    })
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files)
  }

  function handlePaste(e: ClipboardEvent) {
    if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files)
  }

  function addFiles(files: FileList) {
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file)
      setAttachments((prev) => [...prev, { name: file.name, mime: file.type, url }])
    }
  }

  // Revoke any remaining blob URLs when the component unmounts to prevent memory leaks
  onCleanup(() => {
    attachments().forEach((a) => {
      if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url)
    })
  })

  const placeholder = () => {
    if (props.mode === "feature") {
      if (!props.pipelineStage) return "Describe a feature to build..."
      if (props.pipelineStage === "brainstorm") return "Reply to brainstorm..."
      if (props.pipelineStage.startsWith("compile")) return "Send a message to the compiler agent..."
      return "Send a message to the agent..."
    }
    return props.isBusy ? "Queue another message..." : "Message..."
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const copy = [...prev]
      if (copy[index]!.url.startsWith("blob:")) URL.revokeObjectURL(copy[index]!.url)
      copy.splice(index, 1)
      return copy
    })
  }

  function triggerFileAttach() {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.onchange = () => { if (input.files) addFiles(input.files) }
    input.click()
  }

  return (
    <div data-testid="input-bar" class="px-3 pb-3 pt-2 flex justify-center">
      <div class={`rounded-xl border ${modeStyle().border} bg-vsc-input-bg w-full max-w-[720px]`}>
        <FileAttachments files={attachments()} onRemove={removeAttachment} />
        <div class="relative">
          <SkillPicker
            visible={showSkillPicker()}
            skills={allCommands()}
            query={skillQuery()}
            selectedIndex={selectedIndex()}
            onSelect={handleSkillSelect}
            onClose={() => setShowSkillPicker(false)}
          />
          <FilePicker
            visible={showFilePicker()}
            files={props.fileResults ?? []}
            query={fileQuery()}
            loading={fileLoading()}
            onSelect={handleFileSelect}
            onClose={() => setShowFilePicker(false)}
          />
          <textarea
            ref={textareaRef}
            class="w-full bg-transparent px-3.5 py-2.5 text-vsc-editor-fg resize-none min-h-[40px] max-h-[200px] focus:outline-none placeholder:text-vsc-description-fg/60"
            style={{ font: "inherit" }}
            placeholder={placeholder()}
            rows={1}
            value={text()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onPaste={handlePaste}
          />
        </div>
        {/* Inline error */}
        <Show when={props.sendError}>
          <div class="px-3.5 pb-1 text-xs text-vsc-error">{props.sendError}</div>
        </Show>
        {/* Control bar */}
        <div class="mx-2.5 border-t border-vsc-panel-border/40" />
        <div class="flex items-center gap-1 px-1.5 pb-1.5 pt-1 min-h-[28px]">
          <ModePill mode={props.mode} onModeChange={props.onModeChange} locked={props.modeLocked} />
           <ModelPill
             models={props.models}
             selected={props.selectedModel}
             selectedVariant={props.selectedVariant}
             favorites={props.favorites ?? []}
             onSelect={props.onSelectModel}
             onVariantChange={props.onVariantChange}
             onUpsertFavorite={props.onUpsertFavorite ?? noop}
             onSelectFavorite={props.onSelectFavorite ?? noop}
             onRemoveFavorite={props.onRemoveFavorite ?? noop}
             onReorderFavorites={props.onReorderFavorites ?? noop}
           />
          <ReasoningPill
            variants={props.variants ?? []}
            current={props.selectedVariant}
            onChange={(v) => props.onVariantChange?.(v)}
            hidden={!props.variants || props.variants.length === 0}
          />
          <Show when={props.activeFileContext}>
            <button
              data-testid="file-context-pill"
              class="flex items-center h-6 px-1.5 rounded text-xs leading-none transition-colors"
              classList={{
                "text-vsc-editor-fg": props.fileContextEnabled !== false,
                "text-vsc-description-fg/50 line-through": props.fileContextEnabled === false,
              }}
              onClick={() => props.onToggleFileContext?.()}
              title={`${props.activeFileContext!.relativePath} — click to toggle`}
            >
              <span>{fileContextLabel()}</span>
            </button>
          </Show>
          {/* Selected context — shows attached files as inline chips */}
          <For each={attachments()}>
            {(file, i) => (
              <button
                class="flex items-center gap-1 h-6 px-1.5 rounded text-xs text-vsc-link hover:bg-vsc-list-hover transition-colors group"
                onClick={() => removeAttachment(i())}
                title={`Remove ${file.name}`}
              >
                <span class="opacity-70">&lt;/&gt;</span>
                <span>{file.name}</span>
                <span class="opacity-0 group-hover:opacity-100 text-vsc-description-fg ml-0.5">&times;</span>
              </button>
            )}
          </For>
          <Show when={activeSkill()}>
            <span class="flex items-center gap-1 h-6 px-1.5 rounded text-xs bg-vsc-button-bg/20 text-vsc-button-fg">
              <span class="opacity-70">/</span>
              <span>{activeSkill()}</span>
              <button
                class="opacity-50 hover:opacity-100 ml-0.5"
                onClick={() => {
                  const skill = activeSkill()
                  setActiveSkill(null)
                  if (skill) {
                    const value = text()
                    const pattern = new RegExp(`(^|\\s)\\/${skill}\\s?`)
                    setText(value.replace(pattern, "$1").trim())
                  }
                }}
              >&times;</button>
            </span>
          </Show>
          <ContextIndicator inputTokens={props.inputTokens} contextLimit={contextLimit()} />
          <div class="ml-auto flex items-center gap-1">
            {/* Add context */}
            <button
              aria-label="Add context"
              class="w-6 h-6 flex items-center justify-center rounded text-vsc-description-fg hover:text-vsc-editor-fg hover:bg-vsc-list-hover transition-colors"
              onClick={triggerFileAttach}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
            {/* Send / Stop: show Send when there's text (even while busy), Stop otherwise */}
            <Show when={props.isBusy && !text().trim()} fallback={
              <button
                aria-label="Send"
                class={`w-7 h-7 flex items-center justify-center rounded-lg text-sm transition-colors ${canSend() ? modeStyle().button : modeStyle().disabled}`}
                disabled={!text().trim() || props.disabled || props.sending}
                onClick={handleSubmit}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M2 12L12 7L2 2V6L8 7L2 8V12Z" fill="currentColor" />
                </svg>
              </button>
            }>
              <button
                aria-label={props.isLoopActive ? "Stop Loop" : "Stop"}
                class={`w-7 h-7 flex items-center justify-center rounded-lg ${modeStyle().button} transition-colors`}
                onClick={() => props.onAbort?.()}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
