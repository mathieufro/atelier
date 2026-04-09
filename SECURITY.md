# Security

## Important Disclaimer

**Atelier runs autonomous LLM agents with full system-level permissions** — including file writes, shell commands, and git operations. Agents execute with the same permissions as the user running the VS Code extension.

It is the user's responsibility to run Atelier in a safe environment. Consider:

- Running inside a **sandbox** or **container** to limit blast radius
- Reviewing pipeline artifacts before merging to your main branch
- Not running Atelier on machines with sensitive credentials or production access
