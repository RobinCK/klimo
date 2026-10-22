/**
 * Profile colours come from the UI-kit (12 colour/ink pairs where the ink reads on the colour,
 * the first six are the profiles a new house starts with); these are the profile icons.
 */
import type { IconName } from '@api/model';
import { PROFILE_COLORS } from '@ui';
import { t } from '@i18n';

export const PROFILE_PALETTE = PROFILE_COLORS;

export const PROFILE_ICONS = (): { name: IconName; label: string }[] => [
  { name: 'home', label: t('Home') },
  { name: 'away', label: t('Leaving') },
  { name: 'leaf', label: t('Leaf') },
  { name: 'moon', label: t('Moon') },
  { name: 'users', label: t('People') },
  { name: 'suitcase', label: t('Suitcase') },
  { name: 'sun', label: t('Sun') },
];

/** The first palette colour and icon no profile uses yet (for a new profile). */
export function freshLook(used: readonly { color: string; icon: IconName }[]): { color: string; ink: string; icon: IconName } {
  const colour = PROFILE_PALETTE.find((p) => !used.some((u) => u.color.toLowerCase() === p.color.toLowerCase())) ?? PROFILE_PALETTE[0];
  const icon = PROFILE_ICONS().find((i) => !used.some((u) => u.icon === i.name))?.name ?? 'home';
  return { color: colour.color, ink: colour.ink, icon };
}
