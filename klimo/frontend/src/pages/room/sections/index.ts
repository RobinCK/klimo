// The room's settings sections, in the order each layout shows them.
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

/** Desktop, full width above the columns: the room as the wizard set it up, to edit. */
export const SETUP_SECTION: SectionDef = setupSection;

/** Desktop, left column: what serves the room and how it measures and reacts. */
export const LEFT_SECTIONS: SectionDef[] = [sourcesSection, sensorsSection, toleranceSection, windowsSection, profileTargetsSection];

/** Desktop, right column: devices and the rest. */
export const RIGHT_SECTIONS: SectionDef[] = [trvsSection, humiditySection, smartSection, notifySection, haSection];

/** Phone accordions, most used first. */
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
