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

- **未实现**：歌单改名、批量评论/点赞、歌曲下载。
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
