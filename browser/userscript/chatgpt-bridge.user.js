// ==UserScript==
// @name         Universal Agent Bridge (Multi-Model Coding Matrix)
// @namespace    https://github.com/realysy/LLM-Agent-Bridge
// @version      0.7.0
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
// @downloadURL  https://raw.githubusercontent.com/realysy/LLM-Agent-Bridge/main/browser/userscript/chatgpt-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/realysy/LLM-Agent-Bridge/main/browser/userscript/chatgpt-bridge.user.js
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
  let badgeContainer = null;
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
      // 发送按钮：ds-button--primary 圆形图标按钮，内含向上箭头 svg（path d 以 "M8.3125" 开头）
      // 输入框为空时同一元素会额外带 ds-button--disabled / 无 tabindex，必须排除，
      // 否则会点到灰色按钮导致 click 无效。
      send: [
        'div[role="button"].ds-button--primary:not(.ds-button--disabled):has(svg path[d^="M8.3125"])',
        'div[role="button"].ds-button--primary:not(.ds-button--disabled):has(svg path[d*="M8.3125 0.980206"])',
      ].join(', '),
      // 停止按钮：同一位置但 svg path 换成方形（d 以 "M2 4.88" 开头）。
      // 用 :has() 精确匹配 path 前缀，避免和发送按钮混淆。
      stop: [
        'div[role="button"].ds-button--primary:has(svg path[d^="M2 4.88"])',
        'div[role="button"].ds-button--circle:has(svg path[d^="M2 4.88"])',
      ].join(', '),
      assistant: '.ds-markdown, .ds-message-assistant, div[class*="ds-message"]:not([class*="user"])',
      model: () => document.querySelector('.ds-dropdown-value, div[class*="model-name"]')?.textContent.trim() || 'DeepSeek-V3/R1',
      isLogin: () => !document.querySelector('div[class*="login-btn"], a[href*="/login"]'),
      // Markdown 内容根容器。
      //
      // 不能用 '.ds-markdown'：DeepSeek 的思考容器 .ds-think-content 里
      // 也有 .ds-markdown，querySelector 会匹配到两个。正式回答的那个带
      // .ds-assistant-message-main-content 类，用这个精确匹配。
      markdownRoot: '.ds-assistant-message-main-content',
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
      input: 'textarea#chat-textarea, textarea[placeholder*="问"], div[contenteditable="true"], textarea',
      // 发送按钮：button.send-button，禁用态会带 disabled 属性 + disabled class，
      // 必须排除，否则空输入时命中灰色按钮，click 无效。
      send: 'button.send-button:not([disabled]):not(.disabled)',
      // 停止按钮：button.stop-button（带 aria-label="停止"）
      stop: 'button.stop-button',
      // 整条 assistant 消息的顶层容器。
      // 不能用 '.qwen-markdown' / 'div[class*="markdown"]' 这类选择器：
      // .qwen-markdown 内部有大量嵌套的子 div（.qwen-markdown-paragraph、
      // .qwen-markdown-space、.qwen-markdown-code-body 等）也匹配 class*="markdown"，
      // 而 querySelectorAll 返回文档顺序，取最后一个只能拿到最深层的某个子节点，
      // 会把整个回答截断成最后几行。.qwen-chat-message-assistant 是最外层容器，
      // 一次回答对应一个，内部多个 .response-message-content 片段都会包含进来。
      assistant: '.qwen-chat-message-assistant',
      model: () => document.querySelector('div[class*="model-name"], span[class*="modelTag"]')?.textContent.trim() || 'Qwen 2.5 Max/Plus',
      isLogin: () => !document.querySelector('.login-btn') && !hasButtonWithText('登录'),
      // Markdown 内容根容器：其直接子元素是流式推送的"顶层块"。
      markdownRoot: '.qwen-markdown',
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

  // ==========================================================================
  // Block 去重：网页对话本身保存历史，客户端每轮重发的 system / context / tools
  // 不必重复注入。服务端把 messages 拆成带 kind 的 blocks，浏览器端按内容哈希
  // 决定是否跳过。
  //
  // 状态只存在于当前页面内存，网页刷新即重置（符合"刷新=重新开始"的直觉）。
  // 会话重置（URL 变化 / assistant 消息归零）时也会清空。
  // ==========================================================================

  // 当前对话已发送过的 block 哈希集合
  const sentHashes = new Set();

  // 会话重置标志：用户切走或关闭当前网页对话后置为 true，由下一次
  // buildPromptFromPayload 消费。为 true 时该请求里所有 kind='context'
  // 的 block 直接跳过（并记入 sentHashes），因为用户重置网页对话的意图
  // 就是清空上下文，不该把客户端侧的历史补回去。
  let contextResetPending = false;

  /**
   * FNV-1a 32-bit 哈希，无外部依赖，同步执行。
   * 用于比较 block 内容是否已在当前网页对话里发送过。
   */
  function fnv1aHash(text, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * 对 block 内容计算 16 位十六进制哈希。用两个不同种子拼接，降低碰撞概率。
   *
   * 只哈希 content、不哈希 kind：同一段文字在不同轮次里可能从 `turn` 降级为
   * `context`（历史消息），kind 变化不应该影响去重结果。如果拼上 kind，第一轮
   * 发过的 `turn` 内容在第二轮变成 `context` 时哈希不同，会被重复发送。
   */
  function hashBlock(content) {
    return fnv1aHash(content, 0x811c9dc5) + fnv1aHash(content, 0x9e3779b9);
  }

  /**
   * 把单个 block 渲染成注入网页的文本片段。保留角色前缀，便于网页模型理解结构。
   */
  function renderBlock(kind, content) {
    switch (kind) {
      case 'system':  return `SYSTEM: ${content}`;
      // 工具定义用 JSON code block 包裹：模型侧普遍有 markdown 解析器，
      // 裸 JSON 一行塞进去容易被当成普通文本忽略；代码块能明确标记
      // "这是一份 JSON 数据"。
      case 'tools':   return `TOOLS:\n\n\`\`\`json\n${content}\n\`\`\``;
      case 'tool_protocol': return content;
      case 'tool_result':   return content;
      case 'context': return `CONTEXT: ${content}`;
      case 'turn':    return `USER: ${content}`;
      default:        return content;
    }
  }

  // 会话状态监视器只启动一次
  let sessionWatchStarted = false;
  let lastConversationToken = undefined;

  /**
   * 从 URL 中提取会话标识：取路径中最后一段长度 >= 8 且字符集为
   * [A-Za-z0-9_-] 的片段。命中则返回该片段，否则返回 null。
   *
   * 各大平台的实际形态：
   *   DeepSeek : https://chat.deepseek.com/a/chat/s/{token}
   *   ChatGPT  : https://chatgpt.com/c/{token}
   *   Qwen     : https://chat.qwen.ai/c/{token}
   *
   * 首页 / 新对话页面（如 https://chat.deepseek.com/）没有这段，返回 null。
   * 不是完美解析，但足以区分"具体的某个会话"和"还没有会话"。
   */
  function extractConversationToken(url) {
    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (/^[A-Za-z0-9_-]{8,}$/.test(segments[i])) return segments[i];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 监视网页会话是否发生重置。
   *
   * 只跟踪 URL 里的"会话标识"变化，而不是 URL 的任何变化。原因是：
   *
   *   在平台上新建会话时，URL 会经历两段变化：
   *     /(无 token) → /a/chat/s/{token}   ← 用户发了第一条消息后被分配 ID
   *     /a/chat/s/{token} → /             ← 用户点了"新对话"
   *
   *   第一段变化不是会话重置（对话内容还在，只是被分配了 ID），第二段才是。
   *   如果无脑按 URL 变化清空哈希集合，就会在用户发完第一条消息后立刻清空，
   *   导致下一轮请求把 system / context 又重发一遍（Cherry Studio 多轮测试中
   *   观察到的 log2 现象）。
   *
   * 清空条件：之前 URL 里有一个会话 token，且现在 token 变了或消失了。
   * "从无 token 到有 token"（新会话的第一条消息）不清空。
   *
   * 用 2 秒轮询而非 MutationObserver：URL 变化在 SPA 里通过 history.pushState
   * 完成，不触发任何 DOM 事件，轮询更简单可靠，代价可忽略。
   */
  function startSessionWatch() {
    if (sessionWatchStarted) return;
    sessionWatchStarted = true;
    lastConversationToken = extractConversationToken(window.location.href);

    setInterval(() => {
      const token = extractConversationToken(window.location.href);
      if (token === lastConversationToken) return;

      const wasInConversation = lastConversationToken !== null;
      const previousToken = lastConversationToken;
      lastConversationToken = token;

      // 只有"从某个会话切走"才视为重置；新会话的第一条消息不重置
      if (!wasInConversation) return;

      if (sentHashes.size > 0) {
        console.log(
          `[AgentBridge:${currentPlatform.name}] Conversation changed ` +
          `(${previousToken} -> ${token}), clearing ${sentHashes.size} block hashes`
        );
      }
      sentHashes.clear();
      // 标记下一次请求：丢弃所有 context，只发 system / tools / turn
      contextResetPending = true;
    }, 2000);
  }

  /**
   * 检测 GM_xmlhttpRequest 的错误是否来自 userscript @connect 列表拦截。
   * Tampermonkey 不同版本把拦截信息放在 err.error / err.message 里，
   * 关键词稳定为 "connect list" / "Refused to connect"。
   */
  function isConnectBlockedError(err) {
    const text = String(err?.error || err?.message || err?.statusText || err || '');
    return /connect list|Refused to connect/i.test(text);
  }

  // 节流：心跳循环每 4 秒重试一次，避免每次都弹
  let connectBlockedNoticeShownAt = 0;
  const CONNECT_BLOCKED_NOTICE_INTERVAL_MS = 60000;

  /**
   * 弹出一个 15 秒后自动消失的 toast，告知用户目标主机被 @connect 列表拦截，
   * 并给出可操作的修复方式。60 秒内最多触发一次。
   */
  function showConnectBlockedNotice(targetHost) {
    const now = Date.now();
    if (now - connectBlockedNoticeShownAt < CONNECT_BLOCKED_NOTICE_INTERVAL_MS) return;
    connectBlockedNoticeShownAt = now;

    // 已存在同 id 的 toast 先移除，避免堆叠
    const existing = document.getElementById('agent-bridge-connect-notice');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'agent-bridge-connect-notice';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '60px',
      right: '80px',
      zIndex: '1000000',
      padding: '10px 26px 10px 14px',
      borderRadius: '8px',
      background: '#dc2626',
      color: '#fff',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '12px',
      lineHeight: '1.55',
      maxWidth: '340px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    });

    const codeStyle = 'background:rgba(255,255,255,0.18);padding:1px 4px;border-radius:3px;';

    const title = document.createElement('div');
    title.textContent = 'Bridge 被 @connect 列表拦截';
    title.style.fontWeight = '600';
    title.style.marginBottom = '4px';

    const body = document.createElement('div');
    body.innerHTML =
      `目标主机 <code style="${codeStyle}">${targetHost}</code> 不在 userscript 的 ` +
      `<code style="${codeStyle}">@connect</code> 列表中，无法连接 Bridge。`;

    const hint = document.createElement('div');
    hint.style.marginTop = '6px';
    hint.style.opacity = '0.92';
    hint.innerHTML =
      `改用 <code style="${codeStyle}">127.0.0.1</code> 或 ` +
      `<code style="${codeStyle}">localhost</code>，或在脚本头加入 ` +
      `<code style="${codeStyle}">// @connect ${targetHost}</code> / ` +
      `<code style="${codeStyle}">// @connect *</code>。`;

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '4px',
      right: '8px',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      opacity: '0.85',
      userSelect: 'none',
    });
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(closeBtn);
    toast.appendChild(title);
    toast.appendChild(body);
    toast.appendChild(hint);
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, 15000);
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
            if (isConnectBlockedError(err)) {
              try {
                const host = new URL(options.url).host;
                showConnectBlockedNotice(host);
              } catch { /* URL 解析失败时静默 */ }
            }
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

  // 当前 badge 位置（比例），供窗口尺寸变化时重新映射到新视口。
  // null 表示尚未定位，使用默认右上角。
  let badgePosition = null;

  // 应用 badgePosition 到当前视口尺寸；若尚未有值，保持默认右上角。
  function applyBadgePosition() {
    if (!badgeContainer) return;
    if (!badgePosition) return;
    const width = badgeContainer.offsetWidth;
    const height = badgeContainer.offsetHeight;
    // 面板展开时的高度可能远大于 badge 本体，用 badge 本体尺寸做 clamp 基准，
    // 面板是否出界由 clampPanelDirection 单独处理。
    const maxX = Math.max(1, window.innerWidth - width);
    const maxY = Math.max(1, window.innerHeight - height);
    const left = clamp(badgePosition.x * maxX, 0, maxX);
    const top = clamp(badgePosition.y * maxY, 0, maxY);
    badgeContainer.style.left = `${left}px`;
    badgeContainer.style.top = `${top}px`;
    badgeContainer.style.right = 'auto';
  }

  /**
   * 让设置面板始终留在视口内，且不影响 badge 位置：
   * - 水平：默认与 badge 左对齐（left: 0）；若右边缘会超出视口，整体向左平移
   *         （给 left 一个负偏移），最左不超过视口左边距。
   * - 垂直：默认从 badge 下方展开；若下边缘会超出视口，用负 marginTop 向上顶，
   *         最上不超过视口上边距。
   * - 尺寸：面板宽/高超过视口时用 maxWidth / maxHeight 限制，内容可滚动。
   * 面板是 badgeContainer 的 absolute 子元素，本身不参与容器布局，
   * 所以本函数不会移动 badge。
   * @returns 
   */
  function clampPanelPosition() {
    if (!badgeContainer || !settingsPanel) return;
    if (settingsPanel.style.display === 'none') return;

    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 复位到初始态，得到"未 clamp"时的自然位置与尺寸
    settingsPanel.style.left = '0';
    settingsPanel.style.marginTop = '0';
    settingsPanel.style.maxWidth = '';
    settingsPanel.style.maxHeight = '';
    settingsPanel.style.overflowY = '';

    // 尺寸先 clamp，避免后面的偏移量基于过大的尺寸计算
    let rect = settingsPanel.getBoundingClientRect();
    if (rect.width > vw - margin * 2) {
      settingsPanel.style.maxWidth = `${vw - margin * 2}px`;
      rect = settingsPanel.getBoundingClientRect();
    }
    if (rect.height > vh - margin * 2) {
      settingsPanel.style.maxHeight = `${vh - margin * 2}px`;
      settingsPanel.style.overflowY = 'auto';
      rect = settingsPanel.getBoundingClientRect();
    }

    // ---- 水平：默认与 badge 左对齐；右侧溢出则整体左移 ----
    let offsetLeft = 0;
    const overflowRight = rect.right - (vw - margin);
    if (overflowRight > 0) offsetLeft -= overflowRight;
    // 左边缘也不能越过视口左边距
    const minOffsetLeft = margin - rect.left;
    if (offsetLeft < minOffsetLeft) offsetLeft = minOffsetLeft;
    settingsPanel.style.left = `${offsetLeft}px`;

    // ---- 垂直：默认从 badge 下方展开；底部溢出则向上顶 ----
    let offsetTop = 0;
    const overflowBottom = rect.bottom - (vh - margin);
    if (overflowBottom > 0) offsetTop -= overflowBottom;
    // 上边缘也不能越过视口上边距
    const minOffsetTop = margin - rect.top;
    if (offsetTop < minOffsetTop) offsetTop = minOffsetTop;
    settingsPanel.style.marginTop = `${offsetTop}px`;
  }

  // 1. Create floating UI badge with settings panel
  function createBadge() {
    if (document.getElementById('agent-bridge-badge')) return;

    badgeContainer = document.createElement('div');
    badgeContainer.id = 'agent-bridge-badge';
    // 容器定位在右上角，badge 固定在首行，设置面板显示时向下展开，
    // 因此容器的 top 值始终保持不变，badge 视觉位置不受面板显隐影响。
    Object.assign(badgeContainer.style, {
      position: 'fixed',
      top: '12px',
      right: '80px',
      zIndex: '999999',
      // 容器只承载 badge；设置面板改用 absolute 定位，不再参与流式布局，
      // 因此容器尺寸固定为 badge 尺寸，面板展开/收起不会移动 badge。
      display: 'block',
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
      cursor: 'grab',
      userSelect: 'none',
      touchAction: 'none',
      whiteSpace: 'nowrap',
    });
    statusBadge.title = `Click to open settings (${currentPlatform.name})`;

    settingsPanel = document.createElement('div');
    Object.assign(settingsPanel.style, {
      display: 'none',
      // 相对 badgeContainer 绝对定位：默认与 badge 左对齐（left: 0），
      // 从 badge 底部下方 4px 处向下展开。右侧溢出时由 clampPanelPosition
      // 直接把 left 调成负值向左平移。
      position: 'absolute',
      top: 'calc(100% + 4px)',
      left: '0',
      padding: '10px 12px',
      borderRadius: '8px',
      fontSize: '11px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#374151',
      backgroundColor: '#f9fafb',
      border: '1px solid #e5e7eb',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      minWidth: '220px',
      zIndex: '1',
    });

    // ---- 配置行容器：将来新增配置项时，往这里 append 新的 row 即可 ----
    const settingsRows = document.createElement('div');
    Object.assign(settingsRows.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });

    // ---- 第 1 行：BASE_HTTP ----
    const settingsRow = document.createElement('div');
    Object.assign(settingsRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
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
      minWidth: '0',
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

    settingsRow.appendChild(label);
    settingsRow.appendChild(input);
    settingsRows.appendChild(settingsRow);

    // ---- 操作区：Save 按钮独立于配置行，始终位于所有配置项下方 ----
    const settingsActions = document.createElement('div');
    Object.assign(settingsActions.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: '10px',
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.padding = '4px 12px';
    saveBtn.style.fontSize = '11px';
    saveBtn.style.backgroundColor = '#10a37f';
    saveBtn.style.color = '#fff';
    saveBtn.style.border = 'none';
    saveBtn.style.borderRadius = '4px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.onclick = () => {
      // 集中收集所有配置项并持久化。
      // 将来新增配置项时，只需在下面补充对应的收集/写回逻辑。
      const val = input.value.trim();
      if (val) {
        BASE_HTTP = val;
        localStorage.setItem(STORAGE_KEY, val);
      }
      saveBtn.textContent = 'Saved!';
      setTimeout(() => saveBtn.textContent = 'Save', 1000);
    };
    settingsActions.appendChild(saveBtn);

    settingsPanel.appendChild(settingsRows);
    settingsPanel.appendChild(settingsActions);

    // 关键顺序：statusBadge 先 append，settingsPanel 后 append，
    // 使 badge 始终固定在容器首行，设置面板向下展开而不顶开 badge。
    badgeContainer.appendChild(statusBadge);
    badgeContainer.appendChild(settingsPanel);
    document.body.appendChild(badgeContainer);

    statusBadge.onclick = (e) => {
      e.stopPropagation();
      const isVisible = settingsPanel.style.display === 'block';
      settingsPanel.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) {
        input.value = BASE_HTTP;
        input.focus();
        input.select();
        // 面板显示后立即调整方向与位置；再在下一帧补一次，等布局稳定
        clampPanelPosition();
        requestAnimationFrame(clampPanelPosition);
      }
    };

    document.addEventListener('click', (e) => {
      if (!badgeContainer.contains(e.target)) {
        settingsPanel.style.display = 'none';
      }
    });

    // ---- 拖动 badge 改变位置；仅在超过阈值的水平/垂直位移后才视为拖动 ----
    // 位置以视口比例（0~1）存入 localStorage，跨分辨率时不会落到屏幕外。
    (function enableDrag() {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      const onPointerDown = (e) => {
        // 只响应主键/触摸，左键拖拽；点在面板内部的输入控件上时不触发拖动
        if (e.button !== undefined && e.button !== 0) return;
        if (settingsPanel && settingsPanel.contains(e.target)) return;
        if (e.target.closest && e.target.closest('input, textarea, button')) return;

        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = badgeContainer.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        // 拖动前先清掉过渡，避免跟手
        badgeContainer.style.transition = 'none';
        badgeContainer.style.userSelect = 'none';

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      };

      const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        moved = true;

        const width = badgeContainer.offsetWidth;
        const height = badgeContainer.offsetHeight;
        const left = clamp(startLeft + dx, 0, window.innerWidth - width);
        const top = clamp(startTop + dy, 0, window.innerHeight - height);

        badgeContainer.style.left = `${left}px`;
        badgeContainer.style.top = `${top}px`;
        badgeContainer.style.right = 'auto';
      };

      const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);

        badgeContainer.style.userSelect = '';
        badgeContainer.style.transition = 'all 0.3s ease';

        if (moved) {
          const rect = badgeContainer.getBoundingClientRect();
          const maxX = Math.max(1, window.innerWidth - rect.width);
          const maxY = Math.max(1, window.innerHeight - rect.height);
          badgePosition = { x: rect.left / maxX, y: rect.top / maxY };
          saveBadgePosition(badgePosition.x, badgePosition.y);
          badgeContainer.dataset.justDragged = '1';
          setTimeout(() => delete badgeContainer.dataset.justDragged, 0);
          // 若面板正开着，按新位置重新 clamp
          clampPanelPosition();
        }
      };

      statusBadge.addEventListener('pointerdown', onPointerDown);
    })();

    // 窗口尺寸变化时，按新视口重新映射比例位置；同时重新 clamp 面板方向
    window.addEventListener('resize', () => {
      applyBadgePosition();
      requestAnimationFrame(() => {
        applyBadgePosition();
        clampPanelPosition();
      });
    });

    // badge 自身尺寸变化（例如窄屏省略平台名前缀）也要重新 clamp
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        applyBadgePosition();
        clampPanelPosition();
      });
      ro.observe(badgeContainer);
    }

    // 应用已保存的位置；没有保存过则保持默认（右上角）
    requestAnimationFrame(() => {
      badgePosition = loadBadgePosition();
      if (badgePosition) {
        applyBadgePosition();
      }
    });

    // 拖动刚结束的那一次 click 不触发展开面板
    statusBadge.addEventListener('click', (e) => {
      if (badgeContainer.dataset.justDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  // 窄屏阈值：窗口宽度小于该值时，精简 badge
  const NARROW_VIEWPORT_PX = 640;
  // 缓存最近一次渲染入参，供窗口尺寸变化时按新宽度重新渲染。
  let lastBadgeRender = null;
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
    // 窄屏时省略平台名前缀，只保留状态文案，避免 badge 过长挤压页面
    const label = window.innerWidth < NARROW_VIEWPORT_PX
      ? text
      : `${currentPlatform.name} Bridge: ${text}`;
    statusBadge.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.dot};"></span> ${label}`;
    if (tooltip) {
      statusBadge.title = tooltip;
    }
    lastBadgeRender = { status, text, tooltip };
  }

  // 窗口尺寸变化时按新宽度重新渲染 badge（只影响文案，不影响 badge 位置）
  window.addEventListener('resize', () => {
    if (lastBadgeRender) {
      updateBadge(lastBadgeRender.status, lastBadgeRender.text, lastBadgeRender.tooltip);
    }
  });

  // Badge 拖动后的自定义位置（百分比，相对视口左上角；null 表示用默认右上角）
  const BADGE_POSITION_KEY = 'agent_bridge_badge_position';
  const DRAG_THRESHOLD_PX = 4;  // 超过此位移才算拖动，避免误伤点击展开面板

  function loadBadgePosition() {
    try {
      const raw = localStorage.getItem(BADGE_POSITION_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (typeof pos?.x !== 'number' || typeof pos?.y !== 'number') return null;
      // 数值是 0~1 的比例，避免分辨率变化后落到屏幕外
      if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) return null;
      return pos;
    } catch (e) {
      return null;
    }
  }

  function saveBadgePosition(xRatio, yRatio) {
    try {
      localStorage.setItem(
        BADGE_POSITION_KEY,
        JSON.stringify({ x: xRatio, y: yRatio })
      );
    } catch (e) {
      /* 存储失败不影响使用 */
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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

  /**
   * 从 payload 构造最终注入网页输入框的文本。
   *
   * 优先使用 payload.blocks（服务端拆好的结构化 blocks）：
   *   - system / tools / context 按内容哈希去重，命中则跳过
   *   - turn 永远发送
   * 去重后的 hash 会加入 sentHashes，下一次请求可直接跳过。
   *
   * 若 payload.blocks 不存在（如 ws-transport.mjs send 直发 raw packet），
   * 则退回 payload.packet 路径，不做去重，行为与旧版一致。
   */
  function buildPromptFromPayload(payload) {
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : null;

    if (blocks && blocks.length > 0) {
      const wasResetPending = contextResetPending;

      // 会话重置：清空 sentHashes，让 system / tools / tool_protocol
      // 也从头发送。新网页对话里什么都没有，这些静态信息必须重发，
      // 否则新对话的模型完全没有工具定义和系统提示。
      if (wasResetPending) {
        sentHashes.clear();
      }

      const parts = [];
      let skipped = 0;
      let droppedByReset = 0;

      for (const block of blocks) {
        const kind = String(block?.kind || 'user');
        const content = String(block?.content || '');
        if (!content) continue;

        const hash = hashBlock(content);

        // ① alwaysSend（workspace_info 等）：每轮都发。
        //    优先级最高，绕过 sentHashes 和 contextResetPending。
        //    不这样做的话，模型在第 2 轮之后会丢失工作区路径，
        //    开始从 system prompt 里的零碎路径瞎拼假路径。
        if (block?.alwaysSend) {
          parts.push(renderBlock(kind, content));
          sentHashes.add(hash);
          continue;
        }

        // ② 会话刚重置：丢弃客户端侧的历史 context（模拟新会话）。
        //    注意 alwaysSend 的 workspace_info 已经在 ① 里处理过了，
        //    不会被这一段丢弃 —— 新会话反而更需要它。
        if (wasResetPending && kind === 'context') {
          sentHashes.add(hash);
          skipped += 1;
          droppedByReset += 1;
          continue;
        }

        // ③ 普通去重：system / tools / tool_protocol / context / tool_result
        //    - system / tools / tool_protocol 静态内容，只发一次
        //    - 历史 context（网页对话已保存）只发一次
        //    - 历史 tool_result（网页对话已保存）只发一次
        //    - turn 永远发送（本次新问题）
        const dedupable = kind === 'system' || kind === 'tools' || kind === 'tool_protocol'
          || kind === 'context' || kind === 'tool_result';
        if (dedupable && sentHashes.has(hash)) {
          skipped += 1;
          continue;
        }

        parts.push(renderBlock(kind, content));
        sentHashes.add(hash);
      }

      contextResetPending = false;

      if (wasResetPending) {
        console.log(
          `[AgentBridge:${currentPlatform.name}] Session reset: cleared sentHashes, dropped ${droppedByReset} historical context block(s)`
        );
      }
      if (skipped > 0) {
        console.log(
          `[AgentBridge:${currentPlatform.name}] Deduplicated ${skipped}/${blocks.length} blocks`
        );
      }

      if (parts.length === 0) {
        throw new Error('All blocks were deduplicated; nothing left to send.');
      }

      return parts.join('\n\n');
    }

    // 兼容路径：raw packet
    return typeof payload?.packet === 'string'
      ? payload.packet
      : (payload?.packet?.content?.instruction || JSON.stringify(payload.packet));
  }

  /**
   * 去掉孤立的 UTF-16 surrogate 码元（高代理后没有低代理、或低代理前
   * 没有高代理）。正常的字符（包括中文、emoji）不会受影响。
   *
   * 这是防御性措施：如果采集或处理过程中意外产生了孤立 surrogate，
   * 编码为 UTF-8 时会被替换成 U+FFFD（），进而在客户端渲染成乱码。
   */
  function sanitizeSurrogates(text) {
    if (!text) return text;
    return text
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }

  /**
   * 流式上报器：在网页流式生成过程中，每 500ms 采集一次当前的 Markdown
   * 并通过 /stream 端点推给 server，让 SSE 客户端能实时看到内容。
   *
   * 采集内容用 domToMarkdown，保证和最终 /result 的格式一致。
   *
   * 避免回退：浏览器只负责"上报当前文本"，前缀不匹配的去重由 server 处理。
   * 本函数只要保证"文本有变化才上报"即可。
   */
  function startStreamReporter(requestId, beforeSnapshot) {
    let lastReportedText = '';
    let stopped = false;
    let inflight = false;

    const timer = setInterval(async () => {
      if (stopped || inflight) return;

      // 只在"本次回答已开始"后才上报，避免把上一条回答的文本推出去
      let started = false;
      try {
        started = hasNewResponseStarted(beforeSnapshot);
      } catch { /* 选择器异常视为未开始 */ }
      if (!started) return;

      let text = '';
      try {
        text = getLatestAssistantText({ isFinal: false });
      } catch { /* 采集失败时跳过本轮 */ }
      text = sanitizeSurrogates(text);
      if (!text || text === lastReportedText) return;

      inflight = true;
      try {
        await request({
          url: `${BASE_HTTP}/stream`,
          method: 'POST',
          data: { request_id: requestId, text, done: false },
          timeout: 3000,
        });
        // 仅在成功后更新：失败时保留旧值，下一次采样还会重试推送同样的内容
        lastReportedText = text;
      } catch (e) {
        // 流式上报失败不阻断主流程，静默重试
        console.warn(`[AgentBridge:${currentPlatform.name}] stream report failed:`, e);
      } finally {
        inflight = false;
      }
    }, 500);

    return {
      /**
       * 收尾：停止轮询并发送 done=true 的最终帧。
       * 若 finalText 为空，用当前页面文本兜底。
       */
      async stop(finalText) {
        stopped = true;
        clearInterval(timer);
        let text = finalText;
        if (!text) {
          try {
            // 回退路径也用 isFinal=true，保证末尾代码块/表格不被跳过
            text = getLatestAssistantText({ isFinal: true }) || lastReportedText;
          } catch {
            text = lastReportedText;
          }
        }
        text = sanitizeSurrogates(text);
        try {
          await request({
            url: `${BASE_HTTP}/stream`,
            method: 'POST',
            data: { request_id: requestId, text, done: true },
            timeout: 5000,
          });
        } catch (e) {
          console.warn(`[AgentBridge:${currentPlatform.name}] stream final report failed:`, e);
        }
      },
    };
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

      // 首次执行时启动会话状态监视器（幂等）
      startSessionWatch();

      const promptText = buildPromptFromPayload(payload);

      // 清空上一轮遗留的块状态：本次回答的所有块都是新内容，不需要继承上一轮的稳定计时。
      topLevelBlockState.clear();

      // ---- 判断本轮是否为工具调用场景 ----
      // 工具调用场景下不做流式上报：模型在流式期间会交错输出叙述和
      // tool_call，中间态里 tool_call 常被截断/损坏，且用户真正关心的是
      // 完整的工具调用结果而非过程。等网页完成一次性 /result 上报即可。
      const hasTools = Array.isArray(payload?.blocks) &&
        payload.blocks.some(b => b?.kind === 'tools');
      
      // ---- 发送前快照 ----
      const beforeSnapshot = captureAssistantSnapshot();
      
      // 只有非工具调用场景才启动流式上报
      const streamReporter = hasTools
        ? { stop: async () => {} }   // 空实现
        : startStreamReporter(requestId, beforeSnapshot);

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

      // 现代框架（React/Vue）在 input 事件后会异步把内容同步回受控组件，
      // 给一帧时间即可；用最短 120ms + 最多 600ms 的轮询代替固定 600ms 硬等。
      // 新选择器已排除 disabled 态，只要 findVisible 命中即视为按钮就绪。
      await new Promise((resolve) => {
        const started = Date.now();
        const minWait = 120;
        const maxWait = 600;
        const step = 60;
        const tick = () => {
          const elapsed = Date.now() - started;
          const ready = !!findVisible(currentPlatform.send);
          if (elapsed >= minWait && (ready || elapsed >= maxWait)) {
            resolve();
            return;
          }
          setTimeout(tick, step);
        };
        tick();
      });

      /**
       * 发送策略：优先 click 发送按钮，避免与 Enter fallback 同时触发。
       *
       * 早期版本会"既 click 又 dispatch Enter"，导致 DeepSeek 这类平台
       * 在已有对话中把同一条消息发两次：click 已经触发发送，React 异步
       * 清空输入框需要时间，此时 Enter 事件到达时 value 尚未清空，于是
       * 被再次识别为一次发送。
       *
       * 现在改为：
       *   1) 有发送按钮 → click 它，然后等输入框被清空（最长 250ms）。
       *      被清空 => 发送已被接受，不再走 Enter。
       *   2) 没按钮 / click 后输入框始终未清空 → 退回 Enter keydown 兜底。
       */
      const sendBtn = findVisible(currentPlatform.send) || document.querySelector(currentPlatform.send);
      let sent = false;

      const readInputText = () =>
        (inputEl.value !== undefined ? inputEl.value : inputEl.textContent || '').trim();

      if (sendBtn) {
        try {
          sendBtn.click();
          const started = Date.now();
          while (Date.now() - started < 250) {
            if (!readInputText()) { sent = true; break; }
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch (e) {
          console.warn(`[AgentBridge:${currentPlatform.name}] send button click failed:`, e);
        }
      }

      // 仅在"没有发送按钮"或"click 后输入框未被清空"时，才退回 Enter。
      if (!sent) {
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      // 记录发送时刻，供最小等待使用
      const sentAt = Date.now();

      // Wait for completion
      let resultMarkdown;
      try {
        resultMarkdown = await waitForCompletion({ beforeSnapshot, sentAt });
      } catch (err) {
        // 超时/异常：用当前文本收尾，让流式客户端能拿到部分内容
        await streamReporter.stop();
        throw err;
      }

      // 流式收尾：推最终完整 Markdown，通知 server 结束 SSE
      await streamReporter.stop(resultMarkdown);

      const state = getPageState();

      updateBadge('busy', 'Reporting...', 'Sending result to agent');

      const ok = await safeReport({
        type: 'REASONING_RESULT',
        request_id: requestId,
        payload: {
          content: sanitizeSurrogates(resultMarkdown),
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

  // ==========================================================================
  // DOM → Markdown：把网页渲染后的回答节点转回 Markdown 文本。
  //
  // 网页的 assistant 节点是 HTML（标题、段落、代码块、表格等），直接取
  // innerText 会把"复制/下载"按钮的文案、代码块语言标签、Monaco 编辑器
  // 的行号等 UI 文本混进结果。这里按标签递归转换成标准 Markdown。
  //
  // 平台差异：
  //   DeepSeek : 代码块是 div.md-code-block > pre > span 逐行
  //   Qwen     : 代码块是 pre.qwen-markdown-code，代码在 Monaco 的 .view-line
  // 其它元素走通用转换规则。
  // ==========================================================================

  /**
   * 判断某个元素是否应该跳过（不参与 Markdown 输出）。
   * 覆盖复制/下载按钮、SVG 图标、滚动条、工具状态卡片、页脚操作区等。
   */
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;

    // 通用装饰性标签
    if (tag === 'SVG' || tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE') return true;

    const cls = el.classList;
    if (!cls) return false;

    // DeepSeek：复制/下载按钮及其容器、滚动条 gutter
    if (cls.contains('ds-button')) return true;
    if (cls.contains('efa13877')) return true;                    // 按钮行容器
    // DeepSeek 表格的滚动条 gutter
    if (cls.contains('ds-scroll-area__gutters')) return true;
    if (cls.contains('ds-scroll-area__horizontal-gutter')) return true;
    if (cls.contains('ds-scroll-area__vertical-gutter')) return true;

    // Qwen：代码块 header 里的操作按钮、工具状态卡片、页脚操作、表格下载按钮
    if (cls.contains('qwen-markdown-code-header-actions')) return true;
    if (cls.contains('qwen-chat-tool-status-card-wraper')) return true;
    if (cls.contains('qwen-chat-tool-status-card')) return true;
    if (cls.contains('message-hoc-container')) return true;
    if (cls.contains('qwen-chat-package-comp-new-action-control-icons')) return true;
    if (cls.contains('qwen-markdown-table-header')) return true;

    // Qwen 思考模式：thinking 状态卡片（"正在思考…跳过"等）。
    // 流式早期它出现在 .qwen-markdown 之外，可能被 blockToMd 抓成正式回答。
    for (const cn of cls) {
      if (cn.startsWith('qwen-chat-thinking-')) return true;
    }

    // DeepSeek 思考模式：思考内容容器。
    // 里面也有 .ds-markdown，若某个路径绕过 markdownRoot 检查会抓到它。
    if (cls.contains('ds-think-content')) return true;

    // Qwen "多选一回复"界面：resolveMarkdownRoot 通常已深入到第一张卡片，
    // 但作为防御，把提示文案、卡片头、卡片底按钮行一并跳过。
    if (cls.contains('smrm-tip')) return true;
    if (cls.contains('smrm-card__header')) return true;
    if (cls.contains('smrm-card__footer')) return true;

    return false;
  }

  /**
   * 检测 KaTeX 渲染结构，恢复原始 $...$ / $$...$$。
   * 返回 null 表示不是 KaTeX 元素，让调用方继续走通用分派。
   *
   * KaTeX 结构：
   *   <span class="katex">                          ← inline
   *     <span class="katex-mathml">
   *       <math><semantics>...
   *         <annotation encoding="application/x-tex">\frac{a}{b}</annotation>
   *   </span>
   *   <span class="katex-display">                  ← display 包裹层
   *     <span class="katex">...
   *
   * 我们只需从 annotation 里取原始 LaTeX，重新用 $ / $$ 包起来。
   */
  function tryExtractKatex(node) {
    if (!node.classList) return null;

    // Display 模式最外层
    if (node.classList.contains('katex-display')) {
      const annotation = node.querySelector('.katex-mathml annotation[encoding^="application/x-tex"]');
      if (!annotation) return null;
      const tex = annotation.textContent || '';
      if (!tex) return null;
      return `\n$$${tex}$$\n\n`;
    }

    // Inline 模式（katex 类名，且不是 display 的子元素）
    if (node.classList.contains('katex')) {
      const annotation = node.querySelector('.katex-mathml annotation[encoding^="application/x-tex"]');
      if (!annotation) return null;
      const tex = annotation.textContent || '';
      if (!tex) return null;
      return `$${tex}$`;
    }

    return null;
  }

  /**
   * 判断元素是否是各平台表示"空行间隔"的占位元素（例如 Qwen 的
   * `.qwen-markdown-space`）。这些元素在判断"末尾块级元素"时应当被忽略，
   * 因为它们只是渲染上的间距，不代表新内容开始。
   */
  // 各平台表示"纯间距占位"的类名。新增平台时在此处补充。
  const PLATFORM_SPACE_CLASSES = ['qwen-markdown-space'];
  function isPlatformSpace(el) {
    if (!el || !el.classList) return false;
    for (const cls of el.classList) {
      if (PLATFORM_SPACE_CLASSES.includes(cls)) return true;
    }
    return false;
  }

  // ==========================================================================
  // 流式"块级稳定"检测。
  //
  // 用户要求：粗粒度、正确优先。因此不再用"位置/行数增长"这类针对特定
  // 元素类型的启发式判断，而是对 markdownRoot 的每个顶层子元素统一用
  // "内容指纹稳定一段时间"作为渲染完成的标志。
  //
  // 稳定性阈值取 700ms：与采样间隔（500ms）的关系：阈值应该略大于一个采样周期，保证"两次
  // 连续采样看到完全相同的转换结果"才推送，同时不要太大以避免串行延迟
  // 累加。700ms 覆盖一次完整采样周期加抖动余量。
  //
  // 为什么不需要更长：
  //   - H1/H2 等 tag 变化的中间态由 key 里的 tagName 覆盖，一旦 tag 变
  //     化会立即重置计时；
  //   - 代码块的中间态由 tryExtractCodeBlock 的 viewport height 判据覆盖，
  //     未渲染完的代码块直接返回空字符串，不会触发 hash 变化；
  //   - 表格逐行 append 会立即改变 hash；
  // 因此真正的"未稳定"状态会在 500ms 内体现为 hash 变化，700ms 足以
  // 判定"内容已稳定"。
  //
  // 之前设 2500ms 是因为中间态可以被误判为稳定。现在结构性判据已经解
  // 决了那些误判，长窗口只会让串行推送的总延迟线性累加：20 个块的回答
  // 用 2500ms 会累计 50 秒延迟，用 700ms 则降到 14 秒。
  const BLOCK_STABLE_MS = 700;

  // 每个顶层块的内容指纹与最后变化时间
  const topLevelBlockState = new Map();

  /**
   * 按顺序转换 markdownRoot 的所有顶层子元素。
   *
   * 每个块先通过 blockToMd 转成 Markdown，然后**用转换结果本身**做稳定
   * 判定。这是关键：指纹的来源必须和最终推送给客户端的内容一致，否则会
   * 出现"指纹说稳定但输出还在变"的错位。
   *
   * 之前用 node.innerText 做指纹会包含 Monaco 编辑器的行号等 UI 文本，
   * 而实际输出用的是 .view-line，两者更新节奏不同步。现在统一用转换
   * 结果，任何真实内容变化都会立即改变哈希并重置稳定计时。
   *
   * 流式采样（isFinal !== true）时：遇到第一个未稳定的块就停止。保证每
   * 次推送的内容都是"前几个已稳定块"的拼接，后续采样一定是本次内容的
   * 前缀，server 端前缀检测不会拒绝。
   *
   * 最终帧（isFinal === true）时：不过滤，全部输出。
   */
  function renderTopLevelBlocks(root, options = {}) {
    if (!root) return '';
    const parts = [];
    for (const child of root.childNodes) {
      if (child.nodeType !== 1) continue;
      if (shouldSkipElement(child)) continue;
      if (isPlatformSpace(child)) continue;

      // 先转换：转换结果既用于稳定判定，也用于最终输出
      let converted;
      try {
        converted = blockToMd(child, options);
      } catch (e) {
        console.warn(`[AgentBridge:${currentPlatform.name}] blockToMd failed:`, e);
        converted = '';
      }

      if (!options.isFinal) {
        const hash = fnv1aHash(converted, 0x811c9dc5) + fnv1aHash(converted, 0x9e3779b9);
        // 用 "tagName:hash" 作为 key：
        //   - tag 变化（<p>→<h1>）：视为新块，计时重置
        //   - 内容变化（同一 tag 下文本变）：hash 变化，视为新块
        //   - tag 与内容都不变：state 延续，累积稳定时间
        const key = `${child.tagName}:${hash}`;
        const now = Date.now();
        const prev = topLevelBlockState.get(key);
        if (!prev) {
          topLevelBlockState.set(key, { at: now });
          break;
        }
        if (now - prev.at < BLOCK_STABLE_MS) {
          break;
        }
      }

      parts.push(converted);
    }
    return parts.join('');
  }

  /**
   * 平台定制的代码块提取。
   *   - 返回非空字符串：转换好的 Markdown 代码块
   *   - 返回空字符串：这是代码块但还没渲染完成，本轮跳过
   *   - 返回 null：不是代码块，走通用标签分派
   *
   * 判定完全基于节点自身的 class，不再依赖 currentPlatform.id。
   * 之前用 `if (id === 'qwen')` 判断时，一旦平台识别失误就会落到最后的
   * `return null`，让 blockToMd 继续走通用 `case 'pre'` 分支，把 Monaco
   * 的行号 gutter（1 2 3 ...）当成代码内容输出。
   *
   * Qwen 的代码块根节点是 <pre>，Monaco 未渲染完时 .view-line 为空。
   * 这种情况下必须返回空字符串跳过（不能 fallback 到 textContent，那会
   * 包含行号）。空字符串 !== null，所以 blockToMd 不会继续往下走。
   */
  function tryExtractCodeBlock(node, options = {}) {
    // Qwen 代码块。
    // 主判据是 class 名，兜底判据是"<pre> 内含 Monaco 结构"。
    // 兜底是必要的：流式渲染的某些阶段 className 可能与我们预期的不同，
    // 一旦主判据失败，blockToMd 会回退到 case 'pre' 读 textContent，
    // 把 Monaco 的行号 gutter 当成代码内容输出（表现为客户端出现 1 2 3）。
    const isQwenCode = node.tagName === 'PRE' && (
      node.classList?.contains('qwen-markdown-code') ||
      !!node.querySelector('.view-line')
    );
    if (isQwenCode) {
      // Monaco 完成渲染的结构性信号：.qwen-markdown-code-editor-viewport
      // 上出现一个大于 0 的显式 height。
      //
      // 不能用"body 上有语言 class"作为信号——Qwen 里存在**无语言**的
      // 代码块（例如项目结构块），它们的 .qwen-markdown-code-body 只有
      // 一个 class（qwen-markdown-code-body 本身），会误伤。
      //
      // 也不能只判断 viewLines.length > 0——Monaco 分多次挂载 .view-line，
      // 中间存在"部分行已挂载但布局尚未最终确定"的状态。
      //
      // viewport 的 height 是 Monaco 完成初始化、拿到最终内容高度后才
      // 由 JS 显式写入的。在渲染完之前它是 0 或缺失。
      const viewport = node.querySelector('.qwen-markdown-code-editor-viewport');
      if (!viewport) {
        return '';
      }
      const viewportHeight = parseInt(viewport.style.height, 10);
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        return '';
      }

      const header = node.querySelector('.qwen-markdown-code-header');
      const lang = header?.firstElementChild?.textContent?.trim() || '';
      const viewLines = Array.from(node.querySelectorAll('.view-line'));
      if (viewLines.length === 0) {
        return '';
      }
      const lines = viewLines.map((l) => l.textContent.replace(/\u00a0/g, ' '));
      return `\n\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n\n`;
    }

    // DeepSeek 代码块
    if (node.classList?.contains('md-code-block')) {
      const lang = node.querySelector('.d813de27')?.textContent?.trim() || '';
      const pre = node.querySelector('pre');
      if (!pre) return null;
      const lines = Array.from(pre.children)
        .filter((c) => c.tagName === 'SPAN')
        .map((s) => s.textContent);
      return `\n\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n\n`;
    }

    return null;
  }

  /**
   * 提取节点内部所有子节点的"内联"Markdown（不加段落级换行）。
   * 用于列表项、表格单元格、标题等不允许出现 \n\n 的位置。
   */
  function inlineToMd(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (shouldSkipElement(node)) return '';

    // 优先恢复 KaTeX 数学公式
    const katex = tryExtractKatex(node);
    if (katex !== null) return katex;

    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'br': return '\n';
      case 'strong': case 'b': {
        const inner = inlineToMdChildren(node);
        return inner ? `**${inner}**` : '';
      }
      case 'em': case 'i': {
        const inner = inlineToMdChildren(node);
        return inner ? `*${inner}*` : '';
      }
      case 'code': return `\`${node.textContent}\``;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = inlineToMdChildren(node);
        return href ? `[${text}](${href})` : text;
      }
      default: return inlineToMdChildren(node);
    }
  }

  function inlineToMdChildren(node) {
    return Array.from(node.childNodes).map(inlineToMd).join('');
  }

  /**
   * 把一个表格转换成 Markdown 表格。
   * 单元格内容里的 | 会被转义，换行会被折叠为空格。
   */
  function tableToMd(table) {
    const headRows = Array.from(table.querySelectorAll('thead tr'));
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));

    const renderRow = (row) =>
      Array.from(row.children).map((cell) =>
        inlineToMdChildren(cell).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')
      );

    const lines = [];
    let headerCells;
    let dataRows;

    if (headRows.length > 0) {
      headerCells = renderRow(headRows[0]);
      dataRows = bodyRows;
    } else if (bodyRows.length > 0) {
      // 没有 thead 时把第一行当表头
      headerCells = renderRow(bodyRows[0]);
      dataRows = bodyRows.slice(1);
    } else {
      return '';
    }

    if (headerCells.length > 0) {
      lines.push('| ' + headerCells.join(' | ') + ' |');
      lines.push('| ' + headerCells.map(() => '---').join(' | ') + ' |');
    }
    for (const row of dataRows) {
      lines.push('| ' + renderRow(row).join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  /**
   * 把列表项内容转换成 Markdown。
   *
   * 列表项内部可能既有内联内容（`<p>`、`<span>`、`<a>`、`<code>`…）又有
   * 块级内容（代码块、表格、嵌套列表）。早期实现把所有非 p/ul/ol 的子
   * 元素都交给 inlineToMd，导致代码块的语言标签和代码内容被拍成一行
   * （例如 `[rustup](...)bashcurl --proto ...`）。现在区分对待：
   *
   *   - 纯文本节点：直接拼接
   *   - <p>：内联内容（不加 \n\n，保持和列表项的紧凑格式）
   *   - <ul> / <ol>：换行 + 递归列表
   *   - 内联标签（span/strong/em/code/a/br）：inlineToMd
   *   - 其它（div/pre/table…）：blockToMd，前后补空行
   */
  function listItemContent(li, options = {}) {
    const INLINE_TAGS = new Set(['span', 'strong', 'b', 'em', 'i', 'code', 'a', 'br']);
    const parts = [];
    for (const child of li.childNodes) {
      if (child.nodeType === 3) {
        parts.push(child.textContent);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (shouldSkipElement(child)) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'p') {
        parts.push(inlineToMdChildren(child));
      } else if (tag === 'ul' || tag === 'ol') {
        parts.push('\n' + listToMd(child, tag === 'ol', options));
      } else if (INLINE_TAGS.has(tag)) {
        parts.push(inlineToMd(child));
      } else {
        const blockMd = blockToMd(child, options).trim();
        if (blockMd) parts.push('\n\n' + blockMd);
      }
    }
    return parts.join('');
  }

  /**
   * 把 ul/ol 转换成 Markdown 列表。多行内容用缩进对齐。
   *
   * 空行不缩进：CommonMark 里"空行"必须是完全空白的行，如果在空行里
   * 塞进缩进空格，某些解析器会把它视为"带空白的行"，从而中断列表项
   * 内部的代码块识别。所以这里对空行保留为 ''，只缩进有内容的行。
   */
  function listToMd(list, ordered, options = {}) {
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
    return items.map((li, i) => {
      const prefix = ordered ? `${i + 1}. ` : '- ';
      const indent = ' '.repeat(prefix.length);
      const inner = listItemContent(li, options).trim();
      const indented = inner
        .split('\n')
        .map((line, idx) => (idx === 0 ? line : (line ? indent + line : '')))
        .join('\n');
      return prefix + indented;
    }).join('\n');
  }

  /**
   * 递归把节点转换成块级 Markdown。返回空字符串表示该节点不产生输出。
   */
  function blockToMd(node, options = {}) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (shouldSkipElement(node)) return '';

    // 优先恢复 KaTeX 数学公式
    const katex = tryExtractKatex(node);
    if (katex !== null) return katex;

    // 平台定制的代码块必须在通用标签分派之前判断
    const codeBlock = tryExtractCodeBlock(node, options);
    if (codeBlock !== null) return codeBlock;

    // Qwen 表格外层包装：内部才是真正的 <table>
    if (node.classList?.contains('qwen-markdown-table-wrapper')) {
      const table = node.querySelector('table');
      if (table) return `\n${tableToMd(table)}\n\n`;
    }

    // Qwen 的段落/间距用带类名的 div 表示
    if (node.classList?.contains('qwen-markdown-space')) return '';
    if (node.classList?.contains('qwen-markdown-paragraph')) {
      return `\n${inlineToMdChildren(node).trim()}\n\n`;
    }

    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'h1': return `\n# ${inlineToMdChildren(node).trim()}\n\n`;
      case 'h2': return `\n## ${inlineToMdChildren(node).trim()}\n\n`;
      case 'h3': return `\n### ${inlineToMdChildren(node).trim()}\n\n`;
      case 'h4': return `\n#### ${inlineToMdChildren(node).trim()}\n\n`;
      case 'h5': return `\n##### ${inlineToMdChildren(node).trim()}\n\n`;
      case 'h6': return `\n###### ${inlineToMdChildren(node).trim()}\n\n`;
      case 'p': return `\n${inlineToMdChildren(node).trim()}\n\n`;
      case 'hr': return `\n---\n\n`;
      case 'br': return '\n';
      case 'ul': return `\n${listToMd(node, false, options)}\n\n`;
      case 'ol': return `\n${listToMd(node, true, options)}\n\n`;
      case 'table': return `\n${tableToMd(node)}\n\n`;
      case 'blockquote': {
        const inner = blockToMdChildren(node, options).trim();
        return `\n> ${inner.replace(/\n/g, '\n> ')}\n\n`;
      }
      case 'pre': {
        // 若 <pre> 内含 Monaco 结构（.view-line 或 .monaco-editor），
        // 它是一个我们没能正确识别的代码块。绝不能从 textContent 读
        // 内容——那会包含 Monaco 的行号 gutter、语言标签、按钮文案。
        // 返回空字符串让这个块暂时"消失"，等 tryExtractCodeBlock 命中
        // 或 Monaco 渲染完成后再输出。
        if (node.querySelector('.view-line, .monaco-editor')) {
          return '';
        }
        const code = node.textContent.replace(/\n$/, '');
        return `\n\`\`\`\n${code}\n\`\`\`\n\n`;
      }
      case 'strong': case 'b': {
        const inner = inlineToMdChildren(node);
        return inner ? `**${inner}**` : '';
      }
      case 'em': case 'i': {
        const inner = inlineToMdChildren(node);
        return inner ? `*${inner}*` : '';
      }
      case 'code': return `\`${node.textContent}\``;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = inlineToMdChildren(node);
        return href ? `[${text}](${href})` : text;
      }
      default:
        return blockToMdChildren(node, options);
    }
  }

  function blockToMdChildren(node, options = {}) {
    return Array.from(node.childNodes).map((c) => blockToMd(c, options)).join('');
  }

  /**
   * 在转换前定位真正的"内容根"。
   *
   * Qwen 在"请选择一个回复"的场景下，会渲染一个 dual-message 容器，
   * 里面并列两个 `.smrm-card`，各自包着一份完整的 `.chat-response-message`。
   * 我们对这种结构只能返回一份答案，约定取第一个回复。
   *
   * 其它平台/场景直接返回原节点。
   */
  function resolveMarkdownRoot(node) {
    if (!node) return node;
    // Qwen 多选一回答：进入第一张卡片的 .chat-response-message 子树
    if (node.classList?.contains('qwen-chat-message-dual-message')) {
      const firstContent = node.querySelector('.smrm-card .chat-response-message');
      if (firstContent) return firstContent;
    }
    return node;
  }

  /**
   * 入口：把 assistant 节点的 DOM 子树转换成干净的 Markdown。
   *
   * 流式采样时只输出"已稳定的顶层块"，遇到第一个不稳定块即停止；最终帧
   * 输出全部内容。最后做几轮清理：合并多余空行、去掉行尾空白、去首尾空行。
   */
  function domToMarkdown(root, options = {}) {
    if (!root) return '';
    const effectiveRoot = resolveMarkdownRoot(root);

    // 定位 markdown 内容根：
    //   - 平台配置了 markdownRoot：
    //       - effectiveRoot 恰好匹配它 → 用它本身
    //       - 在 effectiveRoot 内部能找到 → 用找到的
    //       - 都找不到 → 返回空字符串，等下一轮采样。**不 fallback**
    //         到 effectiveRoot，否则会把思考内容（DeepSeek 的
    //         .ds-think-content、Qwen 的 thinking 卡片）当作正式回答输出
    //   - 平台未配置 markdownRoot → 退回 effectiveRoot 本身
    const rootSelector = currentPlatform.markdownRoot;
    let blocksRoot;
    if (rootSelector) {
      try {
        if (typeof effectiveRoot.matches === 'function' && effectiveRoot.matches(rootSelector)) {
          blocksRoot = effectiveRoot;
        } else {
          blocksRoot = effectiveRoot.querySelector(rootSelector);
        }
      } catch { /* 无效选择器忽略 */ }
      if (!blocksRoot) {
        // 正式回答还没开始渲染，本轮无内容可输出
        return '';
      }
    } else {
      blocksRoot = effectiveRoot;
    }

    const raw = renderTopLevelBlocks(blocksRoot, options);

    return raw
      .replace(/[ \t]+\n/g, '\n')     // 行尾空白
      .replace(/\n{3,}/g, '\n\n')     // 三段以上空行压成两段
      .replace(/^\n+/, '')            // 去首部空行
      .replace(/\n+$/, '')            // 去尾部空行
      .trim();
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

  /**
   * 取当前最新 assistant 消息的 Markdown 文本。
   *
   * 优先走 domToMarkdown 做结构化转换（正确保留代码块、表格、列表），
   * 转换失败时回落到 innerText，保证功能不中断。
   */
  function getLatestAssistantText(options = {}) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(currentPlatform.assistant));
    } catch (e) {
      return '';
    }
    if (nodes.length === 0) return '';
    const last = nodes[nodes.length - 1];

    try {
      // 无条件返回 domToMarkdown 的结果，即使它是空字符串。
      //
      // 空字符串是"本轮所有块都还没稳定"的合法结果，不是错误。
      // 之前的 `if (md) return md;` 会把空字符串当作转换失败，fallback
      // 到 innerText —— 而 innerText 包含 Monaco 行号、未处理的 markdown
      // 标记等 UI 文本，与后续真实的 markdown 输出不是前缀关系，会让
      // server 端前缀检测永久拒绝，客户端卡在 innerText 版本直到最终帧。
      //
      // 只有 domToMarkdown 抛异常时（真正的转换失败）才回退。
      return domToMarkdown(last, options);
    } catch (e) {
      console.warn(`[AgentBridge:${currentPlatform.name}] domToMarkdown failed, fallback to innerText:`, e);
    }
    return (last.innerText || last.textContent || '').trim();
  }

  /**
  * Wait for completion: 基于新回答 diff + 可见停止按钮 + 文本稳定 + 最小等待时间
  * 
  * 参数调优说明：
  * - interval 800→400，stableChecks 4→2：秒回场景从 ~3.2s 降到 ~0.8s；
  *   仍能过滤掉 SSE 分片抖动（相邻两次 400ms 采样文本完全一致）。
  * - noStopGraceMs 2500→1200：仅当整个响应周期里一次都没看到过停止按钮时才生效，
  *   用于兜底那些秒回、停止按钮根本没渲染的平台（如 Qwen "hi"）。
  * - 新增 hardStableMs = 4000：即使一直能看到停止按钮，只要文本连续 4s 不变也判完成，
  *   避免某些平台停止按钮改成“重新生成”后一直挂着导致永久挂起。
  */
  function waitForCompletion({ beforeSnapshot, sentAt, timeoutMs = 300000 } = {}) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const minGenerationMs = 500;       // 响应刚开始后的最小观察窗
      const requiredStableChecks = 2;    // 连续 2 次（400ms * 2 ≈ 0.8s）文本不变即完成
      const noStopGraceMs = 1200;        // 未见过停止按钮时的兜底等待
      const hardStableMs = 4000;         // 见得到停止按钮但文本长期不变 => 也判完成
      const CHECK_INTERVAL_MS = 400;

      let streamStableCount = 0;
      let lastText = '';
      let lastChangeAt = 0;              // 最后一次文本发生变化的时间
      let hadVisibleStopButton = false;
      let responseStarted = false;
      let responseStartedAt = 0;

      // 判定完成时，用 isFinal=true 重新采集一次，确保末尾代码块不被跳过
      const collectFinal = () => {
        try {
          const t = getLatestAssistantText({ isFinal: true });
          return t || lastText;
        } catch {
          return lastText;
        }
      };

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
            lastChangeAt = now;
            console.log(`[AgentBridge:${currentPlatform.name}] Response started. initial text length: ${lastText.length}`);
          }
          return; // 还没开始就继续等
        }

        // 2) 最小等待时间，避免秒回被过早判定
        if (now - responseStartedAt < minGenerationMs) return;

        const currentText = getLatestAssistantText();

        // 3) 文本变化跟踪
        if (currentText !== lastText) {
          lastText = currentText;
          lastChangeAt = now;
          streamStableCount = 0;
        }

        // 4) 可见停止按钮检测
        const stopBtn = findVisible(currentPlatform.stop);
        if (stopBtn) {
          hadVisibleStopButton = true;
          // 停止按钮仍在：正常生成中，继续等
          // 但若文本已长期不变（部分平台停止按钮不会自动消失），走 hardStableMs 兜底
          if (currentText && now - lastChangeAt >= hardStableMs) {
            clearInterval(checkInterval);
            console.log(`[AgentBridge:${currentPlatform.name}] Completion detected (hard-stable ${hardStableMs}ms, stop btn still visible).`);
            resolve(collectFinal());
          }
          return;
        }

        // 5) 无可见停止按钮
        if (!currentText) return;

        // 如果从没见过停止按钮，至少要等 noStopGraceMs 才允许判定（防止误判）
        if (!hadVisibleStopButton && now - responseStartedAt < noStopGraceMs) {
          return;
        }

        // 6) 文本稳定性判定
        if (currentText === lastText) {
          streamStableCount++;
          console.log(`[AgentBridge:${currentPlatform.name}] Stable check ${streamStableCount}/${requiredStableChecks}, len=${currentText.length}`);
          if (streamStableCount >= requiredStableChecks) {
            clearInterval(checkInterval);
            console.log(`[AgentBridge:${currentPlatform.name}] Completion detected.`);
            resolve(collectFinal());
          }
        } else {
          streamStableCount = 0;
          lastText = currentText;
          lastChangeAt = now;
        }
      }, CHECK_INTERVAL_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBridgeLoop);
  } else {
    startBridgeLoop();
  }
})();