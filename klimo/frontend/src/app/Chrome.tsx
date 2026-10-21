import type { HouseState } from '@api/model';
import { NotificationBell, SeasonPill, StatusBanner } from '@ui';
import { brand } from '@brand';
import { fmtAgo, houseModeLabel, seasonShortLabel, t } from '@i18n';
import { useConnection, useNow } from '@data';
import { paths } from './router';

/** «Авто · опалення» pill in the header; links to the System page. */
export function HouseSeasonPill({ house, variant = 'outline' }: { house: HouseState | null; variant?: 'outline' | 'filled' }) {
  if (!house) return null;
  const { season } = house;
  const tone = season.houseMode === 'off' ? 'off' : season.season === 'heating' ? 'heat' : season.season === 'cooling' ? 'cool' : 'off';
  const label =
    season.houseMode === 'auto' ? t('Auto · {season}', { season: seasonShortLabel(season.season) }) : houseModeLabel(season.houseMode);
  return <SeasonPill tone={tone} label={label} variant={variant} to={paths.system()} />;
}

/** The phone header bell: live count of the inbox, opens the notifications. */
export function InboxBell({ house }: { house: HouseState | null }) {
  const count = house?.inboxCount ?? 0;
  const label = count > 0 ? t('Notifications, {count} new', { count }) : t('Notifications');
  return <NotificationBell count={count} to={paths.notifications()} label={label} />;
}

/**
 * Persistent banners above every page: the simulator, a lost live connection, Home Assistant
 * unreachable, unconvertible units, and the short watch-only phase after a start.
 */
export function AppBanners({ house, simulated }: { house: HouseState | null; simulated: boolean }) {
  const conn = useConnection();
  // re-render every 30 s so «оновлено N хв тому» stays true
  useNow(30_000);
  const product = brand.productName;
  const out: JSX.Element[] = [];

  if (simulated) {
    out.push(
      <StatusBanner
        key="sim"
        tone="event"
        icon="sparkle"
        text={t('Simulator — a virtual house; nothing real is switched.')}
        action={{ label: t('Simulator controls'), to: paths.settings() }}
      />,
    );
  }
  if (conn.status === 'closed') {
    out.push(
      <StatusBanner
        key="socket"
        tone="warn"
        icon="offline"
        text={
          conn.everConnected && conn.lastUpdateAt
            ? t('No live connection to {product} · updated {ago}', { product, ago: fmtAgo(conn.lastUpdateAt) })
            : t('Connecting to {product}…', { product })
        }
      />,
    );
  }
  if (house && !house.engine.haConnected) {
    out.push(<StatusBanner key="ha" tone="err" icon="offline" text={t('{product} is not connected to Home Assistant', { product })} />);
  }
  if (house && !house.engine.unitsOk) {
    out.push(
      <StatusBanner
        key="units"
        tone="err"
        icon="thermometer"
        text={t('Home Assistant reports temperatures in units that cannot be converted — control is paused.')}
      />,
    );
  }
  if (house && house.engine.health === 'dry_run') {
    out.push(<StatusBanner key="dry" tone="event" icon="eye" text={t('Just started — checking every device before switching anything.')} />);
  }
  return out.length ? <>{out}</> : null;
}
