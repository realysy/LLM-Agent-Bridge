# OpenAI-Compatible API Server

## Overview

The Universal Agent Bridge now provides an **OpenAI-compatible API endpoint** that allows any OpenAI-compatible client to route requests through browser-based AI platforms (ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, GLM).

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

# With custom port and API key
node skills/universal-agent-bridge/scripts/openai-api.mjs serve --port 8765 --api-key my-secret-key
```

### 2. Install Browser Userscript

Make sure the Tampermonkey userscript is installed in your browser:
- [GreasyFork Userscript](https://greasyfork.org/zh-CN/scripts/593912-universal-agent-bridge-multi-model-coding-matrix)

### 3. Open Your Preferred AI Platform

Open and log in to any supported platform in your browser:
- https://chatgpt.com
- https://claude.ai
- https://chat.deepseek.com
- https://gemini.google.com
- https://www.kimi.com
- https://grok.com
- https://tongyi.aliyun.com
- https://www.doubao.com
- https://chatglm.cn

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

## Model Mapping

The server automatically maps OpenAI-style model names to browser platforms:

| Model Name Pattern | Platform |
|-------------------|----------|
| `chatgpt-web`, `gpt-*` | ChatGPT |
| `claude-web`, `claude-*` | Claude |
| `deepseek-web`, `deepseek-*` | DeepSeek |
| `gemini-web`, `gemini-*` | Gemini |
| `kimi-web`, `kimi-*` | Kimi |
| `grok-web`, `grok-*` | Grok |
| `qwen-web`, `qwen-*` | Qwen (通义千问) |
| `doubao-web`, `doubao-*` | Doubao (豆包) |
| `glm-web`, `glm-*` | GLM (智谱清言) |

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
