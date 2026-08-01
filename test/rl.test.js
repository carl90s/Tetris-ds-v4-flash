'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const AI = require('../ai.js');
const { RLAgent, enumeratePlacements } = AI;
const { SHAPES, COLS } = TetrisGame;

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

test('RLAgent：初始权重 q 计算正确（洞 50 / maxH 8）', () => {
  const rl = new RLAgent();
  const phi = { full: 1, aggH: 10, maxH: 5, holes: 2, bump: 3, rowTrans: 20 };
  const q = rl.q(phi);
  const expected = 760 * 1 - 1.5 * 10 - 8 * 5 - 50 * 2 - 2 * 3 - 18 * 20;
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
  assert.equal(rl.rewardOf({ ...base, full: 2 }), 200, '2 行应为 200（4×1 行）');
  assert.equal(rl.rewardOf({ ...base, full: 3 }), 500);
  assert.equal(rl.rewardOf({ ...base, full: 4 }), 1000, '4 行应为 1000（爆发奖励）');
  assert.ok(rl.rewardOf({ ...base, full: 4 }) > 2 * rl.rewardOf({ ...base, full: 2 }), '4 行应远高于 2 个 2 行之和');
  // 洞惩罚加大：每个洞 -60
  assert.equal(rl.rewardOf({ ...base, full: 0, holes: 1 }), -60, '1 个洞即时惩罚 -60');
  assert.equal(rl.rewardOf({ ...base, full: 2, holes: 1 }), 140, '2 行 200 扣 1 洞 60 = 140');
  // 即时代价仍生效
  assert.ok(rl.rewardOf({ ...base, full: 0, aggH: 10 }) < 0, '高堆仍受罚');
});
test('RLAgent：futureValue 未来 3 步价值叠加且有限', () => {
  const rl = new RLAgent();
  const g = playingGame();
  const v0 = rl.futureValue(g, 0);
  const v1 = rl.futureValue(g, 1);
  const v3 = rl.futureValue(g, 3);
  assert.equal(v0, 0, '0 步无未来价值');
  assert.ok(Number.isFinite(v1) && Number.isFinite(v3));
  // 空棋盘上未来价值是堆叠惩罚（负值），步数越多叠加越多
  assert.ok(v3 < 0, '空棋盘未来价值应为负（堆叠惩罚）');
  assert.ok(v3 !== v1, '3 步应叠加更多未来价值（v3=' + v3 + ' vs v1=' + v1 + '）');
});

test('RLAgent：observe 使用 3 步未来价值后权重仍有限', () => {
  const rl = new RLAgent();
  const g = playingGame();
  for (let i = 0; i < 10; i++) {
    rl.observe({ full: 0, aggH: 8, maxH: 5, holes: 2, bump: 3, rowTrans: 15 }, g);
  }
  assert.ok(rl.w.every(v => Number.isFinite(v)), '权重应保持有限');
  assert.ok(rl.steps.length === 10);
});
test('RLAgent：决策 Q 的消行因子非线性（4 行 = 20 倍 1 行）', () => {
  const rl = new RLAgent();
  const base = { aggH: 0, maxH: 0, holes: 0, bump: 0, rowTrans: 0 };
  const q1 = rl.q({ ...base, full: 1 });
  const q2 = rl.q({ ...base, full: 2 });
  const q4 = rl.q({ ...base, full: 4 });
  assert.ok(q4 > 10 * q1, '4 行 Q 应远大于 1 行（' + q4 + ' vs ' + q1 + '）');
  assert.ok(q2 > 2 * q1, '2 行 Q 应超过 2 个 1 行');
});

test('RLAgent：有 I 竖放消 4 行机会时优先竖放', () => {
  const rl = new RLAgent();
  const g = playingGame();
  // 16~19 行除第 5 列外全满（竖井），竖 I 放入可消 4 行
  for (let r = 16; r <= 19; r++) {
    g.board[r] = Array(COLS).fill('#x').map((v, c) => (c === 5 ? 0 : v));
  }
  g.current = { type: 'I', matrix: SHAPES.I.matrix.map(r => r.slice()), color: SHAPES.I.color, x: 3, y: 0 };
  g.updateGhost();
  const plan = rl.decide(g);
  assert.ok(plan, '应有落点');
  const cands = AI.enumeratePlacements(g);
  const chosen = cands.find(c => c.rot === plan.rot && c.col === plan.col);
  assert.ok(chosen, '选中候选应存在');
  assert.equal(chosen.phi.full, 4, '应选择能消 4 行的竖放落点（实际 ' + chosen.phi.full + '）');
});
test('RLAgent：经验回放池存储与批量更新', () => {
  const rl = new RLAgent();
  const g = playingGame();
  for (let i = 0; i < 12; i++) {
    rl.observe({ full: i % 3, aggH: 8, maxH: 5, holes: 2, bump: 3, rowTrans: 15 }, g);
  }
  assert.equal(rl.replay.length, 12, '经验应存入回放池');
  assert.ok(rl.w.every(v => Number.isFinite(v)), '批量更新后权重应有限');
  assert.equal(rl.steps.length, 12);
});

test('RLAgent：回放池环形缓冲上限', () => {
  const rl = new RLAgent();
  rl.replayCapacity = 10;
  const g = playingGame();
  for (let i = 0; i < 25; i++) {
    rl.observe({ full: 0, aggH: 6, maxH: 4, holes: 1, bump: 2, rowTrans: 10 }, g);
  }
  assert.ok(rl.replay.length <= 10, '环形缓冲应限制在容量内');
});
test('RLAgent：10 维权重含非线性特征且作为惩罚生效', () => {
  const rl = new RLAgent();
  assert.equal(rl.w.length, 10);
  assert.equal(rl.g2.length, 10, 'AdaGrad 累计应为 10 维');
  // 非线性惩罚：maxH² 与 aggH² 应降低 Q
  const base = { full: 0, aggH: 0, maxH: 0, holes: 0, bump: 0, rowTrans: 0, wellSum: 0, landing: 0 };
  const qLinear = rl.q({ ...base, maxH: 8, aggH: 0 });
  const qNonlin = rl.q({ ...base, maxH: 8, aggH: 0, maxH2: 64, aggH2: 0 });
  assert.ok(qNonlin < qLinear, 'maxH² 应额外降低 Q（非线性惩罚）');
  // maxH 即时惩罚加大：每格 -5
  const r = rl.rewardOf({ full: 0, aggH: 0, holes: 0, maxH: 4, bump: 0, rowTrans: 0 });
  assert.equal(r, -20, 'maxH 即时惩罚应为 -5/格（实际 ' + r + '）');
});
test('enumeratePlacements：竖 I 可落最左列（边缘列候选存在）', () => {
  const g = playingGame();
  // 16~19 行除列 0 外全满（井在最左列），竖 I 放列 0 可消 4 行
  for (let r = 16; r <= 19; r++) {
    g.board[r] = Array(COLS).fill('#x').map((v, c) => (c === 0 ? 0 : v));
  }
  g.current = { type: 'I', matrix: SHAPES.I.matrix.map(r => r.slice()), color: SHAPES.I.color, x: 3, y: 0 };
  g.updateGhost();
  const cands = AI.enumeratePlacements(g);
  // 竖 I 非零列 index 2 → 占列 0 需要 col=-2
  const edge = cands.find(c => c.col === -2);
  assert.ok(edge, '应有竖 I 落最左列（col=-2）的候选');
  assert.equal(edge.phi.full, 4, '该候选应消 4 行（实际 ' + (edge ? edge.phi.full : '无') + '）');
  // RL 决策应选边缘竖放消四连
  const rl = new RLAgent();
  const plan = rl.decide(g);
  const chosen = cands.find(c => c.rot === plan.rot && c.col === plan.col);
  assert.equal(chosen.phi.full, 4, 'RL 应选择边缘竖放消 4 行（实际 ' + chosen.phi.full + '）');
});
test('RLAgent：imitate 跳过制造高墙的人类落点（防教坏）', () => {
  const rl = new RLAgent();
  const g = playingGame();
  // 左侧堆高墙到第 3 行（列 0 高 17），人类把 O 放柱顶（maxH 极高）
  for (let r = 3; r < 20; r++) g.board[r][0] = '#x';
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 0, y: 0 };
  g.updateGhost();
  const w0 = rl.w.slice();
  rl.imitate(g);
  assert.deepEqual(rl.w, w0, '制造高墙的落点不应被学习');
});

test('RLAgent：imitate 学习正常落点仍生效', () => {
  const rl = new RLAgent();
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  const cands = AI.enumeratePlacements(g);
  const human = cands.find(c => c.col === 4);
  assert.ok(human && human.phi.maxH <= 2, '空棋盘中央落点应为低墙');
  const before = rl.q(human.phi);
  for (let i = 0; i < 20; i++) rl.imitate(g);
  assert.ok(rl.q(human.phi) > before, '正常落点应被学习（价值上升）');
});