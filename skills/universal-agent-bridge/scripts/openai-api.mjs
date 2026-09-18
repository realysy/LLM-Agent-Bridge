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

    // 流式输出注册表：handoff request_id → 流式状态。
    // 当 /v1/chat/completions 使用 stream=true 时，会在这里注册一个 entry，
    // 浏览器通过 /stream 端点持续推送累积文本，server 从中切出 delta 推给客户端。
    this.streamingOutputs = new Map();

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

        // Skip API key validation for status and stream endpoints.
        // /stream 是浏览器脚本的内部通道：它不携带 API key，
        // 以知道 request_id 作为隐式凭证。
        if (pathname !== '/status' && pathname !== '/stream' && !this.validateApiKey(req)) {
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
            // 1. 解析请求体
            let data;
            try {
              data = JSON.parse(body);
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: {
                  message: 'Invalid JSON in request body',
                  type: 'invalid_request_error',
                  code: 'invalid_json',
                }
              }));
              return;
            }

            const wantsStream = data.stream === true;

            // ==================== 流式（SSE）分支 ====================
            // 真流式：浏览器在网页流式过程中通过 /stream 端点持续推送累积文本，
            // server 切出 delta 实时转发。若浏览器未推 /stream（旧版脚本），
            // 则在 /result 到达时一次性分片推送（兼容路径）。
            if (wantsStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Transfer-Encoding': 'chunked',
              });

              try { req.socket.setNoDelay(true); } catch {}
              try { req.socket.setKeepAlive(true); } catch {}

              const requestId = `chatcmpl-${Date.now()}-${++this.requestIdCounter}`;
              const created = Math.floor(Date.now() / 1000);
              const modelName = data.model || 'chatgpt-web';

              let aborted = false;
              const writeChunk = (delta, finishReason = null) => {
                if (aborted) return false;
                const chunk = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created,
                  model: modelName,
                  choices: [{ index: 0, delta, finish_reason: finishReason }],
                };
                try {
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  return true;
                } catch (e) {
                  console.error(`[SSE-WRITE] failed:`, e);
                  aborted = true;
                  return false;
                }
              };

              const writeDone = () => {
                if (res.writableEnded) return;
                try {
                  res.write('data: [DONE]\n\n');
                  res.end();
                } catch (e) {
                  console.error(`[SSE-DONE] failed:`, e);
                }
              };

              // 角色起始帧
              writeChunk({ role: 'assistant', content: '' });

              // 生成 handoff 请求 ID，并把流式状态注册进 streamingOutputs，
              // 这样浏览器发来的 /stream 帧就能找到对应的 SSE response。
              const handoffRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

              const streamState = {
                res,
                openaiRequestId: requestId,
                created,
                modelName,
                pushedLength: 0,
                lastReportedText: '',
                writeChunk,
                writeDone,
                aborted: () => aborted,
                finished: false,
                timer: null,
                data,   // 保留原始请求体，用于 usage 计算
              };
              this.streamingOutputs.set(handoffRequestId, streamState);

              res.on('close', () => {
                if (!res.writableEnded) {
                  aborted = true;
                  console.log(`[SSE-ABORT] client disconnected before response ended`);
                }
                if (!streamState.finished) {
                  streamState.finished = true;
                  if (streamState.timer) clearTimeout(streamState.timer);
                  this.streamingOutputs.delete(handoffRequestId);
                }
              });

              // 超时保护：5 分钟无 final 帧则强制结束，防止客户端永久挂起
              streamState.timer = setTimeout(() => {
                if (streamState.finished) return;
                streamState.finished = true;
                this.streamingOutputs.delete(handoffRequestId);
                console.error(`[SSE-TIMEOUT] requestId=${handoffRequestId}`);
                if (!aborted) {
                  writeChunk({ content: '\n[Error: Stream timed out]' }, null);
                  writeChunk({}, 'stop');
                }
                writeDone();
              }, 5 * 60 * 1000);

              // 发起 handoff（不 await；真正的推送逻辑由 /stream 驱动）
              this.handleChatCompletion(data, { requestId: handoffRequestId })
                .then((result) => {
                  if (streamState.finished) return;

                  // 浏览器已在推 /stream：不做兼容路径，等 done 帧处理。
                  // 只有当 pushedLength === 0（浏览器完全没推 /stream）时才走兼容路径。
                  if (streamState.pushedLength > 0) {
                    // 兜底：如果 10 秒内 done 帧仍未来到，用 result 强制收尾
                    setTimeout(() => {
                      if (streamState.finished) return;
                      const content = result.choices?.[0]?.message?.content || '';
                      const tail = content.slice(streamState.pushedLength);
                      if (!aborted && tail) writeChunk({ content: tail });
                      if (!aborted) writeChunk({}, 'stop');
                      streamState.finished = true;
                      if (streamState.timer) clearTimeout(streamState.timer);
                      this.streamingOutputs.delete(handoffRequestId);
                      writeDone();
                    }, 10000);
                    return;
                  }

                  const content = result.choices?.[0]?.message?.content || '';
                  const tail = content.slice(streamState.pushedLength);
                  if (!aborted && tail) {
                    writeChunk({ content: tail });
                  }
                  if (!aborted) writeChunk({}, 'stop');
                  if (!aborted && data.stream_options?.include_usage) {
                    const usageChunk = {
                      id: requestId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelName,
                      choices: [],
                      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    };
                    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                  }
                  streamState.finished = true;
                  clearTimeout(streamState.timer);
                  this.streamingOutputs.delete(handoffRequestId);
                  writeDone();
                })
                .catch((err) => {
                  if (streamState.finished) return;
                  console.error(`[SSE-ERROR]`, err.message);
                  if (!aborted) {
                    writeChunk({ content: `\n[Error: ${err.message || 'Internal server error'}]` }, null);
                    writeChunk({}, 'stop');
                  }
                  streamState.finished = true;
                  clearTimeout(streamState.timer);
                  this.streamingOutputs.delete(handoffRequestId);
                  writeDone();
                });

              return;
            }

            // ==================== 非流式分支（原有逻辑） ====================
            try {
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
            console.log(`[Poll] DELIVER task requestId=${task.request_id} to platform=${platform}`);
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

        // HTTP Streaming Update from Userscript
        //
        // 浏览器在网页流式过程中持续推送"当前的累积文本"。Server 从中切出
        // 与"已推给客户端的文本"的差值，推给 SSE 客户端。
        //
        // 请求体：
        //   { request_id: "req_...", text: "累积文本", done: false }
        //
        // 回退避免策略：
        //   - 新文本以"上次上报文本"为前缀 → 推 delta（正常追加）
        //   - 新文本不以它为前缀 → 静默忽略，等下一次上报对齐
        //     （通常是 DOM 从"纯文本代码块"切换到 Monaco 编辑器时的瞬时抖动）
        //   - done: true → 无论如何都推剩余部分，保证答案完整
        if (pathname === '/stream' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            let data;
            try {
              data = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
              return;
            }

            const { request_id: requestId, text, done } = data;
            const newText = String(text || '');
            const isDone = done === true;

            const state = this.streamingOutputs.get(requestId);
            if (!state || state.finished) {
              // 未知或已结束的 requestId：可能客户端已断开，静默接受
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ignored: true }));
              return;
            }

            const prevText = state.lastReportedText || '';
            // 改为函数调用，每次判断时都取最新值
            const isAborted = () => state.aborted();

            let accept = false;
            if (!prevText) {
              accept = true;
            } else if (newText.startsWith(prevText)) {
              accept = true;
            } else if (newText.length <= prevText.length) {
              accept = false;
            } else {
              accept = isDone;
            }

            if (accept && !isAborted()) {
              const delta = newText.slice(state.pushedLength);
              if (delta) {
                state.writeChunk({ content: delta });
                state.pushedLength = newText.length;
              }
              state.lastReportedText = newText;
            }

            if (isDone) {
              if (!isAborted() && !state.finished) {
                const tail = newText.slice(state.pushedLength);
                if (tail) {
                  state.writeChunk({ content: tail });
                  state.pushedLength = newText.length;
                }
                state.writeChunk({}, 'stop');
              }
              state.finished = true;
              if (state.timer) clearTimeout(state.timer);
              this.streamingOutputs.delete(requestId);
              if (!isAborted()) state.writeDone();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, accepted: accept }));
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
              } else {
                console.warn(`[Result] UNKNOWN requestId=${request_id} (already timed out or dup)`);
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

      for (const [requestId, state] of this.streamingOutputs.entries()) {
        try {
          state.finished = true;
          if (state.timer) clearTimeout(state.timer);
          if (!state.aborted()) {
            state.writeChunk({ content: '\n[Error: Server shutting down]' }, null);
            state.writeChunk({}, 'stop');
            state.writeDone();
          }
        } catch {}
      }
      this.streamingOutputs.clear();

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
  async handleChatCompletion(openAiRequest, options = {}) {
    const {
      model = 'chatgpt-web',
      messages = [],
      tools = null,
      temperature,
      max_tokens,
      stream = false,
    } = openAiRequest;

    // Map OpenAI model name to platform ID
    const platformId = this.modelToPlatform(model);

    // Convert messages to a prompt string（保留作为 fallback / 兼容旧路径）
    const prompt = this.messagesToPrompt(messages);

    // 拆分成带类型的 blocks，供浏览器端做增量去重。
    // 网页对话自身保存历史，因此重复的 system / context / tools 不必每轮都注入。
    const blocks = this.buildBlocks(messages, tools);

    // Execute via bridge - pass prompt as plain string for browser to inject
    const result = await this.executeHandoff(prompt, {
      platform: platformId,
      timeout: 280,
      blocks,
      // 流式模式下由调用方指定 requestId，使 server 能提前注册 /stream 输出表；
      // 非流式模式下为 undefined，executeHandoff 会自行生成。
      requestId: options.requestId,
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
   * 把 messages 拆成带类型的 blocks，供浏览器端做增量去重。
   *
   * block kind 分类：
   *   system  - role=system 的消息
   *   tools   - 请求体顶层的 tools 数组（序列化后作为单个 block）
   *   context - 非最后一条 role=user 的消息（历史 + 环境上下文等）
   *   turn    - 最后一条 role=user 的消息（本次新问题，永不去重）
   *
   * assistant 消息一律忽略：网页对话本身已有历史，不需要重复注入。
   *
   * @param {Array} messages OpenAI 格式消息数组
   * @param {Array} tools 可选的工具定义数组
   * @returns {Array<{kind:string, content:string}>}
   */
  buildBlocks(messages, tools) {
    const blocks = [];

    const contentOf = (m) => {
      const c = m?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
      }
      return '';
    };

    // 1) system
    for (const m of messages) {
      if (m?.role !== 'system') continue;
      const content = contentOf(m);
      if (content) blocks.push({ kind: 'system', content });
    }

    // 2) tools（序列化后作为单个 block）
    if (Array.isArray(tools) && tools.length > 0) {
      blocks.push({ kind: 'tools', content: JSON.stringify(tools) });
    }

    // 3) 定位最后一条 user，用于区分 context / turn
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.role === 'user') lastUserIdx = i;
    }

    // 4) user 消息
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (m?.role !== 'user') continue;
      const content = contentOf(m);
      if (!content) continue;
      blocks.push({
        kind: i === lastUserIdx ? 'turn' : 'context',
        content,
      });
    }

    return blocks;
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
      console.error(`[Handoff] NO BROWSER for platform=${targetPlatform}`);
      throw new Error(`NEEDS_BROWSER_CONNECTION: No active browser tab connected for platform [${targetPlatform}]. Please open the platform in your browser with the bridge userscript active.`);
    }

    // 优先使用调用方指定的 requestId（流式模式下 server 已用它注册 /stream 输出表），
    // 否则自行生成。
    const requestId = options.requestId
      || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 构建要发给浏览器的任务包
    const isStringPrompt = typeof packetContent === 'string';
    const taskPayload = {
      type: 'EXECUTE_REASONING',
      request_id: requestId,
      targetPlatform,
      payload: {
        packet: isStringPrompt ? packetContent : packetContent,
        // 结构化 blocks；浏览器端按 kind 与内容哈希做增量去重。
        // 若为 null（例如 ws-transport.mjs send 直接发 raw packet），
        // 浏览器端会退回到 packet 路径，不做去重。
        blocks: Array.isArray(options.blocks) ? options.blocks : null,
        model: options.model || null,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.error(`[Handoff] TIMEOUT requestId=${requestId}`);
        reject(new Error(`Timeout: Reasoning did not complete within ${options.timeout || 180}s`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          console.error(`[Handoff] REJECTED requestId=${requestId}:`, err.message);
          clearTimeout(timer);
          reject(err);
        },
      });

      // Priority 1: WebSocket clients
      for (const client of this.clients) {
        if (targetPlatform === 'auto' || client.platform === targetPlatform) {
          this.send(client, taskPayload);
          return;
        }
      }

      // Priority 2: HTTP long-poll waiters
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
      console.log(`[Handoff] ENQUEUED requestId=${requestId}, queue size=${this.queuedTasks.length}`);
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
