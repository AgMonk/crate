// 为已下载专辑补写标签：曲名/艺人/专辑/音轨号/年份/流派/作曲 + 内嵌封面
//
// 元数据来源有两处：`.crate-manifest.json`（专辑名、曲序、时长）
// 与站点专辑接口（专辑正式名、专辑艺人、封面）。不再手工维护第三份清单。
//
// 该模块同时被 `dl tag`（独立补写）与下载流程（下完即写）复用。

import fs from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { fetchAlbum, PLATFORM_NAME } from '../lib/flac.mjs'
import { writeTags } from '../lib/tags.mjs'
import { ROOT } from '../lib/api.mjs'
import { table, ok, info, warn, fail, dim, cyan, green, red, bold } from '../lib/ui.mjs'

const MANIFEST = '.crate-manifest.json'
const COVER_DIR = path.join(ROOT, 'data', 'cover-cache')
const COVER_PARAM = '?param=600y600'
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.wav', '.ape', '.ogg', '.opus'])

export const pick = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

/** 目录本身有清单就用它，否则向下递归收集 */
function collectManifestDirs(dir) {
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) return []
  if (fs.existsSync(path.join(abs, MANIFEST))) return [abs]
  const out = []
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    out.push(...collectManifestDirs(path.join(abs, ent.name)))
  }
  return out
}

/** 按轨号前缀匹配实际文件（文件名里的曲名经过规范化，不能直接与标签比对） */
function indexFiles(dir) {
  const map = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!AUDIO_EXT.has(path.extname(f).toLowerCase())) continue
    const m = /^(\d+)\s*-/.exec(f)
    if (!m) continue
    map.set(Number(m[1]), path.join(dir, f))
  }
  return map
}

/** 拉取并缓存封面；返回图片 Buffer（失败为 null）。缓存按专辑 ID 落盘，重跑不重复下载 */
export async function loadCover(url, key, { dry = false } = {}) {
  if (!url) return null
  const cache = path.join(COVER_DIR, `${key || 'cover'}.img`)
  if (fs.existsSync(cache)) return fs.readFileSync(cache)
  if (dry) return Buffer.alloc(0)

  const target = url.includes('?') ? `${url}&param=600y600` : `${url}${COVER_PARAM}`
  const res = await fetch(target, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`封面下载失败 HTTP ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length < 1024) throw new Error('封面体积异常')
  fs.mkdirSync(COVER_DIR, { recursive: true })
  fs.writeFileSync(cache, data)
  return data
}

/** 目标字段 → music-metadata 的读法，用于判断「已经是目标状态」 */
function actualFields(meta) {
  const c = meta?.common || {}
  return {
    TITLE: c.title,
    ARTIST: c.artist,
    ALBUM: c.album,
    ALBUMARTIST: c.albumartist,
    TRACKNUMBER: c.track?.no,
    TRACKTOTAL: c.track?.of,
    DISCNUMBER: c.disk?.no,
    DISCTOTAL: c.disk?.of,
    DATE: c.year,
    GENRE: c.genre?.[0],
    COMPOSER: c.composer?.[0],
  }
}

/** 空值表示「本次不指定」，不参与比对，也不会覆盖已有值 */
function diffFields(meta, desired, withCover) {
  const actual = actualFields(meta)
  const diffs = []
  for (const [k, v] of Object.entries(desired)) {
    if (v === undefined || v === null || String(v).trim() === '') continue
    if (String(actual[k] ?? '') !== String(v)) diffs.push(k)
  }
  if (withCover && !meta?.common?.picture?.length) diffs.push('PICTURE')
  return diffs
}

async function readMeta(file) {
  try {
    return await parseFile(file, { duration: false })
  } catch {
    return null
  }
}

/**
 * 给单个文件写标签（供 dl track 复用）。
 * 返回 { written, skipped, diffs }。
 */
export async function tagFile(file, opts, { dry = false, force = false, quiet = true } = {}) {
  const desired = {
    TITLE: opts.title,
    ARTIST: opts.artist,
    ALBUM: opts.album,
    ALBUMARTIST: opts.albumArtist || opts.artist,
    TRACKNUMBER: opts.track,
    TRACKTOTAL: opts.trackTotal,
    DISCNUMBER: opts.disc,
    DISCTOTAL: opts.discTotal,
    DATE: opts.date,
    GENRE: opts.genre,
    COMPOSER: opts.composer,
  }
  const meta = await readMeta(file)
  const diffs = diffFields(meta, desired, !!opts.cover)
  if (!force && !diffs.length) return { written: false, skipped: true, diffs }

  if (!dry) writeTags(file, { comments: desired, picture: opts.cover })
  if (!quiet) info(dim(`${dry ? '预演' : '已写入'} ${path.basename(file)}：${diffs.join('/') || '全量'}`))
  return { written: !dry, skipped: false, diffs }
}

async function tagAlbum(dir, flags = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'))
  const files = indexFiles(dir)
  if (!files.size) {
    warn(`目录内没有可识别的音频文件：${dir}`)
    return { done: 0, skipped: 0, failed: [] }
  }

  let albumName = manifest.album || path.basename(dir)
  let albumArtist = manifest.artist || ''
  let coverUrl = ''
  let trackArtists = new Map()

  if (!flags['no-fetch'] && manifest.albumId) {
    try {
      const data = await fetchAlbum(manifest.platform || 'wyy', manifest.albumId)
      albumName = data.info?.name || albumName
      albumArtist = data.info?.artist || albumArtist
      coverUrl = data.info?.pic_url || ''
      for (const [i, t] of (data.list || []).entries()) trackArtists.set(i + 1, t.artist || '')
    } catch (err) {
      warn(`专辑接口不可用，退回清单信息：${err.message}`)
    }
  }

  let cover = null
  if (!flags['no-cover']) {
    try {
      cover = await loadCover(coverUrl, String(manifest.albumId || 'unknown'), { dry: !!flags.dry })
    } catch (err) {
      warn(`封面跳过（${err.message}）`)
    }
  }

  const total = (manifest.tracks || []).length
  const genre = pick(flags.genre) || 'Soundtrack'
  const date = pick(flags.date)
  const composer = pick(flags.composer)
  const quiet = !!flags.quiet

  if (!quiet) {
    console.log()
    info(`${bold(albumName)}　${dim(`${PLATFORM_NAME[manifest.platform] || manifest.platform || '-'} · 专辑ID ${manifest.albumId || '-'} · ${files.size} 文件`)}`)
    info(`目录 ${cyan(dir)}${cover?.length ? dim(`　封面 ${(cover.length / 1024).toFixed(0)} KB`) : ''}`)
  }

  const rows = []
  let done = 0
  let skipped = 0
  const failed = []

  for (const t of manifest.tracks || []) {
    const idx = Number(t.index)
    const file = files.get(idx)
    if (!file) {
      rows.push([String(idx).padStart(2, '0'), t.name, '-', red('文件缺失')])
      failed.push({ file: `${idx} - ${t.name}`, error: '文件缺失' })
      continue
    }

    const artist = trackArtists.get(idx) || albumArtist
    const desired = {
      TITLE: t.name,
      ARTIST: artist,
      ALBUM: albumName,
      ALBUMARTIST: albumArtist,
      TRACKNUMBER: idx,
      TRACKTOTAL: total,
      DISCNUMBER: 1,
      DISCTOTAL: 1,
      DATE: date,
      GENRE: genre,
      COMPOSER: composer,
    }

    // 已是目标状态就跳过：既支持「下完即写」，也支持事后补 --date/--composer
    const meta = flags.force ? null : await readMeta(file)
    const diffs = flags.force ? ['FORCE'] : diffFields(meta, desired, !!cover)
    if (!flags.force && !diffs.length) {
      skipped++
      rows.push([String(idx).padStart(2, '0'), t.name, artist || '-', dim('已是最新')])
      continue
    }

    if (flags.dry) {
      done++
      rows.push([String(idx).padStart(2, '0'), t.name, artist || '-', green('待写入')])
      continue
    }

    try {
      writeTags(file, { comments: desired, picture: cover })
      done++
      rows.push([String(idx).padStart(2, '0'), t.name, artist || '-', green('已写入')])
    } catch (err) {
      fs.rmSync(`${file}.cratetag`, { force: true })
      failed.push({ file: path.basename(file), error: err.message })
      rows.push([String(idx).padStart(2, '0'), t.name, artist || '-', red(err.message)])
    }
  }

  if (!quiet) console.log(table(['#', '曲目', '艺人', '状态'], rows, { align: ['right', 'left', 'left', 'left'] }))
  const verb = flags.dry ? '待写入' : '已写入'
  if (failed.length) warn(`${verb} ${done} 首，跳过 ${skipped} 首，失败 ${failed.length} 首`)
  else ok(`标签${verb} ${done} 首${skipped ? `，跳过 ${skipped} 首（已是最新）` : ''}${cover?.length ? `，封面 ${(cover.length / 1024).toFixed(0)} KB` : ''}`)

  return { done, skipped, failed }
}

export async function cmdTag(dirs, flags) {
  const targets = (dirs.length ? dirs : ['.']).flatMap((d) => collectManifestDirs(d))
  if (!targets.length) throw new Error('未找到 .crate-manifest.json：请指定已下载专辑目录')

  const summary = []
  for (const dir of targets) {
    try {
      summary.push(await tagAlbum(dir, flags))
    } catch (err) {
      fail(`${dir}: ${err.message}`)
      summary.push({ done: 0, skipped: 0, failed: [{ file: dir, error: err.message }] })
    }
  }

  const done = summary.reduce((a, s) => a + s.done, 0)
  const failCount = summary.reduce((a, s) => a + s.failed.length, 0)
  if (targets.length > 1) {
    console.log()
    info(`共 ${targets.length} 张专辑，处理 ${done} 首${failCount ? `，失败 ${failCount} 首` : ''}`)
  }
  return summary
}

/** 下载流程内部调用：目录已就绪、清单已写入，静默补写 */
export async function autoTag(dir, flags = {}) {
  if (flags['no-tag']) return null
  try {
    return await tagAlbum(dir, { ...flags, quiet: true })
  } catch (err) {
    warn(`标签补写失败（不影响音频）：${err.message}`)
    return null
  }
}

/** 单曲下载后的标签：复用同一套字段口径，不依赖清单 */
export async function autoTagFile(file, info_, flags = {}) {
  if (flags['no-tag'] || !file) return null
  let cover = null
  if (!flags['no-cover'] && info_.coverUrl) {
    try {
      cover = await loadCover(info_.coverUrl, info_.coverKey || 'single')
    } catch (err) {
      warn(`封面跳过（${err.message}）`)
    }
  }
  try {
    return await tagFile(file, {
      title: info_.title,
      artist: info_.artist,
      album: info_.album,
      albumArtist: info_.artist,
      date: pick(flags.date),
      genre: pick(flags.genre) || 'Soundtrack',
      composer: pick(flags.composer),
      cover,
    }, { force: false, quiet: true })
  } catch (err) {
    warn(`标签补写失败（不影响音频）：${err.message}`)
    return null
  }
}
