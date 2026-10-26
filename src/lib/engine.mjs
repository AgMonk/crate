// 下载引擎：Aria2 JSON-RPC 与内置 HTTP 下载器，共用 submit/finish 接口
//
// Aria2 只是加速项，不是前提。auto 模式先探测 RPC，探不到就降级到内置下载器，
// 保证「装没装 Aria2 都能下」。
//
// 接口刻意做成「取到一条直链就提交一条」：站点直链带时效，先抓完全部再提交
// 会让最早那几条在排队时过期，而且首字节要等所有取链完成才出现。
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const DEFAULT_RPC = 'http://localhost:6800/jsonrpc'

async function jsonRpc(url, method, params, { secret = '', timeout = 15000 } = {}) {
  const body = {
    jsonrpc: '2.0',
    id: String(Date.now()),
    method,
    params: secret ? [`token:${secret}`, ...params] : params,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`Aria2 RPC HTTP ${res.status}`)
  const out = await res.json().catch(() => null)
  if (out?.error) throw new Error(out.error.message || JSON.stringify(out.error))
  return out?.result
}

// ---------------------------------------------------------------- Aria2

export class Aria2Engine {
  constructor({ rpc = DEFAULT_RPC, secret = '' } = {}) {
    this.kind = 'aria2'
    this.rpc = rpc
    this.secret = secret
    this.submitted = []
  }

  call(method, params, opts) {
    return jsonRpc(this.rpc, method, params, { secret: this.secret, ...opts })
  }

  async ping() {
    try {
      const v = await this.call('aria2.getVersion', [], { timeout: 2500 })
      return { ok: true, version: v?.version || '?' }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }

  async globalDir() {
    try {
      const opt = await this.call('aria2.getGlobalOption', [], { timeout: 4000 })
      return opt?.dir || ''
    } catch {
      return ''
    }
  }

  /**
   * continue 必须显式关掉：否则会把新文件续传拼到同名旧文件后面，得到码率爆表的怪文件。
   * auto-file-renaming 也要关，否则同名时 aria2 会偷偷改成 xxx.1.flac。
   * CDN 偶发 SSL 重置，交给 aria2 自己重试，比整批重跑省事。
   */
  async submit(task) {
    const options = {
      dir: task.dir,
      out: task.out,
      'allow-overwrite': 'true',
      continue: 'false',
      'auto-file-renaming': 'false',
      'max-tries': '5',
      'retry-wait': '3',
    }
    const gid = await this.call('aria2.addUri', [[task.url], options])
    this.submitted.push({ ...task, gid })
    return gid
  }

  /** 轮询到全部任务落到终态；单次 multicall 拿全部 gid，避免 N 倍 RPC */
  async finish({ onProgress, pollMs = 900, deadlineMs = 60 * 60 * 1000 } = {}) {
    const all = this.submitted
    if (!all.length) return { kind: this.kind, submitted: all, completed: [], failed: [] }
    const gids = all.map((q) => q.gid)
    const settled = new Map()
    const startedAt = Date.now()
    let emptyTicks = 0

    // aria2 的已完成记录会被 --max-download-result 挤掉，随后 tellStatus 直接报 not found。
    // 这类 gid 不能算失败，也不能无限等——磁盘上「有文件且无 .aria2 控制文件」才是真正下完。
    const onDisk = (q) => {
      const dest = path.join(q.dir, q.out)
      return fs.existsSync(dest) && !fs.existsSync(`${dest}.aria2`)
    }

    for (;;) {
      let stats = []
      try {
        const res = await this.call(
          'system.multicall',
          [gids.map((gid) => ({
            methodName: 'aria2.tellStatus',
            params: [gid, ['gid', 'status', 'completedLength', 'totalLength', 'errorMessage']],
          }))],
          { timeout: 12000 },
        )
        stats = (res || [])
          .map((r) => (Array.isArray(r) ? r[0] : r))
          .filter((s) => s && typeof s === 'object' && s.gid)
      } catch {
        // RPC 抖动不致命，下一轮再试
      }

      if (!stats.length) emptyTicks++
      else emptyTicks = 0

      for (const s of stats) {
        if (s.status === 'complete' || s.status === 'error' || s.status === 'removed') settled.set(s.gid, s)
      }
      for (const q of all) {
        if (!settled.has(q.gid) && onDisk(q)) settled.set(q.gid, { gid: q.gid, status: 'complete', fromDisk: true })
      }

      const finished = gids.filter((g) => settled.has(g)).length
      onProgress?.({
        finished,
        total: gids.length,
        bytes: stats.reduce((a, s) => a + Number(s.completedLength || 0), 0),
        totalBytes: stats.reduce((a, s) => a + Number(s.totalLength || 0), 0),
      })

      if (finished >= gids.length) break
      // 任务被清出队列（purge）后 tellStatus 会查不到，连续多轮空结果就收手
      if (emptyTicks >= 8) break
      if (Date.now() - startedAt > deadlineMs) break
      await sleep(pollMs)
    }

    const completed = []
    const failed = []
    for (const q of all) {
      const s = settled.get(q.gid)
      if (s?.status === 'complete') completed.push(q)
      else if (s?.status === 'error' || s?.status === 'removed') failed.push({ ...q, error: s.errorMessage || s.status })
      else failed.push({ ...q, error: '未确认完成（RPC 查不到该任务，磁盘上也没有完整文件）' })
    }
    return { kind: this.kind, submitted: all, completed, failed }
  }
}

// ---------------------------------------------------------------- 内置下载器

export class NativeEngine {
  constructor({ concurrency = 3, retries = 3 } = {}) {
    this.kind = 'native'
    this.concurrency = Math.max(1, Number(concurrency) || 3)
    this.retries = Math.max(0, Number(retries) || 0)
    this.queue = []
    this.submitted = []
    this.completed = []
    this.failed = []
    this.running = 0
    this.onProgress = null
    this.idleWaiters = []
  }

  async ping() {
    return { ok: true, version: 'builtin' }
  }

  async globalDir() {
    return ''
  }

  /** 入队即开跑：worker 池一有空位就启动，不会等全部直链取完 */
  async submit(task) {
    this.submitted.push(task)
    this.queue.push(task)
    this.#pump()
    return task.out
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const task = this.queue.shift()
      this.running++
      this.#one(task)
        .then((r) => this.completed.push({ ...task, ...r }))
        .catch((err) => this.failed.push({ ...task, error: err.message }))
        .finally(() => {
          this.running--
          this.onProgress?.({
            finished: this.completed.length + this.failed.length,
            total: this.submitted.length,
            bytes: 0,
            totalBytes: 0,
          })
          this.#pump()
          this.#checkIdle()
        })
    }
    this.#checkIdle()
  }

  #checkIdle() {
    if (this.running || this.queue.length) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  async finish({ onProgress } = {}) {
    this.onProgress = onProgress
    if (this.running || this.queue.length) await new Promise((r) => this.idleWaiters.push(r))
    return { kind: this.kind, submitted: this.submitted, completed: this.completed, failed: this.failed }
  }

  async #one(task) {
    const dest = path.join(task.dir, task.out)
    fs.mkdirSync(task.dir, { recursive: true })
    const part = `${dest}.part`
    let lastErr

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        fs.rmSync(part, { force: true })
        const res = await fetch(task.url, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(10 * 60 * 1000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const expect = Number(res.headers.get('content-length')) || 0
        let got = 0
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            got += chunk.length
            cb(null, chunk)
          },
        })
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part))
        if (expect && got !== expect) throw new Error(`大小不符 ${got}/${expect}`)
        fs.renameSync(part, dest)
        return { size: got }
      } catch (err) {
        lastErr = err
        fs.rmSync(part, { force: true })
        if (attempt < this.retries) await sleep(1500 * (attempt + 1))
      }
    }
    throw new Error(lastErr?.message || '下载失败')
  }
}

/**
 * 按 engine 选择实现。
 * auto  ：探测 Aria2，可用则用，不可用降级内置（默认）
 * aria2 ：强制 Aria2，探不到直接报错
 * native：强制内置下载器
 */
export async function createEngine({ engine = 'auto', rpc = DEFAULT_RPC, secret = '', concurrency = 3, retries = 3 } = {}) {
  const mode = String(engine || 'auto').toLowerCase()
  const aria2 = new Aria2Engine({ rpc, secret })

  if (mode === 'native') {
    return { engine: new NativeEngine({ concurrency, retries }), note: '内置 HTTP 下载器' }
  }

  const probe = await aria2.ping()
  if (probe.ok) return { engine: aria2, note: `Aria2 ${probe.version} @ ${rpc}` }

  if (mode === 'aria2') {
    throw new Error(`Aria2 RPC 不可用（${rpc}）：${probe.reason}。改用 --engine auto 可自动降级到内置下载器`)
  }
  return {
    engine: new NativeEngine({ concurrency, retries }),
    note: `Aria2 不可用（${probe.reason}），已降级为内置下载器`,
  }
}
