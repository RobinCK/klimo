/**
 * «Опалення»: the order in which central sources heat (the first whose conditions hold runs),
 * how a heat pump and a boiler share the work by outdoor temperature (bivalence), when the
 * boiler joins a heat pump that is not keeping up, and the extras in single rooms.
 */
import { useState } from 'react';
import type { BivalentMode, ChainEntry, HeatStrategy, StrategyDto } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation, useRoom } from '@data';
import { paths } from '@app';
import { AutoGrid, BivalenceChart, CheckboxRow, RadioCardList, Section, SegmentedControl, SortableList, Stack, StatusBanner, StatusChip, Stepper } from '@ui';
import { fmtDelta, fmtDur, fmtTemp, renderReason, t } from '@i18n';
import type { SystemData } from '../shared';
import { chainChip, type StrategyData } from './data';

const deg = (v: number) => fmtTemp(v, { decimals: 0 });

/** Role texts of the heat pump and the boiler for each way they work together. */
function pairWhen(mode: BivalentMode, p: number, l: number): [string, string] {
  switch (mode) {
    case 'alt':
      return [t('main, while it is not colder than {p} outside', { p: deg(p) }), t('below {p}, when the heat pump fails or cannot keep up', { p: deg(p) })];
    case 'parallel':
      return [t('heats in any weather'), t('below {p} — together with the heat pump; also when it fails', { p: deg(p) })];
    case 'partial':
      return [
        t('main down to {p}, together with the boiler down to {l}', { p: deg(p), l: deg(l) }),
        t('below {p} — with the heat pump, below {l} — alone', { p: deg(p), l: deg(l) }),
      ];
  }
}

function modeHint(mode: BivalentMode, p: number, h: number, l: number): string {
  switch (mode) {
    case 'alt':
      return t('Above {p} only the heat pump heats, below it only the boiler. Back to the heat pump when it warms up to {back}.', {
        p: deg(p),
        back: deg(p + h),
      });
    case 'parallel':
      return t('The heat pump always heats; below {p} the boiler helps it. Cheap heat from the heat pump even in frost.', { p: deg(p) });
    case 'partial':
      return t('From {p} to {l} both heat; below {l} the heat pump stops and the boiler stays.', { p: deg(p), l: deg(l) });
  }
}

export function chainItems(entries: readonly ChainEntry[], runtime: StrategyDto['runtime']['heatChain'], d: SystemData, when: (i: number) => string | null) {
  return entries.map((e, i) => {
    const rt = runtime.find((r) => r.entryId === e.id);
    const chip = chainChip(rt, e);
    return {
      id: e.id,
      title: e.label ?? e.sourceIds.map(d.nameOf).join(', '),
      sub: when(i) ?? (rt ? renderReason(rt.when, d.ctx) : undefined),
      trailing: <StatusChip tone={chip.tone} label={chip.label} size={24} />,
      locked: !d.canEdit,
    };
  });
}

export function HeatCard({ d, s, embedded }: { d: SystemData; s: StrategyData; embedded?: boolean }) {
  const dto = s.strategy.data as StrategyDto;
  const heat = dto.heat;
  const { setData } = s.strategy;
  const save = (p: Parameters<typeof api.strategy.patchHeat>[0]) => api.strategy.patchHeat(p).then(setData);
  const biv = useAutosave(heat.bivalence, (b) => save({ bivalence: b }));
  const lag = useAutosave(heat.lag, (l) => save({ lag: l }));
  const reorder = useMutation((chain: ChainEntry[]) => api.strategy.setHeatChain({ chain }), { onSuccess: setData, onError: () => void s.strategy.reload() });

  const chain = heat.chain;
  const kinds = chain.slice(0, 2).map((e) => (d.sources.data ?? []).find((x) => x.config.id === e.sourceIds[0])?.config.kind);
  const pair = chain.length >= 2 && kinds[0] === 'heat_pump' && chain[0].sourceIds.length === 1 && chain[1].sourceIds.length === 1;
  const b = biv.value;
  const when = pair ? pairWhen(b.mode, b.pointC, b.hpLimitC) : null;
  const outdoor = dto.runtime.outdoor10C ?? dto.runtime.outdoorC;
  const cutoff = heat.heatingCutoffOutdoorC ?? 15;
  const hpName = pair ? d.nameOf(chain[0].sourceIds[0]) : '';
  const reserveName = pair ? d.nameOf(chain[1].sourceIds[0]) : '';
  const setB = (p: Partial<HeatStrategy['bivalence']>) => biv.set((x) => ({ ...x, ...p }));

  return (
    <Section
      variant={embedded ? 'plain' : 'card'}
      accent={embedded ? undefined : 'heat'}
      icon={embedded ? undefined : 'flame'}
      title={embedded ? undefined : t('Heat')}
      subtitle={t('Takes the first source whose conditions hold. Drag to change the order.')}
    >
      <Stack gap="xl">
        <SortableList
          numbered
          ariaLabel={t('Heating order')}
          items={chainItems(chain, dto.runtime.heatChain, d, (i) => (when && i < 2 ? when[i] : null))}
          onReorder={(ids) => {
            const next = ids.map((id) => chain.find((e) => e.id === id) as ChainEntry);
            setData({ ...dto, heat: { ...heat, chain: next } });
            void reorder.run(next);
          }}
        />

        {pair ? (
          <Stack gap="lg">
            <Section
              variant="plain"
              level={3}
              title={t('How the heat pump and the boiler work together')}
              // the phone list already explains every mode; the desktop control only the chosen one
              hint={
                embedded
                  ? undefined
                  : {
                      text: t('Decided by the outdoor temperature, averaged over 10 minutes.'),
                      bullets: [
                        `${t('Alternately')} — ${modeHint('alt', b.pointC, b.hysteresisC, b.hpLimitC)}`,
                        `${t('In parallel')} — ${modeHint('parallel', b.pointC, b.hysteresisC, b.hpLimitC)}`,
                        `${t('Partly in parallel')} — ${modeHint('partial', b.pointC, b.hysteresisC, b.hpLimitC)}`,
                      ],
                    }
              }
            >
              {embedded ? (
                // three long labels do not fit a phone row: a list of choices with their meaning
                <RadioCardList<BivalentMode>
                  ariaLabel={t('Bivalence mode')}
                  value={b.mode}
                  options={[
                    { value: 'alt', title: t('Alternately'), hint: modeHint('alt', b.pointC, b.hysteresisC, b.hpLimitC), disabled: !d.canEdit },
                    { value: 'parallel', title: t('In parallel'), hint: modeHint('parallel', b.pointC, b.hysteresisC, b.hpLimitC), disabled: !d.canEdit },
                    { value: 'partial', title: t('Partly in parallel'), hint: modeHint('partial', b.pointC, b.hysteresisC, b.hpLimitC), disabled: !d.canEdit },
                  ]}
                  onChange={(mode) => setB({ mode })}
                />
              ) : (
                <SegmentedControl<BivalentMode>
                  ariaLabel={t('Bivalence mode')}
                  value={b.mode}
                  options={[
                    { value: 'alt', label: t('Alternately'), disabled: !d.canEdit },
                    { value: 'parallel', label: t('In parallel'), disabled: !d.canEdit },
                    { value: 'partial', label: t('Partly in parallel'), disabled: !d.canEdit },
                  ]}
                  onChange={(mode) => setB({ mode })}
                  hint={modeHint(b.mode, b.pointC, b.hysteresisC, b.hpLimitC)}
                />
              )}
            </Section>
            <BivalenceChart
              ariaLabel={t('When which source heats: {text}', { text: modeHint(b.mode, b.pointC, b.hysteresisC, b.hpLimitC) })}
              tracks={[
                { label: hpName, from: b.mode === 'alt' ? b.pointC : b.mode === 'partial' ? b.hpLimitC : null, to: cutoff, color: 'heat' },
                { label: reserveName, from: null, to: b.pointC, color: 'heat-deep' },
              ]}
              nowC={outdoor}
              nowLabel={outdoor != null ? t('now {t}', { t: fmtTemp(outdoor) }) : ''}
              ticks={[
                { value: -20, label: '−20°' },
                { value: -10, label: '−10°' },
                { value: 0, label: '0°' },
                { value: 10, label: '+10°' },
                { value: 20, label: t('{value} outdoors', { value: '+20°' }) },
              ]}
              caption={t('The bars show when each source may heat. Above {cutoff} heating is not needed.', { cutoff: deg(cutoff) })}
            />
            <AutoGrid min={210} gap="sm">
              <Stepper
                variant="tile"
                label={t('Bivalence point')}
                sub={t('below it the boiler joins')}
                hint={t('The outdoor temperature (10-minute average) below which the heat pump alone no longer keeps the house warm, or no longer pays off — where its output falls below the house’s heat loss (see its datasheet). Default: {def}.', {
                  def: deg(-10),
                })}
                value={b.pointC}
                text={deg(b.pointC)}
                min={-20}
                max={5}
                step={1}
                disabled={!d.canEdit}
                onChange={(pointC) => setB({ pointC, hpLimitC: Math.min(b.hpLimitC, pointC - 1) })}
                ariaDec={t('Lower bivalence point')}
                ariaInc={t('Higher bivalence point')}
              />
              <Stepper
                variant="tile"
                label={t('Return hysteresis')}
                sub={t('back to the heat pump at {t}', { t: deg(b.pointC + b.hysteresisC) })}
                hint={t('So the sources do not swap back and forth while it hovers around the point: below {p} the boiler steps in, and the heat pump gets the house back only at {back}. The heat pump limit uses the same margin. Default: {def}.', {
                  p: deg(b.pointC),
                  back: deg(b.pointC + b.hysteresisC),
                  def: fmtDelta(2, { sign: false, decimals: 0 }),
                })}
                value={b.hysteresisC}
                text={fmtDelta(b.hysteresisC, { sign: false, decimals: 0 })}
                min={1}
                max={5}
                step={1}
                disabled={!d.canEdit}
                onChange={(hysteresisC) => setB({ hysteresisC })}
                ariaDec={t('Smaller hysteresis')}
                ariaInc={t('Larger hysteresis')}
              />
              <Stepper
                variant="tile"
                label={t('Heat pump limit')}
                sub={b.mode === 'partial' ? t('below it the heat pump stops') : t('only for «Partly in parallel»')}
                hint={t('Only in «Partly in parallel»: below this the heat pump stops altogether and the boiler heats alone — in deep frost many heat pumps barely give heat. It comes back at {back}. Default: {def}.', {
                  back: deg(b.hpLimitC + b.hysteresisC),
                  def: deg(-15),
                })}
                value={b.hpLimitC}
                text={deg(b.hpLimitC)}
                min={-25}
                max={b.pointC - 1}
                step={1}
                disabled={!d.canEdit || b.mode !== 'partial'}
                onChange={(hpLimitC) => setB({ hpLimitC })}
                ariaDec={t('Lower limit')}
                ariaInc={t('Higher limit')}
              />
              <Stepper
                variant="tile"
                label={t('Heat pump not keeping up')}
                sub={t('rooms lack {delta} for longer than', { delta: fmtDelta(lag.value.deficitC, { sign: false, decimals: 0 }) })}
                hint={t('While the heat pump runs, a room more than {delta} short of its target for {dur} brings the boiler in to help — whatever the outdoor temperature — until every such room is back in its band. Default: 45 min.', {
                  delta: fmtDelta(lag.value.deficitC, { sign: false, decimals: 0 }),
                  dur: fmtDur(lag.value.forMin),
                })}
                value={lag.value.forMin}
                text={fmtDur(lag.value.forMin)}
                unit={t('min')}
                min={15}
                max={180}
                step={15}
                disabled={!d.canEdit || !lag.value.enabled}
                onChange={(forMin) => lag.set((x) => ({ ...x, forMin }))}
                ariaDec={t('Fewer minutes')}
                ariaInc={t('More minutes')}
              />
            </AutoGrid>
            <CheckboxRow
              checked={lag.value.enabled}
              disabled={!d.canEdit}
              title={t('The boiler helps a heat pump that is not keeping up')}
              hint={t('Not in the first {dur} after the heat pump starts, nor while it defrosts.', { dur: fmtDur(lag.value.graceAfterStartMin) })}
              onChange={(enabled) => lag.set((x) => ({ ...x, enabled }))}
            />
          </Stack>
        ) : chain.length ? (
          <StatusBanner tone="event" icon="info" text={t('Bivalence settings appear when a heat pump is first in the chain and another heat source second.')} />
        ) : (
          <StatusBanner tone="warn" icon="alert" text={t('No central heat source in the chain.')} action={{ label: t('Sources'), to: paths.sources() }} />
        )}

        <Extras d={d} dto={dto} mode="heat" />
      </Stack>
    </Section>
  );
}

/** «Доповнення в кімнатах»: room sources that help (air conditioners) or run only on a trigger. */
export function Extras({ d, dto, mode }: { d: SystemData; dto: StrategyDto; mode: 'heat' | 'cool' }) {
  const [off, setOff] = useState<StrategyDto['runtime']['extras']>([]);
  const listed = dto.runtime.extras.filter((x) => x.mode === mode);
  const rows = [...listed, ...off.filter((o) => o.mode === mode && !listed.some((x) => x.emitterId === o.emitterId))];
  if (!rows.length) return null;
  return (
    <Section variant="plain" level={3} title={mode === 'heat' ? t('Extras in the rooms') : t('Extras in the rooms (cooling)')}>
      <Stack gap="xs">
        {rows.map((x) => (
          <ExtraRow
            key={`${x.emitterId}:${x.mode}`}
            d={d}
            extra={x}
            on={listed.some((l) => l.emitterId === x.emitterId)}
            onOff={(was) => setOff((prev) => (was ? [...prev.filter((p) => p.emitterId !== x.emitterId), x] : prev.filter((p) => p.emitterId !== x.emitterId)))}
          />
        ))}
      </Stack>
    </Section>
  );
}

function ExtraRow({
  d,
  extra,
  on,
  onOff,
}: {
  d: SystemData;
  extra: StrategyDto['runtime']['extras'][number];
  on: boolean;
  onOff: (turnedOff: boolean) => void;
}) {
  const room = useRoom(extra.roomId);
  const emitter = room.data?.emitters.find((e) => e.id === extra.emitterId) ?? null;
  const save = useMutation(
    (enable: boolean) => {
      if (!emitter) throw new Error('emitter not loaded');
      // only this mode's role changes; what the emitter does in the other mode stays
      return api.rooms.emitters.patch(extra.roomId, extra.emitterId, { roles: { ...emitter.roles, [extra.mode]: enable ? extra.role : null } });
    },
    { onSuccess: (_r, enable) => onOff(!enable) },
  );
  const source = (d.sources.data ?? []).find((s) => s.config.id === extra.sourceId)?.config.name ?? d.nameOf(extra.sourceId);
  const roomName = d.roomName(extra.roomId) ?? extra.roomId;
  const trigger = (d.sources.data ?? []).find((s) => s.config.id === extra.sourceId)?.state.roleReason;
  const hint =
    extra.role === 'assist'
      ? t('When the room lacks more than {delta} (after airing, for example), it helps.', {
          delta: fmtDelta(emitter?.assist?.deficitC ?? 1.5, { sign: false }),
        })
      : trigger && trigger.code === 'role.trigger_only'
        ? `${renderReason(trigger, d.ctx)} — ${t('so solar energy is not wasted.')}`
        : t('Only while its trigger is active.');
  return (
    <CheckboxRow
      variant="divided"
      checked={on}
      disabled={!d.canEdit || !emitter || save.pending}
      title={extra.role === 'assist' ? t('{source} · {room} — top-up', { source, room: roomName }) : `${source} · ${roomName}`}
      hint={hint}
      onChange={(v) => void save.run(v)}
    />
  );
}
