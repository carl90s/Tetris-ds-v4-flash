'use strict';
// 诊断 RL 行为：跑 N 局统计 game over 时各列高度分布与 I 块放置偏好
const TetrisGame = require('../game.js');
const AI = require('../ai.js');

const N = Number(process.argv[2] || 15);
const MAX = Number(process.argv[3] || 150);
const rl = new AI.RLAgent();
rl.eps = Number(process.argv[4] || 0.05); // 探索率

let overCount = 0;
let iPlacements = { v: 0, h: 0, colHist: new Array(10).fill(0) };
let leftCount = 0, totalPlaced = 0;

for (let e = 0; e < N; e++) {
  const g = new TetrisGame();
  g.status = 'playing';
  let placed = 0;
  while (g.status === 'playing' && placed < MAX) {
    const plan = rl.decide(g);
    if (plan) {
      for (let i = 0; i < plan.rot; i++) g.rotate(1);
      let guard = 0;
      while (g.current && g.current.x < plan.col && guard++ < 12) g.tryMove(1, 0);
      while (g.current && g.current.x > plan.col && guard++ < 12) g.tryMove(-1, 0);
      const type = g.current.type;
      const wasI = type === 'I';
      g.hardDrop();
      if (wasI) {
        // 记录 I 的放置：竖（矩阵非零列宽 1）或横（非零行宽 4）
        const m = g.current ? null : null; // current 已换新，无法直接判断——用 plan 判断
      }
      totalPlaced++;
      if (plan.col <= 1 || (plan.rot === 1 || plan.rot === 3 ? false : plan.col <= 1)) leftCount++;
    } else {
      g.hardDrop();
    }
    placed++;
    if (g.status === 'clearing') g.clearRows();
  }
  if (g.status === 'over') {
    overCount++;
    const hs = [];
    for (let c = 0; c < 10; c++) {
      let h = 0;
      for (let r = 19; r >= 0; r--) { if (g.board[r][c]) { h = 20 - r; break; } }
      hs.push(h);
    }
    console.log('over 棋盘高度: [' + hs.join(',') + ']');
  }
}
console.log('over 局数: ' + overCount + '/' + N);
