import type { AcControl, Emitter, EmitterDevice, EmitterState, SourceConfig } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation } from '@data';
import { AutoGrid, Button, CheckboxRow, EmitterRow, FallbackNote, SegmentedControl, Section, Stack } from '@ui';
import { paths } from '@app';
import { brand } from '@brand';
import { acControlHint, acControlLabel, emitterRoleLabel, fmtDelta, fmtPct, t } from '@i18n';
import { lockable } from './readonly';
import type { SectionDef, SectionProps } from './types';

type RoomEmitter = Emitter & { devices: EmitterDevice[] };

const EXCLUDED: Record<NonNullable<EmitterState['excluded']>, () => string> = {
  dew: () => t('paused: dew point'),
  humid: () => t('paused: too humid'),
  season: () => t('off for the season'),
  disabled: () => t('switched off'),
  floor_limit: () => t('paused: the floor is at its limit'),
  heat_only: () => t('heating only'),
};

function climateEntity(src: SourceConfig | undefined): string | undefined {
  return src && src.adapter.type === 'climate' ? (src.adapter.climate ?? undefined) : undefined;
}

function sourcesOf(p: SectionProps, e: RoomEmitter, mode: 'heat' | 'cool'): string {
  const row = p.room.servedBy.find((s) => s.emitterId === e.id && s.mode === mode);
  const names = (row?.sourceIds ?? []).map((id) => p.ctx.source?.(id) ?? id);
  return names.length ? t('from {sources}', { sources: names.join(', ') }) : '';
}

/** An air conditioner (or any room device) that can heat but is not the room's main heating. */
function canAssist(p: SectionProps, e: RoomEmitter): boolean {
  if (e.kind !== 'direct' || !e.sourceId) return false;
  const src = p.room.roomSources.find((s) => s.id === e.sourceId);
  return Boolean(src?.capabilities.heat) && e.roles.heat !== 'primary' && e.roles.heat !== 'reserve' && e.roles.heat !== 'trigger';
}

function Body(p: SectionProps) {
  const { room, state } = p;
  const emitters = [...room.emitters].sort((a, b) => a.order - b.order);
  const stateOf = (e: Emitter) => state.emitters.find((x) => x.emitterId === e.id);
  const blocked = (e: Emitter) => {
    const ex = stateOf(e)?.excluded;
    return ex ? EXCLUDED[ex]() : undefined;
  };
  const patchEmitter = useMutation(
    (e: RoomEmitter, on: boolean) =>
      api.rooms.emitters.patch(room.config.id, e.id, {
        roles: { ...e.roles, heat: on ? 'assist' : null },
        assist: on ? (e.assist ?? { deficitC: 1.5 }) : e.assist,
      }),
    {
      onSuccess: (r) => p.setRoom(r),
    },
  );
  const ac = useAutosave(room.config.ac, (v) => p.save({ ac: v }));
  const controlled = useMutation((on: boolean) => p.save({ controlEnabled: on }));
  const heat = emitters.filter((e) => e.roles.heat != null && e.roles.heat !== 'assist');
  const assist = emitters.filter((e) => canAssist(p, e));
  const cool = emitters.filter((e) => e.roles.cool != null);
  const hasAc = room.roomSources.some((s) => s.adapter.type === 'climate' && (s.capabilities.cool || s.capabilities.heat));
  const srcOf = (e: RoomEmitter) => room.roomSources.find((s) => s.id === e.sourceId);
  const control: { value: AcControl; label: string; disabled?: boolean }[] = lockable(
    (['target', 'onoff', 'asis'] as const).map((v) => ({ value: v, label: acControlLabel(v) })),
    p.canEdit,
  );

  return (
    <Stack gap="md">
      <AutoGrid min={240} gap="md">
        <Section variant="well" accent="heat" overline={t('Space heating')} level={3}>
          <Stack gap="sm">
            {heat.map((e) => (
              <EmitterRow
                key={e.id}
                title={e.name}
                sub={sourcesOf(p, e, 'heat')}
                entityId={e.kind === 'direct' ? climateEntity(srcOf(e)) : undefined}
                role={{ label: emitterRoleLabel(e.roles.heat ?? 'primary').toLowerCase(), tone: 'heat' }}
                blocked={blocked(e)}
              />
            ))}
            {assist.map((e) => (
              <CheckboxRow
                key={e.id}
                variant="well"
                checked={e.roles.heat === 'assist'}
                disabled={!p.canEdit || patchEmitter.pending}
                title={t('{name} — top-up heat', { name: srcOf(e)?.name ?? e.name })}
                hint={t('when the room is more than {delta} short of its target', { delta: fmtDelta(e.assist?.deficitC ?? 1.5) })}
                onChange={(on) => void patchEmitter.run(e, on)}
              />
            ))}
            {!heat.length && !assist.length ? <FallbackNote icon="info" text={t('Nothing in this room can heat.')} /> : null}
          </Stack>
        </Section>
        <Section variant="well" accent="cool" overline={t('Space cooling')} level={3}>
          <Stack gap="sm">
            {cool.map((e) => (
              <EmitterRow
                key={e.id}
                title={e.kind === 'direct' ? (srcOf(e)?.name ?? e.name) : e.name}
                sub={e.kind === 'direct' ? undefined : sourcesOf(p, e, 'cool')}
                entityId={e.kind === 'direct' ? climateEntity(srcOf(e)) : undefined}
                role={{ label: emitterRoleLabel(e.roles.cool ?? 'primary').toLowerCase(), tone: 'cool' }}
                blocked={blocked(e)}
              />
            ))}
            {!cool.length ? <FallbackNote icon="info" text={t('Nothing in this room can cool.')} /> : null}
            {hasAc ? (
              <Stack gap="sm">
                <Section variant="plain" level={3} title={t('How to control the air conditioner')} />
                <SegmentedControl
                  value={ac.value.control}
                  options={control}
                  onChange={(v) => ac.set((x) => ({ ...x, control: v }))}
                  surface="well"
                  ariaLabel={t('How to control the air conditioner')}
                  hint={acControlHint(ac.value.control)}
                />
                <CheckboxRow
                  checked={ac.value.quietNight.enabled}
                  disabled={!p.canEdit}
                  title={t('Quiet fan at night')}
                  hint={t('from {from} to {to} — the lowest fan speed', { from: ac.value.quietNight.from, to: ac.value.quietNight.to })}
                  onChange={(on) => ac.set((x) => ({ ...x, quietNight: { ...x.quietNight, enabled: on } }))}
                />
                <CheckboxRow
                  checked={ac.value.dry.enabled}
                  disabled={!p.canEdit}
                  title={t('Dry the air above {pct}', { pct: fmtPct(ac.value.dry.abovePct) })}
                  hint={t('when the temperature is already in range')}
                  onChange={(on) => ac.set((x) => ({ ...x, dry: { ...x.dry, enabled: on } }))}
                />
              </Stack>
            ) : null}
          </Stack>
        </Section>
      </AutoGrid>
      <CheckboxRow
        variant="divided"
        checked={room.config.controlEnabled}
        disabled={!p.canEdit || controlled.pending}
        title={t('{product} controls this room', { product: brand.productName })}
        hint={t('Switch off to only watch the temperature: nothing in the room is driven.')}
        onChange={(on) => void controlled.run(on)}
      />
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const heat = p.room.emitters.filter((e) => e.roles.heat === 'primary' || e.roles.heat === 'reserve').map((e) => e.name);
  const cool = p.room.emitters.filter((e) => e.roles.cool != null).map((e) => p.room.roomSources.find((s) => s.id === e.sourceId)?.name ?? e.name);
  const assist = p.room.emitters.some((e) => e.roles.heat === 'assist');
  const parts: string[] = [];
  if (heat.length) parts.push(heat.join(', '));
  if (cool.length) parts.push(assist ? t('{names} — cooling and top-up', { names: cool.join(', ') }) : t('{names} — cooling', { names: cool.join(', ') }));
  return parts.join(' · ') || t('nothing heats or cools');
}

export const sourcesSection: SectionDef = {
  key: 'src',
  icon: 'heatPump',
  title: () => t('What heats and cools'),
  subtitle: (p) => t('The sources themselves live in «System». Here: which of them serve {room}.', { room: p.room.config.name }),
  summary,
  action: () => (
    <Button variant="secondary" size="sm" iconRight="chevronRight" to={paths.sources()}>
      {t('Sources')}
    </Button>
  ),
  Body,
};
