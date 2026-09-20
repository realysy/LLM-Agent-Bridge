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
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 是否启用调试日志
const DEBUG_LOG_ENABLED = /^(1|true|yes)$/i.test(process.env.BRIDGE_DEBUG_LOG || '');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(SCRIPT_DIR)));
const DEBUG_LOG_DIR = join(REPO_ROOT, 'logs');  // 日志文件路径: <repo_root>/logs/

/**
 * 本地时区 ISO-ish 时间戳，毫秒精度。
 * 用 '-' 替换 ':' 和 '.'，兼容 Windows 文件名（不允许冒号）。
 * 示例：2026-09-20T11-27-28-853
 */
function formatLocalTimestamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 把原始请求体落盘。启用时才执行。
 * 任何 IO 错误都只 warn，不影响主流程。
 */
function dumpDebugRequest(data) {
  if (!DEBUG_LOG_ENABLED) return;
  try {
    mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    const file = join(DEBUG_LOG_DIR, `${formatLocalTimestamp()}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[DebugLog] failed to persist request:', e.message);
  }
}

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
  constructor(port = DEFAULT_PORT, apiKey = DEFAULT_API_KEY, host = '127.0.0.1') {
    this.port = port;
    this.apiKey = apiKey;
    // 默认只监听 loopback。开放到 0.0.0.0 需要显式传 host 参数。
    this.host = host;
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

    // 上一次工具调用的结果，用于在下一轮 tool_protocol 后注入强化提示：
    //   'success' — 上一轮解析出了 tool_calls（协议遵守）
    //   'failure' — 上一轮原文里有工具调用标记，但解析出 0 个 tool_calls（协议没被遵守）
    //   null      — 尚未观测到工具调用轮次，或上一轮根本不是工具轮次
    this.lastToolUseOutcome = null;
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

            // 调试用：落盘原始请求（BRIDGE_DEBUG_LOG=1 时启用）
            dumpDebugRequest(data);

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

              this.handleChatCompletion(data, { requestId: handoffRequestId })
                .then((result) => {
                  if (streamState.finished) return;

                  const choice = result.choices?.[0];
                  const message = choice?.message || {};
                  const finishReason = choice?.finish_reason || 'stop';
                  const toolCalls = message.tool_calls;
                  const cleanContent = message.content || '';

                  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                    if (!aborted) {
                      // 不再推 content tail —— tool_calls 场景下 content 应当为空
                      writeChunk({ tool_calls: this.buildToolCallsDelta(toolCalls) });
                      writeChunk({}, 'tool_calls');
                    }
                  } else if (streamState.pushedLength > 0) {
                    // 浏览器已在推 /stream：等 done 帧处理，最多等 10 秒
                    setTimeout(() => {
                      if (streamState.finished) return;
                      const tail = cleanContent.slice(streamState.pushedLength);
                      if (!aborted && tail) writeChunk({ content: tail });
                      if (!aborted) writeChunk({}, finishReason);
                      streamState.finished = true;
                      if (streamState.timer) clearTimeout(streamState.timer);
                      this.streamingOutputs.delete(handoffRequestId);
                      writeDone();
                    }, 10000);
                    return;
                  } else {
                    // 兼容路径：浏览器完全没推 /stream
                    const tail = cleanContent.slice(streamState.pushedLength);
                    if (!aborted && tail) {
                      writeChunk({ content: tail });
                    }
                    if (!aborted) writeChunk({}, finishReason);
                  }

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
            const rawText = String(text || '');
            // 移除 <tool_call> 块：用户不应该在流式输出里看到工具调用指令。
            // 最终工具调用信息由 .then() 分支单独发出。
            const newText = this.cleanStreamText(rawText);
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
              // 只标记浏览器已结束推送；最终输出由 handleChatCompletion 的
              // .then() 分支决定（因为可能包含 tool_calls chunk）。
              // 不做 writeDone()，也不 delete state —— 让 .then() 收尾。
              state.browserDone = true;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, accepted: accept, deferred: true }));
              return;
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

      this.server.listen(this.port, this.host, () => {
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
   * Converts OpenAI request format to bridge packet and routes to browser.
   *
   * 如果网页模型返回的内容中包含 <tool_call> 块，会解析成 OpenAI 的
   * tool_calls 结构，并设置 finish_reason='tool_calls'。
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

    const rawContent = result.content || '';
    const { toolCalls, cleanContent } = this.parseToolCallsFromContent(rawContent);

    // 更新"上次工具调用结果"，供下一轮 buildBlocks 生成强化提示时使用：
    //   - 解析出 toolCalls → 'success'（协议被遵守）
    //   - 没解析出但原文有工具调用标记 → 'failure'（模型走偏了）
    //   - 都没出现 → 保持原状态（本轮不是工具调用轮次）
    if (Array.isArray(tools) && tools.length > 0) {
      const prev = this.lastToolUseOutcome;
      if (toolCalls.length > 0) {
        this.lastToolUseOutcome = 'success';
      } else {
        // 全角竖线 U+FF5C 组成的 DeepSeek DSML token，与半角 `|` 不通用
        const hasMarkers =
          rawContent.includes('<tool_call') ||
          rawContent.includes('<｜｜DSML｜｜') ||
          rawContent.includes('<|tool_calls');
        if (hasMarkers) {
          this.lastToolUseOutcome = 'failure';
        }
      }
      if (this.lastToolUseOutcome !== prev) {
        console.log(`[ToolUse] outcome: ${prev ?? '(none)'} -> ${this.lastToolUseOutcome}`);
      }
    }

    // Generate OpenAI-compatible response
    const requestId = `chatcmpl-${Date.now()}-${++this.requestIdCounter}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const message = {
      role: 'assistant',
      // OpenAI 规范：有 tool_calls 时 content 通常为 null
      content: toolCalls.length > 0 ? (cleanContent || null) : (rawContent || ''),
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: requestId,
      object: 'chat.completion',
      created: timestamp,
      model: model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: this.estimateTokens(prompt),
        completion_tokens: this.estimateTokens(rawContent),
        total_tokens: this.estimateTokens(prompt) + this.estimateTokens(rawContent),
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
   * 判断一条 user context 是否属于"每轮都必须重新投喂"的环境信息。
   *
   * Copilot 每轮都会把这些块原样带上（hash 相同），我们的 sentHashes
   * 去重会命中并跳过 —— 但模型确实每轮都需要它们才能正常工作：
   * 尤其是 <workspace_info> 里的工作区路径。跳过后模型会从 system
   * prompt 里的零碎路径（如 VSCODE_TARGET_SESSION_LOG）瞎拼出
   * /opt/.../workspaceStorage/<uuid> 这种假路径。
   *
   * 这类块体积小（几百 token），每轮重发的成本可控；相比丢失路径
   * 导致的工具调用失败，代价可以忽略。
   */
  isPersistentContext(content) {
    return /<environment_info>|<workspace_info>|<userMemory>|<sessionMemory>|<repoMemory>/.test(content);
  }

  /**
   * 把 messages 拆成带类型的 blocks，供浏览器端做增量去重。
   *
   * block kind 分类：
   *   system        - role=system 的消息
   *   tools         - 请求体顶层的 tools 数组（JSON 序列化后作为单个 block）
   *   tool_protocol - 工具调用格式说明（仅当请求带 tools 时生成）
   *   context       - 非最后一条 role=user 的消息（历史 + 环境上下文等）
   *   tool_result   - role=tool 的消息（工具执行结果），按 call_id 关联工具名
   *   turn          - 最后一条 role=user 的消息（本次新问题，永不去重）
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

    // 2) tools + tool_protocol + tool_reinforcement
    if (Array.isArray(tools) && tools.length > 0) {
      blocks.push({ kind: 'tools', content: JSON.stringify(tools) });
      blocks.push({
        kind: 'tool_protocol',
        content: this.buildToolProtocolPrompt(tools),
      });

      // 根据上一轮的成功/失败，注入针对性强化提示。
      // 独立 block + alwaysSend：每轮都发，不污染 tool_protocol 的 hash。
      const reinforcement = this.buildToolReinforcement(this.lastToolUseOutcome);
      if (reinforcement) {
        blocks.push({
          kind: 'tool_reinforcement',
          content: reinforcement,
          alwaysSend: true,
        });
      }
    }

    // 3) 建立 tool_call_id -> tool_name 的映射
    // Copilot 会把上一轮 bridge 返回的 tool_calls 原样带回来，
    // 每个 id 对应一个工具名。tool 消息只带 id，需要靠这个映射恢复工具名。
    const toolCallMap = new Map();
    for (const m of messages) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.id && tc?.function?.name) {
            toolCallMap.set(tc.id, tc.function.name);
          }
        }
      }
    }

    // 4) 定位最后一条 user，用于区分 context / turn
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]?.role === 'user') lastUserIdx = i;
    }

    // 5) 按顺序生成 blocks
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (!m) continue;

      if (m.role === 'system') continue;    // 已处理
      if (m.role === 'assistant') continue; // 网页模型自己记得它的输出

      if (m.role === 'user') {
        const content = contentOf(m);
        if (!content) continue;
        const isTurn = i === lastUserIdx;
        blocks.push({
          kind: isTurn ? 'turn' : 'context',
          content,
          // 环境/工作区/记忆类上下文：每轮都发，不参与去重
          alwaysSend: !isTurn && this.isPersistentContext(content),
        });
        continue;
      }

      if (m.role === 'tool') {
        const callId = m.tool_call_id;
        const toolName = (callId && toolCallMap.get(callId)) || 'unknown_tool';
        const content = contentOf(m) || '(empty result)';
        blocks.push({
          kind: 'tool_result',
          content: `TOOL_RESULT (tool=${toolName}):\n${content}`,
        });
        continue;
      }
    }

    return blocks;
  }

  /**
   * 生成工具调用协议说明。仅当请求带 tools 时生成，作为独立 block
   * 发送给网页模型，明确要求它按 <tool_call> 格式输出。
   *
   * 不这样做的话，模型会按它自己训练过的格式输出（例如 DeepSeek 的
   * <｜｜DSML｜｜ calls>、OpenAI 的 function_call XML、markdown json
   * 代码块等），agent 客户端无法解析。
   *
   * 设计要点（来自实测踩过的坑）：
   *   1) 模型倾向于在 tool_call 前后加"我先看看..."这类叙述 —— 必须禁止
   *   2) 模型偶尔会多吐一个 </tool_call> —— 必须显式强调"唯一闭标签"
   *   3) 模型不知道工作区路径时会从 system prompt 里抓零碎片段瞎拼
   *      （如把 VSCODE_TARGET_SESSION_LOG 里的 UUID 当成 cwd）——
   *      必须要求路径未知时先探测，绝不允许猜测
   *   4) 模型偶尔会在 tool_call 后继续输出最终答案 —— 必须明确"emit 后
   *      立即停止，等待 TOOL_RESULT"
   */
  buildToolProtocolPrompt(tools) {
    const toolNames = tools
      .map((t) => t?.function?.name)
      .filter((n) => typeof n === 'string')
      .join(', ');

    return [
      'TOOL CALLING PROTOCOL',
      '',
      'You are connected to an external tool runner. You may invoke tools to complete the user\'s request. Follow the rules below EXACTLY — the runner parses your output mechanically and cannot tolerate deviations.',
      '',
      '### Invocation format',
      '',
      'To invoke a tool, emit a block in EXACTLY this form:',
      '',
      '<tool_call>',
      '```json',
      '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
      '```',
      '</tool_call>',
      '',
      '### Hard rules',
      '',
      '1. OUTPUT SHAPE. When you decide to call tools, your entire response MUST consist solely of one or more <tool_call> blocks. Do NOT output any prose, greeting, acknowledgement, plan, explanation, or trailing summary — not before, not between, not after the blocks.',
      '2. JSON INSIDE CODE FENCE. The JSON object MUST be inside a fenced code block tagged exactly ```json, and that code block MUST be wrapped by <tool_call> ... </tool_call>. The fence is REQUIRED because the runner reads the JSON from the rendered code block; without it your arguments may be corrupted by the UI\'s markdown renderer.',
      '3. ONE TAG PER BLOCK. Each <tool_call> block opens with exactly one <tool_call> tag and closes with exactly one </tool_call> tag. Never emit duplicate or stray closing tags.',
      '4. NO NESTING. Never nest one <tool_call> block inside another. For multiple tools, emit each block sequentially: close the first </tool_call> BEFORE opening the next <tool_call>.',
      '5. NO CONTROL TOKENS. Never emit model-specific control tokens such as <｜｜DSML｜｜ calls> or <|tool_calls|>. They will be rejected by the runner.',
      '6. ARGUMENTS. "arguments" MUST be a JSON object (not a string) whose fields match the tool\'s parameter schema. Include every required field. Use correct JSON types (numbers as numbers, booleans as booleans).',
      '7. STOP AFTER EMITTING. Immediately after the last </tool_call> tag, STOP. Do not continue with the final answer. The runner will execute the calls and reply with one TOOL_RESULT block per call.',
      '8. PATHS. Whenever a parameter expects a file or directory path, provide an ABSOLUTE path. If you do not know the current working directory, do NOT guess or infer it from unrelated context — first call a tool that reveals it (for example, run `pwd` in the terminal) and wait for its result.',
      '9. WHEN TO FINISH. When you no longer need any tool — i.e. you can answer the user directly — respond with the final answer as plain text, WITHOUT any <tool_call> block.',
      '',
      '### Positive example',
      '',
      'User asks to list the workspace. Correct response (entire response, nothing else):',
      '',
      '<tool_call>',
      '```json',
      '{"name": "list_dir", "arguments": {"path": "/home/user/project"}}',
      '```',
      '</tool_call>',
      '',
      '### Negative examples — never produce output like these',
      '',
      'WRONG (JSON not wrapped in a code fence):',
      '  <tool_call>{"name": "list_dir", "arguments": {"path": "/"}}</tool_call>',
      '',
      'WRONG (extra prose around the block):',
      '  Sure, I\'ll list the directory first.',
      '  <tool_call>',
      '  ```json',
      '  {"name": "list_dir", "arguments": {"path": "/"}}',
      '  ```',
      '  </tool_call>',
      '',
      'WRONG (two tool_calls nested instead of sequential):',
      '  <tool_call><tool_call>...</tool_call></tool_call>',
      '',
      '### Available tools',
      '',
      toolNames || '(none)',
    ].join('\n');
  }

  /**
   * 生成工具调用格式的强化提示。
   *
   * 目的：通过正向/负向反馈提高模型遵守协议的概率。
   *   - 上一轮解析成功 → 正向强化，鼓励保持格式
   *   - 上一轮解析失败 → 纠正提示，明确要求重试正确格式
   *   - 尚未观测到工具调用 → 返回 null，不注入
   *
   * 作为**独立 block**（kind='tool_reinforcement'）发送，不污染
   * tool_protocol 的 hash —— 后者是静态去重的，混入动态内容会让它
   * 每轮都重发，失去去重意义。
   *
   * 该 block 带 alwaysSend=true，每轮都随请求注入。
   */
  buildToolReinforcement(status) {
    if (status !== 'success' && status !== 'failure') return null;

    const example = [
      '<tool_call>',
      '```json',
      '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
      '```',
      '</tool_call>',
    ].join('\n');

    if (status === 'success') {
      return [
        'TOOL CALL FORMAT — REINFORCEMENT',
        '',
        'GREAT — your previous tool call was parsed successfully. Keep emitting tool calls in EXACTLY the same format:',
        '',
        example,
        '',
        'Do not deviate. Continue using this exact format for every subsequent call.',
      ].join('\n');
    }

    // status === 'failure'
    return [
      'TOOL CALL FORMAT — CORRECTION',
      '',
      'WRONG — your previous round failed because the tool call was NOT in the required format. You MUST use EXACTLY this format:',
      '',
      example,
      '',
      'Do NOT use DSML (e.g. <｜｜DSML｜｜ …), function_call XML, <|tool_calls|>, bare JSON, or any other syntax. The <tool_call> wrapper AND the ```json code fence are both REQUIRED. Retry the same tool call using the format above.',
    ].join('\n');
  }

  /**
   * DeepSeek DSML 工具调用解析器（兜底）。
   *
   * 协议（tool_protocol block）已明确要求 JSON 格式，模型在绝大多数
   * 轮次会遵守。但当上下文变长或模型"走神"时，它会退化到训练语料里
   * 见过的 DSML 格式。这个解析器负责接住这种情况。
   *
   * 实测遇到两种形态，都要兼容：
   *
   *   形态 A（逐参数）：
   *     <｜｜DSML｜｜ parameter name="filePath" string="true">/a/b.txt</｜｜DSML｜｜ parameter>
   *     <｜｜DSML｜｜ parameter name="startLine" string="false">1</｜｜DSML｜｜ parameter>
   *     → arguments = { filePath: "/a/b.txt", startLine: 1 }
   *
   *   形态 B（打包 arguments）：
   *     <｜｜DSML｜｜ parameter name="arguments" string="false">{"path": "/a"}</｜｜DSML｜｜ parameter>
   *     → arguments = { path: "/a" }
   *
   * 判定规则：若参数里只有唯一的 `arguments` 键且值是对象，直接展开。
   *
   * 返回 { calls, stripped }：calls 是 OpenAI tool_calls，stripped 是
   * 移除 DSML 块后的剩余文本（供后续 JSON 扫描使用）。
   */
  parseDsmlToolCalls(content) {
    const calls = [];
    if (!content) return { calls, stripped: '' };

    const blocksToRemove = [];
    let stripped = content;

    const callsRegex = /<｜｜DSML｜｜\s*calls>([\s\S]*?)<\/｜｜DSML｜｜\s*calls>/g;
    const invokeRegex = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>/g;
    const paramRegex = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/g;

    let callsMatch;
    while ((callsMatch = callsRegex.exec(content)) !== null) {
      const inner = callsMatch[1];
      invokeRegex.lastIndex = 0;

      let invokeMatch;
      while ((invokeMatch = invokeRegex.exec(inner)) !== null) {
        const toolName = invokeMatch[1];
        const paramsBlock = invokeMatch[2];
        const rawArgs = {};

        paramRegex.lastIndex = 0;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
          const pName = paramMatch[1];
          // string="true" 或缺省 => 值按字符串处理；string="false" => 尝试 JSON.parse
          const pIsString = paramMatch[2] !== 'false';
          const pValue = paramMatch[3];
          if (pIsString) {
            rawArgs[pName] = pValue;
          } else {
            try { rawArgs[pName] = JSON.parse(pValue); }
            catch { rawArgs[pName] = pValue; }
          }
        }

        // 形态 B 展开：只有唯一的 arguments 键，且值是对象
        let finalArgs = rawArgs;
        const keys = Object.keys(rawArgs);
        if (keys.length === 1 && keys[0] === 'arguments'
            && rawArgs.arguments && typeof rawArgs.arguments === 'object') {
          finalArgs = rawArgs.arguments;
        }

        if (toolName) {
          calls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(finalArgs),
            },
          });
        }
      }

      blocksToRemove.push([callsMatch.index, callsMatch.index + callsMatch[0].length]);
    }

    for (let i = blocksToRemove.length - 1; i >= 0; i--) {
      const [s, e] = blocksToRemove[i];
      stripped = stripped.slice(0, s) + stripped.slice(e);
    }

    return { calls, stripped };
  }

  /**
   * 从网页模型的原始输出里提取工具调用。
   *
   * 解析顺序（两条路径互补，不互斥）：
   *   1) DSML 兜底 —— 模型走偏到自己的训练格式时接住
   *   2) JSON 协议 —— 模型遵守 tool_protocol 时的正常路径
   *
   * 先跑 DSML 是因为它的块里没有 {…}，JSON 扫描抓不到，必须单独处理。
   * DSML 块被剥离后，剩余文本再走 JSON 扫描，互不干扰。
   */
  parseToolCallsFromContent(content) {
    const toolCalls = [];
    if (!content) return { toolCalls, cleanContent: '' };

    // ---- 1) DSML 兜底解析 ----
    const { calls: dsmlCalls, stripped } = this.parseDsmlToolCalls(content);
    toolCalls.push(...dsmlCalls);
    let working = stripped;

    // ---- 2) JSON 协议解析 ----
    const consumedRanges = [];
    const jsonObjects = this.extractJsonObjects(working);

    for (const { json, start, end } of jsonObjects) {
      let obj;
      try { obj = JSON.parse(json); } catch { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (typeof obj.name !== 'string') continue;
      if (!('arguments' in obj)) continue;

      const args = obj.arguments;
      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: obj.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      });
      consumedRanges.push([start, end]);
    }

    let cleanContent = working;
    for (let i = consumedRanges.length - 1; i >= 0; i--) {
      const [s, e] = consumedRanges[i];
      cleanContent = cleanContent.slice(0, s) + cleanContent.slice(e);
    }

    cleanContent = this.stripToolSyntax(cleanContent);
    return { toolCalls, cleanContent };
  }

  /**
   * 扫描文本中所有形如 {...} 的平衡 JSON 片段，返回其中**含 `"name":`
   * 字段的候选对象**。
   *
   * 为什么要预检 `"name"`：
   *   本函数的调用方只有 parseToolCallsFromContent，它只关心
   *   tool_call 对象（必须有顶层 name）。其他 JSON（比如用户提供的
   *   schema、嵌套的 arguments 内容）直接跳过，可以省下一次
   *   JSON.parse，也不会污染候选集。
   *
   * 为什么用括号平衡而不是正则：
   *   - 正确处理嵌套对象/数组
   *   - 正确处理字符串字面量里的 { } 和转义字符 \"
   *   - 遇到未闭合的 { 时只跳过它，不影响后续扫描
   *     （历史 bug：曾经 break，导致前面任何一个孤立 { 就丢弃全部）
   *
   * 返回 [{ json, start, end }, ...]，按出现顺序排列。
   */
  extractJsonObjects(text) {
    const results = [];
    if (!text) return results;
    const n = text.length;

    for (let i = 0; i < n; i++) {
      if (text[i] !== '{') continue;

      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let j = i; j < n; j++) {
        const c = text[j];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }

      if (end === -1) continue;   // 这个 { 没配对，跳过它继续找下一个

      const json = text.slice(i, end + 1);
      if (!/"name"\s*:/.test(json)) continue;   // 不跳 i，允许扫到内层
      results.push({ json, start: i, end: end + 1 });
      i = end;   // 只有识别为 tool_call 才跳过
    }

    return results;
  }

  /**
   * 清理模型输出里各种"工具调用语法残留"：
   *   - <tool_call> / </tool_call> 成对或孤立标签
   *   - DeepSeek 特有 token：<｜｜DSML｜｜ ...> 或 </｜｜...>
   *   - 通用特殊 token：<|...|>
   */
  stripToolSyntax(text) {
    if (!text) return '';
    return text
      .replace(/<\/?tool_call>/g, '')
      // 兜底 1：成对的 DSML 块（invoke / parameter），连同内容一并删除。
      // 主要防畸形输入（模型写了开头忘了结尾，导致 parseDsmlToolCalls
      // 匹配不到完整块）。
      .replace(/<｜｜DSML｜｜[^>]*>[\s\S]*?<\/｜｜DSML｜｜[^>]*>/g, '')
      // 兜底 2：自闭合或单侧的 DSML 标签（如 <｜｜DSML｜｜ calls>）
      .replace(/<\/?｜[^>]*>/g, '')
      // 通用特殊 token：<|...|> / <|...>
      .replace(/<\|[^>]*?\|>/g, '')
      .replace(/<\|[^>]*>/g, '')
      .replace(/```json\s*```/g, '')
      .replace(/```\s*```/g, '')
      .trim();
  }

  /**
   * 流式推送时对累积文本做清理：
   *   - 移除已闭合的 <tool_call>...</tool_call> 块
   *   - 遇到未闭合的 <tool_call> 或 DeepSeek 特殊 token 起始（<｜），
   *     截断到它之前，避免 tool_call 内容被流式推给用户
   *
   * 真正的工具调用信息会由最终帧的 tool_calls chunk 单独发出。
   */
  cleanStreamText(text) {
    if (!text) return '';
    let result = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

    const markers = ['<tool_call>', '<｜'];
    let cutAt = result.length;
    for (const m of markers) {
      const i = result.indexOf(m);
      if (i !== -1 && i < cutAt) cutAt = i;
    }
    return result.slice(0, cutAt);
  }

  /**
   * 把 tool_calls 数组转换成 OpenAI SSE 的 delta 结构。
   */
  buildToolCallsDelta(toolCalls) {
    return toolCalls.map((tc, idx) => ({
      index: idx,
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
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
  node openai-api.mjs serve [--port 8765] [--host 127.0.0.1] [--api-key your-key]

Commands:
  serve   Start OpenAI-compatible API server

Options:
  --port       Port to listen on (default: 8765)
  --host       Interface to bind (default: 127.0.0.1, loopback only).
               Use 0.0.0.0 to accept connections from other machines.
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

  const hostIndex = args.indexOf('--host');
  const host = hostIndex !== -1 ? args[hostIndex + 1] : '127.0.0.1';

  if (command === 'serve') {
    const server = new OpenAIApiServer(port, apiKey, host);
    await server.start();
    // --port 0 时 OS 会分配随机端口，日志必须打实际端口，
    // 否则测试无法得知该连到哪。
    const actualPort = server.server.address().port;
    console.log(`[OpenAIApiServer] Listening on http://${host}:${actualPort}`);
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
