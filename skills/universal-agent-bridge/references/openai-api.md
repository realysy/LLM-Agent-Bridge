# OpenAI-Compatible API Server

## Overview

The Universal Agent Bridge now provides an **OpenAI-compatible API endpoint** that allows any OpenAI-compatible client to route requests through browser-based AI platforms (ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, GLM).

## Platform Support Status

> **TL;DR** — 目前完成了 **DeepSeek** 和 **Qwen** 的主动适配与端到端测试。其它平台（ChatGPT / Claude / Gemini / Kimi / Grok / Doubao / GLM）的适配器与协议转换代码存在且逻辑上应当可用，但**未经测试**，不保证功能完整。

### Support Matrix

| Platform | Plain Chat | Thinking Mode | Streaming | Tool Use | Multi-turn Tools | Tested |
|----------|-----------|---------------|-----------|----------|------------------|--------|
| **DeepSeek** (`deepseek-web`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 主动适配 + 测试 |
| **Qwen** (`qwen-web`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 主动适配 + 测试 |
| ChatGPT (`chatgpt-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| Claude (`claude-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| Gemini (`gemini-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| Kimi (`kimi-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| Grok (`grok-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| Doubao (`doubao-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |
| GLM (`glm-web`) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ 未测试 |

**图例**：
- ✅ — 已主动适配并通过端到端测试
- ⚠️ — 代码路径存在，但**未经测试**, 可能存在解析错误/功能缺失等问题
- ❌ — 未验证

### What "Tested" Means

「已测试」指以下场景均已通过端到端验证（见 [Tool Use (Function Calling)](#tool-use-function-calling) 与 [Debug Logging](#debug-logging)）：

1. **普通问答** — 单轮对话、多轮对话（历史由网页对话自身维护）
2. **思考模式** — DeepSeek 的 `已思考（用时 X 秒）` 与 Qwen 的 thinking 卡片均被正确剥离，不污染正式回答
3. **流式输出** — 网页 500ms 采样累积文本，SSE 端 delta 实时推给客户端
4. **工具调用** — 通过 VSCode Copilot（`deepseek-web` / `qwen-web`）验证：

   测试步骤：[./agent-test-procedure.md](./agent-test-procedure.md)，观察：

   - 单轮 tool_calls 解析与执行
   - 多轮工具循环（create_file → read_file → run_in_terminal → …）
   - 嵌套 / 缺少闭标签 / DeepSeek DSML 控制 token 等畸形容错
5. **工具调用模式下的流式禁用** — 请求体含 `tools` 时 userscript 主动关闭 `/stream` 上报，等最终 DOM 一次性解析（避免中间态被 markdown / KaTeX 渲染器损坏）

### Known Limitations

- **未测试平台**：适配器使用平台通用的 DOM 选择器（如 `.markdown`、`[data-message-author-role]`），但各平台 UI 差异较大，不保证命中。欢迎 PR。
- **工具调用与流式互斥**：启用 `tools` 时**不支持** SSE 增量推送。这是有意的设计取舍 —— 网页 UI 的实时渲染（KaTeX 吃 `$`、Markdown 解析器吞 `<`）会损坏工具调用 JSON，必须等最终 DOM 稳定后再提取。
- **思考模式仅部分剥离**：DeepSeek 与 Qwen 的思考容器已识别并跳过。其它平台的思考/推理显示区（如 Claude 的 `thinking`、ChatGPT 的 o1 系列推理）**未做专门处理**，其内容可能会混入 `content`。

## Architecture

```
┌─────────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│  Any OpenAI Client  │────▶│  Local Node.js Server    │────▶│  Browser Userscript │
│  (curl, SDK, etc.)  │     │  (openai-api.mjs)        │     │  (Tampermonkey)     │
│                     │◀────│  Port: 8765              │◀────│                     │
└─────────────────────┘ SSE └──────────────────────────┘ POST└─────────────────────┘
       │                            │         ▲                  │
       │                            │         │ /stream (实时上报)│
       │                            │         └──────────────────┘
       │                            │                            ▼
       │                     Legacy Endpoints             ┌─────────────────────┐
       │                     (/handoff, /poll, etc.)      │   Web AI Platform   │
       │                                                  │   (ChatGPT/DeepSeek/│
       └──────────────────────────────────────────────────│    Claude/Qwen/…)   │
                                                          └─────────────────────┘
```

浏览器每 500ms 通过 `POST /stream` 推送当前累积的 Markdown 文本；
服务端切出新增部分（delta）实时转发给 SSE 客户端，实现真正的流式响应。


## Quick Start

### 1. Start the OpenAI-Compatible API Server

```bash
# Using npm script
npm run api

# Or directly
node skills/universal-agent-bridge/scripts/openai-api.mjs serve

# With custom host, port and API key
node skills/universal-agent-bridge/scripts/openai-api.mjs serve --host 127.0.0.1 --port 8765 --api-key my-secret-key
```

### 2. Install Browser Userscript

Make sure the Tampermonkey userscript is installed in your browser:
- [GreasyFork Userscript](https://raw.githubusercontent.com/realysy/LLM-Agent-Bridge/main/browser/userscript/chatgpt-bridge.user.js)

Remember to reload (Ctrl+F5) your LLM provider page after installation.

### 3. Open Your Preferred AI Platform

Open and log in to any supported platform in your browser:
- https://chat.deepseek.com
- https://chat.qwen.ai
- https://chatgpt.com
- https://claude.ai
- https://gemini.google.com
- https://www.kimi.com
- https://grok.com
- https://tongyi.aliyun.com
- https://www.doubao.com
- https://chatglm.cn

Keep page open and stay logged in.

## API Endpoints

### GET `/v1/models`

List available browser-connected models.

**Request:**
```bash
curl http://localhost:8765/v1/models \
  -H "Authorization: Bearer sk-bridge-local-key"
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "chatgpt-web",
      "object": "model",
      "created": 1234567890,
      "owned_by": "universal-agent-bridge"
    },
    {
      "id": "claude-web",
      "object": "model",
      "created": 1234567891,
      "owned_by": "universal-agent-bridge"
    }
  ]
}
```

### POST `/v1/chat/completions`

OpenAI-compatible chat completions endpoint.

**Request:**
```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {"role": "user", "content": "Explain quantum computing in simple terms"}
    ],
    "temperature": 0.7,
    "max_tokens": 1000
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-1234567890-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "chatgpt-web",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Quantum computing is a type of computing that uses quantum mechanics..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 120,
    "total_tokens": 135
  },
  "system_fingerprint": "universal-agent-bridge"
}
```

### GET `/status`

Health check endpoint (no authentication required).

**Request:**
```bash
curl http://localhost:8765/status
```

**Response:**
```json
{
  "status": "READY",
  "connected_clients": 2,
  "platforms": [
    {
      "id": "chatgpt",
      "name": "ChatGPT Web",
      "model": "ChatGPT",
      "channel": "ws"
    },
    {
      "id": "claude",
      "name": "Claude Web",
      "model": "Claude 3.7 Sonnet",
      "channel": "http"
    }
  ]
}
```

### POST `/stream`

**内部端点**：浏览器 userscript 使用，无需 API Key 认证（以 `request_id` 作为隐式凭证）。

浏览器在网页流式生成过程中持续推送"当前的累积 Markdown 文本"；server 切出与已推内容的差值（delta）实时转发给 SSE 客户端。

**Request body:**
```json
{
  "request_id": "req_1789702897_abc123",
  "text": "## 标题\n\n已生成的部分内容…",
  "done": false
}

**字段说明**：
- `request_id` — 对应 `/v1/chat/completions` 发起 handoff 时生成的 `req_*` ID
- `text` — **累积文本**，不是增量。server 端只推 `text.slice(pushedLength)`
- `done` — `true` 时表示最终帧，server 会补齐剩余内容并结束 SSE

**Response:**
```json
{ "ok": true, "accepted": true }
```

**回退避免策略**：server 只在满足以下条件之一时接受本次上报：
- `text` 以 `lastReportedText` 为前缀（正常追加）
- `done === true`（最终帧强制接受，保证结果完整）

否则本次上报被静默忽略，`accepted: false`，等下一次采样对齐。这是为了容忍浏览器 DOM 的瞬时抖动（React 双缓冲、Monaco 中间态等）。

## Authentication

The default API key is `sk-bridge-local-key`. For production use, change it:

```bash
node skills/universal-agent-bridge/scripts/openai-api.mjs serve --api-key your-secure-key
```

Then use the key in your requests:
```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Authorization: Bearer your-secure-key" \
  ...
```

## Tool Use (Function Calling)

The server bridges OpenAI-style `tools` / `tool_calls` to web models via a
plain-text protocol. Web models emit tool calls in a strict block format;
the server parses them back into standard OpenAI `tool_calls`.

### Request with tools

```bash
curl http://localhost:8765/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web",
    "messages": [
      {"role": "user", "content": "list files in current dir"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a bash command",
        "parameters": {
          "type": "object",
          "properties": {"command": {"type": "string"}},
          "required": ["command"]
        }
      }
    }]
  }'
```

### Response with tool_calls

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "deepseek-web",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "I'll list the files in the current directory.",
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {
          "name": "bash",
          "arguments": "{\"command\":\"ls -la\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

OpenAI convention: `finish_reason` is `"tool_calls"` whenever at least one tool
call is present; `content` is set to `null` if the model only emitted calls.

### Model output protocol

The server injects a `tool_protocol` block instructing the web model to emit
each call in this exact form:

```
<tool_call>
```json
{"name": "<tool_name>", "arguments": {<json_arguments>}}
```
</tool_call>
```

The JSON is **inside a fenced code block** so the platform's markdown / KaTeX
renderer doesn't corrupt `$…$`, `\"`, or `<…>` characters in arguments.

### Multi-turn tool loop

On each subsequent round, the agent client (Copilot, Claude Code, Cursor, etc.)
sends back:

- An `assistant` message carrying the previous `tool_calls` (ignored by the
  bridge — the web conversation already holds the model's own output).
- One or more `role: "tool"` messages with execution results. Each is mapped
  by `tool_call_id` to the tool name via the assistant message's `tool_calls`
  array and re-emitted as a `TOOL_RESULT (tool=<name>):` block.
- The original `<workspace_info>` context block. This is marked `alwaysSend`
  and re-injected every turn so the web model never loses the workspace path.

### Deduplication

The bridge dedupes unchanged blocks to save tokens:

| Block kind | First turn | Subsequent turns |
|------------|-----------|------------------|
| `system` | sent | skipped |
| `tools` (large JSON) | sent | skipped |
| `tool_protocol` | sent | skipped |
| `context` — historical user messages | sent | skipped |
| `context` — `<workspace_info>` etc. | sent | **sent every turn** |
| `tool_result` — historical | sent | skipped |
| `turn` — current user message | sent | sent |

When the user opens a new web chat (URL session token changes), the bridge
clears the dedup set and drops historical context, simulating a fresh session.
`alwaysSend` blocks (workspace info) are still re-injected — a fresh chat
needs them most.

### Parser tolerance

`parseToolCallsFromContent` extracts tool calls by scanning for any valid
`{"name": ..., "arguments": ...}` JSON object, **regardless of outer tag**.
This tolerates models that:

- Forget to close `</tool_call>`.
- Nest `<tool_call>` blocks instead of writing them sequentially.
- Emit `<｜｜DSML｜｜ calls>` or `<|tool_calls|>` control tokens.
- Skip the wrapper tags entirely and emit bare JSON.

`arguments` may be a JSON object or a JSON string; the server always returns
it as a string per the OpenAI spec.

### Streaming and tool calls

When a request includes `tools`, the userscript **does not stream**. Web UIs
frequently corrupt tool-call JSON mid-stream (KaTeX consuming `$`, markdown
renderers eating `<`). The bridge waits for the final DOM, extracts the full
markdown, and delivers the tool calls in one non-streamed round-trip.

---

## Debug Logging

Set `BRIDGE_DEBUG_LOG=1` to persist every incoming `/v1/chat/completions`
request body to `<repo-root>/logs/<timestamp>.json`. Off by default.

```bash
BRIDGE_DEBUG_LOG=1 npm run api
```

Filenames use the **local timezone** (millisecond precision), with `:`
and `.` replaced by `-` for Windows compatibility:

```
logs/2026-09-20T11-27-28-853.json
```

Use cases:

- Reproduce a client-side bug by replaying the exact request body.
- Inspect the precise `messages` / `tools` payload an agent client sends.
- Debug token blow-up from repeated context blocks.

> A full multi-turn agent session can emit several MB of logs. Clean the
> `logs/` directory periodically, and keep it in `.gitignore`.

## Using with OpenAI SDK

### Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8765/v1",
    api_key="sk-bridge-local-key"  # Required but not validated on remote server
)

response = client.chat.completions.create(
    model="claude-web",
    messages=[
        {"role": "user", "content": "Write a haiku about coding"}
    ]
)

print(response.choices[0].message.content)
```

### Node.js SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8765/v1',
  apiKey: 'sk-bridge-local-key',
});

const response = await client.chat.completions.create({
  model: 'deepseek-web',
  messages: [{ role: 'user', content: 'Explain recursion' }],
});

console.log(response.choices[0].message.content);
```

## Legacy Bridge Endpoints

The server also maintains backward compatibility with existing bridge endpoints:

- `POST /handoff` - Direct handoff execution
- `GET /poll` - HTTP long-polling for userscript
- `POST /heartbeat` - Client heartbeat
- `POST /result` - Result submission

These endpoints work exactly as in the original `ws-transport.mjs` server.

## Differences from ws-transport.mjs

| Feature | ws-transport.mjs | openai-api.mjs |
|---------|------------------|----------------|
| Primary Interface | CLI + WebSocket | OpenAI REST API |
| Authentication | None | Bearer token (optional) |
| Model Discovery | Manual | `/v1/models` endpoint |
| Response Format | Custom JSON | OpenAI standard |
| Streaming | No (single-shot) | Yes — SSE + /stream real-time delta |
| Use Case | Direct agent handoff | Universal LLM client integration |

## Troubleshooting

### "NEEDS_BROWSER_CONNECTION" Error

Ensure:
1. The Tampermonkey userscript is installed and active
2. You have opened a supported AI platform in your browser
3. The browser tab is not in background (some browsers throttle background tabs)

### API Key Rejected

- Default key: `sk-bridge-local-key`
- Check your Authorization header format: `Bearer sk-bridge-local-key`
- Or pass `?api_key=sk-bridge-local-key` as query parameter

### Timeout Errors

The default timeout is 180 seconds. For complex reasoning tasks, you may need to wait longer or simplify your prompt.

## Migration Guide

If you're currently using `ws-transport.mjs`:

1. **Keep using existing CLI commands** - `ws-transport.mjs` still works unchanged
2. **Add OpenAI API for new clients** - Start `openai-api.mjs` alongside for SDK integration
3. **Or replace entirely** - `openai-api.mjs` includes all legacy endpoints

Both servers can run simultaneously on different ports if needed:
```bash
node skills/universal-agent-bridge/scripts/ws-transport.mjs serve --port 8765
node skills/universal-agent-bridge/scripts/openai-api.mjs serve --port 8766
```
