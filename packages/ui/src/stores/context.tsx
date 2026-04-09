import { createContext, useContext, type ParentComponent } from "solid-js"
import { createSessionStore, type SessionStore } from "./session-store.js"
import { createMessageStore, type MessageStore } from "./message-store.js"
import { createInteractionStore, type InteractionStore } from "./interaction-store.js"
import { createPipelineStore, type PipelineStore } from "./pipeline-store.js"
import { createRalphStore, type RalphStore } from "./ralph-store.js"

interface Stores {
  sessionStore: SessionStore
  messageStore: MessageStore
  interactionStore: InteractionStore
  pipelineStore: PipelineStore
  ralphStore: RalphStore
}

const StoreContext = createContext<Stores>()

export const StoreProvider: ParentComponent = (props) => {
  const stores: Stores = {
    sessionStore: createSessionStore(),
    messageStore: createMessageStore(),
    interactionStore: createInteractionStore(),
    pipelineStore: createPipelineStore(),
    ralphStore: createRalphStore(),
  }
  return (
    <StoreContext.Provider value={stores}>
      {props.children}
    </StoreContext.Provider>
  )
}

export function useStores(): Stores {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStores must be used within StoreProvider")
  return ctx
}
