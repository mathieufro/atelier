import {
  parser,
  parser_write,
  parser_end,
  type Token,
  type Attr,
  type Renderer,
  STRONG_AST,
  STRONG_UND,
  ITALIC_AST,
  ITALIC_UND,
  STRIKE,
  CODE_INLINE,
  CODE_FENCE,
  CODE_BLOCK,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HEADING_4,
  HEADING_5,
  HEADING_6,
  LINK,
  RAW_URL,
  IMAGE,
  LIST_ORDERED,
  LIST_UNORDERED,
  LIST_ITEM,
  BLOCKQUOTE,
  PARAGRAPH,
  TABLE,
  TABLE_ROW,
  TABLE_CELL,
  HREF,
  SRC,
  LANG,
} from "streaming-markdown"
import type { WebviewMessage } from "@atelier/core"

export interface RendererOptions {
  onFileClick?: (path: string, line?: number) => void
  postMessage?: (msg: WebviewMessage) => void
}

// Require paths starting with /, ./, or common project patterns
function createFilePathRegex(): RegExp {
  return /(?:^|\s)((?:\.\/|\/|src\/|packages\/|extension\/)(?:[\w .-]+\/)*[\w .-]+(?::(\d+)(?::\d+)?)?)/g
}

// I12: Dangerous URI schemes to sanitize in links
const DANGEROUS_SCHEMES = /^(javascript|data|vbscript):/i

// State object used as the Renderer `data` property
interface RenderState {
  stack: HTMLElement[]
  currentCodeBlock: HTMLElement | null
  currentCodeLang: string
  codeText: string
  container: HTMLElement
  options: RendererOptions
}

// C5: Custom SolidJS-compatible renderer with syntax highlighting, copy buttons, and streaming file path detection
function createCustomRenderer(
  container: HTMLElement,
  options: RendererOptions = {},
): Renderer<RenderState> {
  const data: RenderState = {
    stack: [container],
    currentCodeBlock: null,
    currentCodeLang: "",
    codeText: "",
    container,
    options,
  }

  return {
    data,
    add_token(state: RenderState, type: Token) {
      const top = state.stack[state.stack.length - 1] ?? state.container
      let el: HTMLElement
      switch (type) {
        case STRONG_AST:
        case STRONG_UND:
          el = document.createElement("strong")
          break
        case ITALIC_AST:
        case ITALIC_UND:
          el = document.createElement("em")
          break
        case STRIKE:
          el = document.createElement("del")
          break
        case CODE_INLINE:
          el = document.createElement("code")
          el.className = "bg-vsc-input-bg px-1 py-px rounded font-mono text-[0.9em] leading-[1.35]"
          break
        case CODE_FENCE:
        case CODE_BLOCK:
          {
            const wrapper = document.createElement("div")
            wrapper.className = "relative group my-2"

            // Copy button
            const copyBtn = document.createElement("button")
            copyBtn.className = "absolute top-2 right-2 px-2 py-1 text-xs bg-vsc-input-bg text-vsc-description-fg rounded opacity-0 group-hover:opacity-100 transition-opacity"
            copyBtn.textContent = "Copy"
            el = document.createElement("pre")
            el.className = "bg-vsc-sidebar-bg rounded-lg p-3 overflow-x-auto font-mono text-xs leading-5"
            const code = document.createElement("code")

            copyBtn.onclick = () => {
              const text = code.textContent ?? ""
              if (options.postMessage) {
                options.postMessage({ type: "copyToClipboard", text })
              } else {
                navigator.clipboard.writeText(text).catch(() => {})
              }
              copyBtn.textContent = "Copied!"
              setTimeout(() => { copyBtn.textContent = "Copy" }, 1500)
            }
            wrapper.appendChild(copyBtn)
            el.appendChild(code)
            wrapper.appendChild(el)
            top.appendChild(wrapper)
            state.currentCodeBlock = code
            state.codeText = ""
            state.stack.push(code)
            return
          }
        case HEADING_1:
        case HEADING_2:
        case HEADING_3:
        case HEADING_4:
        case HEADING_5:
        case HEADING_6:
          el = document.createElement("h3")
          el.className = "text-sm font-semibold text-vsc-editor-fg mt-3 mb-1"
          break
        case LINK:
        case RAW_URL:
          el = document.createElement("a")
          el.className = "text-vsc-link hover:underline"
          break
        case IMAGE:
          el = document.createElement("img")
          el.className = "max-w-md rounded"
          break
        case LIST_ORDERED:
          el = document.createElement("ol")
          el.className = "list-decimal list-outside pl-5 space-y-1 my-1"
          break
        case LIST_UNORDERED:
          el = document.createElement("ul")
          el.className = "list-disc list-outside pl-5 space-y-1 my-1"
          break
        case LIST_ITEM:
          el = document.createElement("li")
          el.className = "leading-[1.3]"
          break
        case BLOCKQUOTE:
          el = document.createElement("blockquote")
          el.className = "border-l-2 border-vsc-panel-border pl-4 pr-1 py-1.5 my-2 text-vsc-description-fg italic leading-[1.55]"
          break
        case PARAGRAPH:
          el = document.createElement("p")
          el.className = "mb-1"
          break
        case TABLE:
          el = document.createElement("table")
          el.className = "border-collapse my-2"
          break
        case TABLE_ROW:
          el = document.createElement("tr")
          break
        case TABLE_CELL:
          el = document.createElement("td")
          el.className = "border border-vsc-panel-border px-2 py-1"
          break
        default:
          el = document.createElement("span")
      }
      top.appendChild(el)
      state.stack.push(el)
    },

    end_token(state: RenderState) {
      // Check if we're ending a code fence by seeing if current top is a code element inside a pre
      if (state.currentCodeBlock && state.stack[state.stack.length - 1] === state.currentCodeBlock) {
        if (state.currentCodeLang) {
          state.currentCodeBlock.className = `language-${state.currentCodeLang}`
        }
        state.currentCodeBlock = null
        state.currentCodeLang = ""
      }
      if (state.stack.length > 1) state.stack.pop()
    },

    add_text(state: RenderState, text: string) {
      if (text == null) return
      const top = state.stack[state.stack.length - 1] ?? state.container
      if (state.currentCodeBlock) {
        state.codeText += text
        state.currentCodeBlock.appendChild(document.createTextNode(text))
        return
      }
      // Render plain text during streaming — file path detection is done as a
      // post-processing pass in end() to avoid partial matches from chunked delivery
      top.appendChild(document.createTextNode(text))
    },

    set_attr(state: RenderState, type: Attr, value: string) {
      const el = state.stack[state.stack.length - 1] ?? state.container
      if (type === LANG) {
        state.currentCodeLang = value
      } else if (type === HREF) {
        // I12: Sanitize dangerous URI schemes
        if (DANGEROUS_SCHEMES.test(value.trim())) return
        el.setAttribute("href", value)
      } else if (type === SRC) {
        el.setAttribute("src", value)
      }
    },
  }
}

/** Generate a VS Code command URI to open a file */
function fileCommandUri(filePath: string, line?: number): string {
  const args = line != null ? [filePath, line] : [filePath]
  return `command:atelier.openFile?${encodeURIComponent(JSON.stringify(args))}`
}

function splitWithFilePaths(
  text: string,
): Node[] {
  const regex = createFilePathRegex()
  const nodes: Node[] = []
  let lastIndex = 0

  for (const match of text.matchAll(regex)) {
    const idx = match.index!
    if (idx > lastIndex) nodes.push(document.createTextNode(text.slice(lastIndex, idx)))
    const prefix = match[0].startsWith(" ") ? " " : ""
    if (prefix) nodes.push(document.createTextNode(prefix))
    const rawPath = match[1]!
    const line = match[2] ? parseInt(match[2], 10) : undefined
    const filePath = line == null ? rawPath : rawPath.replace(/:\d+(?::\d+)?$/, "")
    const link = document.createElement("a")
    link.setAttribute("data-file-path", filePath)
    link.className = "file-link hover:underline"
    link.textContent = rawPath
    link.href = fileCommandUri(filePath, line)
    nodes.push(link)
    lastIndex = idx + match[0].length
  }

  if (lastIndex < text.length) nodes.push(document.createTextNode(text.slice(lastIndex)))
  if (nodes.length === 0) nodes.push(document.createTextNode(text))
  return nodes
}

export function createStreamingRenderer(
  container: HTMLElement,
  options: RendererOptions = {},
) {
  // C5: Use custom renderer instead of default_renderer
  const renderer = createCustomRenderer(container, options)
  const p = parser(renderer)
  let disposed = false

  return {
    write(text: string) {
      if (disposed) return
      parser_write(p, text)
    },
    end() {
      if (disposed) return
      parser_end(p)
      normalizeMultilineInlineCode(container)
      // C5: Post-render file path detection on fully assembled text nodes
      if (options.onFileClick) {
        wrapFilePaths(container, options.onFileClick)
      }
      // I12: Post-render sanitization of any links the parser created
      sanitizeLinks(container)
    },
    cleanup() {
      disposed = true
    },
  }
}

function normalizeMultilineInlineCode(container: HTMLElement) {
  normalizeCodeOnlyParagraphRuns(container)

  const elements = Array.from(container.querySelectorAll("p, li, blockquote")) as HTMLElement[]

  for (const parent of elements) {
    let node: Node | null = parent.firstChild

    while (node) {
      if (!isInlineCodeNode(node)) {
        node = node.nextSibling
        continue
      }

      const runNodes: Node[] = [node]
      const lines: string[] = [node.textContent ?? ""]
      let cursor = node.nextSibling
      let separators: Node[] = []

      while (cursor) {
        if (isCodeSeparatorNode(cursor)) {
          separators.push(cursor)
          cursor = cursor.nextSibling
          continue
        }
        if (isInlineCodeNode(cursor)) {
          runNodes.push(...separators, cursor)
          separators = []
          lines.push(cursor.textContent ?? "")
          cursor = cursor.nextSibling
          continue
        }
        break
      }

      if (lines.length >= 2) {
        const pre = document.createElement("pre")
        pre.className = "bg-vsc-sidebar-bg rounded-lg p-3 overflow-x-auto font-mono text-xs leading-5 my-2"
        const code = document.createElement("code")
        code.textContent = lines.join("\n")
        pre.appendChild(code)

        const runSet = new Set(runNodes)
        const onlyRunContent = Array.from(parent.childNodes).every((child) => runSet.has(child) || isWhitespaceTextNode(child))
        if (parent.tagName === "P" && onlyRunContent) {
          parent.parentElement?.insertBefore(pre, parent)
          parent.parentElement?.removeChild(parent)
        } else {
          parent.insertBefore(pre, runNodes[0] ?? null)
          for (const n of runNodes) parent.removeChild(n)
        }
        node = pre.nextSibling
        continue
      }

      node = cursor
    }
  }
}

function normalizeCodeOnlyParagraphRuns(container: HTMLElement) {
  const scopes = [container]

  for (const scope of scopes) {
    const children = Array.from(scope.children)

    for (let i = 0; i < children.length;) {
      const first = children[i] as HTMLElement
      if (first.tagName !== "P") {
        i++
        continue
      }

      const lines: string[] = []
      let j = i

      while (j < children.length) {
        const el = children[j] as HTMLElement
        if (el.tagName !== "P") break
        const line = extractCodeOnlyParagraphLine(el)
        if (line === undefined) break
        lines.push(line)
        j++
      }

      if (lines.length >= 2) {
        const pre = document.createElement("pre")
        pre.className = "bg-vsc-sidebar-bg rounded-lg p-3 overflow-x-auto font-mono text-xs leading-5 my-2"
        const code = document.createElement("code")
        code.textContent = lines.join("\n")
        pre.appendChild(code)
        scope.insertBefore(pre, children[i] ?? null)
        for (let k = i; k < j; k++) scope.removeChild(children[k]!)
        i = j
        continue
      }

      i++
    }
  }
}

function extractCodeOnlyParagraphLine(paragraph: HTMLElement): string | undefined {
  const codes = Array.from(paragraph.querySelectorAll("code")).filter((code) => code.parentElement?.tagName !== "PRE")
  if (codes.length !== 1) return undefined

  const clone = paragraph.cloneNode(true) as HTMLElement
  for (const code of Array.from(clone.querySelectorAll("code"))) code.remove()
  if ((clone.textContent ?? "").trim() !== "") return undefined

  return codes[0]!.textContent ?? undefined
}

function isInlineCodeNode(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE
    && (node as HTMLElement).tagName === "CODE"
    && (node as HTMLElement).parentElement?.tagName !== "PRE"
}

function isCodeSeparatorNode(node: Node): boolean {
  if (isWhitespaceTextNode(node)) return true
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as HTMLElement
  if (el.tagName === "BR") return true
  return el.tagName === "SPAN" && (el.textContent ?? "").trim() === ""
}

function isWhitespaceTextNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && /^\s*$/.test(node.textContent ?? "")
}

// C5: Walk text nodes and wrap file paths with clickable spans
function wrapFilePaths(container: HTMLElement, onClick: (path: string, line?: number) => void) {
  // Collect text nodes first (avoid live NodeList mutation during iteration)
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    // Skip text inside fenced code blocks and inline code
    const parent = node.parentElement
    if (parent?.closest("pre") || parent?.closest("code")) continue
    textNodes.push(node)
  }

  // Group truly adjacent text nodes for complete path matching
  // (smd may split text across multiple text nodes, but we must not merge across element boundaries)
  const runs: { parent: HTMLElement; nodes: Text[] }[] = []
  for (const tn of textNodes) {
    const p = tn.parentElement
    if (!p) continue
    const lastRun = runs[runs.length - 1]
    if (lastRun && lastRun.parent === p && lastRun.nodes[lastRun.nodes.length - 1]!.nextSibling === tn) {
      lastRun.nodes.push(tn)
    } else {
      runs.push({ parent: p, nodes: [tn] })
    }
  }

  for (const { parent, nodes } of runs) {
    const fullText = nodes.map((n) => n.textContent ?? "").join("")
    const regex = createFilePathRegex()
    if (!regex.test(fullText)) continue

    const replacements = splitWithFilePaths(fullText)
    const first = nodes[0] ?? null
    for (const r of replacements) parent.insertBefore(r, first)
    for (const n of nodes) parent.removeChild(n)
  }
}

// I12: Remove dangerous schemes from any links in the container
function sanitizeLinks(container: HTMLElement) {
  const links = container.querySelectorAll("a[href]")
  for (const link of links) {
    const href = link.getAttribute("href") ?? ""
    if (DANGEROUS_SCHEMES.test(href.trim())) {
      link.removeAttribute("href")
      ;(link as HTMLElement).style.cursor = "default"
      ;(link as HTMLElement).style.textDecoration = "none"
    }
  }
}
