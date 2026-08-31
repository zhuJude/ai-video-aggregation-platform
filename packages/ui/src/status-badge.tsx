import type { ReactNode } from 'react';

export function StatusBadge({
  tone,
  children,
}: {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return <span data-tone={tone}>{children}</span>;
}
