// 把本地 self-memory.json 迁进 memvec 的 scope=self。
// 稳定 ID + 本地台账：重复执行不会重复导入；memvec 的行不参与 ID 生成。
import crypto from 'node:crypto';

export function stableSelfKey(item) {
  const text = String(item?.text || '').trim();
  const at = Number(item?.at) || 0;
  const url = String(item?.sourceUrl || '');
  return `self-${crypto.createHash('sha1').update(`${text}\n${at}\n${url}`).digest('hex').slice(0, 16)}`;
}

export function planSelfMigration(items, ledger = {}) {
  const done = new Set(Array.isArray(ledger?.ids) ? ledger.ids : []);
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && String(item.text || '').trim() && String(item.excerpt || '').trim())
    .map((item) => ({ ...item, key: stableSelfKey(item) }))
    .filter((item) => !done.has(item.key));
}

export function commitSelfLedger(ledger, keys, now = Date.now()) {
  const ids = [...new Set([...(Array.isArray(ledger?.ids) ? ledger.ids : []), ...(Array.isArray(keys) ? keys : [])])];
  return { version: 1, ids: ids.slice(-2000), updatedAt: now };
}

export function reconcileSelf(items, ledger = {}) {
  const done = new Set(Array.isArray(ledger?.ids) ? ledger.ids : []);
  const keys = (Array.isArray(items) ? items : []).map(stableSelfKey);
  return {
    total: keys.length,
    migrated: keys.filter((k) => done.has(k)).length,
    pending: keys.filter((k) => !done.has(k)).length,
    duplicateLedger: keys.length - new Set(keys).size,
  };
}
