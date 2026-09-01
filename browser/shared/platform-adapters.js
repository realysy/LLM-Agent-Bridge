/**
 * Universal Multi-Platform DOM Adapters (Matrix Extension)
 * Supported Platforms:
 * 1. ChatGPT (chatgpt.com / chat.openai.com)
 * 2. Claude (claude.ai)
 * 3. DeepSeek (chat.deepseek.com)
 * 4. Google Gemini (gemini.google.com)
 * 5. Kimi (kimi.com / www.kimi.com / kimi.moonshot.cn)
 * 6. Grok / xAI (grok.com / x.com/i/grok)
 * 7. Qwen / 通义千问 (tongyi.aliyun.com / chat.qwen.ai)
 * 8. Doubao / 豆包 (doubao.com)
 * 9. GLM / 智谱清言 (chatglm.cn)
 */

export const PLATFORM_CONFIGS = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    matches: ['chatgpt.com', 'chat.openai.com'],
    selectors: {
      input: '#prompt-textarea, div[contenteditable="true"], textarea',
      send: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
      stop: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"]',
      assistantMsg: '[data-message-author-role="assistant"]',
      modelText: 'button[data-testid="model-switcher-dropdown-button"], button[aria-haspopup="menu"] span',
      isLogin: () => !document.querySelector('a[href*="/login"], button[data-testid="login-button"]'),
    },
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    matches: ['claude.ai'],
    selectors: {
      input: 'div[contenteditable="true"].ProseMirror, fieldset div[contenteditable="true"], div[contenteditable="true"]',
      send: 'button[aria-label="Send Message"], button[aria-label="Send prompt"], fieldset button:has(svg)',
      stop: 'button[aria-label="Stop Response"], button[aria-label="Stop generating"]',
      assistantMsg: '.font-claude-message, [data-is-streaming], div[data-testid="chat-message-assistant"]',
      modelText: 'button[data-testid="model-selector-dropdown"] span, button:has(span.font-medium)',
      isLogin: () => !document.querySelector('a[href*="/login"], a[href*="/signup"]'),
    },
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    matches: ['chat.deepseek.com'],
    selectors: {
      input: 'textarea#chat-input, textarea.chat-input, textarea',
      send: 'div[role="button"]:has(svg), div#chat-input-send-button, div[class*="send-button"], button:has(svg)',
      stop: 'div[role="button"]:has(svg.ds-icon-stop), div[class*="stop-button"]',
      assistantMsg: '.ds-markdown, .ds-message-assistant, div[class*="ds-message"]:not([class*="user"])',
      modelText: '.ds-dropdown-value, div[class*="model-name"]',
      isLogin: () => !document.querySelector('div[class*="login-btn"], a[href*="/login"]'),
    },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    matches: ['gemini.google.com'],
    selectors: {
      input: 'rich-textarea > div, div[contenteditable="true"], textarea',
      send: 'button[aria-label*="Send"], button.send-button, mat-icon[data-mat-icon-name="send"]',
      stop: 'button[aria-label*="Stop"], button.stop-button',
      assistantMsg: 'model-response, .model-response-text, message-content',
      modelText: '.model-pill-label, button[aria-label*="model"]',
      isLogin: () => !document.querySelector('a[href*="accounts.google.com"]'),
    },
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    matches: ['kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
    selectors: {
      input: 'div[contenteditable="true"], div[class*="editor"], textarea',
      send: 'div[class*="send-button"], button[class*="send"], div[role="button"]:has(svg), div[class*="sendIcon"]',
      stop: 'div[class*="stop"], button[class*="stop"]',
      assistantMsg: '.markdown___, div[class*="chat-message-assistant"], div[class*="segment-assistant"], div[class*="chat-content"], div[class*="markdown"]',
      modelText: 'div[class*="model-switcher"] span, div[class*="tag"], div[class*="model-name"]',
      isLogin: () => !document.querySelector('button:contains("登录"), div[class*="login"], a[href*="login"]'),
    },
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    matches: ['grok.com', 'x.com/i/grok', 'twitter.com/i/grok'],
    selectors: {
      input: 'textarea[placeholder*="Ask"], textarea, div[contenteditable="true"]',
      send: 'button[aria-label*="Grok"], button[type="submit"], button:has(svg)',
      stop: 'button[aria-label*="Stop"], button[class*="stop"]',
      assistantMsg: 'div.response-body, div[class*="message-bubble"], div[class*="response-message"], div[dir="auto"].items-start, div[class*="prose"]',
      modelText: 'button[aria-haspopup="menu"] span, div[class*="model"]',
      isLogin: () => !document.querySelector('a[href*="/login"], a[href*="/i/flow/login"]'),
    },
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen (通义千问)',
    matches: ['tongyi.aliyun.com', 'chat.qwen.ai'],
    selectors: {
      input: 'textarea[placeholder*="问"], textarea#chat-textarea, div[contenteditable="true"]',
      send: 'div[class*="operateBtn"] button, div[class*="send-btn"], button:has(svg)',
      stop: 'div[class*="stop-btn"], button[class*="stop"]',
      assistantMsg: '.tongyi-ui-markdown, div[class*="contentWrapper"], div[class*="markdown"]',
      modelText: 'div[class*="model-name"], span[class*="modelTag"]',
      isLogin: () => !document.querySelector('.login-btn, button:contains("登录")'),
    },
  },
  doubao: {
    id: 'doubao',
    name: 'Doubao (豆包)',
    matches: ['doubao.com'],
    selectors: {
      input: 'textarea[placeholder*="输入"], textarea#flow-end-textarea, div[contenteditable="true"]',
      send: 'button#flow-end-msg-send, div[class*="send-btn"], button:has(svg)',
      stop: 'button[class*="stop"], div[class*="stop-btn"]',
      assistantMsg: 'div[data-testid="receive_message"], div[class*="message-receive"], .markdown-body',
      modelText: 'div[class*="model-select"] span, div[class*="model-item"]',
      isLogin: () => !document.querySelector('button:contains("登录"), div[class*="login"]'),
    },
  },
  glm: {
    id: 'glm',
    name: 'GLM (智谱清言)',
    matches: ['chatglm.cn', 'bigmodel.cn'],
    selectors: {
      input: 'textarea[placeholder*="输入"], div[contenteditable="true"], textarea',
      send: 'button:has(svg), .send-btn, div[class*="enter-icon"]',
      stop: '.stop-btn, button:has(svg.stop-icon)',
      assistantMsg: '.markdown-body, div[class*="bubble-content-assistant"], .chat-item-assistant',
      modelText: 'div[class*="model-select"] span, div[class*="current-model"]',
      isLogin: () => !document.querySelector('.login-btn, button:contains("登录")'),
    },
  },
};

export function detectPlatform(url = window.location.href) {
  for (const [key, cfg] of Object.entries(PLATFORM_CONFIGS)) {
    if (cfg.matches.some(m => url.includes(m))) {
      return cfg;
    }
  }
  return null;
}
