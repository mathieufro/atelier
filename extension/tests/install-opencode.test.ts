import { describe, it, expect, vi, beforeEach } from "vitest"

const mockExistsSync = vi.fn()
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  default: { existsSync: (...args: any[]) => mockExistsSync(...args) },
}))

const mockKill = vi.fn()
const mockExec = vi.fn()
vi.mock("node:child_process", () => ({
  exec: (...args: any[]) => mockExec(...args),
  default: { exec: (...args: any[]) => mockExec(...args) },
}))

import { isOpencodeInstalled, installOpencode } from "../src/install-opencode.js"

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
    cb(null, "ok", "")
    return { kill: mockKill }
  })
})

describe("isOpencodeInstalled", () => {
  it("returns true when binary exists", () => {
    mockExistsSync.mockReturnValue(true)
    expect(isOpencodeInstalled()).toBe(true)
  })

  it("returns false when binary missing", () => {
    mockExistsSync.mockReturnValue(false)
    expect(isOpencodeInstalled()).toBe(false)
  })
})

describe("installOpencode", () => {
  const progress = { report: vi.fn() }

  it("reports progress and resolves with binary path on success", async () => {
    mockExistsSync.mockReturnValue(true)
    const result = await installOpencode(progress)
    expect(result).toContain(".opencode/bin/opencode")
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ message: "Downloading OpenCode..." }))
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ message: "OpenCode installed successfully" }))
  })

  it("runs curl install script", async () => {
    mockExistsSync.mockReturnValue(true)
    await installOpencode(progress)
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("curl -fsSL"),
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    )
  })

  it("rejects when exec fails", async () => {
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      cb(new Error("curl failed"), "", "connection refused")
      return { kill: mockKill }
    })
    await expect(installOpencode(progress)).rejects.toThrow(/installation failed.*connection refused/i)
  })

  it("rejects when binary not found after install", async () => {
    mockExistsSync.mockReturnValue(false)
    await expect(installOpencode(progress)).rejects.toThrow(/not found/)
  })

  it("rejects immediately if already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(installOpencode(progress, ac.signal)).rejects.toThrow(/cancelled/)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it("kills child process on abort", async () => {
    const ac = new AbortController()
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      setTimeout(() => cb(new Error("killed"), "", ""), 50)
      return { kill: mockKill }
    })
    const promise = installOpencode(progress, ac.signal)
    ac.abort()
    await expect(promise).rejects.toThrow()
    expect(mockKill).toHaveBeenCalled()
  })
})
