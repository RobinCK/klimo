import type { IconName, Tone } from '@api/model';
import type { SpaceName } from './tokens/base';

export type { IconName, Tone };

/**
 * Named gaps for layout props: 3xs 2 · 2xs 4 · xs 6 · sm 8 · md 12 · lg 16 · xl 20 · 2xl 24 · 3xl 32 · 4xl 40 px.
 */
export type Space = SpaceName;

/** A button-like action handed to a component: a callback, a route, or both. */
export interface Action {
  label: string;
  onClick?: () => void;
  /** Route (`/rooms/living`) resolved through UiNavContext. */
  to?: string;
  disabled?: boolean;
  loading?: boolean;
}

/** One navigation destination of the top bar or the phone tab bar. */
export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  to: string;
  badge?: { count: number; tone: 'warn' | 'err' };
}
