import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { ensureYtdlp, spawnYtdlp } from '../../../lib/ytdlp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// format 白名单：防 shell/参数注入（只允许 yt-dlp format_id 常见字符）
const FORMAT_RE = /^[\w\-+.$\[\]/]+$/;

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildDisposition(filename, ext) {
  // ASCII 兜底名 + RFC 5987 UTF-8 名，双保险
  const base = (filename || 'video').slice(0, 120);
  const ascii = base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').trim() || 'video';
  const full = ext ? `${base}.${ext}` : base;
  const asciiFull = ext ? `${ascii}.${ext}` : ascii;
  return `attachment; filename="${asciiFull}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const format = searchParams.get('format');
  const ext = (searchParams.get('ext') || 'mp4').replace(/[^\w]/g, '').slice(0, 10);
  const filename = searchParams.get('filename') || 'video';

  if (!url || !isAllowedUrl(url)) {
    return NextResponse.json({ error: 'URL 不合法，仅支持 http/https' }, { status: 400 });
  }
  if (!format || !FORMAT_RE.test(format)) {
    return NextResponse.json({ error: 'format 参数不合法' }, { status: 400 });
  }

  let bin;
  try {
    bin = await ensureYtdlp();
  } catch (err) {
    return NextResponse.json(
      { error: '下载引擎初始化失败（首次请求较慢属正常），请重试：' + err.message },
      { status: 503 }
    );
  }

  const child = spawnYtdlp(bin, [
    '-f', format,
    '--no-playlist',
    '--no-part',
    '--no-progress',
    '-o', '-',
    '--',
    url,
  ]);

  // spawn 本身失败（比如二进制不存在）时直接报错
  const spawnError = new Promise((_, reject) => child.once('error', reject));

  // stdout → Web ReadableStream，全程流式转发、不落盘
  let stderrBuf = '';
  child.stderr.on('data', (c) => {
    stderrBuf += c.toString('utf8');
    if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
  });

  const stream = new ReadableStream({
    start(controller) {
      child.stdout.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      child.stdout.on('end', () => {
        try {
          controller.close();
        } catch {}
      });
      child.stdout.on('error', (err) => controller.error(err));
      child.on('error', (err) => controller.error(err));
      // 客户端断开（cancel）时 kill 子进程，避免僵尸进程占资源
    },
    cancel() {
      try {
        child.kill('SIGKILL');
      } catch {}
    },
  });

  try {
    // 给 spawn 一个极短的出错窗口；正常路径下立即进入流式响应
    await Promise.race([
      spawnError,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: '下载进程启动失败：' + err.message },
      { status: 500 }
    );
  }

  return new Response(stream, {
    headers: {
      'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
      'Content-Disposition': buildDisposition(filename, ext),
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
