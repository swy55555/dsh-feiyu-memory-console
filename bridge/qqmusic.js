// QQ 音乐音源：搜索 → 取播放地址（vkey）→ 下载 → 转 mp3。
//
// 需要绿钻登录态（config.json 的 qqmusic.cookie）。cookie 过期或没配时，
// 调用方应当自动回退到 B 站音源，不要把整条唱歌流程卡死在这里。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

function uinFromCookie(cookie) {
  const m = /(?:^|;\s*)uin=(\d+)/.exec(String(cookie || ''))
  return m ? m[1] : ''
}

function headers(cookie) {
  return {
    'user-agent': UA,
    referer: 'https://y.qq.com/',
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  }
}

/** 官方搜索：返回 [{ mid, name, singer, duration }] */
export async function qqSearch(query, cookie, limit = 8) {
  const body = {
    comm: { ct: '19', cv: '1859', uin: uinFromCookie(cookie) },
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: limit, page_num: 1, query: String(query), search_type: 0 },
    },
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json().catch(() => ({}))
  const list = json?.req_1?.data?.body?.song?.list ?? []
  return list.map((s) => ({
    mid: s.mid,
    name: s.name,
    singer: (s.singer ?? []).map((x) => x.name).join('/'),
    duration: Number(s.interval) || 0,
  }))
}

/** 选最像的那首：名字里命中的字多者优先，时长 1~10 分钟，排除伴奏/纯音乐 */
export function pickBest(songs, query) {
  const chars = [...new Set(String(query).replace(/\s+/g, ''))].filter((c) => /[\u4e00-\u9fff\w]/.test(c))
  let best = null
  for (const s of songs) {
    if (!s.mid || !s.name) continue
    if (s.duration && (s.duration < 60 || s.duration > 600)) continue
    let score = 0
    for (const c of chars) if (s.name.includes(c)) score += 1
    // 歌手里命中的字权重更高：点「邓寓君的归寻」时要能压过别家的同名版本
    for (const c of chars) if (s.singer && s.singer.includes(c)) score += 2
    if (/伴奏|纯音乐|instrumental|karaoke/i.test(s.name)) score -= 6
    if (!best || score > best.score) best = { ...s, score }
  }
  return best
}

/** 取播放地址：优先无损，其次 320k mp3 */
export async function qqResolve(mid, cookie) {
  const uin = uinFromCookie(cookie)
  const wanted = [
    { file: `F000${mid}${mid}.flac`, ext: 'flac', label: '无损' },
    { file: `M800${mid}${mid}.mp3`, ext: 'mp3', label: '320k' },
  ]
  const body = {
    comm: { uin, format: 'json', ct: 24, cv: 0 },
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '10000',
        songmid: wanted.map(() => mid),
        songtype: wanted.map(() => 0),
        uin,
        loginflag: 1,
        platform: '20',
        filename: wanted.map((w) => w.file),
      },
    },
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json().catch(() => ({}))
  const data = json?.req_0?.data ?? {}
  const infos = data.midurlinfo ?? []
  const sip = (data.sip ?? [])[0] || ''
  for (let i = 0; i < wanted.length; i++) {
    const purl = infos[i]?.purl
    if (purl && sip) {
      return { url: sip.replace(/^http:/, 'https:') + purl, ext: wanted[i].ext, label: wanted[i].label }
    }
  }
  return null
}

function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/**
 * 下载一首歌到 dir（统一转成 mp3）。成功返回文件名，失败抛错。
 * @param {string} query 歌名/关键词
 * @param {{cookie:string, dir:string, ffmpeg:string, log?:(s:string)=>void}} opts
 */
export async function qqDownload(query, opts) {
  const { cookie, dir, ffmpeg, log = () => {} } = opts
  if (!cookie) throw new Error('没有配置 QQ 音乐 cookie')

  const songs = await qqSearch(query, cookie)
  if (!songs.length) throw new Error(`QQ 音乐搜不到《${query}》`)
  const best = pickBest(songs, query)
  if (!best) throw new Error(`《${query}》只搜到片段/伴奏`)

  const resolved = await qqResolve(best.mid, cookie)
  if (!resolved) throw new Error(`取不到《${best.name}》的播放地址（cookie 可能过期或没有绿钻）`)

  log(`选中: ${best.singer} - ${best.name} (${best.mid}, ${resolved.label})`)
  const base = safeName(`${best.singer} - ${best.name}`) || safeName(best.name)
  const tmpExt = resolved.ext
  const tmp = path.join(dir, `${base}.src.${tmpExt}`)
  const out = path.join(dir, `${base}.mp3`)

  const res = await fetch(resolved.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 100 * 1024) throw new Error(`下载内容太小（${buf.length} 字节），可能不是完整歌曲`)
  fs.writeFileSync(tmp, buf)
  log(`下载完成 ${(buf.length / 1048576).toFixed(1)}MB -> ${path.basename(tmp)}`)

  if (tmpExt === 'mp3') {
    fs.renameSync(tmp, out)
  } else {
    execFileSync(ffmpeg, ['-y', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', '320k', out], { timeout: 180000 })
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
  return { file: path.basename(out), quality: resolved.label, song: best }
}
