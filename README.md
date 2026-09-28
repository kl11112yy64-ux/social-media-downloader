# 社媒视频下载工具（Social Media Downloader）

一个可直接部署到 Vercel 的海外社媒内容下载 Web 工具：粘贴链接 → 解析媒资 → 选择清晰度/格式 → 下载。支持 YouTube、Instagram、TikTok、X(Twitter) 等 yt-dlp 覆盖的主流平台。

> **免责声明**：本工具仅供下载**用户本人拥有版权或已获得授权**的内容。使用者须自行遵守各平台服务条款与所在地区的版权法规，因使用本工具产生的任何法律责任由使用者本人承担。

## 架构说明

```
浏览器                       Vercel Serverless Functions (Node.js runtime)
  │                                │
  │  POST /api/parse { url }       │   spawn yt-dlp -J --no-playlist
  ├───────────────────────────────▶│   → title / thumbnail / duration / uploader
  │                                │   → progressive（按 height 去重排序）
  │                                │   → audioOnly（前 3 个）
  │                                │
  │  GET /api/download?url=&format=│   spawn yt-dlp -f <format> -o - <url>
  ├───────────────────────────────▶│   stdout 流式转发给客户端，全程不落盘
  │  ◀────────── 文件流 ──────────│   Content-Disposition: attachment
```

**解析引擎**：不在 package.json 中安装 yt-dlp。[lib/ytdlp.js](lib/ytdlp.js) 在 Serverless Function 冷启动时从 [yt-dlp 官方 release](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux) 下载单文件 Linux 二进制到 `/tmp/yt-dlp`、`chmod 755`；并发请求共享同一次下载（模块级 Promise 去重），暖启动直接复用 `/tmp` 中已有的二进制，零额外开销。

**技术栈**：Next.js 14（App Router）+ Node.js runtime，无数据库、无登录，单页深色 UI。

## 本地运行

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

### 本地 Windows / macOS 换二进制

Vercel 上跑的是 Linux 二进制；本地开发时 yt-dlp 的 Linux 版跑不起来，两种方式任选：

**方式一（推荐）：指向本机已安装的 yt-dlp**

在 `.env.local` 中设置 `YTDLP_BINARY_PATH`（优先级高于 URL 下载）：

```bash
# Windows（PowerShell）
$env:YTDLP_BINARY_PATH="C:\tools\yt-dlp.exe"   # 或写入 .env.local

# macOS / Linux
YTDLP_BINARY_PATH=/usr/local/bin/yt-dlp npm run dev
```

yt-dlp 各平台二进制下载：<https://github.com/yt-dlp/yt-dlp/releases/latest>

**方式二：换下载地址**

```bash
# .env.local，macOS 示例
YTDLP_BINARY_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos
```

Windows 下没有可直接 spawn 的 yt-dlp 单文件 Linux 二进制，请用方式一指定 `yt-dlp.exe`。

## 部署到 Vercel

### 方式一：导入仓库一键 Deploy

1. 把本仓库 push 到 GitHub / GitLab / Bitbucket；
2. 打开 [vercel.com/new](https://vercel.com/new)，选择 **Import Git Repository**，选中该仓库；
3. Framework Preset 会自动识别为 **Next.js**，无需修改任何配置；
4. 点击 **Deploy**。首次构建完成后即可使用（首次解析请求因冷启动下载 yt-dlp 会慢 5-15 秒，属正常现象）。

### 方式二：Vercel CLI

```bash
npm i -g vercel
vercel login
vercel          # 预览部署
vercel --prod   # 生产部署
```

`vercel.json` 已把 `/api/parse` 和 `/api/download` 两个函数的 `maxDuration` 设为 60 秒。**注意：60 秒超出 Hobby（免费）计划的 10 秒上限**，Hobby 计划部署时请把 `vercel.json` 里的 `maxDuration` 改为 `10`（代价是长视频下载可能中断），或升级到 Pro。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `YTDLP_BINARY_URL` | 否 | yt-dlp 官方 `yt-dlp_linux` release 地址 | 二进制下载地址，本地开发可换 `yt-dlp_macos` 等 |
| `YTDLP_BINARY_PATH` | 否 | `<os.tmpdir()>/yt-dlp` | 直接指定本机已有二进制（Windows/macOS 本地开发用），优先级高于 URL 下载 |
| `MAX_DURATION_SECONDS` | 否 | `3600` | 单条视频时长上限（秒），超限返回 413 |

## 平台限制与处理方式

| 限制 | 处理方式 |
|---|---|
| Serverless 文件系统只读 | 所有写入仅限 `/tmp`（yt-dlp 二进制），不持久化任何用户内容 |
| 冷启动 | 首次请求下载约 30MB 二进制，耗时 5-15 秒；接口错误信息会提示「首次请求较慢」，前端解析中也有提示 |
| 无 ffmpeg | 不做音视频流合并与转码，只列出可直接播放的 progressive 格式和纯音频格式；页面注明「部分平台高清档不可用」 |
| 函数执行时长上限 60s | `vercel.json` 配置 `maxDuration: 60`；解析内部超时 50s，超时返回 504 |
| 错误映射 | 超时 → 504；Unsupported URL → 422；私有/需登录 → 403；不存在/已删除 → 404；平台限流 → 429 |
| 注入防护 | `format` 参数白名单正则 `/^[\w\-+.$\[\]/]+$/`；URL 仅允许 http/https；另屏蔽 localhost 与常见内网地址（基础 SSRF 防护）；yt-dlp 参数用 `--` 分隔，URL 不会被当作参数解析 |
| 客户端断连 | 下载流 cancel 时立即 `SIGKILL` yt-dlp 子进程，不留僵尸进程 |

## 合规边界（代码级强制）

- **一律 `--no-playlist`**：解析与下载均禁止播放列表/批量抓取，一次只处理单条内容；
- **时长上限**：默认 3600 秒（`MAX_DURATION_SECONDS` 可调），超限直接返回 413；
- **不提供 cookies/登录态**：遇到需要登录的内容直接报错拒绝（403）；
- **不落盘、不存储**：下载全程 stdout 流式转发，服务器不保存任何媒体文件或链接记录；
- **免责声明**：页面顶部横幅 + 页脚各展示一遍。

## 接口速查

```bash
# 解析
curl -X POST http://localhost:3000/api/parse \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.youtube.com/watch?v=xxxx"}'

# 下载（流式）
curl -L -o video.mp4 \
  'http://localhost:3000/api/download?url=<编码后的URL>&format=18&ext=mp4&filename=my-video'
```

## 目录结构

```
app/
  layout.jsx            # 根布局（metadata + globals.css）
  page.jsx              # 单页前端（客户端组件）
  globals.css           # 深色主题样式
  api/parse/route.js    # POST /api/parse
  api/download/route.js # GET /api/download
lib/
  ytdlp.js              # yt-dlp 二进制下载/复用/spawn 封装
package.json
vercel.json             # 函数 maxDuration 配置
.env.example
.gitignore
```
