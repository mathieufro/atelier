// Stub for vscode module in test environment
export const Uri = {
  file: (path: string) => ({ path, scheme: "file", fsPath: path }),
  joinPath: (...args: any[]) => ({ path: args.map(String).join("/") }),
  parse: (s: string) => ({ path: s }),
}
export const window = {
  showErrorMessage: () => {},
  showWarningMessage: () => {},
  showInformationMessage: (..._args: any[]) => Promise.resolve(undefined),
  showTextDocument: () => Promise.resolve({ selection: null, revealRange: () => {} }),
  showQuickPick: () => Promise.resolve(undefined),
  createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  registerWebviewViewProvider: () => ({ dispose: () => {} }),
  registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
  createWebviewPanel: () => ({
    webview: { html: "", postMessage: () => {}, onDidReceiveMessage: () => {}, asWebviewUri: (u: any) => u, cspSource: "" },
    reveal: () => {},
    onDidDispose: () => {},
    onDidChangeViewState: () => {},
    dispose: () => {},
    active: false,
  }),
  withProgress: (_opts: any, task: any) => task({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
  tabGroups: {
    activeTabGroup: { activeTab: undefined },
    onDidChangeTabs: () => ({ dispose: () => {} }),
  },
}
export const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 }
export const workspace = {
  openTextDocument: () => Promise.resolve({}),
  getConfiguration: () => ({ get: () => null }),
  findFiles: () => Promise.resolve([]),
  workspaceFolders: undefined,
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
}
export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
}
export const ViewColumn = { One: 1, Two: 2, Three: 3 }
export const Position = class { constructor(public line: number, public character: number) {} }
export const Selection = class { constructor(public anchor: any, public active: any) {} }
export const Range = class { constructor(public start: any, public end: any) {} }
