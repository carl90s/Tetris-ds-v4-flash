'use strict';
/**
 * 权重自动搜索：随机采样 + 精英保留迭代，找消行/存活更优的权重组合。
 * 用法：node scripts/search-weights.js [候选数] [每候选局数]
 */
const TetrisGame = require('../game.js');
const AI = require('../ai.js');

const CANDIDATES = Number(process.argv[2] || 80);
const GAMES = Number(process.argv[3] || 3);
const N = 150; // 每局方块上限（搜索用较小值提速）

function runOnce(W) {
  const g = new TetrisGame();
  g.status = 'playing';
  let placed = 0;
  while (placed < N && g.status === 'playing') {
    const plan = AI.planBestPlacement(g, W);
    if (plan) {
      for (let i = 0; i < plan.rot; i++) g.rotate(1);
      let guard = 0;
      while (g.current && g.current.x < plan.col && guard++ < 12) g.tryMove(1, 0);
      while (g.current && g.current.x > plan.col && guard++ < 12) g.tryMove(-1, 0);
      g.hardDrop();
    } else {
      g.hardDrop();
    }
    placed++;
    if (g.status === 'clearing') g.clearRows();
  }
  return { placed, lines: g.lines };
}

function evaluate(W) {
  let placed = 0, lines = 0;
  for (let i = 0; i < GAMES; i++) {
    const r = runOnce(W);
    placed += r.placed;
    lines += r.lines;
  }
  // 目标：存活优先（放置数），消行其次
  return { placed: placed / GAMES, lines: lines / GAMES, score: (placed / GAMES) + (lines / GAMES) * 3 };
}

function randWeight() {
  const r = (lo, hi) => lo + Math.random() * (hi - lo);
  return {
    full: r(500, 1500),
    aggH: r(0.5, 5),
    maxH: r(2, 15),
    holes: r(20, 80),
    bump: r(1, 6),
    rowTrans: r(8, 40),
    landing: r(0, 8),
    well: r(0, 40),
    lookahead: 1 // 搜索用无前瞻（快 100 倍），找到权重后另用深度 2 验证
  };
}

const t0 = Date.now();
// 基准（当前默认权重）
const base = evaluate({ lookahead: 1 });
console.log(`基准权重: 放置 ${base.placed.toFixed(1)} 消行 ${base.lines.toFixed(1)} 目标 ${base.score.toFixed(1)}`);

let elite = [{ w: {}, score: base.score, placed: base.placed, lines: base.lines }];
for (let i = 0; i < CANDIDATES; i++) {
  // 50% 随机采样，50% 基于精英变异
  let w;
  if (elite.length > 1 && Math.random() < 0.5) {
    const e = elite[Math.floor(Math.random() * Math.min(3, elite.length))].w;
    w = {};
    for (const k of Object.keys(e)) {
      if (k === 'lookahead') { w[k] = 2; continue; }
      w[k] = e[k] * (0.8 + Math.random() * 0.4);
    }
  } else {
    w = randWeight();
  }
  const r = evaluate(w);
  elite.push({ w, score: r.score, placed: r.placed, lines: r.lines });
  elite.sort((a, b) => b.score - a.score);
  elite = elite.slice(0, 5);
  if ((i + 1) % 10 === 0) {
    console.log(`候选 ${i + 1}/${CANDIDATES} | 当前最优: 放置 ${elite[0].placed.toFixed(1)} 消行 ${elite[0].lines.toFixed(1)} 目标 ${elite[0].score.toFixed(1)}`);
  }
}
console.log(`\n搜索完成（${((Date.now() - t0) / 1000).toFixed(0)}s），最优权重：`);
console.log(JSON.stringify(elite[0].w));
console.log(`放置 ${elite[0].placed.toFixed(1)} | 消行 ${elite[0].lines.toFixed(1)} | 目标 ${elite[0].score.toFixed(1)} (基准 ${base.score.toFixed(1)})`);
