import { useState } from 'react';
import type { ContactKind, WindowReaction } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation, useResource } from '@data';
import { AutoGrid, Button, CheckboxRow, ContactRow, FallbackNote, RadioCardList, SegmentedControl, Stack, StatTile } from '@ui';
import { fmtDelta, fmtDur, fmtDurSec, fmtPct, fmtSince, fmtTemp, t, windowDelayHints, windowReactionLabel } from '@i18n';
import { AddEntityDialog } from '../AddEntityDialog';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import { lockable, SettingPill } from './readonly';
import { EditSensorDialog } from './Sensors';
import type { SectionDef, SectionProps } from './types';

function stateText(kind: ContactKind, open: boolean | null, available: boolean, since: string | null): string {
  if (!available || open == null) return t('unknown');
  if (open) {
    const word = kind === 'door' ? t('Door open') : t('Window open');
    return since ? `${word} ${since}` : word;
  }
  return kind === 'door' ? t('Door closed') : t('Window closed');
}

/** The eco profile's value for this room, for «Перемкнути на «Еко» — 19°». */
function useEco(p: SectionProps): { name: string; value: number | null } {
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings', 'safety'] });
  const profiles = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room'] });
  const ecoId = settings.data?.general.ecoProfileId ?? 'eco';
  const eco = profiles.data?.find((x) => x.id === ecoId);
  const row = eco?.roomTargets.find((r) => r.roomId === p.room.config.id);
  const cool = p.state.activeModes.cool && !p.state.activeModes.heat;
  const value = !eco ? null : row?.mode === 'own' ? (cool ? (row.coolC ?? eco.coolC) : (row.heatC ?? eco.heatC)) : cool ? eco.coolC : eco.heatC;
  return { name: eco?.name ?? p.ctx.profile?.(ecoId) ?? ecoId, value };
}

function Body(p: SectionProps) {
  const { room, state } = p;
  const id = room.config.id;
  const win = useAutosave(room.config.windows, (v) => p.save({ windows: v }));
  const eco = useEco(p);
  const dialog = useOpenDialog();
  const [kind, setKind] = useState<ContactKind>('window');
  const add = useMutation(
    (entityId: string, name: string) => api.rooms.sensors.add(id, { entityId, role: 'contact', contactKind: kind, name: name || undefined }),
    {
      onSuccess: (r) => {
        p.setRoom(r);
        closeDialog();
      },
    },
  );
  const contacts = room.sensors.filter((s) => s.role === 'contact').sort((a, b) => a.order - b.order);
  const editing = dialog?.startsWith('edit-sensor:') ? (contacts.find((s) => `edit-sensor:${s.id}` === dialog) ?? null) : null;
  const w = win.value;
  const delays = windowDelayHints(w);
  const cooling = state.activeModes.cool && !state.activeModes.heat;
  const reactions: { value: WindowReaction; title: string; hint: string }[] = [
    { value: 'pause', title: cooling ? t('Do not cool') : t('Do not heat'), hint: t('Close the valves; the room does not ask for heat.') },
    {
      value: 'eco',
      title:
        eco.value != null ? t('Switch to «{profile}» — {t}', { profile: eco.name, t: fmtTemp(eco.value) }) : t('Switch to «{profile}»', { profile: eco.name }),
      hint: t('The room does not cool down if the window is forgotten.'),
    },
    {
      value: 'lower',
      title: cooling ? t('Raise the target by {delta}', { delta: fmtDelta(w.lowerByC) }) : t('Lower the target by {delta}', { delta: fmtDelta(w.lowerByC) }),
      hint: t('Relative to the current profile.'),
    },
    { value: 'notify', title: windowReactionLabel('notify'), hint: t('Change nothing; a notification after {dur}.', { dur: fmtDur(w.notifyAfterMin) }) },
  ];
  return (
    <Stack gap="lg">
      {contacts.length ? (
        <Stack gap="xs">
          {contacts.map((s) => {
            const c = state.window.contacts.find((x) => x.sensorId === s.id);
            const r = state.sensors.find((x) => x.sensorId === s.id);
            const meta = [r?.batteryPct != null ? fmtPct(r.batteryPct) : '', r?.lqi != null ? `LQI ${r.lqi}` : ''].filter(Boolean).join(' · ');
            const open = c?.open ?? null;
            const since = open && state.window.openSince != null ? fmtSince(state.window.openSince, p.now) : null;
            return (
              <ContactRow
                key={s.id}
                name={s.name}
                entityId={s.entityId}
                meta={meta}
                stateText={stateText(s.contactKind ?? 'window', open, c?.available ?? true, since)}
                open={Boolean(open)}
                unavailable={c ? !c.available : false}
                onEdit={p.canEdit ? () => openDialog(`edit-sensor:${s.id}`) : undefined}
              />
            );
          })}
        </Stack>
      ) : (
        <FallbackNote icon="windowClosed" text={t('No window or door sensors. A sudden drop of the temperature is treated as an open window.')} />
      )}
      <RadioCardList<WindowReaction>
        value={w.reaction}
        compact={false}
        options={lockable(reactions, p.canEdit)}
        onChange={(v) => win.set((x) => ({ ...x, reaction: v }))}
        ariaLabel={t('When anything is open')}
      />
      <AutoGrid min={160} gap="sm">
        <StatTile
          variant="well"
          title={t('React if open longer than')}
          hint={delays.open}
          value={
            <SettingPill
              readOnly={!p.canEdit}
              text={t('{s} s', { s: w.openDelaySec })}
              ariaLabel={t('React if open longer than')}
              editor={{ kind: 'number', min: 0, max: 300, step: 10, unit: t('s') }}
              value={w.openDelaySec}
              onChange={(v: number) => win.set((x) => ({ ...x, openDelaySec: v }))}
            />
          }
        />
        <StatTile
          variant="well"
          title={t('Resume after closing in')}
          hint={delays.resume}
          value={
            <SettingPill
              readOnly={!p.canEdit}
              text={fmtDurSec(w.resumeDelaySec)}
              ariaLabel={t('Resume after closing in')}
              editor={{ kind: 'number', min: 0, max: 30, step: 1, unit: t('min') }}
              value={Math.round(w.resumeDelaySec / 60)}
              onChange={(v: number) => win.set((x) => ({ ...x, resumeDelaySec: v * 60 }))}
            />
          }
        />
        <StatTile
          variant="well"
          title={t('Remind if open for')}
          hint={delays.remind}
          value={
            <SettingPill
              readOnly={!p.canEdit}
              text={fmtDur(w.remindAfterMin)}
              ariaLabel={t('Remind if open for')}
              editor={{ kind: 'number', min: 5, max: 120, step: 5, unit: t('min') }}
              value={w.remindAfterMin}
              onChange={(v: number) => win.set((x) => ({ ...x, remindAfterMin: v }))}
            />
          }
        />
      </AutoGrid>
      <CheckboxRow
        checked={w.tempDrop.enabled}
        disabled={!p.canEdit}
        title={t('Detect an open window by a temperature drop')}
        hint={t('Backup when a window sensor is offline: {drop} within {dur}.', { drop: `−${fmtDelta(w.tempDrop.dropC)}`, dur: fmtDur(w.tempDrop.windowMin) })}
        onChange={(on) => win.set((x) => ({ ...x, tempDrop: { ...x.tempDrop, enabled: on } }))}
      />
      {p.phone && p.canEdit ? (
        <Button variant="secondary" icon="plus" onClick={() => openDialog('add-contact')} fullWidth>
          {t('Add a window or door')}
        </Button>
      ) : null}
      <AddEntityDialog
        open={dialog === 'add-contact'}
        title={t('Add a window or door sensor')}
        role="contact"
        roomId={id}
        placeholder={t('Search a window or door sensor')}
        onClose={closeDialog}
        onSubmit={(entityId, name) => add.run(entityId, name)}
        errors={add}
        extra={
          <SegmentedControl<ContactKind>
            value={kind}
            options={[
              { value: 'window', label: t('Window') },
              { value: 'door', label: t('Door') },
            ]}
            onChange={setKind}
            full
            ariaLabel={t('Window or door')}
          />
        }
      />
      <EditSensorDialog p={p} sensor={editing} weight={false} />
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const n = p.room.sensors.filter((s) => s.role === 'contact').length;
  const w = p.room.config.windows;
  const reaction = windowReactionLabel(w.reaction).toLowerCase();
  const parts = [n ? t('{count} sensors', { count: n }) : t('no sensors'), reaction, t('after {dur}', { dur: fmtDurSec(w.openDelaySec) })];
  if (p.state.window.anyOpen) parts.unshift(t('open now'));
  return parts.join(' · ');
}

export const windowsSection: SectionDef = {
  key: 'win',
  icon: 'windowClosed',
  title: () => t('Windows and doors'),
  tag: () => t('optional'),
  summary,
  action: (p) =>
    p.canEdit ? (
      <Button variant="secondary" size="sm" icon="plus" onClick={() => openDialog('add-contact')}>
        {t('Add')}
      </Button>
    ) : null,
  Body,
};
