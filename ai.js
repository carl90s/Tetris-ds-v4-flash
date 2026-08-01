/**
 * 俄罗斯方块 AI 引擎
 * - 内置确定性算法（启发式评分 + 消行模拟 + 1 步前瞻）
 * - 内置强化学习代理（REINFORCE 在线学习，初始权重 = 启发式默认，越玩越强）
 * 无外部依赖，浏览器 / Node 均可运行。
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

  /* ============ 启发式评分 ============ */

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

  /* ============ 落点搜索（启发式） ============ */

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

  /* ============ 候选枚举（启发式 / RL 共用） ============ */

  /**
   * 在任意棋盘上枚举方块全部落点（无前瞻），候选含特征 phi 与放置后棋盘。
   * phi: {full, aggH, maxH, holes, bump, rowTrans}
   */
  function enumerateOnBoard(board, m0, COLS, ROWS, rotateMatrix) {
    let m = m0;
    const out = [];
    for (let rot = 0; rot < 4; rot++) {
      for (let col = 0; col < COLS; col++) {
        const y = dropYOn(board, m, col);
        if (y === null) continue;
        const placed = placeOnBoard(board, m, col, y);
        const cleared = ROWS - placed.length;
        while (placed.length < ROWS) placed.unshift(Array(COLS).fill(0));
        const s = evalBoard(placed);
        s.full = cleared;
        out.push({
          rot, col, y,
          matrix: m.map(r => r.slice()),
          boardAfter: placed,
          phi: { full: s.full, aggH: s.aggH, maxH: s.maxH, holes: s.holes, bump: s.bump, rowTrans: s.rowTrans }
        });
      }
      m = rotateMatrix(m);
    }
    return out;
  }

  /** 枚举当前方块全部落点（game 实例版） */
  function enumeratePlacements(game) {
    if (!game.current) return [];
    const COLS = game.constructor.COLS, ROWS = game.constructor.ROWS;
    const rotateMatrix = game.constructor.rotateMatrix;
    return enumerateOnBoard(game.board, game.current.matrix.map(r => r.slice()), COLS, ROWS, rotateMatrix);
  }

  /* ============ 强化学习代理（REINFORCE with baseline） ============ */

  const RL_STORAGE_KEY = 'tetris-rl-state';
  /** 初始权重 = 启发式默认（保证冷启动不弱于启发式） */
  const RL_DEFAULT_W = [760, 1.5, 4, 35, 2, 18];

  function lsGet(k) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }

  class RLAgent {
    constructor() {
      this.w = RL_DEFAULT_W.slice();
      this.episodes = 0;
      this.baseline = 0;
      this.alpha = 0.002;   // 学习率
      this.gamma = 0.95;    // 折扣
      this.eps = 0.08;      // 探索率（随局数衰减）
      this.steps = [];      // 本局记录（统计用）
      this.episodeReward = 0;
      this.load();
    }

    load() {
      const raw = lsGet(RL_STORAGE_KEY);
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        if (Array.isArray(s.w) && s.w.length === 6) this.w = s.w.map(Number);
        if (Number.isFinite(s.episodes)) this.episodes = s.episodes;
        if (Number.isFinite(s.eps)) this.eps = s.eps;
      } catch (e) { /* 忽略 */ }
    }

    save() {
      lsSet(RL_STORAGE_KEY, JSON.stringify({
        w: this.w, episodes: this.episodes, eps: this.eps
      }));
    }

    /** 重置本局记录（游戏开始时调用） */
    resetEpisode() {
      this.steps = [];
      this.episodeReward = 0;
    }

    /** 价值：Q = w·phi（full 正向，其余惩罚项负向） */
    q(phi) {
      return phi.full * this.w[0]
        - phi.aggH * this.w[1]
        - phi.maxH * this.w[2]
        - phi.holes * this.w[3]
        - phi.bump * this.w[4]
        - phi.rowTrans * this.w[5];
    }

    /** 决策：ε-greedy 选 Q 最高落点（含 1 步前瞻：考虑下一方块在此放置后的最优） */
    decide(game) {
      const cands = enumeratePlacements(game);
      if (!cands.length) return null;
      // 下一方块（初始朝向）用于前瞻
      const SHAPES = game.constructor.SHAPES || {};
      const rotateMatrix = game.constructor.rotateMatrix;
      const COLS = game.constructor.COLS, ROWS = game.constructor.ROWS;
      const previews = game.preview();
      const nextShape = previews.length ? SHAPES[previews[0]] : null;
      let best = cands[0], bestQ = -Infinity;
      for (const c of cands) {
        let q = this.q(c.phi);
        if (nextShape) {
          // 下一块在此放置后棋盘上的最优 q（0.5 权重）
          const nCands = enumerateOnBoard(c.boardAfter, nextShape.matrix.map(r => r.slice()), COLS, ROWS, rotateMatrix);
          let nBestQ = -Infinity;
          for (const nc of nCands) {
            const nq = this.q(nc.phi);
            if (nq > nBestQ) nBestQ = nq;
          }
          if (Number.isFinite(nBestQ)) q = q * 0.5 + nBestQ * 0.5;
        }
        if (q > bestQ) { bestQ = q; best = c; }
      }
      if (Math.random() < this.eps) {
        best = cands[Math.floor(Math.random() * cands.length)];
      }
      return best;
    }

    /**
     * TD(0) 步级学习：放置完成后调用。
     * @param {Object} phi 本步所选落点的特征（放置后棋盘）
     * @param {Object} game 当前游戏（已放置并生成新方块）
     */
    observe(phi, game) {
      // 即时奖励：消行收益 - 堆高/洞的即时代价（防止 TD 只认消行、奖励黑客）
      const reward = phi.full * 50 - phi.aggH * 1.0 - phi.holes * 30 - phi.maxH * 2;
      this.episodeReward += reward;
      // 下一状态价值：新棋盘上下一方块（当前方块）的最优 Q
      const nCands = enumeratePlacements(game);
      let maxQ = 0;
      for (const c of nCands) {
        const q = this.q(c.phi);
        if (q > maxQ) maxQ = q;
      }
      const qPrev = this.q(phi);
      const delta = reward + this.gamma * maxQ - qPrev;
      this.w[0] += this.alpha * delta * phi.full;
      this.w[1] += this.alpha * delta * (-phi.aggH);
      this.w[2] += this.alpha * delta * (-phi.maxH);
      this.w[3] += this.alpha * delta * (-phi.holes);
      this.w[4] += this.alpha * delta * (-phi.bump);
      this.w[5] += this.alpha * delta * (-phi.rowTrans);
      // 权重范围：full 可升，惩罚项设下限防“奖励黑客”学崩
      this.w[0] = Math.min(2000, Math.max(200, this.w[0]));
      this.w[1] = Math.min(100, Math.max(1.0, this.w[1]));
      this.w[2] = Math.min(60, Math.max(2.0, this.w[2]));
      this.w[3] = Math.min(200, Math.max(20, this.w[3]));
      this.w[4] = Math.min(40, Math.max(1.0, this.w[4]));
      this.w[5] = Math.min(200, Math.max(10, this.w[5]));
      this.steps.push({ phi });
    }

    /** 回合结束：结算统计与探索衰减 */
    endEpisode(over) {
      this.episodes++;
      this.eps = Math.max(0.03, this.eps * 0.97);
      this.steps = [];
      this.episodeReward = 0;
      this.save();
    }

    /** 两矩阵形状是否相同（非零格一致） */
    static matricesEqual(a, b) {
      if (!a || !b || a.length !== b.length || a[0].length !== b[0].length) return false;
      for (let r = 0; r < a.length; r++) {
        for (let c = 0; c < a[r].length; c++) {
          if (!!a[r][c] !== !!b[r][c]) return false;
        }
      }
      return true;
    }

    /**
     * 模仿学习（Behavior Cloning）：人玩时调用。
     * 把人类锁定方块的位置作为监督信号，用 max-margin 更新权重，
     * 使"人类选择的落点"的价值高于其他候选（向高手操作靠拢）。
     * @param {Object} game 锁定前的游戏（current 仍是人类刚放的方块，棋盘未含它）
     */
    imitate(game) {
      if (!game.current) return;
      const cands = enumeratePlacements(game);
      if (!cands.length) return;
      let human = null;
      for (const c of cands) {
        if (c.col === game.current.x && RLAgent.matricesEqual(c.matrix, game.current.matrix)) {
          human = c;
          break;
        }
      }
      if (!human) return; // 人类落点不在枚举内（异常情况忽略）
      const qH = this.q(human.phi);
      const margin = 1.0;
      let updated = false;
      for (const c of cands) {
        if (c === human) continue;
        const diff = qH - this.q(c.phi);
        if (diff < margin) {
          const f = this.alpha * (margin - diff);
          this.w[0] += f * (human.phi.full - c.phi.full);
          this.w[1] += f * (-(human.phi.aggH - c.phi.aggH));
          this.w[2] += f * (-(human.phi.maxH - c.phi.maxH));
          this.w[3] += f * (-(human.phi.holes - c.phi.holes));
          this.w[4] += f * (-(human.phi.bump - c.phi.bump));
          this.w[5] += f * (-(human.phi.rowTrans - c.phi.rowTrans));
          updated = true;
        }
      }
      if (!updated) return;
      // 与 observe 相同的权重范围限制
      this.w[0] = Math.min(2000, Math.max(200, this.w[0]));
      this.w[1] = Math.min(100, Math.max(0.8, this.w[1]));
      this.w[2] = Math.min(60, Math.max(1.5, this.w[2]));
      this.w[3] = Math.min(200, Math.max(15, this.w[3]));
      this.w[4] = Math.min(40, Math.max(0.8, this.w[4]));
      this.w[5] = Math.min(200, Math.max(8, this.w[5]));
      this.save();
    }

    /** 当前权重（调试/显示用） */
    getWeights() {
      return {
        full: this.w[0], aggH: this.w[1], maxH: this.w[2],
        holes: this.w[3], bump: this.w[4], rowTrans: this.w[5],
        episodes: this.episodes, eps: this.eps
      };
    }
  }

  return { planBestPlacement, evalBoard, enumeratePlacements, RLAgent };
});
