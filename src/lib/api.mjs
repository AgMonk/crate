// 网易云 API 调用层：登录态注入 + 全局限速 + 分层重试 + 风控熔断
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CONFIG_DIR = path.join(ROOT, 'config')
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json')
export const SNAP_DIR = path.join(ROOT, 'data', 'snapshot')
export const EXPORT_DIR = path.join(ROOT, 'data', 'export')
export const QR_FILE = path.join(ROOT, 'data', 'login-qr.png')

const DEFAULT_INTERVAL = Number(process.env.NCM_INTERVAL_MS || 500) // 默认 2 req/s

const state = {
  cookie: '',
  uid: 0,
  nickname: '',
  interval: DEFAULT_INTERVAL,
}

let apiPromise = null

/** 懒加载 API 库；dotenv 横幅会污染 CLI 输出，先置静默标记 */
export function api() {
  if (!apiPromise) {
    process.env.DOTENV_CONFIG_QUIET = 'true'
    apiPromise = import('@neteasecloudmusicapienhanced/api').then((m) => m.default)
  }
  return apiPromise
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    return auth?.cookie ? auth : null
  } catch {
    return null
  }
}

export function saveAuth(auth) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8')
  Object.assign(state, auth)
}

export function useAuth(auth) {
  if (auth) Object.assign(state, auth)
  return state
}

export const getUid = () => state.uid
export const getNickname = () => state.nickname
export const getInterval = () => state.interval
export const setInterval = (ms) => {
  state.interval = Math.max(50, Number(ms) || DEFAULT_INTERVAL)
}

let lastCallAt = 0

async function throttle() {
  const wait = state.interval - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

const RETRYABLE = new Set([405, 500, 502, 503])

/**
 * 该库响应包装不一致：多数模块返回 {code,...}，
 * 少数（如 playlist_tracks）把 request 结果整体再包一层 {status, body:{status, body, cookie}}。
 * 统一解包到真正承载 code 的那一层。
 */
function unwrap(res) {
  let body = res?.body ?? res
  for (let i = 0; i < 3; i++) {
    if (body && typeof body === 'object' && body.code === undefined && body.body && typeof body.body === 'object') {
      body = body.body
    } else break
  }
  return body
}

/**
 * 调用一个 API 模块
 * @returns {Promise<any>} body（可能非 200，交由调用方判定）
 */
export async function call(name, params = {}, opts = {}) {
  const lib = await api()
  const fn = lib[name]
  if (typeof fn !== 'function') throw new Error(`接口不存在: ${name}`)

  const cookie = params.cookie !== undefined ? params.cookie : state.cookie
  const maxRetry = opts.retry ?? 2
  let attempt = 0

  for (;;) {
    await throttle()
    let body
    try {
      const res = await fn({ ...params, cookie })
      body = unwrap(res)
    } catch (err) {
      // 模块常以 Promise.reject({status, body}) 抛业务错误，需解包后交调用方判断
      const eb = unwrap(err)
      if (eb?.code && eb.code !== 200 && !RETRYABLE.has(eb.code)) return eb
      if (attempt++ >= maxRetry) {
        const detail = eb?.msg || eb?.message || err?.message || JSON.stringify(err)
        throw new Error(`${name} 请求失败: ${detail}`)
      }
      await sleep(1200 * attempt)
      continue
    }

    const code = body?.code
    if (code === 200) return body
    if (RETRYABLE.has(code) && attempt++ < maxRetry) {
      await sleep(2000 * attempt)
      continue
    }
    if (code === -460) {
      throw new Error(`触发风控(-460)，已中止。请降低频率（--interval 1000）或稍后再试`)
    }
    if (code === 301) {
      throw new Error(`登录态失效，请重新执行: node src/cli.mjs login`)
    }
    return body
  }
}

/** 断言业务成功，失败即抛错中断（不在写入链路上继续） */
export function must(body, context) {
  if (body?.code !== 200) {
    const msg = body?.msg || body?.message || body?.data?.msg || '未知错误'
    throw new Error(`${context} 失败 [code=${body?.code ?? 'null'}] ${msg}`)
  }
  return body
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
