/**
 * System («Система»): the plant as a whole. Three tabs on wide screens — the schema (house
 * mode, what-if, circuits and pumps, protections, Home Assistant entities, the decision
 * journal), the sources, and the strategy with its triggers and energy policy. Phones get a
 * status page, the source list with drill-in, and the strategy as stacked sections.
 */
import { useCallback, useState } from 'react';
import type { SchemaView, SimPresetId } from '@api/model';
import { useLayout } from '@data';
import { navigate, paths, useRoute } from '@app';
import { AutoGrid, Page, Stack, SubNav } from '@ui';
import { t } from '@i18n';
import { CircuitsSection } from './Circuits';
import { GuardsSection } from './Guards';
import { HaEntitiesSection } from './HaEntities';
import { HouseModeSection } from './HouseMode';
import { JournalSection } from './Journal';
import { PhoneStatus } from './PhoneStatus';
import { SchemaSection, WhySection } from './Schema';
import { useSystemData, type SystemData } from './shared';
import { SourcesTab } from './sources/SourcesTab';
import { StrategyTab } from './strategy/StrategyTab';

const PRESETS: readonly SimPresetId[] = ['now', 'frost', 'blackout_sun', 'shoulder', 'summer', 'custom'];

type Tab = 'schema' | 'sources' | 'strategy';

function SystemNav({ current }: { current: Tab }) {
  return (
    <SubNav
      ariaLabel={t('System sections')}
      current={current}
      items={[
        { key: 'schema', label: t('Schema'), to: paths.system() },
        { key: 'sources', label: t('Sources'), to: paths.sources() },
        { key: 'strategy', label: t('Strategy & triggers'), to: paths.strategy() },
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
  return (
    <Page
      title={t('System')}
      subtitle={t('Climate sources → circuits and pumps → rooms. Everything is controlled through Home Assistant entities.')}
      actions={<SystemNav current="schema" />}
    >
      <HouseModeSection d={d} />
      <SchemaSection d={d} sim={sim} onSim={(id) => navigate(paths.system({ sim: id === 'now' ? undefined : id }), { replace: true })} onView={onView} />
      {/* each card keeps its own height instead of stretching to the tallest in the row */}
      <AutoGrid min={560} gap="xl">
        <Stack>
          <WhySection d={d} view={view} />
        </Stack>
        <Stack>
          <CircuitsSection d={d} />
        </Stack>
      </AutoGrid>
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
  if (phone) return <PhoneStatus d={d} />;
  return <SchemaTab d={d} focusJournal={route.name === 'journal'} />;
}
