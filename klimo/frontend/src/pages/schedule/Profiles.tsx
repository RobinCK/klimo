/**
 * The list of profiles with the one in force marked «діє зараз», and creating a new one.
 * Selecting a profile opens it in the editor; it does not switch the house to it.
 */
import type { Id } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { DashedAddButton, ProfileListItem, Stack } from '@ui';
import { fmtTemp, profileKindLabel, t } from '@i18n';
import type { ScheduleContext } from './data';
import { freshLook } from './palette';

export function useCreateProfile(c: ScheduleContext, onCreated: (id: Id) => void) {
  return useMutation(
    () => {
      const list = c.profiles.data ?? [];
      const base = t('New profile');
      let name = base;
      for (let n = 2; list.some((p) => p.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
      const look = freshLook(list);
      return api.profiles.create({ name, ...look, copyFrom: c.settings.data?.general.defaultProfileId ?? 'home' });
    },
    {
      onSuccess: (p) => {
        c.profiles.put(p);
        onCreated(p.id);
      },
      okToast: (p) => t('Created «{name}»', { name: p.name }),
    },
  );
}

export function ProfileItems({ c, selectedId, onSelect }: { c: ScheduleContext; selectedId: Id | null; onSelect: (id: Id) => void }) {
  const create = useCreateProfile(c, onSelect);
  return (
    <Stack gap="sm">
      {(c.profiles.data ?? []).map((p) => (
        <ProfileListItem
          key={p.id}
          name={p.name}
          kindLabel={profileKindLabel(p.kind)}
          color={p.color}
          ink={p.ink}
          icon={p.icon}
          heatText={p.frostOnly ? t('frost') : fmtTemp(p.heatC)}
          coolText={fmtTemp(p.coolC)}
          live={p.live}
          selected={p.id === selectedId}
          onClick={() => onSelect(p.id)}
        />
      ))}
      {c.canEdit ? <DashedAddButton label={t('New profile')} onClick={() => void create.run()} /> : null}
    </Stack>
  );
}
