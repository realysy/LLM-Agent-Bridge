// ==UserScript==
// @name         Universal Agent Bridge (Multi-Model Coding Matrix)
// @namespace    https://github.com/realysy/LLM-Agent-Bridge
// @version      0.5.10
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
// @connect      192.168.*
// @connect      172.16.*
// @connect      172.17.*
// @connect      172.18.*
// @connect      172.19.*
// @connect      172.2?.*
// @connect      172.30.*
// @connect      172.31.*
// @connect      10.0.*
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
            resolve(currentText);
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
            resolve(currentText);
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