/**
 * Room editing: what the parts of the «Кімната й пристрої» section share — one way to send a change
 * (the fresh room comes back and is shown, the toast says what happened), the house circuits, and
 * the heating kind that waits for its first device.
 */
import { useMemo, useState } from 'react';
import type { CircuitDto, Id, RoomDetailDto, RoomHeatingKind } from '@api/model';
import { api } from '@api/endpoints';
import { invalidate, useMutation, useResource } from '@data';
import { toast } from '@ui';
import { circuitLine, circuitModeWords, type CodeContext } from '@i18n';
import type { SectionProps } from '../sections/types';

/** A heating kind ticked that only exists with a device (heads, an AC, a heater) or a circuit choice (floor). */
export type PendingKind = Extract<RoomHeatingKind, 'trv' | 'floor' | 'ac' | 'local'> | null;

export interface EditState {
  pending: PendingKind;
  setPending: (k: PendingKind) => void;
}

export function useEditState(): EditState {
  const [pending, setPending] = useState<PendingKind>(null);
  return { pending, setPending };
}

/** Sends one room change; the room read model it returns goes on screen, the toast says what happened. */
export function useRoomWrite(p: SectionProps) {
  const { setRoom } = p;
  const m = useMutation(async (send: () => Promise<RoomDetailDto>, done: string) => ({ room: await send(), done }), {
    onSuccess: ({ room, done }) => {
      setRoom(room);
      // the circuits list their member rooms; joining or leaving changes them
      invalidate('names:circuits');
      if (done) toast({ tone: 'ok', message: done });
    },
  });
  return { run: m.run, pending: m.pending };
}

/** The house circuits, by kind. */
export function useCircuits() {
  const res = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit', 'pump'] });
  const all = res.data;
  return useMemo(
    () => ({
      settled: res.settled,
      floor: (all ?? []).filter((c) => c.config.kind === 'floor'),
      radiators: (all ?? []).filter((c) => c.config.kind === 'radiators'),
      byId: (id: Id | null | undefined) => (id ? (all ?? []).find((c) => c.config.id === id) : undefined),
    }),
    [all, res.settled],
  );
}

/** A house circuit in words: how it runs, its pump and the other rooms on it. */
export function circuitSummary(c: CircuitDto, roomId: Id, ctx: CodeContext): { mode: { title: string; hint: string }; line: string } {
  const pumps = c.pumps.filter((x) => x.enabled);
  return {
    mode: circuitModeWords(c.config.mode, c.config.kind, pumps[0]?.runOnHeatMin ?? null),
    line: circuitLine(
      pumps.map((x) => ctx.pump?.(x.id) ?? x.name),
      c.memberRoomIds.filter((id) => id !== roomId).map((id) => ctx.room?.(id) ?? id),
    ),
  };
}
