// 标签写入：FLAC 走 VORBIS_COMMENT/PICTURE，MP3 走 ID3v2.4
//
// 只依赖 Node 内置能力：两种容器的标签区结构都简单，自己解析/重组比引入 taglib 更可控，
// 也能保证音频数据字节不动。FLAC 保留 STREAMINFO/SEEKTABLE/CUESHEET 等其余块，
// 只替换注释与封面；MP3 剥掉旧的 ID3v2/ID3v1 后重写。

import fs from 'node:fs'

const BLOCK = { STREAMINFO: 0, PADDING: 1, APPLICATION: 2, SEEKTABLE: 3, VORBIS_COMMENT: 4, CUESHEET: 5, PICTURE: 6 }
const VENDOR = 'crate'
const COPY_CHUNK = 4 * 1024 * 1024

/** 读取元数据块；返回块列表与音频帧起始偏移 */
export function readBlocks(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'fLaC') throw new Error('不是 FLAC 文件')
  const blocks = []
  let off = 4
  for (;;) {
    if (off + 4 > buf.length) throw new Error('元数据块越界')
    const head = buf.readUInt32BE(off)
    const last = head >= 0x80000000
    const type = (head >>> 24) & 0x7f
    const len = head & 0xffffff
    if (off + 4 + len > buf.length) throw new Error('元数据块长度越界')
    blocks.push({ type, data: buf.subarray(off + 4, off + 4 + len) })
    off += 4 + len
    if (last) break
  }
  return { blocks, audioOffset: off }
}

/** VORBIS_COMMENT 负载：厂商串 + 若干 KEY=value（UTF-8） */
export function buildComment(fields) {
  const entries = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${String(k).toUpperCase()}=${String(v)}`)

  const comments = entries.map((e) => Buffer.from(e, 'utf8'))
  const vendor = Buffer.from(VENDOR, 'utf8')
  const head = Buffer.alloc(4)
  const count = Buffer.alloc(4)
  head.writeUInt32LE(vendor.length, 0)
  count.writeUInt32LE(comments.length, 0)

  const parts = [head, vendor, count]
  for (const c of comments) {
    const l = Buffer.alloc(4)
    l.writeUInt32LE(c.length, 0)
    parts.push(l, c)
  }
  return Buffer.concat(parts)
}

/** 从 JPEG 的 SOF 段读宽高；失败返回 0（规范允许宽高为 0） */
export function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return { width: 0, height: 0 }
}

/**
 * 按魔数识别图片格式与尺寸。
 * 站点声明的 content-type 不可信：实测封面接口标 image/jpg，实际返回 PNG。
 */
export function detectImage(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { mime: 'image/jpeg', ...jpegSize(buf) }
  }
  return { mime: 'image/jpeg', width: 0, height: 0 }
}

/** PICTURE 负载；type 3 = 封面正面。字段顺序严格按 FLAC 规范：type/mime/desc/宽高深色/dataLen */
export function buildPicture(data) {
  const { mime, width, height } = detectImage(data)
  const mimeBuf = Buffer.from(mime, 'ascii')

  const head = Buffer.alloc(8)
  head.writeUInt32BE(3, 0) // picture type: front cover
  head.writeUInt32BE(mimeBuf.length, 4)

  const desc = Buffer.alloc(4) // 描述串长度 = 0

  const dims = Buffer.alloc(16)
  dims.writeUInt32BE(width, 0)
  dims.writeUInt32BE(height, 4)
  dims.writeUInt32BE(24, 8) // 位深
  dims.writeUInt32BE(0, 12) // 调色板数量（非索引色为 0）

  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(data.length, 0)

  return Buffer.concat([head, mimeBuf, desc, dims, tail, data])
}

/**
 * 音频帧的字节数（不含标签区）。用于码率校验：
 * 写标签后文件里多了注释与封面，拿总字节反推码率会误判。
 * 只读文件头尾，不把整文件读进内存。
 */
export function audioBytesOf(file) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(10)
    const n = fs.readSync(fd, head, 0, 10, 0)

    // FLAC：跳过全部元数据块
    if (n >= 4 && head.toString('latin1', 0, 4) === 'fLaC') {
      let off = 4
      for (;;) {
        const b = Buffer.alloc(4)
        fs.readSync(fd, b, 0, 4, off)
        const h = b.readUInt32BE(0)
        off += 4 + (h & 0xffffff)
        if (h >= 0x80000000) break
      }
      return size - off
    }

    // MP3：扣掉头部 ID3v2 与尾部 ID3v1
    if (n >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
      const tagSize = 10
        + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f))
        + ((head[5] & 0x10) ? 10 : 0)
      let tail = 0
      if (size > 128) {
        const t = Buffer.alloc(3)
        fs.readSync(fd, t, 0, 3, size - 128)
        if (t.toString('latin1') === 'TAG') tail = 128
      }
      return size - tagSize - tail
    }

    return size
  } finally {
    fs.closeSync(fd)
  }
}

/** ID3 的 size 字段每字节只用低 7 位（syncsafe） */
function syncsafe(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}

/** 已有 ID3v2 标签的总字节数（10 字节头 + 正文 + 可选 footer） */
function id3Size(buf) {
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  return 10 + size + ((buf[5] & 0x10) ? 10 : 0)
}

function id3Frame(id, body) {
  return Buffer.concat([Buffer.from(id, 'ascii'), syncsafe(body.length), Buffer.from([0, 0]), body])
}

function id3Text(id, value) {
  return id3Frame(id, Buffer.concat([Buffer.from([0x03]), Buffer.from(String(value), 'utf8')]))
}

function id3Apic(data) {
  const { mime } = detectImage(data)
  const body = Buffer.concat([
    Buffer.from([0x03]), // 编码：UTF-8
    Buffer.from(mime, 'ascii'), Buffer.from([0]),
    Buffer.from([3]), // 图片类型：封面正面
    Buffer.alloc(0), Buffer.from([0]), // 空描述
    data,
  ])
  return id3Frame('APIC', body)
}

/** ID3v2.4 标签块：文本帧 UTF-8，帧长度按 syncsafe 编码 */
export function buildId3(comments, picture) {
  const g = (k) => (comments[k] === undefined || comments[k] === null ? '' : String(comments[k]).trim())
  const track = [g('TRACKNUMBER'), g('TRACKTOTAL')].filter(Boolean).join('/')
  const disc = [g('DISCNUMBER'), g('DISCTOTAL')].filter(Boolean).join('/')
  const map = [
    ['TIT2', g('TITLE')],
    ['TPE1', g('ARTIST')],
    ['TALB', g('ALBUM')],
    ['TPE2', g('ALBUMARTIST')],
    ['TRCK', track],
    ['TPOS', disc],
    ['TDRC', g('DATE')],
    ['TCON', g('GENRE')],
    ['TCOM', g('COMPOSER')],
  ]
  const frames = map.filter(([, v]) => v).map(([id, v]) => id3Text(id, v))
  if (picture) frames.push(id3Apic(picture))
  const body = Buffer.concat(frames)
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x04, 0x00, 0x00]), syncsafe(body.length), body])
}

/** 去掉文件头已有的 ID3v2 与文件尾的 ID3v1，避免新旧两套标签并存 */
function stripId3(buf) {
  let start = 0
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') start = Math.min(id3Size(buf), buf.length)
  let end = buf.length
  if (end - start > 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128
  return buf.subarray(start, end)
}

/** 原子落盘：先写临时文件再改名；目标被占用（Windows EBUSY）时退回原地重写 */
function writeAtomic(file, parts) {
  const tmp = `${file}.cratetag`
  const fd = fs.openSync(tmp, 'w')
  try {
    for (const p of parts) fs.writeSync(fd, p)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
    fs.writeFileSync(file, fs.readFileSync(tmp))
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * 写入标签。comments 为 {KEY: value}，picture 为封面图片的 Buffer（可空）。
 * FLAC 写 VORBIS_COMMENT + PICTURE；MP3 写 ID3v2.4（文本帧 + APIC）。
 * 两条路径都只重组标签区，音频字节原样保留。
 */
export function writeTags(file, { comments, picture }) {
  const buf = fs.readFileSync(file)
  const magic = buf.toString('latin1', 0, 4)

  if (magic === 'fLaC') {
    const { blocks, audioOffset } = readBlocks(buf)

    const streaminfo = blocks.find((b) => b.type === BLOCK.STREAMINFO)
    if (!streaminfo) throw new Error('缺少 STREAMINFO 块')
    // 保留其余块（应用块/定位表/提示表等），丢弃旧的注释与封面
    const rest = blocks.filter((b) => b.type !== BLOCK.STREAMINFO && b.type !== BLOCK.VORBIS_COMMENT && b.type !== BLOCK.PICTURE)

    const out = [streaminfo, { type: BLOCK.VORBIS_COMMENT, data: buildComment(comments) }]
    if (picture) out.push({ type: BLOCK.PICTURE, data: buildPicture(picture) })
    out.push(...rest)

    const parts = [Buffer.from('fLaC', 'latin1')]
    for (const [i, b] of out.entries()) {
      const last = i === out.length - 1 ? 0x80000000 : 0
      const head = Buffer.alloc(4)
      head.writeUInt32BE(last + (b.type << 24) + b.data.length, 0)
      parts.push(head, b.data)
    }
    // 音频帧按块写出，避免把上百 MB 的整段再复制一份
    for (let p = audioOffset; p < buf.length; p += COPY_CHUNK) {
      parts.push(buf.subarray(p, Math.min(p + COPY_CHUNK, buf.length)))
    }

    writeAtomic(file, parts)
    return { container: 'flac', audioOffset, blocks: out.length }
  }

  if (magic.slice(0, 3) === 'ID3' || /\.mp3$/i.test(file)) {
    writeAtomic(file, [buildId3(comments, picture), stripId3(buf)])
    return { container: 'mp3' }
  }

  throw new Error(`不支持的容器：${file}（仅 FLAC / MP3）`)
}
