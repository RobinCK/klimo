import type { HouseState } from '@api/model';
import type { NavItem } from '@ui';
import { t } from '@i18n';
import type { Route, RouteName } from './router';

export type AreaKey = 'overview' | 'rooms' | 'schedule' | 'system' | 'notifications' | 'devices' | 'settings' | 'dev';

const AREA: Record<RouteName, AreaKey> = {
  overview: 'overview',
  rooms: 'rooms',
  wizard: 'rooms',
  room: 'rooms',
  roomSettings: 'rooms',
  roomUse: 'rooms',
  schedule: 'schedule',
  scheduleProfiles: 'schedule',
  scheduleProfile: 'schedule',
  schedulePriority: 'schedule',
  system: 'system',
  sources: 'system',
  source: 'system',
  strategy: 'system',
  energy: 'system',
  journal: 'system',
  notifications: 'notifications',
  devices: 'devices',
  device: 'devices',
  settings: 'settings',
  gallery: 'dev',
  notFound: 'overview',
};

/** Which top-level section a route belongs to (the highlighted tab). */
export function areaOf(route: Route): AreaKey {
  return AREA[route.name];
}

/** On phones Devices, Notifications, the journal and Settings are rows of the System page. */
export function phoneTabOf(route: Route): AreaKey {
  const area = areaOf(route);
  return area === 'notifications' || area === 'devices' || area === 'settings' ? 'system' : area;
}

function devicesBadge(house: HouseState | null): NavItem['badge'] {
  const n = house?.deviceIssuesCount ?? 0;
  return n > 0 ? { count: n, tone: 'warn' } : undefined;
}

export function desktopNav(house: HouseState | null): NavItem[] {
  return [
    { key: 'overview', label: t('Overview'), icon: 'home', to: '/' },
    { key: 'rooms', label: t('Rooms'), icon: 'grid', to: '/rooms' },
    { key: 'schedule', label: t('Schedule'), icon: 'calendar', to: '/schedule' },
    { key: 'system', label: t('System'), icon: 'settings', to: '/system' },
    { key: 'notifications', label: t('Notifications'), icon: 'bell', to: '/notifications' },
    { key: 'devices', label: t('Devices'), icon: 'zigbee', to: '/devices', badge: devicesBadge(house) },
  ];
}

export function phoneNav(house: HouseState | null): NavItem[] {
  return [
    { key: 'overview', label: t('Overview'), icon: 'home', to: '/' },
    { key: 'rooms', label: t('Rooms'), icon: 'grid', to: '/rooms' },
    { key: 'schedule', label: t('Schedule'), icon: 'calendar', to: '/schedule' },
    { key: 'system', label: t('System'), icon: 'settings', to: '/system', badge: devicesBadge(house) },
  ];
}
