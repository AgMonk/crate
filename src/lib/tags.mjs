// FLAC 标签写入：直接改写元数据块，不重编码音频
//
// 只依赖 Node 内置能力：FLAC 的元数据块格式简单（4 字节头 + 负载），
// 自己解析/重组比引入 taglib 更可控，也能保证音频数据字节不动。
// 写入前会保留 STREAMINFO/SEEKTABLE/CUESHEET 等其余块，只替换 VORBIS_COMMENT 与 PICTURE。

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
 * 只读元数据块头，返回音频帧起始偏移。
 * 不把整文件读进内存——长曲动辄上百 MB，这里只需跳过块负载。
 */
export function audioOffsetOf(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    fs.readSync(fd, magic, 0, 4, 0)
    if (magic.toString('latin1') !== 'fLaC') throw new Error('不是 FLAC 文件')
    let off = 4
    for (;;) {
      const head = Buffer.alloc(4)
      fs.readSync(fd, head, 0, 4, off)
      const h = head.readUInt32BE(0)
      off += 4 + (h & 0xffffff)
      if (h >= 0x80000000) return off
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 写入标签。comments 为 {KEY: value}，picture 为封面图片的 Buffer（可空）。
 * 先写临时文件再原子替换，避免中断留下半截 FLAC。
 */
export function writeTags(file, { comments, picture }) {
  const buf = fs.readFileSync(file)
  const { blocks, audioOffset } = readBlocks(buf)

  const streaminfo = blocks.find((b) => b.type === BLOCK.STREAMINFO)
  if (!streaminfo) throw new Error('缺少 STREAMINFO 块')
  // 保留其余块（应用块/定位表/提示表等），丢弃旧的注释与封面
  const rest = blocks.filter((b) => b.type !== BLOCK.STREAMINFO && b.type !== BLOCK.VORBIS_COMMENT && b.type !== BLOCK.PICTURE)

  const out = [streaminfo, { type: BLOCK.VORBIS_COMMENT, data: buildComment(comments) }]
  if (picture) out.push({ type: BLOCK.PICTURE, data: buildPicture(picture) })
  out.push(...rest)

  const tmp = `${file}.cratetag`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, Buffer.from('fLaC', 'latin1'))
    for (const [i, b] of out.entries()) {
      const last = i === out.length - 1 ? 0x80000000 : 0
      const head = Buffer.alloc(4)
      head.writeUInt32BE(last + (b.type << 24) + b.data.length, 0)
      fs.writeSync(fd, head)
      fs.writeSync(fd, b.data)
    }
    for (let p = audioOffset; p < buf.length; p += COPY_CHUNK) {
      const end = Math.min(p + COPY_CHUNK, buf.length)
      fs.writeSync(fd, buf.subarray(p, end))
    }
  } finally {
    fs.closeSync(fd)
  }

  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    // Windows 下目标被其他进程持有句柄时 rename 会 EBUSY/EPERM，但原地写入仍可用
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
    fs.writeFileSync(file, fs.readFileSync(tmp))
    fs.rmSync(tmp, { force: true })
  }
  return { audioOffset, blocks: out.length }
}
