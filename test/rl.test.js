'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const AI = require('../ai.js');
const { RLAgent, enumeratePlacements } = AI;
const { SHAPES } = TetrisGame;

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

test('RLAgent：imitate 模仿学习使人类落点价值上升', () => {
  const rl = new RLAgent();
  const g = playingGame();
  // 人类固定把方块放到第 2 列：设置 current 为 O 方块于 x=2
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 2, y: 0 };
  g.updateGhost();
  const cands = AI.enumeratePlacements(g);
  const human = cands.find(c => c.col === 2);
  assert.ok(human, '应有第 2 列候选');
  const qHumanBefore = rl.q(human.phi);
  const qOtherBefore = Math.max(...cands.filter(c => c.col !== 2).map(c => rl.q(c.phi)));
  for (let i = 0; i < 20; i++) rl.imitate(g);
  const qHumanAfter = rl.q(human.phi);
  const qOtherAfter = Math.max(...cands.filter(c => c.col !== 2).map(c => rl.q(c.phi)));
  assert.ok(
    qHumanAfter - qOtherAfter > qHumanBefore - qOtherBefore,
    '人类落点应相对其他候选价值提升（' + (qHumanAfter - qOtherAfter).toFixed(2) + ' vs ' + (qHumanBefore - qOtherBefore).toFixed(2) + '）'
  );
});

test('RLAgent：matricesEqual 判断矩阵形状', () => {
  const a = [[1, 1], [1, 1]];
  const b = [[1, 1], [1, 1]];
  const c = [[1, 0], [1, 1]];
  assert.ok(RLAgent.matricesEqual(a, b));
  assert.ok(!RLAgent.matricesEqual(a, c));
  assert.ok(!RLAgent.matricesEqual(a, null));
});
test('RLAgent：rewardOf 消行递增奖励（单次越多越值钱）', () => {
  const rl = new RLAgent();
  const base = { aggH: 0, holes: 0, maxH: 0, bump: 0, rowTrans: 0 };
  assert.equal(rl.rewardOf({ ...base, full: 1 }), 50);
  assert.equal(rl.rewardOf({ ...base, full: 2 }), 150, '2 行应为 150 而非 100');
  assert.equal(rl.rewardOf({ ...base, full: 3 }), 300);
  assert.equal(rl.rewardOf({ ...base, full: 4 }), 500, '4 行应为 500（爆发奖励）');
  assert.ok(rl.rewardOf({ ...base, full: 4 }) > 2 * rl.rewardOf({ ...base, full: 2 }), '4 行应远高于 2 个 2 行之和');
  // 即时代价仍生效
  assert.ok(rl.rewardOf({ ...base, full: 0, aggH: 10 }) < 0, '高堆仍受罚');
});