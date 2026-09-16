// ==UserScript==
// @name         Universal Agent Bridge (Multi-Model Coding Matrix)
// @namespace    https://github.com/realysy/LLM-Agent-Bridge
// @version      0.5.6
// @description  Universal reasoning bridge connecting AI Agents with ChatGPT, Claude, DeepSeek, Gemini, Kimi, Grok, Qwen, Doubao, and GLM Web.
// @author       Universal Agent Community, realysy
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
// @connect      10.0.2.2
// @run-at       document-idle
// @downloadURL  https://github.com/realysy/LLM-Agent-Bridge/raw/refs/heads/main/browser/userscript/chatgpt-bridge.user.js
// @updateURL    https://github.com/realysy/LLM-Agent-Bridge/raw/refs/heads/main/browser/userscript/chatgpt-bridge.user.js
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

  // Configuration: Load from LocalStorage or use default
  const DEFAULT_BASE_HTTP = 'http://127.0.0.1:8765';
  const STORAGE_KEY = 'agent_bridge_base_url';

  let BASE_HTTP = localStorage.getItem(STORAGE_KEY) || DEFAULT_BASE_HTTP;
  let statusBadge = null;
  let settingsPanel = null;
  let isExecuting = false;
  let isPolling = false;

  // Platform Adapters
  function hasButtonWithText(text) {
    try {
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = (el.textContent || '').trim();
        if (t === text || t.includes(text)) return true;
      }
    } catch (e) {
      // 忽略遍历异常，视为未找到
    }
    return false;
  }
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
      // 发送按钮：保留原逻辑，同时兼容新结构
      send: 'div.ds-button--primary button.ds-button__icon, div[class*="send"]:has(svg path[d*="M8.3125 0.980206"]), button:has(svg path[d*="M8.3125 0.980206"])',
      // 停止按钮：基于你提供的实际 HTML 结构
      // <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ...">
      //   <svg><path d="M2 4.88C2 3.68009 ..."></path></svg>
      // </div>
      stop: [
        'div[role="button"].ds-button--circle:has(svg path[d^="M2 4.88"])',
        'div[role="button"].ds-button--primary:has(svg path[d^="M2 4.88"])',
        'button.ds-button--iconLabelTertiary:has(svg path[d*="M2 4.88"])',
        'div[role="button"]:has(svg.ds-icon-stop)',
        'div[class*="stop-button"]',
      ].join(', '),
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
      isLogin: () => !document.querySelector('div[class*="login"], a[href*="login"]') && !hasButtonWithText('登录'),
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
      isLogin: () => !document.querySelector('.login-btn') && !hasButtonWithText('登录'),
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
      isLogin: () => !document.querySelector('div[class*="login"]') && !hasButtonWithText('登录'),
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
      isLogin: () => !document.querySelector('.login-btn') && !hasButtonWithText('登录'),
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

  // ---- Utility: visibility check ----
  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    if (el.getClientRects().length === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  // Find first *visible* element matching selector
  function findVisible(selector) {
    if (!selector) return null;
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (e) {
      return null;
    }
    for (const el of nodes) {
      if (isElementVisible(el)) return el;
    }
    return null;
  }

  // ---- Robust request with timeout on both GM_xmlhttpRequest and fetch ----
  function request(options) {
    return new Promise((resolve, reject) => {
      let gmHttp = null;
      if (typeof GM_xmlhttpRequest === 'function') {
        gmHttp = GM_xmlhttpRequest;
      } else if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
        gmHttp = GM.xmlHttpRequest;
      }

      const timeout = options.timeout || 30000;

      if (gmHttp) {
        gmHttp({
          method: options.method || 'GET',
          url: options.url,
          headers: { 'Content-Type': 'application/json' },
          data: options.data ? JSON.stringify(options.data) : undefined,
          timeout: timeout,
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(options.url, {
          method: options.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: options.data ? JSON.stringify(options.data) : undefined,
          signal: controller.signal,
        })
          .then(r => r.json())
          .then(resolve)
          .catch(reject)
          .finally(() => clearTimeout(timer));
      }
    });
  }

  // Safely report result/error, never let it block badge updates
  async function safeReport(body, timeoutMs = 5000) {
    try {
      await Promise.race([
        request({ url: `${BASE_HTTP}/result`, method: 'POST', data: body, timeout: timeoutMs }),
        new Promise((_, rj) => setTimeout(() => rj(new Error('report timeout')), timeoutMs + 500)),
      ]);
      return true;
    } catch (e) {
      console.warn(`[AgentBridge:${currentPlatform.name}] report failed:`, e);
      return false;
    }
  }

  // 1. Create floating UI badge with settings panel
  function createBadge() {
    if (document.getElementById('agent-bridge-badge')) return;

    const badgeContainer = document.createElement('div');
    badgeContainer.id = 'agent-bridge-badge';
    Object.assign(badgeContainer.style, {
      position: 'fixed',
      top: '12px',
      right: '80px',
      zIndex: '999999',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '4px',
    });

    statusBadge = document.createElement('div');
    Object.assign(statusBadge.style, {
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
    statusBadge.title = `Click to open settings (${currentPlatform.name})`;

    settingsPanel = document.createElement('div');
    Object.assign(settingsPanel.style, {
      display: 'none',
      padding: '10px 12px',
      borderRadius: '8px',
      fontSize: '11px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#374151',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      minWidth: '200px',
    });

    const settingsRow = document.createElement('div');
    Object.assign(settingsRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '4px',
    });

    const label = document.createElement('span');
    label.textContent = 'BASE_HTTP:';
    label.style.fontWeight = '600';
    label.style.whiteSpace = 'nowrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = BASE_HTTP;
    input.placeholder = DEFAULT_BASE_HTTP;
    Object.assign(input.style, {
      flex: '1',
      padding: '4px 8px',
      fontSize: '11px',
      border: '1px solid #d1d5db',
      borderRadius: '4px',
      outline: 'none',
    });
    input.onfocus = () => input.style.borderColor = '#4b5563';
    input.onblur = () => input.style.borderColor = '#d1d5db';
    input.onchange = () => {
      const val = input.value.trim();
      if (val) {
        BASE_HTTP = val;
        localStorage.setItem(STORAGE_KEY, val);
      }
    };

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.padding = '4px 8px';
    saveBtn.style.fontSize = '11px';
    saveBtn.style.backgroundColor = '#10a37f';
    saveBtn.style.color = '#fff';
    saveBtn.style.border = 'none';
    saveBtn.style.borderRadius = '4px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.onclick = () => {
      const val = input.value.trim();
      if (val) {
        BASE_HTTP = val;
        localStorage.setItem(STORAGE_KEY, val);
        saveBtn.textContent = 'Saved!';
        setTimeout(() => saveBtn.textContent = 'Save', 1000);
      }
    };

    settingsRow.appendChild(label);
    settingsRow.appendChild(input);
    settingsRow.appendChild(saveBtn);
    settingsPanel.appendChild(settingsRow);

    badgeContainer.appendChild(settingsPanel);
    badgeContainer.appendChild(statusBadge);
    document.body.appendChild(badgeContainer);

    statusBadge.onclick = (e) => {
      e.stopPropagation();
      const isVisible = settingsPanel.style.display === 'block';
      settingsPanel.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        input.value = BASE_HTTP;
        input.focus();
        input.select();
      }
    };

    document.addEventListener('click', (e) => {
      if (!badgeContainer.contains(e.target)) {
        settingsPanel.style.display = 'none';
      }
    });
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

  // 安全调用平台适配器方法：任何异常都不应中断 Bridge 主循环
  function safeCall(fn, fallback, label) {
    try {
      return fn();
    } catch (e) {
      console.warn(`[AgentBridge:${currentPlatform.name}] adapter ${label} failed:`, e);
      return fallback;
    }
  }

  function getPageState() {
    return {
      platform: currentPlatform.id,
      platform_name: currentPlatform.name,
      isLogin: safeCall(
        () => currentPlatform.isLogin ? currentPlatform.isLogin() : true,
        true,
        'isLogin'
      ),
      currentModel: safeCall(
        () => currentPlatform.model ? currentPlatform.model() : 'Kimi',
        'Unknown',
        'model'
      ),
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
        updateBadge('disconnected', 'Waiting for Agent...', 'Run: npm run api in local agent repo');
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  }

// 4. Inject prompt & extract result
  async function handleReasoningRequest(requestId, payload) {
    if (isExecuting) {
      await safeReport({
        request_id: requestId,
        type: 'REASONING_ERROR',
        payload: { error: `${currentPlatform.name} tab is already processing another reasoning request.` },
      });
      return;
    }

    isExecuting = true;
    updateBadge('busy', 'Reasoning...', 'Executing agent task');

    try {
      const inputEl = findVisible(currentPlatform.input) || document.querySelector(currentPlatform.input);

      if (!inputEl) {
        throw new Error(`Could not find ${currentPlatform.name} prompt input area.`);
      }

      const promptText = typeof payload.packet === 'string'
        ? payload.packet
        : (payload.packet?.content?.instruction || JSON.stringify(payload.packet));

      // ---- 发送前快照：assistant 消息数量 + 最后一条文本 ----
      const beforeSnapshot = captureAssistantSnapshot();
      console.log(`[AgentBridge:${currentPlatform.name}] Snapshot before send:`, beforeSnapshot);

      // Universal Input injection
      inputEl.focus();
      if (inputEl.tagName === 'TEXTAREA') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(inputEl, promptText);
        } else {
          inputEl.value = promptText;
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, promptText);
      }

      await new Promise((r) => setTimeout(r, 600));

      const sendBtn = findVisible(currentPlatform.send) || document.querySelector(currentPlatform.send);
      if (sendBtn) {
        sendBtn.click();
      }

      // Fallback: send Enter keydown
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

      // 记录发送时刻，供最小等待使用
      const sentAt = Date.now();

      // Wait for completion
      const resultMarkdown = await waitForCompletion({ beforeSnapshot, sentAt });
      const state = getPageState();

      updateBadge('busy', 'Reporting...', 'Sending result to agent');

      const ok = await safeReport({
        type: 'REASONING_RESULT',
        request_id: requestId,
        payload: {
          content: resultMarkdown,
          platform: currentPlatform.id,
          platform_name: currentPlatform.name,
          model: state.currentModel,
          timestamp: new Date().toISOString(),
        },
      });

      if (ok) {
        updateBadge('connected', 'Ready', 'Task completed');
      } else {
        updateBadge('error', 'Report Failed', 'Could not POST result to agent');
      }
    } catch (err) {
      console.error(`[AgentBridge:${currentPlatform.name}] Execution error:`, err);

      await safeReport({
        type: 'REASONING_ERROR',
        request_id: requestId,
        payload: { error: err.message },
      });

      updateBadge('error', 'Execution Failed', err.message);
    } finally {
      isExecuting = false;
      try {
        if (statusBadge && /Reasoning|Reporting/.test(statusBadge.textContent || '')) {
          updateBadge('connected', 'Ready', 'Task finished (fallback)');
        }
      } catch (e) { /* noop */ }
    }
  }

  // 抓取当前 assistant 消息快照
  function captureAssistantSnapshot() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(currentPlatform.assistant));
    } catch (e) {
      nodes = [];
    }
    const last = nodes[nodes.length - 1] || null;
    return {
      count: nodes.length,
      lastText: last ? (last.innerText || last.textContent || '').trim() : '',
    };
  }

  // 判定"本次回答是否已经开始"
  function hasNewResponseStarted(before) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(currentPlatform.assistant));
    } catch (e) {
      return false;
    }
    if (nodes.length === 0) return false;

    // 消息数量变多 => 新回答
    if (nodes.length > before.count) return true;

    // 最后一条文本变了 => 本次回答已经开始（秒回场景很常见）
    const last = nodes[nodes.length - 1];
    const lastText = (last.innerText || last.textContent || '').trim();
    if (lastText && lastText !== before.lastText) return true;

    return false;
  }

  // 取当前最新 assistant 消息文本
  function getLatestAssistantText() {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(currentPlatform.assistant));
    } catch (e) {
      return '';
    }
    const last = nodes[nodes.length - 1];
    if (!last) return '';
    return (last.innerText || last.textContent || '').trim();
  }

  // Wait for completion: 基于新回答 diff + 可见停止按钮 + 文本稳定 + 最小等待时间
  function waitForCompletion({ beforeSnapshot, sentAt, timeoutMs = 300000 } = {}) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const minGenerationMs = 1500;      // 至少等 1.5s，避免秒回还没渲染完就判定稳定
      const requiredStableChecks = 4;    // 连续 4 次（800ms * 4 ≈ 3.2s）文本不变才算完成
      const noStopGraceMs = 2500;        // 若从没见过停止按钮，至少等 2.5s 再考虑"无停止"完成

      let streamStableCount = 0;
      let lastText = '';
      let hadVisibleStopButton = false;
      let responseStarted = false;
      let responseStartedAt = 0;

      const checkInterval = setInterval(() => {
        const now = Date.now();

        if (now - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for ${currentPlatform.name} response.`));
          return;
        }

        // 1) 是否已经开始新回答
        if (!responseStarted) {
          if (hasNewResponseStarted(beforeSnapshot)) {
            responseStarted = true;
            responseStartedAt = now;
            lastText = getLatestAssistantText();
            console.log(`[AgentBridge:${currentPlatform.name}] Response started. initial text length: ${lastText.length}`);
          }
          return; // 还没开始就继续等
        }

        // 2) 最小等待时间，避免秒回被过早判定
        if (now - responseStartedAt < minGenerationMs) return;

        // 3) 可见停止按钮检测
        const stopBtn = findVisible(currentPlatform.stop);
        if (stopBtn) {
          hadVisibleStopButton = true;
          // 生成中：文本仍在变，重置稳定计数
          const cur = getLatestAssistantText();
          if (cur.length !== lastText.length) {
            lastText = cur;
          }
          streamStableCount = 0;
          return;
        }

        // 4) 无可见停止按钮
        const currentText = getLatestAssistantText();

        // 没有文本，继续等
        if (!currentText) return;

        // 如果从没见过停止按钮，至少要等 noStopGraceMs 才允许判定（防止误判）
        if (!hadVisibleStopButton && now - responseStartedAt < noStopGraceMs) {
          lastText = currentText;
          return;
        }

        // 5) 文本稳定性判定
        if (currentText.length === lastText.length && currentText === lastText) {
          streamStableCount++;
          console.log(`[AgentBridge:${currentPlatform.name}] Stable check ${streamStableCount}/${requiredStableChecks}, len=${currentText.length}`);
          if (streamStableCount >= requiredStableChecks) {
            clearInterval(checkInterval);
            console.log(`[AgentBridge:${currentPlatform.name}] Completion detected.`);
            resolve(currentText);
          }
        } else {
          streamStableCount = 0;
          lastText = currentText;
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