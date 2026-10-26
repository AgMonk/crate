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

const QR_STATE = {
  800: '二维码已过期',
  801: '等待扫码',
  802: '已扫码，等待手机端确认',
  803: '授权成功',
}

/** 校验当前 cookie 是否有效，返回用户档案 */
export async function fetchProfile() {
  const body = await call('user_account', {}, { retry: 0 })
  if (body?.code !== 200) return null
  const profile = body.profile || {}
  return {
    uid: profile.userId || body.account?.id || 0,
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
        const cookie = typeof res.cookie === 'string' ? res.cookie : (res.cookie || []).join(';')
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
  return {
    uid: body.profile?.userId || body.account?.id || 0,
    nickname: body.profile?.nickname || '',
    vipType: body.profile?.vipType ?? 0,
  }
}
