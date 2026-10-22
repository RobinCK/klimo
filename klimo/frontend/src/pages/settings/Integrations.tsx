/**
 * «Інтеграції»: the links everything else depends on — MQTT (room entities, dashboard cards),
 * the Home Assistant connection, and the Lovelace card bundle with ready YAML for each card.
 */
import { useState } from 'react';
import type { HaStatusDto, RoomSummary, SettingsBundle } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { Button, CodeBlock, KeyValueList, Row, Section, Select, Skeleton, Stack, StatusBanner } from '@ui';
import { t } from '@i18n';

type CardKind = 'room' | 'rooms' | 'thermostat' | 'house' | 'system';

function cardYaml(kind: CardKind, room: RoomSummary | undefined): string {
  const roomRef = room?.slug ?? 'living';
  switch (kind) {
    case 'room':
      return ['type: custom:klimo-room-card', `room: ${roomRef}`, 'variant: card', 'show_sparkline: true'].join('\n');
    case 'rooms':
      return ['type: custom:klimo-rooms-card', 'rooms: all', 'variant: compact', 'sort: attention_first'].join('\n');
    case 'thermostat':
      return ['type: custom:klimo-thermostat-card', 'rooms: all', 'controls: direct', 'durations: [slot, 1h, 3h, forever]', 'quick_actions: [boost, airing]'].join('\n');
    case 'house':
      return ['type: custom:klimo-house-card', 'show_profile: true', 'profile_change: confirm', 'show_system: [source, pumps, outdoor]'].join('\n');
    case 'system':
      return ['type: custom:klimo-system-card', 'show: [sources, circuits, energy, triggers]'].join('\n');
  }
}

function cardLabel(kind: CardKind): string {
  switch (kind) {
    case 'room':
      return t('One room');
    case 'rooms':
      return t('All rooms');
    case 'thermostat':
      return t('Thermostat');
    case 'house':
      return t('House');
    case 'system':
      return t('System');
  }
}

function lovelaceText(l: SettingsBundle['lovelace']): { tone: 'ok' | 'warn' | 'err'; text: string } {
  if (l.resource === 'error') return { tone: 'err', text: t('Could not install the cards — see the add-on log.') };
  if (l.resource === 'simulated') {
    const path = l.path ?? '/card/klimo-cards.js';
    return { tone: 'ok', text: t('Simulator: the add-on serves the cards itself at {path}; nothing is copied to Home Assistant.', { path }) };
  }
  if (l.resource === 'unsupported') return { tone: 'warn', text: t('Dashboards are in YAML mode: add the resource {path} (module) by hand.', { path: l.path ?? '/local/klimo-cards.js' }) };
  if (l.deployed) return { tone: 'ok', text: l.path ? t('Cards installed · resource {path}', { path: l.path }) : t('Cards installed') };
  return { tone: 'warn', text: t('The cards are not installed yet.') };
}

export function IntegrationsSection({
  bundle,
  ha,
  rooms,
  canEdit,
  onLovelace,
}: {
  bundle: SettingsBundle;
  ha: HaStatusDto | undefined;
  rooms: readonly RoomSummary[];
  canEdit: boolean;
  onLovelace: (l: SettingsBundle['lovelace']) => void;
}) {
  const [card, setCard] = useState<CardKind>('room');
  const redeploy = useMutation(api.settings.redeployLovelace, { onSuccess: (l) => l && onLovelace(l), okToast: t('Cards installed again') });
  const mqtt = bundle.mqtt;
  const lovelace = lovelaceText(bundle.lovelace);

  return (
    <Section title={t('Integrations')} icon="plug">
      <Stack gap="lg">
        <Section title={t('MQTT')} variant="plain" level={3}>
          <Stack gap="sm">
            <StatusBanner
              tone={mqtt.connected ? 'ok' : mqtt.configured ? 'err' : 'warn'}
              icon={mqtt.connected ? 'checkCircle' : 'offline'}
              text={
                mqtt.connected
                  ? t('Connected · {count} entities in Home Assistant', { count: mqtt.publishedEntities })
                  : mqtt.configured
                    ? t('No connection to the broker: {detail}', { detail: mqtt.detail ?? '—' })
                    : t('MQTT is not set up: rooms do not appear as Home Assistant entities and the dashboard cards stay empty.')
              }
            />
            <KeyValueList
              rows={[
                { key: t('Broker'), value: mqtt.broker ?? '—', mono: true },
                {
                  key: t('Found through'),
                  value:
                    mqtt.source === 'supervisor'
                      ? t('the Mosquitto add-on')
                      : mqtt.source === 'options'
                        ? t('the add-on options')
                        : mqtt.source === 'simulator'
                          ? t('the simulator')
                          : '—',
                },
              ]}
            />
          </Stack>
        </Section>

        <Section title={t('Home Assistant')} variant="plain" level={3}>
          {ha ? (
            <KeyValueList
              rows={[
                { key: t('Connection'), value: ha.connected ? t('connected') : t('no connection') },
                { key: t('Version'), value: ha.version ?? '—' },
                { key: t('Time zone'), value: ha.tz, mono: true },
                { key: t('Units'), value: ha.unitSystem === 'us_customary' ? t('imperial (°F)') : ha.unitSystem === 'metric' ? t('metric (°C)') : '—' },
                { key: t('Entities'), value: String(ha.statesCount) },
              ]}
            />
          ) : (
            <Skeleton height={160} radius={12} />
          )}
        </Section>

        <Section
          title={t('Dashboard cards')}
          variant="plain"
          level={3}
          action={
            // the simulator has no Home Assistant config folder to copy the bundle into
            canEdit && bundle.lovelace.resource !== 'simulated' ? (
              <Button variant="secondary" size="sm" icon="sync" loading={redeploy.pending} onClick={() => void redeploy.run()}>
                {t('Install again')}
              </Button>
            ) : undefined
          }
        >
          <Stack gap="sm">
            <StatusBanner tone={lovelace.tone} icon={lovelace.tone === 'ok' ? 'checkCircle' : 'alert'} text={lovelace.text} />
            <Row gap="sm" wrap>
              <Select<CardKind>
                ariaLabel={t('Card')}
                size="sm"
                value={card}
                options={(['room', 'rooms', 'thermostat', 'house', 'system'] as const).map((k) => ({ value: k, label: cardLabel(k) }))}
                onChange={setCard}
              />
            </Row>
            <CodeBlock code={cardYaml(card, rooms[0])} ariaLabel={t('Card configuration')} />
          </Stack>
        </Section>
      </Stack>
    </Section>
  );
}
