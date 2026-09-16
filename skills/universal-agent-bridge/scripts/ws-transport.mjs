#!/usr/bin/env node

/**
 * Universal Agent Bridge Multi-Platform Local Server (WebSocket + HTTP Long-Polling)
 * Supports: ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, GLM
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exec } from 'node:child_process';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 8765;

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

export class BridgeServer {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.clients = new Set();
    this.pendingRequests = new Map();
    this.server = null;
    this.latestClientStatus = null;

    // Platform registry
    this.activeProviders = new Map(); // platformId -> { info, lastHeartbeat, type: 'ws'|'http' }
    this.httpPollWaiters = new Map(); // platformId -> [waiters]
    this.queuedTasks = [];
  }

  setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
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
        list.push({
          id,
          name: prov.info?.platform_name || id,
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

        // 1. Health & Status
        if (pathname === '/status') {
          const platforms = this.getActivePlatformList();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: platforms.length > 0 ? 'READY' : 'NEEDS_BROWSER_CONNECTION',
            connected_clients: platforms.length,
            platforms,
            client_info: this.latestClientStatus,
          }));
          return;
        }

        // 2. HTTP Long-Poll from Userscript (Fetch Next Task)
        if (pathname === '/poll') {
          const platform = urlObj.searchParams.get('platform') || 'chatgpt';
          const now = Date.now();

          // Update provider timestamp
          const current = this.activeProviders.get(platform) || { info: {}, type: 'http' };
          current.lastHeartbeat = now;
          this.activeProviders.set(platform, current);

          // Check for matching queued task
          const taskIdx = this.queuedTasks.findIndex(t => !t.targetPlatform || t.targetPlatform === 'auto' || t.targetPlatform === platform);
          if (taskIdx !== -1) {
            const task = this.queuedTasks.splice(taskIdx, 1)[0];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ task }));
            return;
          }

          // Otherwise hold the request
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

        // 3. HTTP Client Heartbeat
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

        // 4. HTTP Result Submission
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

        // 5. External CLI / Agent Handoff execution
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
        console.error('[BridgeServer] Invalid JSON message received:', err.message);
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
      console.error('[BridgeServer] Socket write error:', err.message);
    }
  }

  async executeHandoff(packetContent, options = {}) {
    const timeoutMs = (options.timeout || 180) * 1000;
    const targetPlatform = options.platform || 'auto';

    if (!this.isBrowserConnected(targetPlatform)) {
      throw new Error(`NEEDS_BROWSER_CONNECTION: No active browser tab connected for platform [${targetPlatform}]. Please open ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, or GLM with the bridge active.`);
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
  node ws-transport.mjs serve [--port 8765]
  node ws-transport.mjs status [--port 8765]
  node ws-transport.mjs send <packet_file> [output_file] [--platform auto|chatgpt|claude|deepseek|gemini|kimi|grok|qwen|doubao|glm] [--port 8765] [--timeout 180]

Commands:
  serve   Start standalone Universal Bridge server
  status  Check connected browser platforms (ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, GLM)
  send    Send a Context Packet to an active Web reasoning platform
    `);
    return;
  }

  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : DEFAULT_PORT;

  const platformIndex = args.indexOf('--platform');
  const targetPlatform = platformIndex !== -1 ? args[platformIndex + 1] : 'auto';

  if (command === 'serve') {
    const server = new BridgeServer(port);
    await server.start();
    console.log(`[BridgeServer] Listening on http/ws://0.0.0.0:${port}`);
    console.log(`[BridgeServer] Ready for ChatGPT / Claude / DeepSeek / Gemini / Kimi / Grok / Qwen / Doubao / GLM connections.`);
    return;
  }

  if (command === 'status') {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      const json = await res.json();
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(JSON.stringify({ status: 'SERVER_NOT_RUNNING', error: `No bridge server on port ${port}` }, null, 2));
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'send') {
    const packetPath = resolve(args[1]);
    const outputPath = args[2] && !args[2].startsWith('--') ? resolve(args[2]) : null;

    let packetContent;
    try {
      packetContent = await readFile(packetPath, 'utf8');
    } catch (err) {
      console.error(`Error reading packet file: ${err.message}`);
      process.exitCode = 2;
      return;
    }

    let isExternalServer = false;
    let server = null;
    let isTemporaryServer = false;

    try {
      const statusRes = await fetch(`http://127.0.0.1:${port}/status`);
      const statusJson = await statusRes.json();
      isExternalServer = true;

      // 1. First check if any browser tab (or the requested target platform) is already open and connected
      const availablePlatforms = (statusJson.platforms || []).map(p => p.id);
      const isAlreadyConnected = targetPlatform === 'auto'
        ? availablePlatforms.length > 0
        : availablePlatforms.includes(targetPlatform);

      if (isAlreadyConnected) {
        const selected = targetPlatform === 'auto' ? availablePlatforms[0] : targetPlatform;
        console.log(`[Bridge] Using already connected browser platform: [${selected}]`);
      } else {
        // 2. If not connected, launch the default browser to the requested platform
        const launchTarget = targetPlatform === 'auto' ? 'deepseek' : targetPlatform;
        console.log(`[Bridge] No active connection for [${targetPlatform}]. Automatically launching [${launchTarget}] in default browser...`);
        openBrowser(launchTarget);

        const connected = await new Promise((resolveWait) => {
          const interval = setInterval(async () => {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/status`);
              const checkJson = await res.json();
              const checkPlatforms = (checkJson.platforms || []).map(p => p.id);
              if (targetPlatform === 'auto' ? checkPlatforms.length > 0 : checkPlatforms.includes(targetPlatform)) {
                clearInterval(interval);
                resolveWait(true);
              }
            } catch {}
          }, 800);
          setTimeout(() => {
            clearInterval(interval);
            resolveWait(false);
          }, 25000);
        });

        if (!connected) {
          console.error(`Error: Timed out waiting for browser tab to connect.`);
          process.exitCode = 1;
          return;
        }
      }
    } catch {
      isTemporaryServer = true;
      server = new BridgeServer(port);
      await server.start();
      console.log(`[BridgeServer] Started temporary bridge on ws/http://0.0.0.0:${port}`);

      // Check if any tab connects immediately within 1.5 seconds before launching browser
      const alreadyOpen = await new Promise((resolveQuick) => {
        const quickTimer = setTimeout(() => resolveQuick(false), 1500);
        const quickInterval = setInterval(() => {
          if (server.isBrowserConnected(targetPlatform)) {
            clearTimeout(quickTimer);
            clearInterval(quickInterval);
            resolveQuick(true);
          }
        }, 300);
      });

      if (alreadyOpen) {
        console.log(`[Bridge] Reused already open browser tab for [${targetPlatform}].`);
      } else {
        const launchTarget = targetPlatform === 'auto' ? 'deepseek' : targetPlatform;
        console.log(`[Bridge] Automatically launching [${launchTarget}] in default browser...`);
        openBrowser(launchTarget);
        console.log(`[BridgeServer] Waiting up to 30s for browser connection...`);

        const connected = await new Promise((resolveWait) => {
          const interval = setInterval(() => {
            if (server.isBrowserConnected(targetPlatform)) {
              clearInterval(interval);
              resolveWait(true);
            }
          }, 500);
          setTimeout(() => {
            clearInterval(interval);
            resolveWait(false);
          }, 30000);
        });

        if (!connected) {
          console.error('Error: Timed out waiting for browser connection.');
          await server.stop();
          process.exitCode = 1;
          return;
        }
      }
    }

    try {
      let result;
      if (isExternalServer) {
        const handoffRes = await fetch(`http://127.0.0.1:${port}/handoff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packet: packetContent, options: { platform: targetPlatform } }),
        });
        const handoffJson = await handoffRes.json();
        if (!handoffJson.ok) {
          throw new Error(handoffJson.error || 'External server failed to process handoff');
        }
        result = handoffJson.result;
      } else {
        result = await server.executeHandoff(packetContent, { platform: targetPlatform });
      }

      if (outputPath) {
        await writeFile(outputPath, result.content, 'utf8');
        console.log(`[Success] (${result.platform_name || 'AI'}) Reasoning Result written to: ${outputPath}`);
      } else {
        console.log(result.content);
      }
    } catch (err) {
      console.error(`Handoff execution failed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      if (isTemporaryServer && server) {
        await server.stop();
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('ws-transport.mjs')) {
  main();
}
