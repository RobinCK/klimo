import { useEffect, useState } from 'react';
import type { ProfileDto, RoomProfileMode } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { AutoGrid, DataTable, Dialog, IconButton, KeyValueList, Link, ProfileTile, SegmentedControl, Skeleton, Stack, Stepper, ToneBadge } from '@ui';
import { paths } from '@app';
import { fmtTemp, roomProfileModeLabel, t } from '@i18n';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import type { SectionDef, SectionProps } from './types';

interface Row {
  profile: ProfileDto;
  mode: RoomProfileMode;
  heat: number | null;
  cool: number | null;
  ownHeat: boolean;
  ownCool: boolean;
}

function rowsOf(p: SectionProps, profiles: readonly ProfileDto[]): Row[] {
  return [...profiles]
    .sort((a, b) => a.order - b.order)
    .map((profile) => {
      const s = p.room.profileTargets.find((x) => x.profileId === profile.id);
      if (profile.frostOnly || s?.mode === 'off') return { profile, mode: 'off', heat: null, cool: null, ownHeat: false, ownCool: false };
      if (s?.mode === 'own') {
        return { profile, mode: 'own', heat: s.heatC ?? profile.heatC, cool: s.coolC ?? profile.coolC, ownHeat: s.heatC != null, ownCool: s.coolC != null };
      }
      return { profile, mode: 'inherit', heat: profile.heatC, cool: profile.coolC, ownHeat: false, ownCool: false };
    });
}

function origin(r: Row): string {
  if (r.profile.frostOnly) return t('frost protection only');
  if (r.mode === 'off') return t('off in this room');
  if (r.ownHeat && r.ownCool) return t('own targets');
  if (r.ownHeat) return t('own heating target');
  if (r.ownCool) return t('own cooling target');
  return t('from the profile');
}

function value(v: number | null, own: boolean, tone: 'heat' | 'cool') {
  if (v == null) return '—';
  return own ? (
    <ToneBadge tone={tone} size="sm">
      {fmtTemp(v)}
    </ToneBadge>
  ) : (
    fmtTemp(v)
  );
}

function EditDialog({ p, row }: { p: SectionProps; row: Row | null }) {
  const [mode, setMode] = useState<RoomProfileMode>('inherit');
  const [heat, setHeat] = useState(20);
  const [cool, setCool] = useState(25);
  useEffect(() => {
    if (!row) return;
    setMode(row.profile.frostOnly ? 'off' : row.mode);
    setHeat(row.heat ?? row.profile.heatC);
    setCool(row.cool ?? row.profile.coolC);
  }, [row]);
  const save = useMutation(
    (profileId: string) => api.rooms.setProfileTarget(p.room.config.id, profileId, mode === 'own' ? { mode, heatC: heat, coolC: cool } : { mode }),
    {
      onSuccess: (r) => {
        p.setRoom(r);
        closeDialog();
      },
    },
  );
  return (
    <Dialog
      open={row != null}
      onClose={closeDialog}
      title={row ? t('«{profile}» in {room}', { profile: row.profile.name, room: p.room.config.name }) : ''}
      actions={[
        { label: t('Cancel'), onClick: closeDialog },
        { label: t('Save'), onClick: () => row && void save.run(row.profile.id), loading: save.pending },
      ]}
    >
      <Stack gap="lg">
        <SegmentedControl<RoomProfileMode>
          value={mode}
          options={(['inherit', 'own', 'off'] as const).map((m) => ({ value: m, label: roomProfileModeLabel(m) }))}
          onChange={setMode}
          full
          ariaLabel={t('Target in this profile')}
          hint={
            mode === 'inherit'
              ? t('The room follows the profile: {heat} heating, {cool} cooling.', { heat: fmtTemp(row?.profile.heatC), cool: fmtTemp(row?.profile.coolC) })
              : mode === 'off'
                ? t('The room is off in this profile; frost protection stays.')
                : undefined
          }
        />
        {mode === 'own' ? (
          <AutoGrid min={200} gap="md">
            <Stepper
              variant="big"
              label={t('Space heating')}
              labelTone="heat"
              value={heat}
              text={fmtTemp(heat)}
              min={5}
              max={30}
              step={0.5}
              onChange={setHeat}
              ariaDec={t('Lower the heating target by 0.5°')}
              ariaInc={t('Raise the heating target by 0.5°')}
            />
            <Stepper
              variant="big"
              label={t('Space cooling')}
              labelTone="cool"
              value={cool}
              text={fmtTemp(cool)}
              min={16}
              max={32}
              step={0.5}
              onChange={setCool}
              ariaDec={t('Lower the cooling target by 0.5°')}
              ariaInc={t('Raise the cooling target by 0.5°')}
            />
          </AutoGrid>
        ) : null}
      </Stack>
    </Dialog>
  );
}

function Body(p: SectionProps) {
  const profiles = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room'] });
  const dialog = useOpenDialog();
  if (!profiles.data) return <Skeleton height={200} radius={12} />;
  const rows = rowsOf(p, profiles.data);
  const editing = dialog?.startsWith('profile:') ? (rows.find((r) => `profile:${r.profile.id}` === dialog) ?? null) : null;
  const edit = (r: Row) => openDialog(`profile:${r.profile.id}`);
  return (
    <>
      {p.phone ? (
        <KeyValueList
          rows={rows.map((r) => ({
            key: r.profile.name,
            value: r.mode === 'off' ? origin(r) : `${fmtTemp(r.heat)} / ${fmtTemp(r.cool)}${r.ownHeat || r.ownCool ? ` · ${t('own')}` : ''}`,
            action: p.canEdit ? { label: t('Change'), onClick: () => edit(r) } : undefined,
          }))}
        />
      ) : (
        <DataTable
          minWidth={480}
          ariaLabel={t('Targets by profile')}
          columns={[
            { key: 'profile', label: t('Profile'), width: '1.3fr' },
            { key: 'heat', label: t('Space heating'), width: '0.7fr' },
            { key: 'cool', label: t('Space cooling'), width: '0.8fr' },
            { key: 'from', label: t('From'), width: '1fr' },
            { key: 'edit', label: t('Change'), width: 'auto', hideLabel: true, align: 'end' },
          ]}
          rows={rows.map((r) => ({
            key: r.profile.id,
            cells: {
              profile: <ProfileTile variant="inline" name={r.profile.name} color={r.profile.color} />,
              heat: value(r.heat, r.ownHeat, 'heat'),
              cool: value(r.cool, r.ownCool, 'cool'),
              from: origin(r),
              edit: p.canEdit ? (
                <IconButton icon="pencil" size={40} label={t('Change the target of «{profile}»', { profile: r.profile.name })} onClick={() => edit(r)} />
              ) : null,
            },
          }))}
        />
      )}
      <EditDialog p={p} row={editing} />
    </>
  );
}

function summary(p: SectionProps): string {
  const rows = rowsOf(p, p.profiles ?? []);
  const row = rows.find((r) => r.profile.id === p.state.target.profileId) ?? rows.find((r) => r.mode === 'own') ?? rows[0];
  if (!row) return t('heat / cold by profile');
  if (row.mode === 'off') return t('{profile}: off', { profile: row.profile.name });
  return t('heat / cold · {profile} {heat} / {cool}', { profile: row.profile.name, heat: fmtTemp(row.heat), cool: fmtTemp(row.cool) });
}

export const profileTargetsSection: SectionDef = {
  key: 'prof',
  icon: 'layers',
  title: () => t('Targets by profile'),
  summary,
  action: () => (
    <Link to={paths.schedule()} variant="inline">
      {t('All profiles')}
    </Link>
  ),
  Body,
};
