import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { isAlive, terminateProcessTree, waitForExit } from "../src/infra/process-tree"

describe("process-tree lifecycle", () => {
  it("terminates a detached long-running process", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    child.unref()

    expect(child.pid).toBeDefined()
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    await terminateProcessTree(pid, { graceMs: 300, forceMs: 300 })

    expect(await waitForExit(pid, 1200)).toBe(true)
    expect(isAlive(pid)).toBe(false)
  })

  it("returns false when process stays alive past timeout", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    child.unref()

    expect(child.pid).toBeDefined()
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    expect(await waitForExit(pid, 100)).toBe(false)

    await terminateProcessTree(pid, { graceMs: 300, forceMs: 300 })
    expect(await waitForExit(pid, 1200)).toBe(true)
  })

  it("does not throw for already-dead pid", async () => {
    await expect(terminateProcessTree(999_999, { graceMs: 100, forceMs: 100 })).resolves.toBeUndefined()
  })
})
