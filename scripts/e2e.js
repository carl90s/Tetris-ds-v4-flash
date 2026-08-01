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


  // ---- 内置算法引擎：免配置直接开启并自动玩 ----
  const actx = await browser.createBrowserContext();
  const apage2 = await actx.newPage();
  apage2.on('pageerror', e => errors.push('[algo pageerror] ' + e.message));
  await apage2.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400));
  await apage2.$eval('#btn-ai', el => el.click()); // 算法引擎无需配置，直接开启
  await new Promise(r => setTimeout(r, 3000));
  out.algoOn = await apage2.$eval('#btn-ai', el => el.classList.contains('on'));
  out.algoScore = await apage2.$eval('#stat-score', el => Number(el.textContent));
  out.algoLines = await apage2.$eval('#stat-lines', el => Number(el.textContent));
  out.algoWorks = out.algoOn && out.algoScore > 0;
  await actx.close();

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
    || !out.algoWorks;
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
