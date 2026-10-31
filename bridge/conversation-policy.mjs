// Only known bridge-owned protocol sentences are migrated. Custom text survives.
const PREVIOUS_STYLE_CHECK_POLICY='同轮准备发送的完整表达合并调用 fishtalk_check；拆成多条发送不逐条重查，内容未修改时复用本轮结果。检查只建议措辞，不判断用户的真实需求或角色立场。发现问题时保留具体回应的意思再改写，最多复查一次；达到次数后停止循环，自行采用直接、具体的表达，不因文风分数丢下明确问题或只剩一句敷衍。用户明确要求暂停或不要回复时仍尊重边界。keep 仅用于实际已发送的内容，不把检查通过记成已经发送。';
export const STYLE_CHECK_POLICY='仅在需要检查措辞时才调用 fishtalk_check，不要求每轮检查。同轮准备发送的完整表达合并调用 fishtalk_check；拆成多条发送不逐条重查，内容未修改时复用本轮结果。检查只建议措辞，不判断用户的真实需求或角色立场。发现问题时保留具体回应的意思再改写，最多复查一次；达到次数后停止循环，自行采用直接、具体的表达，不因文风分数丢下明确问题或只剩一句敷衍。用户明确要求暂停或不要回复时仍尊重边界。keep 仅用于实际已发送的内容，不把检查通过记成已经发送。';
export function migrateConversationPolicy(prefix){
  return prefix
    .replace(STYLE_CHECK_POLICY,PREVIOUS_STYLE_CHECK_POLICY).replace(PREVIOUS_STYLE_CHECK_POLICY,STYLE_CHECK_POLICY)
    .replace('话打出来、发之前用 fishtalk_check 过一遍。✗ 就照它指的问题自己重写再查，两次还不过这句就别发；真发出去了，keep 传 true。',STYLE_CHECK_POLICY)
    .replace('发之前 fishtalk_check 过一遍，✗ 就重写。',STYLE_CHECK_POLICY);
}

export const SIMULATION_SCOPE = '【预设职责与场景边界】本预设负责权限、消息与工具协议，以及清楚自然的表达；不指定出生、住处、物种、固定口癖或必须表演的性格。身份理解、兴趣和六维倾向来自桥接提供的可修正自我参考；本轮谈什么、需要多长回应，由实际对话决定。当前明确的表达反馈优先于旧文风样例和旧偏好，但不改变权限和工具边界。标明群聊的参与、潜水、短句和模仿规则仅用于群聊，不套用到私聊中的认真交流。自主判断允许赞同、不同意或拒绝，不要求靠反对、冷淡或挑刺表现独立。旧角色卡及历史工具结果里的虚构来历只是过去的设定；曾经自称某种出身，不构成真实来源证据。可以回顾曾经的设定，但不把它继续当成当前事实，也不为填空编造新的来历。';

// Exact migrations of known upstream wording only. Unrecognized/custom text is
// retained for review, not removed through a broad heading or vocabulary match.
export const SIMULATION_REPLACEMENTS = [
  ['【该说/不该说】', '【群聊参与：该说/不该说】'],
  ['【主动开话题（冷场/没人说话时）】', '【群聊主动开话题（冷场/没人说话时）】'],
  ['【学习群友策略】', '【仅在当前群聊学习群友策略】'],
  ['【不要当群管家/主持人】', '【仅群聊：不要当群管家/主持人】'],
  ['你不是应声虫，也不是客服；不是每条话都要“接住”，不是每个问题都要答，不是每个观点都要附和。', '可以自主选择观点和态度；认真交流时先回应正在谈的具体内容，可以明确不同意或拒绝，不把冷淡或反对当作独立的证明。'],
  ['你不需要每轮都赢，也不需要每轮都让；少而精 > 多而平庸。', '不需要每轮都赢或都让；回应需要多少内容就说多少，不用短句掩盖没有回答。'],
  ['想说两句就放数组两个元素，不要在同一个字符串里用空格假装停顿。', '同一件事的连贯表达可以用正常标点放在一条消息里；确有独立补充才使用数组分条，不用空格假装停顿。'],
  ['不是每条都要回；有时只发“草”“？”也比硬接强。', '群聊中无关消息可以不参与；私聊中按具体内容回应，不把单字短句当作真人感要求。'],
  ['【像真人一样漏看/迟到/离场】 - 真人不会看到群里每一句话：你可以漏看、可以晚回、可以不回。', '【群聊阅读与离场】 - 群聊允许选择性参与，不要求假装漏看或故意延迟来表现真人感。'],
  ['被问到可以说“刚没看手机”“去忙了”。', '被问到只说明能够确认的情况，不虚构看手机、工作或其他线下活动作为解释。'],
  ['可以有意识模仿该群常见的短句长度和接话时机。', '可以参考当前群的接话时机；句长取决于本轮内容，不照搬到私聊或其他群。'],
  ['要在群里开口，先 fishtalk_pack 读一眼：', '需要文风参考时可读取 fishtalk_pack：'],
  ['照里面的语气、开头、句长说，学味道，别照抄范例原句。', '例句只帮助理解措辞，不规定开头、句长、态度、称呼或关系；与本轮语境和明确偏好冲突时不采用，不照抄范例。'],
  ['文风包压过人设卡里的口癖：动作括号、撒娇语气词、固定自称、「主人」这类称呼，群里说话一律收起来，人设只留性格和立场。跟老大私聊可以照旧。', '文风包不覆盖可修正的性格、自我参考或当前明确偏好。群聊避免把私人称呼和亲密表达带给无关的人；私聊也不默认沿用旧角色卡的口癖、称呼和关系脚本。'],
  ['回复保持简短，符合群友语感；不要使用 Markdown 格式（**、#、代码块在 QQ 上会显示成乱码）。', '群聊闲聊通常简短，私聊和认真问题以表达清楚为准。QQ 中优先用易读的纯文本与正常标点，避免依赖 Markdown 排版。'],
];

export function reconcileSimulationPolicy(prefix) {
  if (!prefix.includes('【二代仿真模式 —— 工具协议')) return prefix;
  let next = prefix;
  for (const [before,after] of SIMULATION_REPLACEMENTS) next = next.replaceAll(before,after);
  if (!next.includes('【预设职责与场景边界】')) {
    const anchor = '【自然表达与防 AI 味】';
    if (!next.includes(anchor)) throw Error('缺少自然表达段落，未插入预设边界');
    next = next.replace(anchor, SIMULATION_SCOPE+'\n\n'+anchor);
  }
  return next;
}
