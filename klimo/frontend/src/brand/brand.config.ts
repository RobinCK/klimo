import type { BrandTheme, MarkColors, NeutralTokens } from '@ui';

export type { MarkColors };

/**
 * Product identity — the only place that names or brands the product. To rebrand, change
 * this file (and the logo construction in Logo.tsx if the mark differs); the UI-kit takes
 * everything it needs from here through UiProvider.
 *
 * Fixed technical ids (the `klimo` slug of entities, topics, card elements and storage keys
 * shared with the cards) are not part of the brand and never change.
 */
export interface BrandConfig extends BrandTheme {
  /** localStorage namespace of the panel's own preferences. */
  id: string;
  /** Document title, accessible names, «About». */
  productName: string;
  /** Lower-case wordmark next to the logo. */
  wordmark: string;
  tagline: { uk: string; en: string };
  mark: { dark: MarkColors; light: MarkColors };
  /** Neutral primary button (ink on paper), per scheme. */
  action: { dark: { bg: string; fg: string }; light: { bg: string; fg: string } };
  fonts: { sans: string; mono: string };
  radiusScale: number;
  neutrals?: { dark?: Partial<NeutralTokens>; light?: Partial<NeutralTokens> };
  links: { docs: string; repo: string };
}

export const brand: BrandConfig = {
  id: 'klimo',
  productName: 'Klimo',
  wordmark: 'klimo',
  tagline: {
    uk: 'Клімат кожної кімнати: опалення, охолодження й вологість в одному адоні для Home Assistant.',
    en: 'The climate of every room: heating, cooling and humidity in one Home Assistant add-on.',
  },
  mark: {
    dark: { cold: '#4DA6FF', warm: '#FF8A3D', dot: '#F4F5F6', tile: '#15181C', tileBorder: '#2A2F36' },
    light: { cold: '#2F86E0', warm: '#E8701F', dot: '#14171A', tile: '#FFFFFF', tileBorder: '#E1E4E9' },
  },
  action: {
    dark: { bg: '#ECEEF1', fg: '#0E1013' },
    light: { bg: '#14171A', fg: '#FFFFFF' },
  },
  fonts: { sans: 'IBM Plex Sans', mono: 'IBM Plex Mono' },
  radiusScale: 1,
  links: {
    docs: 'https://github.com/RobinCK/klimo/blob/main/klimo/DOCS.md',
    repo: 'https://github.com/RobinCK/klimo',
  },
};
