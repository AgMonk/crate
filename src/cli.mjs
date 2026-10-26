#!/usr/bin/env node
// 网易云音乐歌单 / 云盘批量操作 CLI
import { loadAuth, useAuth, setInterval as setRate, getNickname, getUid } from './lib/api.mjs'
import { qrLogin, requireLogin, fetchProfile } from './lib/auth.mjs'
import * as pl from './cmd/playlist.mjs'
import * as cloud from './cmd/cloud.mjs'
import { bold, dim, cyan, green, red, warn, info, ok, fail } from './lib/ui.mjs'

const BOOL_FLAGS = new Set(['apply', 'recursive', 'help', 'json', 'keep-order', 'not-in-playlist', 'repair'])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        if (BOOL_FLAGS.has(key)) flags[key] = true
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]
        else flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

const HELP = `
${bold('唱片箱 crate')} ${dim('· 网易云音乐 歌单 / 云盘 批量管理')}

${bold('登录')}
  login                            扫码登录（二维码输出到终端与 data/login-qr.png）
  status                           查看当前登录态

${bold('歌单')}
  pl list                          列出全部歌单
  pl show <歌单> [--limit 50]      查看歌单曲目
  pl export <歌单> [--format csv|json|m3u] [--out 路径]
  pl add <歌单> --tracks 1,2,3 [--file ids.txt] [--apply]
  pl remove <歌单> --tracks 1,2,3 [--apply]
  pl dedupe <歌单> [--by id|meta] [--apply]
  pl move <歌单> --id <歌曲id> --to <位置> [--apply]   单曲移到指定位置
  pl audit                         巡检各歌单中缺歌手/专辑的曲目
  pl merge <源歌单...> --into <目标|new:新名称> [--apply]
  pl create <名称> [--apply]
  pl delete <歌单> [--apply]       删除自建歌单（仅限自己创建的）

${bold('云盘')}
  cloud list [--limit n] [--match matched|unmatched] [--export out.csv]
  cloud upload <文件或目录...> [--recursive] [--playlist 歌单|new:名称] [--repair] [--apply]
  cloud verify <目录> [--apply]     校验云端内容与本地 md5 是否一致，--apply 自动修复
  cloud delete [--ids 1,2] [--name 关键词] [--artist 关键词] [--match 状态] [--apply]
  cloud delete --not-in-playlist [--apply]        删除未被任何歌单引用的云盘曲目
  cloud topl <歌单> --from-dir <目录> [--apply]   按目录文件顺序批量入歌单
  cloud topl <歌单> [--name 关键词] [--artist 关键词] [--limit n] [--apply]
  cloud match --sid <云盘songId> --asid <目标歌曲id> [--apply]
  cloud report [--out 路径.md]      生成云盘曲目 vs 歌单归属的 Markdown 报告

${bold('通用参数')}
  --apply      真正写入；缺省为预演（dry-run）
  --keep-order 添加曲目时保持给定顺序（服务端默认逆序插头部，已做补偿）
  --repair     上传后内容与本地不符时，自动删除重传再建歌单
  --interval   请求间隔毫秒，默认 500（约 2 req/s），风控时调大到 1000~2000
  <歌单> 可填歌单 ID 或名称（名称支持唯一子串匹配）

${dim('写操作前自动保存快照到 data/snapshot/，可按快照回滚。')}
`

async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)

  if (!positional.length || positional[0] === 'help' || flags.help) {
    console.log(HELP)
    return
  }

  if (flags.interval) setRate(Number(flags.interval))

  const [group, action, ...rest] = positional

  try {
    // ---------- 登录 ----------
    if (group === 'login') {
      const auth = await qrLogin({ refresh: 2 })
      if (!auth) process.exitCode = 1
      return
    }

    if (group === 'status') {
      const auth = loadAuth()
      if (!auth) return warn('未登录。执行: node src/cli.mjs login')
      useAuth(auth)
      const p = await fetchProfile()
      if (!p) return fail('登录态已失效，请重新 login')
      ok(`已登录: ${bold(p.nickname)}  uid=${p.uid}  登录时间 ${auth.loginAt || '-'}`)
      return
    }

    // 其余命令统一要求登录
    await requireLogin()

    // ---------- 歌单 ----------
    if (group === 'pl' || group === 'playlist') {
      switch (action) {
        case 'list':
        case 'ls':
          return await pl.cmdList()
        case 'show':
          return await pl.cmdShow(rest[0] || flags.pid, flags)
        case 'export':
          return await pl.cmdExport(rest[0] || flags.pid, flags)
        case 'add':
          return await pl.cmdAdd(rest[0] || flags.pid, flags)
        case 'remove':
        case 'rm':
          return await pl.cmdRemove(rest[0] || flags.pid, flags)
        case 'dedupe':
          return await pl.cmdDedupe(rest[0] || flags.pid, flags)
        case 'move':
          return await pl.cmdMove(rest[0] || flags.pid, flags)
        case 'audit':
          return await cloud.cmdAudit(flags)
        case 'merge':
          return await pl.cmdMerge(rest, flags)
        case 'delete':
        case 'del':
          return await pl.cmdDeletePlaylist(rest[0] || flags.pid, flags)
        case 'create':
          return await pl.cmdCreate(flags, rest)
        default:
          throw new Error(`未知歌单子命令: ${action}（可用: list/show/export/add/remove/dedupe/merge/create）`)
      }
    }

    // ---------- 云盘 ----------
    if (group === 'cloud') {
      switch (action) {
        case 'list':
        case 'ls':
          return await cloud.cmdList(flags)
        case 'upload':
        case 'up':
          return await cloud.cmdUpload(rest, flags)
        case 'delete':
        case 'rm':
          return await cloud.cmdDelete(flags)
        case 'topl':
          return await cloud.cmdToPlaylist(rest[0] || flags.pid, flags)
        case 'verify':
          return await cloud.cmdVerify(rest[0] || flags.dir, flags)
        case 'report':
          return await cloud.cmdReport(flags)
        case 'match':
          return await cloud.cmdMatch(flags)
        default:
          throw new Error(`未知云盘子命令: ${action}（可用: list/upload/delete/topl/match）`)
      }
    }

    throw new Error(`未知命令组: ${group}。执行 node src/cli.mjs help 查看用法`)
  } catch (e) {
    console.log()
    fail(e.message)
    process.exitCode = 1
  }
}

main()
