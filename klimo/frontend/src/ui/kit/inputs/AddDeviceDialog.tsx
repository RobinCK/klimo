import { useEffect, useState } from 'react';
import type { HaEntityDto } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { Dialog } from '../containers/overlays';
import { Stack } from '../../shell/Layout';
import { EntityPicker } from './EntityPicker';
import { Select } from './fields';
import s from './fields.module.css';

export interface AddDeviceDialogProps<K extends string> {
  open: boolean;
  onClose: () => void;
  title: string;
  /** «Що це»: what the device is; the choice decides what the search finds. */
  kinds: { value: K; label: string }[];
  kind: K;
  onKind: (k: K) => void;
  kindLabel: string;
  /** The search for the chosen kind (`useEntitySearch`). */
  search: (q: string) => Promise<HaEntityDto[]>;
  placeholder: string;
  /** Under the search while nothing is picked. */
  help?: string;
  /** A quiet line about the picked entity («now in Bedroom — will be moved»). */
  note?: (e: HaEntityDto) => string | null;
  /** Why the picked entity cannot be added: said at the field, «Add» stays off. */
  blocked?: (e: HaEntityDto) => string | null;
  /** A result's value in words («19.4°», «off»). */
  valueText?: (e: HaEntityDto) => string | null;
  addLabel: string;
  onAdd: (e: HaEntityDto) => void | Promise<unknown>;
  /** Why the last attempt failed. */
  error?: string | null;
  busy?: boolean;
}

/**
 * «Додати пристрій»: say what it is, then find it among every Home Assistant entity (the room's area
 * first). The kind can come preselected from the block the dialog was opened in.
 */
export function AddDeviceDialog<K extends string>({
  open,
  onClose,
  title,
  kinds,
  kind,
  onKind,
  kindLabel,
  search,
  placeholder,
  help,
  note,
  blocked,
  valueText,
  addLabel,
  onAdd,
  error,
  busy,
}: AddDeviceDialogProps<K>) {
  const ut = useUiText();
  const [picked, setPicked] = useState<HaEntityDto | null>(null);
  useEffect(() => {
    if (open) setPicked(null);
  }, [open, kind]);
  const why = picked ? (blocked?.(picked) ?? null) : null;
  const line = picked && !why ? (note?.(picked) ?? null) : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      error={error}
      actions={[
        { label: ut('Cancel'), onClick: onClose },
        { label: addLabel, onClick: () => picked && void onAdd(picked), disabled: !picked || !!why, loading: busy },
      ]}
    >
      <Stack gap="md">
        <Select label={kindLabel} ariaLabel={kindLabel} value={kind} options={kinds} onChange={onKind} size="lg" />
        <Stack gap="xs">
          <EntityPicker
            key={kind}
            value={picked?.entityId ?? null}
            onChange={(_, e) => setPicked(e ?? null)}
            search={search}
            placeholder={placeholder}
            entity={picked}
            error={why ?? undefined}
            valueText={valueText}
            autoFocus
            clearable
          />
          {line ? <span className={s.help}>{line}</span> : !picked && help ? <span className={s.help}>{help}</span> : null}
        </Stack>
      </Stack>
    </Dialog>
  );
}
