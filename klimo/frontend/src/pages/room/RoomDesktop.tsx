import { useEffect, useState } from 'react';
import type { EpochMs, LocalDate, ProfileDto, RoomSummary } from '@api/model';
import { AutoGrid, Page, RoomTabs, Section, Stack, type Tone } from '@ui';
import { RoomOrderDialog, paths, roomDemand } from '@app';
import { fmtTemp, t } from '@i18n';
import { Hero } from './Hero';
import { RangeControl, RoomConsumption } from './RoomConsumption';
import { SectionBody } from './SectionBody';
import { DangerZone, LEFT_SECTIONS, RIGHT_SECTIONS, SETUP_SECTION, type SectionDef, type SectionProps } from './sections';
import type { TargetEditor } from './useTargetEditor';

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

/** Desktop and tablet: room tabs, the hero with today's chart, the room's consumption, then every setting in two columns. */
export function RoomDesktop({
  p,
  ed,
  rooms,
  profiles,
  now,
  section,
  startDate,
}: {
  p: SectionProps;
  ed: TargetEditor;
  rooms: readonly RoomSummary[];
  profiles: readonly ProfileDto[] | undefined;
  now: EpochMs;
  section: string | undefined;
  /** The consumption's first period (a link from System → Consumption); null: the current one. */
  startDate: LocalDate | null;
}) {
  const { room, state } = p;
  const [ordering, setOrdering] = useState(false);
  // «#/rooms/<id>/settings?section=win» opens the room page at that section, «#/rooms/<id>/use» at the consumption
  useEffect(() => {
    if (!section) return;
    const timer = window.setTimeout(() => document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => window.clearTimeout(timer);
  }, [section, room.config.id]);
  return (
    <Page>
      <RoomTabs
        rooms={rooms.map((r) => ({ id: r.id, name: r.name, tempText: fmtTemp(r.tempC), dotTone: tabTone(r), demand: roomDemand(r) }))}
        current={room.config.id}
        hrefFor={(id) => paths.room(id)}
        addTo={paths.wizard()}
        addLabel={t('Add a room')}
        order={p.canEdit && rooms.length > 1 ? { label: t('Order of the rooms'), onClick: () => setOrdering(true) } : undefined}
      />
      <RoomOrderDialog open={ordering} onClose={() => setOrdering(false)} />
      <Hero room={room} state={state} ed={ed} ctx={p.ctx} now={now} profiles={profiles} />
      <Section
        id="section-use"
        title={t('Consumption')}
        subtitle={t('The room’s share of its sources’ meters, by how long it took their heat.')}
        action={<RangeControl />}
      >
        {/* another room starts on the date of its own link, or on the current period */}
        <RoomConsumption key={room.config.id} roomId={room.config.id} phone={false} startDate={startDate} />
      </Section>
      <SectionCard def={SETUP_SECTION} p={p} />
      <AutoGrid min={560} gap="xl">
        <Stack gap="xl">
          {LEFT_SECTIONS.map((def) => (
            <SectionCard key={def.key} def={def} p={p} />
          ))}
        </Stack>
        <Stack gap="xl">
          {RIGHT_SECTIONS.map((def) => (
            <SectionCard key={def.key} def={def} p={p} />
          ))}
          <DangerZone p={p} />
        </Stack>
      </AutoGrid>
    </Page>
  );
}
