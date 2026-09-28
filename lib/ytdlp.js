import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// yt-dlp 二进制管理
//
// Vercel Serverless Function 不允许在 package.json 里带可执行二进制，
// 所以采用“冷启动时下载官方单文件二进制到 /tmp”的方案：
//   1. 冷启动：从 YTDLP_BINARY_URL（默认官方 yt-dlp_linux）下载到 /tmp/yt-dlp
//      并 chmod 755，首次请求会比平时慢 5-15 秒；
//   2. 暖启动：/tmp 中的二进制被同一个 Lambda 实例复用，零开销；
//   3. 并发请求共享同一次下载（模块级 ensurePromise），不会重复拉取；
//   4. 本地 Windows/macOS 开发：用 YTDLP_BINARY_PATH 直接指向本机已有的
//      yt-dlp.exe / yt-dlp，或用 YTDLP_BINARY_URL 换成对应平台的二进制地址。
// ---------------------------------------------------------------------------

export const DEFAULT_BINARY_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

const BINARY_URL = process.env.YTDLP_BINARY_URL || DEFAULT_BINARY_URL;
const BINARY_PATH =
  process.env.YTDLP_BINARY_PATH || path.join(os.tmpdir(), 'yt-dlp');

let ensurePromise = null;

function isUsableBinary(p) {
  try {
    const stat = fs.statSync(p);
    // 官方二进制约 30MB+，小于 1MB 视为残留的半截下载
    return stat.isFile() && stat.size > 1024 * 1024;
  } catch {
    return false;
  }
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'vercel-ytdlp-bootstrap/1.0' },
        timeout: 60_000,
      },
      (res) => {
        // 跟随 GitHub releases 的 302 跳转
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirectsLeft <= 0) {
            return reject(new Error('下载重定向次数过多'));
          }
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载 yt-dlp 失败：HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest, { mode: 0o755 });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载 yt-dlp 超时')));
    req.on('error', reject);
  });
}

/**
 * 确保 yt-dlp 二进制可用，返回可执行文件路径。
 * 并发调用共享同一次下载；失败后清除缓存，允许后续请求重试。
 */
export async function ensureYtdlp() {
  // 本地开发覆盖：直接指向已有二进制（Windows 下用 yt-dlp.exe）
  if (process.env.YTDLP_BINARY_PATH) {
    if (isUsableBinary(process.env.YTDLP_BINARY_PATH)) {
      return process.env.YTDLP_BINARY_PATH;
    }
    throw new Error(
      `YTDLP_BINARY_PATH 指向的文件不可用：${process.env.YTDLP_BINARY_PATH}`
    );
  }

  if (isUsableBinary(BINARY_PATH)) return BINARY_PATH;

  if (!ensurePromise) {
    ensurePromise = (async () => {
      // 先写到临时文件再原子改名，避免并发实例读到写了一半的文件
      const tmpPath = `${BINARY_PATH}.part-${process.pid}-${Date.now()}`;
      try {
        await download(BINARY_URL, tmpPath);
        fs.chmodSync(tmpPath, 0o755);
        fs.renameSync(tmpPath, BINARY_PATH);
        return BINARY_PATH;
      } catch (err) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        throw err;
      } finally {
        ensurePromise = null;
      }
    })();
  }
  return ensurePromise;
}

/** 以统一参数 spawn yt-dlp。 */
export function spawnYtdlp(binPath, args) {
  return spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 收集子进程输出（用于 -J 解析），带超时，超时即 kill。 */
export function runYtdlpJson(binPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnYtdlp(binPath, args);
    const stdoutChunks = [];
    const stderrChunks = [];

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const err = new Error(stderr || `yt-dlp exited with code ${code}`);
        err.stderr = stderr;
        err.exitCode = code;
        return reject(err);
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr,
      });
    });
  });
}
