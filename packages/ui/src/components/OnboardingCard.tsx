interface OnboardingCardProps {
  onCheckAgain: () => void
}

export function OnboardingCard(props: OnboardingCardProps) {
  return (
    <div class="flex items-center justify-center h-full bg-vsc-sidebar-bg text-vsc-editor-fg">
      <div class="flex flex-col items-center gap-6 max-w-lg px-6">
        {/* Atelier table logo — inline SVG with currentColor for theme adaptation */}
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" class="text-vsc-description-fg">
          <path d="M2,5 L22,5 L22,8 L2,8 Z" />
          <path d="M4.8,10.2 L7.8,10.2 L5.2,20 L2.5,20 Z" />
          <path d="M16.2,10.2 L19.2,10.2 L21.5,20 L18.8,20 Z" />
        </svg>

        <div class="text-center">
          <h1 class="text-lg font-medium mb-2">No backend detected</h1>
          <p class="text-sm text-vsc-description-fg">
            Atelier needs a backend to run. Set up one of the following:
          </p>
        </div>

        <div class="flex gap-4 w-full">
          {/* Claude Code */}
          <div class="flex-1 rounded border border-vsc-panel-border bg-vsc-input-bg p-4">
            <h2 class="font-medium text-sm mb-1">Claude Code</h2>
            <p class="text-xs text-vsc-description-fg mb-3">Requires Max subscription</p>
            <ol class="text-xs space-y-1.5 list-decimal list-inside text-vsc-description-fg">
              <li>Install Claude Code CLI</li>
              <li>Run <code class="text-vsc-editor-fg">claude login</code></li>
            </ol>
          </div>

          {/* OpenCode */}
          <div class="flex-1 rounded border border-vsc-panel-border bg-vsc-input-bg p-4">
            <h2 class="font-medium text-sm mb-1">OpenCode</h2>
            <p class="text-xs text-vsc-description-fg mb-3">Works with any OpenAI-compatible provider</p>
            <ol class="text-xs space-y-1.5 list-decimal list-inside text-vsc-description-fg">
              <li>Install OpenCode binary</li>
              <li>Run <code class="text-vsc-editor-fg">opencode login</code></li>
            </ol>
          </div>
        </div>

        <button
          class="px-4 py-1.5 rounded text-sm bg-vsc-button-bg text-vsc-button-fg hover:bg-vsc-button-hover-bg"
          onClick={() => props.onCheckAgain()}
        >
          Check again
        </button>
      </div>
    </div>
  )
}
