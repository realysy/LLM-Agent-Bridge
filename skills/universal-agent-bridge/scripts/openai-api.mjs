#!/usr/bin/env node

/**
 * Universal Agent Bridge - OpenAI Compatible API Server
 * 
 * Provides an OpenAI-compatible /v1/chat/completions endpoint that routes
 * requests through the browser-based AI platforms (ChatGPT, Claude, DeepSeek, etc.)
 * 
 * Usage:
 *   node openai-api.mjs serve [--port 8765] [--api-key your-key]
 * 
 * API Endpoints:
 *   POST /v1/chat/completions - OpenAI compatible chat completions
 *   GET  /v1/models          - List available models (browser platforms)
 *   GET  /status             - Health check
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 8765;
const DEFAULT_API_KEY = 'sk-bridge-local-key';

const PLATFORM_URLS = {
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  deepseek: 'https://chat.deepseek.com',
  gemini: 'https://gemini.google.com',
  kimi: 'https://www.kimi.com',
  grok: 'https://grok.com',
  qwen: 'https://tongyi.aliyun.com',
  doubao: 'https://www.doubao.com',
  glm: 'https://chatglm.cn',
};

// Map platform IDs to OpenAI-style model names
const PLATFORM_MODELS = {
  chatgpt: { id: 'chatgpt-web', name: 'ChatGPT Web' },
  claude: { id: 'claude-web', name: 'Claude Web' },
  deepseek: { id: 'deepseek-web', name: 'DeepSeek Web' },
  gemini: { id: 'gemini-web', name: 'Gemini Web' },
  kimi: { id: 'kimi-web', name: 'Kimi Web' },
  grok: { id: 'grok-web', name: 'Grok Web' },
  qwen: { id: 'qwen-web', name: 'Qwen Web' },
  doubao: { id: 'doubao-web', name: 'Doubao Web' },
  glm: { id: 'glm-web', name: 'GLM Web' },
};

export function openBrowser(platform = 'chatgpt') {
  const url = PLATFORM_URLS[platform] || PLATFORM_URLS.chatgpt;
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

export class OpenAIApiServer {
  constructor(port = DEFAULT_PORT, apiKey = DEFAULT_API_KEY) {
    this.port = port;
    this.apiKey = apiKey;
    this.clients = new Set();
    this.pendingRequests = new Map();
    this.server = null;
    this.latestClientStatus = null;

    // Platform registry
    this.activeProviders = new Map();
    this.httpPollWaiters = new Map();
    this.queuedTasks = [];
    
    // Request ID counter for OpenAI compatibility
    this.requestIdCounter = 0;
  }

  setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
  }

  validateApiKey(req) {
    const authHeader = req.headers.authorization || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/);
    if (bearerMatch) {
      return bearerMatch[1] === this.apiKey;
    }
    const keyParam = new URL(req.url, `http://127.0.0.1:${this.port}`).searchParams.get('api_key');
    if (keyParam) {
      return keyParam === this.apiKey;
    }
    // Allow empty key for local development
    return !authHeader || authHeader === 'Bearer ' || authHeader === 'Bearer sk-bridge-local-key';
  }

  isBrowserConnected(targetPlatform = null) {
    const now = Date.now();
    for (const [id, prov] of this.activeProviders.entries()) {
      if (now - prov.lastHeartbeat < 35000) {
        if (!targetPlatform || targetPlatform === 'auto' || id === targetPlatform) {
          return true;
        }
      }
    }
    return this.clients.size > 0;
  }

  getActivePlatformList() {
    const now = Date.now();
    const list = [];
    for (const [id, prov] of this.activeProviders.entries()) {
      if (now - prov.lastHeartbeat < 35000) {
        const modelInfo = PLATFORM_MODELS[id] || { id, name: id };
        list.push({
          id: modelInfo.id,
          object: 'model',
          created: Math.floor(prov.lastHeartbeat / 1000),
          owned_by: 'universal-agent-bridge',
          platform: id,
          name: modelInfo.name,
          model: prov.info?.model || 'Default',
          channel: prov.type,
        });
      }
    }
    return list;
  }

  start() {
    return new Promise((resolveStart, rejectStart) => {
      this.server = createServer(async (req, res) => {
        this.setCorsHeaders(res);

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const urlObj = new URL(req.url, `http://127.0.0.1:${this.port}`);
        const pathname = urlObj.pathname;

        // Skip API key validation for status endpoint
        if (pathname !== '/status' && !this.validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            }
          }));
          return;
        }

        // ==================== OpenAI Compatible Endpoints ====================

        // GET /v1/models - List available models
        if (pathname === '/v1/models' && req.method === 'GET') {
          const platforms = this.getActivePlatformList();
          const models = platforms.map(p => ({
            id: p.id,
            object: 'model',
            created: p.created,
            owned_by: p.owned_by,
          }));
          
          // Always include at least one default model entry
          if (models.length === 0) {
            models.push({
              id: 'chatgpt-web',
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'universal-agent-bridge',
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: models }));
          return;
        }

        // POST /v1/chat/completions - OpenAI compatible chat completions
        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const result = await this.handleChatCompletion(data);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: {
                  message: err.message || 'Internal server error',
                  type: 'server_error',
                  code: 'internal_error',
                }
              }));
            }
          });
          return;
        }

        // ==================== Legacy Bridge Endpoints ====================

        // Health & Status
        if (pathname === '/status') {
          const platforms = this.getActivePlatformList();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: platforms.length > 0 ? 'READY' : 'NEEDS_BROWSER_CONNECTION',
            connected_clients: platforms.length,
            platforms: platforms.map(p => ({
              id: p.platform,
              name: p.name,
              model: p.model,
              channel: p.channel,
            })),
            client_info: this.latestClientStatus,
          }));
          return;
        }

        // HTTP Long-Poll from Userscript
        if (pathname === '/poll') {
          const platform = urlObj.searchParams.get('platform') || 'chatgpt';
          const now = Date.now();

          const current = this.activeProviders.get(platform) || { info: {}, type: 'http' };
          current.lastHeartbeat = now;
          this.activeProviders.set(platform, current);

          const taskIdx = this.queuedTasks.findIndex(t => !t.targetPlatform || t.targetPlatform === 'auto' || t.targetPlatform === platform);
          if (taskIdx !== -1) {
            const task = this.queuedTasks.splice(taskIdx, 1)[0];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ task }));
            return;
          }

          if (!this.httpPollWaiters.has(platform)) {
            this.httpPollWaiters.set(platform, []);
          }
          const waiterList = this.httpPollWaiters.get(platform);
          const waiter = { res, timer: null };

          waiter.timer = setTimeout(() => {
            const idx = waiterList.indexOf(waiter);
            if (idx !== -1) waiterList.splice(idx, 1);
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ task: null }));
            } catch {}
          }, 25000);

          waiterList.push(waiter);
          return;
        }

        // HTTP Client Heartbeat
        if (pathname === '/heartbeat' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const platform = data.platform || 'chatgpt';
              this.activeProviders.set(platform, {
                info: data,
                lastHeartbeat: Date.now(),
                type: 'http',
              });
              this.latestClientStatus = data;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }

        // HTTP Result Submission
        if (pathname === '/result' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const { request_id, type, payload } = data;
              if (request_id && this.pendingRequests.has(request_id)) {
                const { resolve, reject } = this.pendingRequests.get(request_id);
                this.pendingRequests.delete(request_id);
                if (type === 'REASONING_RESULT') {
                  resolve(payload);
                } else {
                  reject(new Error(payload?.error || 'Reasoning failed in browser'));
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // External CLI / Agent Handoff execution
        if (pathname === '/handoff' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const result = await this.executeHandoff(data.packet, data.options || {});
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, result }));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      // WebSocket Upgrade Handler
      this.server.on('upgrade', (req, socket, head) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) {
          socket.destroy();
          return;
        }

        const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
        const headers = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n');

        socket.write(headers);

        const client = {
          socket,
          alive: true,
          platform: 'chatgpt',
          info: {},
        };

        this.clients.add(client);

        socket.on('data', (buffer) => {
          this.handleFrame(client, buffer);
        });

        socket.on('close', () => {
          this.clients.delete(client);
          this.activeProviders.delete(client.platform);
        });

        socket.on('error', () => {
          this.clients.delete(client);
          this.activeProviders.delete(client.platform);
        });
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolveStart(this);
      });

      this.server.on('error', (err) => {
        rejectStart(err);
      });
    });
  }

  stop() {
    return new Promise((res) => {
      for (const client of this.clients) {
        try { client.socket.destroy(); } catch {}
      }
      this.clients.clear();
      this.activeProviders.clear();

      for (const list of this.httpPollWaiters.values()) {
        for (const waiter of list) {
          try {
            clearTimeout(waiter.timer);
            waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
            waiter.res.end(JSON.stringify({ task: null }));
          } catch {}
        }
      }
      this.httpPollWaiters.clear();

      if (this.server) {
        this.server.close(res);
      } else {
        res();
      }
    });
  }

  /**
   * Handle OpenAI Chat Completions API
   * Converts OpenAI request format to bridge packet and routes to browser
   */
  async handleChatCompletion(openAiRequest) {
    const {
      model = 'chatgpt-web',
      messages = [],
      temperature,
      max_tokens,
      stream = false,
    } = openAiRequest;

    // Map OpenAI model name to platform ID
    const platformId = this.modelToPlatform(model);
    
    // Convert messages to a prompt string
    const prompt = this.messagesToPrompt(messages);

    // Create a context packet for the bridge
    const packet = {
      type: 'CONTEXT_PACKET',
      version: '1.0',
      timestamp: new Date().toISOString(),
      content: {
        instruction: prompt,
        evidence: [],
        constraints: {
          max_tokens: max_tokens || 4096,
          temperature: temperature || 0.7,
        },
      },
    };

    // Execute via bridge
    const result = await this.executeHandoff(packet, { 
      platform: platformId,
      timeout: 180,
    });

    // Generate OpenAI-compatible response
    const requestId = `chatcmpl-${Date.now()}-${++this.requestIdCounter}`;
    const timestamp = Math.floor(Date.now() / 1000);

    return {
      id: requestId,
      object: 'chat.completion',
      created: timestamp,
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content || '',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: this.estimateTokens(prompt),
        completion_tokens: this.estimateTokens(result.content || ''),
        total_tokens: this.estimateTokens(prompt) + this.estimateTokens(result.content || ''),
      },
      system_fingerprint: 'universal-agent-bridge',
    };
  }

  /**
   * Convert OpenAI model name to platform ID
   */
  modelToPlatform(modelName) {
    const lower = modelName.toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('deepseek')) return 'deepseek';
    if (lower.includes('gemini')) return 'gemini';
    if (lower.includes('kimi')) return 'kimi';
    if (lower.includes('grok')) return 'grok';
    if (lower.includes('qwen') || lower.includes('quwen')) return 'qwen';
    if (lower.includes('doubao')) return 'doubao';
    if (lower.includes('glm') || lower.includes('qingyan')) return 'glm';
    if (lower.includes('chatgpt') || lower.includes('gpt')) return 'chatgpt';
    return 'chatgpt'; // default
  }

  /**
   * Convert OpenAI messages array to prompt string
   */
  messagesToPrompt(messages) {
    return messages.map(msg => {
      const role = msg.role || 'user';
      const content = typeof msg.content === 'string' ? msg.content : 
                      Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : '';
      return `${role.toUpperCase()}: ${content}`;
    }).join('\n\n');
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  handleFrame(client, buffer) {
    if (buffer.length < 2) return;
    const firstByte = buffer[0];
    const opcode = firstByte & 0x0f;

    if (opcode === 0x08) {
      client.socket.destroy();
      this.clients.delete(client);
      return;
    }

    if (opcode === 0x09) {
      this.sendRaw(client.socket, 0x0a, Buffer.alloc(0));
      return;
    }

    if (opcode === 0x01) {
      const secondByte = buffer[1];
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        payloadLength = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let payload;
      if (isMasked) {
        const mask = buffer.slice(offset, offset + 4);
        offset += 4;
        const data = buffer.slice(offset, offset + payloadLength);
        payload = Buffer.alloc(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          payload[i] = data[i] ^ mask[i % 4];
        }
      } else {
        payload = buffer.slice(offset, offset + payloadLength);
      }

      try {
        const message = JSON.parse(payload.toString('utf8'));
        this.handleMessage(client, message);
      } catch (err) {
        console.error('[OpenAIApiServer] Invalid JSON message received:', err.message);
      }
    }
  }

  handleMessage(client, message) {
    const { type, payload, request_id } = message;

    if (type === 'CLIENT_STATUS') {
      client.info = payload;
      client.platform = payload.platform || 'chatgpt';
      this.latestClientStatus = payload;
      this.activeProviders.set(client.platform, {
        info: payload,
        lastHeartbeat: Date.now(),
        type: 'ws',
        client,
      });
      return;
    }

    if (type === 'REASONING_RESULT' || type === 'REASONING_ERROR') {
      if (request_id && this.pendingRequests.has(request_id)) {
        const { resolve, reject } = this.pendingRequests.get(request_id);
        this.pendingRequests.delete(request_id);
        if (type === 'REASONING_RESULT') {
          resolve(payload);
        } else {
          reject(new Error(payload?.error || 'Reasoning failed in browser'));
        }
      }
    }
  }

  send(client, messageObject) {
    const json = JSON.stringify(messageObject);
    const data = Buffer.from(json, 'utf8');
    this.sendRaw(client.socket, 0x01, data);
  }

  sendRaw(socket, opcode, data) {
    const length = data.length;
    let header;

    if (length <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      socket.write(Buffer.concat([header, data]));
    } catch (err) {
      console.error('[OpenAIApiServer] Socket write error:', err.message);
    }
  }

  async executeHandoff(packetContent, options = {}) {
    const timeoutMs = (options.timeout || 180) * 1000;
    const targetPlatform = options.platform || 'auto';

    if (!this.isBrowserConnected(targetPlatform)) {
      throw new Error(`NEEDS_BROWSER_CONNECTION: No active browser tab connected for platform [${targetPlatform}]. Please open the platform in your browser with the bridge userscript active.`);
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskPayload = {
      type: 'EXECUTE_REASONING',
      request_id: requestId,
      targetPlatform,
      payload: {
        packet: packetContent,
        model: options.model || null,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout: Reasoning did not complete within ${options.timeout || 180}s`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      // Priority 1: Check WebSocket clients
      for (const client of this.clients) {
        if (targetPlatform === 'auto' || client.platform === targetPlatform) {
          this.send(client, taskPayload);
          return;
        }
      }

      // Priority 2: Check HTTP Long-Poll waiters
      for (const [pId, list] of this.httpPollWaiters.entries()) {
        if ((targetPlatform === 'auto' || pId === targetPlatform) && list.length > 0) {
          const waiter = list.shift();
          clearTimeout(waiter.timer);
          waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
          waiter.res.end(JSON.stringify({ task: taskPayload }));
          return;
        }
      }

      // Priority 3: Enqueue for next incoming poll
      this.queuedTasks.push(taskPayload);
    });
  }
}

// CLI Command Parser
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Usage:
  node openai-api.mjs serve [--port 8765] [--api-key your-key]

Commands:
  serve   Start OpenAI-compatible API server

Options:
  --port       Port to listen on (default: 8765)
  --api-key    API key for authentication (default: sk-bridge-local-key)

API Endpoints:
  POST /v1/chat/completions  - OpenAI compatible chat completions
  GET  /v1/models            - List available browser-based models
  GET  /status               - Health check (no auth required)

Example:
  node openai-api.mjs serve --port 8765 --api-key my-secret-key

curl http://localhost:8765/v1/chat/completions \\
  -H "Authorization: Bearer my-secret-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "chatgpt-web",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
    `);
    return;
  }

  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : DEFAULT_PORT;

  const keyIndex = args.indexOf('--api-key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : DEFAULT_API_KEY;

  if (command === 'serve') {
    const server = new OpenAIApiServer(port, apiKey);
    await server.start();
    console.log(`[OpenAIApiServer] Listening on http://0.0.0.0:${port}`);
    console.log(`[OpenAIApiServer] OpenAI-compatible API ready at /v1/chat/completions`);
    console.log(`[OpenAIApiServer] API Key: ${apiKey}`);
    console.log(`[OpenAIApiServer] Ready for ChatGPT / Claude / DeepSeek / Gemini / Kimi / Grok / Qwen / Doubao / GLM connections.`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('openai-api.mjs')) {
  main();
}
