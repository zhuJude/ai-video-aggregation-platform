import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  children,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type={type} {...props}>
      {children}
    </button>
  );
}
