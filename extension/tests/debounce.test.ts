import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Inline debounce extracted for testing
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }) as unknown as T
}

describe("debounce", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("calls function after delay", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 150)
    debounced()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(fn).toHaveBeenCalledOnce()
  })

  it("coalesces rapid calls into one", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 150)
    debounced()
    debounced()
    debounced()
    vi.advanceTimersByTime(150)
    expect(fn).toHaveBeenCalledOnce()
  })

  it("resets timer on each call", () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 150)
    debounced()
    vi.advanceTimersByTime(100)
    debounced() // reset
    vi.advanceTimersByTime(100)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledOnce()
  })
})
