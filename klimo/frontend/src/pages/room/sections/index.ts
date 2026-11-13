// The room's settings sections, in the order the phone's accordions and the desktop's settings list show them.
import { humiditySection } from './Humidity';
import { haSection } from './HaEntities';
import { profileTargetsSection } from './ProfileTargets';
import { notifySection, smartSection } from './Smart';
import { sensorsSection } from './Sensors';
import { setupSection } from './Setup';
import { sourcesSection } from './Sources';
import { toleranceSection } from './Tolerance';
import { trvsSection } from './Trvs';
import type { SectionDef } from './types';
import { windowsSection } from './Windows';

export { DangerZone } from './Danger';
export type { SectionDef, SectionProps } from './types';

/** Phone accordions and the desktop's settings list, most used first. */
export const PHONE_SECTIONS: SectionDef[] = [
  setupSection,
  sensorsSection,
  sourcesSection,
  toleranceSection,
  windowsSection,
  trvsSection,
  humiditySection,
  profileTargetsSection,
  smartSection,
  notifySection,
  haSection,
];

/** Accordions open the first time the phone settings are shown. */
export const PHONE_DEFAULT_OPEN = ['src', 'tol', 'trv'];
