import { useEffect } from 'react';
import { Accordion, MobileTopBar, Stack } from '@ui';
import { navigate, paths, usePref } from '@app';
import { t } from '@i18n';
import { DangerZone, PHONE_DEFAULT_OPEN, PHONE_SECTIONS, type SectionProps } from './sections';
import { SectionBody } from './SectionBody';

/** Phone room settings: one accordion per section with a live summary; open ones are remembered. */
export function PhoneSettings({ p, section }: { p: SectionProps; section: string | undefined }) {
  const [open, setOpen] = usePref<string[]>('roomSettings.open', PHONE_DEFAULT_OPEN);
  const roomId = p.room.config.id;

  // a row of the room page («Термоголовки ›») opens its section and brings it into view
  useEffect(() => {
    if (!section) return;
    if (!open.includes(section)) setOpen([...open, section]);
    const timer = window.setTimeout(() => document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => window.clearTimeout(timer);
    // only when the deep link changes, not every time an accordion is toggled
  }, [section, roomId]);

  const toggle = (key: string) => setOpen(open.includes(key) ? open.filter((k) => k !== key) : [...open, key]);
  return (
    <Stack gap="sm">
      <MobileTopBar
        title={t('Settings')}
        subtitle={{ text: t('{room} · changes apply at once', { room: p.room.config.name }) }}
        onBack={() => navigate(paths.room(roomId))}
      />
      {PHONE_SECTIONS.filter((def) => !def.hidden?.(p)).map((def) => {
        return (
          <Accordion
            key={def.key}
            id={`section-${def.key}`}
            icon={def.icon}
            title={def.title(p)}
            summary={def.summary(p)}
            open={open.includes(def.key)}
            onToggle={() => toggle(def.key)}
          >
            <SectionBody def={def} p={p} />
          </Accordion>
        );
      })}
      <DangerZone p={p} />
    </Stack>
  );
}
