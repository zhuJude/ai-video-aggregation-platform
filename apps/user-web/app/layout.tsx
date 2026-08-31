import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AppShell } from '../components/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '光帧 AI 视频工作台',
    template: '%s | 光帧',
  },
  description: '面向专业创作者的 AI 视频生成与作品管理平台。',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
