import { createContext, useContext, type ReactNode } from 'react';

/**
 * Navigation seam: kit links and `to` actions resolve routes here, so the kit knows nothing
 * about the router. Routes are app paths such as `/rooms/living`.
 */
export interface UiNav {
  /** The href to put on an anchor for `to` (the app returns `#/rooms/living`). */
  href(to: string): string;
  navigate(to: string, opts?: { replace?: boolean }): void;
}

const hashNav: UiNav = {
  href: (to) => `#${to.startsWith('/') ? to : `/${to}`}`,
  navigate: (to) => {
    window.location.hash = to.startsWith('/') ? to : `/${to}`;
  },
};

const UiNavContext = createContext<UiNav>(hashNav);

export function UiNavProvider({ nav, children }: { nav: UiNav; children: ReactNode }) {
  return <UiNavContext.Provider value={nav}>{children}</UiNavContext.Provider>;
}

export function useUiNav(): UiNav {
  return useContext(UiNavContext);
}
