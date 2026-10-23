/**
 * Settings («Налаштування»): the house and its outdoor temperature, units and languages, how
 * the system behaves, the integrations it relies on, backups, the simulator (when it runs) and
 * what this is. Safety limits live on the System page, notification rules on Notifications.
 */
import type { SettingsBundle } from '@api/model';
import { api } from '@api/endpoints';
import { useLayout, useMe, useMeta, useResource, useRoomSummaries } from '@data';
import { navigate, paths } from '@app';
import { AutoGrid, Button, KeyValueList, MobileTopBar, Page, Row, Section, Skeleton, Stack, StatusBanner } from '@ui';
import { LogoMark, brand } from '@brand';
import { errorText, lang, t } from '@i18n';
import { BackupSection } from './Backup';
import { BehaviourSection, DisplaySection, HouseSection } from './General';
import { IntegrationsSection } from './Integrations';
import { openTab } from './links';
import { SimulatorSection } from './Simulator';
import { TariffsSection } from './Tariffs';

const RELOAD_ON = ['settings', 'safety', 'house', 'device_health'] as const;

function About({ version, haVersion, tz, simulated }: { version: string; haVersion: string | null; tz: string; simulated: boolean }) {
  return (
    <Section title={t('About')} icon="info">
      <Stack gap="md">
        <Row gap="md">
          <LogoMark size={48} />
          <KeyValueList
            rows={[
              { key: brand.productName, value: brand.tagline[lang()] },
              { key: t('Version'), value: simulated ? t('{version} · simulator', { version }) : version, mono: true },
              { key: t('Home Assistant'), value: haVersion ?? '—', mono: true },
              { key: t('Time zone'), value: tz, mono: true },
            ]}
          />
        </Row>
        <Row gap="sm" wrap>
          <Button variant="secondary" size="sm" iconRight="external" onClick={() => openTab(brand.links.docs)}>
            {t('Documentation')}
          </Button>
          <Button variant="ghost" size="sm" iconRight="external" onClick={() => openTab(brand.links.repo)}>
            {t('Source code')}
          </Button>
        </Row>
      </Stack>
    </Section>
  );
}

export default function SettingsPage(): JSX.Element {
  const phone = useLayout() === 'phone';
  const meta = useMeta();
  const me = useMe();
  const canEdit = me?.canEditConfig ?? false;
  const rooms = useRoomSummaries();
  const res = useResource('settings', api.settings.get, { reloadOn: RELOAD_ON });
  const ha = useResource('ha-status', api.ha.status);
  const bundle = res.data;
  const simulated = meta.data?.simulated ?? false;
  const onSaved = (b: SettingsBundle) => res.setData(b);

  const body = !bundle ? (
    res.error && res.settled ? (
      <StatusBanner tone="err" icon="alert" text={errorText(res.error) || t('Could not load the settings.')} action={{ label: t('Try again'), onClick: () => void res.reload() }} />
    ) : (
      <AutoGrid min={560} gap="xl">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={320} radius={20} />
        ))}
      </AutoGrid>
    )
  ) : (
    <Stack gap="xl">
      {!canEdit ? <StatusBanner tone="event" icon="lock" text={t('Only a Home Assistant administrator can change these settings.')} /> : null}
      {/* the simulator banner on every page leads here: its controls come first */}
      {simulated ? <SimulatorSection /> : null}
      <AutoGrid min={560} gap="xl">
        <HouseSection bundle={bundle} onSaved={onSaved} canEdit={canEdit} />
        <DisplaySection bundle={bundle} onSaved={onSaved} canEdit={canEdit} haUnits={meta.data?.haUnits ?? null} />
        <BehaviourSection bundle={bundle} onSaved={onSaved} canEdit={canEdit} />
        <TariffsSection bundle={bundle} onSaved={onSaved} canEdit={canEdit} />
        <IntegrationsSection bundle={bundle} ha={ha.data} rooms={rooms} canEdit={canEdit} onLovelace={(lovelace) => res.setData({ ...bundle, lovelace })} />
        <BackupSection canEdit={canEdit} />
        <About version={meta.data?.version ?? '—'} haVersion={meta.data?.haVersion ?? null} tz={meta.data?.tz ?? '—'} simulated={simulated} />
      </AutoGrid>
    </Stack>
  );

  return phone ? (
    <Stack gap="lg">
      <MobileTopBar title={t('Settings')} onBack={() => navigate(paths.system())} />
      {body}
    </Stack>
  ) : (
    <Page title={t('Settings')} subtitle={t('The house, units and languages, behaviour, integrations and backups.')}>
      {body}
    </Page>
  );
}
