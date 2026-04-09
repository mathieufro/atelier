# Security

## Important Disclaimer

**Atelier auto-approves every agent action.** File writes, shell commands, git operations, tool calls — all execute without confirmation prompts. This is by design: autonomous pipelines cannot stop and wait for human approval at every step.

Agents run with the same permissions as the user running the VS Code extension. There is no built-in sandbox, permission boundary, or action filter.

## Recommendations

- Run Atelier inside a **container**, **VM**, or **disposable environment** to limit blast radius
- **Never** run on machines with production credentials, SSH keys to production servers, or sensitive data
- Review pipeline artifacts (code, tests, specs) before merging to your main branch
- Use a dedicated workspace directory — Atelier agents will create files, run shell commands, and make git commits

## Reporting Vulnerabilities

If you discover a security issue, please open a GitHub issue or email the maintainer directly.
