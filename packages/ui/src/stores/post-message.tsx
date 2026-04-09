import { createContext, useContext } from "solid-js"
import type { WebviewMessage } from "@atelier/core"

type PostFn = (msg: WebviewMessage) => void

const PostMessageContext = createContext<PostFn>()

export const PostMessageProvider = PostMessageContext.Provider

export function usePostMessage(): PostFn | undefined {
  return useContext(PostMessageContext)
}
