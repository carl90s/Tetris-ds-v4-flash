'use strict';
/**
 * 后台模拟：完整跑启发式 / RL 各 N 局，统计
 * - 存活方块数 / 消行 / over 率
 * - 结束或中止时左3列 vs 右3列平均高度（验证"左侧堆高"）
 * - 竖 I 放置次数 / 竖 I 消 4 行次数
 * 用法：node scripts/simulate.js [引擎 heuristic|rl] [局数] [每局上限]
 */
const TetrisGame = require('../game.js');
const AI = require('../ai.js');

const engine = process.argv[2] || 'heuristic';
const N = Number(process.argv[3] || 20);
const MAX = Number(process.argv[4] || 300);

function colHeights(g) {
  const hs = [];
  for (let c = 0; c < TetrisGame.COLS; c++) {
    let h = 0;
    for (let r = TetrisGame.ROWS - 1; r >= 0; r--) { if (g.board[r][c]) { h = TetrisGame.ROWS - r; break; } }
    hs.push(h);
  }
  return hs;
}

const rl = engine === 'rl' ? new AI.RLAgent() : null;
if (rl) { rl.eps = 0.05; rl.replayCapacity = 300; }

const stats = { placed: [], lines: [], over: 0, vI: 0, hI: 0, quadClear: 0, leftH: [], rightH: [] };

for (let e = 0; e < N; e++) {
  const g = new TetrisGame();
  g.status = 'playing';
  if (rl) rl.resetEpisode();
  let placed = 0, lines = 0;
  while (g.status === 'playing' && placed < MAX) {
    let plan;
    if (rl) plan = rl.decide(g);
    else plan = AI.planBestPlacement(g);
    const type = g.current ? g.current.type : null;
    const rot = plan ? plan.rot : 0;
    if (plan) {
      for (let i = 0; i < plan.rot; i++) g.rotate(1);
      let guard = 0;
      while (g.current && g.current.x < plan.col && guard++ < 12) g.tryMove(1, 0);
      while (g.current && g.current.x > plan.col && guard++ < 12) g.tryMove(-1, 0);
      g.hardDrop();
    } else {
      g.hardDrop();
    }
    if (type === 'I') {
      // rot 1/3 = 竖 I（初始横）
      if (rot === 1 || rot === 3) stats.vI++; else stats.hI++;
    }
    if (g.status === 'clearing') {
      const cleared = g.clearingRows.length;
      lines += cleared;
      if (cleared === 4 && type === 'I') stats.quadClear++;
      g.clearRows();
    }
    placed++;
    if (g.status === 'over') {
      stats.over++;
      const hs = colHeights(g);
      stats.leftH.push((hs[0] + hs[1] + hs[2]) / 3);
      stats.rightH.push((hs[7] + hs[8] + hs[9]) / 3);
    }
  }
  if (g.status !== 'over') {
    // 达到上限未死：记录当前高度倾向
    const hs = colHeights(g);
    stats.leftH.push((hs[0] + hs[1] + hs[2]) / 3);
    stats.rightH.push((hs[7] + hs[8] + hs[9]) / 3);
  }
  stats.placed.push(placed);
  stats.lines.push(lines);
  if (rl) rl.endEpisode(g.status === 'over');
}

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const overList = stats.placed.filter((_, i) => i < N && (stats.overList = null)); // no-op
console.log(`=== ${engine} ${N} 局（每局上限 ${MAX} 方块）===`);
console.log(`平均放置: ${avg(stats.placed).toFixed(1)} | 平均消行: ${avg(stats.lines).toFixed(1)} | over 率: ${(stats.over / N * 100).toFixed(0)}%`);
console.log(`左3列平均高度(结束/中止时): ${avg(stats.leftH).toFixed(1)} | 右3列: ${avg(stats.rightH).toFixed(1)}`);
console.log(`竖 I 放置: ${stats.vI} 次 | 横 I: ${stats.hI} 次 | 竖 I 消4行: ${stats.quadClear} 次`);
console.log(`存活到上限局数: ${stats.placed.filter(p => p >= MAX).length}/${N}`);
if (stats.over > 0) {
  console.log(`over 的局里，左3列 vs 右3列最大差: ${Math.max(...stats.leftH.map((l, i) => l - stats.rightH[i])).toFixed(1)}`);
}
