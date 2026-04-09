import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"

describe("PipelineStateData: Phase 6 fields", () => {
  let tmpDir: string
  let ps: PipelineState

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-phase6-"))
    ps = createPipelineState(tmpDir)
  })

  afterEach(async () => {
    await ps.flush()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("stores worktreePath and worktreeChoice on pipeline", () => {
    const id = ps.createPipeline({
      prompt: "build dashboard",
      workspacePath: tmpDir,
      type: "feature",
    })
    const data = ps.getPipeline(id)!
    expect(data.worktreePath).toBeNull()
    expect(data.worktreeChoice).toBeNull()
  })

  it("persists worktreePath via setWorktreeMetadata", () => {
    const id = ps.createPipeline({
      prompt: "build dashboard",
      workspacePath: tmpDir,
      type: "feature",
    })
    ps.setWorktreeMetadata(id, {
      worktreePath: "/tmp/worktree-abc",
      worktreeChoice: "worktree",
    })
    const data = ps.getPipeline(id)!
    expect(data.worktreePath).toBe("/tmp/worktree-abc")
    expect(data.worktreeChoice).toBe("worktree")
  })

  it("accepts 'epic' as pipeline type", () => {
    const id = ps.createPipeline({
      prompt: "build platform",
      workspacePath: tmpDir,
      type: "epic",
    })
    const data = ps.getPipeline(id)!
    expect(data.type).toBe("epic")
  })

  it("setPipelineType changes the type", () => {
    const id = ps.createPipeline({
      prompt: "build thing",
      workspacePath: tmpDir,
      type: "feature",
    })
    ps.setPipelineType(id, "epic")
    const data = ps.getPipeline(id)!
    expect(data.type).toBe("epic")
  })
})
