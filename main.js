/* ============ 俄罗斯方块：渲染 / 输入 / 音效 / UI ============ */
(function () {
  'use strict';

  const game = new TetrisGame();
  const COLS = TetrisGame.COLS || 10;
  const ROWS = TetrisGame.ROWS || 20;
  const CELL = 30;

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const nextCanvas = document.getElementById('next');
  const nctx = nextCanvas.getContext('2d');
  // 高分屏适配（必须先于任何 dpr 使用声明）
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  nextCanvas.width = nextCanvas.width * dpr;
  nextCanvas.height = nextCanvas.height * dpr;
  const NEXT_CELL = 15;

  const $ = id => document.getElementById(id);
  const els = {
    score: $('stat-score'),
    best: $('stat-best'),
    level: $('stat-level'),
    lines: $('stat-lines'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlaySub: $('overlay-sub'),
    overlayScore: $('overlay-score'),
    btnStart: $('btn-start'),
    btnPause: $('btn-pause'),
    btnRestart: $('btn-restart'),
    btnSound: $('btn-sound'),
    btnAi: $('btn-ai'),
    btnAiSettings: $('btn-ai-settings'),
    aiStatus: $('ai-status'),
    aiModal: $('ai-modal'),
    aiProvider: $('ai-provider'),
    aiBaseUrl: $('ai-baseurl'),
    aiApiKey: $('ai-apikey'),
    aiModel: $('ai-model'),
    aiDelay: $('ai-delay'),
    aiDelayVal: $('ai-delay-val'),
    aiMsg: $('ai-msg'),
    aiTest: $('ai-test'),
    aiSave: $('ai-save'),
    aiCancel: $('ai-cancel')
  };

  /* ---------- AI 托管状态 ---------- */
  const ai = new TetrisAI.AIController();
  let aiMode = false;
  let aiBusy = false;
  let aiFailCount = 0;
  let aiEmptyCount = 0;      // 连续"未解析出动作"次数
  let aiLastComment = '';
  let aiLastError = '';      // 最近一次错误（不被状态刷新覆盖）
  let aiPendingStart = false; // 用户点了开启但未配置：保存配置后自动开启

  const BEST_KEY = 'tetris-highscore';
  const SOUND_KEY = 'tetris-sound';
  // 安全读写：禁用存储（隐私模式等）时降级为内存，不影响游戏
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
  let bestScore = parseInt(lsGet(BEST_KEY) || '0', 10) || 0;
  let soundOn = lsGet(SOUND_KEY) !== 'off';

  /* ---------- 高分屏适配（dpr 已在上方声明） ---------- */
  canvas.width = canvas.width * dpr;
  canvas.height = canvas.height * dpr;
  ctx.scale(dpr, dpr);

  /* ---------- 音效（Web Audio 合成，无外部资源） ---------- */
  let audio = null;
  function ensureAudio() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audio = new AC();
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function beep(freq, dur, type, vol, slideTo) {
    if (!soundOn || !audio) return;
    const t0 = audio.currentTime;
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol || 0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(audio.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  }
  const sfx = {
    move() { beep(200, 0.03, 'square', 0.03); },
    rotate() { beep(320, 0.05, 'square', 0.04); },
    soft() { beep(160, 0.03, 'triangle', 0.04); },
    hard() { beep(420, 0.12, 'square', 0.05, 140); },
    clear(n) {
      const base = [0, 523, 587, 659, 784][n] || 523;
      [0, 0.07, 0.14, 0.21].forEach((d, i) => {
        if (i < n) setTimeout(() => beep(base * Math.pow(1.12, i), 0.09, 'square', 0.05), d * 1000);
      });
    },
    over() { beep(380, 0.9, 'sawtooth', 0.06, 55); },
    start() { beep(523, 0.1, 'square', 0.05); setTimeout(() => beep(784, 0.14, 'square', 0.05), 110); }
  };

  /* ---------- 绘制 ---------- */
  function drawCell(x, y, color, ghost) {
    const px = x * CELL, py = y * CELL;
    if (ghost) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
      ctx.globalAlpha = 1;
      return;
    }
    // 霓虹光晕
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.fillRect(px, py, CELL, CELL);
    ctx.shadowBlur = 0;
    // 立体感：左上高光 + 右下阴影
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(px, py, CELL, 3);
    ctx.fillRect(px, py, 3, CELL);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px, py + CELL - 3, CELL, 3);
    ctx.fillRect(px + CELL - 3, py, 3, CELL);
    // 1px 内边
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
  }

  function renderBoard() {
    ctx.clearRect(0, 0, 300, 600);

    // 背景网格
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let x = 1; x < COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, 600);
      ctx.stroke();
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(300, y * CELL);
      ctx.stroke();
    }

    // 已锁定方块
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (game.board[r][c]) drawCell(c, r, game.board[r][c], false);
      }
    }

    // 消行闪烁
    const blinkOn = Math.floor(game.clearingTimer / 70) % 2 === 0;
    if (game.status === 'clearing' && blinkOn) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (const r of game.clearingRows) ctx.fillRect(0, r * CELL, 300, CELL);
    }

    // 幽灵方块 + 当前方块
    if (game.current) {
      const { matrix, x, y, color } = game.current;
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          if (!matrix[r][c]) continue;
          const gy = game.ghostY + r;
          if (gy > y) drawCell(x + c, gy, color, true);
        }
      }
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          if (!matrix[r][c]) continue;
          const by = y + r;
          if (by >= 0) drawCell(x + c, by, color, false);
        }
      }
    }

    // 消行得分浮字
    if (game.lastClear && game.status === 'playing') {
      const t = game.lastClear.time / 1000;
      const alpha = Math.max(0, 1 - t);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('+' + game.lastClear.points, 150, 280 - t * 60);
      ctx.globalAlpha = 1;
    }
  }

  /** 在预览区画一个方块：按非零区域紧凑计算并居中 */
  function drawMiniPiece(nctx, type, cx, cy, slotH) {
    const m = TetrisGame.SHAPES[type].matrix;
    const rows = m.length, cols = m[0].length;
    let minR = rows, maxR = -1, minC = cols, maxC = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (m[r][c]) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    const areaW = nextCanvas.width / dpr;
    const cell = Math.min(NEXT_CELL, Math.floor((areaW * 0.9) / w), Math.floor((slotH * 0.8) / h));
    const ox = cx - (w * cell) / 2;
    const oy = cy - (h * cell) / 2;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (!m[r][c]) continue;
        const px = ox + (c - minC) * cell;
        const py = oy + (r - minR) * cell;
        nctx.fillStyle = TetrisGame.SHAPES[type].color;
        nctx.fillRect(px, py, cell - 1, cell - 1);
        nctx.fillStyle = 'rgba(255,255,255,0.35)';
        nctx.fillRect(px, py, cell - 1, 2);
        nctx.fillRect(px, py, 2, cell - 1);
      }
    }
  }

  function renderNext() {
    nctx.save();
    nctx.scale(dpr, dpr);
    nctx.clearRect(0, 0, nextCanvas.width / dpr, nextCanvas.height / dpr);
    const list = game.preview();
    const slots = list.length;
    const slotH = nextCanvas.height / dpr / slots;
    list.forEach((type, i) => {
      drawMiniPiece(nctx, type, (nextCanvas.width / dpr) / 2, slotH * i + slotH / 2, slotH);
    });
    nctx.restore();
  }

  /* ---------- UI 状态 ---------- */
  function updateHUD() {
    els.score.textContent = game.score;
    els.level.textContent = game.level;
    els.lines.textContent = game.lines;
    els.best.textContent = bestScore;
    els.btnSound.textContent = soundOn ? '🔊' : '🔇';
    els.btnPause.textContent = game.status === 'paused' ? '继续' : '暂停';
  }

  function saveBest() {
    if (game.score > bestScore) {
      bestScore = game.score;
      lsSet(BEST_KEY, String(bestScore));
    }
  }

  function showOverlay(kind) {
    els.overlay.classList.remove('hidden');
    if (kind === 'ready') {
      els.overlayTitle.textContent = '俄罗斯方块';
      els.overlaySub.textContent = '消行得分，填满即结束';
      els.overlayScore.textContent = '';
      els.btnStart.textContent = '开始游戏';
    } else if (kind === 'paused') {
      els.overlayTitle.textContent = '已暂停';
      els.overlaySub.textContent = '点击继续或按 P 键';
      els.overlayScore.textContent = '当前得分 ' + game.score;
      els.btnStart.textContent = '继续游戏';
    } else if (kind === 'over') {
      els.overlayTitle.textContent = '游戏结束';
      els.overlaySub.textContent = '再来一局，冲击更高分！';
      els.overlayScore.textContent = '得分 ' + game.score + ' · 最高 ' + bestScore;
      els.btnStart.textContent = '再来一局';
    }
  }

  function hideOverlay() {
    els.overlay.classList.add('hidden');
  }

  function refreshUI() {
    updateHUD();
    if (game.status === 'ready') showOverlay('ready');
    else if (game.status === 'paused') showOverlay('paused');
    else if (game.status === 'over') { saveBest(); updateHUD(); showOverlay('over'); }
    else hideOverlay();
  }

  /* ---------- AI 托管逻辑 ---------- */
  function setAIStatus(text, cls) {
    els.aiStatus.textContent = text;
    els.aiStatus.className = 'ai-status' + (cls ? ' ' + cls : '');
  }

  function updateAIUI() {
    els.btnAi.textContent = aiMode ? '🤖 托管中 · 点击停用' : '开启 AI 托管';
    els.btnAi.classList.toggle('on', aiMode);
    els.btnAi.classList.toggle('off', !aiMode);
    if (aiLastError) { setAIStatus('⚠ ' + aiLastError, 'err'); return; }
    if (!ai.configured) { setAIStatus('未配置 AI · 点击“AI 设置”填写', 'warn'); return; }
    if (!aiMode) { setAIStatus('已配置 · 点击开启托管', 'ok'); return; }
    if (aiBusy) { setAIStatus('AI 思考中…', 'ok'); return; }
    if (aiLastComment) { setAIStatus('AI：' + aiLastComment, 'ok'); return; }
    setAIStatus('AI 托管中', 'ok');
  }

  /** AI 回合：决策 → 逐动作放置 → 锁定；每块一次调用 */
  async function launchAITurn() {
    const t0 = Date.now();
    aiBusy = true;
    updateAIUI();
    try {
      const result = await ai.playTurn(game);
      aiFailCount = 0;
      aiLastError = '';
      aiLastComment = result.comment || '';
      if (result.moves.length === 0) {
        aiEmptyCount++;
        if (aiEmptyCount >= 3) {
          aiMode = false; // 模型始终不返回有效动作，停用避免无限堆叠
          aiPendingStart = false;
          aiLastError = '模型连续 3 次未返回有效动作，已停用托管（请换用支持 JSON 输出的模型）';
        } else {
          aiLastError = '模型未返回有效动作（第 ' + aiEmptyCount + ' 次，已自动落底）';
        }
        if (result.raw) console.warn('[AI] 未解析出动作，模型原始响应：', result.raw);
      } else {
        aiEmptyCount = 0;
      }
    } catch (err) {
      aiFailCount++;
      aiLastError = err && err.message ? err.message : String(err);
      if (aiFailCount >= 2) {
        aiMode = false; // 连续失败自动停用，避免无脑堆叠
        aiPendingStart = false;
      } else if (game.status === 'playing' && game.current) {
        game.hardDrop(); // 兜底：落底当前方块
      }
    } finally {
      // 最小回合间隔：保证“AI 思考中”可见、节奏可跟（快速模型也不会瞬移堆叠）
      const el = Date.now() - t0;
      if (el < 250) await sleep(250 - el);
      aiBusy = false;
      updateAIUI();
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ---------- AI 设置弹窗 ---------- */
  function openAIModal() {
    const p = TetrisAI.PROVIDERS;
    els.aiProvider.value = ai.settings.provider in p ? ai.settings.provider : 'custom';
    els.aiBaseUrl.value = ai.settings.baseUrl || '';
    els.aiApiKey.value = ai.settings.apiKey || '';
    els.aiModel.value = ai.settings.model || '';
    els.aiDelay.value = ai.settings.moveDelay;
    els.aiDelayVal.textContent = ai.settings.moveDelay;
    els.aiMsg.textContent = '';
    els.aiMsg.className = 'ai-msg';
    els.aiModal.classList.remove('hidden');
  }

  function closeAIModal() {
    els.aiModal.classList.add('hidden');
  }

  function applyModalToSettings() {
    ai.settings.provider = els.aiProvider.value;
    ai.settings.baseUrl = els.aiBaseUrl.value.trim();
    ai.settings.apiKey = els.aiApiKey.value.trim();
    ai.settings.model = els.aiModel.value.trim();
    ai.settings.moveDelay = parseInt(els.aiDelay.value, 10) || 60;
    els.aiDelayVal.textContent = ai.settings.moveDelay;
  }

  els.btnAiSettings.addEventListener('click', openAIModal);
  els.aiCancel.addEventListener('click', closeAIModal);
  els.aiModal.addEventListener('click', (e) => { if (e.target === els.aiModal) closeAIModal(); });
  els.aiProvider.addEventListener('change', () => {
    const p = TetrisAI.PROVIDERS[els.aiProvider.value];
    if (p && els.aiProvider.value !== 'custom') {
      els.aiBaseUrl.value = p.baseUrl;
      els.aiModel.value = p.model;
    }
  });
  els.aiDelay.addEventListener('input', () => { els.aiDelayVal.textContent = els.aiDelay.value; });

  els.aiTest.addEventListener('click', async () => {
    applyModalToSettings();
    els.aiMsg.textContent = '测试中…';
    els.aiMsg.className = 'ai-msg';
    const r = await ai.testConnection();
    els.aiMsg.textContent = r.message;
    els.aiMsg.className = 'ai-msg ' + (r.ok ? 'ok' : 'err');
  });

  els.aiSave.addEventListener('click', () => {
    applyModalToSettings();
    TetrisAI.saveSettings(ai.settings);
    closeAIModal();
    aiLastError = '';
    if (aiPendingStart && ai.configured) {
      aiPendingStart = false; // 用户此前点过“开启 AI 托管”，配置好后直接进入托管
      aiMode = true;
      aiFailCount = 0;
      aiEmptyCount = 0;
      ensureAudio();
      if (game.status === 'ready' || game.status === 'over') { startOrRestart(); }
      else if (game.status === 'paused') { doAction('pause'); }
    }
    updateAIUI();
  });

  els.btnAi.addEventListener('click', () => {
    if (!ai.configured) {
      aiPendingStart = true; // 记录开启意图：保存配置后自动进入托管
      openAIModal();
      setAIStatus('请先在设置中配置 API，保存后自动开启', 'warn');
      return;
    }
    aiMode = !aiMode;
    aiFailCount = 0;
    aiEmptyCount = 0;
    aiLastComment = '';
    aiLastError = '';
    if (aiMode) {
      ensureAudio();
      if (game.status === 'ready' || game.status === 'over') { startOrRestart(); }
      else if (game.status === 'paused') { doAction('pause'); }
    }
    updateAIUI();
  });
  /* ---------- 动作（统一入口，带音效） ---------- */
  function doAction(action) {
    if (action === 'pause') {
      if (game.togglePause()) refreshUI();
      return;
    }
    if (aiMode) return; // AI 托管时屏蔽玩家移动/旋转/降块
    if (!game.interactive) return;
    switch (action) {
      case 'left': if (game.tryMove(-1, 0)) sfx.move(); break;
      case 'right': if (game.tryMove(1, 0)) sfx.move(); break;
      case 'rotate': if (game.rotate(1)) sfx.rotate(); break;
      case 'rotateCCW': if (game.rotate(-1)) sfx.rotate(); break;
      case 'soft': if (game.softDrop()) sfx.soft(); break;
      case 'hard': if (game.hardDrop()) sfx.hard(); break;
    }
  }

  function startOrRestart() {
    game.reset();
    game.start();
    sfx.start();
    els.btnStart.blur(); // 移除焦点，避免后续 Enter 误触
    refreshUI();
  }

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', (e) => {
    const code = e.code;
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Space'].includes(code)) e.preventDefault();
    ensureAudio();

    if (code === 'Enter') {
      e.preventDefault(); // 防止聚焦按钮被再次触发
      if (game.status === 'paused') { doAction('pause'); return; }
      if (game.status !== 'playing') { startOrRestart(); }
      return;
    }
    if (code === 'KeyM') { toggleSound(); return; }
    if (code === 'KeyR') { startOrRestart(); return; }
    if (code === 'Escape' && !els.aiModal.classList.contains('hidden')) { closeAIModal(); return; }
    if (code === 'KeyP' || code === 'Escape') { doAction('pause'); return; }

    if (!game.interactive) return;
    switch (code) {
      case 'ArrowLeft': doAction('left'); break;
      case 'ArrowRight': doAction('right'); break;
      case 'ArrowDown': doAction('soft'); break;
      case 'ArrowUp':
      case 'KeyX': doAction('rotate'); break;
      case 'KeyZ': doAction('rotateCCW'); break;
      case 'Space': if (!e.repeat) doAction('hard'); break;
    }
  });

  /* ---------- 触控按钮（支持长按重复） ---------- */
  function bindHold(btn, action, repeatable) {
    let timer = null, interval = null;
    const fire = () => doAction(action);
    const clear = () => { clearTimeout(timer); clearInterval(interval); timer = interval = null; };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fire();
      if (repeatable) {
        timer = setTimeout(() => { interval = setInterval(fire, 90); }, 300);
      }
    });
    btn.addEventListener('pointerup', clear);
    btn.addEventListener('pointercancel', clear);
    btn.addEventListener('pointerleave', clear);
  }

  document.querySelectorAll('.touch-btn').forEach(btn => {
    const action = btn.dataset.action;
    bindHold(btn, action, action === 'left' || action === 'right' || action === 'soft');
  });

  /* ---------- 面板按钮 ---------- */
  els.btnStart.addEventListener('click', () => {
    ensureAudio();
    if (game.status === 'paused') { // 暂停时按钮是“继续游戏”，不能重开
      doAction('pause');
      return;
    }
    startOrRestart();
  });
  els.btnPause.addEventListener('click', () => { ensureAudio(); doAction('pause'); });
  els.btnRestart.addEventListener('click', () => { ensureAudio(); startOrRestart(); });
  els.btnSound.addEventListener('click', toggleSound);

  function toggleSound() {
    soundOn = !soundOn;
    lsSet(SOUND_KEY, soundOn ? 'on' : 'off');
    updateHUD();
    if (soundOn) { ensureAudio(); sfx.rotate(); }
  }

  /* ---------- 主循环 ---------- */
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    game.tick(dt, aiMode);
    renderBoard();
    renderNext();
    // 状态变化时刷新覆盖层/HUD（每帧轻量检查）
    const prev = loop._status;
    if (prev !== game.status) {
      loop._status = game.status;
      refreshUI();
      if (game.status === 'over') sfx.over();
      if (game.status === 'clearing') sfx.clear(game.clearingRows.length);
    } else {
      updateHUD();
    }
    if (aiMode && !aiBusy && game.status === 'playing') launchAITurn();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  refreshUI();
  updateAIUI();
})();
