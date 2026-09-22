'use client';

import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function AccessibleDialog({
  labelledBy,
  onClose,
  busy = false,
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog;
    initial?.focus();
    return () => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (!busy) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    if (elements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const activeIndex = elements.findIndex((element) => element === document.activeElement);
    event.preventDefault();
    if (event.shiftKey) elements[activeIndex <= 0 ? elements.length - 1 : activeIndex - 1]?.focus();
    else
      elements[
        activeIndex < 0 || activeIndex === elements.length - 1 ? 0 : activeIndex + 1
      ]?.focus();
  };

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="commerce-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </section>
    </div>
  );
}
