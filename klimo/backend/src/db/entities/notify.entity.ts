import { Entity, Index, PrimaryColumn } from 'typeorm';
import type { PersonalPrefs, WatchCondition, WatchRule } from '../../shared/model';
import { BoolCol, EntityCol, EnumCol, IdCol, IntCol, JsonCol, NameCol, PkCol, StrCol } from '../columns';

@Entity('notify_target')
export class NotifyTargetRow {
  @PkCol() id: string;
  @EnumCol() channel: string;
  @NameCol() name: string;
  @NameCol(true) shortName: string | null;
  @EnumCol() icon: string;
  @BoolCol() enabled: boolean;
  @IntCol() order: number;
  @EntityCol(true) service: string | null;
  @IdCol(true) chatId: string | null;
  @EntityCol(true) chatTitle: string | null;
  @BoolCol() isPrimary: boolean;
  @BoolCol() isEscalation: boolean;
  @IdCol(true) ownerUserId: string | null;
}

/** Only cells that differ from the catalogue default are stored. */
@Entity('notify_routing')
export class NotifyRoutingRow {
  @PrimaryColumn({ type: 'varchar', length: 24 }) kind: string;
  @PrimaryColumn({ type: 'varchar', length: 64 }) targetId: string;
  @BoolCol() on: boolean;
}

@Entity('event_params')
export class EventParamsRow {
  @PrimaryColumn({ type: 'varchar', length: 24 }) kind: string;
  @BoolCol() enabled: boolean;
  @JsonCol() params: Record<string, number | string | boolean>;
}

/** Manual rules plus auto rules the user edited or muted; other auto rules are derived, not stored. */
@Entity('watch_rule')
export class WatchRuleRow {
  @PkCol(255) id: string;
  @EnumCol() origin: string;
  @Index() @EntityCol() entityId: string;
  @StrCol(255) name: string;
  @StrCol(32) role: string;
  @JsonCol() ref: WatchRule['ref'];
  @JsonCol() condition: WatchCondition;
  @EnumCol() severity: string;
  @EnumCol() eventKind: string;
  @BoolCol() muted: boolean;
}

@Entity('personal_prefs')
export class PersonalPrefsRow {
  @PkCol() userId: string;
  @JsonCol() targetIds: string[];
  @JsonCol() levels: PersonalPrefs['levels'];
  @BoolCol() quietHours: boolean;
}

@Entity('z2m_instance')
export class Z2mInstanceRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @Index({ unique: true }) @EntityCol() baseTopic: string;
  @StrCol(255, true) frontendUrl: string | null;
  @EntityCol(true) bridgeEntityId: string | null;
  @BoolCol() resendOnRestart: boolean;
}

@Entity('device_meta')
export class DeviceMetaRow {
  @PkCol(255) key: string;
  @NameCol(true) label: string | null;
  @BoolCol() ignored: boolean;
  @StrCol(32, true) batteryType: string | null;
}
