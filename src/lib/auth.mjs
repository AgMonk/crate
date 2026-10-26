// 登录：扫码为主路径，登录态落盘复用；附带登录态校验
import QRCode from 'qrcode'
import qrTerminal from 'qrcode-terminal'
import {
  call,
  loadAuth,
  saveAuth,
  useAuth,
  QR_FILE,
  ensureDir,
} from './api.mjs'
import { info, ok, warn, fail, dim, cyan } from './ui.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Set-Cookie 的属性名，不属于 cookie 本身，拼进请求头会污染整个 Cookie 字段 */
const COOKIE_ATTR = new Set([
  'max-age', 'expires', 'path', 'domain', 'httponly', 'secure', 'samesite', 'priority', 'version', 'comment',
])

/**
 * 归一化登录返回的 cookie。
 * 该接口的 `cookie` 可能是「完整 Set-Cookie 字符串」数组（`MUSIC_U=xxx; Path=/; Max-Age=...`），
 * 直接 join 会把 Path/Expires 等属性当成 cookie 键值发出去；此处只保留 name=value。
 */
function normalizeCookie(raw) {
  const pieces = Array.isArray(raw) ? raw : String(raw ?? '').split(';')
  const pairs = new Map()
  for (const item of pieces) {
    const head = String(item).split(';')[0].trim() // 丢弃单条内的 Path/Expires 等后缀
    const eq = head.indexOf('=')
    if (eq < 1) continue
    const name = head.slice(0, eq).trim()
    const value = head.slice(eq + 1).trim()
    if (!name || COOKIE_ATTR.has(name.toLowerCase())) continue
    if (!value) continue // Max-Age=0 的清除指令，值为空，写入反而覆盖有效值
    pairs.set(name, value)
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ')
}

const QR_STATE = {
  800: '二维码已过期',
  801: '等待扫码',
  802: '已扫码，等待手机端确认',
  803: '授权成功',
}

/** 校验当前 cookie 是否有效，返回用户档案；匿名态 code 仍为 200 但 profile 为空，须按 uid 判定 */
export async function fetchProfile() {
  const body = await call('user_account', {}, { retry: 0 })
  if (body?.code !== 200) return null
  const profile = body.profile || {}
  const uid = profile.userId || body.account?.id || 0
  if (!uid) return null
  return {
    uid,
    nickname: profile.nickname || '',
    vipType: profile.vipType ?? 0,
  }
}

/** 确保已有可用登录态，否则抛错并给出修复指令 */
export async function requireLogin() {
  const auth = loadAuth()
  if (!auth) {
    throw new Error('未登录。请先执行: node src/cli.mjs login')
  }
  useAuth(auth)
  const profile = await fetchProfile()
  if (!profile?.uid) {
    throw new Error('登录态已失效。请重新执行: node src/cli.mjs login')
  }
  // 昵称/uid 可能随时间变化，回写一次
  const merged = { ...auth, uid: profile.uid, nickname: profile.nickname }
  if (merged.uid !== auth.uid || merged.nickname !== auth.nickname) saveAuth(merged)
  return { ...auth, ...profile }
}

/**
 * 扫码登录。轮询期间持续输出状态；成功后落盘 cookie。
 * @param {{refresh?: number}} [opts] 二维码过期后自动重试次数
 */
export async function qrLogin(opts = {}) {
  const maxRefresh = opts.refresh ?? 2

  for (let round = 0; round <= maxRefresh; round++) {
    const keyBody = await call('login_qr_key', {})
    const key = keyBody?.data?.unikey
    if (!key) throw new Error('获取二维码 key 失败')

    const qrBody = await call('login_qr_create', { key, qrimg: true }, { retry: 1 })
    const qrUrl = qrBody?.data?.qrurl
    if (!qrUrl) throw new Error('获取二维码内容失败')

    ensureDir(QR_FILE.replace(/[\\/][^\\/]+$/, ''))
    await QRCode.toFile(QR_FILE, qrUrl, { width: 420, margin: 1 })
    qrTerminal.generate(qrUrl, { small: true })
    console.log()
    info(`二维码已保存: ${cyan(QR_FILE)}`)
    info(`或浏览器打开链接扫码: ${dim(qrUrl)}`)
    console.log()

    let lastCode = -1
    const deadline = Date.now() + 3 * 60 * 1000

    while (Date.now() < deadline) {
      const res = await call('login_qr_check', { key }, { retry: 1 })
      const code = res?.code
      if (code !== lastCode) {
        if (code === 801) info('等待扫码…')
        if (code === 802) info('已扫码，请在手机上点击确认')
        if (code === 800) warn('二维码已过期')
        lastCode = code
      }

      if (code === 803) {
        const cookie = normalizeCookie(res.cookie)
        if (!cookie || !cookie.includes('MUSIC_U')) {
          throw new Error('登录返回的 cookie 不含 MUSIC_U，可能被风控拦截')
        }
        const profile = await fetchProfileWith(cookie)
        const auth = {
          cookie,
          uid: profile?.uid || 0,
          nickname: profile?.nickname || '',
          vipType: profile?.vipType ?? 0,
          loginAt: new Date().toISOString(),
        }
        saveAuth(auth)
        ok(`登录成功: ${auth.nickname || '(未知昵称)'}  uid=${auth.uid}`)
        return auth
      }

      if (code === 800) break
      await sleep(1500)
    }

    if (round < maxRefresh) {
      warn(`二维码失效，正在刷新（${round + 1}/${maxRefresh}）…`)
    } else {
      fail('登录超时，请重新执行 login')
      return null
    }
  }
  return null
}

async function fetchProfileWith(cookie) {
  const body = await call('user_account', { cookie }, { retry: 1 })
  if (body?.code !== 200) return null
  const uid = body.profile?.userId || body.account?.id || 0
  if (!uid) return null
  return {
    uid,
    nickname: body.profile?.nickname || '',
    vipType: body.profile?.vipType ?? 0,
  }
}
