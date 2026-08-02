'use strict';
/**
 * 真实浏览器游玩模拟：puppeteer 打开游戏 → AI 托管自动玩 → 定时抓取棋盘列高度分布。
 * 验证"左侧堆墙"是否真实出现。
 * 用法：node scripts/browser-play.js [rl|heuristic] [秒数]
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const ENGINE = process.argv[2] || 'rl';
const MAX_SECONDS = Number(process.argv[3] || 75);
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

async function colHeights(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('board');
    const ctx = cv.getContext('2d');
    const dpr = cv.width / 300;
    const heights = [];
    for (let c = 0; c < 10; c++) {
      const x = Math.floor((c * 30 + 15) * dpr);
      let h = 0;
      for (let row = 0; row < 20; row++) {
        const y = Math.floor((599 - row * 30 - 15) * dpr);
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (Math.abs(d[0] - 10) + Math.abs(d[1] - 12) + Math.abs(d[2] - 22) > 60) { h = row + 1; break; }
      }
      heights.push(h);
    }
    return heights;
  });
}

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await b.createBrowserContext(); // 隔离 localStorage（干净权重）
  const p = await ctx.newPage();
  await p.setViewport({ width: 900, height: 1000 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  // 选择引擎并开启 AI 托管（自动训练默认 10 局）
  await p.$eval('#ai-engine', (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, ENGINE);
  await p.$eval('#btn-ai', el => el.click());
  console.log('引擎:', ENGINE, '| 已开启 AI 托管，观察中...');

  const deadline = Date.now() + MAX_SECONDS * 1000;
  const samples = [];
  let lastStatus = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await p.$eval('#ai-status', el => el.textContent);
    const score = await p.$eval('#stat-score', el => Number(el.textContent));
    const lines = await p.$eval('#stat-lines', el => Number(el.textContent));
    const hs = await colHeights(p);
    samples.push({ st, score, lines, hs, t: ((MAX_SECONDS * 1000 - (deadline - Date.now())) / 1000).toFixed(0) });
    if (st !== lastStatus) { console.log(`[t=${samples[samples.length-1].t}s] ${st} | 列高 [${hs.join(',')}] 左3=${((hs[0]+hs[1]+hs[2])/3).toFixed(1)} 右3=${((hs[7]+hs[8]+hs[9])/3).toFixed(1)}`); lastStatus = st; }
    // 游戏结束且不再自动重开（自动训练完成）→ 提前退出
    if (st.includes('强化学习托管中') || st.includes('AI 托管中')) break;
  }
  // 汇总
  const lefts = samples.map(s => (s.hs[0] + s.hs[1] + s.hs[2]) / 3);
  const rights = samples.map(s => (s.hs[7] + s.hs[8] + s.hs[9]) / 3);
  const maxLeft = Math.max(...lefts), maxRight = Math.max(...rights);
  console.log('\n=== 汇总 ===');
  console.log(`采样 ${samples.length} 次`);
  console.log(`左3列平均: ${(lefts.reduce((a, b) => a + b, 0) / lefts.length).toFixed(2)} | 右3列平均: ${(rights.reduce((a, b) => a + b, 0) / rights.length).toFixed(2)}`);
  console.log(`左3列最大: ${maxLeft.toFixed(1)} | 右3列最大: ${maxRight.toFixed(1)}`);
  console.log(`最终分数: ${samples[samples.length-1].score} | 消行: ${samples[samples.length-1].lines}`);
  console.log('errors:', JSON.stringify(errors));
  await p.screenshot({ path: require('path').join(__dirname, '..', 'shot-browser-play.png') });
  await ctx.close(); await b.close();
  const asymmetric = maxLeft > maxRight + 6;
  console.log(asymmetric ? '判定: ⚠ 左侧明显堆高' : '判定: ✅ 左右对称');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
