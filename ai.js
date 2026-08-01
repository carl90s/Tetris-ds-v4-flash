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
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    custom: { label: '自定义', baseUrl: '', model: '' }
  };

  const SETTINGS_KEY = 'tetris-ai-settings';
  const VALID_MOVES = ['left', 'right', 'rotate', 'rotateCCW', 'soft', 'hard'];
  const MAX_MOVES = 20;
  const REQUEST_TIMEOUT_MS = 20000;

  function lsGet(k) {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* 忽略 */ }
  }

  function defaultSettings() {
    return { provider: 'deepseek', baseUrl: PROVIDERS.deepseek.baseUrl, apiKey: '', model: PROVIDERS.deepseek.model, moveDelay: 60 };
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
        moveDelay: Number.isFinite(s.moveDelay) ? Math.min(200, Math.max(10, s.moveDelay)) : d.moveDelay
      };
    } catch (e) { return d; }
  }

  function saveSettings(s) {
    lsSet(SETTINGS_KEY, JSON.stringify({
      provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, moveDelay: s.moveDelay
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
      '5. 除非方块已经对准目标位置，否则不要直接输出 "hard"——必须先使用 left/right/rotate 把方块调整到目标列和朝向，最后再 "hard"。',
      '6. 输出中不能包含注释文字、逗号缺失、多余标点等 JSON 语法问题。',
      '策略建议：尽量消行；方块放得越低越好；避免留下难以填补的缝隙；优先把方块放在堆叠较低的一侧。'
    ].join('\n');
  }

  function buildUserPrompt(game) {
    return [
      '当前棋盘（.空 #已填）：',
      serializeBoard(game),
      '',
      '当前方块：' + game.current.type + '，位置 x=' + game.current.x + ', y=' + game.current.y + '，朝向矩阵：',
      pieceMatrix(game),
      '',
      '请输出放置动作。'
    ].join('\n');
  }

  /** 解析模型响应：容忍 ```json 围栏、前后杂文、非法 JSON */
  function parseResponse(text) {
    if (!text || typeof text !== 'string') return { moves: [], comment: '' };
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
    if (!obj || !Array.isArray(obj.moves)) return { moves: [], comment: '' };
    const moves = obj.moves
      .filter(m => typeof m === 'string' && VALID_MOVES.includes(m.toLowerCase()))
      .map(m => m.toLowerCase())
      .slice(0, MAX_MOVES);
    return { moves, comment: typeof obj.comment === 'string' ? obj.comment.slice(0, 60) : '' };
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
          { role: 'user', content: buildUserPrompt(game) }
        ],
        temperature: 0.2,
        max_tokens: 300,
        stream: false
      };
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
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      const parsed = parseResponse(content);
      return { moves: parsed.moves, comment: parsed.comment, raw: String(content).slice(0, 120) };
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
    async playTurn(game) {
      const gen = game.generation; // 记录局数：重开/复位后旧回合立即失效
      const { moves, comment, raw } = await this.decide(game);
      const applied = [];
      for (const m of moves) {
        if (game.generation !== gen || game.status !== 'playing' || !game.current) break;
        if (this.applyMove(game, m)) applied.push(m);
        if (m === 'hard') break; // 已锁定，本回合结束
        if (this.settings.moveDelay > 0) await sleep(this.settings.moveDelay);
      }
      // 兜底：动作用尽但方块仍在空中 → 硬降锁定（本回合已 hard 过则跳过）
      if (game.generation === gen && game.status === 'playing' && game.current && !applied.includes('hard')) {
        game.hardDrop();
        applied.push('hard');
      }
      return { moves, applied, comment, raw, done: game.status === 'playing' };
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
            max_tokens: 5
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