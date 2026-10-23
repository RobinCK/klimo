/**
 * System («Система»): the plant as a whole. Four tabs on wide screens — the schema (house
 * mode, what-if, circuits and pumps, protections, Home Assistant entities, the decision
 * journal), the sources, the strategy with its triggers and energy policy, and what the sources
 * and pumps used. Phones get a status page, the source list with drill-in, the strategy as
 * stacked sections and the consumption.
 */
import { useCallback, useState } from 'react';
import type { Id, SchemaView, SimPresetId } from '@api/model';
import { useLayout } from '@data';
import { navigate, paths, useRoute } from '@app';
import { AutoGrid, Page, Stack, SubNav } from '@ui';
import { t } from '@i18n';
import { CircuitsSection } from './Circuits';
import { GuardsSection } from './Guards';
import { HaEntitiesSection } from './HaEntities';
import { HouseModeSection } from './HouseMode';
import { JournalSection } from './Journal';
import { ManifoldDrawer, ManifoldsSection } from './Manifolds';
import { PhoneCircuits, PhoneStatus } from './PhoneStatus';
import { SchemaSection, WhySection } from './Schema';
import { useSystemData, type SystemData } from './shared';
import { SourcesTab } from './sources/SourcesTab';
import { EnergyTab } from './energy/EnergyTab';
import { StrategyTab } from './strategy/StrategyTab';

const PRESETS: readonly SimPresetId[] = ['now', 'frost', 'blackout_sun', 'shoulder', 'summer', 'custom'];

type Tab = 'schema' | 'sources' | 'strategy' | 'energy';

function SystemNav({ current }: { current: Tab }) {
  return (
    <SubNav
      ariaLabel={t('System sections')}
      current={current}
      items={[
        { key: 'schema', label: t('Schema'), to: paths.system() },
        { key: 'sources', label: t('Sources'), to: paths.sources() },
        { key: 'strategy', label: t('Strategy & triggers'), to: paths.strategy() },
        { key: 'energy', label: t('Consumption'), to: paths.energy() },
      ]}
    />
  );
}

function SchemaTab({ d, focusJournal }: { d: SystemData; focusJournal: boolean }) {
  const route = useRoute();
  const q = route.query.sim as SimPresetId | undefined;
  const sim: SimPresetId = q && PRESETS.includes(q) ? q : 'now';
  const [view, setView] = useState<SchemaView | null>(null);
  const onView = useCallback((v: SchemaView | null) => setView(v), []);
  const [manifold, setManifold] = useState<{ id: Id | null } | null>(null);
  const editManifold = useCallback((id: Id | null) => setManifold({ id }), []);
  return (
    <Page
      title={t('System')}
      subtitle={t('Climate sources → circuits and pumps → rooms. Everything is controlled through Home Assistant entities.')}
      actions={<SystemNav current="schema" />}
    >
      <HouseModeSection d={d} />
      <SchemaSection
        d={d}
        sim={sim}
        onSim={(id) => navigate(paths.system({ sim: id === 'now' ? undefined : id }), { replace: true })}
        onView={onView}
        onManifold={editManifold}
      />
      {/* each card keeps its own height instead of stretching to the tallest in the row */}
      <AutoGrid min={560} gap="xl">
        <Stack>
          <WhySection d={d} view={view} />
        </Stack>
        <Stack gap="xl">
          <ManifoldsSection d={d} onEdit={editManifold} />
          <CircuitsSection d={d} focus={route.query.section === 'circuits'} />
        </Stack>
      </AutoGrid>
      {manifold ? <ManifoldDrawer d={d} id={manifold.id} onClose={() => setManifold(null)} /> : null}
      <AutoGrid min={420} gap="xl">
        <Stack>
          <GuardsSection d={d} />
        </Stack>
        <Stack>
          <HaEntitiesSection />
        </Stack>
        <Stack>
          <JournalSection ctx={d.ctx} focus={focusJournal} />
        </Stack>
      </AutoGrid>
    </Page>
  );
}

export default function SystemPage(): JSX.Element {
  const route = useRoute();
  const phone = useLayout() === 'phone';
  const d = useSystemData();

  if (route.name === 'sources' || route.name === 'source') {
    return <SourcesTab d={d} phone={phone} selectedId={route.params.id ?? null} nav={phone ? null : <SystemNav current="sources" />} />;
  }
  if (route.name === 'strategy') {
    return <StrategyTab d={d} phone={phone} nav={phone ? null : <SystemNav current="strategy" />} />;
  }
  if (route.name === 'energy') {
    return <EnergyTab d={d} phone={phone} nav={phone ? null : <SystemNav current="energy" />} />;
  }
  if (phone) return route.query.section === 'circuits' ? <PhoneCircuits d={d} /> : <PhoneStatus d={d} />;
  return <SchemaTab d={d} focusJournal={route.name === 'journal'} />;
}
