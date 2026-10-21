import { Entity, Index } from 'typeorm';
import type { DeviceTransport, Emitter, RoomConfig, TrvCapabilities, TrvSiblings } from '../../shared/model';
import { BoolCol, EntityCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, NameCol, PkCol, StrCol, TsCol } from '../columns';

@Entity('room')
export class RoomRow {
  @PkCol() id: string;
  @Index({ unique: true }) @StrCol(40) slug: string;
  @NameCol() name: string;
  @IntCol() order: number;
  @EnumCol(true) icon: string | null;
  @EntityCol(true) haAreaId: string | null;
  @BoolCol() controlEnabled: boolean;
  @JsonCol() tolerance: RoomConfig['tolerance'];
  @JsonCol() demand: RoomConfig['demand'];
  @JsonCol() limits: RoomConfig['limits'];
  @JsonCol() temperature: RoomConfig['temperature'];
  @JsonCol() humidity: RoomConfig['humidity'];
  @JsonCol() windows: RoomConfig['windows'];
  @JsonCol() trv: RoomConfig['trv'];
  @JsonCol() ac: RoomConfig['ac'];
  @JsonCol() smart: RoomConfig['smart'];
  @JsonCol() quick: RoomConfig['quick'];
  @JsonCol() floor: RoomConfig['floor'];
  @FloatCol(true) frostC: number | null;
  @BoolCol() sunnySide: boolean;
  @JsonCol() notify: RoomConfig['notify'];
  @TsCol() createdAt: number;
  @TsCol() updatedAt: number;
}

@Entity('room_sensor')
@Index(['roomId', 'role', 'entityId'], { unique: true })
export class RoomSensorRow {
  @PkCol() id: string;
  @Index() @IdCol() roomId: string;
  @EntityCol() entityId: string;
  @EnumCol() role: string;
  @EnumCol(true) contactKind: string | null;
  @NameCol() name: string;
  @EntityCol(true) model: string | null;
  @IdCol(true) haDeviceId: string | null;
  @FloatCol() weight: number;
  @BoolCol() included: boolean;
  @EnumCol(true) excludedBy: string | null;
  @IntCol() order: number;
}

@Entity('emitter')
export class EmitterRow {
  @PkCol() id: string;
  @Index() @IdCol() roomId: string;
  @EnumCol() kind: string;
  @NameCol() name: string;
  @IntCol() order: number;
  @BoolCol() enabled: boolean;
  @Index() @IdCol(true) circuitId: string | null;
  @Index() @IdCol(true) sourceId: string | null;
  @JsonCol() roles: Emitter['roles'];
  @JsonCol() assist: Emitter['assist'];
  @JsonCol() trigger: Emitter['trigger'];
  @BoolCol() excludeFromCooling: boolean;
  @BoolCol() ignoreSeason: boolean;
}

@Entity('emitter_device')
export class EmitterDeviceRow {
  @PkCol() id: string;
  @Index() @IdCol() emitterId: string;
  @Index() @IdCol() roomId: string;
  @EnumCol() kind: string;
  @Index({ unique: true }) @EntityCol() entityId: string;
  @NameCol() name: string;
  @NameCol(true) label: string | null;
  @IdCol(true) haDeviceId: string | null;
  @EntityCol(true) model: string | null;
  @EntityCol(true) manufacturer: string | null;
  @JsonCol() transport: DeviceTransport;
  @JsonCol() capabilities: TrvCapabilities | null;
  @JsonCol() siblings: TrvSiblings | null;
  @IntCol() order: number;
}
