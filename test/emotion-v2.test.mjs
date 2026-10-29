import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyEmotion,
  normalizeEmotion,
  applyEmotionEvent,
  tickEmotion,
  refineEmotionEvent,
  emotionPromptLine,
  suggestPersonalityDrift,
} from "../bridge/emotion.js";
import {
  classifyEmotion,
  validateSemanticAppraisal,
} from "../bridge/emotion-appraisal.mjs";
const start = 1800000000000,
  near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const say = (s, text, i = 0, extra = {}) =>
  applyEmotionEvent(
    s,
    { text, source: "owner", chatKey: "private:1", eventId: `e${i}`, ...extra },
    start + i * 60000,
  );

test("ordinary requests, negation, quotes, task correction and distress never create anger", () => {
  const phrases = [
    "麻烦你帮我看看",
    "烦请继续",
    "往下滚动一下",
    "随便选一个",
    "你答错了",
    "你这个回答一点用都没有",
    "我今天很难过",
    "我真的害怕",
    "我不生气",
    "我没有讨厌你",
    "你不是废物",
    "他说“你是废物”",
    "朋友说，你是废物",
    "如果我说你是废物呢",
    "我没有说你是废物",
    "你可真是大聪明",
    "对不起个屁",
    "这个词“闭嘴”是什么意思",
  ];
  for (const text of phrases) {
    const s = say(emptyEmotion(start), text);
    assert.notEqual(s.lastEvent.kind, "conflict", text);
    assert.ok(s.state.valence >= 0.07, text);
    assert.equal(s.state.holdUntil, 0);
    assert.equal(s.relationshipSamples, 0, text);
  }
});
test("distress changes caring stance, task criticism has a small bounded effect", () => {
  const s = say(emptyEmotion(start), "我今天很难过");
  assert.equal(s.stance, "关切用户");
  near(s.state.valence, 0.12);
  let c = emptyEmotion(start);
  for (let i = 0; i < 100; i++) c = say(c, "你答错了", i);
  assert.ok(c.state.valence >= 0.07 - 1e-10);
  assert.equal(c.state.label, "平静");
  assert.equal(c.climate.owner.samples, 0);
});
test("clear repeated attacks accumulate, one apology helps without instantly erasing conflict", () => {
  let s = emptyEmotion(start);
  for (let i = 0; i < 3; i++) s = say(s, "你是个废物", i);
  assert.equal(s.state.label, "生气");
  assert.ok(s.state.valence > -0.6);
  const v = s.state.valence,
    c = s.dynamics.conflict;
  s = say(s, "对不起，刚才我说错了", 3);
  assert.ok(s.state.valence > v);
  assert.ok(s.state.valence < 0.12);
  assert.ok(s.dynamics.conflict < c);
  const out = tickEmotion(s, start + 180 * 60000);
  near(out.baseline.valence, 0.12);
  assert.equal(out.state.label, "平静");
});
test("recovery is independent of timer frequency, neutral chat cannot relatch anger", () => {
  const initial = say(emptyEmotion(start), "你是个废物");
  let fine = initial;
  for (let i = 1; i <= 60; i++) fine = tickEmotion(fine, start + i * 60000);
  const coarse = tickEmotion(initial, start + 60 * 60000);
  near(fine.state.valence, coarse.state.valence);
  near(fine.mood.valence, coarse.mood.valence);
  let s = initial;
  for (let i = 1; i < 30; i++) {
    const old = s.state.valence;
    s = say(s, "帮我看代码", i);
    assert.ok(s.state.valence >= old);
  }
  assert.equal(s.climate.owner.samples, 1);
  assert.equal(tickEmotion(s, start).updatedAt, s.updatedAt);
});
test("absence, bedtime and non-directed group statements do not punish relationships", () => {
  for (const kind of ["neglect", "bedtime"]) {
    const s = say(emptyEmotion(start), "你是废物", 0, { kind });
    near(s.state.valence, kind === "neglect" ? 0.04 : 0.12);
    assert.equal(s.relationshipSamples, 0);
  }
  const s = say(emptyEmotion(start), "你是废物", 0, {
    directed: false,
    source: "group",
  });
  near(s.state.valence, 0.12);
});
test("missing someone stays mild, never accumulates conflict, and a normal return resolves it", () => {
  let s = emptyEmotion(start);
  for (let i = 0; i < 50; i++)
    s = say(s, "好久没聊天了", i, { kind: "neglect" });
  near(s.state.valence, 0.04);
  assert.equal(s.dynamics.conflict, 0);
  assert.equal(s.relationshipSamples, 0);
  assert.equal(s.climate.owner.samples, 0);
  assert.match(s.stance, /想念/);
  const returned = say(s, "我回来了，今天吃了面", 51);
  near(returned.state.valence, 0.12);
  near(returned.dynamics.longing, 0);
  assert.equal(returned.lastCause, null);
  const fine = tickEmotion(
      tickEmotion(s, start + 60 * 60000),
      start + 120 * 60000,
    ),
    coarse = tickEmotion(s, start + 120 * 60000);
  near(fine.dynamics.longing, coarse.dynamics.longing);
});
test("migration preserves history and baseline, drops old hard hold and quarantines old climate", () => {
  const old = {
    version: 1,
    baseline: { valence: 0.2, arousal: 0.3 },
    state: {
      valence: -0.4,
      arousal: 0.7,
      holdUntil: start + 1e9,
      holdValence: -0.4,
    },
    history: [{ at: start, v: -0.4 }],
    climate: {
      owner: {
        samples: 100,
        valence: -0.9,
        arousal: 0.9,
        lastAt: start,
        since: start - 10 * 86400000,
      },
    },
  };
  const snapshot = JSON.stringify(old),
    s = normalizeEmotion(old, start);
  assert.equal(JSON.stringify(old), snapshot);
  assert.equal(s.state.holdUntil, 0);
  assert.equal(s.history.length, 1);
  near(s.baseline.valence, 0.2);
  assert.equal(suggestPersonalityDrift(s, { now: start }).eligible, false);
  assert.ok(tickEmotion(s, start + 60000).state.valence > s.state.valence);
});
test("deduplication and model refinement replace one event; stale/invalid responses do nothing", () => {
  const before = emptyEmotion(start),
    input = {
      eventId: "model1",
      at: start,
      text: "真有你的",
      source: "owner",
      chatKey: "private:1",
    };
  const local = applyEmotionEvent(before, input, start),
    ap = {
      kind: "affection",
      target: "character",
      confidence: 0.9,
      intensity: 0.5,
      evidence: ["真有你的"],
    };
  const revised = refineEmotionEvent(local, before, input, ap, start + 1000);
  assert.equal(revised.metrics.events, 1);
  assert.equal(revised.climate.owner.samples, 1);
  assert.equal(revised.triggers.length, 1);
  assert.equal(
    applyEmotionEvent(revised, input, start + 1000).metrics.events,
    1,
  );
  const later = say(local, "继续看代码", 2);
  assert.equal(
    refineEmotionEvent(later, before, input, ap, start + 200000),
    later,
  );
  for (const bad of [
    { ...ap, evidence: ["伪造"] },
    { ...ap, target: "user" },
    { ...ap, confidence: 2 },
    { ...ap, evidence: [] },
    { ...ap, intensity: "1" },
  ])
    assert.equal(validateSemanticAppraisal(bad, input.text), null);
});
test("low confidence cannot create conflict, private cause stays out of group prompt", () => {
  let s = say(emptyEmotion(start), "你是废物", 0, {
    appraisal: {
      kind: "conflict",
      target: "character",
      confidence: 0.5,
      intensity: 1,
      evidence: ["你是废物"],
    },
  });
  near(s.state.valence, 0.12);
  s = say(s, "你是废物", 1);
  assert.ok(emotionPromptLine(s, { isOwner: true }).includes("你是废物"));
  assert.ok(!emotionPromptLine(s).includes("你是废物"));
});
test("bounded deterministic dynamics across long mixed conversations", () => {
  let a = emptyEmotion(start),
    b = emptyEmotion(start);
  const phrases = [
    "你是废物",
    "谢谢你",
    "对不起",
    "麻烦你",
    "我很难过",
    "你答错了",
  ];
  for (let i = 0; i < 2000; i++) {
    const text = phrases[(i * 17 + i * i) % phrases.length];
    a = say(a, text, i);
    b = say(b, text, i);
    assert.ok(a.state.valence >= -1 && a.state.valence <= 1);
    assert.ok(a.state.arousal >= 0 && a.state.arousal <= 1);
    assert.ok(a.triggers.length <= 80);
  }
  assert.deepEqual(a, b);
  near(a.baseline.valence, 0.12);
});
