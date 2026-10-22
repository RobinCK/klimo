/**
 * «Стратегія й тригери»: who heats and cools first, who takes over, and what changes when
 * something happens in Home Assistant. Wide screens show heating and cooling side by side;
 * on a phone every part is an accordion that remembers which one was open.
 */
import type { ReactNode } from 'react';
import type { IconName } from '@api/model';
import { navigate, paths, usePref } from '@app';
import { Accordion, AutoGrid, MobileTopBar, Page, Skeleton, Stack, StatusBanner } from '@ui';
import { bivalentModeLabel, fmtKw, hpModeSelectionLabel, t } from '@i18n';
import type { SystemData } from '../shared';
import { CoolCard, SeasonCard } from './CoolCard';
import { useStrategyData, type StrategyData } from './data';
import { EnergySection } from './Energy';
import { HeatCard } from './HeatCard';
import { RulesSection } from './Rules';
import { TriggersSection } from './Triggers';

function Phone({ d, s }: { d: SystemData; s: StrategyData }) {
  const [open, setOpen] = usePref<string | null>('strategy.open', 'heat');
  const dto = s.strategy.data;
  const parts: { id: string; icon: IconName; title: string; summary: string; body: ReactNode }[] = dto
    ? [
        {
          id: 'heat',
          icon: 'flame',
          title: t('Heat'),
          summary: `${dto.heat.chain.map((e) => e.label ?? e.sourceIds.map(d.nameOf).join(', ')).join(' → ')} · ${bivalentModeLabel(dto.heat.bivalence.mode)}`,
          body: <HeatCard d={d} s={s} embedded />,
        },
        {
          id: 'cool',
          icon: 'snow',
          title: t('Cool'),
          summary: hpModeSelectionLabel(dto.cool.hpModeSelection),
          body: <CoolCard d={d} s={s} embedded />,
        },
        {
          id: 'season',
          icon: 'calendar',
          title: t('Season'),
          summary: t('heating below {heat}, cooling above {cool}', { heat: `${dto.season.heatBelowC}°`, cool: `${dto.season.coolAboveC}°` }),
          body: <SeasonCard d={d} s={s} embedded />,
        },
        {
          id: 'triggers',
          icon: 'bolt',
          title: t('Triggers'),
          summary: t('{active} of {count} active', {
            active: (s.triggers.data ?? []).filter((x) => x.state.active).length,
            count: (s.triggers.data ?? []).length,
          }),
          body: <TriggersSection d={d} s={s} embedded />,
        },
        {
          id: 'rules',
          icon: 'layers',
          title: t('Actions on triggers'),
          summary: t('{count} actions', { count: (s.rules.data ?? []).length }),
          body: <RulesSection d={d} s={s} embedded />,
        },
        ...(s.energy.data
          ? [
              {
                id: 'energy',
                icon: 'battery_storage' as IconName,
                title: t('Energy during a blackout'),
                summary: t('budget {kw}', { kw: fmtKw(s.energy.data.policy.budgetKw) }),
                body: <EnergySection d={d} s={s} embedded />,
              },
            ]
          : []),
      ]
    : [];
  return (
    <Stack gap="md">
      <MobileTopBar title={t('Strategy & triggers')} onBack={() => navigate(paths.system())} />
      {!dto ? (
        <Skeleton height={320} radius={16} />
      ) : (
        <Stack gap="sm">
          {parts.map((p) => (
            <Accordion
              key={p.id}
              id={p.id}
              icon={p.icon}
              title={p.title}
              summary={p.summary}
              open={open === p.id}
              onToggle={() => setOpen(open === p.id ? null : p.id)}
            >
              {p.body}
            </Accordion>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function StrategyTab({ d, phone, nav }: { d: SystemData; phone: boolean; nav: ReactNode }) {
  const s = useStrategyData();
  if (phone) return <Phone d={d} s={s} />;
  const ready = Boolean(s.strategy.data);
  return (
    <Page
      title={t('Strategy & triggers')}
      subtitle={t('Who heats and cools first, who takes over, and what changes when something happens in Home Assistant.')}
      actions={nav}
    >
      {s.strategy.error && !ready ? (
        <StatusBanner
          tone="err"
          icon="alert"
          text={t('Could not load the strategy.')}
          action={{ label: t('Retry'), onClick: () => void s.strategy.reload() }}
        />
      ) : null}
      {ready ? (
        <>
          {/* each card keeps its own height instead of stretching to the tallest in the row */}
          <AutoGrid min={600} gap="xl">
            <Stack>
              <HeatCard d={d} s={s} />
            </Stack>
            <Stack>
              <CoolCard d={d} s={s} />
            </Stack>
          </AutoGrid>
          <SeasonCard d={d} s={s} />
          <TriggersSection d={d} s={s} />
          <AutoGrid min={560} gap="xl">
            <Stack>
              <RulesSection d={d} s={s} />
            </Stack>
            <Stack>{s.energy.data ? <EnergySection d={d} s={s} /> : <Skeleton height={420} radius={20} />}</Stack>
          </AutoGrid>
        </>
      ) : (
        <Stack gap="lg">
          <Skeleton height={640} radius={20} />
          <Skeleton height={320} radius={20} />
        </Stack>
      )}
    </Page>
  );
}
