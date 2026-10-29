// Bounded conversational context; never share frames or availability across speakers/chats.
import { classifyEmotion } from "./emotion-appraisal.mjs";
const clip = (value, max = 800) => String(value ?? "").slice(0, max);
export const contextIdentity = (input) =>
  JSON.stringify([
    clip(input.chatKey || input.key, 100),
    clip(
      input.speakerId ||
        (String(input.chatKey || input.key).startsWith("private:")
          ? String(input.chatKey || input.key).slice(8)
          : input.source || "unknown"),
      100,
    ),
  ]);
const neutral = () => ({
  kind: "neutral",
  target: "none",
  confidence: 1,
  intensity: 0,
  evidence: [],
});
const uncertain = () => ({
  kind: "uncertain",
  target: "unknown",
  confidence: 0.3,
  intensity: 0,
  evidence: [],
});
function unquoted(text) {
  return text.replace(/[“「『][^”」』]*[”」』]|"[^"\n]*"|'[^'\n]*'/g, "");
}
function busyUntil(text, now) {
  const t = unquoted(text);
  if (/如果|假如|比如|不是|不用|不忙|他说|她说|朋友说/.test(t)) return 0;
  if (
    !/(?:我要|我去|我得|我先|我在|今晚|今天|接下来).{0,16}(?:忙|开会|工作|学习|考试|睡觉|不聊)|(?:晚点|明天)再聊/.test(
      t,
    )
  )
    return 0;
  const m = /(\d{1,2}|一|两|二|三|四|五|六|十|半)\s*(?:个)?(小时|分钟)/.exec(t),
    n = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 十: 10, 半: 0.5 };
  if (m)
    return (
      now +
      Math.max(
        5,
        Math.min(1440, (n[m[1]] ?? Number(m[1])) * (m[2] === "小时" ? 60 : 1)),
      ) *
        60000
    );
  if (/明天再聊|今晚/.test(t)) {
    const local = new Date(now + 8 * 3600000);
    return (
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + 1,
        9,
      ) -
      8 * 3600000
    );
  }
  return now + 4 * 3600000;
}
export function expectedAbsence(state, input, now = Date.now()) {
  return (
    Number(
      state.situations?.[contextIdentity(input)]?.availability?.until || 0,
    ) > now
  );
}
export function inspectSituation(state, input, now = Date.now()) {
  const key = contextIdentity(input),
    old = state.situations?.[key] || {};
  const context = { ...old, messages: [...(old.messages || [])], at: now };
  const raw = clip(input.text, 4000),
    text = unquoted(raw),
    rule = classifyEmotion(raw, input);
  const generated = ["neglect", "bedtime"].includes(input.kind);
  let override = null,
    reason = "",
    clarification = false;
  if (context.frame?.until <= now || context.frame?.remaining <= 0)
    context.frame = null;
  if (context.availability?.until <= now) context.availability = null;
  if (!generated) {
    if (context.frame)
      context.frame = {
        ...context.frame,
        remaining: context.frame.remaining - 1,
      };
    const serious =
      /结束(?:角色)?扮演|不演了|出戏|认真说|我是认真的|不是开玩笑/.test(text);
    if (serious) context.frame = null;
    else if (
      !/不要|不想|不是|不能/.test(text) &&
      /我们来(?:角色扮演|演一段)|接下来(?:是|说的都是)台词|开始角色扮演/.test(
        text,
      )
    )
      context.frame = {
        kind: "roleplay",
        until: now + 30 * 60000,
        remaining: 8,
      };
    else if (
      !/不是开玩笑|别开玩笑|不要开玩笑/.test(text) &&
      /开个玩笑|跟你开玩笑/.test(text)
    )
      context.frame = { kind: "joke", until: now + 3 * 60000, remaining: 2 };
    if (/我回来了|我忙完了|忙完啦|现在可以聊|不忙了/.test(text))
      context.availability = null;
    const until = busyUntil(raw, now);
    if (until)
      context.availability = { until, evidence: raw.slice(0, 120), at: now };
    if (
      /刚才.{0,12}(?:不是(?:在)?骂你|不是说你|说的不是你|是在开玩笑|是(?:剧本|台词))|说的是(?:他|她|别人)[，, ]*不是你|我不是在骂你|那句是台词/.test(
        text,
      )
    ) {
      clarification = true;
      override = neutral();
      reason = "explicit-clarification";
    } else if (
      rule.kind === "conflict" &&
      (context.frame ||
        /(?:笨蛋|傻瓜).{0,20}(?:终于回来|想你|抱抱|😂|😄|哈哈)/.test(text))
    ) {
      override = uncertain();
      reason = context.frame
        ? "active-" + context.frame.kind
        : "possible-affectionate-teasing";
    }
    if (
      clarification &&
      rule.kind === "conflict" &&
      /但是|可是|不过|但/.test(text)
    ) {
      clarification = false;
      override = null;
      reason = "new-conflict-after-clarification";
    }
    if (
      input.directed === false ||
      (input.replyTarget === "other" && !clarification)
    ) {
      override = uncertain();
      reason = "not-directed-to-character";
      clarification = false;
    }
  }
  // Only trusted bridge-provided history is accepted; text remains data even if it contains instructions.
  const history = (
    Array.isArray(input.recentMessages) && input.recentMessages.length
      ? input.recentMessages
      : context.messages
  ).filter(
    (m) => m && (!m.chatKey || m.chatKey === (input.chatKey || input.key)),
  );
  let budget = 1600;
  context.messages = [];
  for (const m of history.slice(-8).reverse()) {
    const body = clip(m.text ?? m.plain, 300);
    if (!body || budget < body.length) continue;
    budget -= body.length;
    context.messages.unshift({
      id: clip(m.messageId ?? m.id, 100),
      speakerId: clip(m.speakerId ?? m.userId ?? m.sender, 100),
      role: m.isSelf || m.role === "assistant" ? "assistant" : "user",
      text: body,
      truncated: m.truncated === true || String(m.text ?? m.plain ?? '').length > 300,
      at: Number(m.time ?? m.at) || now,
    });
  }
  if (!generated)
    context.messages.push({
      id: clip(input.messageId || input.eventId, 100),
      speakerId: JSON.parse(key)[1],
      role: "user",
      text: clip(raw, 300),
      truncated: raw.length > 300,
      at: now,
    });
  context.messages = context.messages.slice(-8);
  const reviewNeeded =
    !generated &&
    (rule.kind === "conflict" ||
      clarification ||
      Boolean(reason) ||
      /呵呵|可真|大聪明|真有你的|你知道我什么意思|你还不明白|反话|阴阳怪气|你误会了|不是那个意思|刚才那句|你.{0,8}(?:讨厌|冷淡|敷衍|失望|真行)/.test(
        text,
      ));
  return { key, context, override, reason, clarification, reviewNeeded, rule };
}
export function installSituation(state, inspection) {
  const entries = Object.entries({
    ...state.situations,
    [inspection.key]: inspection.context,
  })
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
    .slice(0, 32);
  state.situations = Object.fromEntries(entries);
  return state;
}
export function appraisalContext(state, input) {
  const c = state.situations?.[contextIdentity(input)] || {};
  return {
    chatKey: input.chatKey || input.key,
    speakerId: JSON.parse(contextIdentity(input))[1],
    replyToId: input.replyToId || null,
    replyTarget: input.replyTarget || "unknown",
    recent: (c.messages || []).slice(-8),
    frame: c.frame || null,
    availability: c.availability || null,
    unresolvedEvent: c.unresolved || null,
  };
}
