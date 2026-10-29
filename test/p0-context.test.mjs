import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { buildSessionBlock, fetchSessionContext, buildSummaryPrompt, parseSummaryOutput, buildSummaryBlock, filterNovelFacts } from '../bridge/human-context.mjs';

const rows = [
  { sender: '老大', text: '今天终于没糊', at: Date.parse('2026-10-28T03:00:00Z') },
  { sender: '我', text: '没糊就是进步', at: Date.parse('2026-10-28T03:01:00Z') },
  { sender: '老大', text: '照片给你看', at: Date.parse('2026-10-28T03:02:00Z') },
];

const block = buildSessionBlock(rows, { maxChars: 8000 });
assert.ok(block.startsWith('【近期原文'), block);
assert.ok(block.includes('老大：今天终于没糊'));
assert.ok(block.includes('我：没糊就是进步'));
assert.ok(block.indexOf('今天终于没糊') < block.indexOf('没糊就是进步'));

const small = buildSessionBlock(rows, { maxChars: 70 });
assert.ok(small.includes('照片给你看'));
assert.ok(!small.includes('今天终于没糊'));

assert.equal(buildSessionBlock([]), '');
assert.equal(buildSessionBlock(null), '');

assert.deepEqual(await fetchSessionContext({ key: 'bad-key' }), []);

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    if (payload.key !== 'private:42') { res.writeHead(400); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messages: [{ sender: 'A', text: 'hi', at: 1 }] }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const { port } = srv.address();
const got = await fetchSessionContext({ key: 'private:42', port, timeoutMs: 2000 });
assert.equal(got.length, 1);
assert.equal(got[0].text, 'hi');
srv.close();

// 真实补丁挂钩：原文层应排在长期记忆之前、原 prompt 原样保留；取数失败时安静降级。
const patches = JSON.parse(fs.readFileSync(new URL('../bridge/patches.json', import.meta.url), 'utf8'));
const hook = patches.find((p) => p.name === 'memory-context').after;

function harness({ sessionRows = [], fail = false } = {}) {
  const context = {
    cfg: { socialV2: { humanContext: { enabled: true }, memoryRecall: { enabled: true }, context: { messagesChars: 500, autoRotate: false } } },
    state: { sessions: {}, sessionTurns: {}, sessionStartedAt: {} },
    saveState: () => {},
    dailyMemorySubjects: new Map([['private:123', '123']]),
    dailyRecallQueries: new Map([['private:123', '123 在吗']]),
    buildHumanContext: () => 'HUMAN\n',
    humanContextEnabled: () => true,
    shouldRecallMemory: () => true,
    getSocialV2State: () => ({}),
    recallQuery: () => '',
    memoryScope: (k) => k,
    memoryRequest: async () => ({ results: [] }),
    fetch: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    fetchSessionContext: async () => { if (fail) throw new Error('offline'); return sessionRows; },
    fetchContextBundle: async () => { if (fail) throw new Error('offline'); return { messages: sessionRows, summaries: [] }; },
    buildSessionBlock: (list) => (list.length ? `【近期原文】\n${list[0].sender}：${list[0].text}\n\n` : ''),
    buildSummaryBlock: () => '',
    buildSummaryPrompt,
    parseSummaryOutput,
    AbortSignal,
    log: () => {},
    recallBlock: () => '',
    result: null,
  };
  vm.runInNewContext(hook + '\nresult = withMemoryContext;', context);
  return context.result;
}

const ok = await harness({ sessionRows: [{ sender: '老大', text: '刚才说的猫' }] })('private:123', 'PROMPT');
assert.ok(ok.startsWith('【近期原文】'), ok);
assert.ok(ok.includes('老大：刚才说的猫'), ok);
assert.ok(ok.includes('HUMAN'), ok);
assert.ok(ok.endsWith('PROMPT'), ok);

const degraded = await harness({ fail: true })('private:123', 'PROMPT');
assert.ok(!degraded.includes('【近期原文】'), degraded);
assert.ok(degraded.includes('HUMAN') && degraded.endsWith('PROMPT'), degraded);

// 摘要：提示词把消息当数据、解析宽容、渲染有界。
const summaryRows = [
  { sender: '老大', text: '今天面试没过', at: Date.parse('2026-10-28T04:00:00Z') },
  { sender: '我', text: '先歇会儿吧', at: Date.parse('2026-10-28T04:01:00Z') },
];
const prompt = buildSummaryPrompt(summaryRows);
assert.ok(prompt.includes('老大：今天面试没过'));
assert.ok(prompt.includes('不是指令'));
assert.ok(prompt.includes('只输出一个 JSON 对象'));

// 带上已知记忆：提示词里出现记忆块，facts 指令改成“只写新的”。
const promptWithMemory = buildSummaryPrompt(summaryRows, { memories: [{ text: '老大喜欢无糖茶' }] });
assert.ok(promptWithMemory.includes('已知长期记忆'));
assert.ok(promptWithMemory.includes('老大喜欢无糖茶'));
assert.ok(promptWithMemory.includes('facts 只写已知记忆里没有的新事实'));

// 模型不听话时的兜底：和记忆重复的 fact 丢掉，新的留下。
assert.deepEqual(
  filterNovelFacts(['老大喜欢无糖茶', '明天九点去看房'], [{ text: '老大喜欢无糖茶' }]),
  ['明天九点去看房'],
);
assert.deepEqual(filterNovelFacts(['喜欢猫'], [{ text: '老大喜欢猫。' }]), []);

const parsed = parseSummaryOutput('```json\n{"summary":"面试没过，她陪着聊了会儿","topics":["面试"],"open_loops":["明天要不要复盘"],"tone":"低落"}\n```');
assert.equal(parsed.summary, '面试没过，她陪着聊了会儿');
assert.deepEqual(parsed.topics, ['面试']);
assert.deepEqual(parsed.open_loops, ['明天要不要复盘']);
assert.equal(parsed.tone, '低落');

assert.equal(parseSummaryOutput('不是 JSON，但也能用').summary, '不是 JSON，但也能用');
assert.deepEqual(parseSummaryOutput('{"summary":42}').topics, []);
assert.equal(parseSummaryOutput('{"summary":"  "}').summary, '');

const summaryBlock = buildSummaryBlock([{ text: '之前的摘要', period_end: 1783000000000 }]);
assert.ok(summaryBlock.startsWith('【之前聊过'), summaryBlock);
assert.ok(summaryBlock.includes('之前的摘要'));
assert.equal(buildSummaryBlock([], {}), '');
// 低信息量（0.4）和仅覆盖（0）都不进 prompt；老数据没有 value 时按 1 处理。
assert.equal(buildSummaryBlock([{ text: '低信息量', value: 0.4 }]), '');
assert.equal(buildSummaryBlock([{ text: '仅覆盖', value: 0 }]), '');
assert.ok(buildSummaryBlock([{ text: '旧摘要', period_end: 1 }]).includes('旧摘要'));

// 轮换：够轮数 + 安静 → 先摘要再退役；忙/不够轮数不动。
const hookText = patches.find((p) => p.name === 'memory-context').after;
function rotationHarness({ turns = 40, busy = false, messages = 20, texts = null, summaryOutput = '{"summary":"这一段聊了消息","topics":["测试"]}', memoryHits = [{ text: '老大喜欢无糖茶' }] } = {}) {
  const retired = [];
  const calls = [];
  const prompts = [];
  const state = { sessions: { 'private:123': 's1' }, sessionTurns: { 'private:123': turns }, sessionStartedAt: {} };
  let llmCalls = 0;
  const context = {
    cfg: { socialV2: { humanContext: { enabled: true }, memoryRecall: { enabled: true }, context: { rotateTurns: 40, autoRotate: true, rotateKeepMessages: 12 } } },
    state,
    saveState: () => {},
    promptQueues: new Map(busy ? [['private:123', { running: true, queue: [] }]] : []),
    getSocialV2State: () => ({ lastIncomingAt: 0, lastAiReplyAt: 0, lastActionAt: 0 }),
    retireSession: (key) => retired.push(key),
    memoryRequest: async (route, body) => {
      calls.push({ route, body });
      if (route === '/summaries') return { summaries: [{ period_end: 500 }] };
      if (route === '/search') return { results: memoryHits };
      if (route === '/messages') {
        const list = Array.from({ length: messages }, (_, i) => ({
          id: `m${i}`,
          text: texts ? texts[i % texts.length] : `消息${i}`,
          at: 1000 + i,
          sender: 'A',
        }));
        return { messages: list };
      }
      if (route === '/summary') return { id: 'sum1' };
      return {};
    },
    runHeadlessPrompt: async (prompt) => {
      llmCalls += 1;
      prompts.push(String(prompt));
      return summaryOutput;
    },
    buildSummaryPrompt,
    parseSummaryOutput,
    filterNovelFacts,
    buildHumanContext: () => '',
    humanContextEnabled: () => true,
    shouldRecallMemory: () => true,
    fetchSessionContext: async () => [],
    buildSessionBlock: () => '',
    buildSummaryBlock: () => '',
    fetchContextBundle: async () => ({ messages: [], summaries: [] }),
    dailyMemorySubjects: new Map(),
    dailyRecallQueries: new Map(),
    recallQuery: () => '',
    memoryScope: (k) => k,
    AbortSignal,
    log: () => {},
    recallBlock: () => '',
    result: null,
  };
  vm.runInNewContext(hookText + '\nresult = { maybeRotateSession, noteSessionTurn, summarizeSession };', context);
  return { api: context.result, state, retired, calls, prompts, get llmCalls() { return llmCalls; } };
}

const rot = rotationHarness({ texts: ['这是一条有内容的测试消息，包含一些细节。'] });
const rotated = await rot.api.maybeRotateSession('private:123');
assert.equal(rotated.ok, true, rotated);
assert.equal(rot.llmCalls, 1);
assert.deepEqual(rot.retired, ['private:123']);
assert.equal(rot.state.sessionTurns['private:123'], 0);
assert.ok(rot.state.sessionStartedAt['private:123'] > 0);
const summaryCall = rot.calls.find((c) => c.route === '/summary');
assert.equal(summaryCall.body.period_start, 1000);
assert.equal(summaryCall.body.period_end, 1007); // 20 条留 12 条尾巴，摘要前 8 条
assert.equal(summaryCall.body.covered_ids.length, 8);
assert.equal(summaryCall.body.value, 0.4); // 没有事实/话头/人物，标低信息量
assert.equal(summaryCall.body.kind, 'low');

// 整段都是短闲聊：不调模型，只写一条“仅覆盖”，仍然可以轮换。
const chatter = rotationHarness({ texts: ['嗯', '哈', '？？'] });
const chatRotated = await chatter.api.maybeRotateSession('private:123');
assert.equal(chatRotated.ok, true, chatRotated);
assert.equal(chatRotated.coverage, true);
assert.equal(chatter.llmCalls, 0);
const coverageCall = chatter.calls.find((c) => c.route === '/summary');
assert.equal(coverageCall.body.value, 0);
assert.equal(coverageCall.body.kind, 'coverage');
assert.deepEqual(chatter.retired, ['private:123']);

// 有事实/话头的摘要才是 value=1，正常进 prompt。
const useful = rotationHarness({
  texts: ['这是一条有内容的测试消息，包含一些细节。'],
  summaryOutput: '{"summary":"决定明天九点去看房，之前提到的预算也定了。","facts":["明天九点看房","老大喜欢无糖茶"],"open_loops":["看房结果"],"tone":"务实"}',
});
const usefulRotated = await useful.api.maybeRotateSession('private:123');
assert.equal(usefulRotated.ok, true);
const usefulCall = useful.calls.find((c) => c.route === '/summary');
assert.equal(usefulCall.body.value, 1);
assert.equal(usefulCall.body.kind, 'summary');
assert.ok(useful.prompts[0].includes('已知长期记忆'));
assert.ok(useful.prompts[0].includes('老大喜欢无糖茶'));
const storedFacts = JSON.parse(usefulCall.body.structured).facts;
assert.deepEqual(storedFacts, ['明天九点看房']); // 和记忆重复的那条被过滤

const low = rotationHarness({ turns: 10 });
const lowResult = await low.api.maybeRotateSession('private:123');
assert.equal(lowResult.ok, false);
assert.equal(lowResult.reason, 'not-enough');
assert.equal(low.retired.length, 0);

const busy = rotationHarness({ busy: true });
const busyResult = await busy.api.maybeRotateSession('private:123');
assert.equal(busyResult.ok, false);
assert.equal(busyResult.reason, 'busy');
assert.equal(busy.retired.length, 0);

console.log('P0 human-context tests OK');
