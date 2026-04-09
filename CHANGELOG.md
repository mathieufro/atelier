# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-28

Initial open-source release.

### Added

- 15-stage autonomous pipeline — brainstorm, spec, review, conventions, plan, review, implement, code review, simplify, fix, E2E gate, E2E tests, and more
- Fresh-eyes review stages — reviewers run in clean sessions with zero author context
- Review-fix cycles — up to 3 automatic fix attempts per review stage
- Multi-backend support — Claude Code (Anthropic Agent SDK) and OpenCode simultaneously
- SolidJS webview with streaming markdown, tool cards, file links, and pipeline visualization
- Bun + Hono HTTP server with SSE event streaming
- 28 skill definitions (SKILL.md) — one per pipeline stage
- Skill-driven orchestration — pipeline behavior defined in markdown, not hardcoded
- E2E gate — automatic evaluation of whether a feature warrants end-to-end testing
- Strobe MCP integration for runtime debugging during implementation
- Visual regression testing with Playwright
- 1,493 unit and integration tests across 119 test files
