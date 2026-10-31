import {EmotionScopes,emotionScope} from '../bridge/emotion-scopes.mjs';
import os from "node:os";
import path from "node:path";
import { appraisalContext } from "../bridge/emotion-context.mjs";
import { reserveAppraisal } from "../bridge/appraisal-budget.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import * as emotion from "../bridge/emotion.js";
import * as human from "../bridge/human-context-v09.mjs";
import { TurnTraces } from "../bridge/turn-traces.mjs";
import {backgroundEffort,runBoundedHeadless} from '../bridge/background-reasoning.mjs';
import {featureKey} from '../bridge/usage-features.mjs';
import {createTokenLedger} from '../bridge/feature-token-ledger.mjs';
function bindScopes(ctx){const lanes=new EmotionScopes({ownerKey:'private:1',legacy:ctx.emotionState});ctx.emotionScope=emotionScope;ctx.emotionLanes=lanes;ctx.commitEmotionLane=(k,s)=>{lanes.set(k,s);ctx.emotionState=lanes.owner()};}
const source = fs.readFileSync(
  new URL("../bridge/bridge-v09.js", import.meta.url),
  "utf8",
);
const between = (a, b) => {
  const start = source.indexOf(a),
    end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};

test('actual headless sessions record isolated feature keys before follow and preserve attribution after cleanup', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-feature-routing-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const features=new Map(), learners=new Set();let serial=0;
  const ledger=createTokenLedger({file:path.join(dir,'usage.jsonl'),resolveKey:id=>features.get(id)});
  const ctx=vm.createContext({path,fs,URL,AbortSignal,pendingBackgroundStops:new Map(),backgroundEffort,runBoundedHeadless,cfg:{dsh:{baseUrl:"http://127.0.0.1:1"},consoleToken:"fixture-console-token"},fetch:async()=>({ok:true,json:async()=>({ok:true})}),STATE_DIR:dir,featureKey,learnerFeatures:features,learnerSessions:learners,
    learnerWaiters:new Map(),learnerCollectors:new Map(),clearTimeout,
    unwrap:x=>x,ensureChatModel:async()=> 'applied',waitLearnerTurn:async()=> 'ok',
    dispatchTracedPrompt:async()=>({result:{ok:true}}),
    api:{agentPresets:{list:async()=>({presets:[{id:'qq-memory'}]})},
      workspace:{create:async()=>({workspace:{workspaceId:'w'}}),archiveSession:async()=>{}},
      sessions:{create:async()=>({sessionId:`s${++serial}`})},
      events:{follow:id=>{
        assert.ok(features.has(id));
        ledger.ingestEvent({sessionId:id,event:{type:'assistant/message',seq:1,data:{turn:1,step:1,usage:{inputTokens:10,outputTokens:5}}}});
      },forget:()=>{}}},
  });
  const run=vm.runInContext(between('  async function runHeadlessPrompt(', '  // Admission follows')+';runHeadlessPrompt',ctx);
  await Promise.all([run('a',1000,[],'memory_extract'),run('b',1000,[],'idle_association')]);
  assert.equal(features.size,0);assert.equal(learners.size,0);
  assert.deepEqual(ledger.summary().features.map(f=>f.key).sort(),[featureKey('idle_association'),featureKey('memory_extract')].sort());
  assert.equal(ledger.summary().plugin.totalTokens,30);
});

test('actual prompt dispatch distinguishes accepted, rejected and unknown association delivery',async()=>{
  const delivery=[];
  let result={result:{ok:true,value:{}}};
  const ctx=vm.createContext({reverse:new Map([['s','private:1']]),turnTraces:new TurnTraces(()=>{}),
    idleAssociations:{delivery:(ref,status)=>delivery.push({ref,status})},
    api:{sessions:{prompt:async()=>{if(result instanceof Error)throw result;return result;}}},
  });
  const dispatch=vm.runInContext(between('  async function dispatchTracedPrompt(', '  function traceRow(')+';dispatchTracedPrompt',ctx);
  const reference={key:'private:1',ideaId:'idea'};
  await dispatch({sessionId:'s'},{idleAssociation:reference});
  result={result:{ok:false}};await dispatch({sessionId:'s'},{idleAssociation:reference});
  result=new Error('offline');await assert.rejects(dispatch({sessionId:'s'},{idleAssociation:reference}));
  assert.deepEqual(delivery.map(x=>x.status),['injected','rejected','delivery-unknown']);
});

test("actual bridge dispatch wrapper cancels rejected/command slots and binds accepted turns", async () => {
  const rows = [],
    turnTraces = new TurnTraces((r) => rows.push(r));
  let result = { result: { ok: true, value: {} } };
  const ctx = vm.createContext({
    turnTraces,
    reverse: new Map([["s", "private:1"]]),
    api: { sessions: { prompt: async () => result } },
  });
  const fn = vm.runInContext(
    between("  async function dispatchTracedPrompt(", "  function traceRow(") +
      ";dispatchTracedPrompt",
    ctx,
  );
  result = { result: { ok: false, error: { code: "no" } } };
  await fn({ sessionId: "s" }, { traceId: "rejected" });
  result = { result: { ok: true, value: { command: { text: "done" } } } };
  await fn({ sessionId: "s" }, { traceId: "command" });
  result = { result: { ok: true, value: {} } };
  await fn({ sessionId: "s" });
  await fn({ sessionId: "s" }, { traceId: "real" });
  turnTraces.start("s", "aux");
  turnTraces.finish("s", "aux");
  turnTraces.start("s", "real-turn");
  turnTraces.sent("s", { ok: true, sent: 1 }, "real-turn");
  turnTraces.finish("s", "real-turn");
  assert.equal(rows.at(-1).traceId, "real");
  assert.equal(rows.at(-1).turnId, "real-turn");
});

test("actual withMemoryContext records only selected rows with subject and association metadata", async () => {
  const traces = [],
    key = "private:1";
  const rows = [
    {
      id: "good",
      scope: key,
      subject_id: "1",
      tags: "food",
      text: "我喜欢吃面",
      score: 0.9,
      status: "active",
    },
    {
      id: "bad",
      scope: "private:999",
      text: "foreign",
      score: 0.99,
      status: "active",
    },
  ];
  const ctx = vm.createContext({
    ...human,
    crypto,
    AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ results: rows }) }),
    cfg: {
      socialV2: {
        humanContext: { enabled: true },
        association: { enabled: true },
        memoryShare: { enabled: false },
        context: { enabled: false },
      },
    },
    recordRetrievalTrace: (r) => traces.push(r),
    noteSessionTurn: () => {},
    scheduleRotationCheck: () => {},
    dailyMemorySubjects: new Map([[key, "1"]]),
    dailyRecallQueries: new Map([[key, "1 我喜欢吃什么"]]),
    getSocialV2State: () => ({}),
    memoryScope: (k) => k,
    log: () => {},
    recallQuery: () => "",
    memoryRequest: async (route) => ({
      results:
        route === "/associate"
          ? [
              {
                id: "assoc",
                scope: key,
                subject_id: "1",
                text: "上次聊过意面",
                score: 0.5,
                status: "active",
              },
            ]
          : [],
    }),
  });
  vm.runInContext(
    between("  function traceRow(", "  function recordRetrievalTrace("),
    ctx,
  );
  const fn = vm.runInContext(
      between(
        "  async function withMemoryContext(",
        "  const dailyRecallQueries",
      ) + ";withMemoryContext",
      ctx,
    ),
    context = {};
  const prompt = await fn(key, "当前问题", context);
  assert.match(prompt, /association-not-fact/);
  assert.ok(!prompt.includes("foreign"));
  assert.ok(context.traceId);
  assert.deepEqual(Array.from(traces[0].injected, (r) => r.id).sort(), [
    "assoc",
    "good",
  ]);
  assert.equal(traces[0].injected.find((r) => r.id === "good").subjectId, "1");
  assert.equal(traces[0].injected.find((r) => r.id === "good").tags, "food");
});

test('actual recall prepares privacy before shared search and only gives owner requested summaries',async()=>{
 for(const key of ['private:1','private:2','group:9'])for(const asked of [true,false]){
  const order=[],body='你刚才在群里聊了什么';
  const ctx=vm.createContext({...human,crypto,AbortSignal,
   cfg:{ownerQQ:'1',socialV2:{humanContext:{enabled:true},memoryShare:{enabled:true},context:{enabled:false}}},
   recordRetrievalTrace:()=>{},noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},
   dailyMemorySubjects:new Map([[key,'1']]),dailyRecallQueries:new Map([[key,'1 '+body]]),
   getSocialV2State:()=>({}),memoryScope:k=>k,log:()=>{},recallQuery:()=>'',
   fetch:async()=>({ok:true,json:async()=>({results:[]})}),
   sharingPrivacy:{prepare:async(scope,query,opts)=>{order.push('privacy');assert.equal(opts.includeSummaries,key==='private:1'&&asked);return {summaries:opts.includeSummaries?[{id:'recap',scope:'group:7',text:'聊了种花。',participated:true}]:[]}}},
   memoryRequest:async route=>{order.push(route);return {results:[]}},
  });
  const fn=vm.runInContext(between('  async function withMemoryContext(','  const dailyRecallQueries')+';withMemoryContext',ctx);
  const text=await fn(key,body,{conversationRecall:asked});
  assert.equal(text.includes('聊了种花。'),key==='private:1'&&asked);
  assert.ok(order.indexOf('privacy')<order.indexOf('/search'));
  if(key==='private:1'&&asked)assert.match(text,/可自行选择讲述、简述或不谈/);
 }
});

test("actual noteEmotion/refinement replaces scores once and ignores a late response", async (t) => {
  const quotaDir = fs.mkdtempSync(path.join(os.tmpdir(), "feiyu-quota-"));
  t.after(() => {
    const rel = path.relative(os.tmpdir(), quotaDir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      fs.rmSync(quotaDir, { recursive: true, force: true });
  });
  let resolveModel;
  const ctx = vm.createContext({
    ...emotion,
    crypto,
    emotionState: emotion.emptyEmotion(),
    emotionLast: { text: "", at: 0 },
    path,
    STATE_DIR: quotaDir,
    appraisalContext,
    reserveAppraisal,
    cfg: {
      socialV2: {
        emotion: { appraisalModel: { enabled: true, maxPerDay: 3 } },
      },
    },
    emotionRecoveryCfg: () => ({}),
    recordEpisodeOutcome: () => {},
    maybeCreateEpisode: () => null,
    saveEmotionState: () => {},
    maybeQueueSpillover: () => {},
    log: () => {},
    runHeadlessPrompt: () => new Promise((r) => (resolveModel = r)),
  });
  bindScopes(ctx);
  vm.runInContext(
    between("  function noteEmotion(", "  const emotionTimer ="),
    ctx,
  );
  vm.runInContext("noteEmotion({text:'真有你的',key:'private:1'})", ctx);
  resolveModel(
    JSON.stringify({
      kind: "affection",
      target: "character",
      confidence: 0.9,
      intensity: 0.5,
      evidence: ["真有你的"],
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.emotionState.metrics.events, 1);
  assert.equal(ctx.emotionState.lastEvent.kind, "affection");
  assert.equal(ctx.emotionState.climate.owner.samples, 1);
  vm.runInContext("noteEmotion({text:'呵呵',key:'private:1'})", ctx);
  const stale = resolveModel;
  vm.runInContext("noteEmotion({text:'帮我看代码',key:'private:1'})", ctx);
  const before = ctx.emotionState;
  stale(
    JSON.stringify({
      kind: "conflict",
      target: "character",
      confidence: 0.95,
      intensity: 0.9,
      evidence: ["呵呵"],
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.emotionState, before);
});

test("manual reset invalidates in-flight appraisal and clears dynamics", () => {
  let impressionsCleared = false;
  const ctx = vm.createContext({
    ...emotion,
    idleAssociations: {clearImpressions: () => { impressionsCleared = true; }},
    emotionState: emotion.applyEmotionEvent(emotion.emptyEmotion(), {
      text: "你是废物",
      eventId: "pending",
    }),
    saveEmotionState: () => {},
    log: () => {},
  });
  vm.runInContext(
    between("  function resetEmotion()", "  function acceptEmotionDrift(") +
      ";resetEmotion()",
    ctx,
  );
  assert.equal(ctx.emotionState.dynamics.v, 0);
  assert.equal(ctx.emotionState.latestEventId, null);
  assert.equal(ctx.emotionState.lastCause, null);
  assert.equal(impressionsCleared, true);
});

test("actual model gate reviews ordinary owner messages, reuses semantic results and handles malformed output, outage and ignores legacy daily limits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feiyu-review-gate-"));
  t.after(() => {
    const rel = path.relative(os.tmpdir(), dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      fs.rmSync(dir, { recursive: true, force: true });
  });
  let calls = 0,
    prompt = "";
  const ctx = vm.createContext({
    ...emotion,
    crypto,
    path,
    STATE_DIR: dir,
    appraisalContext,
    reserveAppraisal,
    emotionState: emotion.emptyEmotion(),
    emotionLast: {},
    cfg: {
      socialV2: {
        emotion: { appraisalModel: { enabled: true, maxPerDay: 2 } },
      },
    },
    emotionRecoveryCfg: () => ({}),
    recordEpisodeOutcome: () => {},
    maybeCreateEpisode: () => null,
    saveEmotionState: () => {},
    maybeQueueSpillover: () => {},
    log: () => {},
    runHeadlessPrompt: async (p) => {
      prompt = p;
      calls++;
      if (calls <= 2) return "not JSON";
      throw Error("timeout");
    },
  });
  bindScopes(ctx);
  vm.runInContext(
    between("  function noteEmotion(", "  const emotionTimer ="),
    ctx,
  );
  await ctx.noteEmotion({
    text: "麻烦你帮我看代码",
    key: "private:1",
    speakerId: "1",
    messageId: "m1",
  });
  assert.equal(calls, 1);
  await ctx.noteEmotion({
    text: "你这个笨蛋，终于回来了😂",
    key: "private:1",
    speakerId: "1",
    messageId: "m2",
  });
  assert.equal(calls, 2);
  assert.equal(ctx.emotionState.lastEvent.review.status, "invalid-result");
  assert.ok(prompt.includes("recent"));
  assert.ok(prompt.includes("speakerId"));
  assert.ok(ctx.emotionState.state.valence >= 0.1);
  await ctx.noteEmotion({
    text: "你是个废物",
    key: "private:1",
    speakerId: "1",
    messageId: "m3",
  });
  assert.equal(calls, 3);
  assert.equal(ctx.emotionState.lastEvent.review.status, "unavailable");
  assert.ok(ctx.emotionState.state.valence >= 0.1);
  await ctx.noteEmotion({
    text: "你真是废物",
    key: "private:1",
    speakerId: "1",
    messageId: "m4",
  });
  assert.equal(calls, 4);
  assert.equal(ctx.emotionState.lastEvent.review.status, "unavailable");
  ctx.emotionLast = {};
  const count = ctx.emotionState.metrics.events;
  await ctx.noteEmotion({
    text: "你真是废物",
    key: "private:1",
    speakerId: "1",
    messageId: "m4",
  });
  assert.equal(ctx.emotionState.metrics.events, count);
  assert.equal(calls, 4);
  await ctx.noteEmotion({text:'今天好开心',key:'private:1',speakerId:'1',messageId:'shared',semanticAppraisal:{kind:'neutral',target:'none',confidence:.9,intensity:0,evidence:[],feelings:[{kind:'joy',intensity:.4,confidence:.9,reason:'分享好心情',evidence:'好开心'}]}});
  assert.equal(calls,4);assert.equal(ctx.emotionState.lastEvent.review.status,'shared-event');assert.match(ctx.emotionState.state.nuance,/轻快/);
  await ctx.noteEmotion({text:'/状态',key:'private:1',speakerId:'1',messageId:'command'});
  assert.equal(calls,4);

});

test("correction retracts matching derived episode and queued spillover without deleting unrelated history", () => {
  let saved = 0;
  const pending = { items: [{ emotionEventId: "a" }, { emotionEventId: "b" }] };
  const ctx = vm.createContext({
    episodes: [
      { emotionEventId: "a", summary: "original" },
      { emotionEventId: "b" },
    ],
    saveEpisodes: () => saved++,
    readSpillover: () => pending,
    saveSpillover: () => {},
    activeSpillover: { emotionEventId: "a" },
  });
  vm.runInContext(
    between(
      "  function reconcileEmotionCorrection(",
      "  function noteEmotion(",
    ),
    ctx,
  );
  ctx.reconcileEmotionCorrection({ status: "replayed", eventId: "a", at: 123 });
  assert.equal(saved, 1);
  assert.equal(ctx.episodes[0].emotionRetracted, true);
  assert.equal(ctx.episodes[0].summary, "original");
  assert.equal(ctx.episodes[1].emotionRetracted, undefined);
  assert.equal(pending.items[0].emotionEventId, "b");
  assert.equal(ctx.activeSpillover, null);
});


test('semantic fact reviewer is read-only, preserves context and rejects wrong revisions', async () => {
  const { reviewMemoryFacts } = await import('../bridge/fact-review.mjs');
  const context = { scope: 'private:1', revision: 'r1', candidate: { id: 'c', text: '茶是我的续命水', quote: '茶是我的续命水' }, related: [{ id: 'a', text: '早餐常吃小笼包', quote: '早餐常吃小笼包' }] };
  let seen = '';
  const result = await reviewMemoryFacts(context, async (prompt, timeout) => {
    seen = prompt; assert.equal(timeout, 12000);
    return JSON.stringify({ revision: 'r1', candidateEvidence: context.candidate.quote, relations: [{ id: 'a', relation: 'coexist', confidence: .99, evidence: context.related[0].quote }] });
  });
  assert.ok(seen.includes('茶是我的续命水'));
  assert.ok(seen.includes('不发送消息'));
  assert.equal(result.relations[0].relation, 'coexist');
  await assert.rejects(reviewMemoryFacts(context, async () => '{"revision":"wrong","relations":[]}'));
  await assert.rejects(reviewMemoryFacts({ ...context, related: Array(9).fill(context.related[0]) }, async () => '{}'));
});


test('memory extraction retains distinct facts from the same message and accepts semantic coexistence', async () => {
  const { memoryCandidates } = await import('../bridge/daily-memory.js');
  const messages = [{ id: 'message', userId: '1', text: '不喜欢吃煎饼，喜欢吃小笼包', time: Date.now() }];
  const rows = ['不喜欢吃煎饼', '喜欢吃小笼包'].map(quote => ({ source_id: 'message', quote, kind: 'preference', aspect: '饮食', confidence: .99, relation: 'coexist', relation_confidence: .99, related_id: '', fact: { object: quote.endsWith('小笼包') ? '小笼包' : '煎饼', attribute: '喜好', value: quote, condition: '', timeframe: '', cardinality: 'single', evidence: quote } }));
  for (const row of rows) row.assessment = {subject:'self',mode:'asserted',sensitive:false};
  const result = memoryCandidates(JSON.stringify(rows), messages, Date.now(), [], { autoConfirm: true });
  assert.equal(result.length, 2); assert.equal(result[0].source_id, result[1].source_id);
  assert.notEqual(result[0].fact.object, result[1].fact.object);
  assert.ok(result.every(r => r.relation === 'independent' && r.related_id === ''));
});
