import { NextResponse } from 'next/server';
import { ensureYtdlp, runYtdlpJson } from '../../../lib/ytdlp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel 上 maxDuration 为 60s，留一点余量给响应
const PARSE_TIMEOUT_MS = 50_000;
const MAX_DURATION_SECONDS = Number(process.env.MAX_DURATION_SECONDS || 3600);

function json(error, status) {
  return NextResponse.json({ error }, { status });
}

function isAllowedUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // 基础 SSRF 防护：不允许指向内网/本机地址
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }
  return true;
}

// 错误映射：超时→504、Unsupported URL→422、私有/需登录→403、不存在→404
function mapYtdlpError(stderr) {
  const s = stderr || '';
  if (/Unsupported URL|no suitable InfoExtractor/i.test(s)) {
    return { status: 422, error: '暂不支持该链接，请确认是公开的视频/帖子地址' };
  }
  if (
    /login required|Sign in|Private video|This video is only available|requires authentication|members only|join this channel|This content isn|account is private|You need to log in/i.test(s)
  ) {
    return { status: 403, error: '该内容为私有或需要登录，本工具不提供下载' };
  }
  if (
    /HTTP Error 404|does not exist|Video unavailable|Removed|Deleted|not available anymore|No video formats found.*404|tweet.*not found/i.test(s)
  ) {
    return { status: 404, error: '内容不存在或已被删除' };
  }
  if (/429|Too Many Requests|rate.?limit/i.test(s)) {
    return { status: 429, error: '目标平台限流，请稍后重试' };
  }
  return { status: 500, error: '解析失败，请确认链接有效后重试（首次请求因冷启动较慢属正常现象）' };
}

function fmtSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

// 无 ffmpeg 环境：只保留可直接播放的格式
// progressive = 同时带视频轨和音频轨（vcodec+acodec 都有），可直接下载播放
// audioOnly   = 纯音频轨，取码率最高的前 3 个
function buildFormats(info) {
  const seen = new Set();
  const progressive = [];
  const audioOnly = [];

  for (const f of info.formats || []) {
    if (!f.format_id) continue;
    // 必须有可直接访问的直链，流媒体清单(m3u8/dash)在无 ffmpeg 时无法落盘为单文件
    if (!f.url) continue;
    if (f.protocol && /m3u8|dash|f4m|ism/i.test(f.protocol)) continue;

    // 注意：generic 直链的 vcodec/acodec 为 null（未知），应视为“有”；
    // 正规提取器只会返回具体 codec 或 'none'
    const hasVideo = f.vcodec !== 'none';
    const hasAudio = f.acodec !== 'none';
    const filesize = f.filesize || f.filesize_approx || null;

    if (hasVideo && hasAudio) {
      const height = f.height || 0;
      const key = height + ':' + f.ext;
      if (seen.has(key)) continue; // 按 height 去重
      seen.add(key);
      progressive.push({
        id: f.format_id,
        kind: 'video',
        label: (height ? height + 'p' : '视频') + ' · ' + f.ext,
        height,
        ext: f.ext,
        fps: f.fps || null,
        tbr: f.tbr || null,
        filesize,
        sizeLabel: fmtSize(filesize),
      });
    } else if (!hasVideo && hasAudio) {
      audioOnly.push({
        id: f.format_id,
        kind: 'audio',
        label: '音频 · ' + f.ext + (f.abr ? ' · ' + Math.round(f.abr) + 'kbps' : ''),
        ext: f.ext,
        abr: f.abr || f.tbr || null,
        filesize,
        sizeLabel: fmtSize(filesize),
      });
    }
  }

  progressive.sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0));
  audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));

  return { progressive, audioOnly: audioOnly.slice(0, 3) };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json('请求体必须是 JSON：{ "url": "..." }', 400);
  }

  const url = body?.url;
  if (!isAllowedUrl(url)) {
    return json('URL 不合法，仅支持 http/https 的公开链接', 400);
  }

  let bin;
  try {
    bin = await ensureYtdlp();
  } catch (err) {
    return json(
      '解析引擎初始化失败（首次请求需下载约 30MB 的 yt-dlp 二进制，耗时 5-15 秒属正常），请重试：' +
        err.message,
      503
    );
  }

  let stdout;
  try {
    ({ stdout } = await runYtdlpJson(
      bin,
      ['-J', '--no-playlist', '--no-warnings', '--', url],
      PARSE_TIMEOUT_MS
    ));
  } catch (err) {
    if (err.code === 'ETIMEDOUT') {
      return json('解析超时。首次请求因冷启动较慢属正常现象，请重试一次', 504);
    }
    const mapped = mapYtdlpError(err.stderr || err.message);
    return json(mapped.error, mapped.status);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    return json('解析结果异常，请重试', 500);
  }

  const duration = info.duration || 0;
  if (duration > MAX_DURATION_SECONDS) {
    return json(
      `视频时长 ${Math.round(duration / 60)} 分钟，超过上限 ${Math.round(MAX_DURATION_SECONDS / 60)} 分钟，已拒绝下载`,
      413
    );
  }

  const { progressive, audioOnly } = buildFormats(info);

  return NextResponse.json({
    title: info.title || '未知标题',
    thumbnail: info.thumbnail || null,
    duration,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    platform: info.extractor_key || info.extractor || null,
    webpageUrl: info.webpage_url || url,
    formats: { progressive, audioOnly },
    note: '部分平台高清档因无 ffmpeg 合并环境不可用',
  });
}
