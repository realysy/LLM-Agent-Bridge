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

## Streaming Report

当服务端以 `stream: true` 发起请求时，userscript 在网页生成过程中每 500ms 采集一次当前 Markdown 并 POST 到 `/stream`，实现实时流式。

### 采集逻辑

每次采样调用 `getLatestAssistantText({ isFinal: false })`：

1. 定位平台的 `markdownRoot`（如 `.qwen-markdown`、`.ds-assistant-message-main-content`）
2. 按顺序遍历它的**顶层子元素**（跳过 spacer 和 UI 元素）
3. 对每个块：先调用 `blockToMd` 转换成 Markdown，再用**转换结果**的哈希做稳定性判定

### 块级稳定判定

每个块的推送需满足：**转换后的内容指纹连续 700ms 不变**。

- 平台差异（代码块增量渲染、表格逐行 append）由 `blockToMd` 输出反映；内容变了 hash 立即变，稳定计时归零
- 遇到第一个未稳定的块就停止——保证每次推送内容是前一次的前缀，server 端前缀检测不会拒绝
- 最终帧（`isFinal: true`）跳过所有判定，输出完整内容

阈值 `BLOCK_STABLE_MS = 700` 是"一个采样周期 + 200ms 余量"。过低会导致 React 双缓冲的瞬时抖动被推送；过高会造成各块延迟串行累加。

### 平台特化

| 平台 | markdownRoot | 代码块完成判据 |
|---|---|---|
| DeepSeek | `.ds-assistant-message-main-content` | `.md-code-block` 里 `<pre>` 的 `<span>` 子节点 |
| Qwen | `.qwen-markdown` | `.qwen-markdown-code-editor-viewport` 的显式 `height` 不为 0 |

### 思考模式过滤

Reasoning 模式（DeepSeek 的 `已思考`、Qwen 的 `正在思考…跳过`）在正式回答之外渲染。过滤方式：

- `shouldSkipElement` 跳过 `.ds-think-content` 和任何 `qwen-chat-thinking-*` class
- `markdownRoot` 精确定位到**正式回答**容器，而非整个 assistant 节点
- `domToMarkdown` 在找不到 `markdownRoot` 时返回空字符串（**不回退**到 assistant 根节点），避免把思考内容误当回答

---

## 3. `skills/universal-agent-bridge/SKILL.md`

**改动点**：在 "Overview" 之后加一节简短的流式说明。

**在 `## Overview` 之后插入**：

```md
## Streaming

桥接层支持真正的流式响应。客户端以 `stream: true` 调用 `/v1/chat/completions` 时，浏览器端每 500ms 通过内部 `/stream` 端点上报当前累积的 Markdown，server 实时切出 delta 转发，避免长回答下的首字节延迟。

流式粒度是**块级**（block-level）：每个 `<h2>` / `<p>` / `<pre>` / 表格渲染完成且稳定 700ms 后才推送，保证客户端渲染格式正确。详细协议见 [references/openai-api.md](references/openai-api.md#post-stream) 和 [references/browser-transport.md](references/browser-transport.md#streaming-report)。