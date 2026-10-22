/**
 * Which room-settings dialog is open. A section's header button («+ Додати датчик») and the
 * section body that renders the dialog are separate components, so the open state lives here.
 */
import { useSyncExternalStore } from 'react';

export type DialogKey = 'add-sensor' | 'add-contact' | 'add-trv' | 'add-humidity' | 'delete-room' | `edit-sensor:${string}` | `profile:${string}`;

let open: DialogKey | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function openDialog(key: DialogKey): void {
  open = key;
  emit();
}

export function closeDialog(): void {
  open = null;
  emit();
}

/** The open dialog key (or null). */
export function useOpenDialog(): DialogKey | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => open,
  );
}
