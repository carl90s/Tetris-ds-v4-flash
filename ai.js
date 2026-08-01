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
    // 井深和（Dellacherie 关键特征）：两侧高于自身的深槽，I 块垂直放入可消 4 行
    let wellSum = 0;
    const topH = hs.map(h => ROWS - h); // 转为“距顶部”高度（越大越高）
    for (let c = 0; c < COLS; c++) {
      const left = c > 0 ? topH[c - 1] : ROWS;
      const right = c < COLS - 1 ? topH[c + 1] : ROWS;
      const well = Math.max(0, Math.min(left, right) - topH[c]);
      wellSum += (well * (well + 1)) / 2;
    }
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
    return { full: 0, aggH, maxH, holes, bump, wellSum, rowTrans };
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
      // 非零列范围：允许负 col（边缘列也可放置，如竖 I 落最左列）
      let minC = m[0].length, maxC = -1;
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m[r].length; c++) {
          if (m[r][c]) {
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
          }
        }
      }
      for (let col = -minC; col < COLS - maxC; col++) {
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
      // 当前朝向下方块的非零最大行（落点高度 landing 用）
      let maxRow = 0;
      for (let r = 0; r < m.length; r++) {
        if (m[r].some(v => v)) maxRow = r;
      }
      // 非零列范围：允许负 col（矩阵全零列越界不碰撞，边缘列也可放置，如竖 I 落最左列）
      let minC = m[0].length, maxC = -1;
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m[r].length; c++) {
          if (m[r][c]) {
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
          }
        }
      }
      for (let col = -minC; col < COLS - maxC; col++) {
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
          phi: {
            full: s.full, aggH: s.aggH, maxH: s.maxH, holes: s.holes,
            bump: s.bump, wellSum: s.wellSum, rowTrans: s.rowTrans,
            landing: ROWS - (y + maxRow + 1), // 落点高度：方块最低格距底部
            maxH2: s.maxH * s.maxH,           // 非线性：最高列平方（冒尖加速惩罚）
            aggH2: s.aggH * s.aggH / 100      // 非线性：总高平方归一化（堆高加速惩罚）
          }
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
  /** 初始权重 = 启发式默认（保证冷启动不弱于启发式）；洞/最高列惩罚加大；wellSum 惩罚调低（攒井代价小，鼓励竖放 I 消四连）；后 4 项为非线性特征 */
  const RL_DEFAULT_W = [760, 1.5, 8, 50, 2, 18, 6, 2, 1.0, 0.5];

  /** 消行奖励表（rewardOf 用）：单次 1/2/3/4 行 = 50/200/500/1000 */
  const CLEAR_BONUS = [0, 50, 200, 500, 1000];

  /**
   * 消行决策因子：把 full 特征变换为与奖励一致的递增曲线（1/4/10/20 倍）。
   * 让决策 Q 与非线性奖励对齐——4 行的诱惑是 1 行的 20 倍，AI 才愿意攒竖放消四连。
   */
  function clearFactor(full) {
    return (CLEAR_BONUS[Math.min(4, full)] || 0) / 50;
  }

  function lsGet(k) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }

  class RLAgent {
    constructor() {
      this.w = RL_DEFAULT_W.slice();
      this.g2 = RL_DEFAULT_W.map(() => 0); // AdaGrad：每权重累计梯度平方
      this.episodes = 0;
      this.baseline = 0;
      this.alpha = 0.001;   // 学习率（配合 mini-batch 回放）
      this.replay = [];     // 经验回放池
      this.replayCapacity = 500;
      this.batchSize = 8;
      this.replayIdx = 0;   // 环形缓冲写指针
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
        if (Array.isArray(s.w) && s.w.length === 10) {
          this.w = s.w.map(Number);
        } else if (Array.isArray(s.w) && s.w.length === 8) {
          // 8 维迁移：追加 maxH²/aggH² 默认值
          this.w = s.w.map(Number).concat([1.0, 0.5]);
        } else if (Array.isArray(s.w) && s.w.length === 6) {
          // 旧版 6 维迁移：追加 wellSum/landing/maxH²/aggH² 默认值
          this.w = s.w.map(Number).concat([15, 2, 1.0, 0.5]);
        }
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

    /** 价值：Q = w·phi（full 用递增因子，其余惩罚项负向） */
    q(phi) {
      return clearFactor(phi.full) * this.w[0]
        - phi.aggH * this.w[1]
        - phi.maxH * this.w[2]
        - phi.holes * this.w[3]
        - phi.bump * this.w[4]
        - phi.rowTrans * this.w[5]
        - (phi.wellSum || 0) * this.w[6]
        - (phi.landing || 0) * this.w[7]
        - (phi.maxH2 || 0) * this.w[8]
        - (phi.aggH2 || 0) * this.w[9];
    }

    /** 决策：ε-greedy 选 Q 最高落点（含 2 步前瞻；wellSum 惩罚调低让攒井代价小，鼓励竖放 I） */
    decide(game) {
      const cands = enumeratePlacements(game);
      if (!cands.length) return null;
      const ctx = this.boardCtx(game);
      const previews = game.preview();
      let best = cands[0], bestQ = -Infinity;
      for (const c of cands) {
        let q = this.q(c.phi);
        // 2 步前瞻：接下来 2 个方块在此放置后的最优落点价值（折扣叠加，0.5 权重）
        if (previews.length) {
          const fv = this.valueOfBoard(c.boardAfter, previews, 2, ctx);
          q = q * 0.5 + fv * 0.5;
        }
        if (q > bestQ) { bestQ = q; best = c; }
      }
      if (Math.random() < this.eps) {
        best = cands[Math.floor(Math.random() * cands.length)];
      }
      return best;
    }

    /**
     * 即时奖励（TD 用）：消行递增奖励——单次消的行数越多，每行越值钱，
     * 鼓励攒多行爆发（1/2/3/4 行 = 50/150/300/500），再减去堆高/洞/最高列的即时代价。
     */
    rewardOf(phi) {
      // 消行递增奖励更陡：单次 1/2/3/4 行 = 50/200/500/1000（强鼓励攒多行爆发）
      const clear = Math.min(4, phi.full);
      // 洞惩罚加大（即时）：每个洞 -60；最高列惩罚加大：每格 -5
      return (CLEAR_BONUS[clear] || 0) - phi.aggH * 1.0 - phi.holes * 60 - phi.maxH * 5;
    }

    /** 棋盘上下文（SHAPES/旋转/尺寸），供 valueOfBoard 使用 */
    boardCtx(game) {
      return {
        SHAPES: game.constructor.SHAPES || {},
        rotateMatrix: game.constructor.rotateMatrix,
        COLS: game.constructor.COLS,
        ROWS: game.constructor.ROWS
      };
    }

    /**
     * 未来价值：对任意棋盘 rollout 评估接下来 steps 个方块的最优落点价值（折扣叠加）。
     * 用 γ·Q₁ + γ²·Q₂ + γ³·Q₃ … 把多步未来价值都纳入。
     */
    valueOfBoard(board, previews, steps, ctx) {
      const { SHAPES, rotateMatrix, COLS, ROWS } = ctx;
      let cur = board;
      let total = 0, g = this.gamma;
      for (let i = 0; i < steps; i++) {
        const type = previews[i];
        const shape = type ? SHAPES[type] : null;
        if (!shape) break;
        const cands = enumerateOnBoard(cur, shape.matrix.map(r => r.slice()), COLS, ROWS, rotateMatrix);
        if (!cands.length) break;
        let bestQ = -Infinity, bestCand = null;
        for (const c of cands) {
          const q = this.q(c.phi);
          if (q > bestQ) { bestQ = q; bestCand = c; }
        }
        total += g * bestQ;
        g *= this.gamma;
        cur = bestCand ? bestCand.boardAfter : cur;
      }
      return total;
    }

    /** 当前棋盘的未来价值（TD 目标用，3 步） */
    futureValue(game, steps = 3) {
      return this.valueOfBoard(game.board, game.preview(), steps, this.boardCtx(game));
    }

    /**
     * TD(0) 步级学习：放置完成后调用。
     * @param {Object} phi 本步所选落点的特征（放置后棋盘）
     * @param {Object} game 当前游戏（已放置并生成新方块）
     */
    observe(phi, game) {
      // 即时奖励：消行递增收益 - 堆高/洞的即时代价
      const reward = this.rewardOf(phi);
      this.episodeReward += reward;
      // 未来价值：接下来 3 个方块的最优落点价值（折扣叠加）
      const future = this.futureValue(game, 3);
      // 存入回放池（环形缓冲）
      const exp = { phi: { full: phi.full, aggH: phi.aggH, maxH: phi.maxH, holes: phi.holes, bump: phi.bump, rowTrans: phi.rowTrans, wellSum: phi.wellSum, landing: phi.landing, maxH2: phi.maxH2, aggH2: phi.aggH2 }, reward, future };
      if (this.replay.length < this.replayCapacity) this.replay.push(exp);
      else this.replay[this.replayIdx] = exp;
      this.replayIdx = (this.replayIdx + 1) % this.replayCapacity;
      // 从回放池采样 mini-batch 复习更新（降方差、样本复用）
      const n = Math.min(this.batchSize, this.replay.length);
      for (let i = 0; i < n; i++) {
        const e = this.replay[Math.floor(Math.random() * this.replay.length)];
        this.applyGrad(e);
      }
      this.clampWeights();
      this.steps.push({ phi });
    }

    /** 对单条经验做 TD 梯度更新（AdaGrad 自适应学习率：每权重独立步长） */
    applyGrad(exp) {
      const qPrev = this.q(exp.phi);
      const delta = exp.reward + exp.future - qPrev;
      // 各权重梯度（惩罚项带负号）
      const grads = [
        delta * clearFactor(exp.phi.full),
        delta * (-exp.phi.aggH),
        delta * (-exp.phi.maxH),
        delta * (-exp.phi.holes),
        delta * (-exp.phi.bump),
        delta * (-exp.phi.rowTrans),
        delta * (-(exp.phi.wellSum || 0)),
        delta * (-(exp.phi.landing || 0)),
        delta * (-(exp.phi.maxH2 || 0)),
        delta * (-(exp.phi.aggH2 || 0))
      ];
      for (let i = 0; i < this.w.length; i++) {
        this.g2[i] += grads[i] * grads[i];
        this.w[i] += this.alpha * grads[i] / (Math.sqrt(this.g2[i]) + 1e-8);
      }
    }

    /** 权重范围限制（防“奖励黑客”学崩） */
    clampWeights() {
      this.w[0] = Math.min(2000, Math.max(200, this.w[0]));
      this.w[1] = Math.min(100, Math.max(1.0, this.w[1]));
      this.w[2] = Math.min(120, Math.max(4.0, this.w[2]));   // maxH（下限提高到 4）
      this.w[3] = Math.min(200, Math.max(25, this.w[3]));
      this.w[4] = Math.min(40, Math.max(1.0, this.w[4]));
      this.w[5] = Math.min(200, Math.max(10, this.w[5]));
      this.w[6] = Math.min(100, Math.max(2, this.w[6]));     // wellSum（惩罚调低，鼓励攒井）
      this.w[7] = Math.min(30, Math.max(0.5, this.w[7]));    // landing
      this.w[8] = Math.min(40, Math.max(0.3, this.w[8]));    // maxH²
      this.w[9] = Math.min(25, Math.max(0.1, this.w[9]));    // aggH²
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
          this.w[0] += f * (clearFactor(human.phi.full) - clearFactor(c.phi.full));
          this.w[1] += f * (-(human.phi.aggH - c.phi.aggH));
          this.w[2] += f * (-(human.phi.maxH - c.phi.maxH));
          this.w[3] += f * (-(human.phi.holes - c.phi.holes));
          this.w[4] += f * (-(human.phi.bump - c.phi.bump));
          this.w[5] += f * (-(human.phi.rowTrans - c.phi.rowTrans));
          this.w[6] += f * (-(human.phi.wellSum - c.phi.wellSum));
          this.w[7] += f * (-(human.phi.landing - c.phi.landing));
          this.w[8] += f * (-((human.phi.maxH2 || 0) - (c.phi.maxH2 || 0)));
          this.w[9] += f * (-((human.phi.aggH2 || 0) - (c.phi.aggH2 || 0)));
          updated = true;
        }
      }
      if (!updated) return;
      this.clampWeights();
      this.save();
    }

    /** 当前权重（调试/显示用） */
    getWeights() {
      return {
        full: this.w[0], aggH: this.w[1], maxH: this.w[2],
        holes: this.w[3], bump: this.w[4], rowTrans: this.w[5],
        wellSum: this.w[6], landing: this.w[7],
        maxH2: this.w[8], aggH2: this.w[9],
        episodes: this.episodes, eps: this.eps
      };
    }
  }

  return { planBestPlacement, evalBoard, enumeratePlacements, RLAgent };
});
