import { useEffect, useState } from 'react';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { AreaSelect, AutoGrid, TextField } from '@ui';
import { t } from '@i18n';
import type { SectionProps } from '../sections/types';

/** The room's name and Home Assistant area; the name is saved when the field is left, not on every key. */
export function NameArea({ p }: { p: SectionProps }) {
  const { room } = p;
  const [name, setName] = useState(room.config.name);
  const saved = room.config.name;
  useEffect(() => setName(saved), [saved]);
  const areas = useResource('ha-areas', api.ha.areas);
  const rename = useMutation((v: string) => p.save({ name: v }), {
    okToast: (_r, v) => t('The room is now called «{name}».', { name: v }),
    onError: () => setName(saved),
  });
  const move = useMutation((areaId: string | null) => p.save({ haAreaId: areaId }), { okToast: t('The Home Assistant area is changed.') });
  const commit = () => {
    const v = name.trim();
    if (!v || v === saved) {
      setName(saved);
      return;
    }
    void rename.run(v);
  };
  return (
    <AutoGrid min={260} gap="md">
      <TextField
        label={t('Name')}
        value={name}
        onChange={setName}
        onBlur={commit}
        onEnter={commit}
        maxLength={40}
        disabled={!p.canEdit || rename.pending}
        error={rename.issues.name}
      />
      <AreaSelect
        label={t('Home Assistant area')}
        value={room.config.haAreaId}
        areas={(areas.data ?? []).map((a) => ({ id: a.areaId, name: a.name }))}
        onChange={(id) => void move.run(id)}
        noneLabel={t('No area')}
      />
    </AutoGrid>
  );
}
