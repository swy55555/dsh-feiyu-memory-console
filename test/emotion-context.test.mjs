import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyEmotion,
  applyEmotionEvent,
  tickEmotion,
  refineEmotionEvent,
} from "../bridge/emotion.js";
import {
  contextIdentity,
  expectedAbsence,
  appraisalContext,
} from "../bridge/emotion-context.mjs";
import { reserveAppraisal } from "../bridge/appraisal-budget.mjs";
const start = Date.UTC(2026, 9, 29, 10),
  near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const say = (s, text, i, extra = {}) =>
  applyEmotionEvent(
    s,
    {
      source: "owner",
      chatKey: "private:1",
      speakerId: "1",
      messageId: `m${i}`,
      eventId: `e${i}`,
      text,
      ...extra,
    },
    start + i * 60000,
  );
test("affectionate teasing and roleplay are not counted as attacks; explicit seriousness exits frame", () => {
  let s = say(emptyEmotion(start), "你这个笨蛋，终于回来啦😂", 0);
  near(s.state.valence, 0.12);
  assert.equal(s.lastEvent.reviewNeeded, true);
  s = say(s, "我们来角色扮演", 1);
  s = say(s, "你是废物", 2);
  near(s.state.valence, 0.12);
  s = say(s, "不演了，我是认真的，你是废物", 3);
  assert.equal(s.lastEvent.kind, "conflict");
  assert.ok(s.state.valence < 0);
});
test("frames expire and remain isolated by participant and chat", () => {
  let s = say(emptyEmotion(start), "我们来角色扮演", 0, { chatKey: "group:9" });
  const other = say(s, "你是废物", 1, { chatKey: "group:9", speakerId: "2" });
  assert.equal(other.lastEvent.kind, "conflict");
  const privateChat = say(s, "你是废物", 1);
  assert.equal(privateChat.lastEvent.kind, "conflict");
  s = say(s, "你是废物", 31, { chatKey: "group:9" });
  assert.equal(s.lastEvent.kind, "conflict");
});
test("explicit busy window suppresses longing only while valid; ordinary return ends it", () => {
  let s = say(emptyEmotion(start), "我要开会两个小时，晚点再聊", 0);
  assert.equal(
    expectedAbsence(s, { chatKey: "private:1", speakerId: "1" }, start + 60000),
    true,
  );
  s = say(s, "很久没聊天", 60, { kind: "neglect" });
  near(s.state.valence, 0.12);
  assert.equal(s.lastEvent.expectedAbsence, true);
  const expired = say(s, "很久没聊天", 121, { kind: "neglect" });
  near(expired.dynamics.longing, 0.08);
  s = say(s, "我忙完了，现在可以聊", 61);
  assert.equal(
    expectedAbsence(
      s,
      { chatKey: "private:1", speakerId: "1" },
      start + 62 * 60000,
    ),
    false,
  );
  const other = say(s, "好久没聊天", 62, {
    kind: "neglect",
    chatKey: "private:2",
    speakerId: "2",
  });
  near(other.dynamics.longing, 0.08);
});
test("quoted, hypothetical or negated busyness never changes availability", () => {
  for (const text of [
    "他说“我要忙两个小时”",
    "如果我明天再聊呢",
    "我不是要去忙",
  ]) {
    const s = say(emptyEmotion(start), text, 0);
    assert.equal(
      expectedAbsence(s, { chatKey: "private:1", speakerId: "1" }, start + 1),
      false,
      text,
    );
  }
});
test("clarification replays just the matched event and preserves later independent events", () => {
  let s = say(emptyEmotion(start), "你是废物", 0);
  s = say(s, "你是废物", 1, { speakerId: "2", chatKey: "private:2" });
  s = say(s, "刚才说的不是你", 2);
  let expected = say(emptyEmotion(start), "普通话", 0);
  expected = say(expected, "你是废物", 1, {
    speakerId: "2",
    chatKey: "private:2",
  });
  expected = say(expected, "普通话", 2);
  near(s.state.valence, expected.state.valence);
  near(s.dynamics.conflict, expected.dynamics.conflict);
  near(s.mood.valence, expected.mood.valence);
  assert.equal(s.relationshipSamples, 1);
  assert.equal(s.metrics.events, 3);
  assert.equal(s.corrections[0].eventId, "e0");
  assert.equal(s.lastCause.eventId, "e1");
});
test("quoted message IDs anchor corrections; wrong participant or stale correction cannot clear conflict", () => {
  let s = say(emptyEmotion(start), "你是废物", 0, { chatKey: "group:1" });
  const wrong = say(s, "刚才说的不是你", 1, {
    chatKey: "group:1",
    speakerId: "2",
  });
  assert.equal(wrong.lastEvent.correction.status, "no-matching-event");
  assert.ok(wrong.dynamics.conflict > 0);
  const matched = say(s, "那句是台词", 2, {
    chatKey: "group:1",
    replyToId: "m0",
    replyTarget: "other",
  });
  near(matched.dynamics.conflict, 0);
  const wrongId = say(s, "那句是台词", 2, {
    chatKey: "group:1",
    replyToId: "different",
  });
  assert.equal(wrongId.lastEvent.correction.status, "no-matching-event");
  const stale = say(s, "刚才说的不是你", 11, { chatKey: "group:1" });
  assert.equal(stale.lastEvent.correction.status, "no-matching-event");
});
test("a new attack after clarification is still an attack; duplicate IDs do not replay twice", () => {
  let s = say(emptyEmotion(start), "你是废物", 0);
  s = say(s, "我不是在骂你，但是你是个废物", 1);
  assert.equal(s.lastEvent.kind, "conflict");
  assert.equal(s.corrections.length, 0);
  const duplicate = say(s, "我不是在骂你，但是你是个废物", 1);
  assert.equal(duplicate.metrics.events, s.metrics.events);
});
test("personality edits invalidate replay, and JSON persistence retains context and bounded journal", () => {
  let s = say(emptyEmotion(start), "你是废物", 0);
  s.drifts = [{ id: "manual-edit" }];
  s = say(s, "刚才说的不是你", 1);
  assert.equal(s.lastEvent.correction.status, "no-matching-event");
  s = say(s, "我要忙两个小时", 2);
  s = JSON.parse(JSON.stringify(s));
  assert.equal(
    expectedAbsence(
      s,
      { chatKey: "private:1", speakerId: "1" },
      start + 3 * 60000,
    ),
    true,
  );
  for (let i = 3; i < 50; i++) s = say(s, "帮我看代码", i);
  assert.ok(s.journal.events.length <= 16);
  assert.ok(!s.journal.base.journal);
  assert.ok(
    s.situations[contextIdentity({ chatKey: "private:1", speakerId: "1" })]
      .messages.length <= 8,
  );
});
test("model receives bounded same-chat context and unresolved event; provisional judgments do not punish", () => {
  const before = emptyEmotion(start),
    input = {
      source: "owner",
      chatKey: "private:1",
      speakerId: "1",
      eventId: "model",
      at: start,
      text: "你是废物",
      deferToModel: true,
      recentMessages: [
        { chatKey: "private:2", text: "secret", speakerId: "2" },
        { chatKey: "private:1", text: "刚才在开玩笑", isSelf: true },
      ],
    };
  const current = applyEmotionEvent(before, input, start);
  near(current.state.valence, 0.12);
  assert.equal(current.lastEvent.reviewNeeded, true);
  const context = appraisalContext(current, input);
  assert.ok(!JSON.stringify(context).includes("secret"));
  assert.equal(context.recent[0].role, "assistant");
  const ap = {
    kind: "conflict",
    target: "character",
    confidence: 0.95,
    intensity: 0.9,
    evidence: ["你是废物"],
  };
  const refined = refineEmotionEvent(current, before, input, ap, start + 1000);
  assert.equal(refined.metrics.events, 1);
  assert.equal(refined.relationshipSamples, 1);
  assert.ok(refined.state.valence < 0);
});
test("persistent quota survives restart, respects zero, resets at Shanghai midnight and fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feiyu-budget-")),
    file = path.join(dir, "quota.json");
  try {
    assert.equal(reserveAppraisal(file, 0, start).ok, false);
    assert.equal(reserveAppraisal(file, 2, start).count, 1);
    assert.equal(reserveAppraisal(file, 2, start + 1).count, 2);
    assert.equal(reserveAppraisal(file, 2, start + 2).reason, "daily-limit");
    assert.equal(reserveAppraisal(file, 2, Date.UTC(2026, 9, 29, 16)).count, 1);
    fs.writeFileSync(file, "broken");
    assert.equal(reserveAppraisal(file, 2, start).reason, "budget-unavailable");
  } finally {
    const rel = path.relative(os.tmpdir(), dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('unlimited reviews continue past old caps, survive restart and do not depend on counter availability',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-unlimited-')),file=path.join(dir,'quota.json');
 try {
  const day=new Date(start+8*3600000).toISOString().slice(0,10);
  fs.writeFileSync(file,JSON.stringify({day,count:1000}));
  for(let i=0;i<120;i++){const result=reserveAppraisal(file,null,start+i);assert.equal(result.ok,true);assert.equal(result.maximum,null);assert.equal(result.count,1001+i);}
  assert.equal(reserveAppraisal(file,undefined,start+200).count,1121);
  fs.writeFileSync(file,'broken');const result=reserveAppraisal(file,null,start);assert.equal(result.ok,true);assert.equal(result.counterAvailable,false);assert.equal(result.maximum,null);
 } finally {const rel=path.relative(os.tmpdir(),dir);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(dir,{recursive:true,force:true});}
});
