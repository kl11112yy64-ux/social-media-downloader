import './globals.css';

export const metadata = {
  title: '社媒视频下载工具',
  description:
    '支持 YouTube / Instagram / TikTok / X(Twitter) 的视频解析与下载。仅供下载本人拥有或已获授权的内容。',
};

export const viewport = {
  themeColor: '#0b0d12',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
