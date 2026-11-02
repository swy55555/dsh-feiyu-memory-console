export const name = 'memory-no-tools';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '记忆整理会话禁止一切工具调用');
}
