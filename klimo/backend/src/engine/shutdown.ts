import type { ActuatorRecord, DesiredActuator, EngineConfig, EngineMemory, EpochMs, RoomState } from '../shared/model';
import { sourceDesired } from './core/actuation';
import { trvHandbackDesired } from './core/trv';

/* =====================================================================================================
 * What the house is left with when Klimo stops gracefully (an update, a restart of the add-on). Each
 * running source follows its own fail-safe: `off` is told off; `leave` is left alone — a relay with a
 * device watchdog drops by itself within 15 minutes, a heat pump or AC keeps regulating on its own —
 * so an add-on update does not short-cycle the boiler; `handback` puts a climate source on its own
 * thermostat. Pumps of running water sources stay on (water must flow while the burner may still be
 * hot). Radiator heads switch back to their internal sensor at the current target, so the rooms keep
 * being heated sensibly until Klimo returns and takes them over again.
 * ===================================================================================================== */

export function failsafeDesired(cfg: EngineConfig, memory: EngineMemory, rooms: readonly RoomState[], ledger: Record<string, ActuatorRecord>, now: EpochMs): DesiredActuator[] {
  const out: DesiredActuator[] = [];
  for (const s of cfg.sources) {
    const m = memory.sources[s.id];
    if (!m || !m.on) continue;
    const fs = s.failsafe;
    if (fs.onStop === 'off') {
      const off = { ...m, on: false, mode: null };
      out.push(...sourceDesired(s, off, { now, ledger, urgency: 'safety', setpointC: null, flowC: null, roomTempC: null, roomTargetC: null, stillDrawing: false }));
    } else if (fs.onStop === 'handback' && fs.handback && s.adapter.type === 'climate' && s.adapter.climate) {
      out.push({
        key: s.adapter.climate,
        entityId: s.adapter.climate,
        value: { kind: 'climate', hvacMode: fs.handback.hvacMode, temperature: fs.handback.setpointC, targetLow: null, targetHigh: null, fanMode: null },
        urgency: 'safety',
        owner: { type: 'source', id: s.id, roomId: s.scope === 'room' ? s.roomId : null },
        confirm: { kind: 'climate', tolerance: 0.05 },
        ackTimeoutSec: 60,
        maxAttempts: 1,
        backgroundRetryMin: 15,
        minIntervalSec: 0,
        deadband: 0,
        refreshEverySec: null,
        userSetpointAttr: null,
        reqId: null,
      });
    }
  }
  if (cfg.safety.trvHandbackOnStop) {
    for (const room of cfg.rooms) {
      if (!room.controlEnabled) continue;
      const state = rooms.find((r) => r.roomId === room.id);
      for (const e of cfg.emittersByRoom[room.id] ?? []) {
        if (!e.enabled) continue;
        for (const d of cfg.devicesByEmitter[e.id] ?? []) {
          if (d.kind !== 'trv') continue;
          out.push(...trvHandbackDesired(d, room, state?.target.heatC ?? null, state?.target.frostFloorC ?? cfg.safety.frostC));
        }
      }
    }
  }
  return out;
}
