import type { CircuitDto, HouseState, PlantState, SourceDto, TodayDto } from '@api/model';
import { AutoGrid, Button, LoopTile, ProfileSwatch, RelativeTime, Row, RuntimeBar24h, Stack, StatTile, ToneBadge } from '@ui';
import { paths } from '@app';
import { fmtDur, fmtTemp, renderReason, startOfLocalDay, t, type CodeContext } from '@i18n';
import { energyLine, isRunning, profileOrigin, seasonBadge, sourcesTile } from './house';
import type { ProfileSwitch } from './useProfileSwitch';

interface Props {
  house: HouseState;
  plant: PlantState | null;
  today: TodayDto | null;
  sources: readonly SourceDto[] | undefined;
  circuits: readonly CircuitDto[] | undefined;
  sw: ProfileSwitch;
  ctx: CodeContext;
}

function SourcesTile({ house, plant, today, sources, ctx }: Props) {
  const tile = sourcesTile(house, plant, sources, ctx);
  const track = today?.tracks.find((tr) => tr.key === `source:${tile.leadId}`);
  const stat = today?.stats.perSource.find((p) => p.sourceId === tile.leadId);
  const now = today?.now ?? house.now;
  const dayStart = today?.from ?? startOfLocalDay(now);
  const tone = track?.spans.some((s) => s.mode === 'cool') ? 'cool' : 'heat';
  const runtime = fmtDur(stat?.runtimeMin ?? 0);
  return (
    <StatTile
      title={t('Sources')}
      icon={tile.icon}
      dot={tile.dot}
      value={tile.name}
      sub={tile.sub}
      others={tile.others || undefined}
      to={paths.sources()}
      footer={
        tile.leadId ? (
          <Stack gap="xs">
            <RuntimeBar24h
              spans={(track?.spans ?? []).map((s) => ({ start: s.from, end: s.to }))}
              tone={tone}
              dayStart={dayStart}
              dayEnd={today?.to}
              now={now}
              ariaLabel={t('Ran today for {dur}', { dur: runtime })}
            />
            <Row justify="between">
              <RelativeTime text={t('today')} title={t('Since midnight')} />
              <RelativeTime text={runtime} title={t('Ran today for {dur}', { dur: runtime })} />
            </Row>
          </Stack>
        ) : undefined
      }
    />
  );
}

function LoopsTile({ plant, circuits, ctx }: Props) {
  const states = plant?.circuits ?? [];
  const pumps = [...states.flatMap((c) => c.pumps), ...(plant?.manifoldPumps ?? [])];
  const running = pumps.filter((p) => p.on).length;
  const name = (id: string) => {
    const c = circuits?.find((x) => x.config.id === id)?.config;
    return c ? c.shortName || c.name : (ctx.circuit?.(id) ?? id);
  };
  const busy = states.filter((c) => c.pumpOn || c.mode !== 'none');
  const sub = busy
    .slice(0, 2)
    .map((c) => {
      const rooms = c.requestingRoomIds.map((id) => ctx.room?.(id) ?? id);
      const what = rooms.length ? t('for {rooms}', { rooms: rooms.join(', ') }) : renderReason(c.state, ctx).toLowerCase();
      return `${name(c.circuitId).toLowerCase()} — ${what}`;
    })
    .join(' · ');
  const value = !states.length ? t('No circuits') : running > 0 ? t('{count} pumps are running', { count: running }) : t('Pumps are off');
  const cooling = states.some((c) => c.mode === 'cool');
  return (
    <StatTile
      title={t('Circuits and pumps')}
      icon="pumps"
      dot={{ tone: running > 0 ? (cooling ? 'cool' : 'hold') : 'off', glow: running > 0 }}
      value={value}
      sub={sub || (states.length ? t('nobody asks for heat') : t('Radiators and floors are added on the system page'))}
      to={paths.system()}
      footer={
        states.length ? (
          <Row gap="sm" wrap>
            {states.map((c) => (
              <LoopTile
                key={c.circuitId}
                dotTone={c.mode === 'cool' ? 'cool' : c.pumpOn ? 'hold' : 'off'}
                name={name(c.circuitId).toLowerCase()}
                on={c.pumpOn}
              />
            ))}
          </Row>
        ) : undefined
      }
    />
  );
}

function OutdoorTile({ house }: Props) {
  const s = house.season;
  const badge = seasonBadge(house);
  return (
    <StatTile
      title={t('Outdoor')}
      icon="thermometer"
      value={fmtTemp(s.outdoorC)}
      sub={
        s.avgC != null
          ? t('{count}-day average {t}', { count: s.rule.avgDays, t: fmtTemp(s.avgC) })
          : s.outdoorSource === 'none'
            ? t('no outdoor sensor')
            : undefined
      }
      to={paths.system()}
      footer={<ToneBadge tone={badge.tone}>{badge.text}</ToneBadge>}
    />
  );
}

function EnergyTile({ plant, ctx }: Props) {
  const e = plant?.energy;
  if (!e || !e.configured) {
    return (
      <StatTile
        title={t('Energy')}
        icon="bolt"
        value={t('Not set up')}
        sub={t('Grid, solar and battery sensors let heating plan around blackouts.')}
        to={paths.strategy()}
      />
    );
  }
  const value = e.grid === 'present' ? t('Grid is on') : e.grid === 'absent' ? t('No grid') : t('Grid unknown');
  const dot = e.phase === 'critical' ? 'err' : e.grid === 'absent' ? 'warn' : e.grid === 'present' ? 'ok' : 'off';
  return (
    <StatTile
      title={t('Energy')}
      icon="bolt"
      dot={{ tone: dot, glow: false }}
      value={value}
      sub={energyLine(plant) || undefined}
      to={paths.strategy()}
      emphasis={e.grid === 'absent' ? 'warn' : undefined}
      footer={
        e.note ? <ToneBadge tone={e.phase === 'critical' ? 'err' : e.phase === 'normal' ? 'hold' : 'warn'}>{renderReason(e.note, ctx)}</ToneBadge> : undefined
      }
    />
  );
}

function ProfileTile({ house, sw, ctx }: Props) {
  const id = house.profile.activeProfileId;
  const profile = sw.profiles.find((p) => p.id === id);
  const name = profile?.name ?? ctx.profile?.(id) ?? id;
  return (
    <StatTile
      title={t('House profile')}
      icon="home"
      value={
        <>
          {profile ? <ProfileSwatch color={profile.color} size={12} shape="round" /> : null}
          {name}
        </>
      }
      sub={profileOrigin(house, ctx)}
      footer={
        <Row gap="sm" wrap>
          <Button variant="secondary" size="sm" onClick={sw.open ? sw.close : sw.openPanel}>
            {t('Change profile')}
          </Button>
          {sw.overridden ? (
            <Button variant="link" size="sm" onClick={sw.resume} loading={sw.resuming}>
              {t('Back to schedule')}
            </Button>
          ) : null}
        </Row>
      }
    />
  );
}

/** «Стан системи»: sources, circuits, outdoor, energy and the house profile. */
export function SystemTiles(props: Props) {
  return (
    <AutoGrid min={236} gap="md" ariaLabel={t('System state')}>
      <SourcesTile {...props} />
      <LoopsTile {...props} />
      <OutdoorTile {...props} />
      <EnergyTile {...props} />
      <ProfileTile {...props} />
    </AutoGrid>
  );
}

/** Running sources right now, for the phone summary line. */
export function runningSummary(plant: PlantState | null, ctx: CodeContext): string {
  if (!plant) return '';
  const running = plant.sources.filter(isRunning);
  const pumps = [...plant.circuits.flatMap((c) => c.pumps), ...plant.manifoldPumps].filter((p) => p.on).length;
  const parts = running.slice(0, 2).map((s) => `${ctx.source?.(s.sourceId) ?? s.sourceId} ${s.state === 'cooling' ? t('cools') : t('heats')}`);
  if (pumps > 0) parts.push(t('{count} pumps', { count: pumps }));
  return parts.join(' · ');
}
