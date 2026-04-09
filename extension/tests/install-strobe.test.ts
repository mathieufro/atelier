import { describe, it, expect, vi, beforeEach } from "vitest"

const mockExistsSync = vi.fn()
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  default: { existsSync: (...args: any[]) => mockExistsSync(...args) },
}))

const mockKill = vi.fn()
const mockExec = vi.fn()
const mockExecFileSync = vi.fn()
vi.mock("node:child_process", () => ({
  exec: (...args: any[]) => mockExec(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
  default: { exec: (...args: any[]) => mockExec(...args), execFileSync: (...args: any[]) => mockExecFileSync(...args) },
}))

import { isStrobeInstalled, installStrobe } from "../src/install-strobe.js"

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
    cb(null, "ok", "")
    return { kill: mockKill }
  })
})

describe("isStrobeInstalled", () => {
  it("returns true when strobe binary exists in ~/.strobe/bin", () => {
    mockExistsSync.mockReturnValue(true)
    expect(isStrobeInstalled()).toBe(true)
  })

  it("returns true when strobe is in ~/.cargo/bin", () => {
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true)
    expect(isStrobeInstalled()).toBe(true)
  })

  it("returns true when strobe is on PATH but not in known locations", () => {
    mockExistsSync.mockReturnValue(false)
    mockExecFileSync.mockReturnValue(Buffer.from(""))
    expect(isStrobeInstalled()).toBe(true)
  })

  it("returns false when strobe binary does not exist anywhere", () => {
    mockExistsSync.mockReturnValue(false)
    mockExecFileSync.mockImplementation(() => { throw new Error("not found") })
    expect(isStrobeInstalled()).toBe(false)
  })
})

describe("installStrobe", () => {
  const progress = { report: vi.fn() }

  it("runs the strobe install script and resolves on success", async () => {
    mockExistsSync.mockReturnValue(true)
    const result = await installStrobe(progress)
    expect(result).toContain("strobe")
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ message: "Installing Strobe..." }))
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ message: "Strobe installed successfully" }))
  })

  it("runs curl install script", async () => {
    mockExistsSync.mockReturnValue(true)
    await installStrobe(progress)
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("curl -fsSL"),
      expect.objectContaining({ timeout: 300_000 }),
      expect.any(Function),
    )
  })

  it("rejects when install script fails", async () => {
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      cb(new Error("curl failed"), "", "connection refused")
      return { kill: mockKill }
    })
    await expect(installStrobe(progress)).rejects.toThrow(/installation failed.*connection refused/i)
  })

  it("rejects when binary not found after install", async () => {
    mockExistsSync.mockReturnValue(false)
    await expect(installStrobe(progress)).rejects.toThrow(/not found/)
  })

  it("rejects when cancelled via abort signal", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(installStrobe(progress, ac.signal)).rejects.toThrow(/cancelled/)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it("kills child process on abort", async () => {
    const ac = new AbortController()
    mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
      setTimeout(() => cb(new Error("killed"), "", ""), 50)
      return { kill: mockKill }
    })
    const promise = installStrobe(progress, ac.signal)
    ac.abort()
    await expect(promise).rejects.toThrow()
    expect(mockKill).toHaveBeenCalled()
  })
})
