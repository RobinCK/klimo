/**
 * «Схема зараз»: sources → manifold → circuits and pumps → rooms, with the room-local sources
 * below, drawn from the live plant. «Що якщо» runs the same decisions under other conditions
 * (frost, a sunny blackout, summer, or your own) without switching anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EnergyState, SchemaNode, SchemaView, SimConditions, SimPreset, SimPresetId, SourceDto } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource, type NameDirectory } from '@data';
import { brand } from '@brand';
import { navigate, paths } from '@app';
import {
  CheckboxRow,
  Dialog,
  EnergyStrip,
  NumberedList,
  PlantDiagram,
  ScrollX,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  StatusBanner,
  Stepper,
  TimeStepper,
  Button,
} from '@ui';
import { fmtDate, fmtKw, fmtPct, fmtTemp, minuteToHhmm, nowMs, renderReason, simPresetLabel, t, weekdayLong, zonedParts, type CodeContext } from '@i18n';
import type { SystemData } from './shared';

const PRESET_ORDER: readonly SimPresetId[] = ['now', 'frost', 'blackout_sun', 'shoulder', 'summer', 'custom'];

function presetLabel(p: SimPreset | undefined, id: SimPresetId): string {
  if (id === 'frost' && p) return t('Frost {t}', { t: fmtTemp(p.conditions.outdoorC, { decimals: 0 }) });
  if (id === 'summer') return t('Summer');
  if (id === 'custom') return t('Own conditions…');
  return simPresetLabel(id);
}

/** «Середа, 19:10 · надворі 4.2°». */
export function whenLine(at: number, outdoorC: number | null, now: number = nowMs()): string {
  const p = zonedParts(at);
  // today reads as the weekday; another date (a simulated April afternoon) shows the date
  const day = p.date === zonedParts(now).date ? weekdayLong(p.dow) : fmtDate(at, 'weekday');
  const out = outdoorC != null ? ` · ${t('outdoor {t}', { t: fmtTemp(outdoorC) })}` : '';
  return `${day}, ${minuteToHhmm(p.minuteOfDay)}${out}`;
}

export function energyItems(e: EnergyState): string[] {
  const items: string[] = [];
  if (e.pvKw != null) items.push(t('sun {kw}', { kw: fmtKw(e.pvKw) }));
  if (e.batteryPct != null) items.push(t('battery {pct}', { pct: fmtPct(e.batteryPct) }));
  if (e.houseLoadKw != null) items.push(t('house {kw}', { kw: fmtKw(e.houseLoadKw) }));
  if (e.restrictionsActive && e.budgetKw != null) items.push(t('heat and cold {used} of {budget}', { used: fmtKw(e.usedKw), budget: fmtKw(e.budgetKw) }));
  return items;
}

export function EnergyLine({ energy, ctx, compact }: { energy: EnergyState; ctx: CodeContext; compact?: boolean }) {
  if (!energy.configured) {
    return (
      <EnergyStrip
        variant={compact ? 'compact' : 'strip'}
        grid={{ present: true, label: t('Energy') }}
        items={[]}
        note={{ text: renderReason({ code: 'energy.not_configured' }, ctx), tone: 'off' }}
      />
    );
  }
  const note = energy.note && energy.note.code !== 'energy.grid_ok' ? energy.note : null;
  return (
    <EnergyStrip
      variant={compact ? 'compact' : 'strip'}
      grid={{
        present: energy.grid !== 'absent',
        label: energy.grid === 'absent' ? t('No grid power') : energy.grid === 'unknown' ? t('Grid unknown') : t('Grid is on'),
      }}
      items={energyItems(energy)}
      note={note ? { text: renderReason(note, ctx), tone: energy.phase === 'critical' ? 'err' : energy.phase === 'normal' ? 'warn' : 'warn' } : null}
    />
  );
}

/** Source boxes named alike («Кондиціонер» three times) get their room; other boxes stay as they come. */
function distinctTitles(nodes: readonly SchemaNode[], sources: readonly SourceDto[] | undefined, ctx: NameDirectory): SchemaNode[] {
  return nodes.map((n) => {
    const [kind, ...rest] = n.key.split(':');
    if (kind !== 'source' && kind !== 'local') return n;
    const id = rest.join(':');
    const plain = sources?.find((s) => s.config.id === id)?.config.name;
    const label = ctx.sourceLabel(id);
    return label && n.title === plain ? { ...n, title: label } : n;
  });
}

export function useSchema(d: SystemData) {
  const live = useResource('system:schema', api.system.schema, { reloadOn: ['source', 'circuit', 'pump', 'manifold', 'strategy', 'house'] });
  const { reload } = live;
  // the plant pushes a fresh state every few seconds; redraw the schema at most every 5 s
  const last = useRef(0);
  useEffect(() => {
    if (!d.plant) return;
    const wait = Math.max(0, 5000 - (Date.now() - last.current));
    const timer = window.setTimeout(() => {
      last.current = Date.now();
      void reload();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [d.plant, reload]);
  return live;
}

interface Props {
  d: SystemData;
  sim: SimPresetId;
  onSim: (id: SimPresetId) => void;
  /** The view shown (live or simulated), lifted so «Чому саме так» explains the same picture. */
  onView: (v: SchemaView | null) => void;
}

export function SchemaSection({ d, sim, onSim, onView }: Props) {
  const live = useSchema(d);
  const presets = useResource('system:presets', api.system.presets);
  const [simulated, setSimulated] = useState<SchemaView | null>(null);
  const [custom, setCustom] = useState<SimConditions | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const run = useMutation((preset: SimPresetId, conditions?: Partial<SimConditions>) => api.system.simulate({ preset, conditions }), {
    onSuccess: setSimulated,
  });

  const simulate = run.run;
  useEffect(() => {
    if (sim === 'now') {
      setSimulated(null);
      return;
    }
    if (sim === 'custom') {
      if (custom) void simulate('custom', custom);
      else setCustomOpen(true);
      return;
    }
    void simulate(sim);
  }, [sim, custom, simulate]);

  const view = sim === 'now' ? (live.data ?? null) : simulated;
  useEffect(() => onView(view), [view, onView]);
  const sources = d.sources.data;
  const ctx = d.ctx;
  const nodes = useMemo(() => (view ? distinctTitles(view.nodes, sources, ctx) : []), [view, sources, ctx]);

  const nodeClick = (n: SchemaNode) => {
    const [kind, ...rest] = n.key.split(':');
    const id = rest.join(':');
    if (kind === 'source' || kind === 'local') navigate(paths.source(id));
    else if ((kind === 'room' || kind === 'rooms') && n.roomIds.length === 1) navigate(paths.room(n.roomIds[0]));
  };

  const presetList = presets.data ?? [];
  const title = sim === 'now' ? t('Schema now') : t('What happens if…');
  const conditions = view?.conditions ?? null;

  return (
    <Section
      id="schema"
      title={title}
      subtitle={conditions ? whenLine(conditions.at, conditions.outdoorC) : undefined}
      action={
        <SegmentedControl<SimPresetId>
          ariaLabel={t('Check what happens under other conditions')}
          value={sim}
          options={PRESET_ORDER.filter((id) => id === 'custom' || id === 'now' || presetList.some((p) => p.id === id)).map((id) => ({
            value: id,
            label: presetLabel(
              presetList.find((p) => p.id === id),
              id,
            ),
          }))}
          onChange={(id) => {
            if (id === 'custom') setCustomOpen(true);
            onSim(id);
          }}
        />
      }
    >
      <Stack gap="md">
        {sim !== 'now' ? (
          <StatusBanner
            tone="event"
            icon="info"
            text={t('Simulation: this is how {product} would decide under these conditions. Nothing is switched — it only checks your settings.', {
              product: brand.productName,
            })}
            action={
              sim === 'custom'
                ? { label: t('Change conditions'), onClick: () => setCustomOpen(true) }
                : { label: t('Back to now'), onClick: () => onSim('now') }
            }
          />
        ) : null}
        {view ? (
          <ScrollX minWidth={1232} ariaLabel={t('Plant schema')}>
            <PlantDiagram
              ariaLabel={t('Plant schema: sources, manifold, circuits and rooms')}
              nodes={nodes}
              edges={view.edges}
              columns={[
                { key: 'sources', label: t('Sources') },
                { key: 'manifolds', label: t('Manifold') },
                { key: 'circuits', label: t('Circuits & pumps') },
                { key: 'rooms', label: t('Rooms') },
              ]}
              renderState={(r) => renderReason(r, d.ctx)}
              bandLabel={t('In the rooms — directly, without circuits')}
              energy={<EnergyLine energy={view.energy} ctx={d.ctx} />}
              onNodeClick={nodeClick}
            />
          </ScrollX>
        ) : live.error && sim === 'now' ? (
          <StatusBanner
            tone="warn"
            icon="clock"
            text={t('The schema appears once the first data from Home Assistant arrives.')}
            action={{ label: t('Retry'), onClick: () => void live.reload() }}
          />
        ) : (
          <Skeleton height={420} radius={16} />
        )}
      </Stack>
      {customOpen ? (
        <CustomConditions
          initial={custom ?? presetList.find((p) => p.id === 'now')?.conditions ?? live.data?.conditions ?? null}
          onClose={() => {
            setCustomOpen(false);
            if (sim === 'custom' && !custom) onSim('now');
          }}
          onApply={(c) => {
            setCustomOpen(false);
            setCustom(c);
            onSim('custom');
          }}
        />
      ) : null}
    </Section>
  );
}

/** «Власні умови…»: outdoor temperature, time of day, grid, sun, battery and house load. */
function CustomConditions({ initial, onClose, onApply }: { initial: SimConditions | null; onClose: () => void; onApply: (c: SimConditions) => void }) {
  const base: SimConditions = initial ?? { at: Date.now(), outdoorC: 0, gridPresent: true, pvKw: 0, batteryPct: 100, houseLoadKw: 1 };
  const [c, setC] = useState<SimConditions>(base);
  const minute = zonedParts(c.at).minuteOfDay;
  const dayStart = useMemo(() => c.at - minute * 60_000, [c.at, minute]);
  const set = (p: Partial<SimConditions>) => setC((x) => ({ ...x, ...p }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Own conditions')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Run the check'), onClick: () => onApply(c) },
      ]}
    >
      <Stack gap="md">
        <Stepper
          variant="compact"
          label={t('Outdoor temperature')}
          value={c.outdoorC}
          text={fmtTemp(c.outdoorC)}
          min={-30}
          max={40}
          step={1}
          onChange={(outdoorC) => set({ outdoorC })}
          ariaDec={t('Colder')}
          ariaInc={t('Warmer')}
        />
        <TimeStepper
          label={t('Time of day')}
          value={minute}
          text={minuteToHhmm(minute)}
          min={0}
          max={1410}
          step={30}
          onChange={(m) => set({ at: dayStart + m * 60_000 })}
          ariaEarlier={t('30 min earlier')}
          ariaLater={t('30 min later')}
        />
        <CheckboxRow checked={c.gridPresent} title={t('Grid power is on')} onChange={(gridPresent) => set({ gridPresent })} />
        <Stepper
          variant="compact"
          label={t('Sun')}
          value={c.pvKw}
          text={fmtKw(c.pvKw)}
          min={0}
          max={20}
          step={0.5}
          onChange={(pvKw) => set({ pvKw })}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
        <Stepper
          variant="compact"
          label={t('Battery')}
          value={c.batteryPct}
          text={fmtPct(c.batteryPct)}
          min={0}
          max={100}
          step={5}
          onChange={(batteryPct) => set({ batteryPct })}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
        <Stepper
          variant="compact"
          label={t('House load')}
          value={c.houseLoadKw}
          text={fmtKw(c.houseLoadKw)}
          min={0}
          max={20}
          step={0.5}
          onChange={(houseLoadKw) => set({ houseLoadKw })}
          ariaDec={t('Less')}
          ariaInc={t('More')}
        />
      </Stack>
    </Dialog>
  );
}

/** «Чому саме так»: the facts behind the current (or simulated) decision. */
export function WhySection({ d, view }: { d: SystemData; view: SchemaView | null }) {
  const why = view?.why ?? d.plant?.why ?? [];
  return (
    <Section
      title={t('Why it is so')}
      subtitle={view?.simulated ? t('For the simulated conditions') : undefined}
      action={
        <Button variant="link" size="sm" to={paths.strategy()}>
          {t('Change the source order and triggers')}
        </Button>
      }
    >
      {why.length ? (
        <NumberedList items={why.map((r) => renderReason(r, d.ctx))} />
      ) : (
        <StatusBanner tone="event" icon="info" text={t('Nothing to explain yet — waiting for the first decision.')} />
      )}
    </Section>
  );
}
