import type { ReactNode } from 'react';
import type { EpochMs, IconName, ProfileDto, RoomDetailDto, RoomPatch, RoomState } from '@api/model';
import type { CodeContext } from '@i18n';

/** What every settings section gets: the room, its live state and the ways to save. */
export interface SectionProps {
  room: RoomDetailDto;
  state: RoomState;
  ctx: CodeContext;
  now: EpochMs;
  /** Phone accordion body (narrower, fewer details). */
  phone: boolean;
  /** Configuration may be changed by this user (HA admin, or admin-only config is off). */
  canEdit: boolean;
  /** Saves a part of the room settings (debounced by the caller where it edits a value). */
  save: (patch: RoomPatch) => Promise<unknown>;
  /** Puts a fresh room read model (returned by a sensor/emitter/device write) on screen. */
  setRoom: (room: RoomDetailDto) => void;
  /** Every profile (names, colours and default targets). */
  profiles: readonly ProfileDto[] | undefined;
}

/** One settings section: a card on wide screens, an accordion on phones. */
export interface SectionDef {
  /** `?section=` key and the id of the element (`section-<key>`). */
  key: string;
  icon: IconName;
  title: (p: SectionProps) => string;
  /** Desktop: the line under the title. */
  subtitle?: (p: SectionProps) => string | undefined;
  /** Phone: the live one-line summary of the closed accordion. */
  summary: (p: SectionProps) => string;
  /** Desktop: a button in the header («+ Додати датчик»). */
  action?: (p: SectionProps) => ReactNode;
  /** Small tag next to the desktop title («необов’язково»). */
  tag?: (p: SectionProps) => string | undefined;
  /** Hidden for rooms that have nothing to show here. */
  hidden?: (p: SectionProps) => boolean;
  Body: (p: SectionProps) => JSX.Element;
}
