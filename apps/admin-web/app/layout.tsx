import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '镜界运营控制台',
    template: '%s | 镜界运营控制台',
  },
  description: '独立、权限受控的中文运营管理平台',
  robots: {
    follow: false,
    index: false,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
