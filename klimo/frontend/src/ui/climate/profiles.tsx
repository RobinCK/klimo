import type { CSSProperties } from 'react';
import type { IconName } from '../types';
import { useUiText } from '../UiTextContext';
import { Icon, type IconSize } from '../basic/Icon';
import s from './climate.module.css';

/*
 * Profile colours are categorical (schedule blocks, chips, timelines) and never mean a state;
 * each comes with the ink that reads on it.
 */

export interface ProfileSwatchProps {
  color: string;
  size?: 8 | 10 | 12 | 14;
  shape?: 'square' | 'round';
  /** Profile name: the accessible name when the swatch stands alone. */
  name?: string;
  /** Same as `name`. */
  label?: string;
}

export function ProfileSwatch({ color, size = 10, shape = 'square', name, label: labelProp }: ProfileSwatchProps) {
  const label = labelProp ?? name;
  const style = { '--sw': color, '--size': `${size}px` } as CSSProperties;
  return (
    <span
      className={s.swatch}
      data-shape={shape}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface ProfileIconTileProps {
  /** Without an icon the tile shows the first letter of `name`. */
  icon?: IconName | null;
  color: string;
  ink?: string;
  name?: string;
  size?: 28 | 36 | 48;
}

export function ProfileIconTile({ icon, color, ink, name, size = 36 }: ProfileIconTileProps) {
  const glyph: IconSize = size >= 48 ? 24 : size >= 36 ? 18 : 16;
  const style = { '--tile-bg': color, '--tile-fg': ink ?? 'var(--ui-bg-page)', '--size': `${size}px` } as CSSProperties;
  return (
    <span className={s.profileTile} data-size={size} style={style} aria-hidden="true">
      {icon ? <Icon name={icon} size={glyph} /> : <span className={s.profileInitial}>{(name ?? '').trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}

export interface ProfileTileProps {
  name: string;
  color: string;
  ink?: string;
  icon?: IconName;
  /** «21.0°». */
  value?: string;
  /** tile: name over value (wizard review) · inline: swatch, name and value in a line · chip: a filled pill. */
  variant?: 'tile' | 'inline' | 'chip';
}

export function ProfileTile({ name, color, ink, icon, value, variant = 'tile' }: ProfileTileProps) {
  if (variant === 'chip') {
    const style = { '--chip-bg': color, '--chip-fg': ink ?? 'var(--ui-bg-page)' } as CSSProperties;
    return (
      <span className={s.profileChip} style={style}>
        {icon ? <Icon name={icon} size={14} /> : null}
        <span className={s.ellipsis}>{name}</span>
        {value ? <span className={s.profileChipValue}>{value}</span> : null}
      </span>
    );
  }
  if (variant === 'inline') {
    return (
      <span className={s.profileInline}>
        {icon && ink ? <ProfileIconTile icon={icon} color={color} ink={ink} size={28} /> : <ProfileSwatch color={color} size={12} shape="round" />}
        <span className={s.profileInlineName}>{name}</span>
        {value ? <span className={s.profileInlineValue}>{value}</span> : null}
      </span>
    );
  }
  return (
    <span className={s.profileCard}>
      <span className={s.profileCardName}>
        <ProfileSwatch color={color} size={8} shape="round" />
        <span className={s.ellipsis}>{name}</span>
      </span>
      {value ? <span className={s.profileCardValue}>{value}</span> : null}
    </span>
  );
}

export interface ProfileListItemProps {
  name: string;
  /** «системний», «свій». */
  kindLabel: string;
  color: string;
  ink: string;
  icon: IconName;
  heatText: string;
  coolText: string;
  /** This profile is in force right now. */
  live?: boolean;
  selected: boolean;
  onClick: () => void;
}

/** A profile in the schedule page's list: colour tile, name, kind, heat and cool targets. */
export function ProfileListItem({ name, kindLabel, color, ink, icon, heatText, coolText, live, selected, onClick }: ProfileListItemProps) {
  const ut = useUiText();
  return (
    <button type="button" className={s.profileItem} aria-pressed={selected} onClick={onClick}>
      <ProfileIconTile icon={icon} color={color} ink={ink} size={36} />
      <span className={s.profileItemText}>
        <span className={s.profileItemHead}>
          <span className={s.profileItemName}>{name}</span>
          {live ? <span className={s.liveBadge}>{ut('Active now')}</span> : null}
        </span>
        <span className={s.profileItemKind}>{kindLabel}</span>
      </span>
      <span className={s.profileItemTargets}>
        <span className={s.heatText}>{heatText}</span>
        <span className={s.coolText}>{coolText}</span>
      </span>
    </button>
  );
}
