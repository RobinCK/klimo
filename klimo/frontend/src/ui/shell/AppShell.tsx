import type { ReactNode } from 'react';
import s from './shell.module.css';

export interface AppShellProps {
  /** TopBar on desktop and tablet; nothing (or a MobileTopBar inside the page) on phones. */
  top: ReactNode;
  /** BottomTabBar on phones. */
  bottom?: ReactNode;
  /** Persistent banners (connection lost, simulator) above the page content. */
  banner?: ReactNode;
  children: ReactNode;
}

/** Page frame: max width 1360, fluid gutters, safe areas, fixed tab bar on phones. */
export function AppShell({ top, bottom, banner, children }: AppShellProps) {
  return (
    <div className={s.app} data-has-bottom={bottom ? '' : undefined}>
      {top ? <div className={s.top}>{top}</div> : null}
      {banner ? <div className={s.banner}>{banner}</div> : null}
      <main className={s.main} id="main">
        {children}
      </main>
      {bottom ? <div className={s.bottom}>{bottom}</div> : null}
    </div>
  );
}
