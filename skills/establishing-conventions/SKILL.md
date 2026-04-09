---
name: establishing-conventions
description: Greenfield convention setup — research SOTA patterns for chosen stack, codify project conventions in CLAUDE.md before planning begins
stage: establish-conventions
---

# Establishing Conventions

You are setting up coding conventions for a greenfield project. The brainstorm spec has been finalized and reviewed — you know the stack, architecture, and scope. Your job is to research modern, idiomatic patterns for the chosen stack and codify them as project conventions that all downstream skills will follow.

## Before You Start

**First, check if this project already has conventions.** Explore the codebase for signs of established conventions: CLAUDE.md with a conventions section, consistent patterns across files, linting/formatting config, established directory structure. If the codebase already has established conventions, **call `atelier_signal` with `type: "stage_complete"` immediately** — do not write anything. This stage is only for greenfield projects that need conventions established from scratch.

**If the project is greenfield (no established conventions), read the spec thoroughly.** Extract:

- Language(s) and runtime (e.g. TypeScript + Bun, Rust, Python 3.12, Go)
- Frameworks (e.g. SolidJS, Hono, Axum, FastAPI)
- Test runner (e.g. Vitest, pytest, cargo test)
- Build tools and package manager
- Any architecture decisions that imply conventions (e.g. "monorepo" implies workspace conventions, "event-driven" implies event naming patterns)

## Research Phase

**Use web search extensively.** For each element of the stack, research:

1. **Project structure** — what does a well-organized project look like for this stack? Directory layout, module organization, entry points.
2. **Naming conventions** — files, directories, variables, functions, types, constants, test files. What's idiomatic for the language and framework?
3. **Import/module patterns** — barrel files vs direct imports, relative vs absolute paths, module boundaries. What does the ecosystem recommend?
4. **Error handling** — what's the idiomatic pattern? Result types, exceptions, error codes? How are errors propagated, logged, surfaced?
5. **Type patterns** — type-first vs inferred, interface vs type alias conventions, where types live.
6. **Test conventions** — file naming (`.test.ts` vs `_test.go` vs `test_*.py`), test structure (describe/it vs flat, arrange-act-assert), fixture patterns, mocking approach.
7. **Formatting and linting** — which tools are standard? What's the default config the community uses? (e.g. Biome for TS, rustfmt for Rust, Black for Python)
8. **Common idioms** — language-specific patterns that distinguish idiomatic code from "works but foreign" code. Early returns vs nested ifs, guard clauses, pattern matching usage, functional vs imperative style.
9. **Dependency management** — lock files, version pinning strategy, how to add/update deps.

**Prioritize ecosystem consensus over personal preference.** If the Go community uses flat packages and short names, prescribe that — even if you'd personally prefer deep nesting. The goal is code that any experienced developer in this stack would recognize as idiomatic.

**Verify recency.** Patterns evolve. Confirm that what you're recommending is current practice, not deprecated or legacy. Check official documentation, recent blog posts, and popular open-source projects in the same stack.

## Output

**Primary target: the project's `CLAUDE.md`.** Write (or create) the project's `CLAUDE.md` file at the workspace root (or `.claude/CLAUDE.md` if that directory already exists). Add a `## Coding Conventions` section with the researched patterns. This file is what downstream agents and developers actually read — it must exist when you're done.

**Pipeline artifact copy.** If the task instruction below gives you an artifact path (in `.atelier/pipelines/...`), also write the same conventions content to that path. This is a pipeline record — the primary copy in CLAUDE.md is what matters.

### Convention Format

Conventions must be **concrete and prescriptive** — not vague guidelines. Each convention should tell a developer exactly what to do, not what to think about.

Bad: "Use consistent naming"
Good: "Files: kebab-case (`user-service.ts`). Functions/variables: camelCase. Types/interfaces: PascalCase. Constants: UPPER_SNAKE_CASE. Test files: `<name>.test.ts` co-located with source."

Bad: "Handle errors appropriately"
Good: "Use Result types for operations that can fail. Never throw exceptions for expected failure cases. Throw only for programmer errors (invariant violations). Propagate errors with `?` operator. Log at the boundary, not at every level."

### Section Structure

```markdown
## Coding Conventions

### Project Structure
[Directory layout with brief rationale for each top-level directory]

### Naming
[File, directory, variable, function, type, constant naming rules]

### Imports & Modules
[Import style, module boundaries, re-export patterns]

### Error Handling
[Idiomatic error pattern for this stack, propagation rules]

### Types
[Type definition conventions, where types live, inference vs explicit]

### Testing
[File naming, structure, fixtures, mocking, what to test]

### Formatting & Linting
[Tool + config — e.g. "Biome with default config" or "rustfmt + clippy"]

### Idioms
[3-5 stack-specific patterns that define "idiomatic" for this project]
```

Not every section applies to every stack. Omit sections that don't add value (e.g. skip "Types" for a dynamically typed language with no type tooling). Add sections if the stack demands them (e.g. "Concurrency" for Go/Rust, "Component Patterns" for React/Solid).

### What NOT to Write

- **No code examples.** Keep it to rules and patterns. The writing-plans skill will produce concrete code.
- **No tool installation instructions.** That's scaffolding, not conventions.
- **No architecture decisions.** Those are in the spec. Don't repeat them.
- **No generic wisdom.** "Write clean code" and "follow SOLID principles" add nothing. Every convention should be stack-specific and actionable.

## After Writing

Read back the CLAUDE.md to verify the conventions section is well-formed and doesn't conflict with anything already in the file. The conventions should complement the existing project information, not duplicate or contradict it.

**Verify CLAUDE.md exists at the workspace root** (or `.claude/CLAUDE.md`). If you only wrote to the pipeline artifact path and forgot CLAUDE.md, go back and write it now — the artifact alone is not sufficient.

Call `atelier_signal` with `type: "stage_complete"` and `outputPath` set to the pipeline artifact path (if written).
