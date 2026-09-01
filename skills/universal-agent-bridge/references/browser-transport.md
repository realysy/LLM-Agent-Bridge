# Browser Transport

Universal AI Agent Reasoning Bridge uses a local WebSocket connection (`ws://127.0.0.1:8765`) paired with a lightweight browser extension or Tampermonkey userscript loaded in the user's regular browser (Edge, Chrome, Brave, Arc, etc.) on `https://chatgpt.com/`.

## Transport Preflight Status

- `NEEDS_BRIDGE_SERVER`: the local WebSocket bridge server (`scripts/ws-transport.mjs`) is not running.
- `NEEDS_BROWSER_CONNECTION`: bridge server is running, but no active `https://chatgpt.com/` browser tab is connected.
- `NEEDS_CHATGPT_LOGIN`: the connected ChatGPT page visibly shows a logged-out state.
- `NEEDS_MODEL_SELECTION`: the requested model is not selected or available on the page.
- `READY`: WebSocket transport, authentication, and requested model are visibly active.

## Workflow

1. Agent checks `doctor.mjs` / `ws-transport.mjs --status`.
2. If `NEEDS_BROWSER_CONNECTION`, Agent prompts user to open `https://chatgpt.com/` in their browser with the userscript/extension enabled.
3. Once connected, Agent sends sanitized `Context Packet` via `ws-transport.mjs send <packet_path> <result_path>`.
4. The browser script injects the prompt, waits for generation completion, extracts the clean Markdown response, and delivers it back via WebSocket.
5. Agent proceeds to the mandatory Local Adoption Gate.
