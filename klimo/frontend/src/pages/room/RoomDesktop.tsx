import { useEffect } from 'react';
import type { EpochMs, ProfileDto, RoomSummary } from '@api/model';
import { AutoGrid, Page, RoomTabs, Section, Stack, type Tone } from '@ui';
import { paths } from '@app';
import { fmtTemp, t } from '@i18n';
import { Hero } from './Hero';
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

/** Desktop and tablet: room tabs, the hero with today's chart, then every setting in two columns. */
export function RoomDesktop({
  p,
  ed,
  rooms,
  profiles,
  now,
  section,
}: {
  p: SectionProps;
  ed: TargetEditor;
  rooms: readonly RoomSummary[];
  profiles: readonly ProfileDto[] | undefined;
  now: EpochMs;
  section: string | undefined;
}) {
  const { room, state } = p;
  // «#/rooms/<id>/settings?section=win» opens the room page at that section
  useEffect(() => {
    if (!section) return;
    const timer = window.setTimeout(() => document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => window.clearTimeout(timer);
  }, [section, room.config.id]);
  return (
    <Page>
      <RoomTabs
        rooms={rooms.map((r) => ({ id: r.id, name: r.name, tempText: fmtTemp(r.tempC), dotTone: tabTone(r) }))}
        current={room.config.id}
        hrefFor={(id) => paths.room(id)}
        addTo={paths.wizard()}
        addLabel={t('Add a room')}
      />
      <Hero room={room} state={state} ed={ed} ctx={p.ctx} now={now} profiles={profiles} />
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
