import { Show } from "solid-js"

interface ReasoningPillProps {
  variants: string[]
  current: string | undefined
  onChange: (variant: string | undefined) => void
  hidden?: boolean
}

export function ReasoningPill(props: ReasoningPillProps) {
  function cycle() {
    const variants = props.variants
    if (variants.length === 0) return
    if (!props.current) {
      props.onChange(variants[0])
      return
    }
    const idx = variants.indexOf(props.current)
    if (idx === -1 || idx === variants.length - 1) {
      props.onChange(undefined)
    } else {
      props.onChange(variants[idx + 1])
    }
  }

  const isOff = () => !props.current
  const isLast = () => {
    const v = props.variants
    return v.length > 0 && props.current === v[v.length - 1]
  }

  return (
    <Show when={!props.hidden}>
      <button
        data-variant={props.current ?? "off"}
        class="flex items-center h-6 px-1.5 rounded text-xs leading-none transition-colors"
        classList={{
          "text-vsc-description-fg/50": isOff(),
          "text-vsc-link": !isOff() && !isLast(),
          "text-vsc-warning": isLast(),
        }}
        onClick={cycle}
        title={`Reasoning: ${props.current ?? "off"}`}
      >
        <span>{props.current ?? "think:off"}</span>
      </button>
    </Show>
  )
}
