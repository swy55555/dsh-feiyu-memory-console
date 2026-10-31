// Stable ledger keys: attribution is persisted with usage, never inferred from prompts.
export const PLUGIN_PREFIX = 'internal:可塑性记忆';
export const FEATURE_LABELS = Object.freeze({
  style_distillation: '旧文风蒸馏（已停用）',
  expression_teacher: '旧表达教师（已停用）',
  growth_classroom: '成长课堂',
  memory_privacy: '共享隐私判断',
  memory_extract: '记忆提取', coverage_check: '提取查漏', fact_review: '事实复核',
  confirmation_review: '确认联合复核',
  event_understanding: '事件理解', candidate_review: '候选核对',
  idle_association: '空闲联想', emotion_review: '情绪复核',
  context_summary: '聊天摘要', persona_consolidation: '性格整理',
  persona_draft: '性格草案', diary: '日记生成', image_description: '图片理解',
  other: '其他内部调用',
});
export function featureKey(feature = 'other') {
  return `${PLUGIN_PREFIX}:${Object.hasOwn(FEATURE_LABELS, feature) ? feature : 'other'}`;
}
export function featureLabel(key) {
  if (key === PLUGIN_PREFIX) return '历史未分项';
  return FEATURE_LABELS[String(key).slice(PLUGIN_PREFIX.length + 1)] || '其他内部调用';
}
export const isPluginKey = key => key === PLUGIN_PREFIX || String(key).startsWith(PLUGIN_PREFIX + ':');
