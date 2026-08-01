'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const AI = require('../ai.js');
const { planBestPlacement, evalBoard } = AI;
const { SHAPES } = TetrisGame;
const COLS = TetrisGame.COLS, ROWS = TetrisGame.ROWS;

function playingGame() {
  const g = new TetrisGame();
  g.status = 'playing';
  return g;
}

test('planBestPlacement：空棋盘返回有效落点', () => {
  const g = playingGame();
  const plan = planBestPlacement(g);
  assert.ok(plan, '应有落点');
  assert.ok(plan.rot >= 0 && plan.rot <= 3);
  assert.ok(plan.col >= 0 && plan.col <= 9);
});

test('planBestPlacement：优先选择能消行的位置', () => {
  const g = playingGame();
  // 底行只留 3~6 列空，I 横放 col 3 可填满整行
  g.board[19] = Array(COLS).fill('#888').map((v, i) => (i >= 3 && i <= 6 ? 0 : v));
  g.current = { type: 'I', matrix: SHAPES.I.matrix.map(r => r.slice()), color: SHAPES.I.color, x: 3, y: 17 };
  g.updateGhost();
  const plan = planBestPlacement(g);
  assert.ok(plan, '应有落点');
  assert.equal(plan.rot, 0, 'I 应保持横向');
  assert.equal(plan.col, 3, '应选能消行的列 3');
});

test('算法引擎：连续放置 100 个方块能大量消行', () => {
  const g = playingGame();
  let placed = 0;
  while (placed < 100 && g.status === 'playing') {
    const plan = planBestPlacement(g);
    if (plan) {
      for (let i = 0; i < plan.rot; i++) g.rotate(1);
      let guard = 0;
      const target = plan.col;
      while (g.current && g.current.x < target && guard++ < 12) g.tryMove(1, 0);
      while (g.current && g.current.x > target && guard++ < 12) g.tryMove(-1, 0);
      g.hardDrop();
    } else {
      g.hardDrop();
    }
    placed++;
    if (g.status === 'clearing') g.clearRows();
  }
  assert.ok(g.lines > 0, '应至少消行（实际 ' + g.lines + ' 行）');
  assert.ok(placed >= 60, '应能连续放置大量方块不堆满（实际 ' + placed + ' 个）');
});

test('evalBoard：高度 / 洞 / 凸度 / 行过渡', () => {
  const g = playingGame();
  // 空棋盘：全 0
  const s0 = evalBoard(g.board);
  assert.equal(s0.aggH, 0);
  assert.equal(s0.holes, 0);
  assert.equal(s0.bump, 0);
  // 底行 0,1 列填充 → 高度 1；列 2 留空 → 表面凸度
  g.board[19][0] = '#a';
  g.board[19][1] = '#a';
  const s1 = evalBoard(g.board);
  assert.equal(s1.aggH, 2, '两列高 1');
  assert.equal(s1.maxH, 1);
  assert.ok(s1.bump > 0, '有高度差即有凸度');
  assert.equal(s1.holes, 0, '底部开放空间不算洞');
  // 列 0 顶部方块下方留空 → 洞
  g.board[17][0] = '#a';
  const s2 = evalBoard(g.board);
  assert.equal(s2.holes, 1, '列 0 顶部方块下方为空 → 1 个洞');
  assert.equal(s2.maxH, 3);
});

test('planBestPlacement：lookahead=false 关闭前瞻仍返回落点', () => {
  const g = playingGame();
  const plan = planBestPlacement(g, { lookahead: false });
  assert.ok(plan);
});
