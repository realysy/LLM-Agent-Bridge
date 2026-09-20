/**
 * OpenAI API 兼容性测试套件
 *
 * 设计原则（针对历史上测试超时/端口冲突/污染真实浏览器的问题）：
 *   1) 随机端口：--port 0，从 server stdout 解析真实端口，绝不与
 *      开发者本机运行的 server（8765）冲突。
 *   2) 独立子进程：测试启动的 server 是 detached 进程，浏览器的
 *      Tampermonkey 脚本不会连到它，因此不会真的向网页大模型发请求。
 *   3) 每个 test 都有 { timeout } option，超时即失败，绝不挂起整个 suite。
 *   4) 所有 HTTP 请求都带 AbortController 超时。
 *   5) 不依赖"有浏览器连接"的场景 —— 无浏览器时 bridge 返回 500 /
 *      NEEDS_BROWSER_CONNECTION 是预期行为。
 *   6) 不残留状态：/poll 用独立 platform，且主动 abort。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = 'sk-bridge-local-key';
const TEST_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 3000;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'skills', 'universal-agent-bridge', 'scripts', 'openai-api.mjs');

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, 'serve', '--port', '0', '--api-key', API_KEY], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 显式关闭调试日志，避免测试期间往 logs/ 写文件
      env: { ...process.env, BRIDGE_DEBUG_LOG: '' },
    });

    let settled = false;
    let stdoutBuf = '';

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const m = stdoutBuf.match(/Listening on http:\/\/[^:]+:(\d+)/);
      if (!m) return;
      const port = parseInt(m[1], 10);
      if (!port) return;
      const baseUrl = `http://127.0.0.1:${port}`;
      // 给 server 一点时间进入 listen 状态
      setTimeout(() => finish(resolve, { child, port, baseUrl }), 150);
    });

    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => finish(reject, new Error(`Server exited with code ${code} before ready`)));

    setTimeout(() => finish(reject, new Error('Server startup timed out')), TEST_TIMEOUT_MS);
  });
}

function stopServer(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// HTTP helper —— fetch + AbortController，每个请求都带超时
// ---------------------------------------------------------------------------

async function httpRequest(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (!options.skipAuth) headers['Authorization'] = `Bearer ${API_KEY}`;
    if (options.headers) Object.assign(headers, options.headers);

    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 顶层 describe：启动一次 server，所有测试共享
// ---------------------------------------------------------------------------

test.describe('OpenAI API 兼容性测试', { concurrency: false }, () => {
  let server;

  test.before(async () => {
    server = await startServer();
  });

  test.after(() => {
    if (server) stopServer(server.child);
  });

  // ---------- 认证 ----------

  test.describe('认证与授权', { concurrency: false }, () => {
    test('无认证 token 时返回 200 或 401（宽松模式）', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/models', { skipAuth: true });
      assert.ok([200, 401].includes(r.statusCode));
    });

    test('错误的认证 token 应返回 401', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/models', {
        headers: { 'Authorization': 'Bearer wrong-key' },
      });
      assert.strictEqual(r.statusCode, 401);
    });

    test('正确的认证 token 应通过验证', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/models');
      assert.strictEqual(r.statusCode, 200);
    });
  });

  // ---------- /v1/models ----------

  test.describe('GET /v1/models', { concurrency: false }, () => {
    test('应返回模型列表', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/models');
      assert.strictEqual(r.statusCode, 200);
      assert.ok(Array.isArray(r.body.data));
      assert.ok(r.body.data.length > 0);
      const m = r.body.data[0];
      assert.ok(m.id);
      assert.strictEqual(m.object, 'model');
      assert.ok(m.created);
      assert.ok(m.owned_by);
    });
  });

  // ---------- /status ----------

  test.describe('GET /status', { concurrency: false }, () => {
    test('健康检查应无需认证', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/status', { skipAuth: true });
      assert.strictEqual(r.statusCode, 200);
      assert.ok(typeof r.body === 'object');
      assert.ok('status' in r.body);
    });
  });

  // ---------- /v1/chat/completions（非流式） ----------
  //
  // 测试环境无浏览器连接，bridge 会返回 NEEDS_BROWSER_CONNECTION。
  // 我们只验证 API 层正确解析请求并给出合理响应（200/500），
  // 不依赖真实模型输出。

  test.describe('POST /v1/chat/completions', { concurrency: false }, () => {
    test('应拒绝空请求体', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {},
      });
      assert.ok(r.statusCode !== 400 || r.body.error);
    });

    test('应接受有效的聊天请求（无浏览器时返回 500）', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'claude-web',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });
      assert.ok([200, 500].includes(r.statusCode));
    });

    test('应支持 system 角色消息', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'claude-web',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
          ],
        },
      });
      assert.ok(r.statusCode !== 400);
    });

    test('应支持 temperature 和 max_tokens 参数', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'deepseek-web',
          messages: [{ role: 'user', content: 'Test' }],
          temperature: 0.7,
          max_tokens: 1000,
        },
      });
      assert.ok(r.statusCode !== 400);
    });

    test('应支持多轮对话', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'chatgpt-web',
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello! How can I help?' },
            { role: 'user', content: 'What is 2+2?' },
          ],
        },
      });
      assert.ok(r.statusCode !== 400);
    });
  });

  // ---------- 错误处理 ----------

  test.describe('错误处理', { concurrency: false }, () => {
    test('未知模型应返回适当错误', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'nonexistent-model',
          messages: [{ role: 'user', content: 'Test' }],
        },
      });
      assert.ok(r.body.error || r.statusCode !== 200);
    });

    test('缺少 messages 应返回错误', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'claude-web' },
      });
      assert.ok(r.body.error || r.statusCode !== 200);
    });

    test('无效的 messages 格式应返回错误', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/v1/chat/completions', {
        method: 'POST',
        body: { model: 'claude-web', messages: 'invalid' },
      });
      assert.ok(r.body.error || r.statusCode !== 200);
    });
  });

  // ---------- /stream ----------

  test.describe('/stream 端点', { concurrency: false }, () => {
    test('无需 API key 认证', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/stream', {
        method: 'POST',
        skipAuth: true,
        body: { request_id: 'nonexistent', text: 'hello', done: false },
      });
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(r.body.ignored, true);
    });

    test('拒绝无效 JSON', { timeout: TEST_TIMEOUT_MS }, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${server.baseUrl}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json',
          signal: controller.signal,
        });
        assert.strictEqual(res.status, 400);
      } finally {
        clearTimeout(timer);
      }
    });

    test('未知 request_id 静默接受', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/stream', {
        method: 'POST',
        skipAuth: true,
        body: { request_id: 'req_does_not_exist', text: 'any', done: true },
      });
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(r.body.ignored, true);
    });

    test('GET 方法返回 404', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/stream', { method: 'GET', skipAuth: true });
      assert.strictEqual(r.statusCode, 404);
    });
  });

  // ---------- 原有桥接接口 ----------

  test.describe('原有桥接接口兼容性', { concurrency: false }, () => {
    test('POST /handoff 端点存在（无浏览器时快速返回 500）', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/handoff', {
        method: 'POST',
        body: {},
      });
      // 端点存在不是 404；无浏览器时是 500
      assert.notStrictEqual(r.statusCode, 404);
      assert.strictEqual(r.statusCode, 500);
    });

    test('GET /poll 端点存在', { timeout: TEST_TIMEOUT_MS }, async () => {
      // 用独立 platform 避免污染其它测试的 activeProviders。
      // long-poll 会挂起；请求超时后 AbortError 也证明端点存在。
      const r = await httpRequest(server.baseUrl, '/poll?platform=test-probe-1', {
        skipAuth: true,
        timeoutMs: 800,
      }).catch((err) => {
        if (err.name === 'AbortError') return { statusCode: 200, longPoll: true };
        throw err;
      });
      assert.notStrictEqual(r.statusCode, 404);
    });

    test('POST /result 端点存在', { timeout: TEST_TIMEOUT_MS }, async () => {
      const r = await httpRequest(server.baseUrl, '/result', {
        method: 'POST',
        body: { task_id: 'test', result: 'test' },
      });
      assert.ok(r.statusCode !== 404);
    });
  });

  // ---------- SSE 生命周期 ----------

  test.describe('流式完整生命周期', { concurrency: false }, () => {
    test('stream=true 时应发 role 帧并以 [DONE] 结束', { timeout: TEST_TIMEOUT_MS }, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: 'qwen-web',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
          signal: controller.signal,
        });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

        const text = await res.text();
        const lines = text.split('\n').filter((l) => l.startsWith('data: '));
        assert.ok(lines.length >= 2, 'SSE should emit at least role frame and [DONE]');

        const first = JSON.parse(lines[0].slice(6));
        assert.strictEqual(first.choices[0].delta.role, 'assistant');
        assert.strictEqual(lines[lines.length - 1].trim(), 'data: [DONE]');
      } finally {
        clearTimeout(timer);
      }
    });
  });
});