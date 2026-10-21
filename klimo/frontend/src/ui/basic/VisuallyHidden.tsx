import type { ReactNode } from 'react';
import s from './basic.module.css';

/** Text for screen readers only (live announcements, table captions). */
export function VisuallyHidden({ children, live }: { children: ReactNode; live?: 'polite' | 'assertive' }) {
  return (
    <span className={s.srOnly} aria-live={live}>
      {children}
    </span>
  );
}
