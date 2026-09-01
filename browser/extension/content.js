(function () {
  'use strict';

  const WS_URL = 'ws://127.0.0.1:8765';
  let ws = null;
  let statusBadge = null;
  let isExecuting = false;
  let reconnectTimer = null;

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
      input: 'textarea#chat-input, textarea[placeholder*="DeepSeek"], textarea',
      send: 'div[role="button"][aria-disabled="false"]:has(svg), div#chat-input-send-button, button:has(svg)',
      stop: 'div[role="button"]:has(svg.ds-icon-stop), button:has(svg[aria-label="stop"])',
      assistant: '.ds-markdown, .ds-message-assistant, div[class*="assistant"]',
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
    return PLATFORMS.chatgpt;
  }

  const currentPlatform = getCurrentPlatform();

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
      if (ws) {
        try { ws.close(); } catch {}
      }
      connect();
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
      isLogin: currentPlatform.isLogin(),
      currentModel: currentPlatform.model(),
    };
  }

  // 3. Connect WebSocket
  function connect() {
    createBadge();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      updateBadge('disconnected', 'Waiting for Agent...', 'Run: npm run bridge in local agent repo');
      reconnectTimer = setTimeout(connect, 4000);
      return;
    }

    ws.onopen = () => {
      updateBadge('connected', 'Ready', `Connected as ${currentPlatform.name} Provider`);
      const state = getPageState();
      ws.send(JSON.stringify({
        type: 'CLIENT_STATUS',
        payload: {
          platform: state.platform,
          platform_name: state.platform_name,
          url: window.location.href,
          logged_in: state.isLogin,
          model: state.currentModel,
        },
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'EXECUTE_REASONING') {
          handleReasoningRequest(data.request_id, data.payload);
        }
      } catch (err) {
        console.error(`[AgentBridge:${currentPlatform.name}] Message handling error:`, err);
      }
    };

    ws.onclose = () => {
      updateBadge('disconnected', 'Waiting for Agent...', 'Bridge server offline');
      reconnectTimer = setTimeout(connect, 4000);
    };

    ws.onerror = () => {
      updateBadge('disconnected', 'Waiting for Agent...', 'Bridge server offline');
    };
  }

  // 4. Inject prompt & extract result
  async function handleReasoningRequest(requestId, payload) {
    if (isExecuting) {
      ws.send(JSON.stringify({
        type: 'REASONING_ERROR',
        request_id: requestId,
        payload: { error: `${currentPlatform.name} tab is already processing another reasoning request.` },
      }));
      return;
    }

    isExecuting = true;
    updateBadge('busy', 'Reasoning...', 'Executing agent task');

    try {
      const inputEl = document.querySelector(currentPlatform.input);

      if (!inputEl) {
        throw new Error(`Could not find ${currentPlatform.name} prompt input area.`);
      }

      // Inject text
      inputEl.focus();
      if (inputEl.tagName === 'TEXTAREA') {
        inputEl.value = payload.packet;
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
      } else {
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }

      // Wait for completion
      const resultMarkdown = await waitForCompletion();
      const state = getPageState();

      ws.send(JSON.stringify({
        type: 'REASONING_RESULT',
        request_id: requestId,
        payload: {
          content: resultMarkdown,
          platform: currentPlatform.id,
          platform_name: currentPlatform.name,
          model: state.currentModel,
          timestamp: new Date().toISOString(),
        },
      }));
      updateBadge('connected', 'Ready', 'Task completed');
    } catch (err) {
      console.error(`[AgentBridge:${currentPlatform.name}] Execution error:`, err);
      ws.send(JSON.stringify({
        type: 'REASONING_ERROR',
        request_id: requestId,
        payload: { error: err.message },
      }));
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
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
})();
