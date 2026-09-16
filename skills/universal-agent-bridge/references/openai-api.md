# OpenAI-Compatible API Server

## Overview

The Universal Agent Bridge now provides an **OpenAI-compatible API endpoint** that allows any OpenAI-compatible client to route requests through browser-based AI platforms (ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, GLM).

## Architecture

```
┌─────────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│  Any OpenAI Client  │────▶│  Local Node.js Server    │────▶│  Browser Userscript │
│  (curl, SDK, etc.)  │     │  (openai-api.mjs)        │     │  (Tampermonkey)     │
│                     │     │  Port: 8765              │     │                     │
└─────────────────────┘     └──────────────────────────┘     └─────────────────────┘
                                   │                                  │
                                   │                                  ▼
                                   │                          ┌─────────────────────┐
                                   │                          │   Web AI Platform   │
                                   │                          │   (Claude/DeepSeek/ │
                                   │                          │    ChatGPT/etc.)    │
                                   │                          └─────────────────────┘
                                   │
                            Legacy Endpoints
                            (/handoff, /poll, etc.)
```

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
