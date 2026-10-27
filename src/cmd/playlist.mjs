// 歌单批量操作：列表 / 详情 / 导出 / 增删 / 去重 / 合并 / 新建
import fs from 'node:fs'
import path from 'node:path'
import { call, must, getUid, SNAP_DIR, EXPORT_DIR, ensureDir } from '../lib/api.mjs'
import { table, fmtDuration, fmtSize, ok, info, warn, fail, bold, dim, cyan, green, red, progress } from '../lib/ui.mjs'

const PAGE = 1000
const BATCH = 200

/** 我的歌单（含我创建 + 我收藏） */
export async function listPlaylists() {
  const body = must(
    await call('user_playlist', { uid: getUid(), limit: 1000, offset: 0 }),
    '获取歌单列表',
  )
  const uid = getUid()
  return (body.playlist || []).map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.trackCount,
    creator: p.creator?.nickname || '',
    creatorId: p.creator?.userId,
    own: p.creator?.userId === uid,
    subscribed: !!p.subscribed,
    specialType: p.specialType ?? 0,
    playCount: p.playCount,
    createTime: p.createTime,
  }))
}

/** 按 id / 名称解析歌单，名称支持唯一子串匹配 */
export async function resolvePlaylist(ref) {
  if (ref === undefined || ref === null || ref === '') throw new Error('缺少歌单参数')
  const all = await listPlaylists()
  const raw = String(ref)

  if (/^\d+$/.test(raw)) {
    const hit = all.find((p) => String(p.id) === raw)
    if (hit) return hit
    // 不在我的列表里：直接按 id 查详情
    const body = await call('playlist_detail', { id: raw })
    if (body?.code === 200 && body.playlist) {
      const p = body.playlist
      return { id: p.id, name: p.name, trackCount: p.trackCount, creator: p.creator?.nickname, own: p.creator?.userId === getUid(), specialType: p.specialType ?? 0 }
    }
    throw new Error(`未找到歌单: ${raw}`)
  }

  const exact = all.filter((p) => p.name === raw)
  if (exact.length === 1) return exact[0]
  const fuzzy = all.filter((p) => p.name.includes(raw))
  if (fuzzy.length === 1) {
    warn(`名称未精确命中，使用子串匹配结果: ${fuzzy[0].name} (${fuzzy[0].id})`)
    return fuzzy[0]
  }
  if (fuzzy.length === 0) throw new Error(`未找到名称含「${raw}」的歌单`)
  const hint = fuzzy.slice(0, 12).map((p) => `  ${p.id}  ${p.name} (${p.trackCount}首)`).join('\n')
  throw new Error(`「${raw}」命中 ${fuzzy.length} 个歌单，请改用 id 指定:\n${hint}`)
}

/** 拉取歌单全部曲目（自动翻页） */
export async function fetchTracks(pid) {
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    const body = await call('playlist_track_all', { id: pid, limit: PAGE, offset })
    if (body?.code !== 200) throw new Error(`获取歌单曲目失败 [code=${body?.code}] ${body?.msg || ''}`)
    const songs = body.songs || []
    for (const s of songs) {
      out.push({
        id: s.id,
        name: s.name,
        artist: (s.ar || []).map((a) => a.name).join(' / '),
        album: s.al?.name || '',
        duration: s.dt,
        fee: s.fee,
        mv: s.mv,
      })
    }
    if (songs.length < PAGE) break
  }
  return out
}

/** 写操作前快照，保证可回溯 */
function snapshot(label, payload) {
  ensureDir(SNAP_DIR)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(SNAP_DIR, `${stamp}-${label}.json`)
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), label, ...payload }, null, 2), 'utf8')
  return file
}

/**
 * 提交曲目增删。
 * 服务端行为：op=add 会把整批逆序插到歌单头部。
 * preserveOrder=true 时按「倒序分段、段内倒序」提交，使最终顺序与入参一致。
 */
export async function applyTrackOp(op, pid, ids, { preserveOrder = false } = {}) {
  const chunks = []
  for (let i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH))
  const sequence = preserveOrder && op === 'add' ? chunks.reverse() : chunks

  let done = 0
  let acted = 0
  for (const raw of sequence) {
    const chunk = preserveOrder && op === 'add' ? [...raw].reverse() : raw
    const body = await call('playlist_tracks', { op, pid, tracks: chunk.join(',') })
    if (body?.code !== 200) {
      throw new Error(`${op === 'add' ? '添加' : '移除'}失败 [code=${body?.code}] ${body?.msg || ''} (已处理 ${done} 首)`)
    }
    acted += body.count ?? chunk.length
    done += chunk.length
    process.stdout.write(`\r  ${dim(`已提交 ${done}/${ids.length}`)}`)
  }
  if (ids.length) process.stdout.write('\n')
  return acted
}

export async function cmdList() {
  const all = await listPlaylists()
  if (!all.length) return info('没有歌单')
  const rows = all.map((p) => [
    p.id,
    p.name,
    p.trackCount,
    p.own ? '我创建' : p.subscribed ? '已收藏' : p.creator,
    p.playCount ?? '-',
  ])
  console.log(table(['ID', '名称', '曲目', '归属', '播放量'], rows, { align: ['left', 'left', 'right', 'left', 'right'] }))
  info(`共 ${all.length} 个歌单，其中我创建 ${all.filter((p) => p.own).length} 个`)
}

/**
 * 调整「我的歌单」侧边栏顺序。
 *
 * 服务端接口 /api/playlist/order/update 接受**全量**歌单 id 顺序，
 * 且 ids 必须是 JSON 数组字符串（逗号分隔会返回 code=400）。
 *
 * specialType=5 是网易云默认歌单（「我喜欢的音乐」改名而来），
 * 服务端会把它固定在第一位，不参与排序——排序时需把它单独摘出比较。
 */
export async function cmdSort(flags) {
  const all = await listPlaylists()
  const own = all.filter((p) => p.own && !p.subscribed)
  if (!own.length) return warn('没有可排序的自建歌单')

  // 默认歌单被服务端钉在首位，不参与排序
  const pinned = own.filter((p) => p.specialType === 5)
  const sortable = own.filter((p) => p.specialType !== 5)

  // 带前缀的排到最后，其余在前；组内按名称升序，同名按 id 兜底
  const prefix = flags.prefix === undefined ? 'lib_' : String(flags.prefix)
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id - b.id
  const isPrefixed = (p) => prefix !== '' && p.name.startsWith(prefix)
  const want = [
    ...pinned,
    ...sortable.filter((p) => !isPrefixed(p)).sort(byName),
    ...sortable.filter((p) => isPrefixed(p)).sort(byName),
  ]

  const beforeIds = own.map((p) => p.id)
  const afterIds = want.map((p) => p.id)
  if (beforeIds.join(',') === afterIds.join(',')) {
    ok(`歌单顺序已是目标顺序，无需调整（共 ${own.length} 个）`)
    return
  }

  const beforeName = new Map(own.map((p) => [p.id, p.name]))
  console.log(`${bold('歌单顺序')}  ${dim(`共 ${own.length} 个`)}`)
  console.log(`${dim(prefix ? `前缀 "${prefix}" 的排最后，其余按名称升序` : '全部按名称升序')}\n`)
  const rows = want.map((p, i) => {
    const oldIdx = beforeIds.indexOf(p.id)
    const moved = oldIdx !== i
    return [i + 1, p.name, moved ? `${oldIdx + 1} → ${i + 1}` : '—', p.specialType === 5 ? '固定' : '']
  })
  console.log(table(['新序', '名称', '原位', '备注'], rows, { align: ['right', 'left', 'left', 'left'] }))

  if (!flags.apply) return warn('预演模式，未调整。确认无误后追加 --apply')

  const file = snapshot('sort-playlists', { before: beforeIds, after: afterIds, names: Object.fromEntries(own.map((p) => [p.id, p.name])) })
  info(`快照: ${dim(file)}`)

  must(await call('playlist_order_update', { ids: JSON.stringify(afterIds) }), '调整歌单顺序')

  // 回读校验：服务端会把默认歌单提到首位，比较时需剔除它
  await new Promise((r) => setTimeout(r, 800))
  const after = (await listPlaylists()).filter((p) => p.own && !p.subscribed)
  const actual = after.filter((p) => p.specialType !== 5).map((p) => p.id)
  const expected = afterIds.filter((id) => !pinned.some((p) => p.id === id))
  if (actual.join(',') === expected.join(',')) ok(`已调整（服务端确认 ${after.length} 个歌单）`)
  else warn(`服务端顺序与预期不一致：实际前 3 个是 ${after.slice(0, 3).map((p) => p.name).join(' | ')}`)
}

export async function cmdShow(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const tracks = await fetchTracks(pl.id)
  const limit = Number(flags.limit || tracks.length)
  console.log(`${bold(pl.name)}  ${dim(`id=${pl.id}`)}  共 ${tracks.length} 首\n`)
  const rows = tracks.slice(0, limit).map((t, i) => [
    i + 1,
    t.id,
    t.name,
    t.artist,
    t.album,
    fmtDuration(t.duration),
  ])
  console.log(table(['#', '歌曲ID', '标题', '歌手', '专辑', '时长'], rows, {
    align: ['right', 'left', 'left', 'left', 'left', 'right'],
  }))
  if (limit < tracks.length) info(`仅显示前 ${limit} 首，共 ${tracks.length} 首`)
}

export async function cmdExport(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const tracks = await fetchTracks(pl.id)
  const format = (flags.format || 'csv').toLowerCase()
  const safe = pl.name.replace(/[\\/:*?"<>|]/g, '_')
  const out = flags.out
    ? path.resolve(flags.out)
    : path.join(ensureDir(EXPORT_DIR), `${safe}-${pl.id}.${format === 'json' ? 'json' : format === 'm3u' ? 'm3u8' : 'csv'}`)

  if (format === 'json') {
    fs.writeFileSync(out, JSON.stringify({ playlist: pl, tracks }, null, 2), 'utf8')
  } else if (format === 'm3u') {
    const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`]
    for (const t of tracks) {
      lines.push(`#EXTINF:${Math.round((t.duration || 0) / 1000)},${t.artist} - ${t.name}`)
      lines.push(`https://music.163.com/song?id=${t.id}`)
    }
    fs.writeFileSync(out, lines.join('\n'), 'utf8')
  } else {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['id', 'name', 'artist', 'album', 'duration_ms'].join(',')]
    for (const t of tracks) lines.push([t.id, t.name, t.artist, t.album, t.duration].map(esc).join(','))
    fs.writeFileSync(out, '\uFEFF' + lines.join('\r\n'), 'utf8')
  }
  ok(`已导出 ${tracks.length} 首 → ${cyan(out)}`)
}

function parseIds(flags) {
  const raw = flags.tracks || flags.ids || ''
  const fromFile = flags.file ? fs.readFileSync(path.resolve(flags.file), 'utf8') : ''
  const text = `${raw},${fromFile}`
  const ids = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^\d+$/.test(s)) throw new Error(`非法歌曲 ID: ${s}`)
      return Number(s)
    })
  if (!ids.length) throw new Error('缺少歌曲 ID，用 --tracks 1,2,3 或 --file ids.txt 指定')
  return [...new Set(ids)]
}

export async function cmdAdd(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const ids = parseIds(flags)
  const existing = new Set((await fetchTracks(pl.id)).map((t) => t.id))
  const fresh = ids.filter((id) => !existing.has(id))
  const dup = ids.length - fresh.length

  console.log(`${bold(pl.name)} (${pl.id})  待添加 ${ids.length} 首，已存在 ${dup} 首，实际提交 ${fresh.length} 首`)
  if (!fresh.length) return warn('没有需要添加的曲目')
  if (dup) info('已存在的曲目会自动跳过')

  if (!flags.apply) return warn('预演模式，未写入。确认无误后追加 --apply')

  const file = snapshot(`add-${pl.id}`, { pid: pl.id, before: [...existing] })
  info(`快照: ${dim(file)}`)
  const keepOrder = !!(flags['keep-order'] || flags.keepOrder)
  if (keepOrder) info('已启用保序：曲目将按给定顺序置于歌单头部')
  const acted = await applyTrackOp('add', pl.id, fresh, { preserveOrder: keepOrder })
  ok(`已提交添加 ${fresh.length} 首（服务端确认 ${acted}）`)
}

export async function cmdRemove(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const ids = parseIds(flags)
  const existing = new Set((await fetchTracks(pl.id)).map((t) => t.id))
  const hit = ids.filter((id) => existing.has(id))
  const miss = ids.length - hit.length

  console.log(`${bold(pl.name)} (${pl.id})  待移除 ${ids.length} 首，命中 ${hit.length} 首，不存在 ${miss} 首`)
  if (!hit.length) return warn('目标曲目均不在该歌单')

  if (!flags.apply) return warn('预演模式，未写入。确认无误后追加 --apply')

  const file = snapshot(`remove-${pl.id}`, { pid: pl.id, before: [...existing] })
  info(`快照: ${dim(file)}`)
  await applyTrackOp('del', pl.id, hit)
  ok(`已移除 ${hit.length} 首`)
}

const dedupeKey = (t, by) =>
  by === 'meta'
    ? `${t.name.toLowerCase()}||${t.artist.toLowerCase()}`
    : String(t.id)

export async function cmdDedupe(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const tracks = await fetchTracks(pl.id)
  const by = flags.by || 'id'
  const seen = new Map()
  const removeIds = []

  for (const t of tracks) {
    const key = dedupeKey(t, by)
    const prev = seen.get(key)
    if (prev === undefined) {
      seen.set(key, 1)
    } else {
      seen.set(key, prev + 1)
      removeIds.push(t.id)
    }
  }

  console.log(`${bold(pl.name)} (${pl.id})  共 ${tracks.length} 首，重复 ${removeIds.length} 首（按 ${by === 'meta' ? '标题+歌手' : '歌曲ID'} 判定）`)
  if (!removeIds.length) return ok('无重复曲目')

  const preview = tracks.filter((t) => removeIds.includes(t.id)).slice(0, 10)
  console.log(table(['将移除', '标题', '歌手'], preview.map((t) => [t.id, t.name, t.artist])))

  if (!flags.apply) return warn('预演模式，未写入。确认无误后追加 --apply')

  const file = snapshot(`dedupe-${pl.id}`, { pid: pl.id, before: tracks })
  info(`快照: ${dim(file)}`)

  // 同一 id 出现多次时，逐次提交才能删掉多余副本
  const counted = new Map()
  for (const t of tracks) counted.set(dedupeKey(t, by), (counted.get(dedupeKey(t, by)) || 0) + 1)
  const payload = []
  for (const t of tracks) {
    const key = dedupeKey(t, by)
    if (counted.get(key) > 1 && removeIds.includes(t.id)) payload.push(t.id)
  }

  await applyTrackOp('del', pl.id, payload)

  const after = await fetchTracks(pl.id)
  const afterCount = new Map()
  for (const t of after) afterCount.set(dedupeKey(t, by), (afterCount.get(dedupeKey(t, by)) || 0) + 1)
  const remain = [...afterCount.values()].filter((v) => v > 1).length
  if (remain) warn(`仍有 ${remain} 组重复未清除（服务端按 id 去重，同 id 多副本需再执行一次）`)
  else ok(`去重完成：${tracks.length} → ${after.length} 首`)
}

export async function cmdCreate(flags, positional) {
  const name = flags.name || positional[0]
  if (!name) throw new Error('用法: pl create <名称> 或 pl create --name <名称>')
  if (!flags.apply) return warn(`预演模式：将创建歌单「${name}」，追加 --apply 执行`)
  const body = must(await call('playlist_create', { name }), '创建歌单')
  const id = body.id || body.playlist?.id
  ok(`已创建歌单「${name}」 id=${id}`)
  return id
}

export async function cmdDeletePlaylist(ref, flags) {
  const pl = await resolvePlaylist(ref)
  if (!pl.own) throw new Error(`只能删除自己创建的歌单，${pl.name} (${pl.id}) 非自建`)
  const tracks = await fetchTracks(pl.id)

  console.log(`${bold(pl.name)} (${pl.id})  共 ${tracks.length} 首将被一并删除`)
  if (!flags.apply) return warn('预演模式，未删除。确认无误后追加 --apply')

  const file = snapshot(`del-playlist-${pl.id}`, { playlist: pl, tracks })
  info(`快照: ${dim(file)}`)
  must(await call('playlist_delete', { id: pl.id }), '删除歌单')
  ok(`已删除歌单「${pl.name}」`)
}

/**
 * 移动单曲到指定位置。
 * 注意：调整歌曲顺序的接口是 /api/playlist/manipulate/tracks + op=update（trackIds），
 * 而 /api/playlist/order/update 是调整侧边栏歌单顺序，两者不同，误用会静默返回 200 但不生效。
 */
export async function cmdMove(ref, flags) {
  const pl = await resolvePlaylist(ref)
  const id = Number(flags.id)
  const to = Number(flags.to)
  if (!id || !to) throw new Error('用法: pl move <歌单> --id <歌曲id> --to <目标位置>')

  const tracks = await fetchTracks(pl.id)
  const ids = tracks.map((t) => t.id)
  const from = ids.indexOf(id)
  if (from === -1) throw new Error(`歌曲 ${id} 不在歌单「${pl.name}」中（共 ${ids.length} 首）`)
  if (to < 1 || to > ids.length) throw new Error(`目标位置需在 1..${ids.length} 之间，收到 ${to}`)
  if (from === to - 1) return info(`歌曲 ${id} 已在第 ${to} 位，无需调整`)

  const want = [...ids]
  want.splice(from, 1)
  want.splice(to - 1, 0, id)

  console.log(`${bold(pl.name)} (${pl.id})  将「${tracks[from].name}」从第 ${from + 1} 位移到第 ${to} 位`)
  if (!flags.apply) return warn('预演模式，未调整。确认无误后追加 --apply')

  const file = snapshot(`move-${pl.id}`, { pid: pl.id, before: ids })
  info(`快照: ${dim(file)}`)

  must(await call('song_order_update', { pid: pl.id, ids: JSON.stringify(want) }), '调整曲目顺序')

  const after = (await fetchTracks(pl.id)).map((t) => t.id)
  if (after[to - 1] === id && after.length === ids.length) ok(`已移动到第 ${to} 位`)
  else warn(`服务端顺序与预期不一致，实际第 ${to} 位为 ${after[to - 1]}`)
}

export async function cmdMerge(refs, flags) {
  if (!refs.length) throw new Error('用法: pl merge <源歌单...> --into <目标歌单|new:名称>')
  const sources = []
  for (const ref of refs) {
    const pl = await resolvePlaylist(ref)
    const tracks = await fetchTracks(pl.id)
    sources.push({ pl, tracks })
  }

  const ids = []
  const seen = new Set()
  for (const s of sources) {
    for (const t of s.tracks) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      ids.push(t.id)
    }
  }
  const total = sources.reduce((a, s) => a + s.tracks.length, 0)

  console.log(`源歌单 ${sources.length} 个，合计 ${total} 首，去重后 ${ids.length} 首`)
  console.log(table(['源', 'ID', '曲目'], sources.map((s) => [s.pl.name, s.pl.id, s.tracks.length])))

  const into = flags.into
  if (!into) throw new Error('缺少 --into 目标歌单')

  const isNew = String(into).startsWith('new:')
  let targetId = null
  let toAdd = ids

  if (isNew) {
    console.log(`目标: 新建歌单「${String(into).slice(4)}」`)
  } else {
    const target = await resolvePlaylist(into)
    targetId = target.id
    const existing = new Set((await fetchTracks(target.id)).map((t) => t.id))
    toAdd = ids.filter((id) => !existing.has(id))
    console.log(`目标: ${bold(target.name)} (${target.id})，已有 ${existing.size} 首，需新增 ${toAdd.length} 首`)
  }

  if (!flags.apply) return warn('预演模式，未写入。确认无误后追加 --apply')

  if (isNew) {
    const body = must(await call('playlist_create', { name: String(into).slice(4) }), '创建歌单')
    targetId = body.id || body.playlist?.id
    info(`已创建目标歌单 id=${targetId}`)
  } else {
    const file = snapshot(`merge-${targetId}`, { pid: targetId, before: toAdd })
    info(`快照: ${dim(file)}`)
  }

  await applyTrackOp('add', targetId, toAdd)
  ok(`合并完成，写入 ${toAdd.length} 首到歌单 ${targetId}`)
}
