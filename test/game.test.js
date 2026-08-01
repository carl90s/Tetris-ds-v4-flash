'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const { SHAPES, TYPES, COLS, ROWS } = TetrisGame;

/** 生成一个空白游戏并进入 playing 状态 */
function playingGame() {
  const g = new TetrisGame();
  g.status = 'playing';
  return g;
}

test('旋转矩阵：顺时针 90°', () => {
  assert.deepEqual(TetrisGame.rotateMatrix([[1, 0], [0, 0]]), [[0, 1], [0, 0]]);
  assert.deepEqual(TetrisGame.rotateMatrix([[0, 1], [0, 0]]), [[0, 0], [0, 1]]);
  // 旋转 4 次回到原样
  const t = SHAPES.T.matrix;
  let m = t;
  for (let i = 0; i < 4; i++) m = TetrisGame.rotateMatrix(m);
  assert.deepEqual(m, t);
});

test('初始状态：棋盘为空、有当前方块、预览 3 个', () => {
  const g = new TetrisGame();
  assert.equal(g.status, 'ready');
  assert.ok(g.current, '应有当前方块');
  assert.equal(g.board.length, ROWS);
  assert.ok(g.board.every(row => row.length === COLS && row.every(c => c === 0)));
  assert.equal(g.preview().length, 3);
  assert.equal(g.score, 0);
  assert.equal(g.level, 1);
});

test('7 袋随机：各类型出现次数均衡', () => {
  const g = new TetrisGame();
  const counts = {};
  for (let i = 0; i < 700; i++) {
    g.ensureQueue(1);
    const t = g.queue.shift();
    counts[t] = (counts[t] || 0) + 1;
  }
  for (const t of TYPES) {
    assert.ok(counts[t] >= 70 && counts[t] <= 130, `${t} 出现 ${counts[t]} 次，期望约 100`);
  }
});

test('移动：左右移动与边界碰撞', () => {
  const g = playingGame();
  // 把当前方块推到最左
  while (g.tryMove(-1, 0)) { /* 推到边界 */ }
  const x = g.current.x;
  assert.equal(g.tryMove(-1, 0), false, '越界应被拒绝');
  assert.equal(g.current.x, x, '方块位置不变');
  assert.equal(g.tryMove(1, 0), true);
  assert.equal(g.current.x, x + 1);
});

test('旋转：I 方块横→竖，靠墙时踢墙成功', () => {
  const g = playingGame();
  g.current = {
    type: 'I',
    matrix: SHAPES.I.matrix.map(r => r.slice()),
    color: SHAPES.I.color,
    x: 8,
    y: 0
  };
  g.updateGhost();
  // 竖 I 需要列 x+2，x=8 时越界 → 应踢墙到 x=7
  assert.equal(g.rotate(1), true);
  assert.equal(g.current.matrix[1][2], 1, '旋转后为竖 I');
  assert.equal(g.current.x, 7);
});

test('旋转：O 方块不可旋转', () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  assert.equal(g.rotate(1), false);
});

test('旋转踢墙：I 贴底时可通过上移转正', () => {
  const g = playingGame();
  g.current = {
    type: 'I',
    matrix: SHAPES.I.matrix.map(r => r.slice()),
    color: SHAPES.I.color,
    x: 3,
    y: ROWS - 3 // 横 I 的方块行位于 ROWS-2，贴底
  };
  g.updateGhost();
  assert.equal(g.rotate(1), true);
  assert.equal(g.current.y, ROWS - 4, '应上移一格踢墙成功');
  assert.equal(g.current.matrix[0][2], 1, '旋转后为竖 I');
});

test('软降：+1 分', () => {
  const g = playingGame();
  const y0 = g.current.y;
  assert.equal(g.softDrop(), true);
  assert.equal(g.current.y, y0 + 1);
  assert.equal(g.score, 1);
});

test('硬降：每格 +2 分并锁定', () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  assert.equal(g.hardDrop(), true);
  assert.ok(g.current, '锁定后应立即生成新方块');
  assert.ok(TYPES.includes(g.current.type), '新方块类型合法');
  assert.equal(g.status, 'playing');
  assert.equal(g.score, 2 * 18, 'O 方块下落 18 格');
  assert.ok(g.board[18][4], '底部应有方块');
  assert.ok(g.board[19][5], '底部应有方块');
});

test('幽灵方块：落点预测正确', () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  assert.equal(g.ghostY, ROWS - 2);
});

test('消行：单行得 100 分', () => {
  const g = playingGame();
  g.board[ROWS - 1] = Array(COLS).fill('#888');
  g.findClearing();
  assert.equal(g.status, 'clearing');
  g.clearRows();
  assert.equal(g.lines, 1);
  assert.equal(g.score, 100);
  assert.equal(g.status, 'playing');
  assert.ok(g.board.every(row => row.every(c => c === 0)), '棋盘应清空');
});

test('消行：四行得 800 分', () => {
  const g = playingGame();
  for (let r = ROWS - 4; r < ROWS; r++) g.board[r] = Array(COLS).fill('#888');
  g.findClearing();
  assert.equal(g.status, 'clearing');
  g.clearRows();
  assert.equal(g.lines, 4);
  assert.equal(g.score, 800);
});

test('消行：等级提升加快下落', () => {
  const g = playingGame();
  const interval1 = g.dropInterval;
  g.lines = 9;
  g.board[ROWS - 1] = Array(COLS).fill('#888');
  g.findClearing();
  g.clearRows();
  assert.equal(g.level, 2);
  assert.ok(g.dropInterval < interval1, '等级提升后下落间隔应更短');
});

test('硬降后自然消行（真实玩法链路）', () => {
  const g = playingGame();
  // 第 19 行只留 3~6 列空位
  g.board[ROWS - 1] = Array(COLS).fill('#888').map((v, i) => (i >= 3 && i <= 6 ? 0 : v));
  // 换上 I 横，方块行位于 y=17（矩阵第 2 行），可落至 19
  g.current = {
    type: 'I',
    matrix: SHAPES.I.matrix.map(r => r.slice()),
    color: SHAPES.I.color,
    x: 3,
    y: ROWS - 4
  };
  g.updateGhost();
  g.hardDrop();
  assert.equal(g.status, 'clearing');
  g.clearRows();
  assert.equal(g.lines, 1);
  assert.equal(g.score, 100 + 2 * 2, '硬降 2 格得 4 分 + 消行 100 分');
});

test('游戏结束：顶部堆满后 spawn 失败', () => {
  const g = playingGame();
  for (let r = 0; r < 2; r++) g.board[r] = Array(COLS).fill('#fff');
  assert.equal(g.spawn(), false);
  assert.equal(g.status, 'over');
});

test('暂停：不响应任何操作', () => {
  const g = playingGame();
  assert.equal(g.togglePause(), true);
  assert.equal(g.status, 'paused');
  assert.equal(g.tryMove(1, 0), false);
  assert.equal(g.softDrop(), false);
  assert.equal(g.hardDrop(), false);
  assert.equal(g.rotate(1), false);
  assert.equal(g.togglePause(), true);
  assert.equal(g.status, 'playing');
});

test('暂停时 tick 不推进下落', () => {
  const g = playingGame();
  const y0 = g.current.y;
  g.togglePause();
  g.tick(5000);
  assert.equal(g.current.y, y0, '暂停时方块不应下落');
});

test('复位：score/lines/level 归零、棋盘清空', () => {
  const g = playingGame();
  g.board[ROWS - 1] = Array(COLS).fill('#888');
  g.findClearing();
  g.clearRows();
  g.reset();
  assert.equal(g.score, 0);
  assert.equal(g.lines, 0);
  assert.equal(g.level, 1);
  assert.equal(g.status, 'ready');
  assert.ok(g.board.every(row => row.every(c => c === 0)));
});

test('start() 不能从 over 直接恢复（需先 reset）', () => {
  const g = playingGame();
  g.status = 'over';
  g.current = null;
  assert.equal(g.start(), false);
  assert.equal(g.status, 'over');
});
