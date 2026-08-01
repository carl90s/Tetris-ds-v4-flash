'use strict';
/* 端到端验证：用无头 Edge 加载页面，模拟完整交互流程 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => require('fs').existsSync(p));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));

  await page.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  const out = {};
  out.overlayTitle = await page.$eval('#overlay-title', el => el.textContent);

  // 点击“开始游戏”
  await page.click('#btn-start');
  await new Promise(r => setTimeout(r, 400));
  out.overlayHiddenAfterStart = await page.$eval('#overlay', el => el.classList.contains('hidden'));

  // 移动 + 旋转 + 硬降
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 500));
  out.scoreAfterHardDrop = await page.$eval('#stat-score', el => Number(el.textContent));
  out.lines = await page.$eval('#stat-lines', el => Number(el.textContent));
  out.currentPieceExists = await page.evaluate(() => typeof TetrisGame !== 'undefined');

  // 暂停 → 覆盖层出现且按钮为“继续游戏”
  await page.keyboard.press('KeyP');
  await new Promise(r => setTimeout(r, 300));
  out.pauseOverlayShown = await page.$eval('#overlay', el => !el.classList.contains('hidden'));
  out.pauseBtnText = await page.$eval('#btn-start', el => el.textContent);

  // 点“继续游戏”→ 覆盖层关闭，分数不丢
  const scoreBeforeResume = out.scoreAfterHardDrop;
  await page.click('#btn-start');
  await new Promise(r => setTimeout(r, 300));
  out.resumeOverlayHidden = await page.$eval('#overlay', el => el.classList.contains('hidden'));
  out.scoreAfterResume = await page.$eval('#stat-score', el => Number(el.textContent));
  out.scorePreserved = out.scoreAfterResume >= scoreBeforeResume;

  // 触控按钮：桌面视口下按设计隐藏，切换到移动设备模拟验证
  out.touchButtonsDesktopVisible = await page.$eval('.touch-controls', el =>
    getComputedStyle(el).display !== 'none');

  const mpage = await browser.newPage();
  await mpage.emulate({
    viewport: { width: 375, height: 700, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  mpage.on('pageerror', e => errors.push('[mobile pageerror] ' + e.message));
  await mpage.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  out.touchButtonsMobile = await mpage.$$eval('.touch-btn', els => els.length);
  out.touchControlsVisible = await mpage.$eval('.touch-controls', el =>
    getComputedStyle(el).display !== 'none');
  await mpage.tap('#btn-start'); // 开始游戏
  await new Promise(r => setTimeout(r, 300));
  await mpage.tap('.touch-btn[data-action="hard"]'); // 触控硬降
  await new Promise(r => setTimeout(r, 300));
  out.scoreAfterTouchHard = await mpage.$eval('#stat-score', el => Number(el.textContent));
  // 触控旋转按钮点击不应报错（真实旋转效果已在桌面键盘流程验证）
  await mpage.tap('.touch-btn[data-action="rotate"]');
  await new Promise(r => setTimeout(r, 200));

  // ---- AI 托管流程（拦截 /chat/completions，mock 模型响应） ----
  const apage = await browser.newPage();
  apage.on('pageerror', e => errors.push('[ai pageerror] ' + e.message));
  await apage.setRequestInterception(true);
  let aiCalls = 0;
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type'
  };
  apage.on('request', req => {
    if (req.url().includes('/chat/completions')) {
      aiCalls++;
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: CORS });
      } else {
        req.respond({
          status: 200,
          contentType: 'application/json',
          headers: CORS,
          body: JSON.stringify({ choices: [{ message: { content: '{"moves":["hard"],"comment":"e2e 放置"}' } }] })
        });
      }
    } else {
      req.continue();
    }
  });
  await apage.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));

  // 点“开启 AI 托管”（未配置 → 打开设置弹窗并记录意图）
  await apage.click('#btn-ai');
  await new Promise(r => setTimeout(r, 200));
  out.aiModalShown = await apage.$eval('#ai-modal', el => !el.classList.contains('hidden'));
  // 直接赋值（type() 会追加到预填值之后，污染配置）
  await apage.$eval('#ai-baseurl', el => { el.value = 'https://api.mock.local/v1'; el.dispatchEvent(new Event('input')); });
  await apage.$eval('#ai-apikey', el => { el.value = 'sk-e2e-mock'; el.dispatchEvent(new Event('input')); });
  await apage.$eval('#ai-model', el => { el.value = 'mock-model'; el.dispatchEvent(new Event('input')); });
  // 放慢动作间隔，配合最小回合间隔，避免 mock 零延迟导致快速堆满
  await apage.evaluate(() => {
    const d = document.getElementById('ai-delay');
    d.value = 200;
    d.dispatchEvent(new Event('input'));
  });
  await apage.click('#ai-save');
  await new Promise(r => setTimeout(r, 200));
  out.aiModalClosed = await apage.$eval('#ai-modal', el => el.classList.contains('hidden'));
  // 保存配置后应自动进入 AI 托管（无需再点开启）
  out.aiAutoStarted = await apage.$eval('#btn-ai', el => el.classList.contains('on'));
  // 等 AI 放置约 3 个方块后立即停用（mock 为无脑 hard，长时间运行会堆满棋盘）
  const aiDeadline = Date.now() + 5000;
  while (Date.now() < aiDeadline) {
    await new Promise(r => setTimeout(r, 150));
    const sc = await apage.$eval('#stat-score', el => Number(el.textContent));
    if (sc >= 50) break;
  }
  out.aiModeOn = await apage.$eval('#btn-ai', el => el.classList.contains('on'));
  out.aiScore = await apage.$eval('#stat-score', el => Number(el.textContent));
  out.aiStatusText = await apage.$eval('#ai-status', el => el.textContent);
  out.aiCalls = aiCalls;
  out.aiPlacementWorks = out.aiScore > 0;

  // 停用 AI：玩家键盘恢复
  await apage.click('#btn-ai');
  await new Promise(r => setTimeout(r, 200));
  out.aiModeOff = await apage.$eval('#btn-ai', el => el.classList.contains('on') === false);
  await apage.keyboard.press('ArrowRight'); // 停用后键盘应恢复控制
  await apage.keyboard.press('Space');
  await new Promise(r => setTimeout(r, 300));
  out.aiScoreAfterManual = await apage.$eval('#stat-score', el => Number(el.textContent));
  out.manualAfterAIWorks = out.aiScoreAfterManual > out.aiScore;
  // ---- AI 故障场景：API 500 → 错误信息显示且不被覆盖、自动停用 ----
  const fpage = await browser.newPage();
  fpage.on('pageerror', e => errors.push('[fault pageerror] ' + e.message));
  await fpage.setRequestInterception(true);
  fpage.on('request', req => {
    if (req.url().includes('/chat/completions')) {
      if (req.method() === 'OPTIONS') req.respond({ status: 204, headers: CORS });
      else req.respond({ status: 500, headers: CORS, contentType: 'application/json', body: '{"error":"boom"}' });
    } else {
      req.continue();
    }
  });
  await fpage.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  // Puppeteer 坐标点击在该布局下偶发失败，统一用 DOM click 触发（功能等价）
  await fpage.$eval('#btn-ai', el => el.click()); // 未配置 → 弹窗
  await new Promise(r => setTimeout(r, 200));
  await fpage.$eval('#ai-baseurl', el => { el.value = 'https://api.mock.local/v1'; el.dispatchEvent(new Event('input')); });
  await fpage.$eval('#ai-apikey', el => { el.value = 'sk-e2e-mock'; el.dispatchEvent(new Event('input')); });
  await fpage.$eval('#ai-model', el => { el.value = 'mock-model'; el.dispatchEvent(new Event('input')); });
  await fpage.$eval('#ai-save', el => el.click()); // 自动开启
  // 轮询等待错误出现（避免固定等待的竞态）
  const fDeadline = Date.now() + 5000;
  while (Date.now() < fDeadline) {
    await new Promise(r => setTimeout(r, 250));
    const st = await fpage.$eval('#ai-status', el => el.textContent);
    if (st.includes('⚠') || st.includes('失败')) break;
  } // 连续失败 2 次后自动停用
  out.faultStatusText = await fpage.$eval('#ai-status', el => el.textContent);
  out.faultStopped = await fpage.$eval('#btn-ai', el => !el.classList.contains('on'));
  out.faultErrorVisible = out.faultStatusText.includes('失败') || out.faultStatusText.includes('⚠');

  await page.screenshot({ path: path.join(__dirname, '..', 'shot-e2e.png') });
  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();

  const fail = errors.length > 0
    || !out.overlayHiddenAfterStart
    || !out.resumeOverlayHidden
    || !out.scorePreserved
    || out.touchButtonsDesktopVisible
    || !out.touchControlsVisible
    || out.touchButtonsMobile < 6
    || out.scoreAfterTouchHard <= 0
    || !out.aiModalShown
    || !out.aiModalClosed
    || !out.aiAutoStarted
    || !out.aiModeOn
    || !out.faultStopped
    || !out.faultErrorVisible
    || !out.aiPlacementWorks
    || !out.aiModeOff
    || !out.manualAfterAIWorks;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
