// 终端输出工具：CJK 宽度感知的表格 + ANSI 着色 + 人类可读的容量/时长
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : String(s))

export const bold = paint('1')
export const dim = paint('2')
export const red = paint('31')
export const green = paint('32')
export const yellow = paint('33')
export const cyan = paint('36')
export const magenta = paint('35')

const ANSI_RE = /\u001b\[[0-9;]*m/g

// 全角字符占 2 列，制表前必须按显示宽度而非字符数计算
function charWidth(cp) {
  if (cp < 0x1100) return 1
  return cp <= 0x115f ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1
}

export function strWidth(s) {
  const plain = String(s).replace(ANSI_RE, '')
  let w = 0
  for (const ch of plain) w += charWidth(ch.codePointAt(0))
  return w
}

function pad(s, target, align) {
  const gap = target - strWidth(s)
  if (gap <= 0) return s
  const left = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
  return ' '.repeat(left) + s + ' '.repeat(gap - left)
}

/**
 * 渲染 ASCII 表格
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {{align?: ('left'|'right'|'center')[], maxCol?: number}} [opts]
 */
export function table(headers, rows, opts = {}) {
  const align = opts.align || headers.map(() => 'left')
  const body = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))))
  const widths = headers.map((h, i) =>
    Math.max(strWidth(h), ...body.map((r) => strWidth(r[i] ?? ''))),
  )
  const line = (cells) =>
    cells.map((c, i) => pad(c, widths[i], align[i])).join(dim(' │ ')).trimEnd()

  const out = [line(headers.map(bold))]
  out.push(widths.map((w) => dim('─'.repeat(w))).join(dim('─┼─')))
  for (const r of body) out.push(line(r))
  return out.join('\n')
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

export function fmtDuration(ms) {
  if (!ms) return '-'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const ok = (m) => console.log(`${green('✔')} ${m}`)
export const info = (m) => console.log(`${cyan('·')} ${m}`)
export const warn = (m) => console.log(`${yellow('!')} ${m}`)
export const fail = (m) => console.log(`${red('✘')} ${m}`)

/** 单行进度：\r 覆盖，不刷屏 */
export function progress(cur, total, label = '') {
  if (!process.stdout.isTTY) return
  const pct = total ? Math.floor((cur / total) * 100) : 0
  const width = 24
  const filled = Math.round((pct / 100) * width)
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
  process.stdout.write(`\r  ${bar} ${String(pct).padStart(3)}%  ${cur}/${total} ${label}`)
  if (cur >= total) process.stdout.write('\n')
}
