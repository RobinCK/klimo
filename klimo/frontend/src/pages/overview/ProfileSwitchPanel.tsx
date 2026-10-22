import type { HouseState, ProfileDto } from '@api/model';
import {
  BottomSheet,
  Button,
  ConsequencePreview,
  DurationPills,
  InlinePanel,
  ProfileIconTile,
  RadioCardGrid,
  Row,
  Section,
  Stack,
  type RadioCardGridOption,
} from '@ui';
import { fmtTemp, t, type CodeContext } from '@i18n';
import type { PanelDuration, ProfileSwitch } from './useProfileSwitch';

/** «Опалення 21.0°» and which rooms differ («Вітальня 20.0°, Ніч — свої цілі»). */
function profileLines(p: ProfileDto, house: HouseState | null, ctx: CodeContext): string[] {
  const cool = house?.season.season === 'cooling';
  const first = p.frostOnly ? t('Frost protection only') : cool ? t('Cooling to {t}', { t: fmtTemp(p.coolC) }) : t('Heating {t}', { t: fmtTemp(p.heatC) });
  const own = p.roomTargets.filter((r) => r.mode === 'own' || r.mode === 'off');
  let note: string;
  if (p.frostOnly) note = t('rooms are off, frost protection stays');
  else if (!own.length) note = t('the same for all rooms');
  else if (own.length >= 3) note = t('{count} rooms with their own targets', { count: own.length });
  else
    note = own
      .map((r) => {
        const room = ctx.room?.(r.roomId) ?? r.roomId;
        if (r.mode === 'off') return t('{room} off', { room });
        const v = cool ? (r.coolC ?? p.coolC) : (r.heatC ?? p.heatC);
        return `${room} ${fmtTemp(v)}`;
      })
      .join(', ');
  return [first, note];
}

function Body({ sw, house, ctx }: { sw: ProfileSwitch; house: HouseState | null; ctx: CodeContext }) {
  const options: RadioCardGridOption<string>[] = sw.profiles.map((p) => ({
    value: p.id,
    leading: <ProfileIconTile icon={p.icon} color={p.color} ink={p.ink} name={p.name} size={28} />,
    title: p.name,
    badge: p.id === sw.activeId ? t('now') : undefined,
    lines: profileLines(p, house, ctx),
  }));
  return (
    <Stack gap="xl">
      {sw.pick ? <RadioCardGrid value={sw.pick} options={options} minWidth={190} onChange={sw.setPick} ariaLabel={t('Profile')} /> : null}
      <Section variant="plain" level={3} title={t('How long')}>
        <DurationPills<PanelDuration> value={sw.duration} options={sw.durationOptions} onChange={sw.setDuration} ariaLabel={t('How long')} />
      </Section>
      {sw.consequence ? (
        <ConsequencePreview tone={sw.consequence.tone} icon={sw.consequence.icon} main={sw.consequence.main} chips={sw.consequence.chips} />
      ) : null}
    </Stack>
  );
}

function Footer({ sw }: { sw: ProfileSwitch }) {
  return (
    <Row gap="sm" justify="end" wrap>
      <Button variant="secondary" onClick={sw.close}>
        {t('Cancel')}
      </Button>
      <Button variant="primary" onClick={sw.apply} disabled={!sw.canApply} loading={sw.applying}>
        {sw.applyLabel}
      </Button>
    </Row>
  );
}

/** Inline under the tiles on wide screens, a bottom sheet on phones. Nothing changes before «Перемкнути». */
export function ProfileSwitchPanel({ sw, house, ctx, phone }: { sw: ProfileSwitch; house: HouseState | null; ctx: CodeContext; phone: boolean }) {
  const hint = t('The change applies only after «Switch». Rooms with an open window stay paused.');
  if (phone) {
    return (
      <BottomSheet open={sw.open} onClose={sw.close} title={t('Change the house profile')} subtitle={hint} footer={<Footer sw={sw} />}>
        <Body sw={sw} house={house} ctx={ctx} />
      </BottomSheet>
    );
  }
  if (!sw.open) return null;
  return (
    <InlinePanel title={t('Change the house profile')} hint={hint} onClose={sw.close} footer={<Footer sw={sw} />}>
      <Body sw={sw} house={house} ctx={ctx} />
    </InlinePanel>
  );
}
