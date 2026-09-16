# Universal Agent Bridge 通用智能体网页端推理桥接 (`universal-agent-bridge`)

[English](README.md) | **简体中文**

> **致谢与开源传承**：
> 本项目最初由 [anightmonarch/codex-bridge-chatgpt](https://github.com/anightmonarch/codex-bridge-chatgpt) 启发并派生重构。在此对原作者 `@anightmonarch` 开创的“本地 Agent 抓证据与执行、网页大模型做复杂推理”的范式致以崇高的敬意与感谢！
> 
> 在 **Universal Agent Bridge** 中，我们将这一范式进行了全方位的跨代级扩展与重构：
> 1. **全模型矩阵支持（Multi-Model Matrix）**：从单一 ChatGPT 扩展至同时支持 **Claude、DeepSeek、Gemini、Grok、通义千问 Qwen、豆包 Doubao、智谱 GLM 以及 Kimi**；
> 2. **全智能体支持（Universal Agent Framework）**：彻底解耦了原有的 Codex Desktop 专属绑定，通用支持 **DeepSeek Harness、Claude Code、Cursor、OpenCode、CLI Agents、各种开源 Agent 工作流**；
> 3. **双通道高可用传输架构（Dual-Channel Transport）**：同时支持原生 WebSocket 与油猴特权 HTTP 长轮询（`GM_xmlhttpRequest`），100% 免疫浏览器 CSP 与 Mixed Content 跨域拦截。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-43853d)](package.json)
[![GreasyFork Userscript](https://img.shields.io/badge/GreasyFork-v0.5.2-green.svg)](https://greasyfork.org/zh-CN/scripts/593912-universal-agent-bridge-multi-model-coding-matrix)

![Codex 桥接 ChatGPT 架构](assets/codex-bridge-chatgpt-architecture.png)

---

## 安装

### 第一步：克隆代码到 Agent 的技能目录

将本项目克隆到您所使用的 AI Agent 的技能目录中（如 `~/.dsh/skills`、`~/.codex/skills` 或工作区根目录）：

```bash
# 克隆仓库
git clone https://github.com/EasongChung/Universal-Agent-Bridge.git universal-agent-bridge

# 进入目录并进行环境体检
cd universal-agent-bridge
npm run doctor
```

### 第二步：安装浏览器端油猴脚本（或原生扩展）

- **油猴脚本一键安装（GreasyFork 官方源）**：
  👉 **[Universal-Agent-Bridge on GreasyFork](https://greasyfork.org/zh-CN/scripts/593912-universal-agent-bridge-multi-model-coding-matrix)**
- *备选方案（原生浏览器扩展）*：
  在 Edge 或 Chrome 的 `edge://extensions` / `chrome://extensions` 中开启“开发者模式”，点击“加载解压缩的扩展”并选择仓库中的 `browser/extension/` 文件夹。

### 第三步：使用默认浏览器提前登录需要调用的平台

在您的默认浏览器中打开并登录您需要使用的 AI 平台账号：
- 🟢 **Claude**：`https://claude.ai`
- 🟢 **DeepSeek**：`https://chat.deepseek.com`
- 🟢 **Gemini**：`https://gemini.google.com`
- 🟢 **ChatGPT**：`https://chatgpt.com`
- 🟢 **Grok**：`https://grok.com`
- 🟢 **通义千问 Qwen**：`https://tongyi.aliyun.com` 或 `https://chat.qwen.ai`
- 🟢 **豆包 Doubao**：`https://www.doubao.com`
- 🟢 **智谱清言 GLM**：`https://chatglm.cn`
- 🟢 **Kimi**：`https://www.kimi.com`

---

## 快速上手

当 Agent 触发本技能时，标准化交互流程如下：
1. **自动启动本地服务**：Agent 自动拉起本地 Bridge 传输服务；
2. **询问指定平台**：询问用户是否指定调用某个特定大模型平台（如 DeepSeek、Claude、ChatGPT、Gemini、Grok，或自动选择）；
3. **拉起浏览器与握手**：自动启动默认浏览器打开对应平台网页，建立连接握手（网页右上角显示 **🟢 `Bridge: Ready`**）；
4. **全自动推理与落盘**：向网页输入框注入脱敏 Prompt，提取推理结果并由本地 Agent 继续验证和执行。

```bash
# 1. 启动 Bridge 传输服务
node skills/universal-agent-bridge/scripts/ws-transport.mjs serve

# 2. 检查当前所有已连接的网页平台状态
node skills/universal-agent-bridge/scripts/ws-transport.mjs status

# 3. 发起推理交接（自动选择当前已打开的任意网页，或指定特定平台）
node skills/universal-agent-bridge/scripts/ws-transport.mjs send packet.md result.md
node skills/universal-agent-bridge/scripts/ws-transport.mjs send packet.md result.md --platform claude
node skills/universal-agent-bridge/scripts/ws-transport.mjs send packet.md result.md --platform deepseek
```

### OpenAI 兼容 API 模式

将 Bridge 作为 OpenAI 兼容的 LLM API 服务器使用，支持任何 OpenAI SDK 客户端：

```bash
# 启动 OpenAI 兼容 API 服务器
npm run api
# 或
node skills/universal-agent-bridge/scripts/openai-api.mjs serve --port 8765 --api-key sk-bridge-local-key

# 列出可用模型
curl http://localhost:8765/v1/models -H "Authorization: Bearer sk-bridge-local-key"

# 聊天补全接口
curl http://localhost:8765/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "chatgpt-web", "messages": [{"role": "user", "content": "Hello!"}]}'
```

完整用法及 Python/Node.js SDK 集成示例请参阅 [OpenAI API 文档](skills/universal-agent-bridge/references/openai-api.md)。

---

## 工作原理

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │                            本地 AI Agent                               │
  │     (DeepSeek Harness, Claude Code, Cursor, OpenCode, 终端 CLI)        │
  └──────────────────┬─────────────────────────────────▲───────────────────┘
                     │ 1. 搜集最小脱敏证据包           │ 4. 本地采纳门核验、写文件
                     │    (Token < 3000, 自动脱敏)     │    与运行自动化测试
                     ▼                                 │
  ┌────────────────────────────────────────────────────────────────────────┐
  │                 本地 Bridge 路由服务 (Port 8765)                       │
  │            (WebSocket + GM_xmlhttpRequest HTTP 长轮询)                 │
  └──────────────────┬─────────────────────────────────▲───────────────────┘
                     │ 2. 毫秒级任务分发               │ 3. 提取结构化推理回执
                     ▼                                 │    (Reasoning Result)
  ┌────────────────────────────────────────────────────────────────────────┐
  │                    浏览器网页端大模型推理矩阵                          │
  │     [Claude]      [DeepSeek]      [Gemini]      [Grok]     [ChatGPT]   │
  └────────────────────────────────────────────────────────────────────────┘
```

| 职责划分 | 责任方 |
|---|---|
| 读取本地代码、项目规则、Git 状态 | 本地 AI Agent |
| 证据精简、密钥/凭据脱敏 | 本地 AI Agent 采纳门 |
| 高成本深度逻辑思考 / 复杂方案规划 | 浏览器网页大模型 (Claude, DeepSeek, Gemini 等) |
| 审查方案可行性并拒绝有害操作 | 本地 AI Agent |
| 执行本地代码修改、运行单元测试与构建 | 本地 AI Agent |

---

## 工作流

1. **环境自检**：运行 `node skills/universal-agent-bridge/scripts/doctor.mjs --json`；
2. **构建脱敏上下文包**：提取最小决定性证据（Token < 3000），离线脱敏过滤；
3. **分发至浏览器大模型矩阵**：通过 WebSocket 或油猴长轮询推送到网页端并自动触发思考；
4. **本地确定性核验**：采纳门校验契约完整性、哈希绑定，并在本地运行自动化测试。
