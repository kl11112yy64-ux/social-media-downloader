'use client';

import { useState } from 'react';

function formatDuration(sec) {
  if (!sec && sec !== 0) return '-';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function Disclaimer({ compact }) {
  return (
    <div className={compact ? 'disclaimer disclaimer-compact' : 'disclaimer'} role="note">
      <strong>免责声明：</strong>
      本工具仅供下载<b>用户本人拥有版权或已获得授权</b>的内容。使用者须自行遵守
      YouTube、Instagram、TikTok、X(Twitter) 等平台的服务条款及所在地区的版权法规；
      因使用本工具产生的任何法律责任由使用者本人承担。
    </div>
  );
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleParse(e) {
    e?.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
      }
      setResult(data);
    } catch (err) {
      setError(err.message || '网络错误，请重试');
    } finally {
      setLoading(false);
    }
  }

  function downloadHref(fmt) {
    const params = new URLSearchParams({
      url: result.webpageUrl,
      format: fmt.id,
      ext: fmt.ext || 'mp4',
      filename: result.title || 'video',
    });
    return '/api/download?' + params.toString();
  }

  const hasFormats =
    result &&
    (result.formats.progressive.length > 0 || result.formats.audioOnly.length > 0);

  return (
    <main className="page">
      <Disclaimer />

      <header className="hero">
        <h1>社媒视频下载工具</h1>
        <p className="sub">
          粘贴链接 → 解析媒资 → 选择清晰度/格式 → 下载
        </p>
        <p className="platforms">YouTube · Instagram · TikTok · X(Twitter) 等</p>
      </header>

      <form className="search" onSubmit={handleParse}>
        <input
          type="url"
          inputMode="url"
          placeholder="粘贴视频链接，例如 https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
          required
        />
        <button type="submit" disabled={loading || !url.trim()}>
          {loading ? '解析中…' : '解析'}
        </button>
      </form>

      {loading && (
        <p className="hint">正在解析，首次请求因服务冷启动可能需要 5-15 秒，请稍候…</p>
      )}

      {error && <div className="error">{error}</div>}

      {result && (
        <section className="result">
          <div className="meta">
            {result.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={result.thumbnail} alt={result.title || '封面'} />
            )}
            <div className="meta-text">
              <h2>{result.title}</h2>
              <p>
                {result.uploader && <span>{result.uploader}</span>}
                {result.uploader && ' · '}
                <span>{formatDuration(result.duration)}</span>
                {result.platform && ` · ${result.platform}`}
              </p>
            </div>
          </div>

          {!hasFormats && (
            <p className="hint">
              该平台当前没有可直接下载的格式（部分平台高清档需 ffmpeg 合并环境，暂不可用）。
            </p>
          )}

          {result.formats.progressive.length > 0 && (
            <div className="group">
              <h3>视频（可直接播放）</h3>
              <ul>
                {result.formats.progressive.map((f) => (
                  <li key={f.id}>
                    <span className="label">{f.label}</span>
                    <span className="size">{f.sizeLabel || ''}</span>
                    <a className="btn" href={downloadHref(f)}>
                      下载
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.formats.audioOnly.length > 0 && (
            <div className="group">
              <h3>仅音频</h3>
              <ul>
                {result.formats.audioOnly.map((f) => (
                  <li key={f.id}>
                    <span className="label">{f.label}</span>
                    <span className="size">{f.sizeLabel || ''}</span>
                    <a className="btn" href={downloadHref(f)}>
                      下载
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="note">注：部分平台高清档因无 ffmpeg 合并环境不可用。</p>
        </section>
      )}

      <footer className="footer">
        <Disclaimer compact />
        <p>不存储任何文件与链接 · 单条时长上限 60 分钟 · 不支持播放列表与需登录内容</p>
      </footer>
    </main>
  );
}
