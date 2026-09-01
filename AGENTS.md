# AGENTS.md

## Purpose

This repository contains `agent-bridge-chatgpt`: a universal reasoning handoff bridge enabling any AI Agent (DeepSeek Harness, Claude Code, Cursor, OpenCode, CLI Agents, etc.) to delegate high-cost reasoning tasks to ChatGPT Web via local WebSocket / Browser transport while keeping repository authority, file edits, and testing strictly local.

## Boundaries

- Treat local repository contents as private by default. Send only the minimum sanitized packet required for the task.
- Never include credentials, tokens, private keys, personal data, raw environment files, or unrelated source code in a prompt.
- ChatGPT proposes; the local Agent verifies against the live repository, edits, and tests.
- Do not claim a ChatGPT account tier or model unless the visible page proves it for the current run.
- Zero mandatory external runtime dependencies for core validators.

## Structure

- `.codex-plugin/plugin.json`: Plugin distribution metadata.
- `skills/agent-bridge-chatgpt/SKILL.md`: concise routing and universal workflow.
- `skills/agent-bridge-chatgpt/references/`: Doctor, browser, packet, result, and receipt contracts.
- `skills/agent-bridge-chatgpt/scripts/`:
  - `doctor.mjs`: environment and bridge health check.
  - `ws-transport.mjs`: local WebSocket bridge transport and CLI.
  - `validate-handoff.mjs`: offline deterministic validator.
- `browser/`:
  - `userscript/chatgpt-bridge.user.js`: Tampermonkey / Violentmonkey userscript for ChatGPT Web.
  - `extension/`: Manifest V3 browser extension for Edge and Chrome.
- `tests/`: Node built-in tests and sanitized fixtures.
- `assets/`: presentation assets.
- `docs/`: architecture, design, and memory records.

## Verification

Run:

```bash
npm run doctor
npm run test
```

Before any commit, scan the diff for secrets. Never push or publish without explicit user approval.
