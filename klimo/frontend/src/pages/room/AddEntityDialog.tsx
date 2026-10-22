import { useEffect, useState, type ReactNode } from 'react';
import type { EntityRolePreset, HaEntityDto } from '@api/model';
import { useEntitySearch } from '@data';
import { Dialog, EntityPicker, Stack, TextField } from '@ui';
import { t } from '@i18n';

/**
 * «+ Додати …»: pick a Home Assistant entity (entities of this room's area first), name it,
 * and add it. `extra` holds role-specific fields (window or door).
 */
export function AddEntityDialog({
  open,
  title,
  role,
  roomId,
  placeholder,
  onClose,
  onSubmit,
  extra,
}: {
  open: boolean;
  title: string;
  role: EntityRolePreset;
  roomId: string;
  placeholder: string;
  onClose: () => void;
  onSubmit: (entity: string, name: string) => Promise<unknown>;
  extra?: ReactNode;
}) {
  const search = useEntitySearch(role, { roomId });
  const [entity, setEntity] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setEntity(null);
      setName('');
    }
  }, [open]);
  const pick = (id: string | null, e?: HaEntityDto) => {
    setEntity(id);
    if (e && !name) setName(e.name);
  };
  const submit = async () => {
    if (!entity) return;
    setBusy(true);
    try {
      await onSubmit(entity, name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add'), onClick: () => void submit(), disabled: !entity, loading: busy },
      ]}
    >
      <Stack gap="md">
        <EntityPicker value={entity} onChange={pick} search={search} placeholder={placeholder} autoFocus clearable />
        <TextField label={t('Name in this room')} value={name} onChange={setName} maxLength={40} placeholder={t('e.g. «By the sofa»')} />
        {extra}
      </Stack>
    </Dialog>
  );
}
