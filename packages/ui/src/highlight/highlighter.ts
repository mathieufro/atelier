import { createHighlighterCoreSync } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import langTypescript from "shiki/dist/langs/typescript.mjs"
import langTsx from "shiki/dist/langs/tsx.mjs"
import langJavascript from "shiki/dist/langs/javascript.mjs"
import langJsx from "shiki/dist/langs/jsx.mjs"
import langJson from "shiki/dist/langs/json.mjs"
import langCss from "shiki/dist/langs/css.mjs"
import langHtml from "shiki/dist/langs/html.mjs"
import langPython from "shiki/dist/langs/python.mjs"
import langBash from "shiki/dist/langs/bash.mjs"
import langYaml from "shiki/dist/langs/yaml.mjs"
import langMarkdown from "shiki/dist/langs/markdown.mjs"
import langRust from "shiki/dist/langs/rust.mjs"
import langGo from "shiki/dist/langs/go.mjs"
import langC from "shiki/dist/langs/c.mjs"
import langCpp from "shiki/dist/langs/cpp.mjs"
import langToml from "shiki/dist/langs/toml.mjs"
import langXml from "shiki/dist/langs/xml.mjs"
import langSql from "shiki/dist/langs/sql.mjs"
import langJava from "shiki/dist/langs/java.mjs"
import langRuby from "shiki/dist/langs/ruby.mjs"
import langSwift from "shiki/dist/langs/swift.mjs"
import langPhp from "shiki/dist/langs/php.mjs"
import langVue from "shiki/dist/langs/vue.mjs"
import langSvelte from "shiki/dist/langs/svelte.mjs"
import themeDarkPlus from "shiki/dist/themes/dark-plus.mjs"
import themeLightPlus from "shiki/dist/themes/light-plus.mjs"

export interface HighlightToken {
  content: string
  color?: string
}

// Some lang imports are arrays (include embedded deps), flatten them all
const allLangs = [
  langTypescript, langTsx, langJavascript, langJsx,
  langJson, langCss, langHtml, langPython,
  langBash, langYaml, langMarkdown, langRust,
  langGo, langC, langCpp, langToml,
  langXml, langSql, langJava, langRuby,
  langSwift, langPhp, langVue, langSvelte,
].flat()

const highlighter = createHighlighterCoreSync({
  themes: [themeDarkPlus, themeLightPlus],
  langs: allLangs,
  engine: createJavaScriptRegexEngine(),
})

function detectTheme(): "dark-plus" | "light-plus" {
  if (typeof document !== "undefined" && document.body.classList.contains("vscode-light")) {
    return "light-plus"
  }
  return "dark-plus"
}

const DEFAULT_FG_MAP: Record<string, string> = {
  "dark-plus": "#D4D4D4",
  "light-plus": "#000000",
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html",
  py: "python", pyw: "python",
  rs: "rust",
  go: "go",
  sh: "bash", bash: "bash", zsh: "bash",
  yaml: "yaml", yml: "yaml",
  md: "markdown", mdx: "markdown",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  toml: "toml",
  xml: "xml", svg: "xml", xsl: "xml",
  sql: "sql",
  java: "java",
  rb: "ruby",
  swift: "swift",
  php: "php",
  vue: "vue",
  svelte: "svelte",
}

const LANG_ALIASES: Record<string, string> = {
  shellscript: "bash",
  shell: "bash",
  zsh: "bash",
  sh: "bash",
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  yml: "yaml",
  md: "markdown",
}

/** Detect Shiki language ID from a file path */
export function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase()
  return ext ? EXT_TO_LANG[ext] : undefined
}

/** Normalize a language string to a Shiki language ID */
function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase()
  return LANG_ALIASES[lower] ?? lower
}

/** Highlight code and return tokens per line (for custom rendering like diffs) */
export function highlightTokens(code: string, lang?: string): HighlightToken[][] {
  if (!lang) return code.split("\n").map((line) => [{ content: line }])
  try {
    const theme = detectTheme()
    const defaultFg = DEFAULT_FG_MAP[theme]
    const result = highlighter.codeToTokens(code, { lang: normalizeLang(lang), theme })
    return result.tokens.map((line) =>
      line.map((t) => ({ content: t.content, color: t.color === defaultFg ? undefined : t.color })),
    )
  } catch {
    return code.split("\n").map((line) => [{ content: line }])
  }
}

/** Highlight a single line and return tokens */
export function highlightLine(line: string, lang?: string): HighlightToken[] {
  if (!lang || !line) return [{ content: line }]
  try {
    const theme = detectTheme()
    const defaultFg = DEFAULT_FG_MAP[theme]
    const result = highlighter.codeToTokens(line, { lang: normalizeLang(lang), theme })
    return (
      result.tokens[0]?.map((t) => ({
        content: t.content,
        color: t.color === defaultFg ? undefined : t.color,
      })) ?? [{ content: line }]
    )
  } catch {
    return [{ content: line }]
  }
}
