import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { StoreProvider, useStores } from "./context.jsx"

describe("StoreProvider", () => {
  it("provides stores to children", () => {
    let captured: any
    function Child() {
      captured = useStores()
      return null
    }
    render(() => (
      <StoreProvider>
        <Child />
      </StoreProvider>
    ))
    expect(captured.sessionStore).toBeDefined()
    expect(captured.messageStore).toBeDefined()
    expect(captured.interactionStore).toBeDefined()
  })
})
