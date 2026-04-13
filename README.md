[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/mathieufro/atelier/actions/workflows/ci.yml/badge.svg)](https://github.com/mathieufro/atelier/actions/workflows/ci.yml)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="extension/resources/icon-dark.svg" width="80">
    <source media="(prefers-color-scheme: light)" srcset="extension/resources/icon-light.svg" width="80">
    <img alt="Atelier" src="extension/resources/icon-light.svg" width="80">
  </picture>
</p>

<h1 align="center">Atelier</h1>

<p align="center">
  Autonomous coding orchestration — takes a prompt through brainstorm, plan, build, review, and test with minimal human intervention.
</p>

---

## The Pipeline

Atelier isn't "chat with an AI." It's a 15-stage autonomous pipeline where specialized agents collaborate, review each other's work, and fix issues in-loop before delivering results.

```
Brainstorm → Spec → Review → Conventions → Plan → Review → Implement → Code Review → Simplify → E2E Gate → E2E Tests
     ↑                  ↓                            ↓                       ↓
  interactive      fix cycles                   fix cycles              fix cycles
```

**Fresh-eyes review stages** — Review agents run in clean sessions with zero context from the stage they're reviewing. They catch what the author agent misses because they have no confirmation bias from having written the code.

**Review → fix cycles** — When a reviewer finds issues, a fixer agent addresses them in-loop (up to 3 attempts). Issues are caught and fixed before delivery, not shipped.

**Skill-driven orchestration** — Each stage loads a specialized skill (SKILL.md) that defines exactly how that agent should behave. Purpose-built agents per stage, not a generic prompt doing everything.

**E2E gate** — Automatically evaluates whether the feature warrants end-to-end testing. Research projects and config work skip E2E; apps, APIs, and CLI tools get full test coverage.

**Human-in-the-loop only where it matters** — The brainstorm stage is interactive. Everything after is autonomous.

## Multi-Backend

Atelier is not locked to one LLM provider. It supports multiple backends simultaneously through a BackendRegistry:

- **Claude Code** (Anthropic) — via the Anthropic Agent SDK
- **OpenCode** (OpenAI-compatible) — via the OpenCode SDK

Models from all connected backends appear in a unified picker. The architecture is extensible — new backends implement the `AgentEngine` interface.

**Per-stage model selection** — Each pipeline stage can use a different model. Pick a fast model for brainstorming, a strong model for implementation, a cheap model for reviews. The stage model picker lets you assign models individually or set a default for the entire pipeline.

## Safety

> **Atelier auto-approves every agent action.** File writes, shell commands, git operations, tool calls — all run without confirmation prompts. This is by design: autonomous pipelines can't stop and wait for human approval at every step.

Agents execute with the same permissions as your user. There is no sandbox built in. You should:

- Run Atelier in a **container**, **VM**, or **disposable environment**
- Never run on machines with production credentials or sensitive data
- Review pipeline artifacts before merging to your main branch

See [`SECURITY.md`](SECURITY.md) for details.

## Platform Support

Atelier runs on **macOS**, **Linux**, and **Windows 10/11**. CI runs on Ubuntu and Windows.

## Quick Start

1. **Clone and install:**
   ```bash
   git clone https://github.com/mathieufro/atelier.git
   cd atelier
   ./install.sh
   ```

2. **Set up a backend** (at least one):

   **Claude Code:**
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
   Requires a [Max subscription](https://claude.ai/settings/billing).

   **OpenCode:**
   ```bash
   # Install OpenCode (see https://github.com/opencode-ai/opencode)
   opencode login
   ```

   Both backends can run simultaneously — models appear in a unified picker.

3. **Open Atelier:**
   Press `Cmd+Shift+A` (macOS) or `Ctrl+Shift+A` (Linux) in VS Code. Pick a skill, describe your task.

## Architecture

```
VS Code Extension (SolidJS webview)  ←→  Atelier Server (Bun + Hono)  ←→  Backends
         UI, message rendering              Orchestrator, proxy, SSE         Claude Code, OpenCode
```

- **Extension** (`extension/`) — VS Code extension host with a SolidJS + Tailwind webview. Handles message rendering, file links, tool cards, pipeline visualization.
- **Server** (`server/`) — Bun + Hono server: pipeline orchestrator, session proxy, event merger, backend registry.
- **Core** (`packages/core/`) — Shared types, message helpers, backend interfaces.
- **UI** (`packages/ui/`) — SolidJS components, stores, streaming markdown renderer.
- **Skills** (`skills/`) — 28 skill definitions (SKILL.md files), one per pipeline stage.

See [`docs/guide.md`](docs/guide.md) for the full user guide.

## Development

### Prerequisites

- [Bun](https://bun.sh) (runtime + package manager)
- [Strobe](https://github.com/mathieufro/strobe) (debugging infrastructure — installed by `install.sh`)

### Build

```bash
bun run build    # Full build: core → ui → css → extension → vsix → install
```

Individual targets:
- `bun run build:core` — types + backend interface
- `bun run build:ui` — SolidJS webview (Vite)
- `bun run build:css` — Tailwind CSS
- `bun run build:ext` — Extension host (Bun)

### Test

```bash
bun run test               # Unit + integration (vitest)
bun run test:integration   # Protocol-level integration tests
bun run test:visual        # Playwright visual regression
bun run test:e2e           # Real-agent E2E (requires API keys)
```

See [`tests/TESTING.md`](tests/TESTING.md) for the full testing guide.

### MCP Tools

Atelier uses two MCP tools during pipeline execution:

- **[Strobe](https://github.com/mathieufro/strobe)** — LLM-native debugging infrastructure. Launches programs, traces function calls, reads variables at runtime. Used by the implement stage for TDD.
- **Atelier Signal** — Orchestrator callback tool. Auto-deployed to both backends at runtime — no manual configuration needed.

See [`.mcp.json.example`](.mcp.json.example) for the MCP configuration template.

## License

[MIT](LICENSE) — Copyright (c) 2026 Mathieu Frohlich

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and guidelines.
