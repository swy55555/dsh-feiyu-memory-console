// Conservative local appraisal. Confidence values are heuristics, not calibrated probabilities.
const kinds = new Set([
  "neutral",
  "uncertain",
  "user_distress",
  "third_party",
  "criticism",
  "conflict",
  "repair",
  "affection",
]);
const targets = new Set([
  "none",
  "unknown",
  "user",
  "third_party",
  "task",
  "character",
]);
const event = (kind, target, confidence, intensity, evidence = []) => ({
  kind,
  target,
  confidence,
  intensity,
  evidence,
});
export function classifyEmotion(text, { directed = true, kind = "" } = {}) {
  const raw = String(text || "")
    .trim()
    .slice(0, 4000);
  // Absence, sleep reminders and generated narration are not evidence of user hostility.
  if (["neglect", "bedtime"].includes(kind))
    return event("neutral", "none", 1, 0);
  if (!raw) return event("neutral", "none", 1, 0);
  // A reported utterance can span punctuation; do not turn its next clause into a direct attack.
  if (
    /^(?:今天)?(?:我的)?(?:老板|同事|朋友|别人|他|她|同学|客户).{0,8}(?:说|骂|觉得|评价|叫)/.test(
      raw,
    )
  )
    return event("third_party", "third_party", 0.9, 0, [raw.slice(0, 200)]);
  const clauses = raw
    .replace(/[“「『][^”」』]*[”」』]|"[^"\n]*"/g, "【引用】")
    .split(/[，,。.!！?？;；\n]|但是|可是|不过|而且|但/)
    .map((x) => x.trim())
    .filter(Boolean);
  const found = [];
  for (const text of clauses) {
    if (
      /(?:老板|同事|朋友|别人|他|她|同学|客户).{0,8}(?:说|骂|觉得|评价|叫)/.test(
        text,
      )
    ) {
      found.push(event("third_party", "third_party", 0.9, 0, [text]));
      continue;
    }
    if (
      /如果|假如|比如|例如|(?:我)?(?:没有|不是|没)说|才怪|不是不|并非不|不能不|这句话|怎么回复|如何回复/.test(
        text,
      )
    ) {
      found.push(event("uncertain", "unknown", 0.3, 0, [text]));
      continue;
    }
    const scoped = text
      .replace(
        /你(?:并不是|不是|并不|不|一点都不)(?:个|很|太)?(?:笨蛋|笨|废物|傻子|恶心)/g,
        "【否定评价】",
      )
      .replace(
        /(?:我|也)?(?:并没有|没有|并不|不)(?:真的)?(?:生气|讨厌你|想让你滚开)/g,
        "【否定情绪】",
      );
    const task = scoped.match(
      /你(?:刚才|这次|又)?(?:答错了|说错了|没理解|理解错了|搞错了)|(?:这个|你的|你这个)(?:回答|答案|结果).{0,8}(?:有问题|不对|错了|没用|用都没有|垃圾)|不喜欢你(?:的|这个)(?:回答|答案)/,
    );
    if (task) {
      found.push(event("criticism", "task", 0.9, 0.3, [task[0]]));
      continue;
    }
    const attack = scoped.match(
      /你(?:可真是|真是|就是|是个|是|这个|太|很|真|怎么这么|也太|也|简直是|根本就是)?(?:个)?(?:废物|笨蛋|傻子|傻逼|蠢货|恶心)|你能不能别这么蠢|(?:我)?(?:真的|很|非常|就是)?讨厌你|^(?:你)?(?:给我)?(?:滚开|闭嘴|别烦我)[吧啊]*$|^(?:you are|you're) (?:an? )?(?:idiot|useless|stupid)$/i,
    );
    if (attack) {
      found.push(
        directed
          ? event("conflict", "character", 0.95, 0.9, [attack[0]])
          : event("uncertain", "unknown", 0.3, 0, [attack[0]]),
      );
      continue;
    }
    if (
      /呵呵|可真|大聪明|气死|无语|真有你的|真会谢|对不起个屁|不是我的错|都是你的错/.test(
        text,
      )
    ) {
      found.push(event("uncertain", "unknown", 0.3, 0, [text]));
      continue;
    }
    const repair = text.match(
      /对不起|抱歉|我错了|刚才是我(?:表达|说)错了|别生气|别气|消消气|(?:我|也)?(?:没有|不)讨厌你|\bsorry\b/i,
    );
    if (repair) {
      found.push(event("repair", "character", 0.9, 0.6, [repair[0]]));
      continue;
    }
    const distress = scoped.match(
      /我(?:今天|现在|真的|有点|很|好|特别|太|感觉|觉得|有些|还是|最近)*(?:难过|难受|孤单|害怕|委屈|想哭|烦躁|烦死了)/,
    );
    if (distress) {
      found.push(event("user_distress", "user", 0.9, 0.5, [distress[0]]));
      continue;
    }
    if (
      /(?:不|没|没有|并不|并没有)(?:喜欢你|爱你|想你)|不是谢谢|别谢/.test(
        scoped,
      )
    ) {
      found.push(event("uncertain", "unknown", 0.3, 0, [text]));
      continue;
    }
    const warmth = scoped.match(
      /谢谢(?:你)?|辛苦(?:你)?了|你很聪明|你真棒|(?:我觉得)?你很好|有你在我就放心了|(?<!不)喜欢你|爱你|抱抱|\bthank you\b/i,
    );
    if (warmth) {
      found.push(
        directed
          ? event("affection", "character", 0.9, 0.5, [warmth[0]])
          : event("neutral", "none", 0.9, 0),
      );
      continue;
    }
    if (
      /麻烦你|烦请|滚动|往下滚|随便选|任选|帮我|代码|咖啡|吃面|继续看|是什么意思|平静|【否定/.test(
        scoped,
      )
    ) {
      found.push(event("neutral", "none", 0.9, 0));
      continue;
    }
    found.push(event("uncertain", "unknown", 0.3, 0, [text]));
  }
  for (const kind of [
    "conflict",
    "criticism",
    "user_distress",
    "repair",
    "uncertain",
    "affection",
    "third_party",
    "neutral",
  ]) {
    const value = found.find((x) => x.kind === kind);
    if (value) return value;
  }
  return event("neutral", "none", 1, 0);
}
export function validateSemanticAppraisal(value, text) {
  if (
    !value ||
    typeof value !== "object" ||
    !kinds.has(value.kind) ||
    !targets.has(value.target)
  )
    return null;
  for (const field of ["confidence", "intensity"])
    if (
      typeof value[field] !== "number" ||
      !Number.isFinite(value[field]) ||
      value[field] < 0 ||
      value[field] > 1
    )
      return null;
  const expected = {
    conflict: "character",
    repair: "character",
    affection: "character",
    criticism: "task",
    user_distress: "user",
    third_party: "third_party",
    neutral: "none",
    uncertain: "unknown",
  };
  if (value.target !== expected[value.kind]) return null;
  if (!Array.isArray(value.evidence) || value.evidence.length > 4) return null;
  const original = String(text || "");
  if (
    value.evidence.some(
      (s) =>
        typeof s !== "string" ||
        !s.trim() ||
        s.length > 200 ||
        !original.includes(s),
    )
  )
    return null;
  if (!["neutral", "uncertain"].includes(value.kind) && !value.evidence.length)
    return null;
  const feelingKinds=new Set(['warmth','joy','curiosity','relief','concern','disappointment']);
  if(value.feelings!==undefined&&(!Array.isArray(value.feelings)||value.feelings.length>2))return null;
  const feelings=value.feelings||[];
  if(new Set(feelings.map(f=>f?.kind)).size!==feelings.length||feelings.some(f=>!feelingKinds.has(f?.kind)||typeof f.intensity!=='number'||!Number.isFinite(f.intensity)||f.intensity<0||f.intensity>1||typeof f.evidence!=='string'||!f.evidence.trim()||f.evidence.length>200||!original.includes(f.evidence)))return null;
  if(feelings.some(f=>(f.action!==undefined&&!['evoke','settle'].includes(f.action))||(f.action==='settle'&&f.intensity!==0)))return null;
  if(feelings.some(f=>(f.confidence!==undefined&&(!Number.isFinite(f.confidence)||f.confidence<0||f.confidence>1))||(f.reason!==undefined&&(typeof f.reason!=='string'||f.reason.length>100))))return null;
  return {...event(
    value.kind,
    value.target,
    value.confidence,
    value.intensity,
    value.evidence,
  ), feelings:feelings.map(f=>({kind:f.kind,intensity:f.intensity,evidence:f.evidence,confidence:f.confidence??value.confidence,reason:f.reason||'',action:f.action||'evoke'}))};
}
export function appraisalScores(value, weight = 1) {
  const polarity =
    value.kind === "conflict"
      ? -value.intensity
      : value.kind === "affection"
        ? value.intensity
        : 0;
  return {
    ...value,
    polarity,
    goal: polarity * 0.8,
    social: polarity * 0.7,
    novelty: 0,
    control: 0.7,
    positive: polarity > 0 ? 1 : 0,
    negative: polarity < 0 ? 1 : 0,
    weight: Math.max(0.2, Math.min(3, Number(weight) || 1)),
  };
}

// Stable temperament is context for reaction style, never evidence about the user.
export function temperamentContext(persona) {
  return (Array.isArray(persona?.spec?.dimensions)?persona.spec.dimensions:[]).slice(0,8)
    .filter(d=>d&&typeof d.key==='string'&&Number.isFinite(persona.baseline?.[d.key]))
    .map(d=>({trait:String(d.label||d.key).slice(0,40),description:String(d.desc||'').slice(0,80),baseline:Math.max(0,Math.min(100,persona.baseline[d.key]))}));
}
