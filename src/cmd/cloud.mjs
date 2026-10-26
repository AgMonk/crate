// 云盘批量操作：列表 / 上传 / 删除 / 纠错 / 云盘歌曲批量入歌单
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseFile } from 'music-metadata'
import { call, must, getUid, getNickname, EXPORT_DIR, SNAP_DIR, ensureDir } from '../lib/api.mjs'
import { resolvePlaylist, fetchTracks, applyTrackOp, listPlaylists } from './playlist.mjs'
import {
  table, fmtSize, fmtTime, fmtDuration, ok, info, warn, fail, bold, dim, cyan, green, red, progress,
} from '../lib/ui.mjs'

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.wma', '.ape'])
const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
}
const PAGE = 100

// 云盘条目的真实元数据在 privateCloud 子对象中；顶层 artist/album 已被服务端置空。
// 自传条目的 artist 常被写成「未知艺术家」，此时应回退到匹配到的版权曲目信息。
const UNKNOWN = new Set(['', '未知', '未知艺术家', '未知专辑'])
const cloudName = (it) => it.songName || it.name || it.simpleSong?.name || '(无标题)'
const cloudArtist = (it) => {
  const own = it.privateCloud?.artist
  const ar = (it.simpleSong?.ar || it.ar || []).map((a) => a.name).filter(Boolean).join(' / ')
  if (own && !UNKNOWN.has(own.trim())) return own
  return ar || own || '未知艺术家'
}
const cloudAlbum = (it) => {
  const own = it.privateCloud?.album
  const al = it.simpleSong?.al?.name || it.al?.name || ''
  if (own && !UNKNOWN.has(own.trim())) return own
  return al || own || ''
}
const cloudSize = (it) => it.privateCloud?.fileSize ?? it.fileSize ?? it.size ?? 0
/** 码率单位不统一：历史条目存 kbps(968)，新条目存 bps(1756000)，按量级归一化为 kbps */
const cloudBitrate = (it) => {
  const raw = Number(it.privateCloud?.bitrate ?? it.bitrate ?? it.simpleSong?.h?.br ?? 0) || 0
  return raw > 10000 ? Math.round(raw / 1000) : Math.round(raw)
}
/** 云盘条目 id：songId 与匹配到的版权曲目 id 相同；未匹配时即云盘自身 id */
const cloudId = (it) => it.songId ?? it.songid ?? it.id
const cloudMatch = (it) => it.matchType || 'unknown'
const cloudFileName = (it) => it.privateCloud?.fileName || it.fileName || ''

/** 按名称/歌手/匹配状态筛选 */
function filterCloud(items, flags) {
  const kw = (flags.name || '').toLowerCase()
  const akw = (flags.artist || '').toLowerCase()
  const match = (flags.match || '').toLowerCase()
  return items.filter(
    (it) =>
      (!kw || cloudName(it).toLowerCase().includes(kw) || cloudFileName(it).toLowerCase().includes(kw)) &&
      (!akw || cloudArtist(it).toLowerCase().includes(akw)) &&
      (!match || cloudMatch(it) === match),
  )
}

/** 拉取云盘全量（自动翻页） */
export async function fetchCloud({ max = Infinity } = {}) {
  const out = []
  let offset = 0
  for (;;) {
    const body = await call('user_cloud', { limit: PAGE, offset })
    if (body?.code !== 200) throw new Error(`获取云盘列表失败 [code=${body?.code}] ${body?.msg || ''}`)
    const list = body.data || []
    out.push(...list)
    if (list.length < PAGE || out.length >= max) break
    if (body.hasMore === false) break
    offset += PAGE
  }
  return out.slice(0, Number.isFinite(max) ? max : undefined)
}

export async function cmdList(flags) {
  const max = Number(flags.limit || Infinity)
  const items = filterCloud(await fetchCloud({ max }), flags)
  if (!items.length) {
    info(flags.match || flags.name || flags.artist ? '没有符合条件的云盘歌曲' : '云盘为空')
    return []
  }

  const rows = items.map((it, i) => [
    i + 1,
    cloudId(it),
    cloudName(it),
    cloudArtist(it),
    cloudAlbum(it),
    fmtSize(cloudSize(it)),
    cloudBitrate(it) ? `${Math.round(cloudBitrate(it))}k` : '-',
    cloudMatch(it) === 'matched' ? green('已匹配') : dim('未匹配'),
    fmtTime(it.addTime || it.createTime),
  ])

  console.log(table(['#', '云盘ID', '标题', '歌手', '专辑', '大小', '码率', '匹配', '上传时间'], rows, {
    align: ['right', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'],
  }))

  const totalSize = items.reduce((a, it) => a + Number(cloudSize(it) || 0), 0)
  const unmatched = items.filter((it) => cloudMatch(it) !== 'matched').length
  info(`共 ${items.length} 首，合计 ${fmtSize(totalSize)}${unmatched ? `，其中 ${unmatched} 首未匹配到版权曲目` : ''}`)

  if (flags.export) {
    const out = path.resolve(flags.export)
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['songId', 'name', 'artist', 'album', 'fileName', 'fileSize', 'bitrate', 'matchType', 'addTime'].join(',')]
    for (const it of items) {
      lines.push([
        cloudId(it), cloudName(it), cloudArtist(it), cloudAlbum(it), cloudFileName(it),
        cloudSize(it), cloudBitrate(it), cloudMatch(it), fmtTime(it.addTime || it.createTime),
      ].map(esc).join(','))
    }
    fs.writeFileSync(out, '\uFEFF' + lines.join('\r\n'), 'utf8')
    ok(`已导出 → ${cyan(out)}`)
  }
  return items
}

function collectAudio(targets, recursive) {
  const files = []
  for (const t of targets) {
    const abs = path.resolve(t)
    if (!fs.existsSync(abs)) {
      warn(`路径不存在，跳过: ${abs}`)
      continue
    }
    const st = fs.statSync(abs)
    if (st.isFile()) {
      if (AUDIO_EXT.has(path.extname(abs).toLowerCase())) files.push(abs)
      else warn(`非音频扩展名，跳过: ${abs}`)
      continue
    }
    const walk = (dir) => {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        // 显式自然排序（数字段按数值比较），避免依赖文件系统返回顺序
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      for (const entry of entries) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (recursive) walk(p)
        } else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
          files.push(p)
        }
      }
    }
    walk(abs)
  }
  return files
}

/** 流式计算 MD5，避免大文件重复整块读入内存 */
function md5Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/**
 * 三段式上传：申请凭证 → 直传 NOS → 登记并发布
 * 绕开库内 cloud.js 的 latin1 重编码（会把中文名弄乱码）
 */
export async function uploadOne(file, md5In) {
  const buf = await fsp.readFile(file)
  const md5 = md5In || crypto.createHash('md5').update(buf).digest('hex')
  const size = buf.length
  const filename = path.basename(file)
  const ext = path.extname(filename).toLowerCase()

  let song = path.basename(filename, ext)
  let artist = '未知艺术家'
  let album = '未知专辑'
  try {
    const meta = await parseFile(file, { duration: false })
    const c = meta.common || {}
    if (c.title) song = c.title
    if (c.artist) artist = c.artist
    if (c.album) album = c.album
  } catch {
    /* 标签缺失时回退文件名 */
  }

  const token = must(
    await call('cloud_upload_token', { md5, fileSize: size, filename, bitrate: 999000 }),
    '申请上传凭证',
  )
  const t = token.data || {}

  // 实测：该分支对未上传过的新文件也返回 needUpload=false，但会正常下发 uploadUrl/resourceId，
  // 因此 needUpload 不可作为跳过依据；只要拿到凭证就必须直传，否则云盘不会出现该文件。
  if (!t.uploadUrl || !t.resourceId) {
    throw new Error(`未获取到有效上传凭证 (needUpload=${t.needUpload})`)
  }

  {
    const res = await fetch(t.uploadUrl, {
      method: 'POST',
      headers: {
        'x-nos-token': t.uploadToken,
        'Content-MD5': md5,
        'Content-Type': MIME[ext] || 'audio/mpeg',
        'Content-Length': String(size),
      },
      body: buf,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`直传对象存储失败 HTTP ${res.status} ${text.slice(0, 200)}`)
    }
  }

  const done = must(
    await call('cloud_upload_complete', {
      songId: t.songId,
      resourceId: t.resourceId,
      md5,
      filename,
      song,
      artist,
      album,
    }),
    '登记云盘歌曲',
  )

  return { songId: done.data?.songId ?? t.songId, song, artist, album, size, skipped: false }
}

export async function cmdUpload(targets, flags) {
  if (!targets.length) throw new Error('用法: cloud upload <文件或目录...> [--recursive] [--apply]')
  const files = collectAudio(targets, !!flags.recursive)
  if (!files.length) return warn('未找到可上传的音频文件')

  const preview = files.slice(0, Number(flags.limit || files.length))
  console.log(`${bold('待上传')} ${preview.length} 个文件`)
  console.log(table(['#', '文件', '大小'], preview.map((f, i) => [i + 1, path.basename(f), fmtSize(fs.statSync(f).size)]), {
    align: ['right', 'left', 'right'],
  }))
  if (preview.length < files.length) info(`受 --limit 限制，本次仅处理前 ${preview.length} 个`)

  if (!flags.apply) return warn('预演模式，未上传。确认无误后追加 --apply')

  let targetPid = null
  let targetName = null
  if (flags.playlist) {
    if (String(flags.playlist).startsWith('new:')) {
      targetName = String(flags.playlist).slice(4)
      info(`全部上传成功后将创建歌单「${targetName}」并按文件顺序写入`)
    } else {
      const pl = await resolvePlaylist(flags.playlist)
      targetPid = pl.id
      info(`上传后将按文件顺序加入歌单: ${pl.name} (${pl.id})`)
    }
  }

  const results = []
  let failed = 0
  let skipped = 0

  // 幂等基础：云盘 privateCloud.md5 是唯一可靠判重依据（needUpload 不可用）
  info('建立云盘 MD5 索引…')
  const index = new Map()
  for (const it of await fetchCloud()) {
    const m = it.privateCloud?.md5
    if (m) index.set(m.toLowerCase(), { songId: cloudId(it), name: cloudName(it) })
  }
  info(`索引 ${index.size} 条，开始上传`)

  for (let i = 0; i < preview.length; i++) {
    const f = preview[i]
    const base = path.basename(f)
    try {
      const md5 = await md5Of(f)
      const hit = index.get(md5)
      if (hit) {
        skipped++
        results.push({ songId: hit.songId, song: hit.name, size: fs.statSync(f).size, md5, file: f, skipped: true })
        ok(`已存在，跳过  ${base}  →  id=${hit.songId}`)
        continue
      }
      const r = await uploadOne(f, md5)
      results.push({ ...r, md5, file: f })
      index.set(md5, { songId: r.songId, name: r.song })
      ok(`已上传  ${base}  →  id=${r.songId}`)
    } catch (e) {
      failed++
      fail(`${base}  失败: ${e.message}`)
    }
  }

  const summary = `成功 ${results.length} 个（新传 ${results.length - skipped}，跳过 ${skipped}），失败 ${failed} 个`
  results.length ? ok(summary) : fail(summary)

  if (!flags.playlist) return results

  /**
   * 完整性关卡：上传接口返回的 id 不可靠（实为 originalAudioSongId），
   * 且偶发云端内容与本地不符。一律以云端实际 md5 反查真实 songId，
   * 反查不到即视为该文件未正确入库，不得写入歌单。
   */
  const resolveOrdered = async () => {
    const cloudNow = await fetchCloud()
    const byMd5 = new Map()
    for (const it of cloudNow) {
      const m = it.privateCloud?.md5
      if (m) byMd5.set(m.toLowerCase(), it)
    }
    const ordered = []
    const broken = []
    for (const r of results) {
      const hit = byMd5.get(r.md5)
      if (hit) ordered.push(cloudId(hit))
      else broken.push(r)
    }
    return { ordered, broken, cloudNow }
  }

  let { ordered, broken, cloudNow } = await resolveOrdered()

  if (broken.length && flags.repair) {
    warn(`发现 ${broken.length} 个文件云端内容与本地不符，开始自愈…`)
    for (const b of broken) {
      const name = path.basename(b.file, path.extname(b.file))
      const stale = cloudNow.find((it) => cloudName(it) === name)
      if (stale) {
        await call('user_cloud_del', { id: cloudId(stale) })
        info(`已删除异常条目 ${name} id=${cloudId(stale)}`)
      }
      await uploadOne(b.file, b.md5)
      ok(`重传完成 ${name}`)
    }
    ;({ ordered, broken } = await resolveOrdered())
  }

  if (broken.length) {
    warn(`仍有 ${broken.length} 个文件未正确入库，为确保歌单可用，本次不创建/写入歌单：`)
    console.log(`  ${broken.map((b) => path.basename(b.file)).join('\n  ')}`)
    warn('可执行 cloud verify <目录> --apply 修复后，再用 cloud topl <歌单> --from-dir <目录> 补入')
    return results
  }

  if (failed > 0) {
    warn(`存在 ${failed} 个上传失败文件，按约定不创建/写入歌单。`)
    return results
  }

  if (!targetPid) {
    const body = must(await call('playlist_create', { name: targetName }), '创建歌单')
    targetPid = body.id || body.playlist?.id
    ok(`已创建歌单「${targetName}」 id=${targetPid}`)
  }

  // 保序：服务端逆序插头部，写入层已做补偿
  await applyTrackOp('add', targetPid, ordered, { preserveOrder: true })
  ok(`已按上传顺序加入歌单 ${targetPid}：${ordered.length} 首`)
  return results
}

export async function cmdDelete(flags) {
  let targets = []

  if (flags.ids) {
    targets = flags.ids.split(/[\s,]+/).filter(Boolean).map((s) => ({ id: Number(s), name: `id=${s}` }))
  } else if (flags['not-in-playlist']) {
    // 未被任何歌单引用的云盘条目：以 songId 是否出现在歌单曲目中为准
    const { index, playlists } = await buildPlaylistIndex()
    const items = await fetchCloud()
    const orphan = items.filter((it) => !index.has(cloudId(it)))
    info(`已扫描 ${playlists.length} 个歌单（${index.size} 首曲目），云盘共 ${items.length} 首`)
    targets = orphan.map((it) => ({
      id: cloudId(it),
      name: cloudName(it),
      artist: cloudArtist(it),
      album: cloudAlbum(it),
      size: cloudSize(it),
      bitrate: cloudBitrate(it),
      match: cloudMatch(it),
      md5: it.privateCloud?.md5 || '',
      fileName: cloudFileName(it),
      addTime: it.addTime || it.createTime,
    }))
  } else if (flags.name || flags.artist || flags.match) {
    const items = filterCloud(await fetchCloud(), flags)
    targets = items.map((it) => ({ id: cloudId(it), name: cloudName(it), artist: cloudArtist(it) }))
  } else {
    throw new Error('请用 --not-in-playlist 或 --ids / --name / --artist / --match 指定删除目标')
  }

  if (!targets.length) return warn('没有匹配的云盘歌曲')

  const totalSize = targets.reduce((a, t) => a + Number(t.size || 0), 0)
  console.log(`${bold('待删除')} ${targets.length} 首${totalSize ? `，合计 ${fmtSize(totalSize)}` : ''}`)
  console.log(
    table(
      ['云盘ID', '标题', '歌手', '大小', '匹配'],
      targets.slice(0, 30).map((t) => [t.id, t.name, t.artist || '', t.size ? fmtSize(t.size) : '', t.match === 'matched' ? '已匹配' : '未匹配']),
    ),
  )
  if (targets.length > 30) info(`... 另有 ${targets.length - 30} 首`)

  if (!flags.apply) return warn('预演模式，未删除。确认无误后追加 --apply')

  // 删除不可逆：先留清单（含 md5 与原始文件名），便于日后重新上传
  ensureDir(SNAP_DIR)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const manifest = path.join(SNAP_DIR, `del-cloud-${stamp}.json`)
  fs.writeFileSync(
    manifest,
    JSON.stringify({ at: new Date().toISOString(), reason: 'not-in-any-playlist', count: targets.length, totalSize, targets }, null, 2),
    'utf8',
  )
  info(`删除清单已保存: ${dim(manifest)}`)

  let done = 0
  let failed = 0
  for (const t of targets) {
    try {
      must(await call('user_cloud_del', { id: t.id }), `删除 ${t.name}`)
      done++
      process.stdout.write(`\r  ${dim(`已删除 ${done}/${targets.length}`)}`)
    } catch (e) {
      failed++
      process.stdout.write('\r')
      warn(`${t.name} 删除失败: ${e.message}`)
    }
  }
  process.stdout.write('\n')
  ok(`删除完成：成功 ${done}，失败 ${failed}`)
  return { done, failed, manifest }
}

/**
 * 上传完整性校验：本地 md5 与云端 privateCloud.md5 逐一对账。
 * --repair 时删除不合格条目并重传，重传后再校验一次。
 */
export async function cmdVerify(dir, flags) {
  const target = dir || flags.dir
  if (!target) throw new Error('用法: cloud verify <目录> [--recursive] [--repair]')
  const files = collectAudio([target], flags.recursive !== false)
  if (!files.length) return warn('目录下没有音频文件')

  const run = async () => {
    const cloud = await fetchCloud()
    const byMd5 = new Map()
    const byName = new Map()
    for (const it of cloud) {
      const m = it.privateCloud?.md5
      if (m) byMd5.set(m.toLowerCase(), it)
      byName.set(cloudName(it), it)
    }
    const rows = []
    const bad = []
    for (const f of files) {
      const md5 = await md5Of(f)
      const size = fs.statSync(f).size
      const hit = byMd5.get(md5)
      const sizeOk = hit ? Number(hit.privateCloud?.fileSize) === size : false
      let status = '缺失'
      if (hit && sizeOk) status = '完整'
      else if (hit) status = '大小不符'
      else {
        const named = byName.get(path.basename(f, path.extname(f)))
        if (named) status = '内容不符'
      }
      if (status !== '完整') bad.push({ file: f, md5, size, status })
      rows.push([
        path.basename(f),
        fmtSize(size),
        hit ? fmtSize(hit.privateCloud?.fileSize) : '-',
        status === '完整' ? green(status) : red(status),
      ])
    }
    return { rows, bad, cloud }
  }

  const first = await run()
  console.log(table(['文件', '本地大小', '云端大小', '状态'], first.rows, {
    align: ['left', 'right', 'right', 'left'],
  }))
  info(`校验 ${files.length} 个文件，完整 ${files.length - first.bad.length}，异常 ${first.bad.length}`)

  if (!first.bad.length) return ok('全部文件云端内容与本地一致')
  if (!flags.apply) return warn('预演模式，未修复。追加 --apply --repair 执行修复')

  const cloudById = new Map(first.cloud.map((it) => [cloudId(it), it]))
  for (const b of first.bad) {
    const name = path.basename(b.file, path.extname(b.file))
    const stale = first.cloud.find((it) => cloudName(it) === name)
    if (stale) {
      // 内容不符或大小不符的旧条目必须先删，否则重传会产生重复
      await call('user_cloud_del', { id: cloudId(stale) })
      info(`已删除旧条目 ${cloudName(stale)} id=${cloudId(stale)}`)
    }
    const md5 = await md5Of(b.file)
    const r = await uploadOne(b.file, md5)
    ok(`重传完成 ${path.basename(b.file)}`)
  }

  const second = await run()
  console.log(table(['文件', '本地大小', '云端大小', '状态'], second.rows, {
    align: ['left', 'right', 'right', 'left'],
  }))
  if (second.bad.length) {
    warn(`仍有 ${second.bad.length} 个文件异常，建议单独重跑`)
    return second
  }
  ok('修复完成，全部文件云端内容与本地一致')
  return second
}

/** 云盘歌曲批量加入歌单 */
export async function cmdToPlaylist(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const all = await fetchCloud()

  let picked
  if (flags['from-dir']) {
    // 按目录内文件顺序解析云端条目，顺序即文件顺序
    const files = collectAudio([flags['from-dir']], flags.recursive !== false)
    if (!files.length) return warn('目录下没有音频文件')
    const byMd5 = new Map()
    for (const it of all) {
      const m = it.privateCloud?.md5
      if (m) byMd5.set(m.toLowerCase(), it)
    }
    picked = []
    const missing = []
    for (const f of files) {
      const hit = byMd5.get(await md5Of(f))
      if (hit) picked.push(hit)
      else missing.push(path.basename(f))
    }
    if (missing.length) warn(`${missing.length} 个文件在云盘找不到或内容不符：${missing.slice(0, 5).join('、')}`)
    if (!picked.length) return warn('没有可加入的云盘歌曲')
    info(`按目录顺序解析到 ${picked.length} 首`)
  } else {
    const items = filterCloud(all, flags)
    picked = flags.limit ? items.slice(0, Number(flags.limit)) : items
    if (!picked.length) return warn('没有匹配的云盘歌曲')
  }

  const ids = picked.map((it) => cloudId(it)).filter(Boolean)
  const existing = new Set((await fetchTracks(pl.id)).map((t) => t.id))
  const fresh = ids.filter((id) => !existing.has(id))

  console.log(`${bold(pl.name)} (${pl.id})  匹配云盘 ${picked.length} 首，已在该歌单 ${ids.length - fresh.length} 首，待加入 ${fresh.length} 首`)
  console.log(table(['云盘ID', '标题', '歌手', '匹配'], picked.slice(0, 10).map((it) => [cloudId(it), cloudName(it), cloudArtist(it), cloudMatch(it)])))
  const unmatched = picked.filter((it) => cloudMatch(it) !== 'matched').length
  if (unmatched) warn(`其中 ${unmatched} 首未匹配版权曲目，加入歌单后可能显示为云盘曲目`)
  if (picked.length > 10) info(`... 另有 ${picked.length - 10} 首`)

  if (!fresh.length) return warn('没有需要加入的曲目')
  if (!flags.apply) return warn('预演模式，未写入。确认无误后追加 --apply')

  await applyTrackOp('add', pl.id, fresh, { preserveOrder: !!(flags['keep-order'] || flags.keepOrder || flags['from-dir']) })
  ok(`已加入 ${fresh.length} 首到歌单「${pl.name}」`)
}

/** 云盘歌曲纠错：把云盘歌曲匹配到正确的版权曲目 */
export async function cmdMatch(flags) {
  if (!flags.sid && !flags.ids) throw new Error('用法: cloud match --sid <云盘songId> --asid <目标歌曲id>')
  const sid = Number(flags.sid || flags.ids)
  const asid = Number(flags.asid)
  if (!asid) throw new Error('缺少 --asid 目标歌曲 id')
  if (!flags.apply) return warn(`预演模式：将把云盘歌曲 ${sid} 纠错匹配到歌曲 ${asid}，追加 --apply 执行`)
  must(await call('cloud_match', { uid: getUid(), sid, asid }), '云盘纠错')
  ok(`纠错提交成功: ${sid} → ${asid}`)
}

const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

/**
 * 建立「曲目 id → 收录歌单」索引，供归属报告与未收藏清理共用
 * @returns {Promise<{index: Map<number, {id:number,name:string}[]>, playlists: any[]}>}
 */
async function buildPlaylistIndex({ announce = true } = {}) {
  const playlists = await listPlaylists()
  if (announce) info(`扫描 ${playlists.length} 个歌单，建立曲目归属索引…`)

  const index = new Map()
  let scanned = 0
  for (const p of playlists) {
    const tracks = await fetchTracks(p.id)
    for (const t of tracks) {
      const arr = index.get(t.id)
      if (!arr) index.set(t.id, [{ id: p.id, name: p.name }])
      else if (!arr.some((x) => x.id === p.id)) arr.push({ id: p.id, name: p.name })
    }
    scanned++
    if (announce) progress(scanned, playlists.length, p.name.slice(0, 14))
  }
  return { index, playlists }
}

/**
 * 生成 Markdown 归属报告：云盘曲目按「是否已进入某个歌单」分类
 * 口径：以云盘条目的 songId 与歌单曲目 id 比对。已匹配条目与版权曲目共用 id，
 * 因此「已收藏」表示该曲目存在于歌单中，不等于一定是这次云盘上传的副本。
 */
export async function cmdReport(flags) {
  const { index, playlists } = await buildPlaylistIndex()

  info('拉取云盘清单…')
  const cloud = await fetchCloud()

  const inside = []
  const outside = []
  for (const it of cloud) {
    const hits = index.get(cloudId(it))
    if (hits?.length) inside.push({ it, hits })
    else outside.push(it)
  }

  const multi = inside.filter((x) => x.hits.length > 1)
  const totalSize = cloud.reduce((a, it) => a + Number(cloudSize(it) || 0), 0)
  const inSize = inside.reduce((a, x) => a + Number(cloudSize(x.it) || 0), 0)
  const matched = cloud.filter((it) => cloudMatch(it) === 'matched').length

  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const out = flags.out
    ? path.resolve(flags.out)
    : path.join(ensureDir(EXPORT_DIR), `云盘歌单归属-${stamp}.md`)

  const Lines = []
  Lines.push('# 网易云音乐 云盘歌单归属报告')
  Lines.push('')
  Lines.push(`- 账号：${getNickname() || '(未知)'}（uid ${getUid()}）`)
  Lines.push(`- 生成时间：${now.toLocaleString('zh-CN', { hour12: false })}`)
  Lines.push(`- 歌单扫描范围：${playlists.length} 个歌单，共 ${index.size} 首不同曲目`)
  Lines.push('')
  Lines.push('> **口径说明**：以云盘条目 `songId` 与歌单内曲目 id 比对。')
  Lines.push('>')
  Lines.push('> - **精确**：该云盘条目未匹配到版权曲目，id 唯一，歌单中出现即代表这份云盘副本被加入歌单。')
  Lines.push('> - **参考**：该云盘条目已匹配到版权曲目，二者共用 id；歌单中出现可能只是收藏了版权版，不代表云盘副本本身被加入。')
  Lines.push('')
  Lines.push('## 总览')
  Lines.push('')
  Lines.push('| 指标 | 数值 |')
  Lines.push('| --- | ---: |')
  Lines.push(`| 云盘曲目总数 | ${cloud.length} |`)
  Lines.push(`| 已进入歌单 | ${inside.length}（${((inside.length / cloud.length) * 100 || 0).toFixed(1)}%） |`)
  Lines.push(`| ├ 其中判定精确 | ${inside.filter((x) => cloudMatch(x.it) !== 'matched').length} |`)
  Lines.push(`| └ 其中仅参考 | ${inside.filter((x) => cloudMatch(x.it) === 'matched').length} |`)
  Lines.push(`| 未进入任何歌单 | ${outside.length}（${((outside.length / cloud.length) * 100 || 0).toFixed(1)}%） |`)
  Lines.push(`| 被 2 个及以上歌单收录 | ${multi.length} |`)
  Lines.push(`| 已匹配版权曲目 | ${matched} |`)
  Lines.push(`| 未匹配版权曲目 | ${cloud.length - matched} |`)
  Lines.push(`| 云盘占用 | ${fmtSize(totalSize)}（已收藏部分 ${fmtSize(inSize)}） |`)
  Lines.push('')

  Lines.push(`## 一、已收藏到歌单（${inside.length} 首）`)
  Lines.push('')
  if (!inside.length) Lines.push('_无_')
  else {
    const sorted = [...inside].sort(
      (a, b) =>
        a.hits[0].name.localeCompare(b.hits[0].name, 'zh-CN') ||
        cloudName(a.it).localeCompare(cloudName(b.it), 'zh-CN', { numeric: true }),
    )
    Lines.push('| # | 曲目 | 歌手 | 所属歌单 | 判定 |')
    Lines.push('| ---: | --- | --- | --- | --- |')
    sorted.forEach((x, i) => {
      Lines.push(
        `| ${i + 1} | ${mdCell(cloudName(x.it))} | ${mdCell(cloudArtist(x.it))} | ${mdCell(x.hits.map((h) => h.name).join('、'))} | ${cloudMatch(x.it) === 'matched' ? '参考' : '**精确**'} |`,
      )
    })
  }
  Lines.push('')

  Lines.push(`## 二、未加入任何歌单（${outside.length} 首）`)
  Lines.push('')
  if (!outside.length) Lines.push('_无_')
  else {
    const sorted = [...outside].sort((a, b) =>
      cloudName(a).localeCompare(cloudName(b), 'zh-CN', { numeric: true }),
    )
    Lines.push('| # | 曲目 | 歌手 | 专辑 | 大小 | 码率 | 匹配 | 上传时间 |')
    Lines.push('| ---: | --- | --- | --- | ---: | ---: | --- | --- |')
    sorted.forEach((it, i) => {
      Lines.push(
        `| ${i + 1} | ${mdCell(cloudName(it))} | ${mdCell(cloudArtist(it))} | ${mdCell(cloudAlbum(it))} | ${fmtSize(cloudSize(it))} | ${cloudBitrate(it) ? cloudBitrate(it) + 'k' : '-'} | ${cloudMatch(it) === 'matched' ? '已匹配' : '未匹配'} | ${fmtTime(it.addTime || it.createTime)} |`,
      )
    })
  }
  Lines.push('')

  Lines.push(`## 三、被多个歌单收录（${multi.length} 首）`)
  Lines.push('')
  if (!multi.length) Lines.push('_无_')
  else {
    Lines.push('| 曲目 | 歌手 | 收录歌单 | 数量 |')
    Lines.push('| --- | --- | --- | ---: |')
    ;[...multi]
      .sort((a, b) => b.hits.length - a.hits.length)
      .forEach((x) => {
        Lines.push(
          `| ${mdCell(cloudName(x.it))} | ${mdCell(cloudArtist(x.it))} | ${mdCell(x.hits.map((h) => h.name).join('、'))} | ${x.hits.length} |`,
        )
      })
  }
  Lines.push('')

  fs.writeFileSync(out, Lines.join('\n'), 'utf8')

  console.log()
  console.log(table(['分类', '数量', '占用'], [
    ['已收藏到歌单', inside.length, fmtSize(inSize)],
    ['未加入任何歌单', outside.length, fmtSize(totalSize - inSize)],
    ['其中多歌单收录', multi.length, '-'],
  ], { align: ['left', 'right', 'right'] }))
  ok(`报告已生成 → ${cyan(out)}`)
  return out
}

/**
 * 巡检：找出各歌单里「云盘未匹配」的曲目。
 * 判定必须与云端 matchType 交叉验证：版权下架的曲目同样会返回空歌手占位，
 * 只看空艺术家会把它们误判成待修复项。
 */
export async function cmdAudit(flags) {
  const { playlists } = await buildPlaylistIndex({ announce: false })
  info(`拉取云盘状态，巡检 ${playlists.length} 个歌单…`)

  const cloud = await fetchCloud()
  const unmatchedIds = new Set(cloud.filter((it) => cloudMatch(it) !== 'matched').map((it) => cloudId(it)))

  const hits = []
  let unavailable = 0
  let scanned = 0
  for (const p of playlists) {
    const tracks = await fetchTracks(p.id)
    const bad = tracks.filter((t) => unmatchedIds.has(t.id))
    unavailable += tracks.filter((t) => !t.artist && !unmatchedIds.has(t.id)).length
    if (bad.length) hits.push({ playlist: p, bad, total: tracks.length })
    scanned++
    progress(scanned, playlists.length, p.name.slice(0, 14))
  }

  const total = hits.reduce((a, h) => a + h.bad.length, 0)
  if (unavailable) info(`另有 ${unavailable} 首因版权下架而缺少歌手信息（非云盘条目，不可修复）`)
  if (!total) return ok('所有歌单中的云盘曲目均已匹配到版权曲目')

  console.log(`\n${bold('存在未匹配云盘曲目的歌单')} ${hits.length} 个，合计 ${total} 首\n`)
  console.log(
    table(
      ['歌单', 'ID', '总曲目', '未匹配'],
      hits.map((h) => [h.playlist.name, h.playlist.id, h.total, h.bad.length]),
      { align: ['left', 'left', 'right', 'right'] },
    ),
  )

  for (const h of hits) {
    console.log(`\n${bold(h.playlist.name)} (${h.playlist.id})`)
    console.log(
      table(
        ['云盘ID', '标题', '时长'],
        h.bad.map((t) => [t.id, t.name, fmtDuration(t.duration)]),
        { align: ['left', 'left', 'right'] },
      ),
    )
  }

  info('修复：确认正确版本后执行 cloud match --sid <云盘ID> --asid <目标歌曲id> --apply')
  warn('注意：未匹配 ≠ 可修复。若原版已从网易云下架，搜索只会返回翻唱/改编版，')
  warn('      强行匹配会把曲目挂到错误的歌手名下，比保持未匹配更糟。修复前务必核对歌手与时长。')
}
