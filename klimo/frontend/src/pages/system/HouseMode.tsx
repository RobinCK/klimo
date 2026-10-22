/**
 * «Режим будинку»: auto, heating only, cooling only or off. A change is never applied on a
 * single tap: the chosen mode waits (outlined) with what it would do right now, worked out by
 * the server from the live state, until it is confirmed or dropped.
 */
import { useEffect, useState } from 'react';
import type { HouseMode, HouseModePreview, SeasonState } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { paths } from '@app';
import { brand } from '@brand';
import { InlineConfirm, KeyValueList, Section, SegmentedControl, Stack } from '@ui';
import { fmtTemp, renderReason, seasonLabel, t } from '@i18n';
import type { SystemData } from './shared';

const MODES: readonly HouseMode[] = ['auto', 'heat', 'cool', 'off'];

export function modeLabel(m: HouseMode, short: boolean): string {
  switch (m) {
    case 'auto':
      return t('Auto');
    case 'heat':
      return short ? t('Heat') : t('Heating only');
    case 'cool':
      return short ? t('Cold') : t('Cooling only');
    case 'off':
      return t('Off');
  }
}

export function modeDescription(m: HouseMode, frostC: number, short: boolean): string {
  const product = brand.productName;
  const frost = fmtTemp(frostC, { decimals: 0 });
  switch (m) {
    case 'auto':
      return short
        ? t('{product} decides itself whether to heat or cool: every room keeps its own range.', { product })
        : t(
            '{product} decides itself whether to heat or cool. Every room keeps the range between its heating and cooling targets; central sources switch with the weather, air conditioners in each room separately.',
            { product },
          );
    case 'heat':
      return short
        ? t('Heating only: air conditioners do not cool, even when the sun has warmed a room.')
        : t('Cooling is blocked in every source. Air conditioners may only heat, if the strategy allows it.');
    case 'cool':
      return short
        ? t('Cooling only: the heat pump and the boiler do not heat; frost protection works.')
        : t('The boiler is off, the heat pump only cools. Frost protection always works.');
    case 'off':
      return short
        ? t('Nothing heats or cools. Frost protection {t} always works.', { t: frost })
        : t('I control nothing. Frost protection, the pumps’ anti-seize runs and notifications stay.');
  }
}

/** «Зараз сезон опалення · середня за 3 дні 6.8° (опалення нижче 15°, охолодження вище 22°)». */
export function seasonLine(s: SeasonState): string {
  const base = t('Now: {season} · {days}-day average {avg} (heating below {heat}, cooling above {cool})', {
    season: seasonLabel(s.season),
    days: s.rule.avgDays,
    avg: fmtTemp(s.avgC),
    heat: fmtTemp(s.rule.heatBelowC, { decimals: 0 }),
    cool: fmtTemp(s.rule.coolAboveC, { decimals: 0 }),
  });
  return s.pending ? `${base} · ${t('changing to {season} soon', { season: seasonLabel(s.pending.to) })}` : base;
}

export function useHouseModeChange(d: SystemData) {
  const current = d.house?.season.houseMode ?? 'auto';
  const [pending, setPending] = useState<HouseMode | null>(null);
  const [preview, setPreview] = useState<HouseModePreview | null>(null);
  const apply = useMutation((mode: HouseMode) => api.house.setMode({ mode }), {
    onSuccess: () => setPending(null),
    okToast: (_r, mode) => t('House mode: {mode}', { mode: modeLabel(mode, false) }),
  });
  useEffect(() => {
    if (!pending) {
      setPreview(null);
      return;
    }
    let live = true;
    api.house.previewMode({ mode: pending }).then(
      (p) => live && setPreview(p),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [pending]);
  // the mode changed elsewhere (a card, Home Assistant): a pending choice of it is moot
  useEffect(() => {
    if (pending === current) setPending(null);
  }, [pending, current]);

  const consequence = (): string => {
    if (!pending) return '';
    if (!preview) return t('Working out what changes…');
    const main = renderReason(preview.main, d.ctx);
    const parts = [/[.!?…]$/.test(main) ? main : `${main}.`];
    // the main sentence already names what stops or starts; the rooms make it concrete
    if (preview.affectedRoomIds.length)
      parts.push(t('Rooms affected: {list}.', { list: preview.affectedRoomIds.map((id) => d.roomName(id) ?? id).join(', ') }));
    return parts.join(' ');
  };
  return { current, pending, choose: (m: HouseMode) => setPending(m === current ? null : m), cancel: () => setPending(null), apply, consequence };
}

export function HouseModeSection({ d, short }: { d: SystemData; short?: boolean }) {
  const m = useHouseModeChange(d);
  const frostC = d.settings.data?.safety.frostC ?? 7;
  const season = d.house?.season ?? null;
  const control = (
    <SegmentedControl<HouseMode>
      ariaLabel={t('House mode')}
      size="md"
      full={short}
      value={m.current}
      pending={m.pending}
      options={MODES.map((x) => ({ value: x, label: modeLabel(x, Boolean(short)), disabled: !d.canEdit }))}
      onChange={m.choose}
      hint={short && !m.pending ? modeDescription(m.current, frostC, true) : undefined}
    />
  );
  const confirm = m.pending ? (
    <InlineConfirm
      title={t('Switch to «{mode}»?', { mode: modeLabel(m.pending, Boolean(short)) })}
      text={m.consequence()}
      cancel={{ label: t('Cancel'), onClick: m.cancel }}
      confirm={{ label: t('Switch over'), onClick: () => void m.apply.run(m.pending as HouseMode), loading: m.apply.pending }}
    />
  ) : null;

  if (short) {
    return (
      <Stack gap="sm">
        {control}
        {confirm}
      </Stack>
    );
  }
  return (
    <Section title={t('House mode')} subtitle={modeDescription(m.pending ?? m.current, frostC, false)} action={control}>
      {confirm || (season && m.current === 'auto') ? (
        <Stack gap="md">
          {confirm}
          {season && m.current === 'auto' ? (
            <KeyValueList rows={[{ key: t('Season'), value: seasonLine(season), action: { label: t('Season settings'), to: paths.strategy() } }]} />
          ) : null}
        </Stack>
      ) : null}
    </Section>
  );
}
