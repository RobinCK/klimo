import type { ActuatorRecord, Circuit, CommandProgress, DesiredActuator, Emitter, EmitterDevice, RoomConfig } from '../../shared/model';
import { actuator, progressOf } from './trv';

/* =====================================================================================================
 * Zone actuators of hydronic emitters (a zone valve or switch on a floor loop) and the room dehumidifier.
 * A zone is open exactly when its emitter is open for the room's demand, or for frost protection; a
 * heat-only loop stays shut while a feeding source cools, so chilled water never reaches radiators.
 * ===================================================================================================== */

const ZONE_ACK = { ackTimeoutSec: 60, maxAttempts: 3, backgroundRetryMin: 15 };

export interface ZoneInput {
  room: RoomConfig;
  emitter: Emitter;
  circuit: Circuit | null;
  open: boolean;
  frost: boolean;
  /** A feeding source runs in cooling: heat-only circuits are closed. */
  heatOnlyBlocked: boolean;
  floorLimit: boolean;
}

export function zoneShouldOpen(z: ZoneInput): boolean {
  const heatOnly = !!z.circuit && !z.circuit.capabilities.cool;
  if (heatOnly && z.heatOnlyBlocked) return false;
  if (z.frost && z.emitter.roles.heat !== null && z.emitter.enabled) return true;
  // a floor at its probe limit is too hot to take more heat (it is never that warm while cooling)
  if (z.floorLimit && z.emitter.kind === 'floor') return false;
  return z.open;
}

export function zoneActuation(device: EmitterDevice, z: ZoneInput, ledger: Record<string, ActuatorRecord>): { desired: DesiredActuator; open: boolean; sync: CommandProgress } {
  const open = zoneShouldOpen(z);
  const owner: DesiredActuator['owner'] = { type: 'zone', id: device.id, roomId: z.room.id };
  const isValve = device.entityId.startsWith('valve.');
  const desired = actuator(
    device.entityId,
    isValve ? { kind: 'valve', open, position: null } : { kind: 'switch', on: open },
    owner,
    { ...ZONE_ACK, urgency: z.frost ? 'safety' : 'source', confirm: { kind: 'state_equals' }, deadband: 1 },
  );
  return { desired, open, sync: progressOf(ledger[device.entityId], ZONE_ACK.maxAttempts) };
}

/** The room dehumidifier follows its humidity latch (forced off while airing or a window is open). */
export function dehumidifierActuation(room: RoomConfig, on: boolean): DesiredActuator | null {
  const d = room.humidity.dehumidifier;
  if (!d) return null;
  return actuator(d.entityId, { kind: 'switch', on }, { type: 'aux', id: room.id, roomId: room.id }, { ...ZONE_ACK, urgency: 'background', confirm: { kind: 'state_equals' } });
}
