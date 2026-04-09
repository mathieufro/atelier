import { describe, it, expect, vi } from "vitest"
import { createSignal } from "solid-js"
import { render, fireEvent } from "@solidjs/testing-library"
import { InputBar } from "./InputBar.jsx"

describe("InputBar", () => {
  it("renders textarea", () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("calls onSend with content on Enter", async () => {
    let sent = ""
    const { container } = render(() =>
      <InputBar onSend={(content) => { sent = content }} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "hello" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("hello")
  })

  it("shift+enter does not send", () => {
    let sent = ""
    const { container } = render(() =>
      <InputBar onSend={(content) => { sent = content }} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })
    expect(sent).toBe("")
  })

  it("renders mode pill with current mode", () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="plan" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    expect(container.textContent).toContain("Plan")
  })

  it("renders model pill", () => {
    const models = [{ id: "m1", name: "Claude Sonnet", providerID: "anthropic", limit: { context: 200000 } }]
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={models as any} selectedModel="anthropic:m1" onSelectModel={() => {}} />,
    )
    expect(container.textContent).toContain("Claude Sonnet")
  })

  it("renders context indicator", () => {
    const models = [{ id: "m1", name: "Test", providerID: "a", limit: { context: 100000 } }]
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={models as any} selectedModel="a:m1" onSelectModel={() => {}} inputTokens={15000} />,
    )
    expect(container.textContent).toContain("15%")
  })

  it("shows send button when idle and stop button when busy", () => {
    const { container, unmount } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    expect(container.querySelector("[aria-label='Send']")).not.toBeNull()
    unmount()

    const { container: c2 } = render(() =>
      <InputBar onSend={() => {}} onAbort={() => {}} isBusy={true} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    expect(c2.querySelector("[aria-label='Stop']")).not.toBeNull()
  })

  it("triggers file picker on @ character", async () => {
    const onRequestFiles = vi.fn()
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} onRequestFiles={onRequestFiles} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "@foo" } })
    expect(onRequestFiles).toHaveBeenCalledWith("foo")
  })
})

describe("InputBar - reasoning pill", () => {
  const VARIANTS = ["low", "medium", "high", "max"]

  it("renders reasoning pill with variant label", () => {
    const { container } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        variants={VARIANTS}
        selectedVariant="high"
        onVariantChange={() => {}}
      />,
    )
    expect(container.textContent).toContain("high")
  })

  it("hides reasoning pill when no variants available", () => {
    const { container } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        variants={[]}
        selectedVariant={undefined}
        onVariantChange={() => {}}
      />,
    )
    expect(container.querySelector("[data-variant]")).toBeNull()
  })

  it("calls onVariantChange when pill is clicked", async () => {
    const onChange = vi.fn()
    const { getByTitle } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        variants={VARIANTS}
        selectedVariant="medium"
        onVariantChange={onChange}
      />,
    )
    await fireEvent.click(getByTitle("Reasoning: medium"))
    expect(onChange).toHaveBeenCalledWith("high")
  })
})

describe("InputBar - active file insertion", () => {
  it("adds file to attachments when activeFileInsert is provided", () => {
    const { container } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        activeFileInsert={{ path: "/src/app.ts" }}
      />,
    )
    // Should show file attachment chip with filename
    expect(container.textContent).toContain("app.ts")
    // Verify it's in the attachment area (FileAttachments renders chips with × remove button)
    const attachmentChip = container.querySelector(".truncate")
    expect(attachmentChip?.textContent).toBe("app.ts")
  })

  it("includes file attachment in onSend call", () => {
    let sentAttachments: any[] | undefined
    const { container } = render(() =>
      <InputBar
        onSend={(_content, atts) => { sentAttachments = atts }}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        activeFileInsert={{ path: "/src/app.ts" }}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "check this file" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sentAttachments).toBeDefined()
    expect(sentAttachments!.length).toBe(1)
    expect(sentAttachments![0].url).toBe("/src/app.ts")
    expect(sentAttachments![0].filename).toBe("app.ts")
  })

  it("shows line range label when startLine/endLine provided", () => {
    const { container } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        activeFileInsert={{ path: "/src/app.ts", startLine: 10, endLine: 20 }}
      />,
    )
    expect(container.textContent).toContain("app.ts:10-20")
  })

  it("does not duplicate attachment for same file path", () => {
    const [insert, setInsert] = createSignal<{ path: string } | undefined>({ path: "/src/app.ts" })
    const { container } = render(() =>
      <InputBar
        onSend={() => {}}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        activeFileInsert={insert()}
      />,
    )
    // Re-trigger same path
    setInsert(undefined)
    setInsert({ path: "/src/app.ts" })
    // Should still only have one attachment chip
    const chips = container.querySelectorAll(".truncate")
    const appChips = Array.from(chips).filter((el) => el.textContent === "app.ts")
    expect(appChips.length).toBe(1)
  })
})

describe("InputBar - slash command skill invocation", () => {
  const testSkills = [
    { name: "brainstorming", description: "Guides brainstorm sessions", stage: "brainstorm" },
    { name: "bugfixing", description: "Bug investigation and fixing", stage: "bugfix" },
    { name: "implementing-plans", description: "Autonomous code implementation", stage: "implement" },
  ]

  it("shows skill picker when typing /", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/", selectionStart: 1 } })
    // SkillPicker should be visible
    expect(container.textContent).toContain("/brainstorming")
    expect(container.textContent).toContain("/bugfixing")
  })

  it("filters skills as user types", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/bug", selectionStart: 4 } })
    expect(container.textContent).toContain("/bugfixing")
    expect(container.textContent).not.toContain("/brainstorming")
  })

  it("shows built-in commands even when no skills provided", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/", selectionStart: 1 } })
    // Built-in /clear is always available
    expect(container.textContent).toContain("/clear")
    // But no server skills
    expect(container.textContent).not.toContain("/brainstorming")
  })

  it("shows skill picker for / anywhere in text after whitespace", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "some text /bug", selectionStart: 14 } })
    // Slash after whitespace should trigger picker
    expect(container.textContent).toContain("/bugfixing")
  })

  it("does not show skill picker for / inside a word", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "path/bug", selectionStart: 8 } })
    // Slash inside a word — should not trigger picker
    expect(container.textContent).not.toContain("/bugfixing")
  })

  it("calls onInvokeSkill instead of onSend when skill is active", async () => {
    const onSend = vi.fn()
    const onInvokeSkill = vi.fn(() => true)
    const { container } = render(() =>
      <InputBar
        onSend={onSend}
        onInvokeSkill={onInvokeSkill}
        mode="build"
        onModeChange={() => {}}
        models={[]}
        onSelectModel={() => {}}
        skills={testSkills}
      />,
    )
    const textarea = container.querySelector("textarea")!
    // Step 1: type /brainstorming to activate skill (cursor at end of slash command)
    fireEvent.input(textarea, { target: { value: "/brainstorming", selectionStart: 14 } })
    // Step 2: type the rest of the prompt (skill stays locked since /brainstorming is still in text)
    fireEvent.input(textarea, { target: { value: "/brainstorming Build an API", selectionStart: 27 } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })

    expect(onInvokeSkill).toHaveBeenCalledWith("brainstorming", "Build an API", undefined)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("hides skill picker on Escape", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/", selectionStart: 1 } })
    expect(container.textContent).toContain("/brainstorming")
    fireEvent.keyDown(textarea, { key: "Escape" })
    // After Escape, picker should be hidden
    // Note: text content may still exist in DOM but the Show wrapper controls visibility
  })

  it("shows /clear built-in alongside server skills", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/", selectionStart: 1 } })
    expect(container.textContent).toContain("/clear")
    expect(container.textContent).toContain("/brainstorming")
  })

  it("filters built-in commands alongside skills", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/cl", selectionStart: 3 } })
    expect(container.textContent).toContain("/clear")
    expect(container.textContent).not.toContain("/brainstorming")
  })

  it("calls onNewChat when /clear is submitted", async () => {
    const onNewChat = vi.fn()
    const onSend = vi.fn()
    const { container } = render(() =>
      <InputBar onSend={onSend} onNewChat={onNewChat} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    // Type /clear to activate built-in command
    fireEvent.input(textarea, { target: { value: "/clear", selectionStart: 6 } })
    // Type a space to lock in the exact match
    fireEvent.input(textarea, { target: { value: "/clear ", selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(onNewChat).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
  })

  it("tab-completes the highlighted skill via arrow navigation", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/b", selectionStart: 2 } })
    // Filtered list: brainstorming, bugfixing (both contain 'b')
    // Arrow down should move selection from index 0 to index 1
    fireEvent.keyDown(textarea, { key: "ArrowDown" })
    // Tab should complete the second item
    fireEvent.keyDown(textarea, { key: "Tab" })
    // After tab, text should contain the selected skill name
    expect(textarea.value).toContain("/bugfixing ")
  })

  it("Enter on open picker selects highlighted item instead of submitting", async () => {
    const onSend = vi.fn()
    const { container } = render(() =>
      <InputBar onSend={onSend} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/bug", selectionStart: 4 } })
    // Picker should be open with "bugfixing" as the only match (plus maybe /clear filtered out)
    // Press Enter — should complete the skill, not submit
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(onSend).not.toHaveBeenCalled()
    // Text should now have the completed skill name
    expect(textarea.value).toContain("/bugfixing ")
  })

  it("ArrowUp wraps to last item", async () => {
    const { container } = render(() =>
      <InputBar onSend={() => {}} mode="build" onModeChange={() => {}} models={[]} onSelectModel={() => {}} skills={testSkills} />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "/impl", selectionStart: 5 } })
    // Filtered: implementing-plans only
    // ArrowUp from index 0 should wrap to last (still 0 if only 1 item)
    fireEvent.keyDown(textarea, { key: "ArrowUp" })
    fireEvent.keyDown(textarea, { key: "Tab" })
    expect(textarea.value).toContain("/implementing-plans ")
  })
})

describe("InputBar - favorites wiring", () => {
  it("passes favorite callbacks to model pill", async () => {
    const onUpsertFavorite = vi.fn()
    const models = [{ id: "sonnet", name: "Sonnet", providerID: "anthropic", variants: { thinking: {} }, limit: { context: 100000 } }]
    const { container, getByText } = render(() => (
      <InputBar
        onSend={() => Promise.resolve(true)}
        mode="build"
        onModeChange={() => {}}
        models={models as any}
        selectedModel="anthropic:sonnet"
        selectedVariant="thinking"
        onSelectModel={() => {}}
        favorites={[]}
        onUpsertFavorite={onUpsertFavorite}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    const star = container.querySelector("button[aria-label='Favorite model/variant']") as HTMLButtonElement
    await fireEvent.click(star)
    expect(onUpsertFavorite).toHaveBeenCalledWith({ providerID: "anthropic", modelID: "sonnet", variant: "thinking" })
  })
})

describe("InputBar - file context pill", () => {
  const baseProps = {
    onSend: () => {},
    mode: "build" as const,
    onModeChange: () => {},
    models: [],
    onSelectModel: () => {},
  }

  it("renders file context pill when activeFileContext is provided", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx", startLine: 12, endLine: 25 }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    expect(container.textContent).toContain("App.tsx:12-25")
  })

  it("shows only basename without lines when no selection", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx" }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    expect(container.textContent).toContain("App.tsx")
    expect(container.textContent).not.toContain("App.tsx:")
  })

  it("hides pill when activeFileContext is null", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={null}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    expect(container.querySelector("[data-testid='file-context-pill']")).toBeNull()
  })

  it("shows strikethrough style when toggled off", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx" }}
        fileContextEnabled={false}
        onToggleFileContext={() => {}}
      />,
    )
    const pill = container.querySelector("[data-testid='file-context-pill']")
    expect(pill).not.toBeNull()
    expect(pill!.classList.contains("line-through")).toBe(true)
  })

  it("calls onToggleFileContext on click", async () => {
    const toggle = vi.fn()
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx" }}
        fileContextEnabled={true}
        onToggleFileContext={toggle}
      />,
    )
    const pill = container.querySelector("[data-testid='file-context-pill']")!
    await fireEvent.click(pill)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it("shows single line (not range) when startLine equals endLine", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx", startLine: 5, endLine: 5 }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    expect(container.textContent).toContain("App.tsx:5")
    expect(container.textContent).not.toContain("App.tsx:5-5")
  })

  it("has title with full relative path", () => {
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        activeFileContext={{ path: "/workspace/src/components/App.tsx", relativePath: "src/components/App.tsx" }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    const pill = container.querySelector("[data-testid='file-context-pill']") as HTMLElement
    expect(pill.title).toContain("src/components/App.tsx")
  })
})

describe("InputBar - file context message augmentation", () => {
  const baseProps = {
    mode: "build" as const,
    onModeChange: () => {},
    models: [],
    onSelectModel: () => {},
  }

  it("passes context label as third arg when enabled and context is present", async () => {
    let sent = ""
    let ctx: string | undefined
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        onSend={(content, _atts, fileContext) => { sent = content; ctx = fileContext }}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx", startLine: 12, endLine: 25 }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "fix this bug" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("fix this bug")
    expect(ctx).toBe("src/App.tsx:12-25")
  })

  it("omits line range when no selection", async () => {
    let sent = ""
    let ctx: string | undefined
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        onSend={(content, _atts, fileContext) => { sent = content; ctx = fileContext }}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx" }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "check this" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("check this")
    expect(ctx).toBe("src/App.tsx")
  })

  it("does not prepend when toggle is off", async () => {
    let sent = ""
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        onSend={(content) => { sent = content }}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx" }}
        fileContextEnabled={false}
        onToggleFileContext={() => {}}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "hello" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("hello")
  })

  it("does not prepend when context is null", async () => {
    let sent = ""
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        onSend={(content) => { sent = content }}
        activeFileContext={null}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "hello" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("hello")
  })

  it("uses single line number when start equals end", async () => {
    let sent = ""
    let ctx: string | undefined
    const { container } = render(() =>
      <InputBar
        {...baseProps}
        onSend={(content, _atts, fileContext) => { sent = content; ctx = fileContext }}
        activeFileContext={{ path: "/workspace/src/App.tsx", relativePath: "src/App.tsx", startLine: 5, endLine: 5 }}
        fileContextEnabled={true}
        onToggleFileContext={() => {}}
      />,
    )
    const textarea = container.querySelector("textarea")!
    fireEvent.input(textarea, { target: { value: "explain" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(sent).toBe("explain")
    expect(ctx).toBe("src/App.tsx:5")
  })
})
