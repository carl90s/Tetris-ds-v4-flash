'use strict';
/**
 * RL 学习基准：跑 N 局（含在线学习），比较前/后段表现验证学习有效。
 * 用法：node scripts/bench-rl.js [局数] [每局上限方块]
 */
const TetrisGame = require('../game.js');
const AI = require('../ai.js');

const N = Number(process.argv[2] || 60);
const MAX = Number(process.argv[3] || 500);

const rl = new AI.RLAgent();
rl.eps = 0.12; // 保持适量探索便于学习

const results = [];
for (let e = 0; e < N; e++) {
  const g = new TetrisGame();
  g.status = 'playing';
  rl.resetEpisode();
  let placed = 0;
  while (placed < MAX && g.status === 'playing') {
    const plan = rl.decide(g);
    if (plan) {
      for (let i = 0; i < plan.rot; i++) g.rotate(1);
      let guard = 0;
      while (g.current && g.current.x < plan.col && guard++ < 12) g.tryMove(1, 0);
      while (g.current && g.current.x > plan.col && guard++ < 12) g.tryMove(-1, 0);
      g.hardDrop();
      rl.observe(plan.phi, g);
    } else {
      g.hardDrop();
    }
    placed++;
    if (g.status === 'clearing') g.clearRows();
  }
  rl.endEpisode(g.status === 'over');
  results.push({ placed, lines: g.lines });
}

const avg = arr => (arr.length ? arr.reduce((s, r) => s + r, 0) / arr.length : 0);
const third = Math.max(1, Math.floor(N / 3));
const head = results.slice(0, third);
const tail = results.slice(-third);
console.log(`RL 学习 ${N} 局（每局上限 ${MAX} 方块）`);
console.log(`前 ${third} 局：平均放置 ${avg(head.map(r => r.placed)).toFixed(1)} | 消行 ${avg(head.map(r => r.lines)).toFixed(1)}`);
console.log(`后 ${third} 局：平均放置 ${avg(tail.map(r => r.placed)).toFixed(1)} | 消行 ${avg(tail.map(r => r.lines)).toFixed(1)}`);
console.log('最终权重:', JSON.stringify(rl.getWeights()));
const improved = avg(tail.map(r => r.lines)) > avg(head.map(r => r.lines));
console.log(improved ? 'RESULT: 学习有效（后段优于前段）' : 'RESULT: 未见提升');
