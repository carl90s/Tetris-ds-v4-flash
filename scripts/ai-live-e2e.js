'use strict';
/**
 * 真实 API 端到端验证：无头浏览器 + 真实 DeepSeek key 跑完整 AI 托管流程。
 * 用法：DEEPSEEK_KEY=sk-xxx node scripts/ai-live-e2e.js
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) { console.error('请设置 DEEPSEEK_KEY'); process.exit(1); }

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  await page.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // 点“开启 AI 托管”（未配置 → 弹窗）
  await page.$eval('#btn-ai', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  // 填入真实配置
  await page.$eval('#ai-baseurl', el => { el.value = 'https://api.deepseek.com'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#ai-apikey', (el, k) => { el.value = k; el.dispatchEvent(new Event('input')); }, KEY);
  await page.$eval('#ai-model', el => { el.value = 'deepseek-v4-flash'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#ai-save', el => el.click()); // 保存并自动开启托管

  console.log('=== 真实 API AI 托管观察（15 秒） ===');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await page.evaluate(() => ({
      score: Number(document.getElementById('stat-score').textContent),
      lines: Number(document.getElementById('stat-lines').textContent),
      status: document.getElementById('ai-status').textContent,
      btnOn: document.getElementById('btn-ai').classList.contains('on')
    }));
    console.log(`[t${i}] on=${s.btnOn} score=${s.score} lines=${s.lines} status="${s.status}"`);
  }
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
  const ok = errors.length === 0;
  console.log(ok ? 'LIVE RESULT: PASS' : 'LIVE RESULT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('LIVE FAILED:', e.message); process.exit(1); });
