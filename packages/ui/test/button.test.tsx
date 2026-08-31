import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/index.js';

describe('Button', () => {
  it('defaults to a non-submitting button and forwards accessible attributes', () => {
    render(<Button aria-label="开始生成">生成</Button>);

    expect(screen.getByRole('button', { name: '开始生成' })).toHaveAttribute('type', 'button');
  });
});
