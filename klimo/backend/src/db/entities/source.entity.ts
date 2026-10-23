import { Entity, Index, PrimaryColumn } from 'typeorm';
import type { Circuit, Pump, SourceConfig } from '../../shared/model';
import { BoolCol, EntityCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, NameCol, PkCol, TsCol } from '../columns';

@Entity('source')
export class SourceRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @EnumCol() kind: string;
  @NameCol() subtype: string;
  @EnumCol() scope: string;
  @Index() @IdCol(true) roomId: string | null;
  @IntCol() order: number;
  @BoolCol() enabled: boolean;
  @JsonCol() capabilities: SourceConfig['capabilities'];
  @JsonCol() energy: SourceConfig['energy'];
  @JsonCol() meters: SourceConfig['meters'];
  @JsonCol() adapter: SourceConfig['adapter'];
  @JsonCol() curves: SourceConfig['curves'];
  @JsonCol() outdoorLimits: SourceConfig['outdoorLimits'];
  @JsonCol() guards: SourceConfig['guards'];
  @JsonCol() conditions: SourceConfig['conditions'];
  @JsonCol() seasonPolicy: SourceConfig['seasonPolicy'];
  @JsonCol() failsafe: SourceConfig['failsafe'];
  @JsonCol() hydronic: SourceConfig['hydronic'];
  @Index() @IdCol(true) linkedTo: string | null;
  @JsonCol() ownFields: SourceConfig['ownFields'];
  @TsCol() createdAt: number;
  @TsCol() updatedAt: number;
}

@Entity('manifold')
export class ManifoldRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @EntityCol(true) supplySensorEntityId: string | null;
  @EntityCol(true) returnSensorEntityId: string | null;
  @IntCol() order: number;
}

/** `Circuit` without `sourceIds`, which live in `circuit_source`. */
@Entity('circuit')
export class CircuitRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @NameCol() shortName: string;
  @EnumCol() kind: string;
  @Index() @IdCol(true) manifoldId: string | null;
  @JsonCol() capabilities: Circuit['capabilities'];
  @JsonCol() supply: Circuit['supply'];
  @JsonCol() mixingValve: Circuit['mixingValve'];
  @FloatCol(true) dewMarginC: number | null;
  @EnumCol() pumpGroupMode: string;
  @BoolCol() flowSafety: boolean;
  /** NULL in rows saved before circuits had a mode (derived from their pumps on load). */
  @EnumCol(true) mode: string | null;
  @BoolCol(true) bypass: boolean | null;
  @IntCol() order: number;
}

/** Which sources can physically feed which circuit (M:N). */
@Entity('circuit_source')
export class CircuitSourceRow {
  @PrimaryColumn({ type: 'varchar', length: 64 }) circuitId: string;
  @Index() @PrimaryColumn({ type: 'varchar', length: 64 }) sourceId: string;
  @IntCol() order: number;
}

@Entity('pump')
export class PumpRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @Index() @IdCol(true) circuitId: string | null;
  @Index() @IdCol(true) manifoldId: string | null;
  @Index({ unique: true }) @EntityCol() entityId: string;
  @EnumCol() rule: string;
  @IntCol() runOnHeatMin: number;
  @IntCol() runOnCoolMin: number;
  @IntCol() minOnSec: number;
  @BoolCol() exercise: boolean;
  @JsonCol() speed: Pump['speed'];
  @BoolCol() enabled: boolean;
  @IntCol() order: number;
}
