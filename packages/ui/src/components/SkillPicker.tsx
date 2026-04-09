import { For, Show, createEffect, on } from "solid-js"
import type { SkillInfo } from "@atelier/core"

interface SkillPickerProps {
  visible: boolean
  skills: SkillInfo[]
  query: string
  selectedIndex: number
  onSelect: (skill: SkillInfo) => void
  onClose: () => void
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

export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  if (!query) return skills
  const q = query.toLowerCase()
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
}

export function SkillPicker(props: SkillPickerProps) {
  const filtered = () => filterSkills(props.skills, props.query)
  let containerRef!: HTMLDivElement

  // Scroll the selected item into view when selectedIndex changes
  createEffect(on(() => props.selectedIndex, (idx) => {
    if (!props.visible || !containerRef) return
    const el = containerRef.querySelector(`[data-skill-index="${idx}"]`) as HTMLElement
    if (!el) return
    const cTop = containerRef.scrollTop
    const cBottom = cTop + containerRef.clientHeight
    const eTop = el.offsetTop
    const eBottom = eTop + el.offsetHeight
    if (eTop < cTop) containerRef.scrollTop = eTop
    else if (eBottom > cBottom) containerRef.scrollTop = eBottom - containerRef.clientHeight
  }))

  return (
    <Show when={props.visible}>
      <div
        ref={containerRef}
        class="absolute bottom-full left-0 mb-1 w-80 bg-vsc-sidebar-bg border border-vsc-panel-border rounded shadow-lg max-h-56 overflow-y-auto z-20"
      >
        <Show when={filtered().length === 0}>
          <div class="px-3 py-3 text-xs text-vsc-disabled-fg text-center">No matching commands</div>
        </Show>
        <For each={filtered()}>
          {(skill, i) => (
            <button
              data-skill-index={i()}
              class="w-full text-left px-3 py-1.5 text-xs text-vsc-editor-fg flex flex-col gap-0.5"
              classList={{
                "bg-vsc-list-hover": i() === props.selectedIndex,
                "hover:bg-vsc-list-hover": i() !== props.selectedIndex,
              }}
              onClick={() => props.onSelect(skill)}
            >
              <span class="font-medium">/{highlightMatch(skill.name, props.query)}</span>
              <span class="text-vsc-description-fg truncate">{skill.description}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
