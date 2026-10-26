// 无损音乐下载：flac.music.hi.cn 选源 → Aria2 / 内置下载器 → 元数据校验
//
// 与歌单/云盘不同，这条链路不依赖网易云登录态：站点是第三方聚合搜索，
// 只需要 Referer。Aria2 也是可选项，探不到 RPC 时自动降级到内置下载器。
import fs from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import {
  PLATFORMS, PLATFORM_NAME, searchTracks, fetchAlbum, findAlbum, pickQuality,
  pickCandidates, getUrl, sanitizeFilename, artistMatches, setSiteInterval,
} from '../lib/flac.mjs'
import { createEngine, DEFAULT_RPC } from '../lib/engine.mjs'
import { ROOT } from '../lib/api.mjs'
import {
  table, fmtSize, fmtDuration, ok, info, warn, fail, bold, dim, cyan, green, red, progress,
} from '../lib/ui.mjs'

const CONFIG_FILE = path.join(ROOT, 'config', 'download.json')
const MANIFEST = '.crate-manifest.json'
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.ape', '.ogg', '.opus'])
const PART_FILE = /\.part$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

const cfg = loadConfig()

/** 取第一个有效字符串（flags 里可能是 true，不能直接当值用） */
function pick(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

function resolveRoot(flags) {
  const root = pick(flags.root, process.env.CRATE_DL_ROOT, cfg.root)
  return root ? path.resolve(root) : path.join(ROOT, 'downloads')
}

function engineOptions(flags) {
  return {
    engine: pick(flags.engine, cfg.engine) || 'auto',
    rpc: pick(flags.rpc, process.env.ARIA2_RPC, cfg.rpc) || DEFAULT_RPC,
    secret: pick(flags.secret, process.env.ARIA2_SECRET, cfg.secret),
    concurrency: Number(pick(flags.concurrency, cfg.concurrency)) || 3,
    retries: Number(pick(flags.retries, cfg.retries)) || 3,
  }
}

function platformList(flags) {
  const p = pick(flags.platform, cfg.platform)
  if (!p || p === 'both') return PLATFORMS
  if (!PLATFORMS.includes(p)) throw new Error(`未知平台 ${p}，可用: wyy / kuwo / both`)
  return [p]
}

const qualityMode = (flags) => (pick(flags.quality) === 'mp3' ? 'mp3' : 'flac')

/** 表格列宽兜底：专辑名/文件名动辄几十字，不裁剪会把表拉成一条横线 */
function clip(text, max = 40) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const splitList = (v) => (typeof v === 'string' ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [])

/** 解析 `1,3-5` 形式的轨号范围 */
function parseRanges(text) {
  const set = new Set()
  for (const part of String(text || '').split(/[,，]/)) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) continue
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i)
  }
  return set
}

/** TTY 下走单行进度条，非 TTY 每 15 秒打一行，避免管道场景彻底静默 */
function makeReporter() {
  let last = 0
  return ({ finished, total, bytes, totalBytes }) => {
    if (process.stdout.isTTY) {
      progress(finished, total, totalBytes ? `${fmtSize(bytes)}/${fmtSize(totalBytes)}` : '')
    } else if (Date.now() - last > 15000) {
      last = Date.now()
      info(`进度 ${finished}/${total}`)
    }
  }
}

function applySiteRate(flags) {
  if (pick(flags.interval)) setSiteInterval(Number(flags.interval))
}

// ---------------------------------------------------------------- dl find

export async function cmdFind(keyword, flags) {
  if (!keyword) throw new Error('缺少搜索关键词')
  applySiteRate(flags)
  const limit = Number(pick(flags.limit)) || 20

  const rows = []
  for (const platform of platformList(flags)) {
    const list = await searchTracks(keyword, platform, { page: 1, num: 30 })
    for (const r of list) rows.push(r)
  }
  if (!rows.length) return warn('没有搜索结果')

  const items = rows.slice(0, limit)
  console.log(table(['平台', '歌曲ID', '专辑ID', '曲名', '歌手', '专辑', '时长', '音质'], items.map((r) => {
    const q = pickQuality(r.minfo)
    return [
      PLATFORM_NAME[r.platform] || r.platform,
      r.id,
      r.album_id ?? '-',
      clip(r.name, 32),
      clip(r.artist, 20),
      clip(r.album_name || '-', 26),
      fmtDuration(Number(r.duration || 0) * 1000),
      q ? `${q.format}/${q.bitrate}k` : dim('无'),
    ]
  }), { align: ['left', 'right', 'right', 'left', 'left', 'left', 'right', 'left'] }))

  info(`共 ${items.length} 条；整张下载用 ${cyan('dl album <专辑名> --artist <歌手> --id <专辑ID>')}`)
  return items
}

// ---------------------------------------------------------------- dl albums

/** 汇总某歌手在站点可检索到的专辑（按 album_id 聚合曲目） */
export async function cmdAlbums(artist, flags) {
  if (!artist) throw new Error('缺少歌手名')
  applySiteRate(flags)
  const albums = new Map()

  for (const platform of platformList(flags)) {
    for (const page of [1, 2, 3]) {
      let list = []
      try {
        list = await searchTracks(artist, platform, { page, num: 30 })
      } catch {
        list = []
      }
      if (!list.length) break
      for (const r of list) {
        if (!artistMatches(artist, r.artist)) continue
        const aid = String(r.album_id || '')
        if (!aid || aid === 'undefined' || aid === '0') continue
        const key = `${platform}:${aid}`
        const cur = albums.get(key) || {
          platform, id: aid, name: r.album_name || '(未知专辑)', songs: new Map(),
        }
        cur.songs.set(r.name, cur.songs.get(r.name) || pickQuality(r.minfo)?.format === 'flac')
        albums.set(key, cur)
      }
    }
  }

  const minTracks = flags.all ? 1 : Number(pick(flags['min-tracks'])) || 2
  const list = [...albums.values()]
    .filter((a) => a.songs.size >= minTracks)
    .sort((a, b) => b.songs.size - a.songs.size || a.name.localeCompare(b.name))
  if (!list.length) return warn(`站点没有检索到 ${artist} 的专辑`)

  console.log(table(['平台', '专辑ID', '专辑名', '命中曲目', 'FLAC'], list.map((a) => [
    PLATFORM_NAME[a.platform] || a.platform,
    a.id,
    clip(a.name, 44),
    a.songs.size,
    `${[...a.songs.values()].filter(Boolean).length}/${a.songs.size}`,
  ]), { align: ['left', 'right', 'left', 'right', 'right'] }))

  info(`共 ${list.length} 张（按搜索结果聚合，不是站点官方艺人页：命中曲目数指搜索命中的曲目，不是专辑总曲目数）`)
  info(`缺专辑用 ${cyan('dl albums <别名>')} 换个写法再试；下载整张：${cyan(`dl album "<专辑名>" --artist "${artist}" --id <专辑ID> --platform <wyy|kuwo>`)}`)
  return list
}

// ---------------------------------------------------------------- dl album

/**
 * 下载一张专辑。返回 { album, tracks, queued, failed }。
 * dry 模式只解析与打印计划，不建目录、不取链。
 */
async function downloadAlbum({ artist, album, code = '', root, artistRoot = '', dir = '', flags = {} }) {
  let target = null
  const forcedId = pick(flags.id)
  if (forcedId) {
    target = { platform: pick(flags.platform, cfg.platform) || 'wyy', id: forcedId }
  } else {
    target = await findAlbum({
      artist,
      album,
      alts: splitList(flags.alts),
      probe: pick(flags.probe),
      platforms: platformList(flags),
      deep: !!flags.deep,
    })
  }
  if (!target) {
    fail(`未找到专辑：${artist} - ${album}`)
    return { album, tracks: 0, queued: 0, failed: [{ out: album, error: '未找到专辑' }] }
  }

  let data
  try {
    data = await fetchAlbum(target.platform, target.id)
  } catch (err) {
    fail(err.message)
    return { album, tracks: 0, queued: 0, failed: [{ out: album, error: err.message }] }
  }

  const realName = data.info?.name || album
  const tracks = data.list || []
  // artistRoot 直指歌手目录（批量清单里就是这么写的）；否则按「库根 + 歌手」拼
  const baseDir = artistRoot ? path.resolve(artistRoot) : path.join(root, sanitizeFilename(artist))
  const albumDir = dir
    ? path.resolve(dir)
    : path.join(baseDir, code ? `${code} - ${sanitizeFilename(realName)}` : sanitizeFilename(realName))

  console.log()
  info(`${bold(realName)}　${dim(`${PLATFORM_NAME[target.platform] || target.platform} · 专辑ID ${target.id} · ${tracks.length} 曲`)}`)
  if (realName !== album) info(dim(`平台专辑名与清单不同：${album} → ${realName}`))
  info(`目录 ${cyan(albumDir)}`)

  const ranges = pick(flags.tracks) ? parseRanges(flags.tracks) : null
  // 已存在＝有同轨号文件且没有 .aria2 控制文件；只有控制文件不算下完（残留下半截会被跳过）
  const existing = new Set()
  if (fs.existsSync(albumDir)) {
    for (const f of fs.readdirSync(albumDir)) {
      if (PART_FILE.test(f)) continue
      const m = /^(\d+)\s*-/.exec(f)
      if (!m) continue
      if (fs.existsSync(path.join(albumDir, `${f}.aria2`))) continue
      existing.add(Number(m[1]))
    }
  }

  const plan = []
  for (const [i, t] of tracks.entries()) {
    const idx = i + 1
    if (ranges && !ranges.has(idx)) continue
    const quality = pickQuality(t.minfo, qualityMode(flags))
    const base = `${String(idx).padStart(2, '0')} - ${sanitizeFilename(t.name)}`
    let skip = ''
    if (!quality) skip = '无可用音质'
    else if (!flags.force && existing.has(idx)) skip = '已存在'
    plan.push({ idx, track: t, quality, out: quality ? `${base}.${quality.format}` : base, skip })
  }

  console.log(table(['#', '曲目', '音质', '时长', '状态'], plan.map((p) => [
    String(p.idx).padStart(2, '0'),
    p.track.name,
    p.quality ? `${p.quality.format}/${p.quality.bitrate}k` : dim('-'),
    fmtDuration(Number(p.track.duration || 0) * 1000),
    p.skip ? dim(p.skip) : green('待下载'),
  ]), { align: ['right', 'left', 'left', 'right', 'left'] }))

  const pending = plan.filter((p) => !p.skip)
  const summary = { album: realName, tracks: tracks.length, queued: 0, downloaded: 0, failed: [] }

  if (flags.dry) {
    info(`预演：待下载 ${pending.length} 首${plan.length > pending.length ? `，跳过 ${plan.length - pending.length} 首` : ''}`)
    return summary
  }
  if (!pending.length) {
    ok('没有需要下载的曲目')
    if (flags.verify) await cmdVerify(albumDir, flags)
    return summary
  }

  fs.mkdirSync(albumDir, { recursive: true })

  const { engine, note } = await createEngine(engineOptions(flags))
  info(`下载引擎 ${note}`)

  // 取到一条就提交一条：直链带时效，攒着一起提交会让最早的几条在排队时过期
  const submitOne = async (p) => {
    const dest = path.join(albumDir, p.out)
    if (flags.force && fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true })
      fs.rmSync(`${dest}.aria2`, { force: true })
    } else if (fs.existsSync(dest) && !fs.existsSync(`${dest}.aria2`)) {
      // 取链期间目录被别处补齐了（或上一轮刚下完），别重复提交：Aria2 会拒绝覆盖完整文件
      info(`已存在，跳过：${p.out}`)
      return
    }
    const url = await getUrl(target.platform, p.track, p.quality, {
      onRetry: ({ attempt, message }) => warn(`取链重试 ${p.out}（第 ${attempt} 次）：${message}`),
    })
    await engine.submit({ url, dir: albumDir, out: p.out, label: p.track.name })
  }

  let failedTracks = []
  for (const p of pending) {
    try {
      await submitOne(p)
    } catch (err) {
      warn(`取链失败 ${p.track.name}：${err.message}`)
      failedTracks.push(p)
    }
  }
  // 「Song not found」多为瞬时故障，跑完再补一轮通常就过
  if (failedTracks.length) {
    info(`补一轮取链：${failedTracks.length} 首`)
    await sleep(3000)
    const retryList = failedTracks
    failedTracks = []
    for (const p of retryList) {
      try {
        await submitOne(p)
      } catch (err) {
        fail(`仍取链失败 ${p.track.name}：${err.message}`)
        failedTracks.push(p)
      }
    }
  }

  const submitted = engine.submitted.length
  summary.queued = submitted
  summary.failed.push(...failedTracks.map((p) => ({ out: p.out, error: '取链失败' })))

  const noWait = flags['no-wait'] && engine.kind === 'aria2'
  if (submitted && !noWait) {
    const result = await engine.finish({ onProgress: makeReporter() })
    for (const f of result.failed) fail(`下载失败 ${f.out}：${f.error}`)
    summary.failed.push(...result.failed.map((f) => ({ out: f.out, error: f.error })))
    summary.downloaded = result.completed.length
    if (result.failed.length) warn(`完成 ${result.completed.length}/${submitted}，失败 ${result.failed.length} 首（重跑本命令可续传缺失曲目）`)
    else ok(`完成 ${result.completed.length}/${submitted}`)
  } else if (submitted) {
    info(`已提交 ${submitted} 个任务到 Aria2，可稍后用 dl verify 校验`)
  }

  const manifest = {
    album: realName,
    artist: data.info?.artist || artist,
    platform: target.platform,
    albumId: String(target.id),
    code,
    generatedAt: new Date().toISOString(),
    tracks: plan.map((p) => ({
      index: p.idx,
      name: p.track.name,
      duration: Number(p.track.duration || 0),
      format: p.quality?.format || '',
    })),
  }
  fs.writeFileSync(path.join(albumDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  if (flags.verify) await cmdVerify(albumDir, flags)
  return summary
}

export async function cmdAlbum(name, flags) {
  if (!name) throw new Error('缺少专辑名')
  const artist = pick(flags.artist, cfg.artist)
  if (!artist) throw new Error('缺少 --artist：专辑检索必须带歌手名，否则会命中同名翻唱专辑')
  applySiteRate(flags)
  return downloadAlbum({
    artist,
    album: name,
    code: pick(flags.code),
    root: resolveRoot(flags),
    dir: pick(flags.dir),
    flags,
  })
}

/** 批量模式：--list albums.json，格式同 skill 的 albums.json */
export async function cmdAlbumList(file, flags) {
  const abs = path.resolve(pick(file) || '.')
  if (!fs.existsSync(abs)) throw new Error(`清单不存在: ${abs}`)
  const blocks = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const only = pick(flags.only) ? new Set(pick(flags.only).split(/[,，]/).map((s) => s.trim())) : null
  applySiteRate(flags)

  const summary = []
  for (const block of blocks) {
    // 清单里的 root 是「歌手目录」，与 --root（库根）不是一回事
    const artistRoot = block.root ? path.resolve(block.root) : ''
    for (const alb of block.albums || []) {
      if (only && !only.has(String(alb.code))) continue
      const res = await downloadAlbum({
        artist: block.artist,
        album: alb.name,
        code: alb.code || '',
        root: resolveRoot(flags),
        artistRoot,
        dir: '',
        flags: {
          ...flags,
          id: alb.id,
          platform: alb.platform || flags.platform,
          alts: (alb.alts || []).join(','),
          probe: alb.probe || flags.probe,
        },
      })
      summary.push(res)
    }
  }
  const failCount = summary.reduce((a, s) => a + s.failed.length, 0)
  console.log()
  info(`共 ${summary.length} 张专辑，提交 ${summary.reduce((a, s) => a + s.queued, 0)} 首，失败 ${failCount} 首`)
  return summary
}

// ---------------------------------------------------------------- dl track

export async function cmdTrack(title, flags) {
  if (!title) throw new Error('缺少曲名')
  const artist = pick(flags.artist, cfg.artist)
  if (!artist) throw new Error('缺少 --artist：单曲选源必须带歌手名，否则会下到同名异曲')
  applySiteRate(flags)

  const want = {
    title,
    artist,
    duration: Number(pick(flags.duration)) || 0,
    titleAlts: splitList(flags.alts),
  }
  const cands = await pickCandidates(want, {
    platforms: platformList(flags),
    pageLimit: flags.deep ? 3 : 1,
  })
  if (!cands.length) {
    fail(`没有找到合格候选：${title} - ${artist}`)
    info('可加 --alts 补标题别名，或 --duration 秒数辅助定位')
    return { queued: 0, failed: [{ out: title, error: '无合格候选' }] }
  }

  console.log(table(['#', '平台', '曲名', '歌手', '专辑', '时长', '音质', '得分'], cands.slice(0, 6).map((c, i) => {
    const q = pickQuality(c.minfo, qualityMode(flags))
    return [
      i + 1,
      PLATFORM_NAME[c.platform] || c.platform,
      c.name,
      c.artist,
      c.album_name || '-',
      fmtDuration(Number(c.duration || 0) * 1000),
      q ? `${q.format}/${q.bitrate}k` : dim('无'),
      c.score,
    ]
  }), { align: ['right', 'left', 'left', 'left', 'left', 'right', 'left', 'right'] }))

  const chosen = cands[0]
  const quality = pickQuality(chosen.minfo, qualityMode(flags))
  if (!quality) {
    fail(`选中候选没有可用音质：${chosen.name}`)
    return { queued: 0, failed: [{ out: title, error: '无可用音质' }] }
  }

  const credit = pick(flags.credit) || artist
  const code = pick(flags.code)
  const dir = pick(flags.dir) ? path.resolve(pick(flags.dir)) : path.join(resolveRoot(flags), sanitizeFilename(artist))
  const out = `${code ? `${sanitizeFilename(code)} - ` : ''}${sanitizeFilename(title)} - ${sanitizeFilename(credit)}.${quality.format}`
  info(`选中 ${bold(chosen.name)} ${dim(`(${chosen.artist} · ${PLATFORM_NAME[chosen.platform]})`)}`)
  info(`目录 ${cyan(dir)}`)

  if (flags.dry) {
    info(`预演：${out}（${quality.format}/${quality.bitrate}k）`)
    return { queued: 0, failed: [] }
  }
  if (!flags.force && fs.existsSync(path.join(dir, out))) {
    warn(`已存在，跳过：${out}（--force 覆盖）`)
    return { queued: 0, failed: [] }
  }

  const { engine, note } = await createEngine(engineOptions(flags))
  info(`下载引擎 ${note}`)

  let url
  try {
    url = await getUrl(chosen.platform, chosen, quality, {
      onRetry: ({ attempt, message }) => warn(`取链重试（第 ${attempt} 次）：${message}`),
    })
  } catch (err) {
    fail(`取链失败：${err.message}`)
    return { queued: 0, failed: [{ out, error: err.message }] }
  }

  await engine.submit({ url, dir, out, label: title })
  if (flags['no-wait'] && engine.kind === 'aria2') {
    info(`已提交到 Aria2：${out}`)
    return { queued: 1, failed: [] }
  }

  const result = await engine.finish({ onProgress: makeReporter() })
  for (const f of result.failed) fail(`下载失败 ${f.out}：${f.error}`)
  if (result.completed.length) ok(`完成 ${cyan(path.join(dir, out))}`)
  return { queued: result.completed.length, failed: result.failed }
}

// ---------------------------------------------------------------- dl verify

function walkAudio(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkAudio(abs))
    else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(abs)
  }
  return out.sort()
}

/** 从文件所在目录向上找最近的清单（最多爬到校验根目录） */
function manifestFor(fileDir, stopAt) {
  const stop = path.resolve(stopAt)
  let dir = path.resolve(fileDir)
  for (;;) {
    const file = path.join(dir, MANIFEST)
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    }
    if (dir === stop) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function magicOf(file, bytes = 4) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    fs.readSync(fd, buf, 0, bytes, 0)
    return buf.toString('latin1')
  } finally {
    fs.closeSync(fd)
  }
}

function expectedDuration(manifest, base) {
  const m = /^(\d+)\s*-/.exec(base)
  if (!m || !manifest?.tracks) return 0
  const t = manifest.tracks.find((x) => Number(x.index) === Number(m[1]))
  return t ? Number(t.duration || 0) : 0
}

/**
 * 校验：不只看文件存在。
 * FLAC 魔数、体积下限、时长与清单/预期吻合、体积×8÷时长 与 ffprobe 式码率一致。
 */
export async function cmdVerify(dir, flags = {}) {
  const abs = path.resolve(pick(dir) || '.')
  if (!fs.existsSync(abs)) throw new Error(`目录不存在: ${abs}`)
  const files = walkAudio(abs)
  if (!files.length) {
    warn(`目录内没有音频文件: ${abs}`)
    return []
  }

  const rows = []
  let bad = 0
  let withManifest = 0

  for (const file of files) {
    const base = path.basename(file)
    const ext = path.extname(file).toLowerCase()
    const size = fs.statSync(file).size
    const issues = []

    const manifest = manifestFor(path.dirname(file), abs)
    if (manifest) withManifest++

    let meta = null
    try {
      meta = await parseFile(file, { duration: true })
    } catch (err) {
      issues.push(`解析失败 ${err.message}`)
    }

    if (fs.existsSync(`${file}.aria2`)) issues.push('下载未完成（.aria2 控制文件残留）')
    if (ext === '.flac' && magicOf(file) !== 'fLaC') issues.push('非 FLAC 容器')
    if (size < 1024 * 1024) issues.push('文件小于 1MB')

    const dur = Number(meta?.format?.duration || 0)
    const exp = expectedDuration(manifest, base)
    if (exp && dur && Math.abs(dur - exp) > 8) issues.push(`时长差 ${Math.round(dur - exp)}s`)

    const br = Number(meta?.format?.bitrate || 0)
    if (dur && br) {
      const calc = (size * 8) / dur
      const diff = Math.abs(calc - br) / br
      if (diff > 0.08) issues.push(`码率不符 ${(diff * 100).toFixed(0)}%`)
    }

    if (issues.length) bad++
    rows.push([
      base,
      ext.replace('.', '').toUpperCase(),
      dur ? fmtDuration(dur * 1000) : '-',
      br ? `${Math.round(br / 1000)}k` : '-',
      fmtSize(size),
      issues.length ? red(issues.join('；')) : green('正常'),
    ])
  }

  console.log()
  console.log(table(['文件', '格式', '时长', '码率', '大小', '状态'], rows, {
    align: ['left', 'left', 'right', 'right', 'right', 'left'],
  }))
  if (bad) warn(`共 ${files.length} 个文件，${bad} 个异常${withManifest ? '' : '（无清单，跳过时长比对）'}`)
  else ok(`共 ${files.length} 个文件，全部正常${withManifest ? `（${withManifest} 个比对时长）` : '（无清单，跳过时长比对）'}`)
  return rows
}
