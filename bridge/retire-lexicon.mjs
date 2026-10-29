import crypto from 'node:crypto';

// Fingerprints only: never distribute a user's MCP file or local paths.
const KNOWN_MCP = new Set(['063932e9b2407e019f49d44895744b32fc71faa91495c823b079165b72858899']);
export const hasRetiredTools = text => /\b(?:qq_slang_query|qq_slang_submit)\b/.test(text);
export function retireLexiconTools(bytes) {
  const source = bytes.toString('utf8');
  if (!hasRetiredTools(source)) return bytes;
  const canonical = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  if (!KNOWN_MCP.has(hash)) throw Error('QQ MCP 含黑话工具且版本未知，未修改；需先核对工具实现再迁移');
  const remove = (text, start, end) => {
    const a = text.indexOf(start), b = text.indexOf(end, a);
    if (a < 0 || b <= a) throw Error('QQ MCP 黑话工具边界不匹配，未修改');
    return text.slice(0, a) + text.slice(b);
  };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let result = remove(source, "server.tool("+newline+"  'qq_slang_query',", '// ── 图片/表情查看工具');
  result = result.replace(/^  qq_slang_(?:query|submit):[^\r\n]+\r?\n/gm, '');
  if (hasRetiredTools(result) || /\b(?:slangQuery|slangSubmit)\b/.test(result)) throw Error('QQ MCP 黑话工具移除不完整');
  return Buffer.from(result);
}
