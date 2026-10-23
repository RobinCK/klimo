/**
 * The system on a phone: a status page. The house mode (with a confirmation that says what
 * changes), the sources and loops as they run now, the energy line, the triggers, and the rows
 * that lead to devices, notifications, the journal and the settings.
 */
import type { SourceDto, SourceState, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useLiveEvent, useResource } from '@data';
import { InboxBell, navigate, paths } from '@app';
import { AutoGrid, DashedAddButton, LoopTile, MobileTopBar, Row, RowList, Section, SourceRow, Stack } from '@ui';
import { fmtClock, fmtTemp, renderJournal, renderReason, t } from '@i18n';
import { useState } from 'react';
import type { Id } from '@api/model';
import { CircuitsSection } from './Circuits';
import { HouseModeSection } from './HouseMode';
import { ManifoldDrawer, ManifoldsSection, useManifolds } from './Manifolds';
import { EnergyLine, whenLine } from './Schema';
import { isRunning, SOURCE_ICON, sourceChip, sourceMeta, type SystemData } from './shared';

/** Room air conditioners collapse into one row («Кондиціонери · 3»). */
function sourceRows(d: SystemData) {
  const list = d.sources.data ?? [];
  const acs = list.filter((s) => s.config.kind === 'ac' && s.config.scope === 'room');
  const rows: { key: string; dto: SourceDto; name: string; count: number }[] = [];
  for (const s of list) {
    if (acs.length > 1 && acs.includes(s)) {
      if (s === acs[0]) rows.push({ key: 'acs', dto: s, name: t('Air conditioners · {count}', { count: acs.length }), count: acs.length });
      continue;
    }
    rows.push({ key: s.config.id, dto: s, name: d.nameOf(s.config.id), count: 1 });
  }
  return { rows, acs };
}

/** The short chip of a phone row: «Чекає» leaves room for the source's name; the row says what it waits for. */
function phoneChip(state: SourceState): { tone: Tone; label: string } {
  const chip = sourceChip(state);
  return state.state === 'waiting_trigger' && chip.tone !== 'err' ? { ...chip, label: t('Waiting') } : chip;
}

export function PhoneStatus({ d }: { d: SystemData }) {
  const triggers = useResource('names:triggers', api.triggers.list, { reloadOn: ['trigger'] });
  const journal = useResource('journal:last', () => api.journal({ limit: 1 }));
  useLiveEvent('journal', () => void journal.reload());
  const { rows, acs } = sourceRows(d);
  const house = d.house;
  const energy = d.plant?.energy ?? null;
  const circuits = d.circuits.data ?? [];
  const manifoldList = useManifolds().manifolds;
  const manifolds = manifoldList.data ?? [];
  // without a manifold an editor gets the way to add one right here, not only behind a circuit tile
  const [addingManifold, setAddingManifold] = useState(false);
  const last = journal.data?.items[0] ?? null;
  const devices = house?.deviceIssuesCount ?? 0;
  const inbox = house?.inboxCount ?? 0;

  const acChip = (): { tone: Tone; label: string } => {
    const live = acs.map((s) => d.liveState(s.config.id));
    const running = live.filter((s) => isRunning(s)).length;
    if (running) return { tone: live.some((s) => s?.mode === 'cool') ? 'cool' : 'heat', label: t('{count} running', { count: running }) };
    return sourceChip(live[0] ?? null);
  };

  return (
    <Stack gap="lg">
      <MobileTopBar
        title={t('System')}
        subtitle={house ? { text: whenLine(house.now, house.season.outdoorC, house.now) } : undefined}
        right={<InboxBell house={house} />}
      />
      <HouseModeSection d={d} short />

      <Section variant="plain" level={3} overline={t('Sources')}>
        <RowList ariaLabel={t('Sources')}>
          {rows.map(({ key, dto, name, count }) => {
            const state = d.liveState(dto.config.id) ?? dto.state;
            return (
              <SourceRow
                key={key}
                icon={SOURCE_ICON[dto.config.kind]}
                name={name}
                meta={count > 1 ? renderReason(dto.state.roleReason, d.ctx) : sourceMeta({ ...dto, state }, d.ctx)}
                chip={count > 1 ? acChip() : phoneChip(state)}
                on={count > 1 ? acs.some((s) => isRunning(d.liveState(s.config.id))) : isRunning(state)}
                to={count > 1 ? paths.sources() : paths.source(dto.config.id)}
              />
            );
          })}
        </RowList>
      </Section>

      {circuits.length ? (
        <Section variant="plain" level={3} overline={t('Circuits & pumps')}>
          {/* a tile opens the circuits with their modes, pumps and rooms */}
          <Stack gap="sm">
            <AutoGrid min={150} columns={2} gap="sm">
              {manifolds.map((m) => {
                const pump = d.plant?.manifoldPumps.find((p) => p.manifoldId === m.id);
                const tone = d.plant?.manifolds.find((x) => x.manifoldId === m.id)?.tone ?? 'idle';
                return (
                  <LoopTile
                    key={m.id}
                    dotTone={pump?.on ? tone : 'off'}
                    name={m.name}
                    state={pump ? (pump.on ? t('Pump running') : t('Pump stopped')) : t('No pump')}
                    sub={m.sourceIds.map(d.nameOf).join(', ') || undefined}
                    on={!!pump?.on}
                    to={paths.system({ section: 'circuits' })}
                  />
                );
              })}
              {circuits.map((c) => {
                const live = d.plant?.circuits.find((x) => x.circuitId === c.config.id) ?? c.state;
                const requesting = live.requestingRoomIds.map((id) => d.roomName(id) ?? id);
                const sub =
                  live.runOnUntil && live.runOnUntil > d.now
                    ? t('run-on until {time}', { time: fmtClock(live.runOnUntil, d.now) })
                    : requesting.length
                      ? requesting.join(', ')
                      : renderReason(live.state, d.ctx);
                return (
                  <LoopTile
                    key={c.config.id}
                    dotTone={live.pumpOn ? live.tone : 'off'}
                    name={c.config.shortName || c.config.name}
                    state={live.pumpOn ? t('Pump running') : t('Pump stopped')}
                    sub={sub}
                    on={live.pumpOn}
                    to={paths.system({ section: 'circuits' })}
                  />
                );
              })}
            </AutoGrid>
            {manifoldList.settled && !manifolds.length && d.canEdit ? <DashedAddButton label={t('Add a manifold')} onClick={() => setAddingManifold(true)} /> : null}
          </Stack>
        </Section>
      ) : d.circuits.settled && d.canEdit ? (
        <RowList ariaLabel={t('Circuits & pumps')}>
          <SourceRow
            icon="pumps"
            name={t('Circuits & pumps')}
            meta={t('No circuits yet')}
            chip={{ tone: 'hold', label: t('Open') }}
            on={false}
            to={paths.system({ section: 'circuits' })}
          />
        </RowList>
      ) : null}

      {energy ? <EnergyLine energy={energy} ctx={d.ctx} compact /> : null}

      {triggers.data?.length ? (
        <Section variant="plain" level={3} overline={t('Triggers')}>
          <Row gap="xs" wrap>
            {triggers.data.map((x) => {
              const s = d.plant?.triggers.find((y) => y.triggerId === x.config.id) ?? x.state;
              const value =
                s.nextChangeAt && !s.active
                  ? t('from {time}', { time: fmtClock(s.nextChangeAt, d.now) })
                  : s.active
                    ? t('yes')
                    : typeof s.value === 'number' && x.config.condition.op === 'outdoor'
                      ? fmtTemp(s.value)
                      : t('no');
              return (
                <LoopTile
                  key={x.config.id}
                  dotTone={!x.config.enabled ? 'off' : s.active ? 'event' : s.nextChangeAt ? 'event' : 'off'}
                  name={`${x.config.name} — ${x.config.enabled ? value : t('off')}`}
                  on={s.active}
                />
              );
            })}
          </Row>
        </Section>
      ) : null}

      <RowList ariaLabel={t('More')}>
        <SourceRow
          icon="zigbee"
          name={t('Devices')}
          meta={devices ? t('{count} need attention', { count: devices }) : t('All devices are fine')}
          chip={devices ? { tone: 'warn', label: String(devices) } : { tone: 'ok', label: t('fine') }}
          on={false}
          to={paths.devices()}
        />
        <SourceRow
          icon="bell"
          name={t('Notifications')}
          meta={inbox ? t('{count} new', { count: inbox }) : t('Nothing new')}
          chip={inbox ? { tone: 'warn', label: String(inbox) } : { tone: 'hold', label: '0' }}
          on={false}
          to={paths.notifications()}
        />
        <SourceRow
          icon="gauge"
          name={t('Consumption')}
          meta={t('What the sources and the pumps used')}
          chip={{ tone: 'hold', label: t('Open') }}
          on={false}
          to={paths.energy()}
        />
        <SourceRow
          icon="list"
          name={t('Decision journal')}
          meta={last ? `${fmtClock(last.ts, d.now)} · ${renderJournal(last, d.ctx)}` : t('What the system did and why')}
          chip={{ tone: 'hold', label: t('Open') }}
          on={false}
          to={paths.journal()}
        />
        <SourceRow
          icon="settings"
          name={t('Settings')}
          meta={t('House, units, integrations, backup')}
          chip={{ tone: 'hold', label: t('Open') }}
          on={false}
          to={paths.settings()}
        />
      </RowList>
      {addingManifold ? <ManifoldDrawer d={d} id={null} onClose={() => setAddingManifold(false)} /> : null}
    </Stack>
  );
}

/** The circuits on a phone: the same cards as on the system page, under a bar that leads back. */
export function PhoneCircuits({ d }: { d: SystemData }) {
  const [manifold, setManifold] = useState<{ id: Id | null } | null>(null);
  return (
    <Stack gap="lg">
      <MobileTopBar title={t('Circuits & pumps')} onBack={() => navigate(paths.system())} />
      <ManifoldsSection d={d} phone onEdit={(id) => setManifold({ id })} />
      <CircuitsSection d={d} phone />
      {manifold ? <ManifoldDrawer d={d} id={manifold.id} onClose={() => setManifold(null)} /> : null}
    </Stack>
  );
}
