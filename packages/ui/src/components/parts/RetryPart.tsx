import type { RetryPart } from "@atelier/core"

export function RetryPartView(props: { part: RetryPart }) {
  // I8: Fix error message extraction — ApiError has { data: { message } } shape
  const errorMsg = () => {
    const err = props.part.error
    if (!err) return "unknown error"
    if (typeof err === "string") return err
    if (typeof err === "object") {
      const e = err as Record<string, unknown>
      const data = e.data as Record<string, unknown> | undefined
      return (data?.message ?? e.message ?? e.name ?? String(err)) as string
    }
    return String(err)
  }
  return (
    <div class="text-sm text-vsc-warning flex items-center gap-1">
      <span>⟳</span> Retrying: {errorMsg()}
    </div>
  )
}
