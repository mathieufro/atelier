# Atelier User Guide

## What is Atelier?

Atelier is an autonomous coding pipeline for VS Code. You describe what you want to build, and Atelier takes it through brainstorming, planning, implementation, code review, simplification, and testing — with minimal intervention.

It's not a chatbot. It's a multi-stage pipeline where specialized agents collaborate, review each other's work, and fix issues before delivering results.

## Getting Started

### Installation

```bash
git clone https://github.com/mathieufro/atelier.git
cd atelier
./install.sh
```

This installs dependencies, builds all packages, and installs the VS Code extension.

Use `./install.sh --no-strobe` to skip optional Strobe installation (debugging infrastructure).

### Backend Setup

You need at least one LLM backend:

**Claude Code (recommended):**
```bash
npm install -g @anthropic-ai/claude-code
claude login
```
Requires a [Max subscription](https://claude.ai/settings/billing).

**OpenCode (OpenAI-compatible models):**
```bash
# See https://github.com/opencode-ai/opencode
opencode login
```

Both backends can run simultaneously — models appear in a unified picker.

### Opening Atelier

Press `Cmd+Shift+A` in VS Code. The Atelier panel opens with a skill picker and input bar.

## Using the Pipeline

### 1. Pick a Skill

The skill picker shows available pipeline stages. For a new feature, start with **brainstorming** — it's the entry point for the full pipeline.

### 2. Describe Your Task

Write a clear description of what you want. Be specific about requirements, constraints, and success criteria. The brainstorm stage is **interactive** — the agent will ask clarifying questions before proceeding.

### 3. Let It Run

After brainstorming, the pipeline runs autonomously:

| Stage | What Happens |
|-------|-------------|
| **Brainstorm** | Interactive — collaborates with you to refine requirements into a spec |
| **Spec Review** | Fresh-eyes agent reviews the spec for gaps and inconsistencies |
| **Conventions** | On greenfield projects, researches and codifies stack conventions |
| **Plan** | Creates a detailed implementation plan with TDD task breakdown |
| **Plan Review** | Fresh-eyes agent reviews the plan for feasibility and completeness |
| **Implement** | Builds the feature following the plan, running tests as it goes |
| **Code Review** | Fresh-eyes agent reviews the implementation for bugs and quality |
| **Simplify** | Removes unnecessary complexity and polishes the code |
| **Fix** | Addresses any issues found in review (up to 3 attempts) |
| **E2E Gate** | Evaluates whether the feature needs end-to-end tests |
| **E2E Tests** | If gated in, plans and runs E2E test coverage |

### 4. Review Results

Each stage produces artifacts in the `.atelier/pipelines/` directory. The pipeline creates git commits at stage transitions so you can review or roll back individual stages.

## Pipeline Modes

### Feature Pipeline
The full 15-stage pipeline for building new features. Start with the **brainstorming** skill.

### Task Pipeline
A shorter pipeline for smaller, well-defined tasks. Skips brainstorming and goes straight to planning and implementation.

### Standalone Sessions
Use any skill directly without running a full pipeline. Good for one-off code reviews, quick plans, or bugfixing.

## Skills

Skills are the building blocks of the pipeline. Each skill is a `SKILL.md` file that defines how an agent should behave at a particular stage. Atelier ships with 28 built-in skills covering the full development lifecycle.

### Custom Skills

You can add your own skills:

- **User skills:** `~/.config/atelier/skills/<name>/SKILL.md`
- **Compatible locations:** `~/.claude/skills/` and `.opencode/skills/` are also scanned

A skill is a directory containing a single `SKILL.md` file with YAML frontmatter (name, description, stage) and markdown instructions.

## Multi-Backend Architecture

Atelier supports multiple LLM backends simultaneously through a `BackendRegistry`:

- **Claude Code** — via the Anthropic Agent SDK. Native Claude models.
- **OpenCode** — via the OpenCode SDK. OpenAI, Google, and other providers.

Models from all connected backends appear in the model picker. You can switch models mid-session or use different models for different pipeline stages.

The architecture is extensible — new backends implement the `AgentEngine` interface.

## MCP Tools

Atelier uses two MCP (Model Context Protocol) tools during pipeline execution:

### Strobe
[Strobe](https://github.com/mathieufro/strobe) is an LLM-native debugging tool. It launches programs, traces function calls, and reads variables at runtime. The implementation stage uses Strobe for TDD — running tests and debugging failures.

Configure Strobe in `.mcp.json` (see `.mcp.json.example`).

### Atelier Signal
The orchestrator callback tool. Agents call `atelier_signal` to report stage completion back to the orchestrator. This is auto-deployed at runtime — no manual configuration needed.

## Fresh-Eyes Review

Atelier's key innovation is **fresh-eyes review**. Review agents run in clean sessions with zero context from the stage they're reviewing. This means:

- The reviewer has no confirmation bias from having written the code
- Issues that the author agent overlooked are caught
- Quality gating happens before delivery, not after

When a reviewer finds issues, a **fixer agent** addresses them in-loop (up to 3 automatic attempts). If issues persist after 3 attempts, the pipeline halts for human intervention.

## Configuration

### VS Code Settings

- **`atelier.serverPort`** — Fixed port for the server (default: automatic)
- **`atelier.gitIntegration`** — Enable automatic git branch creation and per-stage commits (default: off)

### MCP Configuration

Copy `.mcp.json.example` to `.mcp.json` and configure your MCP servers:

```json
{
  "mcpServers": {
    "strobe": {
      "command": "strobe",
      "args": ["mcp"]
    }
  }
}
```

## Project Structure

```
packages/core/       — shared types, logger, settings, event system
packages/ui/         — SolidJS webview (components, stores, markdown)
server/              — Bun + Hono HTTP server (orchestrator, engine, infra)
extension/           — VS Code extension host (activation, webview, bridge)
skills/              — 28 skill definitions (one SKILL.md per stage)
tests/               — cross-package tests (e2e, integration, visual)
tools/               — development tools (atelier_signal)
docs/                — documentation
```

## Troubleshooting

### Atelier panel doesn't open
- Ensure the extension is installed: `code --list-extensions | grep atelier`
- Try rebuilding: `bun run build`
- Check the Output panel (View → Output → Atelier) for errors

### Backend not connecting
- Verify the backend is installed and logged in (`claude --version` or `opencode --version`)
- Check the Atelier server logs in the Output panel
- Try reloading the VS Code window (`Cmd+Shift+P` → "Reload Window")

### Pipeline gets stuck
- Check the current stage in the Atelier panel
- You can intervene at any time by sending a message
- The orchestrator auto-detects stuck stages and offers recovery options

### Build errors
```bash
bun run typecheck    # Check for type errors
bun run test         # Run the test suite
```

See [`tests/TESTING.md`](../tests/TESTING.md) for the full testing guide.
