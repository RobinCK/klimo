import { Entity, Index, PrimaryColumn } from 'typeorm';
import type { ActivationRuleConfig, DayPlan, Dow } from '../../shared/model';
import { BoolCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, NameCol, PkCol, StrCol, TsCol } from '../columns';

@Entity('profile')
export class ProfileRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @EnumCol() kind: string;
  @StrCol(16) color: string;
  @StrCol(16) ink: string;
  @EnumCol() icon: string;
  @FloatCol() heatC: number;
  @FloatCol() coolC: number;
  @BoolCol() frostOnly: boolean;
  @IntCol() order: number;
}

/** A row exists only for 'own' or 'off'; no row = the room inherits the profile. */
@Entity('profile_room')
export class ProfileRoomRow {
  @PrimaryColumn({ type: 'varchar', length: 64 }) profileId: string;
  @Index() @PrimaryColumn({ type: 'varchar', length: 64 }) roomId: string;
  @EnumCol() mode: string;
  @FloatCol(true) heatC: number | null;
  @FloatCol(true) coolC: number | null;
  @TsCol(true) writtenAt: number | null;
}

@Entity('activation_rule')
export class ActivationRuleRow {
  @PkCol() id: string;
  @Index() @IdCol() profileId: string;
  @BoolCol() enabled: boolean;
  @IntCol() order: number;
  @JsonCol() config: ActivationRuleConfig;
}

@Entity('schedule')
export class ScheduleRow {
  @PkCol() id: string;
  @EnumCol() scope: string;
  @Index({ unique: true }) @IdCol(true) roomId: string | null;
  @BoolCol() enabled: boolean;
  @JsonCol() days: DayPlan[];
  @TsCol() updatedAt: number;
}

@Entity('schedule_exception')
@Index(['scheduleId', 'date'], { unique: true })
export class ScheduleExceptionRow {
  @PkCol() id: string;
  @IdCol() scheduleId: string;
  @StrCol(10) date: string;
  @JsonCol() plan: DayPlan | { likeDow: Dow };
  @StrCol(255, true) note: string | null;
}
