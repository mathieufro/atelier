import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { SessionDropdown } from "./SessionDropdown.jsx"
import type { PipelineSummary } from "@atelier/core"

const makeSession = (id: string, title: string, updated: number) => ({
  id, slug: id, projectID: "p1", directory: "/", title, version: "1",
  time: { created: updated - 1000, updated },
})

const makePipeline = (id: string, prompt: string, status: "running" | "completed" | "idle" | "stuck", updatedAt: number): PipelineSummary => ({
  id, prompt, status, currentStage: status === "running" ? "brainstorm" : null, createdAt: updatedAt - 5000, updatedAt,
})

describe("SessionDropdown", () => {
  it("shows current session title when closed", () => {
    const sessions = [makeSession("s1", "My Session", Date.now())]
    const { container } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    expect(container.textContent).toContain("My Session")
  })

  it("shows 'New Chat' placeholder when no active session", () => {
    const { container } = render(() =>
      <SessionDropdown sessions={[]} onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    expect(container.textContent).toContain("New Chat")
  })

  it("opens dropdown on click and shows sessions grouped by date", async () => {
    const now = Date.now()
    const sessions = [
      makeSession("s1", "Today Session", now),
      makeSession("s2", "Old Session", now - 8 * 86400000),
    ]
    const { container, getByText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("Today Session"))
    expect(container.textContent).toContain("Today")
    expect(container.textContent).toContain("Older")
  })

  it("filters entries by search query", async () => {
    const now = Date.now()
    const sessions = [
      makeSession("s1", "Auth Feature", now),
      makeSession("s2", "Dashboard Work", now - 1000),
    ]
    const { container, getByText, getByPlaceholderText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("Auth Feature"))
    const search = getByPlaceholderText("Search...")
    await fireEvent.input(search, { target: { value: "dash" } })
    const listItems = container.querySelectorAll(".cursor-pointer")
    expect(listItems).toHaveLength(1)
    expect(listItems[0]!.textContent).toContain("Dashboard Work")
  })

  it("calls onSelectSession when a session is clicked", async () => {
    const onSelect = vi.fn()
    const sessions = [makeSession("s1", "First", Date.now()), makeSession("s2", "Second", Date.now() - 1000)]
    const { getByText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onSelectSession={onSelect} onNewSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("First")) // open dropdown
    await fireEvent.click(getByText("Second")) // select session
    expect(onSelect).toHaveBeenCalledWith("s2")
  })

  it("shows 'No conversations yet' when empty", async () => {
    const { container, getByText } = render(() =>
      <SessionDropdown sessions={[]} onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("New Chat"))
    expect(container.textContent).toContain("No conversations yet")
  })

  it("groups sessions into Yesterday bucket", async () => {
    const now = Date.now()
    const sessions = [
      makeSession("s1", "Today Session", now),
      makeSession("s2", "Yesterday Session", now - 1.5 * 86400000),
    ]
    const { container, getByText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("Today Session"))
    expect(container.textContent).toContain("Today")
    expect(container.textContent).toContain("Yesterday")
    expect(container.textContent).not.toContain("This Week")
    expect(container.textContent).not.toContain("Older")
  })

  it("groups sessions into This Week bucket", async () => {
    const now = Date.now()
    const sessions = [
      makeSession("s1", "Today Session", now),
      makeSession("s2", "Midweek Session", now - 3 * 86400000),
    ]
    const { container, getByText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("Today Session"))
    expect(container.textContent).toContain("Today")
    expect(container.textContent).toContain("This Week")
    expect(container.textContent).not.toContain("Yesterday")
    expect(container.textContent).not.toContain("Older")
  })

  it("sorts entries newest-first within each date group", async () => {
    const now = Date.now()
    const sessions = [
      makeSession("s1", "Oldest Today", now - 3600000),
      makeSession("s2", "Newest Today", now),
      makeSession("s3", "Middle Today", now - 1800000),
    ]
    const { container, getByText } = render(() =>
      <SessionDropdown sessions={sessions as any} activeSessionId="s1" onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />,
    )
    await fireEvent.click(getByText("Oldest Today"))
    const items = container.querySelectorAll(".cursor-pointer span.truncate")
    const titles = Array.from(items).map((el) => el.textContent)
    expect(titles).toEqual(["Newest Today", "Middle Today", "Oldest Today"])
  })

  it("shows pipelines alongside sessions in the dropdown", async () => {
    const now = Date.now()
    const sessions = [makeSession("s1", "My Chat", now)]
    const pipelines = [makePipeline("p1", "Build a twitter clone", "running", now - 500)]
    const { container, getByText } = render(() =>
      <SessionDropdown
        sessions={sessions as any} activeSessionId="s1"
        onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}}
        pipelines={pipelines} onSelectPipeline={() => {}}
      />,
    )
    await fireEvent.click(getByText("My Chat"))
    expect(container.textContent).toContain("My Chat")
    expect(container.textContent).toContain("Build a twitter clone")
  })

  it("calls onSelectPipeline when a pipeline entry is clicked", async () => {
    const onSelectPipeline = vi.fn()
    const now = Date.now()
    const sessions = [makeSession("s1", "My Chat", now)]
    const pipelines = [makePipeline("p1", "Build a twitter clone", "running", now - 500)]
    const { getByText } = render(() =>
      <SessionDropdown
        sessions={sessions as any} activeSessionId="s1"
        onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}}
        pipelines={pipelines} onSelectPipeline={onSelectPipeline}
      />,
    )
    await fireEvent.click(getByText("My Chat")) // open
    await fireEvent.click(getByText("Build a twitter clone")) // select pipeline
    expect(onSelectPipeline).toHaveBeenCalledWith("p1")
  })

  it("shows pipeline prompt as header when pipeline is active", () => {
    const pipelines = [makePipeline("p1", "Build a twitter clone app", "running", Date.now())]
    const { container } = render(() =>
      <SessionDropdown
        sessions={[]} onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}}
        pipelines={pipelines} activePipelineId="p1" onSelectPipeline={() => {}}
      />,
    )
    expect(container.textContent).toContain("Build a twitter clone app")
  })

  it("pipeline entries have status indicator dot", async () => {
    const now = Date.now()
    const pipelines = [makePipeline("p1", "Running pipeline", "running", now)]
    const { container, getByText } = render(() =>
      <SessionDropdown
        sessions={[]} onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}}
        pipelines={pipelines} onSelectPipeline={() => {}}
      />,
    )
    await fireEvent.click(getByText("New Chat")) // open (shows "New Chat" since no active session/pipeline)
    // Pipeline entry should have a status dot (rounded-full element)
    const dots = container.querySelectorAll(".rounded-full")
    expect(dots.length).toBeGreaterThan(0)
  })

  it("session dropdown new-chat action calls onNewSession", async () => {
    const onNewSession = vi.fn()
    const { getByText } = render(() => <SessionDropdown sessions={[]} onNewSession={onNewSession} onSelectSession={() => {}} onDeleteSession={() => {}} />)
    await fireEvent.click(getByText("New Chat"))
    await fireEvent.click(getByText("+ New Chat"))
    expect(onNewSession).toHaveBeenCalled()
  })
})
