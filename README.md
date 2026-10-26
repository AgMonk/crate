# 唱片箱 crate

> 网易云音乐歌单 / 云盘批量管理 CLI —— 整理歌单、导入导出、云盘批量上传与校验、按目录顺序归档成歌单、巡检未匹配曲目。

名字取自 DJ 的唱片箱：把散落的唱片挑出来、排好序、收进同一个箱子。

非官方工具，基于社区逆向接口实现，**仅限个人自用**。请先阅读文末[免责声明](#免责声明)。

---

## 目录

- [它能做什么](#它能做什么)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [登录](#登录)
- [命令参考](#命令参考)
- [典型场景](#典型场景)
- [设计说明：实测踩到的六个坑](#设计说明实测踩到的六个坑)
- [匹配与元数据：三种状态](#匹配与元数据三种状态)
- [数据与安全](#数据与安全)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [免责声明](#免责声明)
- [致谢与参考项目](#致谢与参考项目)
- [License](#license)

---

## 它能做什么

**歌单**

- 列出全部歌单（区分自建/收藏），查看曲目、导出 CSV / JSON / M3U
- 批量增删曲目，自动跳过歌单内已存在的曲目
- 去重（按歌曲 ID 或 标题+歌手），删除后回读校验残留
- 合并多个歌单到指定歌单或新建歌单
- 单曲移动到指定位置（`pl move`，不重建歌单）
- **巡检未匹配曲目**（`pl audit`），按 `matchType` 精确定位，不误伤版权下架曲目
- 新建、删除自建歌单

**云盘**

- 全量列表，按匹配状态 / 名称 / 歌手筛选，导出 CSV
- 批量上传本地音频，支持多级目录递归，自动建立 MD5 索引实现幂等（重跑不会产生副本）
- **上传后完整性校验**：本地 MD5 与云端 `privateCloud.md5` 逐条对账，异常条目可一键删除重传
- 批量删除，支持「删除未被任何歌单引用的曲目」
- 云盘歌曲纠错（把自动匹配错的曲目指回正确版本）
- 云盘 → 歌单：按目录文件顺序批量写入，多级目录保持层级顺序

**下载**

- 从第三方无损聚合站（flac.music.hi.cn）整张专辑 / 单曲批量拉取，FLAC 优先
- **Aria2 可选**：探测到 JSON-RPC 就用它提交，探不到自动降级到内置 HTTP 下载器——不必为了用这个工具先装 Aria2
- 专辑一次解析全部曲目（站点专辑接口直接给出曲目与一次性签名），文件名 `<轨号> - <曲名>.flac`
- **下完即写标签**：曲名 / 艺人 / 专辑 / 音轨号 / 年份 / 作曲 + 内嵌封面，只重排元数据块，音频字节不动
- 下载后校验时长与码率，能识别 TV-size、拼接残缺、非 FLAC 容器

**通用**

- 扫码登录，登录态本地保存，不落密码
- **所有写操作默认预演**，必须加 `--apply` 才落库
- 写操作前自动快照到 `data/snapshot/`，出问题可回溯
- 全局限速（默认约 2 req/s）与风控熔断（命中 `-460` 立即中止而非盲目重试）

## 工作原理

本仓库**不重复实现网易云的加密与协议层**。`weapi` / `eapi` 加密、云盘上传的对象存储交互等，全部委托给社区维护的
[`@neteasecloudmusicapienhanced/api`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。

本仓库只做**编排层**，价值在于：

1. 把「上传 → 校验 → 自愈 → 建歌单 → 保序写入」串成一条可靠流水线；
2. 处理该协议层里若干反直觉的行为（见[设计说明](#设计说明实测踩到的六个坑)）；
3. 把「云盘曲目到底有没有匹配到版权曲目」这件极易判错的事讲清楚（见[匹配与元数据](#匹配与元数据三种状态)）；
4. 给所有破坏性操作加上预演、快照、限速与熔断。

文中所有结论均在真实账号上验证（49 个歌单、843 首云盘曲目），不是照搬接口文档。

## 环境要求

- **Node.js >= 18**（开发与验证环境为 Node 22）
- 无需部署任何服务端，所有请求在本地发起
- **Aria2 为可选项**：已开 JSON-RPC（默认 `http://localhost:6800/jsonrpc`）时并行下载更快；没装也能用内置下载器，`--engine auto` 会自动选

## 安装

```bash
git clone <本仓库地址>
cd <本仓库目录>
npm install
node src/cli.mjs help
```

也可注册为全局命令（可选）：

```bash
npm link
crate help
```

下文示例统一使用 `node src/cli.mjs`，若已 `npm link`，可直接替换为 `crate`（同时保留了 `ncm` 别名）。

## 登录

```bash
node src/cli.mjs login
```

终端会打印二维码，同时保存一份到 `data/login-qr.png`。用网易云音乐 App 扫码并在手机上确认即可。

- 登录态写入 `config/auth.json`（内含 `MUSIC_U`），该文件已在 `.gitignore` 中排除
- 登录态通常可维持数周，失效后重新执行 `login`
- 校验当前状态：`node src/cli.mjs status`

## 命令参考

### 通用参数

| 参数 | 说明 |
| --- | --- |
| `--apply` | 真正写入。**缺省为预演**，只打印将要执行的内容 |
| `--keep-order` | 添加曲目时保持给定顺序（服务端默认逆序插头部，已做补偿） |
| `--repair` | 上传后内容与本地不符时，自动删除重传，再建歌单 |
| `--interval <ms>` | 请求间隔，默认 `500`。触发风控时调大到 `1000`~`2000` |

`<歌单>` 参数可填**歌单 ID 或名称**。名称支持唯一子串匹配；命中多个会报错并列出候选，此时请改用 ID。

### 登录

```bash
node src/cli.mjs login            # 扫码登录
node src/cli.mjs status           # 查看当前登录态
```

### 歌单

```bash
node src/cli.mjs pl list                                  # 列出全部歌单
node src/cli.mjs pl show <歌单> [--limit 50]              # 查看曲目
node src/cli.mjs pl export <歌单> [--format csv|json|m3u] [--out 路径]
node src/cli.mjs pl add <歌单> --tracks 1,2,3 [--file ids.txt] [--keep-order] [--apply]
node src/cli.mjs pl remove <歌单> --tracks 1,2,3 [--apply]
node src/cli.mjs pl dedupe <歌单> [--by id|meta] [--apply]
node src/cli.mjs pl move <歌单> --id <歌曲id> --to <位置> [--apply]   # 单曲移到指定位置
node src/cli.mjs pl audit                                 # 巡检各歌单中未匹配的云盘曲目
node src/cli.mjs pl merge <源歌单...> --into <目标歌单|new:新名称> [--apply]
node src/cli.mjs pl create <名称> [--apply]
node src/cli.mjs pl delete <歌单> [--apply]               # 仅限自己创建的
```

### 云盘

```bash
node src/cli.mjs cloud list [--limit n] [--match matched|unmatched] [--export out.csv]

node src/cli.mjs cloud upload <文件或目录...> [--recursive] \
    [--playlist <歌单>|new:名称] [--repair] [--limit n] [--apply]

node src/cli.mjs cloud verify <目录> [--apply]            # 校验，--apply 自动修复

node src/cli.mjs cloud delete [--ids 1,2] [--name 关键词] [--artist 关键词] \
    [--match matched|unmatched] [--apply]
node src/cli.mjs cloud delete --not-in-playlist [--apply] # 删除未被任何歌单引用的曲目

node src/cli.mjs cloud topl <歌单> --from-dir <目录> [--apply]   # 按目录顺序入歌单
node src/cli.mjs cloud topl <歌单> [--name 关键词] [--artist 关键词] [--limit n] [--apply]

node src/cli.mjs cloud match --sid <云盘songId> --asid <目标歌曲id> [--apply]

node src/cli.mjs cloud report [--out 报告.md]             # 生成归属报告
```

### 下载

> 走第三方聚合站 `flac.music.hi.cn`，**与网易云登录态无关**，`login` 不是前置条件。
> 站点只认 `Referer`，工具已内置。下载完成后会自动按清单补写标签与封面，`--no-tag` 可关闭。

**限流口径**：站点在 `/api/getSongUrl`（取直链）维度按 IP 做配额限制，超额时有两种表现，**后一种不是「歌不存在」**：

| 站点返回 | 含义 | 处理 |
| --- | --- | --- |
| `IP x.x.x.x 在 /api/getSongUrl 维度请求过于频繁，请在 N 秒后重试` | 明确限流，需冷却 N 秒 | 工具按提示自动等待后重试 |
| `Song not found or invalid response` | 多数情况是同一限流的泛化响应 | 放慢 `--interval` 后重跑，不必换专辑 |

`--interval` 同时作用于站内搜索与取链。实测**取链 7000ms 稳定**（约 8.5 req/min）；1000ms 与 2000ms 会持续撞限流，逐首重试耗尽后表现为「取链失败」。另外 `dl albums` 会连续扫多平台多页，扫描完立刻取链基本必失败，先等冷却或直接调大间隔。

> 签名（`time`/`sign`）与限流无关：同一份专辑签名跨曲目复用有效（实测 40 秒后仍能正常取链），无需每首重新拉专辑。

```bash
node src/cli.mjs dl find "Shape of My Heart" [--platform wyy|kuwo|both] [--limit 20]
node src/cli.mjs dl albums "Backstreet Boys" [--all] [--min-tracks 2]

node src/cli.mjs dl album "<专辑名>" --artist "<歌手>" \
    [--id 专辑ID] [--platform wyy|kuwo] [--code 01] [--probe "专辑内任意一首歌名"] \
    [--root 库根目录] [--dir 专辑目录] [--tracks 1,3-5] [--quality flac|mp3] \
    [--engine auto|aria2|native] [--dry] [--force] [--verify] [--no-wait] \
    [--date 2003] [--composer 作曲] [--no-tag]

node src/cli.mjs dl album --list albums.json [--only 01,02]     # 批量专辑模式

node src/cli.mjs dl track "<曲名>" --artist "<歌手>" [--code OP01] [--credit 信用名] [--dry]

node src/cli.mjs dl tag "<目录...>" [--date 2003] [--genre 流派] [--composer 作曲] \
    [--no-cover] [--no-fetch] [--dry] [--force]

node src/cli.mjs dl verify "<目录>"        # 校验时长/码率/FLAC 容器
```

| 参数 | 说明 |
| --- | --- |
| `--root` | 库根目录，实际落盘 `<root>/<歌手>/<NN - 专辑名>/` |
| `--dir` | 直接指定专辑目录，不再拼歌手与编号 |
| `--engine` | `auto`（默认）/ `aria2` / `native`。`auto` 探不到 RPC 就降级内置下载器；用 Aria2 时任务结束会按 gid 移出任务列表，不留「已完成」记录，也不影响你自己排队的其他任务 |
| `--rpc` `--secret` | Aria2 RPC 地址与 `rpc-secret`，也可用 `ARIA2_RPC` / `ARIA2_SECRET` |
| `--code` | 专辑序号前缀，`--code 01` → `01 - Backstreet Boys/` |
| `--probe` | 用专辑内任意一首歌名辅助定位，**同名首专/同名精选必备** |
| `--tracks` | 只处理指定轨号，支持 `1,3-5` |
| `--verify` | 下载完立刻跑一遍校验 |
| `--no-wait` | 只提交给 Aria2 就返回（Aria2 后台继续下） |
| `--force` | 覆盖同轨号已存在的文件 |
| `--date` | 写入标签的年份；`dl tag` 同样适用 |
| `--composer` | 写入标签的作曲（原声类专辑建议填） |
| `--no-tag` | 只下载，不自动补写标签与封面 |

`dl tag` 用于**事后**补写标签（下载流程已默认执行）：补 `--date` / `--composer`、修复被改过的文件，或在 `--no-tag` 下载后统一处理。元数据取自 `.crate-manifest.json` 与站点专辑接口，不需要另建清单：

- 写入 `TITLE` / `ARTIST` / `ALBUM` / `ALBUMARTIST` / `TRACKNUMBER` / `TRACKTOTAL` / `DISCNUMBER` / `DISCTOTAL` / `DATE` / `GENRE` / `COMPOSER`，并内嵌封面（600×600）
- 只重排 FLAC 元数据块，**音频帧字节原样保留**（STREAMINFO 里的 MD5 不变），不重编码
- 按目标状态比对，已是目标值的文件跳过；只补缺失或不同的字段，`--force` 全量重写。因此「先 `--no-tag` 下载、再 `dl tag --date`」也能正确补上年份
- `--no-cover` 不嵌封面；`--no-fetch` 只用清单信息（此时取不到封面地址与逐轨艺人）
- 封面格式按**魔数**识别：站点封面接口标称 `image/jpg`，实际返回的是 PNG
- 目标文件被其他进程占用（Windows `EBUSY`）时，改名会失败，工具退回原地重写而不是中断整批

默认落盘根目录 `./downloads`，可用 `--root`、`CRATE_DL_ROOT` 或 `config/download.json` 覆盖：

```json
{ "root": "E:/Music/flac", "engine": "auto", "rpc": "http://localhost:6800/jsonrpc", "secret": "" }
```

批量模式的 `albums.json`（`code` 按发售顺序手工给定，`probe` 选填但同名专辑强烈建议填）。
注意 `root` 填的是**歌手目录**，工具只在其下建 `NN - 专辑名/`：

```json
[
  {
    "artist": "Backstreet Boys",
    "root": "E:/Music/flac/Backstreet Boys",
    "albums": [
      { "code": "01", "name": "Backstreet Boys", "probe": "Darlin'" },
      { "code": "02", "name": "Backstreet's Back" },
      { "code": "03", "name": "Millennium", "id": "1550459", "platform": "wyy" }
    ]
  }
]
```

命名与选源规则（与油猴脚本一致）：

- 专辑：`<两位轨号> - <曲名>.<ext>`；单曲：`<编号> - <曲名> - <歌手>.<ext>`，编号在下载时就带上，下完不用改名
- Windows 非法字符 `\ / : * ? " < > |` → `_`；`*` `~` 直接去掉；结尾的点与空格去掉
- 音质 `flac > 320k mp3 > 其余`；**同档优先网易云**（酷我常报 2000k，多为转码/升频）
- 目录内已有同轨号文件会跳过，可反复跑到补齐；缺失曲目重跑同一条命令即可

## 典型场景

### 1. 把本地按目录整理的音乐上传并归档成歌单

```
D:\music\lib_JOJO\
├── 03\
│   ├── ED01 - Walk Like an Egyptian - The Bangles.flac
│   └── OP01 - STAND PROUD - 橋本仁.flac
├── 04\
└── 05\
```

```bash
node src/cli.mjs cloud upload "D:/music/lib_JOJO" --recursive \
    --playlist "new:lib_JOJO" --repair --apply
```

最终歌单顺序为 `03/` 全部曲目 → `04/` → `05/`，每层内按文件名自然序（`ED01` 先于 `ED02`，`9` 先于 `10`）。

### 2. 校验云盘内容是否与本地一致

```bash
node src/cli.mjs cloud verify "D:/music/lib_JOJO"          # 只报告
node src/cli.mjs cloud verify "D:/music/lib_JOJO" --apply  # 删除异常条目并重传
```

输出逐文件对比本地大小与云端大小，状态为 `完整` / `大小不符` / `内容不符` / `缺失`。

### 3. 合并多个歌单

```bash
node src/cli.mjs pl merge "曲库 - 日语混合" "曲库 - 英文混合" --into "new:综合曲库" --apply
```

自动按曲目 ID 去重，只写入目标歌单中尚不存在的曲目。

### 4. 清理云盘里没有归属的曲目

```bash
node src/cli.mjs cloud delete --not-in-playlist          # 预演，列出待删清单
node src/cli.mjs cloud delete --not-in-playlist --apply  # 执行
```

删除前会把 `songId`、名称、歌手、专辑、大小、码率、**MD5**、原始文件名写入 `data/snapshot/del-cloud-<时间戳>.json`，便于日后定位与重新上传。

### 5. 生成云盘归属报告

```bash
node src/cli.mjs cloud report --out 云盘归属.md
```

遍历全部歌单建立「曲目 → 歌单」索引，再与云盘逐条比对，输出 Markdown：已收藏 / 未收藏 / 被多个歌单收录三张表。

### 6. 下载整张专辑（Aria2 可选）

```bash
# 先预演：确认选中哪张专辑、哪几首会被跳过
node src/cli.mjs dl album "Backstreet Boys" --artist "Backstreet Boys" \
    --code 01 --root "E:/Music/flac" --probe "Darlin'" --dry

# 正式下载并校验
node src/cli.mjs dl album "Backstreet Boys" --artist "Backstreet Boys" \
    --code 01 --root "E:/Music/flac" --probe "Darlin'" --engine aria2 --verify
```

```
E:\Music\flac\
└── Backstreet Boys\
    └── 01 - Backstreet Boys\
        ├── 01 - We've Got It Goin' On (Radio Edit).flac
        ├── 02 - Anywhere for You.flac
        ├── ...
        └── .crate-manifest.json      # 曲目清单，dl verify 用它比时长
```

没开 Aria2 时去掉 `--engine aria2` 即可，`auto` 会自动降级到内置下载器（并发 3，失败重试 3 次，先写 `.part` 再改名，不会留下半截文件）。

## 设计说明：实测踩到的六个坑

这些行为在文档里都查不到，只有跑真实账号才会暴露。记录下来，也解释了代码里那些看起来多余的判断。

### 1. `needUpload` 不能用来判断文件是否已上传

`/api/cloud/upload/check` 对**从未上传过的新文件**同样返回 `needUpload: false`，却会正常下发 `uploadToken` / `objectKey` / `resourceId` / `uploadUrl`。若据此跳过上传，文件永远不会出现在云盘。

**处理**：一律以 `privateCloud.md5` 建立云盘索引判重，不信任该字段。这也让上传天然幂等——重跑只会补传缺失的文件。

### 2. `cloud_upload_complete` 返回的不是云盘歌曲 ID

它返回的其实是 `originalAudioSongId`（上传音频自身的 ID）。云盘条目真正的 `songId` 是另一套编号；若该曲目自动匹配到了版权曲目，`songId` 就是版权曲目的 ID。

**处理**：上传后回读云盘，按 MD5 反查真实 `songId`，再写入歌单。直接使用返回值会把歌单指向不存在的曲目。

### 3. `op=add` 会把整批曲目逆序插到歌单头部

提交 `[a, b, c]`，歌单变成 `[c, b, a, ...原有曲目]`。

**处理**：写入层做倒序补偿——分批时「倒序分段、段内倒序」，最终顺序才与入参一致。`--keep-order` 或 `--from-dir` 时自动启用。

调整已存在曲目的位置则要用另一个接口：`/api/playlist/manipulate/tracks` 且 `op=update`、参数名为 `trackIds`。**不要用 `/api/playlist/order/update`**——那个接口调整的是侧边栏的**歌单**顺序（参数只有 `ids`），传歌曲 id 进去会静默返回 `200` 但毫无效果，很难排查。`pl move` 已封装正确调用。

### 4. 上传存在稳定复现的内容不符

实测两次批量上传，分别有 **4/10** 和 **8/20** 的文件入库后云端 MD5 与本地不一致（云端条目被替换成约 320kbps 的版本，大小明显偏小）。删除该条目重新上传即可恢复，属传输/登记环节问题。

**处理**：把校验做成流程的强制环节，而不是可选项。

- `cloud upload --playlist ... --repair`：建歌单前先按 MD5 对账，异常则删旧条目重传，复查通过才建单
- `cloud verify <目录> --apply`：独立的全量校验与修复命令

**正确顺序是「上传 → 校验/修复 → 按目录顺序入歌单」**。反过来做（先建歌单再校验）会导致修复时条目 ID 变更，歌单留下失效引用。

### 5. 云盘条目的元数据在 `privateCloud` 子对象里

顶层 `artist` / `album` 已被服务端置空。真实信息在 `privateCloud`（`md5`、`fileName`、`fileSize`、`bitrate`、`originalAudioSongId`）。且 `bitrate` 单位不统一：历史条目是 kbps（`968`），新条目是 bps（`1756000`），需要按量级归一化。

### 6. `playlist_detail` 能读到已删除的歌单，`trackCount` 会滞后

删掉的歌单仍可按 ID 查到详情（服务端缓存），而且 `trackCount` 可能与实际曲目数不一致。**判断歌单是否存在，必须以 `user_playlist` 列表为准**，否则会误判「某歌单仍存在」。

此外，`playlist_tracks` 模块把响应包了两层（`{status, body:{status, body}}`），直接读 `body.code` 会拿到 `undefined`，导致**操作成功却报失败**。调用层需要逐层解包。

## 匹配与元数据：三种状态

云盘曲目是否匹配到版权曲目，直接决定它在歌单里的显示效果与可修复性。这是使用本工具时最容易判断错的地方，单独说明。

### 三种状态

| 状态 | `matchType` | 歌单中的表现 | 能否修复 |
| --- | --- | --- | --- |
| 已匹配 | `matched` | 曲名、歌手、专辑、封面齐全 | — |
| 未匹配，原版仍在库 | `unmatched` | 只显示文件名或 ID3 信息 | ✔ 可 `cloud match` 指向正确版本 |
| 未匹配，原版已下架 | `unmatched` | 同上 | ✘ 没有可指向的目标 |

后两种状态的 `matchType` 相同，**只能通过搜索是否存在合格候选来区分**。

### 判定口径：两件事，两个依据

这两条经常被混为一谈，混用必然漏判：

| 要判断什么 | 唯一依据 |
| --- | --- |
| 是否**匹配到版权曲目** | 云端 `matchType`（`pl audit` 用这个） |
| 是否有**歌手 / 专辑** | `ar` / `al` 是否为空 |

上传时 ID3 里带艺人信息的曲目，在歌单里会正常显示歌手，但 `matchType` 仍是 `unmatched`。按「歌手为空」筛选会把它整类漏掉——实测中有一首 `感謝。`（RSP）就是这样被漏过一轮的。

### 选版本只能靠时长，不能靠歌名

同一首歌在库里常有十几个版本：完整版、TV size、album mix、remix、翻唱。歌名往往一模一样，仅凭标题匹配必然出错。实际踩过的两次：

- `Freek'n You` 被自动匹配成 **TV 动画版（1:40）**，本地是 6:19 完整版；
- `ホログラム` 被匹配成 **Anime Ver.**，本地是 4:09。

**硬标准**：以歌单返回的 `dt` 为基准，与候选 `song_detail` 的 `dt` 比较，差 ≤3 秒才视为候选。工具只提供 `pl audit` 定位与 `cloud match` 执行，**不自动挑选版本**——候选版本必须人工核对时长后再指定 `--asid`。

### 冒名账号：比「找不到」更危险

搜索高热度曲目（尤其已下架的）时，会出现**冒充原唱歌手的账号**。实测搜「蓝色风暴 周杰伦」的结果：

```
10s   蓝色风暴     用户8082066681    ← 片段
62s   蓝色风暴     沃瑶万猿身         ← 片段
31s   可惜故事太长… 周杰伦.           ← 冒充账号，内容完全无关
218s  我爱你        周杰伦♚           ← 冒充账号
```

`周杰伦.` 与 `周杰伦♚` 是**两个不同的冒充账号**，不是简繁体或标点差异。若用 `artist.includes('周杰伦')` 这类宽松判断，会把《蓝色风暴》挂到冒充账号的《我爱你》上——歌名、歌手、封面全错，而且极难发现。

**因此批量自动匹配对下架曲目不可行。宁可判定「不可修」，也不要错配。**

### `search` 与 `song_detail` 的字段结构不同

`search` 返回的歌曲对象里，`ar` / `al` / `dt` **全是 `undefined`**，必须先取 id 再用 `song_detail` 补全。直接读搜索结果会得到一片空值，看着像"这首歌没有任何信息"，实际是取错了字段。

### 推荐操作流程

```
1. pl audit                      → 列出各歌单中未匹配的云盘曲目
2. 对每首搜索「标题 + 歌手」
3. song_detail 取候选，按「歌手精确匹配 + 时长差 ≤3s」筛选
4. 确认目标 id 未被云盘其他条目占用
5. cloud match --sid <云盘ID> --asid <目标ID> --apply
6. 未匹配 → 已匹配 时歌单引用自动跟随，无需改动歌单
```

### 抽样结论：高热度下架曲目无法修复

对 `lib_周杰伦` 前 5 首未匹配曲目做试匹配，**0/5 可修**：原版已整体下架，候选全是片段与冒充账号。这类歌单建议**保持未匹配**——文件可正常播放，只是没有版权元数据，比错配安全得多。

## 数据与安全

| 路径 | 内容 | 是否纳入版本控制 |
| --- | --- | --- |
| `config/auth.json` | 登录 Cookie（含 `MUSIC_U`） | 否（已 gitignore） |
| `data/login-qr.png` | 登录二维码 | 否 |
| `data/snapshot/` | 写操作前快照、删除清单 | 否 |
| `data/export/` | 导出的 CSV / 报告 | 否 |

`config/auth.json` 等价于账号凭证，**不要提交、不要分享、不要放进截图**。若不慎泄露，在网易云 App 中退出全部登录即可使其失效。

## 已知限制

- **未实现**：歌单改名、批量评论/点赞。下载走第三方站点的独立接口（见[下载](#下载)），不经过网易云，也不消耗登录态。
- **匹配相关的问题**统一见 [匹配与元数据](#匹配与元数据三种状态)。最需要注意的两条：
  - **未匹配 ≠ 可修复**。原版下架后不存在合格候选，强行匹配会挂到翻唱或冒充账号名下。
  - **改匹配时歌单引用不会自动更新**（未匹配 → 已匹配 则会自动跟随），前者需要 `pl add` + `pl move` 手工补位。
- **归属判定有固有模糊性**：已匹配到版权曲目的云盘条目与其共用 `songId`，无法区分「云盘副本被加入歌单」与「只是收藏了版权版」。`cloud report` 因此用「精确 / 参考」两档标注。
- **上传失败率不低**，务必配合 `--repair` 或 `cloud verify` 使用。
- **扫描结果是时间点快照**。`pl audit`、`cloud report` 全量扫描耗时数十秒，期间若在客户端改动歌单（增删曲目），结果会与实际不一致。排查「为什么刚扫过还有漏网」时先确认这一点。
- **验证范围有限**：仅在单个真实账号上验证（49 个歌单、843 首云盘曲目），未覆盖超大歌单（>1000 首）、多账号、隐私歌单等场景。
- **无自动化测试**。所有行为在真实账号上人工验证，接口随客户端版本变化可能失效。

## 常见问题

**Q：提示「登录态失效」？**

重新执行 `node src/cli.mjs login`。若反复失效，先确认没有在手机端主动退出登录。

**Q：提示触发风控（`-460`）？**

降低频率：`--interval 1500`，并隔一段时间再试。工具在命中该状态码时会立即中止，不会继续堆请求。

**Q：`dl` 报 `Song not found or invalid response`，是这首歌没有资源吗？**

多数不是。取链接口把 IP 限流泛化成了这句，与「曲目不存在」共用同一个返回。先放慢到 `--interval 7000` 重跑；仍失败再换 `--platform`。真正的「无资源」在 `dl album` 的曲目表里就体现为「无可用音质」，而不是取链报错。

**Q：加进歌单的顺序是反的？**

说明调用方没有启用保序补偿。命令行请加 `--keep-order`；使用 `cloud topl --from-dir` 时会自动启用。

**Q：上传后歌名变成乱码？**

请勿直接调用上游库的 `module/cloud.js`——它对文件名做了 `latin1 → utf8` 重编码，以库方式调用会把中文转乱。本仓库改为拆解三段式接口自行编排，规避了该问题。

**Q：`cloud upload` 报告「仍有 N 个文件未正确入库，不创建歌单」？**

这是保护行为。先跑 `cloud verify <目录> --apply` 修复，再用 `cloud topl <歌单> --from-dir <目录> --apply` 补入。

**Q：歌单里有几首歌不显示歌手、专辑？**

这些是未匹配到版权曲目的云盘上传。先跑 `pl audit` 定位，再按 [匹配与元数据](#匹配与元数据三种状态) 的流程处理。原版已下架的曲目（如周杰伦的作品）无法修复，只能保持现状——文件能正常播放，只是没有版权元数据。

**Q：`pl audit` 报的数量，和歌单里「没有歌手」的歌数量不一致？**

两者口径不同。`pl audit` 统计 `matchType != matched`；「没有歌手」看 `ar` 是否为空。带 ID3 艺人信息的未匹配条目会正常显示歌手，但仍计入 audit。

**Q：不小心匹配到翻唱或冒充账号了怎么办？**

用 `cloud match` 改指到正确版本。注意这时属于「已匹配 → 改匹配」，歌单里的旧引用不会更新，需要 `pl add` 新 id、`pl move` 到原位置、再删除旧条目。若确实找不到正确版本，建议删掉该云盘条目重新上传，让系统重新分配。

**Q：全量扫描刚跑过，为什么还有漏掉的未匹配曲目？**

扫描是时间点快照。`pl audit` 遍历几十个歌单需要数十秒，期间在客户端增删曲目会导致结果落后于实际。确认歌单在这段时间内没有被修改，或直接重跑一次。

## 免责声明

- 本项目为**非官方**工具，与网易云音乐及其关联公司无任何关系。
- 本项目使用第三方逆向接口，**仅供个人学习研究与自用**，禁止用于商业用途或任何违法用途。
- 使用本工具可能违反网易云音乐的用户协议，存在账号被限制的风险。**由此产生的一切后果由使用者自行承担。**
- 云盘上传请仅上传**你拥有合法权利**的音频文件。请勿用于传播侵权内容。
- 作者不对因使用本项目导致的任何直接或间接损失负责。

## 致谢与参考项目

本项目的协议层完全建立在以下项目之上，没有它们就没有这个工具：

| 项目 | 作用 | 许可 |
| --- | --- | --- |
| [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)（npm：`@neteasecloudmusicapienhanced/api`） | **核心依赖**。提供 weapi/eapi 加密、歌单与云盘的全部接口实现，含云盘上传的对象存储交互 | MIT |
| [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) | 上述项目的上游原型，逆向协议的开创性工作 | MIT |
| [Pixel-Forge-Studios/SPlayer](https://github.com/Pixel-Forge-Studios/SPlayer) | 参考实现。通过它定位到上述 Enhanced API 分支，并确认云盘上传/纠错/删除的可行路径 | AGPL-3.0 |

> SPlayer 仅作**思路参考**，本项目未复制其任何源代码。若你计划二次分发本项目，请注意其自身许可为 MIT，与 SPlayer 的 AGPL-3.0 无关。

运行时依赖：

| 依赖 | 用途 |
| --- | --- |
| [`music-metadata`](https://github.com/Borewit/music-metadata) | 读取 FLAC/MP3 等音频的标签与时长 |
| [`qrcode`](https://github.com/soldair/node-qrcode) | 生成登录二维码图片 |
| [`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) | 在终端渲染二维码 |

## License

[MIT](LICENSE)
