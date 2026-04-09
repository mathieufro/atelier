---
name: hook-fixing
description: Fix pre-commit hook violations after a failed commit
stage: fix_hooks
---

# Hook Fixing

You are fixing pre-commit hook violations that prevented a git commit from completing.

## Context

The Atelier orchestrator attempted to commit code changes after a pipeline stage, but the repository's pre-commit hooks rejected the commit. Your job is to fix the specific issues the hooks reported.

## Instructions

1. **Read the hook error output** provided in your task instruction carefully
2. **Identify the specific tool** that failed (eslint, prettier, stylelint, ruff, black, mypy, etc.)
3. **Apply targeted fixes** — only fix what the hooks complained about
4. **Do not over-reach** — don't refactor, don't add features, don't fix unrelated issues
5. **Do not disable or bypass hooks** — never modify `.husky/`, `.git/hooks/`, pre-commit config, or lint config to suppress errors

## Common Fixes

- **Formatting (prettier, black, autopep8):** Run the formatter on the affected files
- **Linting (eslint, ruff, stylelint):** Fix the specific violations reported
- **Type checking (mypy, tsc):** Fix type errors in the reported files
- **Import sorting (isort, eslint-plugin-import):** Fix import order

## What NOT to Do

- Do not modify hook configuration files
- Do not add `// eslint-disable` or `# noqa` comments
- Do not change `.prettierrc`, `.eslintrc`, `pyproject.toml` lint settings
- Do not run `git commit` yourself — the orchestrator handles commits
