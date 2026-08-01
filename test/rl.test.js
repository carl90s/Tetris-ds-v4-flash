'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const AI = require('../ai.js');
const { RLAgent, enumeratePlacements } = AI;

function playingGame() {
  const g = new TetrisGame();
  g.status = 'playing';
  return g;
}

test('RLAgent：decide 返回有效落点与特征', () => {
  const g = playingGame();
  const rl = new RLAgent();
  const plan = rl.decide(g);
  assert.ok(plan, '应有落点');
  assert.ok(plan.rot >= 0 && plan.rot <= 3);
  assert.ok(plan.col >= 0 && plan.col <= 9);
  assert.ok(plan.phi && typeof plan.phi.full === 'number');
  assert.ok(Number.isFinite(rl.q(plan.phi)));
});

test('enumeratePlacements：空棋盘枚举 40 个候选', () => {
  const g = playingGame();
  const cands = enumeratePlacements(g);
  assert.ok(cands.length >= 10, '至少 10 列 × 若干旋转');
  for (const c of cands) {
    assert.ok(typeof c.phi.aggH === 'number');
  }
});

test('RLAgent：初始权重与启发式一致（q 计算）', () => {
  const rl = new RLAgent();
  const phi = { full: 1, aggH: 10, maxH: 5, holes: 2, bump: 3, rowTrans: 20 };
  const q = rl.q(phi);
  const expected = 760 * 1 - 1.5 * 10 - 4 * 5 - 35 * 2 - 2 * 3 - 18 * 20;
  assert.ok(Math.abs(q - expected) < 1e-9);
});

test('RLAgent：observe 步级学习更新权重且不爆炸', () => {
  const rl = new RLAgent();
  const g = playingGame();
  for (let i = 0; i < 20; i++) {
    rl.observe({ full: 1, aggH: 4, maxH: 2, holes: 0, bump: 1, rowTrans: 8 }, g);
  }
  assert.ok(rl.w.every(v => Number.isFinite(v)), '权重应保持有限');
  assert.ok(rl.w[0] !== 760 || rl.w[1] !== 1.5, '权重应产生学习变化');
  assert.ok(rl.steps.length === 20, '应记录 20 步');
});

test('RLAgent：endEpisode 结算并衰减探索', () => {
  const rl = new RLAgent();
  const eps0 = rl.eps;
  const g = playingGame();
  for (let i = 0; i < 5; i++) {
    rl.observe({ full: 0, aggH: 10, maxH: 6, holes: 3, bump: 4, rowTrans: 20 }, g);
  }
  rl.endEpisode(true);
  assert.ok(rl.eps < eps0, '探索率应衰减');
  assert.equal(rl.episodes, 1);
  assert.equal(rl.steps.length, 0, '回合结束应清空步记录');
});
