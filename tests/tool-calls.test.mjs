/**
 * Tool-use / function-calling 解析逻辑测试
 *
 * 覆盖 openai-api.mjs 里与 tools 相关的纯逻辑：
 *   - buildToolProtocolPrompt   协议文案是否要求 code fence
 *   - buildBlocks               消息分类 + alwaysSend + tool_call_id 映射
 *   - parseToolCallsFromContent 从任意形态的模型输出提取 tool_calls
 *   - extractJsonObjects        括号平衡扫描（未闭合 { 不终止扫描）
 *   - stripToolSyntax           清理残留标签和 DeepSeek 控制 token
 *   - cleanStreamText           流式期间截断 tool_call 区块
 *
 * 这些方法都是 OpenAIApiServer 的实例方法，可以直接 new 出来调用，
 * 不需要真正 listen 端口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIApiServer } from '../skills/universal-agent-bridge/scripts/openai-api.mjs';

// 单例即可：所有被测方法都是纯函数（无共享状态）
const srv = new OpenAIApiServer();

// ---------------------------------------------------------------------------
// buildToolProtocolPrompt
// ---------------------------------------------------------------------------

test.describe('buildToolProtocolPrompt', () => {
  const tools = [
    { type: 'function', function: { name: 'list_dir', description: 'List dir', parameters: {} } },
    { type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } },
  ];

  test('要求 JSON 放在 ```json code fence 内', () => {
    const prompt = srv.buildToolProtocolPrompt(tools);
    assert.match(prompt, /```json/);
    assert.match(prompt, /<tool_call>/);
    assert.match(prompt, /<\/tool_call>/);
  });

  test('列出所有可用工具名', () => {
    const prompt = srv.buildToolProtocolPrompt(tools);
    assert.ok(prompt.includes('list_dir'));
    assert.ok(prompt.includes('read_file'));
  });

  test('包含禁止嵌套和禁止控制 token 的规则', () => {
    const prompt = srv.buildToolProtocolPrompt(tools);
    assert.match(prompt, /NO NESTING/i);
    assert.match(prompt, /NO CONTROL TOKENS/i);
    assert.match(prompt, /DSML/i);
  });

  test('无 tools 时退化到 (none)', () => {
    const prompt = srv.buildToolProtocolPrompt([]);
    assert.ok(prompt.includes('(none)'));
  });
});

// ---------------------------------------------------------------------------
// buildBlocks
// ---------------------------------------------------------------------------

test.describe('buildBlocks', () => {
  test('system 消息独立成块', () => {
    const blocks = srv.buildBlocks([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ], null);
    assert.strictEqual(blocks[0].kind, 'system');
    assert.strictEqual(blocks[0].content, 'You are helpful.');
  });

  test('tools + tool_protocol 成对出现', () => {
    const tools = [{ type: 'function', function: { name: 'foo', parameters: {} } }];
    const blocks = srv.buildBlocks([{ role: 'user', content: 'hi' }], tools);
    assert.ok(blocks.find(b => b.kind === 'tools'));
    assert.ok(blocks.find(b => b.kind === 'tool_protocol'));
  });

  test('<workspace_info> 打 alwaysSend 标记', () => {
    const blocks = srv.buildBlocks([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<workspace_info>\n/path/to/ws\n</workspace_info>' },
      { role: 'user', content: 'hello' },
    ], null);
    const ws = blocks.find(b => b.content.includes('<workspace_info>'));
    assert.ok(ws, 'workspace_info block should exist');
    assert.strictEqual(ws.alwaysSend, true);
  });

  test('<environment_info> / <userMemory> 等也打 alwaysSend', () => {
    for (const marker of ['<environment_info>', '<userMemory>', '<sessionMemory>', '<repoMemory>']) {
      const blocks = srv.buildBlocks([
        { role: 'user', content: `${marker}\nbody\n` },
        { role: 'user', content: 'hi' },
      ], null);
      const ctx = blocks.find(b => b.content.includes(marker));
      assert.ok(ctx, `${marker} block should exist`);
      assert.strictEqual(ctx.alwaysSend, true, `${marker} should be alwaysSend`);
    }
  });

  test('普通历史 user 消息不打 alwaysSend', () => {
    const blocks = srv.buildBlocks([
      { role: 'user', content: 'first turn' },
      { role: 'user', content: 'second turn' },
    ], null);
    // 历史消息 kind=context，但没有 alwaysSend
    const ctx = blocks.find(b => b.kind === 'context');
    assert.ok(ctx);
    assert.notStrictEqual(ctx.alwaysSend, true);
  });

  test('最后一条 user 是 turn，永远发送', () => {
    const blocks = srv.buildBlocks([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'new' },
    ], null);
    const turn = blocks.find(b => b.kind === 'turn');
    assert.ok(turn);
    assert.strictEqual(turn.content, 'new');
  });

  test('assistant 消息被忽略', () => {
    const blocks = srv.buildBlocks([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello from assistant' },
      { role: 'user', content: 'bye' },
    ], null);
    assert.ok(!blocks.some(b => b.content.includes('hello from assistant')));
  });

  test('tool_call_id 映射回工具名', () => {
    const blocks = srv.buildBlocks([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'a\nb\nc' },
      { role: 'user', content: 'next' },
    ], null);
    const tr = blocks.find(b => b.kind === 'tool_result');
    assert.ok(tr);
    assert.match(tr.content, /tool=list_dir/);
    assert.match(tr.content, /a\nb\nc/);
  });

  test('未知 tool_call_id 退化为 unknown_tool', () => {
    const blocks = srv.buildBlocks([
      { role: 'tool', tool_call_id: 'call_unknown', content: 'x' },
      { role: 'user', content: 'next' },
    ], null);
    const tr = blocks.find(b => b.kind === 'tool_result');
    assert.match(tr.content, /tool=unknown_tool/);
  });
});

// ---------------------------------------------------------------------------
// parseToolCallsFromContent
// ---------------------------------------------------------------------------

test.describe('parseToolCallsFromContent', () => {
  test('识别代码块包裹的标准格式', () => {
    const content = [
      '<tool_call>',
      '```json',
      '{"name": "list_dir", "arguments": {"path": "/tmp"}}',
      '```',
      '</tool_call>',
    ].join('\n');
    const { toolCalls, cleanContent } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].function.name, 'list_dir');
    assert.deepStrictEqual(JSON.parse(toolCalls[0].function.arguments), { path: '/tmp' });
    assert.ok(!cleanContent.includes('<tool_call>'));
    assert.ok(!cleanContent.includes('```json'));
  });

  test('识别裸 JSON（无标签无 fence）', () => {
    const content = '{"name": "read_file", "arguments": {"filePath": "/a", "startLine": 1, "endLine": 10}}';
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].function.name, 'read_file');
  });

  test('识别多个连续的 fenced tool_call', () => {
    const content = [
      '<tool_call>',
      '```json',
      '{"name": "read_file", "arguments": {"filePath": "/a", "startLine": 1, "endLine": 10}}',
      '```',
      '</tool_call>',
      '<tool_call>',
      '```json',
      '{"name": "read_file", "arguments": {"filePath": "/b", "startLine": 1, "endLine": 10}}',
      '```',
      '</tool_call>',
    ].join('\n');
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 2);
    assert.deepStrictEqual(JSON.parse(toolCalls[0].function.arguments).filePath, '/a');
    assert.deepStrictEqual(JSON.parse(toolCalls[1].function.arguments).filePath, '/b');
  });

  test('容错：嵌套的 <tool_call>（模型偶尔错写成嵌套）', () => {
    // 历史 bug：非贪婪正则匹配到第一个 </tool_call> 就停，
    // 内部包含另一个 <tool_call> 导致 JSON.parse 失败。现在走 JSON
    // 扫描，理应两个都能提取。
    const content = [
      '<tool_call>',
      '{"name": "read_file", "arguments": {"filePath": "/a", "startLine": 1, "endLine": 10}}',
      '<tool_call>',
      '{"name": "read_file", "arguments": {"filePath": "/b", "startLine": 1, "endLine": 10}}',
      '</tool_call>',
      '</tool_call>',
    ].join('\n');
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 2);
  });

  test('容错：DeepSeek DSML 控制 token 被忽略', () => {
    const content = [
      'I will list the directory.',
      '<｜｜DSML｜｜ calls>',
      '{"name": "list_dir", "arguments": {"path": "/tmp"}}',
    ].join('\n');
    const { toolCalls, cleanContent } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 1);
    assert.ok(!cleanContent.includes('｜'));
    assert.ok(!cleanContent.includes('DSML'));
  });

  test('非法 JSON 被跳过', () => {
    const content = '<tool_call>{"name": "list_dir", "arguments": {broken}</tool_call>';
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 0);
  });

  test('缺少 name 字段的 JSON 被跳过', () => {
    const content = '{"foo": "bar", "arguments": {}}';
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 0);
  });

  test('缺少 arguments 字段的 JSON 被跳过', () => {
    const content = '{"name": "list_dir"}';
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 0);
  });

  test('arguments 是字符串时原样保留', () => {
    const content = '{"name": "bash", "arguments": "{\\"command\\":\\"ls\\"}"}';
    const { toolCalls } = srv.parseToolCallsFromContent(content);
    assert.strictEqual(toolCalls.length, 1);
    // OpenAI 规范要求 arguments 是 JSON 字符串
    assert.strictEqual(typeof toolCalls[0].function.arguments, 'string');
  });

  test('空输入返回空结果', () => {
    const { toolCalls, cleanContent } = srv.parseToolCallsFromContent('');
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleanContent, '');
  });

  test('无 tool_call 的纯文本原样返回', () => {
    const { toolCalls, cleanContent } = srv.parseToolCallsFromContent('Hello, world!');
    assert.deepStrictEqual(toolCalls, []);
    assert.strictEqual(cleanContent, 'Hello, world!');
  });
});

// ---------------------------------------------------------------------------
// extractJsonObjects —— 括号平衡扫描
// ---------------------------------------------------------------------------

test.describe('extractJsonObjects', () => {
  test('正确处理嵌套对象', () => {
    // 注意：extractJsonObjects 只返回含 "name": 字段的候选对象（它是
    // tool_call 扫描器，不是通用 JSON 扫描器）。所以测试输入必须带
    // name 字段，才能验证"括号平衡匹配能穿透多层嵌套"这一核心行为。
    const text = '{"name": "foo", "arguments": {"a": {"b": {"c": 1}}}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 1);
    const parsed = JSON.parse(objs[0].json);
    assert.strictEqual(parsed.name, 'foo');
    assert.deepStrictEqual(parsed.arguments, { a: { b: { c: 1 } } });
  });

  test('跳过不含 "name" 字段的 JSON', () => {
    const text = '{"a": {"b": 1}} and {"name": "foo", "arguments": {}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 1, 'only the name-bearing object should be returned');
    assert.strictEqual(JSON.parse(objs[0].json).name, 'foo');
  });

  test('正确处理字符串里的花括号', () => {
    const text = '{"name": "x", "arguments": {"code": "func() { return 1; }"}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 1);
    // 应完整匹配，不会在中间的第一个 } 就结束
    assert.strictEqual(objs[0].json, text);
  });

  test('正确处理字符串里的转义引号', () => {
    const text = '{"name": "x", "arguments": {"msg": "a\\"b}"}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 1);
    assert.strictEqual(objs[0].json, text);
  });

  test('回归：未闭合的 { 不终止后续扫描', () => {
    // 历史 bug：if (end === -1) break; 会丢弃整个文本里后续所有 JSON
    const text = 'Prefix { invalid\n{"name": "x", "arguments": {}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 1, 'should find the valid object after the unclosed brace');
    assert.strictEqual(JSON.parse(objs[0].json).name, 'x');
  });

  test('多个独立 JSON 对象按出现顺序返回', () => {
    const text = '{"name": "a", "arguments": {}} and {"name": "b", "arguments": {}}';
    const objs = srv.extractJsonObjects(text);
    assert.strictEqual(objs.length, 2);
    assert.strictEqual(JSON.parse(objs[0].json).name, 'a');
    assert.strictEqual(JSON.parse(objs[1].json).name, 'b');
  });

  test('无 { 时返回空数组', () => {
    const objs = srv.extractJsonObjects('no braces here');
    assert.deepStrictEqual(objs, []);
  });
});

// ---------------------------------------------------------------------------
// stripToolSyntax / cleanStreamText
// ---------------------------------------------------------------------------

test.describe('stripToolSyntax', () => {
  test('清理成对 <tool_call> 标签', () => {
    const out = srv.stripToolSyntax('a <tool_call> b </tool_call> c');
    assert.strictEqual(out, 'a  b  c');
  });

  test('清理孤立 </tool_call> 标签', () => {
    const out = srv.stripToolSyntax('text </tool_call> more');
    assert.ok(!out.includes('</tool_call>'));
  });

  test('清理 DeepSeek DSML 控制 token', () => {
    const out = srv.stripToolSyntax('<｜｜DSML｜｜ calls>\nbody');
    assert.ok(!out.includes('｜'));
    assert.ok(out.includes('body'));
  });

  test('清理残留的空 code fence', () => {
    const out = srv.stripToolSyntax('before\n```json\n```\nafter');
    assert.ok(!out.includes('```json'));
    assert.ok(out.includes('before'));
    assert.ok(out.includes('after'));
  });
});

test.describe('cleanStreamText', () => {
  test('移除已闭合的 tool_call 块', () => {
    const out = srv.cleanStreamText('Hello <tool_call>{"x":1}</tool_call> world');
    assert.strictEqual(out, 'Hello  world');
  });

  test('遇到未闭合 <tool_call> 时截断', () => {
    const out = srv.cleanStreamText('Hello world <tool_call>{"name": "x"');
    assert.strictEqual(out, 'Hello world ');
  });

  test('遇到 DeepSeek 特殊 token 时截断', () => {
    const out = srv.cleanStreamText('Hello <｜｜DSML｜｜ calls>');
    assert.strictEqual(out, 'Hello ');
  });

  test('无 tool_call 时原样返回', () => {
    const out = srv.cleanStreamText('plain text');
    assert.strictEqual(out, 'plain text');
  });
});