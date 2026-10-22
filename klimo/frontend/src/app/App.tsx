import { Suspense, lazy, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { AppShell, BottomTabBar, IconButton, Link, OverlayPanel, Row, TopBar, UiProvider, type UiNav } from '@ui';
import { LogoMark, Wordmark, brand } from '@brand';
import { t } from '@i18n';
import { liveStore, useHouse, useLayout, useMeta, useRoomSummaries, useRoomsLoaded } from '@data';
import { AppBanners, HouseSeasonPill } from './Chrome';
import { areaOf, desktopNav, phoneNav, phoneTabOf } from './nav';
import { RouteScope, bootRouter, href, navigate, parseRoute, paths, previousRoute, useRoute, type Route, type RouteName } from './router';
import { getPref, setPref } from './prefs';
import { useColorScheme } from './scheme';

type Page = ComponentType;

const Pages = {
  overview: lazy(() => import('../pages/overview')),
  rooms: lazy(() => import('../pages/rooms')),
  room: lazy(() => import('../pages/room')),
  wizard: lazy(() => import('../pages/wizard')),
  schedule: lazy(() => import('../pages/schedule')),
  system: lazy(() => import('../pages/system')),
  notifications: lazy(() => import('../pages/notifications')),
  devices: lazy(() => import('../pages/devices')),
  settings: lazy(() => import('../pages/settings')),
  journal: lazy(() => import('../pages/journal')),
  gallery: lazy(() => import('./GalleryPage')),
} satisfies Record<string, Page>;

type PageKey = keyof typeof Pages;

/** Which page entry renders a route (sub-routes are resolved inside the area entry). */
function pageFor(name: RouteName, phone: boolean): PageKey {
  switch (name) {
    case 'overview':
    case 'notFound':
      return 'overview';
    case 'rooms':
      return 'rooms';
    case 'wizard':
      return 'wizard';
    case 'room':
    case 'roomSettings':
      return 'room';
    case 'schedule':
    case 'scheduleProfiles':
    case 'scheduleProfile':
    case 'schedulePriority':
      return 'schedule';
    case 'journal':
      return phone ? 'journal' : 'system';
    case 'system':
    case 'sources':
    case 'source':
    case 'strategy':
      return 'system';
    case 'notifications':
      return 'notifications';
    case 'devices':
    case 'device':
      return 'devices';
    case 'settings':
      return 'settings';
    case 'gallery':
      return 'gallery';
  }
}

function RoutedPage({ route, phone }: { route: Route; phone: boolean }) {
  const Page = Pages[pageFor(route.name, phone)];
  return (
    <RouteScope route={route}>
      <Page />
    </RouteScope>
  );
}

/** Desktop `#/rooms` opens the last visited room, or the first one. */
function useRoomsRedirect(route: Route, phone: boolean): void {
  const rooms = useRoomSummaries();
  const loaded = useRoomsLoaded();
  useEffect(() => {
    if (route.name === 'room' || route.name === 'roomSettings') setPref('lastRoom', route.params.id ?? null);
  }, [route]);
  useEffect(() => {
    if (phone || route.name !== 'rooms' || !loaded || !rooms.length) return;
    const last = getPref('lastRoom');
    const target = rooms.find((r) => r.id === last || r.slug === last) ?? rooms[0];
    navigate(paths.room(target.id), { replace: true });
  }, [phone, route.name, loaded, rooms]);
}

export function App() {
  const route = useRoute();
  const layout = useLayout();
  const phone = layout === 'phone';
  const house = useHouse();
  const meta = useMeta();
  const simulated = Boolean(meta.data?.simulated ?? house?.engine.simulated);
  useRoomsRedirect(route, phone);

  // the developer gallery exists in development and in the simulator only
  const galleryAllowed = import.meta.env.DEV || simulated;
  useEffect(() => {
    if (route.name === 'notFound') navigate('/', { replace: true, force: true });
    else if (route.name === 'gallery' && meta.settled && !galleryAllowed) navigate('/', { replace: true, force: true });
  }, [route.name, meta.settled, galleryAllowed]);

  // the page behind the add-room panel on wide screens: wherever the user came from
  const background = useRef<Route>(parseRoute('/'));
  if (route.name !== 'wizard') background.current = route;
  const overlay = route.name === 'wizard' && !phone;
  const closeOverlay = () => {
    const prev = previousRoute();
    navigate(prev && prev.name !== 'wizard' ? prev.path : background.current.path);
  };

  const top = phone ? null : (
    <TopBar
      logo={
        <Link to="/" ariaLabel={t('{product}, overview', { product: brand.productName })}>
          <Row gap="sm">
            <LogoMark size={32} />
            <Wordmark size={19} />
          </Row>
        </Link>
      }
      items={desktopNav(house)}
      current={areaOf(route)}
      right={
        <>
          <HouseSeasonPill house={house} />
          <IconButton icon="settings" label={t('Settings')} to={paths.settings()} variant="ghost" />
        </>
      }
    />
  );
  // the phone wizard is full screen, without the tab bar — and without banners pushing its buttons off the screen
  const phoneWizard = phone && route.name === 'wizard';
  const bottom = phone && !phoneWizard ? <BottomTabBar items={phoneNav(house)} current={phoneTabOf(route)} /> : undefined;

  return (
    <AppShell top={top} bottom={bottom} banner={phoneWizard ? undefined : <AppBanners house={house} simulated={simulated} />}>
      <Suspense fallback={null}>
        {/* the page keeps its place in the tree, so opening the panel does not reset it */}
        <RoutedPage key="page" route={overlay ? background.current : route} phone={phone} />
        {overlay ? (
          <OverlayPanel open onClose={closeOverlay} label={t('Add a room')} maxWidth={560}>
            <RoutedPage route={route} phone={phone} />
          </OverlayPanel>
        ) : null}
      </Suspense>
    </AppShell>
  );
}

/** Providers around the app: brand theme, resolved scheme, translations and navigation. */
export function Root() {
  const { scheme } = useColorScheme();
  const nav = useMemo<UiNav>(() => ({ href, navigate: (to, opts) => void navigate(to, opts) }), []);
  useEffect(() => {
    bootRouter();
    liveStore.start();
  }, []);
  return (
    <UiProvider brand={brand} scheme={scheme} ut={t} nav={nav}>
      <App />
    </UiProvider>
  );
}
