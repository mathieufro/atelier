import { For, Show, createSignal, onMount, onCleanup } from "solid-js"
import { highlightLine, langFromPath } from "../../../highlight/highlighter.js"

interface DiffLine {
  type: "add" | "remove" | "context"
  content: string
  oldLineNo?: number
  newLineNo?: number
}

interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const rawLines = diff.split("\n")
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of rawLines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      current = { oldStart: parseInt(hunkMatch[1]!), newStart: parseInt(hunkMatch[2]!), lines: [] }
      oldLine = current.oldStart
      newLine = current.newStart
      hunks.push(current)
      continue
    }

    if (!current) continue

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ })
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "remove", content: line.slice(1), oldLineNo: oldLine++ })
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLineNo: oldLine++, newLineNo: newLine++ })
    }
  }

  return hunks
}

export function inferLanguageFromDiff(diff: string): string | undefined {
  const lines = diff.split("\n")
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim()
      if (!raw || raw === "/dev/null") continue
      const path = raw.startsWith("b/") || raw.startsWith("a/") ? raw.slice(2) : raw
      const lang = langFromPath(path)
      if (lang) return lang
    }
    if (line.startsWith("*** Update File: ") || line.startsWith("*** Add File: ")) {
      const path = line.split(":", 2)[1]?.trim()
      if (!path) continue
      const lang = langFromPath(path)
      if (lang) return lang
    }
  }
  return undefined
}

/** Pair removed+added lines for side-by-side display */
function pairLines(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === "context") {
      pairs.push({ left: line, right: line })
      i++
    } else if (line.type === "remove") {
      // Collect consecutive removes, then match with consecutive adds
      const removes: DiffLine[] = []
      while (i < lines.length && lines[i]!.type === "remove") removes.push(lines[i++]!)
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i]!.type === "add") adds.push(lines[i++]!)
      const max = Math.max(removes.length, adds.length)
      for (let j = 0; j < max; j++) {
        pairs.push({ left: removes[j] ?? null as DiffLine | null, right: adds[j] ?? null as DiffLine | null })
      }
    } else {
      // Standalone add
      pairs.push({ left: null, right: line })
      i++
    }
  }
  return pairs
}

function allLines(hunks: DiffHunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines)
}

export function hasMixedChanges(hunks: DiffHunk[]): boolean {
  let hasAdd = false
  let hasRemove = false

  for (const line of allLines(hunks)) {
    if (line.type === "add") hasAdd = true
    if (line.type === "remove") hasRemove = true
    if (hasAdd && hasRemove) return true
  }

  return false
}

/** Render highlighted tokens for a line of code */
function HighlightedContent(props: { content: string; language?: string }) {
  const tokens = () => highlightLine(props.content, props.language)
  return (
    <For each={tokens()}>
      {(token) => (
        <span style={token.color ? { color: token.color } : {}}>{token.content}</span>
      )}
    </For>
  )
}

/**
 * Compute a unified diff string from old/new text using Myers-like LCS.
 * Returns a minimal unified diff that correctly distinguishes context from changes.
 */
export function computeLineDiff(oldText: string, newText: string, filePath?: string): string {
  const oldLines = oldText ? oldText.split("\n") : []
  const newLines = newText ? newText.split("\n") : []

  // Simple LCS via DP (fine for edit-sized strings)
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }

  // Backtrack to build edit script
  const ops: Array<{ type: "ctx" | "del" | "add"; line: string }> = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "ctx", line: oldLines[i - 1]! })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: "add", line: newLines[j - 1]! })
      j--
    } else {
      ops.push({ type: "del", line: oldLines[i - 1]! })
      i--
    }
  }
  ops.reverse()

  // Format as unified diff
  const header = filePath
    ? `--- a/${filePath}\n+++ b/${filePath}`
    : `--- a/file\n+++ b/file`
  const hunk = `@@ -1,${n} +1,${m} @@`
  const body = ops.map(op =>
    op.type === "ctx" ? ` ${op.line}` :
    op.type === "del" ? `-${op.line}` :
    `+${op.line}`
  ).join("\n")

  return `${header}\n${hunk}\n${body}`
}

const MAX_DIFF_LINES = 6

export function DiffView(props: { diff: string; language?: string }) {
  let containerRef!: HTMLDivElement
  const [wide, setWide] = createSignal(false)

  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWide(w > 500)
    })
    obs.observe(containerRef)
    onCleanup(() => obs.disconnect())
  })

  const hunks = () => parseUnifiedDiff(props.diff)
  // Show only changed lines (no context) — keeps preview proportional to actual edits
  const changedLines = () => allLines(hunks()).filter(l => l.type !== "context")
  const truncatedLines = () => changedLines().slice(0, MAX_DIFF_LINES)
  const isTruncated = () => changedLines().length > MAX_DIFF_LINES
  const pairs = () => pairLines(truncatedLines())
  const language = () => props.language ?? inferLanguageFromDiff(props.diff)
  const showSideBySide = () => wide() && hasMixedChanges(hunks())

  return (
    <div ref={containerRef} class="relative overflow-hidden">
      {showSideBySide() ? <SideBySide pairs={pairs()} language={language()} /> : <Inline lines={truncatedLines()} language={language()} />}
      <Show when={isTruncated()}>
        <div class="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-vsc-editor-bg to-transparent" />
      </Show>
    </div>
  )
}

function Inline(props: { lines: DiffLine[]; language?: string }) {
  return (
    <div class="font-mono text-xs" style={{ "line-height": "var(--vscode-editor-line-height, 1.45)" }}>
      <For each={props.lines}>
        {(line) => (
          <div class="flex" classList={{
            "bg-green-500/10": line.type === "add",
            "bg-red-500/10": line.type === "remove",
          }}>
            <span class="select-none text-vsc-disabled-fg w-8 text-right pr-2 shrink-0">
              {line.type === "remove" ? line.oldLineNo : line.newLineNo}
            </span>
            <span class="select-none w-4 shrink-0" classList={{
              "text-green-400": line.type === "add",
              "text-red-400": line.type === "remove",
              "text-vsc-disabled-fg": line.type === "context",
            }}>
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
            </span>
            <span class="whitespace-pre">
              <HighlightedContent content={line.content} language={props.language} />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

function SideBySide(props: { pairs: Array<{ left: DiffLine | null; right: DiffLine | null }>; language?: string }) {
  return (
    <div class="flex font-mono text-xs" style={{ "line-height": "var(--vscode-editor-line-height, 1.45)" }}>
      {/* Left (old) */}
      <div class="flex-1 min-w-0 border-r border-vsc-panel-border/30">
        <For each={props.pairs}>
          {(pair) => {
            const line = pair.left
            return (
              <div class="flex" classList={{
                "bg-red-500/10": line?.type === "remove",
              }}>
                <span class="select-none text-vsc-disabled-fg w-8 text-right pr-2 shrink-0">
                  {line?.oldLineNo ?? ""}
                </span>
                <span class="whitespace-pre overflow-hidden text-ellipsis">
                  {line ? <HighlightedContent content={line.content} language={props.language} /> : ""}
                </span>
              </div>
            )
          }}
        </For>
      </div>
      {/* Right (new) */}
      <div class="flex-1 min-w-0">
        <For each={props.pairs}>
          {(pair) => {
            const line = pair.right
            return (
              <div class="flex" classList={{
                "bg-green-500/10": line?.type === "add",
              }}>
                <span class="select-none text-vsc-disabled-fg w-8 text-right pr-2 shrink-0">
                  {line?.newLineNo ?? ""}
                </span>
                <span class="whitespace-pre overflow-hidden text-ellipsis">
                  {line ? <HighlightedContent content={line.content} language={props.language} /> : ""}
                </span>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
