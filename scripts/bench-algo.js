'use strict';
/**
 * 算法引擎基准：随机 7 袋方块跑 N 个，统计消行 / 存活 / 得分。
 * 权重可通过环境变量覆盖：W_FULL W_AGGH W_MAXH W_HOLES W_BUMP W_ROWTRANS
 * 用法：node scripts/bench-algo.js [方块数] [重复次数]
 */
const TetrisGame = require('../game.js');
const AI = require('../ai.js');

const W = {
  full: Number(process.env.W_FULL || 760),
  aggH: Number(process.env.W_AGGH || 1.5),
  maxH: Number(process.env.W_MAXH || 4),
  holes: Number(process.env.W_HOLES || 35),
  bump: Number(process.env.W_BUMP || 2),
  rowTrans: Number(process.env.W_ROWTRANS || 18),
  lookahead: process.env.W_LOOKAHEAD === '0' ? false : true
};

function runOnce(N) {
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
  return { placed, lines: g.lines, score: g.score, over: g.status === 'over' };
}

const N = Number(process.argv[2] || 300);
const R = Number(process.argv[3] || 5);
const results = [];
for (let i = 0; i < R; i++) results.push(runOnce(N));

const avg = k => (results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(1);
console.log(`权重 full=${W.full} aggH=${W.aggH} maxH=${W.maxH} holes=${W.holes} bump=${W.bump} rowTrans=${W.rowTrans}`);
console.log(`${R} 局 × 最多 ${N} 方块：平均放置 ${avg('placed')} 个 | 消行 ${avg('lines')} 行 | 得分 ${avg('score')} | 存活率 ${results.filter(r => r.placed >= N).length}/${R}`);
