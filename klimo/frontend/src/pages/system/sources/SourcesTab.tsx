/**
 * «Джерела клімату»: everything that heats or cools — boilers, heat pumps, air conditioners,
 * electric heaters — grouped into whole-house and per-room sources, with the selected one's
 * details beside the list. On a phone the list and the details are separate screens.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { Id, SourceDto } from '@api/model';
import { navigate, paths } from '@app';
import { DashedAddButton, MobileTopBar, Page, Section, Skeleton, SourceListItem, Split, Stack, StatusBanner } from '@ui';
import { renderReason, t } from '@i18n';
import { SOURCE_ICON, sourceChip, type SystemData } from '../shared';
import { AddSource } from './AddSource';
import { SourceDetail } from './SourceDetail';

function SourceList({
  d,
  selectedId,
  adding,
  onPick,
  onAdd,
}: {
  d: SystemData;
  selectedId: Id | null;
  adding: boolean;
  onPick: (id: Id) => void;
  onAdd: () => void;
}) {
  const list = d.sources.data ?? [];
  const groups: { key: string; title: string; items: SourceDto[] }[] = [
    { key: 'central', title: t('Whole-house'), items: list.filter((s) => s.config.scope === 'central') },
    { key: 'room', title: t('In the rooms'), items: list.filter((s) => s.config.scope === 'room') },
  ];
  return (
    <Stack gap="md">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <Section key={g.key} variant="plain" level={3} overline={g.title}>
            <Stack gap="sm">
              {g.items.map((s) => {
                const state = d.liveState(s.config.id) ?? s.state;
                const role = renderReason(state.roleReason, d.ctx);
                return (
                  <SourceListItem
                    key={s.config.id}
                    icon={SOURCE_ICON[s.config.kind]}
                    name={d.nameOf(s.config.id)}
                    sub={[s.config.subtype, s.config.enabled ? role : t('not in use')].filter(Boolean).join(' · ')}
                    chip={s.config.enabled ? sourceChip(state) : { tone: 'off', label: t('Off') }}
                    selected={!adding && s.config.id === selectedId}
                    onClick={() => onPick(s.config.id)}
                  />
                );
              })}
            </Stack>
          </Section>
        ))}
      {d.canEdit ? <DashedAddButton label={t('Add a source')} onClick={onAdd} expanded={adding} /> : null}
    </Stack>
  );
}

interface Props {
  d: SystemData;
  phone: boolean;
  selectedId: Id | null;
  nav: ReactNode;
}

export function SourcesTab({ d, phone, selectedId, nav }: Props) {
  const [adding, setAdding] = useState(false);
  const list = d.sources.data ?? [];
  const selected = list.find((s) => s.config.id === selectedId) ?? (phone ? null : (list[0] ?? null));
  // an unknown id (deleted, mistyped) falls back to the list
  useEffect(() => {
    if (selectedId && d.sources.settled && !list.some((s) => s.config.id === selectedId)) navigate(paths.sources(), { replace: true });
  }, [selectedId, d.sources.settled, list]);

  const pick = (id: Id) => {
    setAdding(false);
    navigate(paths.source(id), { replace: !phone });
  };
  const created = (id: Id) => {
    setAdding(false);
    void d.sources.reload();
    navigate(paths.source(id), { replace: !phone });
  };
  const loading = !d.sources.settled;
  const failed = d.sources.error && !d.sources.data;

  if (phone) {
    if (adding) return <AddSource d={d} phone onClose={() => setAdding(false)} onCreated={created} />;
    if (selected) {
      return (
        <Stack gap="md">
          <MobileTopBar title={d.nameOf(selected.config.id)} onBack={() => navigate(paths.sources())} />
          <SourceDetail d={d} dto={selected} phone />
        </Stack>
      );
    }
    return (
      <Stack gap="md">
        <MobileTopBar title={t('Climate sources')} onBack={() => navigate(paths.system())} />
        {loading ? <Skeleton height={320} radius={16} /> : <SourceList d={d} selectedId={null} adding={false} onPick={pick} onAdd={() => setAdding(true)} />}
      </Stack>
    );
  }

  return (
    <Page
      title={t('Climate sources')}
      subtitle={t('Everything that heats or cools: boilers, heat pumps, air conditioners, electric heaters. Controlled through Home Assistant entities.')}
      actions={nav}
    >
      {failed ? (
        <StatusBanner tone="err" icon="alert" text={t('Could not load the sources.')} action={{ label: t('Retry'), onClick: () => void d.sources.reload() }} />
      ) : null}
      <Split
        asideFirst
        asideBasis={340}
        mainBasis={660}
        aside={
          loading ? (
            <Skeleton height={420} radius={16} />
          ) : (
            <SourceList d={d} selectedId={selected?.config.id ?? null} adding={adding} onPick={pick} onAdd={() => setAdding((x) => !x)} />
          )
        }
        main={
          <Stack gap="lg">
            {adding ? <AddSource d={d} phone={false} onClose={() => setAdding(false)} onCreated={created} /> : null}
            {selected ? (
              <SourceDetail key={selected.config.id} d={d} dto={selected} phone={false} />
            ) : loading ? (
              <Skeleton height={640} radius={20} />
            ) : !adding ? (
              <StatusBanner tone="event" icon="info" text={t('No sources yet — add the boiler, heat pump or air conditioners the house has.')} />
            ) : null}
          </Stack>
        }
      />
    </Page>
  );
}
