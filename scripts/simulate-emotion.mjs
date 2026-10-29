// Offline deterministic engine simulation; no LLM, QQ messages or state-file writes.
import {
  emptyEmotion,
  applyEmotionEvent,
  tickEmotion,
} from "../bridge/emotion.js";
export const cases = [
  {
    name: "亲昵玩笑与角色扮演",
    steps: [
      { text: "你这个笨蛋，终于回来啦😂" },
      { text: "我们来角色扮演" },
      { text: "你是废物" },
      { text: "不演了，我是认真的，你是废物" },
    ],
  },
  {
    name: "提前说明去忙与没有说明离开",
    steps: [
      { text: "我要开会两个小时，晚点再聊" },
      { wait: 60 },
      { text: "很久没联系", kind: "neglect" },
      { wait: 61 },
      { text: "仍然没有联系", kind: "neglect" },
      { text: "我忙完了，回来了" },
    ],
  },
  {
    name: "澄清误会而不是普通道歉",
    steps: [
      { text: "你是个废物" },
      { text: "帮我看一下代码" },
      { text: "刚才说的不是你" },
    ],
  },
  {
    name: "等待复核或模型不可用时保守处理",
    steps: [
      { text: "你是个废物", deferToModel: true },
      { text: "你这个笨蛋，终于回来了😂", deferToModel: true },
    ],
  },
  {
    name: "普通聊天与用户诉苦",
    steps: [
      { text: "麻烦你帮我看一下代码" },
      { text: "我今天很难过" },
      { text: "你刚才答错了" },
      { text: "随便选一个" },
      { text: "继续看看" },
    ],
  },
  {
    name: "明确冲突、道歉与恢复",
    steps: [
      { text: "你是个废物" },
      { text: "你是个废物" },
      { text: "你是个废物" },
      { text: "对不起，刚才是我说错了" },
      { text: "我们继续聊吧" },
      { wait: 30 },
      { wait: 180 },
    ],
  },
  {
    name: "转述、否定和不确定语气",
    steps: [
      { text: "朋友说，你是废物" },
      { text: "我没有讨厌你" },
      { text: "你可真是大聪明" },
      { text: "如果我说你是废物呢" },
    ],
  },
  {
    name: "久未联系、小失落、正常回来",
    steps: [
      { text: "很久没来聊天了", kind: "neglect" },
      { wait: 10 },
      { text: "还是没来聊天", kind: "neglect" },
      { text: "我回来了，今天吃了面" },
    ],
  },
];
const begin = Date.UTC(2026, 9, 29, 0, 0, 0);
const results = cases.map((scenario) => {
  let state = emptyEmotion(begin),
    now = begin;
  const steps = scenario.steps.map((input, i) => {
    now += (input.wait ?? 1) * 60000;
    state = input.wait
      ? tickEmotion(state, now)
      : applyEmotionEvent(
          state,
          {
            ...input,
            source: "owner",
            chatKey: "private:1",
            eventId: `${scenario.name}-${i}`,
          },
          now,
        );
    return {
      input: input.wait ? `等待 ${input.wait} 分钟` : input.text,
      event: input.wait ? "time" : state.lastEvent.kind,
      label: state.state.label,
      stance: state.stance,
      valence: Number(state.state.valence.toFixed(3)),
      arousal: Number(state.state.arousal.toFixed(3)),
      conflict: Number(state.dynamics.conflict.toFixed(3)),
      longing: Number(state.dynamics.longing.toFixed(3)),
      relationshipSamples: state.relationshipSamples,
      reviewNeeded: !input.wait && state.lastEvent.reviewNeeded,
      correction: input.wait ? null : state.lastEvent.correction || null,
      expectedAbsence: input.wait ? null : state.lastEvent.expectedAbsence,
    };
  });
  return { name: scenario.name, steps };
});
console.log(
  JSON.stringify(
    {
      version: "0.8.10",
      method: "deterministic offline engine; no generated dialogue",
      results,
    },
    null,
    2,
  ),
);
