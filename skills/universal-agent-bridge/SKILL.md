---
name: universal-agent-bridge
description: Universal reasoning handoff bridge connecting any AI Agent (DeepSeek Harness, Claude Code, Cursor, OpenCode) with top Web AI models (ChatGPT, Claude, DeepSeek, Gemini, Grok, Qwen, Doubao, GLM, Kimi) while keeping execution, edits, and tests strictly local.
---

# Universal Agent Bridge (`universal-agent-bridge`)

## Overview

Keep repository authority and execution strictly local: The local AI Agent gathers evidence and executes; Web AI models propose high-cost reasoning plans. Exchange bounded, sanitized contracts via local WebSocket / HTTP Long-Polling transport.

## User First-Time Setup & Installation Guide

1. **Clone this repository into your Agent's skills directory**:
   ```bash
   git clone https://github.com/EasongChung/Universal-Agent-Bridge.git universal-agent-bridge
   ```
2. **Install the Browser Userscript (or Extension)**:
   - 👉 **[Universal-Agent-Bridge on GreasyFork](https://greasyfork.org/zh-CN/scripts/593912-universal-agent-bridge-multi-model-coding-matrix)**
   - *Alternative (Browser Extension)*: Load unpacked folder `browser/extension/` in Edge/Chrome.
3. **Log in to platforms in your default browser**:
   - ChatGPT (`chatgpt.com`), Claude (`claude.ai`), DeepSeek (`chat.deepseek.com`), Gemini (`gemini.google.com`), Grok (`grok.com`), Qwen (`tongyi.aliyun.com` / `chat.qwen.ai`), Doubao (`doubao.com`), GLM (`chatglm.cn`), Kimi (`kimi.com`).

---

## Agent Invocation & Reasoning Execution Protocol

When invoking this skill for complex reasoning:

1. **Start Bridge Service & Check Connection**:
   - Ensure local Bridge service is active:
     ```bash
     node skills/universal-agent-bridge/scripts/ws-transport.mjs status
     ```
2. **Prompt / Confirm Target Platform with User**:
   - Ask or determine the desired platform: `deepseek` | `claude` | `chatgpt` | `gemini` | `grok` | `qwen` | `auto`.
3. **Auto-Launch Default Browser & Establish Handshake**:
   - If not connected, the transport will automatically launch your default browser to open the target platform URL;
   - Wait for the browser badge to show **🟢 `[Platform] Bridge: Ready`**.
4. **Collect Sanitized Evidence & Construct Packet**:
   - Read [references/context-packet.md](references/context-packet.md). Build a 1–3K token packet (auto-scrub secrets).
   - Validate offline:
     ```bash
     node skills/universal-agent-bridge/scripts/validate-handoff.mjs packet /path/to/packet.md
     ```
5. **Dispatch Reasoning Request**:
     ```bash
     node skills/universal-agent-bridge/scripts/ws-transport.mjs send /path/to/packet.md /path/to/result.md --platform <target_platform>
     ```
6. **Local Verification & Local Execution**:
   - Validate structure and pair integrity:
     ```bash
     node skills/universal-agent-bridge/scripts/validate-handoff.mjs result /path/to/result.md
     node skills/universal-agent-bridge/scripts/validate-handoff.mjs pair /path/to/packet.md /path/to/result.md
     ```
   - Apply edits, run tests, and generate verifiable cryptographic receipt.
