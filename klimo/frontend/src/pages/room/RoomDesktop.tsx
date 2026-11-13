import { useState } from 'react';
import type { EpochMs, LocalDate, ProfileDto, RoomSummary } from '@api/model';
import { AutoGrid, Page, RoomTabs, RowList, Section, SideNav, SourceRow, Split, Stack, SubNav, type Tone } from '@ui';
import { RoomOrderDialog, paths, roomDemand } from '@app';
import { fmtTemp, t } from '@i18n';
import { Hero } from './Hero';
import { settingsRows } from './PhoneControl';
import { RangeControl, RoomConsumption } from './RoomConsumption';
import { SectionBody } from './SectionBody';
import { DangerZone, PHONE_SECTIONS, type SectionDef, type SectionProps } from './sections';
import type { TargetEditor } from './useTargetEditor';

export type RoomTab = 'overview' | 'use' | 'settings';

/** The tab dot: a problem wins over the state; a room that only holds is grey. */
export function tabTone(r: RoomSummary): Tone {
  if (r.issue) return r.issue.tone;
  switch (r.state) {
    case 'heat':
    case 'wait':
      return r.tone === 'cool' ? 'cool' : 'heat';
    case 'cool':
      return 'cool';
    case 'window':
      return 'warn';
    case 'error':
      return 'err';
    default:
      return 'off';
  }
}

function SectionCard({ def, p }: { def: SectionDef; p: SectionProps }) {
  if (def.hidden?.(p)) return null;
  return (
    <Section id={`section-${def.key}`} title={def.title(p)} subtitle={def.subtitle?.(p)} tag={def.tag?.(p)} action={def.action?.(p) ?? undefined}>
      <SectionBody def={def} p={p} />
    </Section>
  );
}

/**
 * Desktop and tablet: the room tabs, then the room in three parts, each its own address — the overview
 * (the hero with today's chart, and the room at a glance, a row per part of its settings), the
 * consumption, and the settings (a list of their parts beside the one that is open).
 */
export function RoomDesktop({
  p,
  ed,
  rooms,
  profiles,
  now,
  tab,
  section,
  startDate,
}: {
  p: SectionProps;
  ed: TargetEditor;
  rooms: readonly RoomSummary[];
  profiles: readonly ProfileDto[] | undefined;
  now: EpochMs;
  tab: RoomTab;
  /** The open part of the settings («?section=win»). */
  section: string | undefined;
  /** The consumption's first period (a link from System → Consumption); null: the current one. */
  startDate: LocalDate | null;
}) {
  const { room, state } = p;
  const id = room.config.id;
  const [ordering, setOrdering] = useState(false);
  const sections = PHONE_SECTIONS.filter((def) => !def.hidden?.(p));
  const open = sections.find((def) => def.key === section) ?? sections[0];
  const rows = settingsRows(p);
  const half = Math.ceil(rows.length / 2);
  return (
    <Page>
      <RoomTabs
        rooms={rooms.map((r) => ({ id: r.id, name: r.name, tempText: fmtTemp(r.tempC), dotTone: tabTone(r), demand: roomDemand(r) }))}
        current={id}
        // another room opens on the same part, so settings can be compared room by room
        hrefFor={(rid) => (tab === 'settings' ? paths.roomSettings(rid, open?.key) : tab === 'use' ? paths.roomUse(rid) : paths.room(rid))}
        addTo={paths.wizard()}
        addLabel={t('Add a room')}
        order={p.canEdit && rooms.length > 1 ? { label: t('Order of the rooms'), onClick: () => setOrdering(true) } : undefined}
      />
      <RoomOrderDialog open={ordering} onClose={() => setOrdering(false)} />
      <SubNav
        ariaLabel={t('Room sections')}
        current={tab}
        items={[
          { key: 'overview', label: t('Overview'), to: paths.room(id) },
          { key: 'use', label: t('Consumption'), to: paths.roomUse(id) },
          { key: 'settings', label: t('Settings'), to: paths.roomSettings(id) },
        ]}
      />
      {tab === 'overview' ? (
        <>
          <Hero room={room} state={state} ed={ed} ctx={p.ctx} now={now} profiles={profiles} />
          <AutoGrid min={420} gap="md">
            {[rows.slice(0, half), rows.slice(half)].map((part, k) => (
              <RowList key={k} ariaLabel={t('Room settings')}>
                {part.map((r) => (
                  <SourceRow key={r.key} icon={r.icon} name={r.name} meta={r.meta} chip={r.chip} on={false} to={r.to ?? paths.roomSettings(id, r.key)} />
                ))}
              </RowList>
            ))}
          </AutoGrid>
        </>
      ) : tab === 'use' ? (
        <Section title={t('Consumption')} subtitle={t('The room’s share of its sources’ and pumps’ meters, by how long it took their heat.')} action={<RangeControl />}>
          {/* another room starts on the date of its own link, or on the current period */}
          <RoomConsumption key={id} roomId={id} phone={false} startDate={startDate} />
        </Section>
      ) : (
        <Split
          asideFirst
          asideBasis={300}
          mainBasis={640}
          aside={
            <Stack gap="lg">
              <SideNav
                ariaLabel={t('Room settings')}
                current={open?.key ?? ''}
                items={sections.map((def) => ({ key: def.key, label: def.title(p), hint: def.summary(p), icon: def.icon, to: paths.roomSettings(id, def.key) }))}
              />
              <DangerZone p={p} />
            </Stack>
          }
          main={open ? <SectionCard key={`${id}-${open.key}`} def={open} p={p} /> : null}
        />
      )}
    </Page>
  );
}
