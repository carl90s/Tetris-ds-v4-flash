'use strict';
/**
 * AI 真实调用调试：复现游戏内 AI 的完整请求（同样的 system/user prompt + response_format），
 * 打印模型原始返回，分析为什么解析失败。
 * 用法：DEEPSEEK_KEY=sk-xxx node scripts/ai-live.js [batchSize] [model]
 */
const AI = require('../ai.js');
const TetrisGame = require('../game.js');

const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) {
  console.error('请设置环境变量 DEEPSEEK_KEY，例如：$env:DEEPSEEK_KEY="sk-xxx"; node scripts/ai-live.js');
  process.exit(1);
}

const BATCH = Number(process.argv[2] || 3); // 1 = 单回合，3 = 批量
const MODEL = process.argv[3] || 'deepseek-chat';

const g = new TetrisGame();
g.status = 'playing';

const system = AI.buildSystemPrompt();
const user = AI.buildUserPrompt(g, BATCH);

console.log('=== 请求参数 ===');
console.log('模型:', MODEL, '| 批量:', BATCH, '| max_tokens: 1024 | response_format: json_object');
console.log('--- system prompt（前 200 字）---');
console.log(system.slice(0, 200));
console.log('--- user prompt ---');
console.log(user);

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ],
  temperature: 0.2,
  max_tokens: 1024,
  stream: false,
  response_format: { type: 'json_object' }
};

(async () => {
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    console.log('\n=== 调用结果 ===');
    console.log('HTTP:', resp.status, '| 耗时:', ((Date.now() - t0) / 1000).toFixed(1), 's');
    if (!resp.ok) {
      console.log('错误响应:', JSON.stringify(data, null, 2));
      process.exit(1);
    }
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    console.log('--- choices[0].message 全部字段 ---');
    console.log(JSON.stringify(msg, null, 2));
    console.log('\n--- content 原样 ---');
    console.log('"' + (msg.content || '') + '"');
    console.log('\n--- 解析结果（parseResponse） ---');
    const parsed = AI.parseResponse(msg.content || '');
    console.log(JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.error('\n调用异常:', e.message);
    process.exit(1);
  }
})();
