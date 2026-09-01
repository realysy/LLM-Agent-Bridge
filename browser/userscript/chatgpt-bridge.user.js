// ==UserScript==
// @name         Universal Agent Bridge (Multi-Model Coding Matrix)
// @namespace    https://github.com/anightmonarch/codex-bridge-chatgpt
// @version      0.5.2
// @description  Universal reasoning bridge connecting AI Agents with ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, and GLM Web.
// @author       Universal Agent Community
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://chat.deepseek.com/*
// @match        https://gemini.google.com/*
// @match        https://kimi.moonshot.cn/*
// @match        https://www.kimi.com/*
// @match        https://kimi.com/*
// @match        https://grok.com/*
// @match        https://x.com/i/grok*
// @match        https://tongyi.aliyun.com/*
// @match        https://chat.qwen.ai/*
// @match        https://www.doubao.com/*
// @match        https://chatglm.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 1. Safe top-frame check
  try {
    if (window.top !== window.self) {
      return;
    }
  } catch (e) {
    return;
  }

  const BASE_HTTP = 'http://127.0.0.1:8765';
  let statusBadge = null;
  let isExecuting = false;
  let isPolling = false;

  // Platform Adapters
  const PLATFORMS = {
    chatgpt: {
      id: 'chatgpt',
      name: 'ChatGPT',
      matches: ['chatgpt.com', 'chat.openai.com'],
      input: '#prompt-textarea, div[contenteditable="true"], textarea',
      send: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
      stop: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"]',
      assistant: '[data-message-author-role="assistant"]',
      model: () => document.querySelector('button[data-testid="model-switcher-dropdown-button"], button[aria-haspopup="menu"] span')?.textContent.trim() || 'ChatGPT',
      isLogin: () => !document.querySelector('a[href*="/login"], button[data-testid="login-button"]'),
    },
    claude: {
      id: 'claude',
      name: 'Claude',
      matches: ['claude.ai'],
      input: 'div[contenteditable="true"].ProseMirror, fieldset div[contenteditable="true"], div[contenteditable="true"]',
      send: 'button[aria-label="Send Message"], button[aria-label="Send prompt"], fieldset button:has(svg)',
      stop: 'button[aria-label="Stop Response"], button[aria-label="Stop generating"]',
      assistant: '.font-claude-message, [data-is-streaming], div[data-testid="chat-message-assistant"]',
      model: () => document.querySelector('button[data-testid="model-selector-dropdown"] span, button:has(span.font-medium)')?.textContent.trim() || 'Claude 3.7 Sonnet',
      isLogin: () => !document.querySelector('a[href*="/login"], a[href*="/signup"]'),
    },
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      matches: ['chat.deepseek.com'],
      input: 'textarea#chat-input, textarea.chat-input, textarea',
      send: 'div[role="button"]:has(svg), div#chat-input-send-button, div[class*="send-button"], button:has(svg)',
      stop: 'div[role="button"]:has(svg.ds-icon-stop), div[class*="stop-button"]',
      assistant: '.ds-markdown, .ds-message-assistant, div[class*="ds-message"]:not([class*="user"])',
      model: () => document.querySelector('.ds-dropdown-value, div[class*="model-name"]')?.textContent.trim() || 'DeepSeek-V3/R1',
      isLogin: () => !document.querySelector('div[class*="login-btn"], a[href*="/login"]'),
    },
    gemini: {
      id: 'gemini',
      name: 'Gemini',
      matches: ['gemini.google.com'],
      input: 'rich-textarea > div, div[contenteditable="true"], textarea',
      send: 'button[aria-label*="Send"], button.send-button, mat-icon[data-mat-icon-name="send"]',
      stop: 'button[aria-label*="Stop"], button.stop-button',
      assistant: 'model-response, .model-response-text, message-content',
      model: () => document.querySelector('.model-pill-label, button[aria-label*="model"]')?.textContent.trim() || 'Gemini 2.0',
      isLogin: () => !document.querySelector('a[href*="accounts.google.com"]'),
    },
    kimi: {
      id: 'kimi',
      name: 'Kimi',
      matches: ['kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
      input: 'div[contenteditable="true"], div[class*="editor"], textarea',
      send: 'div[class*="send-button"], button[class*="send"], div[role="button"]:has(svg), div[class*="sendIcon"]',
      stop: 'div[class*="stop"], button[class*="stop"]',
      assistant: '.markdown___, div[class*="chat-message-assistant"], div[class*="segment-assistant"], div[class*="chat-content"], div[class*="markdown"]',
      model: () => document.querySelector('div[class*="model-switcher"] span, div[class*="tag"], div[class*="model-name"]')?.textContent.trim() || 'Kimi k1.5',
      isLogin: () => !document.querySelector('button:contains("登录"), div[class*="login"], a[href*="login"]'),
    },
    grok: {
      id: 'grok',
      name: 'Grok',
      matches: ['grok.com', 'x.com/i/grok'],
      input: 'textarea[placeholder*="Ask"], textarea, div[contenteditable="true"]',
      send: 'button[aria-label*="Grok"], button[type="submit"], button:has(svg)',
      stop: 'button[aria-label*="Stop"], button[class*="stop"]',
      assistant: 'div.response-body, div[class*="message-bubble"], div[class*="response-message"], div[dir="auto"].items-start, div[class*="prose"]',
      model: () => document.querySelector('button[aria-haspopup="menu"] span, div[class*="model"]')?.textContent.trim() || 'Grok 3 / 2',
      isLogin: () => !document.querySelector('a[href*="/login"], a[href*="/i/flow/login"]'),
    },
    qwen: {
      id: 'qwen',
      name: 'Qwen',
      matches: ['tongyi.aliyun.com', 'chat.qwen.ai'],
      input: 'textarea[placeholder*="问"], textarea#chat-textarea, div[contenteditable="true"], textarea',
      send: 'div[class*="operateBtn"] button, div[class*="send-btn"], button:has(svg)',
      stop: 'div[class*="stop-btn"], button[class*="stop"]',
      assistant: '.tongyi-ui-markdown, div[class*="contentWrapper"], div[class*="markdown"]',
      model: () => document.querySelector('div[class*="model-name"], span[class*="modelTag"]')?.textContent.trim() || 'Qwen 2.5 Max/Plus',
      isLogin: () => !document.querySelector('.login-btn, button:contains("登录")'),
    },
    doubao: {
      id: 'doubao',
      name: 'Doubao',
      matches: ['doubao.com'],
      input: 'textarea[placeholder*="输入"], textarea#flow-end-textarea, div[contenteditable="true"], textarea',
      send: 'button#flow-end-msg-send, div[class*="send-btn"], button:has(svg)',
      stop: 'button[class*="stop"], div[class*="stop-btn"]',
      assistant: 'div[data-testid="receive_message"], div[class*="message-receive"], .markdown-body',
      model: () => document.querySelector('div[class*="model-select"] span, div[class*="model-item"]')?.textContent.trim() || 'Doubao-Pro',
      isLogin: () => !document.querySelector('button:contains("登录"), div[class*="login"]'),
    },
    glm: {
      id: 'glm',
      name: 'GLM',
      matches: ['chatglm.cn', 'bigmodel.cn'],
      input: 'textarea[placeholder*="输入"], div[contenteditable="true"], textarea',
      send: 'button:has(svg), .send-btn, div[class*="enter-icon"]',
      stop: '.stop-btn, button:has(svg.stop-icon)',
      assistant: '.markdown-body, div[class*="bubble-content-assistant"], .chat-item-assistant',
      model: () => document.querySelector('div[class*="model-select"] span, div[class*="current-model"]')?.textContent.trim() || 'GLM-4',
      isLogin: () => !document.querySelector('.login-btn, button:contains("登录")'),
    },
  };

  function getCurrentPlatform() {
    const url = window.location.href;
    for (const key of Object.keys(PLATFORMS)) {
      if (PLATFORMS[key].matches.some(m => url.includes(m))) {
        return PLATFORMS[key];
      }
    }
    return PLATFORMS.kimi;
  }

  const currentPlatform = getCurrentPlatform();

  // Robust cross-environment HTTP requester
  function request(options) {
    return new Promise((resolve, reject) => {
      let gmHttp = null;
      if (typeof GM_xmlhttpRequest === 'function') {
        gmHttp = GM_xmlhttpRequest;
      } else if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
        gmHttp = GM.xmlHttpRequest;
      }

      if (gmHttp) {
        gmHttp({
          method: options.method || 'GET',
          url: options.url,
          headers: { 'Content-Type': 'application/json' },
          data: options.data ? JSON.stringify(options.data) : undefined,
          timeout: options.timeout || 30000,
          onload: (res) => {
            try {
              const data = JSON.parse(res.responseText || '{}');
              resolve(data);
            } catch (e) {
              resolve(res.responseText);
            }
          },
          onerror: (err) => {
            console.error(`[AgentBridge:${currentPlatform.name}] GM_xmlhttpRequest network error:`, err);
            reject(err);
          },
          ontimeout: () => {
            resolve({ task: null, timeout: true });
          },
        });
      } else {
        fetch(options.url, {
          method: options.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: options.data ? JSON.stringify(options.data) : undefined,
        })
          .then(r => r.json())
          .then(resolve)
          .catch(reject);
      }
    });
  }

  // 1. Create floating UI badge
  function createBadge() {
    if (document.getElementById('agent-bridge-badge')) return;
    statusBadge = document.createElement('div');
    statusBadge.id = 'agent-bridge-badge';
    Object.assign(statusBadge.style, {
      position: 'fixed',
      top: '12px',
      right: '80px',
      zIndex: '999999',
      padding: '4px 12px',
      borderRadius: '16px',
      fontSize: '12px',
      fontWeight: '600',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#fff',
      backgroundColor: '#4b5563',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      transition: 'all 0.3s ease',
      cursor: 'pointer',
      userSelect: 'none',
    });
    statusBadge.title = `Click to reconnect to local Agent Bridge (${currentPlatform.name})`;
    statusBadge.onclick = () => {
      startBridgeLoop();
    };
    document.body.appendChild(statusBadge);
  }

  function updateBadge(status, text, tooltip = '') {
    if (!statusBadge) createBadge();
    const colors = {
      connected: { bg: '#10a37f', dot: '#4ade80' },
      busy: { bg: '#d97706', dot: '#fde047' },
      error: { bg: '#dc2626', dot: '#fca5a5' },
      disconnected: { bg: '#4b5563', dot: '#9ca3af' },
    };
    const c = colors[status] || colors.disconnected;
    statusBadge.style.backgroundColor = c.bg;
    statusBadge.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.dot};"></span> ${currentPlatform.name} Bridge: ${text}`;
    if (tooltip) {
      statusBadge.title = tooltip;
    }
  }

  function getPageState() {
    return {
      platform: currentPlatform.id,
      platform_name: currentPlatform.name,
      isLogin: currentPlatform.isLogin ? currentPlatform.isLogin() : true,
      currentModel: currentPlatform.model ? currentPlatform.model() : 'Kimi',
    };
  }

  // 3. Heartbeat & Long-Poll Loop
  async function startBridgeLoop() {
    createBadge();
    if (isPolling) return;
    isPolling = true;

    console.log(`[AgentBridge] Starting ${currentPlatform.name} bridge loop...`);

    while (true) {
      try {
        const state = getPageState();

        // 1. Send Heartbeat
        await request({
          url: `${BASE_HTTP}/heartbeat`,
          method: 'POST',
          data: {
            platform: state.platform,
            platform_name: state.platform_name,
            url: window.location.href,
            logged_in: state.isLogin,
            model: state.currentModel,
          },
          timeout: 5000,
        });

        updateBadge('connected', 'Ready', `Connected as ${currentPlatform.name} Provider`);

        // 2. Long Poll for tasks
        const response = await request({
          url: `${BASE_HTTP}/poll?platform=${currentPlatform.id}`,
          method: 'GET',
          timeout: 28000,
        });

        if (response && response.task) {
          console.log(`[AgentBridge:${currentPlatform.name}] Executing task:`, response.task.request_id);
          await handleReasoningRequest(response.task.request_id, response.task.payload);
        }
      } catch (err) {
        console.warn(`[AgentBridge:${currentPlatform.name}] Loop connection error:`, err);
        updateBadge('disconnected', 'Waiting for Agent...', 'Run: npm run bridge in local agent repo');
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  }

  // 4. Inject prompt & extract result
  async function handleReasoningRequest(requestId, payload) {
    if (isExecuting) {
      await request({
        url: `${BASE_HTTP}/result`,
        method: 'POST',
        data: {
          request_id: requestId,
          type: 'REASONING_ERROR',
          payload: { error: `${currentPlatform.name} tab is already processing another reasoning request.` },
        },
      });
      return;
    }

    isExecuting = true;
    updateBadge('busy', 'Reasoning...', 'Executing agent task');

    try {
      const inputEl = document.querySelector(currentPlatform.input);

      if (!inputEl) {
        throw new Error(`Could not find ${currentPlatform.name} prompt input area.`);
      }

      // Universal Input injection
      inputEl.focus();
      if (inputEl.tagName === 'TEXTAREA') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(inputEl, payload.packet);
        } else {
          inputEl.value = payload.packet;
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, payload.packet);
      }

      await new Promise((r) => setTimeout(r, 600));

      // Click send button
      const sendBtn = document.querySelector(currentPlatform.send) || inputEl.parentElement?.querySelector('button');

      if (sendBtn) {
        sendBtn.click();
      }

      // Fallback: send Enter keydown
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

      // Wait for completion
      const resultMarkdown = await waitForCompletion();
      const state = getPageState();

      await request({
        url: `${BASE_HTTP}/result`,
        method: 'POST',
        data: {
          type: 'REASONING_RESULT',
          request_id: requestId,
          payload: {
            content: resultMarkdown,
            platform: currentPlatform.id,
            platform_name: currentPlatform.name,
            model: state.currentModel,
            timestamp: new Date().toISOString(),
          },
        },
      });

      updateBadge('connected', 'Ready', 'Task completed');
    } catch (err) {
      console.error(`[AgentBridge:${currentPlatform.name}] Execution error:`, err);
      await request({
        url: `${BASE_HTTP}/result`,
        method: 'POST',
        data: {
          type: 'REASONING_ERROR',
          request_id: requestId,
          payload: { error: err.message },
        },
      });
      updateBadge('error', 'Execution Failed', err.message);
    } finally {
      isExecuting = false;
    }
  }

  function waitForCompletion(timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let streamStableCount = 0;
      let lastTextLength = 0;

      const checkInterval = setInterval(() => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for ${currentPlatform.name} response.`));
          return;
        }

        const stopBtn = document.querySelector(currentPlatform.stop);
        const assistantMessages = document.querySelectorAll(currentPlatform.assistant);
        const latestMessage = assistantMessages[assistantMessages.length - 1];

        if (!latestMessage) return;

        const currentText = latestMessage.innerText || latestMessage.textContent;

        if (!stopBtn && currentText.length > 50) {
          if (currentText.length === lastTextLength) {
            streamStableCount++;
            if (streamStableCount >= 2) {
              clearInterval(checkInterval);
              resolve(currentText);
            }
          } else {
            streamStableCount = 0;
            lastTextLength = currentText.length;
          }
        }
      }, 800);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBridgeLoop);
  } else {
    startBridgeLoop();
  }
})();
