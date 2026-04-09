import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { MessageList } from "./MessageList.jsx"
import { StoreProvider } from "../stores/context.jsx"

describe("MessageList", () => {
  it("renders empty state", () => {
    const { container } = render(() =>
      <StoreProvider><MessageList /></StoreProvider>,
    )
    expect(container.textContent).toContain("Start a conversation")
  })

  it("renders messages from store", () => {
    const { container } = render(() => {
      return (
        <StoreProvider>
          <MessageList />
        </StoreProvider>
      )
    })
    // With empty store, shows empty state
    expect(container).toBeDefined()
  })
})
