// flac.music.hi.cn 站点客户端：搜索 / 专辑 / 取直链，选源打分与文件名规范化
//
// 站点是聚合搜索站（网易云 + 酷我），接口只认 Referer，缺了会 403。
// 所有写盘相关的命名规则集中在这里，保证「选源」与「落盘」用同一套口径。

const SITE = 'https://flac.music.hi.cn'
const AJAX = `${SITE}/ajax.php?act=`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

export const PLATFORMS = ['wyy', 'kuwo']
export const PLATFORM_NAME = { wyy: '网易云', kuwo: '酷我' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// getUrl 按 IP 限速，站内请求统一排队，默认 1s 一次
let siteInterval = Number(process.env.FLAC_INTERVAL_MS || 1000)
let lastCallAt = 0

export function setSiteInterval(ms) {
  siteInterval = Math.max(100, Number(ms) || 1000)
}

async function throttle() {
  const wait = siteInterval - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

/** POST 表单调用；网络抖动重试，业务错误交由调用方判断 */
async function post(act, params, { retry = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await throttle()
    try {
      const res = await fetch(AJAX + act, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Referer: `${SITE}/`,
          Origin: SITE,
          'User-Agent': UA,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt >= retry) throw new Error(`站点 ${act} 请求失败: ${err.message}`)
      await sleep(1500 * (attempt + 1))
    }
  }
}

/** 全角转半角并去掉标点，用于标题/歌手比对 */
export function normText(text) {
  let s = String(text ?? '')
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  s = s.replace(/[\s\-_~〜～!！?？.,、。:：;；'"“”‘’()（）[\]【】/\\|+&*#@$%^=<>]/g, '')
  return s.toLowerCase()
}

/** Windows 非法字符处理：`*` `~` 直接去掉（`*~Asterisk~` → `Asterisk`），其余替换为下划线 */
export function sanitizeFilename(name) {
  let s = String(name ?? '')
  s = s.replace(/[*~]/g, '')
  s = s.replace(/[\\/:?"<>|\x00-\x1f]/g, '_')
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/[. ]+$/, '')
  return s.trim() || 'untitled'
}

/** 二元组 Dice 相似度，替代 difflib 做歌手/标题的模糊比对 */
function similarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ma = grams(a)
  const mb = grams(b)
  let hit = 0
  for (const [g, n] of ma) hit += Math.min(n, mb.get(g) || 0)
  return (2 * hit) / (a.length - 1 + b.length - 1)
}

/** 歌手是否对得上：完全一致 > 包含 > 高相似度；拦的是「同名异曲」和翻唱 */
export function artistMatches(target, cand) {
  const nt = normText(target)
  const nc = normText(cand)
  if (!nt || !nc) return false
  if (nt === nc) return true
  if (nt.includes(nc) || nc.includes(nt)) return true
  return similarity(nt, nc) >= 0.7
}

// ---------------------------------------------------------------- 搜索 / 专辑

const searchCache = new Map()

/** 搜索曲目；结果里带 album_id / album_name / minfo / time / sign */
export async function searchTracks(keyword, platform, { page = 1, num = 30 } = {}) {
  const res = await post('search', { platform, keyword, page, num })
  if (res.code !== 0) throw new Error(`搜索失败 [code=${res.code}] ${res.msg || ''}`)
  const rows = res.data?.list || []
  for (const r of rows) r.platform = platform
  return rows
}

async function searchCached(keyword, platform, page) {
  const key = `${platform}|${page}|${keyword}`
  if (searchCache.has(key)) return searchCache.get(key)
  let rows = []
  try {
    rows = await searchTracks(keyword, platform, { page, num: 30 })
  } catch {
    rows = []
  }
  searchCache.set(key, rows)
  return rows
}

/** 专辑详情 + 全曲目；每首都带 minfo/time/sign，可直接喂 getUrl */
export async function fetchAlbum(platform, albumId, { tries = 4 } = {}) {
  let last = ''
  for (let i = 0; i < tries; i++) {
    try {
      const res = await post('album', { platform, id: albumId, page: 1, num: 200 })
      if (res.code === 0 && res.data) return res.data
      last = res.msg || `code=${res.code}`
    } catch (err) {
      last = err.message
    }
    await sleep(2000 * (i + 1))
  }
  throw new Error(`取专辑失败 id=${albumId}: ${last}`)
}

/**
 * 定位专辑：用歌手过滤噪声，再按专辑名精确度投票，最后回读 info.artist 复核。
 * 同名翻唱专辑泛滥，单靠专辑名一定会翻车。
 */
export async function findAlbum({ artist, album, alts = [], probe, platforms = PLATFORMS, deep = false }) {
  const targets = [normText(album), ...alts.map(normText)].filter(Boolean)
  const keys = []
  if (probe) keys.push(`${probe} ${artist}`, probe)
  keys.push(`${album} ${artist}`, `${artist} ${album}`, album, ...alts)
  const uniqKeys = [...new Set(keys.filter(Boolean))]

  const nameHit = (albumName) => {
    const n = normText(albumName)
    if (!n) return null
    for (const t of targets) {
      if (n === t) return 1
      if (t.length >= 4 && (n.includes(t) || t.includes(n))) return 0
    }
    return null
  }

  const vote = async (platform, pages) => {
    const votes = new Map()
    for (const k of uniqKeys) {
      for (const pg of pages) {
        const rows = await searchCached(k, platform, pg)
        if (!rows.length) break
        for (const r of rows) {
          if (!artistMatches(artist, r.artist)) continue
          const ex = nameHit(r.album_name)
          if (ex === null) continue
          const aid = String(r.album_id || '')
          if (!aid || aid === 'undefined') continue
          const prev = votes.get(aid) || { hits: 0, exact: 0 }
          votes.set(aid, { hits: prev.hits + 1, exact: Math.max(prev.exact, ex) })
        }
      }
    }
    return votes
  }

  let overall = null
  for (const platform of platforms) {
    let best = null
    for (const pages of (deep ? [[1, 2, 3]] : [[1], [1, 2, 3]])) {
      const votes = await vote(platform, pages)
      if (!votes.size) continue
      const ranked = [...votes.entries()].sort((a, b) => b[1].exact - a[1].exact || b[1].hits - a[1].hits).slice(0, 6)
      for (const [aid, v] of ranked) {
        let data
        try {
          data = await fetchAlbum(platform, aid, { tries: 2 })
        } catch {
          continue
        }
        if (!artistMatches(artist, data.info?.artist)) continue
        const n = (data.list || []).length
        // 同名首专常有多个地区版本（US 12 曲 / 国际 16 曲），曲目多者更完整；
        // 平台位次放在曲目数之前：酷我 FLAC 多为 2000k 的转码，同档一律优先网易云。
        const score = [v.exact, n >= 6 ? 1 : 0, platform === 'wyy' ? 1 : 0, n, v.hits]
        if (!best || cmpTuple(score, best.score) > 0) best = { score, id: aid, platform }
      }
      if (best && best.score[0] === 1 && best.score[1] === 1) break
    }
    if (best && (!overall || cmpTuple(best.score, overall.score) > 0)) overall = best
  }
  return overall ? { id: overall.id, platform: overall.platform } : null
}

function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

// ---------------------------------------------------------------- 音质与取链

/** 档位：flac > 320k mp3 > 其余；同档取码率高者 */
export function pickQuality(minfo, mode = 'flac') {
  const list = (minfo || [])
    .map((m) => ({ format: String(m.format || '').toLowerCase(), bitrate: String(m.bitrate || '') }))
    .filter((m) => m.format)
  if (!list.length) return null

  const rank = (m) => {
    const br = Number(m.bitrate) || 0
    if (mode === 'mp3') {
      if (m.format === 'mp3' && br >= 320) return [3, br]
      if (m.format === 'flac') return [2, br]
      return [1, br]
    }
    if (m.format === 'flac') return [3, br]
    if (m.format === 'mp3' && br >= 320) return [2, br]
    return [1, br]
  }

  let best = null
  for (const m of list) {
    const r = rank(m)
    if (!best || cmpTuple(r, best.r) > 0) best = { r, ...m }
  }
  return { format: best.format, bitrate: best.bitrate }
}

/**
 * 取直链。time/sign 是一次性签名，必须原样回传，过期或跨条目都会失败。
 * 命中限流时按提示秒数等待，不要盲目重试。
 */
export async function getUrl(platform, song, quality, { tries = 5, onRetry } = {}) {
  let last = ''
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res
    try {
      res = await post('getUrl', {
        platform,
        songid: song.id,
        format: quality.format,
        bitrate: quality.bitrate,
        time: song.time ?? '',
        sign: song.sign ?? '',
      })
    } catch (err) {
      last = err.message
      await sleep(2000)
      continue
    }
    if (res.code === 0 && res.data?.url) return res.data.url
    last = res.msg || `code=${res.code}`
    // 限流按提示秒数等；「Song not found」多为瞬时故障，退避重试通常能过
    const m = /(\d+)\s*秒后重试/.exec(last)
    const wait = m ? (Number(m[1]) + 1.5) * 1000 : Math.min(2500 * attempt, 8000)
    onRetry?.({ attempt, message: last, wait })
    if (attempt < tries) await sleep(wait)
  }
  throw new Error(last || 'getUrl 失败')
}

// ---------------------------------------------------------------- 单曲选源打分

// 版本词常与原版同名，靠标题分不出来，只能重罚
const NOISE_WORDS = [
  'instrumental', 'off vocal', 'leadless vocal', 'カラオケ', 'karaoke', '伴奏', '纯音乐',
  'acoustic', 'live at', 'live version', 'unplugged', 'tv size', 'tv-size', 'tvsize',
  'remix', 'tribute', 'cover', 'nightcore', 'slowed', 'reverb', 'sped up', '片段', '试听',
  'megamix', 'medley', 'demo',
]

/**
 * 给一个候选曲目打分。宁可留空也不抓成同歌手的另一首歌，所以命中不了就返回 ok=false。
 */
export function scoreTrack(cand, want) {
  const reasons = []
  let score = 0
  const ct = normText(cand.name)
  const wants = [want.title, ...(want.titleAlts || [])].map(normText).filter(Boolean)

  let titleScore = 0
  let exact = false
  for (const w of wants) {
    if (ct === w) {
      titleScore = 4
      exact = true
      break
    }
    if (ct.startsWith(w) || ct.endsWith(w)) titleScore = Math.max(titleScore, 3)
    else if (w.length >= 6 && ct.includes(w)) titleScore = Math.max(titleScore, 2)
    else if (similarity(ct, w) >= 0.85) titleScore = Math.max(titleScore, 1)
  }
  score += titleScore * 10
  if (titleScore) reasons.push(`标题${exact ? '完全一致' : titleScore >= 3 ? '首尾匹配' : '近似'}`)

  const nt = normText(want.title)
  // 短标题千万别靠「包含」匹配：again 会命中 …Love Again，ARIA 会命中一切带 aria 的曲子
  if (nt.length < 6 && titleScore < 3) {
    return { ok: false, score: 0, reasons: ['短标题要求接近完全一致'] }
  }
  if (!titleScore) return { ok: false, score: 0, reasons: ['标题不沾边'] }

  const artistOk = artistMatches(want.artist, cand.artist)
  if (artistOk) {
    score += 4
    reasons.push('歌手一致')
  } else if (exact && want.duration && Math.abs(Number(cand.duration || 0) - want.duration) <= 5) {
    reasons.push('歌手不符但标题与时长吻合')
  } else {
    return { ok: false, score: 0, reasons: [`歌手不符: ${cand.artist}`] }
  }

  const dur = Number(cand.duration || 0)
  if (want.duration && dur) {
    const diff = Math.abs(dur - want.duration)
    if (diff <= 5) {
      score += 3
      reasons.push('时长吻合')
    } else if (diff <= 15) {
      score += 1
    } else {
      score -= 4
      reasons.push(`时长差 ${diff}s`)
    }
  }
  if (dur && dur < 150 && (!want.duration || want.duration > 200)) {
    score -= 12
    reasons.push('疑似 TV-size / 试听片段')
  }

  for (const word of NOISE_WORDS) {
    if (ct.includes(normText(word))) {
      score -= 8
      reasons.push(`版本噪声: ${word}`)
    }
  }

  const q = pickQuality(cand.minfo)
  if (q?.format === 'flac') {
    score += 2
    reasons.push(`FLAC ${q.bitrate}k`)
  }
  if (cand.platform === 'wyy' && q?.format === 'flac') score += 1 // 网易云 FLAC 多为真实码率

  return { ok: score >= 10, score, reasons }
}

/** 按分数取前 6 个合格候选，逐个尝试取链（前面失败自动退到下一个） */
export async function pickCandidates(want, { platforms = PLATFORMS, pageLimit = 1 } = {}) {
  const rows = []
  const seen = new Set()
  for (const platform of platforms) {
    for (const page of Array.from({ length: pageLimit }, (_, i) => i + 1)) {
      let list = []
      try {
        list = await searchTracks(`${want.title} ${want.artist}`, platform, { page, num: 30 })
      } catch {
        list = []
      }
      for (const r of list) {
        const key = `${r.platform}:${r.id}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push(r)
      }
    }
  }
  const scored = rows.map((r) => ({ ...r, ...scoreTrack(r, want) }))
  return scored.filter((r) => r.ok).sort((a, b) => b.score - a.score)
}
