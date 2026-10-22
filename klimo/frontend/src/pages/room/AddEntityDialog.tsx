import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EntityRolePreset, HaEntityDto } from '@api/model';
import { useEntitySearch, type FieldPaths, type MutationErrors } from '@data';
import { Dialog, EntityPicker, Stack, TextField } from '@ui';
import { t } from '@i18n';

/**
 * Where the server's objections to a sensor belong: its own fields, also as a row of the room's sensor
 * list (a write that touches several rows names them `sensors.<id or index>.…`). Anything else — the
 * weight (a stepper has no error line), a problem of the room — goes to the message above the buttons.
 */
export const SENSOR_FIELDS = {
  entity: ['entityId', 'sensors.*.entityId'],
  name: ['name', 'sensors.*.name'],
} as const satisfies FieldPaths<'entity' | 'name'>;

/**
 * «+ Додати …»: pick a Home Assistant entity (entities of this room's area first), name it,
 * and add it. `extra` holds role-specific fields (window or door). `errors` is the add request's
 * state: what the server refused is said at the entity or the name, the rest above the buttons.
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
  errors,
}: {
  open: boolean;
  title: string;
  role: EntityRolePreset;
  roomId: string;
  placeholder: string;
  onClose: () => void;
  onSubmit: (entity: string, name: string) => Promise<unknown>;
  extra?: ReactNode;
  errors?: MutationErrors;
}) {
  const search = useEntitySearch(role, { roomId });
  const [entity, setEntity] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const reset = useRef(errors?.reset);
  reset.current = errors?.reset;
  useEffect(() => {
    if (open) {
      setEntity(null);
      setName('');
      // a verdict on the last attempt does not belong to a fresh one
      reset.current?.();
    }
  }, [open]);
  const pick = (id: string | null, e?: HaEntityDto) => {
    setEntity(id);
    if (e && !name) setName(e.name);
    reset.current?.();
  };
  const rename = (v: string) => {
    setName(v);
    reset.current?.();
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
  const shown = errors?.formErrors(SENSOR_FIELDS);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      error={shown?.message}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add'), onClick: () => void submit(), disabled: !entity, loading: busy },
      ]}
    >
      <Stack gap="md">
        <EntityPicker value={entity} onChange={pick} search={search} placeholder={placeholder} autoFocus clearable error={shown?.fields.entity} />
        <TextField
          label={t('Name in this room')}
          value={name}
          onChange={rename}
          maxLength={40}
          placeholder={t('e.g. «By the sofa»')}
          error={shown?.fields.name}
        />
        {extra}
      </Stack>
    </Dialog>
  );
}
