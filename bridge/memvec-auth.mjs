import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read per request so a token replacement does not require reloading every client.
export function memvecHeaders(extra = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const db = process.env.FEIYU_MEMVEC_DB || process.env.MEMVEC_DB_PATH || path.join(home, 'memvec', 'memories.db');
  const file = process.env.MEMVEC_API_TOKEN_FILE || path.join(path.dirname(db), 'api-token');
  let token = String(process.env.MEMVEC_API_TOKEN || '').trim();
  if (!token) {
    try { token = fs.readFileSync(file, 'utf8').trim(); }
    catch { throw new Error('记忆服务授权令牌不可用，请先启动记忆服务'); }
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('记忆服务授权令牌无效');
  return { 'content-type': 'application/json', ...extra, 'x-memvec-token': token };
}
