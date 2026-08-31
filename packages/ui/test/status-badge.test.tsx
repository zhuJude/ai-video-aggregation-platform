import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../src/index.js';

describe('StatusBadge', () => {
  it('exposes semantic status text', () => {
    render(<StatusBadge tone="success">已完成</StatusBadge>);
    expect(screen.getByText('已完成')).toHaveAttribute('data-tone', 'success');
  });
});
