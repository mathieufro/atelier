import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { StoreProvider } from "../stores/context.jsx"
import { PostMessageProvider } from "../stores/post-message.jsx"
import { InputBar } from "./InputBar.jsx"

describe("InputBar - Feature mode placeholders", () => {
  const noop = () => {}

  it("shows 'Describe a feature to build...' when in Feature mode with no pipeline", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <InputBar
            onSend={noop}
            onModeChange={noop}
            isBusy={false}
            mode="feature"
            pipelineStage={null}
            models={[]}
            onSelectModel={noop}
            fileResults={[]}
            onRequestFiles={noop}
            variants={[]}
            onVariantChange={noop}
          />
        </StoreProvider>
      </PostMessageProvider>
    )
    const textarea = container.querySelector("textarea")
    expect(textarea?.placeholder).toContain("Describe a feature")
  })

  it("shows 'Reply to brainstorm...' during brainstorm stage", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <InputBar
            onSend={noop}
            onModeChange={noop}
            isBusy={false}
            mode="feature"
            pipelineStage="brainstorm"
            models={[]}
            onSelectModel={noop}
            fileResults={[]}
            onRequestFiles={noop}
            variants={[]}
            onVariantChange={noop}
          />
        </StoreProvider>
      </PostMessageProvider>
    )
    const textarea = container.querySelector("textarea")
    expect(textarea?.placeholder).toContain("Reply to brainstorm")
  })

  it("shows 'Send a message to the agent...' during autonomous stages", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <InputBar
            onSend={noop}
            onModeChange={noop}
            isBusy={false}
            mode="feature"
            pipelineStage="implement"
            models={[]}
            onSelectModel={noop}
            fileResults={[]}
            onRequestFiles={noop}
            variants={[]}
            onVariantChange={noop}
          />
        </StoreProvider>
      </PostMessageProvider>
    )
    const textarea = container.querySelector("textarea")
    expect(textarea?.placeholder).toContain("Send a message to the agent")
  })
})
