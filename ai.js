/**
 * 俄罗斯方块 AI 控制器（大模型托管）
 * 通过 OpenAI 兼容 API 让大模型读取棋盘并输出动作序列。
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

  /** 预置服务商（OpenAI 兼容接口） */
  const PROVIDERS = {
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    custom: { label: '自定义', baseUrl: '', model: '' }
  };

  const SETTINGS_KEY = 'tetris-ai-settings';
  const VALID_MOVES = ['left', 'right', 'rotate', 'rotateCCW', 'soft', 'hard'];
  /** 动作别名（含中文）：模型可能输出中文动作名 */
  const MOVE_ALIASES = {
    left: ['left', '左', '左移', '向左', '向左移', '往左'],
    right: ['right', '右', '右移', '向右', '向右移', '往右'],
    rotate: ['rotate', '旋转', '转', '顺时针', '顺旋'],
    rotateCCW: ['rotateccw', '逆时针', '逆旋', '反向旋转', '左旋'],
    soft: ['soft', '下移', '下落', '向下', '下', '软降'],
    hard: ['hard', 'drop', '直落', '落底', '落', '放下', '硬降', '快速落下']
  };
  const MAX_MOVES = 20;
  const REQUEST_TIMEOUT_MS = 12000;

  /** 把模型输出的任意动作写法归一化为标准动作名（最长别名优先，避免“落下”误判） */
  function normalizeMove(m) {
    if (typeof m !== 'string') return null;
    const s = m.toLowerCase().replace(/[\s_\-\u3001\uFF0C\uFF1B]/g, '');
    if (!s) return null;
    for (const canon of VALID_MOVES) {
      if (canon === s) return canon;
    }
    const all = [];
    for (const [canon, aliases] of Object.entries(MOVE_ALIASES)) {
      for (const a of aliases) all.push([a, canon]);
    }
    all.sort((x, y) => y[0].length - x[0].length);
    for (const [a, canon] of all) {
      if (s === a || s.includes(a)) return canon;
    }
    return null;
  }

  function lsGet(k) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }

  function defaultSettings() {
    return { provider: 'deepseek', baseUrl: PROVIDERS.deepseek.baseUrl, apiKey: '', model: PROVIDERS.deepseek.model, moveDelay: 60, batchSize: 3 };
  }
  function loadSettings() {
    const d = defaultSettings();
    try {
      const raw = lsGet(SETTINGS_KEY);
      if (!raw) return d;
      const s = JSON.parse(raw);
      return {
        provider: typeof s.provider === 'string' ? s.provider : d.provider,
        baseUrl: typeof s.baseUrl === 'string' && s.baseUrl ? s.baseUrl : d.baseUrl,
        apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
        model: typeof s.model === 'string' && s.model ? s.model : d.model,
        moveDelay: Number.isFinite(s.moveDelay) ? Math.min(200, Math.max(10, s.moveDelay)) : d.moveDelay,
        batchSize: s.batchSize === 1 ? 1 : 3
      };
    } catch (e) { return d; }
  }

  function saveSettings(s) {
    lsSet(SETTINGS_KEY, JSON.stringify({
      provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, moveDelay: s.moveDelay, batchSize: s.batchSize
    }));
  }

  /** 棋盘序列化为文本（. 空 / # 已填充） */
  function serializeBoard(game) {
    return game.board.map(row =>
      row.map(cell => (cell ? '#' : '.')).join('')
    ).join('\n');
  }

  /** 当前方块的紧凑朝向矩阵（去掉全零行/列） */
  function pieceMatrix(game) {
    const m = game.current.matrix;
    let minR = m.length, maxR = -1, minC = m[0].length, maxC = -1;
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m[r].length; c++) {
        if (m[r][c]) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const out = [];
    for (let r = minR; r <= maxR; r++) {
      const line = [];
      for (let c = minC; c <= maxC; c++) line.push(m[r][c] ? '1' : '0');
      out.push(line.join(' '));
    }
    return out.join(' | ');
  }

  function buildSystemPrompt() {
    return [
      '你是一个俄罗斯方块游戏的 AI 控制器，负责决定当前方块的落点。',
      '棋盘为 10 列 20 行：x 从 0 到 9（从左到右），y 从 0 到 19（从上到下）。',
      '棋盘文本中 . 表示空格，# 表示已填充的方块。',
      '当前方块信息包含：类型（I/O/T/S/Z/J/L）、左上角坐标 (x, y)、朝向矩阵（1 为占位）。',
      '你只能输出一个 JSON 对象，格式严格如下：',
      '{"moves":["left","right","rotate","soft","hard"],"comment":"一句话说明"}',
      '动作说明：',
      '- "left" / "right"：水平移动 1 格；',
      '- "rotate"：顺时针旋转 90°；"rotateCCW"：逆时针旋转；',
      '- "soft"：下移 1 格；',
      '- "hard"：直接落底并锁定（本回合结束）。',
      '要求：',
      '1. moves 数组最多 20 个动作，一次决策完成当前方块的放置；',
      '2. 优先旋转到合适朝向，再水平移动到目标列，最后用 "hard" 落底；',
      '3. 如果方块已经在目标位置，直接输出 ["hard"]；',
      '4. 不要输出解释性文字、不要用 Markdown 代码块，只输出 JSON。',
      '5. "hard" 必须是最后一个动作，且在此之前至少有一个移动或旋转动作（除非方块已经在目标位置正上方）。禁止输出只含 "hard" 的动作序列。',
      '6. 输出中不能包含注释文字、逗号缺失、多余标点等 JSON 语法问题。',
      '7. 严格只输出一个 JSON 对象。禁止输出任何解释、复述、提示或说明文字——你的回复必须能被 JSON.parse 直接解析。',
      '8. 如果实在无法判断动作，也请输出合法的兜底 JSON，例如 {"turns":[{"moves":["hard"]},{"moves":["hard"]},{"moves":["hard"]}],"comment":"兜底"}。',
      '动作序列示例：',
      '{"moves":["right","rotate","right","right","hard"],"comment":"旋转后放到第 6 列"}',
      '{"moves":["left","left","hard"],"comment":"放到第 3 列"}',
      '{"moves":["rotate","left","left","hard"],"comment":"先旋转再左移"}',
      '策略建议：尽量消行；方块放得越低越好；避免留下难以填补的缝隙；优先把方块放在堆叠较低的一侧。'
    ].join('\n');
  }

  function buildUserPrompt(game, batchSize) {
    const SHAPES = game.constructor.SHAPES || {};
    const COLS = game.constructor.COLS || 10;
    const BATCH = Math.min(3, Math.max(1, batchSize || 1));
    const lines = [
      '当前棋盘（.空 #已填）：',
      serializeBoard(game),
      '',
      BATCH > 1 ? ('即将连续放置 ' + BATCH + ' 个方块（按顺序）：') : '当前方块：'
    ];
    // 当前方块
    lines.push('方块 1：' + game.current.type + '，位置 x=' + game.current.x + ', y=' + game.current.y + '，朝向矩阵：');
    lines.push(pieceMatrix(game));
    // 后续方块（初始朝向，落点未知）
    const previews = game.preview();
    for (let i = 1; i < BATCH; i++) {
      const type = previews[i - 1];
      const shape = SHAPES[type];
      const x = Math.floor((COLS - shape.matrix[0].length) / 2);
      lines.push('方块 ' + (i + 1) + '：' + type + '，起始位置 x=' + x + ', y=0，初始朝向矩阵：');
      lines.push(shape.matrix.map(row => row.map(v => (v ? '1' : '0')).join(' ')).join(' | '));
    }
    lines.push('');
    if (BATCH > 1) {
      lines.push('请为每个方块分别规划放置动作，输出格式：');
      lines.push('{"turns":[{"moves":["left","right","rotate","soft","hard"]},{"moves":[...]},{"moves":[...]}],"comment":"一句话说明"}');
      lines.push('turns 数组长度必须等于 ' + BATCH + '；每个方块的动作中 "hard" 必须是最后一个动作。');
    } else {
      lines.push('请为当前方块规划放置动作，输出格式：');
      lines.push('{"moves":["left","right","rotate","soft","hard"],"comment":"一句话说明"}');
      lines.push('moves 数组中 "hard" 必须是最后一个动作。');
    }
    return lines.join('\n');
  }

  /** 解析模型响应：容忍 ```json 围栏、前后杂文、非法 JSON */
  function normalizeMovesList(arr) {
    if (!Array.isArray(arr)) {
      if (typeof arr === 'string') arr = arr.split(/[,，、;；\s]+/).filter(Boolean);
      else return [];
    }
    const moves = [];
    for (const m of arr) {
      if (moves.length >= MAX_MOVES) break;
      const norm = normalizeMove(m);
      if (norm) moves.push(norm);
    }
    return moves;
  }

  function parseResponse(text) {
    if (!text || typeof text !== 'string') return { turns: [], comment: '', moves: [] };
    let t = text.trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    let obj = null;
    if (first !== -1 && last > first) {
      try { obj = JSON.parse(t.slice(first, last + 1)); } catch (e) { obj = null; }
    }
    // 纯数组形式：["left","hard"]
    if (!obj) {
      const arrFirst = t.indexOf('[');
      const arrLast = t.lastIndexOf(']');
      if (arrFirst !== -1 && arrLast > arrFirst) {
        try {
          const arr = JSON.parse(t.slice(arrFirst, arrLast + 1));
          if (Array.isArray(arr)) obj = { moves: arr };
        } catch (e) { /* 忽略 */ }
      }
    }
    if (!obj) return { turns: [], comment: '', moves: [] };
    const comment = typeof obj.comment === 'string' ? obj.comment.slice(0, 60) : '';
    // 批量格式：{"turns":[{"moves":[...]},...]}
    if (Array.isArray(obj.turns)) {
      const turns = obj.turns.slice(0, 6).map(turn => ({ moves: normalizeMovesList(turn && turn.moves) }));
      return { turns, comment, moves: turns.length ? turns[0].moves : [] };
    }
    // 单回合格式（兼容）：{"moves":[...]}
    const moves = normalizeMovesList(obj.moves);
    return { turns: [{ moves }], comment, moves };
  }

  class AIController {
    /**
     * @param {Object} opts
     * @param {Function} opts.fetchImpl  fetch 实现（测试可注入 mock）
     * @param {Object}  opts.settings    初始设置（缺省从 localStorage 读取）
     */
    constructor(opts = {}) {
      this.fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(null) : null);
      this.settings = opts.settings ? Object.assign(defaultSettings(), opts.settings) : loadSettings();
      this.onError = opts.onError || null; // 回调：AI 决策出错时通知 UI
    }

    get configured() {
      return !!(this.settings.apiKey && this.settings.baseUrl && this.settings.model);
    }

    /** 调用模型，返回动作与说明 */
    async decide(game) {
      if (!this.configured) {
        const e = new Error('AI 未配置：请在设置中填写 API 地址、Key 与模型');
        if (this.onError) this.onError(e.message);
        throw e;
      }
      if (!game.current) {
        const e = new Error('当前没有可操作的方块');
        if (this.onError) this.onError(e.message);
        throw e;
      }
      const body = {
        model: this.settings.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(game, this.settings.batchSize) }
        ],
        temperature: 0.2,
        max_tokens: 1024, // 对话模型输出较小；reasoner 推理模型可自行调大
        stream: false
      };
      const isV4 = /v4/i.test(this.settings.model);
      // DeepSeek v4 官方：思考模式默认开启（响应慢、只给 reasoning_content），游戏场景必须关闭
      if (isV4) body.thinking = { type: 'disabled' };
      // 强制模型输出合法 JSON；但 deepseek-reasoner 等推理模型不支持 response_format（且思维链占满 token 时输出为空），跳过
      if (!/reasoner|r1\b/i.test(this.settings.model)) {
        body.response_format = { type: 'json_object' };
      }
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
      let resp;
      try {
        resp = await this.fetchImpl(this.settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.settings.apiKey
          },
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
        const e = new Error('API 请求失败 HTTP ' + resp.status + (detail ? ': ' + detail : ''));
        if (this.onError) this.onError(e.message);
        throw e;
      }
      const data = await resp.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message
        : null;
      const content = msg ? (msg.content || '') : '';
      const reasoning = msg ? (msg.reasoning_content || '') : '';
      // 推理模型（deepseek-reasoner 等）：只返回推理过程、最终动作为空 → 明确报错引导换模型
      if (!content && reasoning) {
        const e = new Error('模型「' + this.settings.model + '」疑似推理模型（只输出思维过程、未给出动作 JSON）。请在 AI 设置中改用对话模型，如 deepseek-chat / gpt-4o-mini');
        if (this.onError) this.onError(e.message);
        throw e;
      }
      const parsed = parseResponse(content);
      return { turns: parsed.turns, comment: parsed.comment, raw: String(content || reasoning).slice(0, 120) };
    }

    /** 执行一个动作，返回是否生效 */
    applyMove(game, move) {
      switch (move) {
        case 'left': return game.tryMove(-1, 0);
        case 'right': return game.tryMove(1, 0);
        case 'rotate': return game.rotate(1);
        case 'rotateCCW': return game.rotate(-1);
        case 'soft': return game.softDrop();
        case 'hard': return game.hardDrop();
        default: return false;
      }
    }

    /**
     * 完整回合：决策 → 逐动作执行 → 落底锁定。
     * @returns {Promise<{moves:string[], applied:string[], comment:string, done:boolean}>}
     */
    async playTurns(game) {
      const gen = game.generation; // 记录局数：重开/复位后旧回合立即失效
      const { turns, comment, raw } = await this.decide(game);
      const executed = [];
      if (turns.length === 0) {
        // 模型未返回任何有效回合：兜底落底当前方块，避免卡住
        if (game.generation === gen && game.status === 'playing' && game.current) {
          game.hardDrop();
          executed.push({ moves: [], applied: ['hard'] });
        }
        return { turns: executed, comment, raw, done: game.status === 'playing' };
      }
      for (const turn of turns) {
        if (game.generation !== gen || game.status !== 'playing' || !game.current) break;
        const applied = [];
        for (const m of turn.moves) {
          if (game.generation !== gen || game.status !== 'playing' || !game.current) break;
          if (this.applyMove(game, m)) applied.push(m);
          if (m === 'hard') break; // 已锁定，本段结束
          if (this.settings.moveDelay > 0) await sleep(this.settings.moveDelay);
        }
        // 兜底：动作用尽但方块仍在空中 → 硬降锁定（本段已 hard 过则跳过）
        if (game.generation === gen && game.status === 'playing' && game.current && !applied.includes('hard')) {
          game.hardDrop();
          applied.push('hard');
        }
        executed.push({ moves: turn.moves, applied });
        if (game.status !== 'playing') break; // 消行动画/结束：交由主循环推进
      }
      return { turns: executed, comment, raw, done: game.status === 'playing' };
    }

    /** 单回合（兼容旧接口，取批量结果第一段） */
    async playTurn(game) {
      const r = await this.playTurns(game);
      const first = r.turns[0] || { moves: [], applied: [] };
      return { moves: first.moves, applied: first.applied, comment: r.comment, raw: r.raw, done: r.done };
    }

    /** 测试连接：发一条最小请求验证 API 可用 */
    async testConnection() {
      if (!this.configured) return { ok: false, message: '请先填写 API 地址、Key 与模型' };
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
      try {
        const resp = await this.fetchImpl(this.settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.settings.apiKey
          },
          body: JSON.stringify({
            model: this.settings.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
            thinking: /v4/i.test(this.settings.model) ? { type: 'disabled' } : undefined
          }),
          signal: ctrl ? ctrl.signal : undefined
        });
        if (!resp.ok) return { ok: false, message: 'HTTP ' + resp.status };
        const data = await resp.json();
        const ok = !!(data && data.choices && data.choices.length);
        return { ok, message: ok ? '连接成功，模型 ' + this.settings.model : '响应格式异常' };
      } catch (e) {
        return { ok: false, message: '连接失败：' + (e && e.message ? e.message : e) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { AIController, PROVIDERS, loadSettings, saveSettings, parseResponse, serializeBoard, buildSystemPrompt, buildUserPrompt };
});