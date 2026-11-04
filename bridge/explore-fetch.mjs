export async function exploreJson(input, { headers = {}, signal, fetchImpl = fetch, format = 'json' } = {}) {
  const url = new URL(input);
  const api = url.hostname === 'api.bilibili.com';
  const subtitle = url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || (!api && !subtitle)) throw new Error('探索来源域名不受信任');
  const safe = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' };
  if (api && headers.cookie) safe.cookie = headers.cookie;
  const response = await fetchImpl(url.href, { headers: safe, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('探索来源 HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try { for (;;) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 2*1024*1024) throw new Error('探索响应过大'); chunks.push(value); } }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  return format === 'xml' ? text : JSON.parse(text);
}
