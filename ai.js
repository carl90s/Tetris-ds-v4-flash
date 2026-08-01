/**
 * 俄罗斯方块 AI 引擎（内置确定性算法）
 * 启发式评分 + 消行模拟 + 1 步前瞻，无需外部 API。
 * 浏览器中挂载 window.TetrisAI；Node 中 require（便于测试）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TetrisAI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============ 棋盘工具 ============ */

  /** 形状矩阵 (m) 放在 (col, y) 时与棋盘是否碰撞 */
  function collidesAt(board, m, col, y) {
    const COLS = board[0].length, ROWS = board.length;
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m[r].length; c++) {
        if (!m[r][c]) continue;
        const bx = col + c, by = y + r;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && board[by][bx]) return true;
      }
    }
    return false;
  }

  /** 模拟方块在棋盘 (board) 的 (col) 处下落高度（放不下返回 null） */
  function dropYOn(board, m, col) {
    const ROWS = board.length;
    let y = 0;
    if (collidesAt(board, m, col, y)) return null;
    while (!collidesAt(board, m, col, y + 1)) {
      y++;
      if (y > ROWS) return null;
    }
    return y;
  }

  /** 放置方块到棋盘副本，移除满行；返回新棋盘（未补齐顶部） */
  function placeOnBoard(board, m, col, y) {
    const next = board.map(row => row.slice());
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m[r].length; c++) {
        if (m[r][c]) next[y + r][col + c] = m[r][c];
      }
    }
    return next.filter(row => !row.every(v => v));
  }

  /** 评估棋盘（需为完整 ROWS 行）：高度 / 最高列 / 洞 / 凸度 / 行过渡 */
  function evalBoard(board) {
    const COLS = board[0].length, ROWS = board.length;
    const hs = [];
    let holes = 0, aggH = 0, maxH = 0;
    for (let c = 0; c < COLS; c++) {
      let h = 0, seen = false, colHoles = 0;
      // 洞：从顶部往下，遇到第一个方块后，剩余空格（被方块盖住、无法从上方填满）
      for (let r = 0; r < ROWS; r++) {
        if (board[r][c]) {
          if (!seen) { seen = true; h = ROWS - r; }
        } else if (seen) {
          colHoles++;
        }
      }
      hs.push(h);
      aggH += h;
      if (h > maxH) maxH = h;
      holes += colHoles;
    }
    let bump = 0;
    for (let c = 1; c < COLS; c++) bump += Math.abs(hs[c] - hs[c - 1]);
    // 行过渡：每行 空↔实 的变化次数（表面平整度，比凸度更全面）
    let rowTrans = 0;
    for (let r = 0; r < ROWS; r++) {
      let prev = true; // 行外视为实（墙）
      for (let c = 0; c < COLS; c++) {
        const v = !!board[r][c];
        if (v !== prev) rowTrans++;
        prev = v;
      }
      if (prev !== true) rowTrans++; // 右边界
    }
    return { full: 0, aggH, maxH, holes, bump, rowTrans };
  }

  /* ============ 评分 ============ */

  /** 合并权重（Dellacherie 风格默认值，实测为局部最优） */
  function defaultWeights(w) {
    return {
      full: w.full !== undefined ? w.full : 760,
      aggH: w.aggH !== undefined ? w.aggH : 1.5,
      maxH: w.maxH !== undefined ? w.maxH : 4,
      holes: w.holes !== undefined ? w.holes : 35,
      bump: w.bump !== undefined ? w.bump : 2,
      rowTrans: w.rowTrans !== undefined ? w.rowTrans : 18
    };
  }

  function scoreEval(s, W) {
    return s.full * W.full - s.aggH * W.aggH - s.maxH * W.maxH - s.holes * W.holes - s.bump * W.bump - s.rowTrans * W.rowTrans;
  }

  /* ============ 落点搜索 ============ */

  /** 对给定棋盘枚举方块全部落点，返回最优（depth>1 时递归前瞻后续方块） */
  function bestOnBoard(board, m0, W, rotateMatrix, COLS, ROWS, previews, depth, SHAPES) {
    let m = m0;
    let best = null, bestScore = -Infinity;
    const nextShape = depth > 1 && previews && previews.length && SHAPES
      ? (SHAPES[previews[0]] || null) : null;
    const nextM0 = nextShape ? nextShape.matrix.map(r => r.slice()) : null;
    for (let rot = 0; rot < 4; rot++) {
      for (let col = 0; col < COLS; col++) {
        const y = dropYOn(board, m, col);
        if (y === null) continue;
        const placed = placeOnBoard(board, m, col, y);
        const cleared = ROWS - placed.length;
        while (placed.length < ROWS) placed.unshift(Array(COLS).fill(0));
        const s = evalBoard(placed);
        s.full = cleared;
        let sc = scoreEval(s, W);
        if (nextM0) {
          const nBest = bestOnBoard(placed, nextM0, W, rotateMatrix, COLS, ROWS, previews.slice(1), depth - 1, SHAPES);
          sc = sc * 0.5 + (nBest ? nBest.score : 0) * 0.5;
        }
        if (sc > bestScore) { bestScore = sc; best = { rot, col, score: sc }; }
      }
      m = rotateMatrix(m);
    }
    return best;
  }

  /**
   * 内置算法：枚举 4 个旋转 × 所有列，按启发式评分选最优落点（默认 1 步前瞻）。
   * @param {Object} game TetrisGame 实例
   * @param {Object} w 可调权重 / { lookahead: false|number } 前瞻深度
   * @returns {{rot:number, col:number, score:number}|null}
   */
  function planBestPlacement(game, w = {}) {
    if (!game.current) return null;
    const COLS = game.constructor.COLS, ROWS = game.constructor.ROWS;
    const rotateMatrix = game.constructor.rotateMatrix;
    const SHAPES = game.constructor.SHAPES || {};
    const W = defaultWeights(w);
    const depth = w.lookahead === false || w.lookahead === 0 ? 1 : (typeof w.lookahead === 'number' ? w.lookahead : 2);

    const previews = game.preview();
    return bestOnBoard(game.board, game.current.matrix.map(r => r.slice()), W, rotateMatrix, COLS, ROWS, previews, depth, SHAPES);
  }

  return { planBestPlacement, evalBoard };
});
