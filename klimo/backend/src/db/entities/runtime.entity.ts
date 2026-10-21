import { Entity, Index } from 'typeorm';
import type {
  Actor,
  ActuatorRecord,
  ConditionMemory,
  OverrideSnapshot,
  OverrideValue,
  PlantMemory,
  PumpMemory,
  RoomMemory,
  SeasonMemory,
  SourceMemory,
} from '../../shared/model';
import { BoolCol, EntityCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, PkCol, TextCol, TsCol } from '../columns';

/* Runtime state that must survive a restart. Never exported. */

@Entity('override')
@Index(['scope', 'subjectId'])
export class OverrideRow {
  @PkCol() id: string;
  @EnumCol() scope: string;
  @IdCol() subjectId: string;
  @EnumCol() kind: string;
  @EnumCol() group: string;
  @JsonCol() value: OverrideValue;
  @EnumCol() duration: string;
  @TsCol() createdAt: number;
  @Index() @TsCol(true) until: number | null;
  @JsonCol() by: Actor;
  @JsonCol() previous: OverrideSnapshot | null;
  @Index() @IdCol(true) revertToken: string | null;
  @TsCol(true) revertUntil: number | null;
  @IdCol(true) reqId: string | null;
}

/* Control memory: the whole record as JSON plus a few hot columns for SQL inspection. */

@Entity('room_control_state')
export class RoomControlStateRow {
  @PkCol() roomId: string;
  @JsonCol() state: RoomMemory;
  @BoolCol() heatOn: boolean;
  @BoolCol() coolOn: boolean;
  @EnumCol() demandMode: string;
  @TsCol() updatedAt: number;
}

@Entity('source_control_state')
export class SourceControlStateRow {
  @PkCol() sourceId: string;
  @JsonCol() state: SourceMemory;
  @BoolCol() on: boolean;
  @EnumCol(true) mode: string | null;
  @TsCol(true) onSince: number | null;
  @TsCol(true) offSince: number | null;
  @EnumCol() confirm: string;
  @TsCol() updatedAt: number;
}

@Entity('pump_control_state')
export class PumpControlStateRow {
  @PkCol() pumpId: string;
  @JsonCol() state: PumpMemory;
  @BoolCol() on: boolean;
  @TsCol(true) runOnUntil: number | null;
  @TsCol() updatedAt: number;
}

@Entity('condition_state')
export class ConditionStateRow {
  @PkCol(255) ownerKey: string;
  @JsonCol() state: ConditionMemory;
  @BoolCol() active: boolean;
  @TsCol(true) since: number | null;
  @TsCol() updatedAt: number;
}

@Entity('season_state')
export class SeasonStateRow {
  @PkCol() id: string;
  @EnumCol() season: string;
  @TsCol() since: number;
  @FloatCol(true) avgC: number | null;
  @TsCol(true) avgComputedAt: number | null;
  @BoolCol() bootstrap: boolean;
  @JsonCol() pending: SeasonMemory['pending'];
}

@Entity('plant_state')
export class PlantStateRow {
  @PkCol() id: string;
  @JsonCol() state: PlantMemory;
  @TsCol() lastHeartbeatAt: number;
  @IntCol() bootCount: number;
}

/** The reconciler ledger: one row per actuation key. */
@Entity('actuator_state')
export class ActuatorStateRow {
  @PkCol(255) key: string;
  @JsonCol() record: ActuatorRecord;
  @Index() @EntityCol(true) entityId: string | null;
  @EnumCol() status: string;
  @TsCol() updatedAt: number;
}

/** Technical cursors only (`telegram.offset`, `mqtt.published`, `card.sha`, seed markers). */
@Entity('kv')
export class KvRow {
  @PkCol() key: string;
  @TextCol() value: string;
}

