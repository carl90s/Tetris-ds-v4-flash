'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TetrisGame = require('../game.js');
const AI = require('../ai.js');
const { AIController, parseResponse, serializeBoard, buildUserPrompt, buildSystemPrompt, loadSettings } = AI;
const { SHAPES } = TetrisGame;
const COLS = TetrisGame.COLS, ROWS = TetrisGame.ROWS;

/** mock fetch：返回固定响应体 */
function mockFetch(body, opts = {}) {
  return async () => ({
    ok: opts.ok !== false,
    status: opts.status || 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
}

/** 带配置的控制器（moveDelay=0 加速测试） */
function aiWith(fetchImpl, extra = {}) {
  return new AIController({
    fetchImpl,
    settings: Object.assign({ apiKey: 'test-key', baseUrl: 'https://example.com/v1', model: 'test-model', moveDelay: 0 }, extra)
  });
}

function playingGame() {
  const g = new TetrisGame();
  g.status = 'playing';
  return g;
}

test('parseResponse：标准 JSON', () => {
  const r = parseResponse('{"moves":["left","right","hard"],"comment":"放左边"}');
  assert.deepEqual(r.moves, ['left', 'right', 'hard']);
  assert.equal(r.comment, '放左边');
});

test('parseResponse：容忍 ```json 围栏与前后杂文', () => {
  assert.deepEqual(parseResponse('```json\n{"moves":["hard"]}\n```').moves, ['hard']);
  assert.deepEqual(parseResponse('好的，我来操作：{"moves":["left","hard"]}完毕！').moves, ['left', 'hard']);
});

test('parseResponse：非法输入返回空动作', () => {
  assert.deepEqual(parseResponse('不是JSON').moves, []);
  assert.deepEqual(parseResponse('{"comment":"只有说明"}').moves, []);
  assert.deepEqual(parseResponse(null).moves, []);
  assert.deepEqual(parseResponse('').moves, []);
  assert.deepEqual(parseResponse('{"moves":"hard"}').moves, []);
});

test('parseResponse：过滤未知动作、转小写、截断上限', () => {
  assert.deepEqual(parseResponse('{"moves":["left","jump","teleport","hard"]}').moves, ['left', 'hard']);
  assert.deepEqual(parseResponse('{"moves":["LEFT","Hard"]}').moves, ['left', 'hard']);
  const many = '{"moves":' + JSON.stringify(Array(40).fill('hard')) + '}';
  assert.equal(parseResponse(many).moves.length, 20);
});

test('serializeBoard：空棋盘 20 行 x 10 列', () => {
  const g = playingGame();
  const s = serializeBoard(g);
  const lines = s.split('\n');
  assert.equal(lines.length, ROWS);
  assert.ok(lines.every(l => l.length === COLS && l === '..........'));
});

test('buildUserPrompt / buildSystemPrompt 包含关键信息', () => {
  const g = playingGame();
  const up = buildUserPrompt(g);
  assert.ok(up.includes('当前棋盘'));
  assert.ok(up.includes(g.current.type));
  assert.ok(up.includes('x=' + g.current.x));
  const sp = buildSystemPrompt();
  assert.ok(sp.includes('hard'));
  assert.ok(sp.includes('JSON'));
});

test('decide：未配置时抛错', async () => {
  const g = playingGame();
  const ai = new AIController({ fetchImpl: mockFetch({}), settings: { apiKey: '', baseUrl: '', model: '' } });
  await assert.rejects(() => ai.decide(g), /AI 未配置/);
});

test('decide：HTTP 错误抛错', async () => {
  const g = playingGame();
  const ai = aiWith(mockFetch({}, { ok: false, status: 401 }));
  await assert.rejects(() => ai.decide(g), /HTTP 401/);
});

test('playTurn：完整回合——决策、移动、落底锁定', async () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  const ai = aiWith(mockFetch({ choices: [{ message: { content: '{"moves":["left","hard"],"comment":"左移落底"}' } }] }));
  const r = await ai.playTurn(g);
  assert.deepEqual(r.moves, ['left', 'hard']);
  assert.deepEqual(r.applied, ['left', 'hard']);
  assert.equal(r.comment, '左移落底');
  assert.equal(r.done, true);
  // O 左移 1 格后硬降：占用 (18,3)(18,4)(19,3)(19,4)
  assert.ok(g.board[18][3] && g.board[19][4], '方块应落到底部 x=3');
  assert.ok(g.current, '锁定后生成新方块');
});

test('playTurn：动作不足时自动硬降兜底', async () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  // 模型只给了 left，未落底 → 控制器应补 hard
  const ai = aiWith(mockFetch({ choices: [{ message: { content: '{"moves":["left"],"comment":"只左移"}' } }] }));
  const r = await ai.playTurn(g);
  assert.deepEqual(r.applied, ['left', 'hard']);
  assert.ok(g.board[19][3], '方块应落底锁定');
});

test('playTurn：hard 后不再执行后续动作', async () => {
  const g = playingGame();
  g.current = { type: 'O', matrix: SHAPES.O.matrix, color: SHAPES.O.color, x: 4, y: 0 };
  g.updateGhost();
  const ai = aiWith(mockFetch({ choices: [{ message: { content: '{"moves":["hard","left"],"comment":"hard即止"}' } }] }));
  const r = await ai.playTurn(g);
  assert.deepEqual(r.applied, ['hard']);
});

test('playTurn：模型返回非法内容 → 空动作 → 兜底硬降', async () => {
  const g = playingGame();
  const ai = aiWith(mockFetch({ choices: [{ message: { content: '抱歉我不懂' } }] }));
  const r = await ai.playTurn(g);
  assert.deepEqual(r.moves, []);
  assert.deepEqual(r.applied, ['hard']);
  assert.ok(g.current, '兜底后继续游戏');
});

test('testConnection：成功与失败', async () => {
  const ok = aiWith(mockFetch({ choices: [{ message: { content: 'hi' } }] }));
  assert.deepEqual(await ok.testConnection(), { ok: true, message: '连接成功，模型 test-model' });
  const bad = aiWith(mockFetch({}, { ok: false, status: 500 }));
  const r = await bad.testConnection();
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('500'));
});

test('loadSettings：无存储时返回默认值', () => {
  const s = loadSettings();
  assert.equal(s.provider, 'deepseek');
  assert.ok(s.baseUrl.length > 0);
  assert.equal(s.model, 'deepseek-chat');
});

test('AI 模式 noGravity：tick 不推进下落', () => {
  const g = playingGame();
  const y0 = g.current.y;
  g.tick(5000, true);  // noGravity
  assert.equal(g.current.y, y0, 'AI 模式下方块不应下落');
  g.tick(5000, false); // 恢复重力
  assert.ok(g.current.y > y0 || g.status !== 'playing' || !g.current, '恢复重力后下落或锁定');
});
test('playTurn：决策期间重开游戏，旧回合不作用到新局', async () => {
  const g = playingGame();
  let resolveFetch;
  const delayedFetch = () => new Promise(res => { resolveFetch = res; });
  const ai = aiWith(delayedFetch);
  const p = ai.playTurn(g); // 挂起在 fetch
  await new Promise(r => setTimeout(r, 20));
  g.reset(); // 重开：generation 递增、棋盘清空
  resolveFetch({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"moves":["hard"],"comment":"旧回合"}' } }] }),
    text: async () => ''
  });
  await p;
  assert.equal(g.status, 'ready', '新局保持未开始状态');
  assert.ok(g.board.every(row => row.every(c => c === 0)), '旧回合不得在棋盘上留方块');
});
test('parseResponse：支持纯数组输出', () => {
  assert.deepEqual(parseResponse('["left","right","hard"]').moves, ['left', 'right', 'hard']);
  assert.deepEqual(parseResponse('好的，输出：["left","hard"] 完毕').moves, ['left', 'hard']);
});

test('decide：返回原始响应片段供诊断', async () => {
  const g = playingGame();
  const ai = aiWith(mockFetch({ choices: [{ message: { content: '{"moves":["hard"],"comment":"c"}' } }] }));
  const r = await ai.decide(g);
  assert.ok(r.raw.includes('"hard"'), 'raw 应包含模型原始输出');
  assert.deepEqual(r.moves, ['hard']);
});