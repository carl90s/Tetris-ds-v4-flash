'use strict';
/**
 * 深度浏览器模拟：通过 window.__tetris 精确读取每一步游戏内部状态，
 * 统计竖 I 的落点列分布、每局结束原因与列高度，验证"左侧堆墙"。
 * 用法：node scripts/browser-deep.js [rl|heuristic] [局数]
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ENGINE = process.argv[2] || 'rl';
const EPISODES = Number(process.argv[3] || 6);
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 900, height: 1000 });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:8901/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await p.$eval('#ai-engine', (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, ENGINE);
  // 自动训练设大，便于长跑
  await p.$eval('#ai-auto', el => { el.value = 30; el.dispatchEvent(new Event('change')); });

  const iCols = new Map();       // 竖 I 落点列分布
  const overInfo = [];           // 每局结束：原因 + 列高度
  let episodesDone = 0;

  await p.$eval('#btn-ai', el => el.click()); // 开启 AI 托管
  console.log(`引擎 ${ENGINE}，自动训练 30 局，开始深度观察（目标 ${EPISODES} 局）...`);

  let lastPiece = '';
  const deadline = Date.now() + 20 * 60 * 1000; // 上限 20 分钟
  while (episodesDone < EPISODES && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const snap = await p.evaluate(() => {
      const t = window.__tetris;
      if (!t) return null;
      const g = t.game;
      // 列高度
      const hs = [];
      for (let c = 0; c < g.constructor.COLS; c++) {
        let h = 0;
        for (let r = g.constructor.ROWS - 1; r >= 0; r--) { if (g.board[r][c]) { h = g.constructor.ROWS - r; break; } }
        hs.push(h);
      }
      const cur = g.current;
      return {
        status: g.status, lines: g.lines, score: g.score,
        curType: cur ? cur.type : null, curX: cur ? cur.x : null,
        matrix: cur ? JSON.stringify(cur.matrix) : null,
        hs, aiEngine: t.aiEngine, aiMode: t.aiMode, episodes: t.rlAgent.episodes
      };
    });
    if (!snap) continue;
    // 检测"上一块刚锁定"：通过 curType 变化 + 棋盘变化判断落点（简化：用 status 与列高变化）
    if (snap.curType && snap.curType !== lastPiece && lastPiece !== '') {
      // 方块更换 → 上一块已放置；竖 I 判断由 matrix 完成（记录于上一轮）
    }
    lastPiece = snap.curType;

    // 竖 I 落点：从 matrix 判断（竖 I 非零列宽 1），x 为最左列
    if (snap.curType === 'I' && snap.matrix) {
      const m = JSON.parse(snap.matrix);
      let cols = 0;
      for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) if (m[r][c]) cols++;
      const isVertical = m.length === 4 && m[0].filter(v => v).length === 1 && cols === 4;
      if (isVertical && snap.curX !== null) {
        // 当前方块 x 是最左列（含负值）
        const col = snap.curX + m[0].indexOf(1);
        iCols.set(col, (iCols.get(col) || 0) + 1);
      }
    }

    // 检测局结束（over）：单次 evaluate 原子读取完整状态
    const snapOver = await p.evaluate(() => {
      const g = window.__tetris.game;
      if (g.status !== 'over') return null;
      const hs = [];
      for (let c = 0; c < g.constructor.COLS; c++) {
        let h = 0;
        for (let r = g.constructor.ROWS - 1; r >= 0; r--) { if (g.board[r][c]) { h = g.constructor.ROWS - r; break; } }
        hs.push(h);
      }
      return {
        hs,
        top6: g.board.slice(0, 6).map(r => r.map(v => v ? '#' : '.').join('')),
        lines: g.lines, score: g.score,
        generation: g.generation
      };
    });
    if (snapOver) {
      const left = (snapOver.hs[0] + snapOver.hs[1] + snapOver.hs[2]) / 3;
      const right = (snapOver.hs[7] + snapOver.hs[8] + snapOver.hs[9]) / 3;
      overInfo.push({ left: +left.toFixed(1), right: +right.toFixed(1), lines: snapOver.lines, hs: snapOver.hs, top6: snapOver.top6 });
      console.log('[over 原子读取] 左3=' + left.toFixed(1) + ' 右3=' + right.toFixed(1) + ' 列高[' + snapOver.hs.join(',') + '] 消行=' + snapOver.lines);
      console.log('  顶部6行:', JSON.stringify(snapOver.top6));
      episodesDone++;
    }
    // 简单局计数：episodes 增加
    if (snap.episodes > episodesDone && snap.episodes > 0) {
      // RL 局数增加（endEpisode 触发）
    }
  }

  console.log('\n=== 竖 I 落点列分布 ===');
  const sorted = [...iCols.entries()].sort((a, b) => a[0] - b[0]);
  for (const [c, n] of sorted) console.log(`  列${c}: ${n} 次`);
  console.log('over 局数:', overInfo.length, '/', episodesDone);
  if (overInfo.length) {
    const lAvg = overInfo.reduce((s, o) => s + o.left, 0) / overInfo.length;
    const rAvg = overInfo.reduce((s, o) => s + o.right, 0) / overInfo.length;
    console.log(`over 时左3列平均 ${lAvg.toFixed(1)} | 右3列平均 ${rAvg.toFixed(1)}`);
  }
  console.log('errors:', JSON.stringify(errors));
  await p.screenshot({ path: path.join(__dirname, '..', 'shot-deep.png') });
  await ctx.close(); await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
