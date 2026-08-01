/**
 * 俄罗斯方块核心逻辑（无 DOM 依赖）
 * 浏览器中挂载到 window.TetrisGame；Node 中通过 require 使用（便于测试）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TetrisGame = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 10;
  const ROWS = 20;

  /** 七种方块：矩阵 + 颜色（经典配色） */
  const SHAPES = {
    I: { matrix: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], color: '#00e5ff' },
    O: { matrix: [[1, 1], [1, 1]], color: '#ffe600' },
    T: { matrix: [[0, 1, 0], [1, 1, 1], [0, 0, 0]], color: '#b26bff' },
    S: { matrix: [[0, 1, 1], [1, 1, 0], [0, 0, 0]], color: '#52e55c' },
    Z: { matrix: [[1, 1, 0], [0, 1, 1], [0, 0, 0]], color: '#ff5252' },
    J: { matrix: [[1, 0, 0], [1, 1, 1], [0, 0, 0]], color: '#4d8dff' },
    L: { matrix: [[0, 0, 1], [1, 1, 1], [0, 0, 0]], color: '#ffa726' }
  };
  const TYPES = Object.keys(SHAPES);

  /** 顺时针旋转矩阵 */
  function rotateMatrix(m) {
    const n = m.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      out[i] = [];
      for (let j = 0; j < n; j++) out[i][j] = m[n - 1 - j][i];
    }
    return out;
  }

  /** Fisher-Yates 洗牌 */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  class TetrisGame {
    constructor() {
      this.reset();
    }

    /** 初始化 / 重开一局 */
    reset() {
      this.generation = (this.generation || 0) + 1; // 局数标记：AI 旧回合据此识别过期
      this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
      this.queue = [];
      this.current = null;
      this.ghostY = 0;
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.dropInterval = this.intervalForLevel(1);
      this.fallAccum = 0;
      this.status = 'ready'; // ready | playing | paused | clearing | over
      this.clearingRows = [];
      this.clearingTimer = 0;
      this.lastClear = null; // 消行提示 { rows, points, time }
      this.spawn();
    }

    intervalForLevel(level) {
      return Math.max(80, 1000 - (level - 1) * 55);
    }

    /** 确保队列里至少有 n 个方块（7 袋随机） */
    ensureQueue(n) {
      while (this.queue.length < n) this.queue.push(...shuffle(TYPES));
    }

    /** 生成下一个方块；若新方块与已锁定格子碰撞则游戏结束 */
    spawn() {
      this.ensureQueue(4);
      const type = this.queue.shift();
      const shape = SHAPES[type];
      const piece = {
        type,
        matrix: shape.matrix.map(r => r.slice()),
        color: shape.color,
        x: Math.floor((COLS - shape.matrix[0].length) / 2),
        y: 0
      };
      if (this.collides(piece)) {
        this.status = 'over';
        this.current = null;
        return false;
      }
      this.current = piece;
      this.updateGhost();
      return true;
    }

    /** 预览接下来 3 个方块 */
    preview() {
      this.ensureQueue(4);
      return this.queue.slice(0, 3);
    }

    /** 方块与边界/已锁定格子是否碰撞 */
    collides(piece, board = this.board) {
      const { matrix, x, y } = piece;
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          if (!matrix[r][c]) continue;
          const bx = x + c;
          const by = y + r;
          if (bx < 0 || bx >= COLS || by >= ROWS) return true;
          if (by >= 0 && board[by][bx]) return true;
        }
      }
      return false;
    }

    tryMove(dx, dy) {
      if (this.status !== 'playing') return false;
      const p = this.current;
      const np = { ...p, x: p.x + dx, y: p.y + dy };
      if (this.collides(np)) return false;
      this.current = np;
      this.updateGhost();
      return true;
    }

    /** 旋转（轻量 SRS 踢墙：先试 x 偏移，再试上移） */
    rotate(dir = 1) {
      if (this.status !== 'playing' || !this.current) return false;
      const p = this.current;
      if (p.type === 'O') return false;
      const rotated = rotateMatrix(p.matrix);
      const kicks = dir === 1
        ? [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]]
        : [[0, 0], [1, 0], [-1, 0], [2, 0], [-2, 0], [0, -1], [1, -1], [-1, -1], [0, -2]];
      for (const [dx, dy] of kicks) {
        const np = { ...p, matrix: rotated, x: p.x + dx, y: p.y + dy };
        if (!this.collides(np)) {
          this.current = np;
          this.updateGhost();
          return true;
        }
      }
      return false;
    }

    /** 软降一格，成功 +1 分 */
    softDrop() {
      if (this.tryMove(0, 1)) {
        this.score += 1;
        return true;
      }
      return false;
    }

    /** 硬降到底，每格 +2 分 */
    hardDrop() {
      if (this.status !== 'playing' || !this.current) return false;
      let d = 0;
      while (!this.collides({ ...this.current, y: this.current.y + d + 1 })) d++;
      this.score += d * 2;
      this.current.y += d;
      this.lock();
      return true;
    }

    /** 锁定当前方块到棋盘 */
    lock() {
      const p = this.current;
      if (!p) return;
      // 锁定前钩子：供 AI 模仿学习等观察“人类落点”（此时棋盘未含本方块）
      if (this.onBeforeLock) {
        try { this.onBeforeLock(this); } catch (e) { /* 忽略回调错误 */ }
      }
      for (let r = 0; r < p.matrix.length; r++) {
        for (let c = 0; c < p.matrix[r].length; c++) {
          if (!p.matrix[r][c]) continue;
          const by = p.y + r;
          if (by < 0) { // 方块溢出顶部：直接结束
            this.status = 'over';
            this.current = null;
            return;
          }
          this.board[by][p.x + c] = p.color;
        }
      }
      this.current = null;
      this.findClearing();
    }

    /** 检测满行，进入清除动画状态 */
    findClearing() {
      const full = [];
      for (let r = 0; r < ROWS; r++) {
        if (this.board[r].every(cell => cell !== 0)) full.push(r);
      }
      if (full.length) {
        this.clearingRows = full;
        this.clearingTimer = 0;
        this.status = 'clearing';
      } else {
        this.afterClear();
      }
    }

    /** 清除满行并计分 */
    clearRows() {
      const n = this.clearingRows.length;
      if (n === 0) {
        this.afterClear();
        return;
      }
      const full = this.clearingRows.slice();
      this.board = this.board.filter((_, r) => !full.includes(r));
      while (this.board.length < ROWS) this.board.unshift(Array(COLS).fill(0));
      this.clearingRows = [];

      const points = [0, 100, 300, 500, 800][n] * this.level;
      this.score += points;
      this.lines += n;
      const newLevel = Math.floor(this.lines / 10) + 1;
      if (newLevel !== this.level) {
        this.level = newLevel;
        this.dropInterval = this.intervalForLevel(newLevel);
      }
      this.lastClear = { rows: n, points, time: 0 };

      this.status = 'playing';
      this.spawn();
    }

    /** 无满行时的后续处理：继续生成下一块 */
    afterClear() {
      this.status = 'playing';
      this.spawn();
    }

    /** 幽灵方块位置（落点预测） */
    updateGhost() {
      if (!this.current) return;
      let y = this.current.y;
      while (!this.collides({ ...this.current, y: y + 1 })) y++;
      this.ghostY = y;
    }

    /** 主循环推进（dt 毫秒；noGravity 时暂停自动下落，用于 AI 托管） */
    tick(dt, noGravity = false) {
      if (this.status === 'clearing') {
        this.clearingTimer += dt;
        if (this.clearingTimer >= 320) this.clearRows();
        return;
      }
      if (this.status !== 'playing') return;

      if (this.lastClear) {
        this.lastClear.time += dt;
        if (this.lastClear.time > 1000) this.lastClear = null;
      }

      if (!noGravity) {
        this.fallAccum += dt;
        while (this.fallAccum >= this.dropInterval) {
          this.fallAccum -= this.dropInterval;
          if (!this.tryMove(0, 1)) {
            this.lock();
            this.fallAccum = 0;
            break;
          }
        }
      }
    }

    start() {
      // over 状态不能直接恢复（current 已为 null），需先 reset()
      if (this.status === 'ready' || this.status === 'paused') {
        this.status = 'playing';
        this.fallAccum = 0;
        return true;
      }
      return false;
    }

    togglePause() {
      if (this.status === 'playing') {
        this.status = 'paused';
        return true;
      }
      if (this.status === 'paused') {
        this.status = 'playing';
        return true;
      }
      return false;
    }

    /** 当前方块是否可被操作（用于输入判定） */
    get interactive() {
      return this.status === 'playing';
    }
  }

  // 静态属性：浏览器与测试均可直接访问
  TetrisGame.COLS = COLS;
  TetrisGame.ROWS = ROWS;
  TetrisGame.SHAPES = SHAPES;
  TetrisGame.TYPES = TYPES;
  TetrisGame.rotateMatrix = rotateMatrix;
  return TetrisGame;
});
