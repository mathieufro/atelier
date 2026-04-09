/* @refresh reload */
import { render } from "solid-js/web"
import { App } from "./App.jsx"
import "./index.css"

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void
  setState(state: unknown): void
  getState(): unknown
}

const vscode = acquireVsCodeApi()
const savedState = vscode.getState() as { activeSessionId?: string; activePipelineId?: string; fileContextEnabled?: boolean } | undefined

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

render(
  () => (
    <App
      postMessage={(msg) => vscode.postMessage(msg)}
      setState={(state) => vscode.setState(state)}
      initialActiveSessionId={savedState?.activeSessionId}
      initialActivePipelineId={savedState?.activePipelineId}
      initialFileContextEnabled={savedState?.fileContextEnabled}
    />
  ),
  root,
)
