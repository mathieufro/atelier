# Atelier

VS Code extension providing a 15-stage autonomous pipeline for software development.

## Commands

- `bun run build` — full build (typecheck, core, ui, css, extension, vsix, install)
- `bun run test` — unit/integration tests (Vitest)
- `bun run test:e2e` — E2E pipeline tests
- `bun run test:visual` — Playwright visual regression
- `bun run dev` — watch mode build
- `bun run typecheck` — TypeScript type checking across all packages

## Coding Conventions

### Project Structure

```
packages/core/       — shared types, logger, settings, event system (no DOM, no Node-only by default)
packages/ui/         — SolidJS webview app (components, stores, markdown, integration)
server/              — Bun + Hono HTTP server (engine, orchestration, infra layers)
extension/           — VS Code extension host (activation, webview bridge, server management)
skills/              — one SKILL.md per pipeline stage (28 skills)
tests/               — cross-package tests (e2e, integration, visual, shared utilities)
tools/               — development tools (atelier_signal)
docs/                — public documentation (user guide)
```

Packages are Bun workspaces (`"workspaces": ["packages/*", "extension", "server"]`). Each has its own `package.json` and `tsconfig.json` extending `tsconfig.base.json`.

### Naming

- **Files/directories**: `kebab-case` — `pipeline-state.ts`, `backend-registry.ts`, `message-store.ts`
- **SolidJS components**: `PascalCase` — `OnboardingCard.tsx`, `AssistantMessage.tsx`, `InputBar.tsx`
- **Functions/variables**: `camelCase` — `createApp`, `sessionStore`, `visibleParts`
- **Types/interfaces**: `PascalCase` — `PipelineStage`, `ModelRef`, `BackendProxy`
- **Constants**: `UPPER_SNAKE_CASE` — `VALID_MODES`, `DEFAULT_PORT`
- **Test files**: `<name>.test.ts` co-located with source or in parallel `tests/` directory
- **Skill directories**: `kebab-case` with single `SKILL.md` inside — `writing-plans/SKILL.md`

### Imports & Modules

- **ESM only** — `"type": "module"` in all packages. No CommonJS.
- **Path aliases** for cross-package imports: `@atelier/core`, `@atelier/ui`, `@atelier/server` (configured in `tsconfig.base.json`)
- **`.js` extensions** on relative imports: `import { createApp } from "./app.js"` (required by Bun's ESM resolution)
- **Node built-ins** with `node:` prefix: `import * as fs from "node:fs"`, `import * as path from "node:path"`
- **Type-only imports** marked explicitly: `import type { BackendProxy } from "./backend-proxy.js"`
- **Barrel files** (`index.ts`) for package public APIs. Exclude Node-only or environment-specific exports — use separate entry points: `@atelier/core/state-dir`, `@atelier/core/agent-engine`
- **No deep imports** into other packages. Import from barrel or named entry points only.

### Error Handling

- **Exceptions for unexpected failures** — throw `Error` or custom subclass (`ValidationError`). No Result/Either types.
- **Silent catch for best-effort cleanup** — `try { cleanup() } catch {}` when failure is acceptable (process kill, file unlink)
- **Null coalescing for safe defaults** — `context?.source ?? bindings.source ?? ""` over explicit null checks
- **Timeout errors** — use `setTimeout` + `Promise` rejection for operations with deadlines
- **Log at boundaries** — server routes and extension host message handlers log errors. Internal functions propagate via throw.

### Types

- **Inline with implementation** — define types in the same file they're used. No separate `types/` directories.
- **Core shared types** live in `packages/core/src/types.ts` — `PipelineStage`, `ModelRef`, `Mode`, `Message`
- **Type-only imports** always use `import type { ... }` syntax
- **Union types for finite state** — `type PipelineStage = "brainstorm" | "write_plan" | "implement" | ...`
- **Strict mode enforced** — `strict: true`, `noUncheckedIndexedAccess: true`, `noFallthroughCasesInSwitch: true`
- **Always narrow indexed access** — `record[key]` returns `T | undefined`; check before use

### Testing

- **Runner**: Vitest (not Jest). Use `describe`/`it`/`expect` from `vitest`.
- **File naming**: `<name>.test.ts` (never `.spec.ts`)
- **Location**: co-located in `src/` for UI components (`App.test.tsx`), parallel `tests/` directory for server/core/extension
- **UI testing**: `@solidjs/testing-library` — `render`, `screen`, `fireEvent`
- **Visual regression**: Playwright with golden files in `tests/visual/__goldens__/`
- **Mocking**: `vi.fn()` for stubs, `vi.mock()` for module replacement. Prefer `vi.spyOn()` over full mocks.
- **Test environments**: jsdom for UI tests, node for server/integration/e2e (configured via `environmentMatchGlobs` in vitest config)
- **Helpers inline** — define test utilities in the test file. No shared test utility library unless used by 3+ test files.
- **Temporary directories** for integration tests — create in `beforeEach`, clean up in `afterEach`
- **Always use Strobe `debug_test`** for test execution — see Running Tests section below.

### SolidJS Patterns

- **Functional components only** — no class components. Export named functions: `export function OnboardingCard(props: Props) { ... }`
- **`createSignal`** for primitive/scalar state. **`createStore`** for nested objects needing granular reactivity.
- **`createMemo`** for derived values that should be cached: `const visibleSkills = createMemo(() => filterSkills(allSkills(), query()))`
- **`createEffect`** for side effects reacting to signal changes
- **Control flow components**: `<Show>`, `<For>`, `<Switch>`/`<Match>` — not ternaries or `.map()` in JSX
- **Props are getters** — access as `props.value`, never destructure at the component boundary (breaks reactivity)
- **`splitProps`** to separate local props from pass-through: `const [local, rest] = splitProps(props, ['label'])`
- **`produce`** from `solid-js/store` for immutable store updates

### Server Patterns (Hono)

- **Route handlers** in `server/src/app.ts` — Hono app with typed routes
- **Three-layer architecture**: `engine/` (backend proxies, session management), `orchestration/` (pipeline, skills, stages), `infra/` (logger, process management, tooling)
- **Validation** via custom `ValidationError` thrown in route handlers — caught by Hono error middleware

### Extension Patterns

- **Activation**: `extension.ts` exports `activate(context)` — push all disposables to `context.subscriptions`
- **Webview communication**: `postMessage` protocol with typed `{ type: string, ...payload }` messages in both directions
- **Panel state** via `panel.iconPath` — dynamically set based on pipeline state messages from webview
- **Extension-to-server**: `atelier-client.ts` manages HTTP connection to the Hono server

### Formatting & Linting

- **TypeScript strict mode** is the primary quality gate — `tsc --noEmit` runs before every build
- **No dedicated formatter/linter** (no Biome, no ESLint, no Prettier) — consistency enforced by TypeScript compiler strictness and code review
- **Tailwind CSS v4** — CSS-based config (`@import "tailwindcss"`), no JS config file. Use `@tailwindcss/cli` for builds.

### Running Tests

**Always use Strobe `debug_test`** for test execution. Strobe provides live progress, structured results, and stuck detection.

| Suite | Strobe Command |
|-------|---------------|
| All tests | `debug_test({ projectRoot: "/path/to/atelier", framework: "vitest" })` |
| Single test file | `debug_test({ projectRoot: "/path/to/atelier", framework: "vitest", test: "app.test" })` |
| Single test name | `debug_test({ projectRoot: "/path/to/atelier", framework: "vitest", test: "POST /skill" })` |
| Visual regression | `debug_test({ projectRoot: "/path/to/atelier", framework: "playwright" })` |
| E2E pipeline | `debug_test({ projectRoot: "/path/to/atelier", framework: "vitest", test: "e2e" })` |

Poll with `debug_test({ action: "status", testRunId: "..." })` for live per-test progress.

Results: `/tmp/strobe/tests/<id>.json` — `{ summary: { passed, failed, durationMs }, failures: [...], tests: [{ name, status, durationMs }] }`.

Never run `bun run test` directly — always go through Strobe.

### Debugging with Strobe

When static analysis doesn't find the bug, use Strobe's dynamic instrumentation:

1. `debug_test` or `debug_launch` — run the code, check stdout/stderr first.
2. `debug_trace` — hook specific functions to observe calls, args, return values at runtime. No recompilation.
3. `debug_query` — inspect what was captured.
4. `debug_memory` — read runtime state of variables and objects.

Never re-run a test without first adding a new trace or making a code change. Same test + no new instrumentation = same result.

### Idioms

1. **Early returns and guard clauses** — check preconditions at the top, return early. Avoid deep nesting.
2. **Null coalescing chain** — `value ?? fallback1 ?? fallback2` over nested `if (value !== undefined)` blocks
3. **`async`/`await` everywhere** — no raw `.then()` chains. Bun handles async natively.
4. **Flat package structure** — prefer files at package root `src/` over deep directory nesting. Group by layer (engine, orchestration, infra), not by feature.
5. **Skill-driven behavior** — pipeline behavior is defined in `SKILL.md` files (YAML frontmatter + markdown instructions), not hardcoded in TypeScript. Adding a new pipeline stage means adding a new skill directory.
