import { Entity } from 'typeorm';
import type {
  Actor,
  ChainEntry,
  ConditionNode,
  CoolStrategy,
  DeviceHealthSettings,
  EnergyPolicy,
  GeneralSettings,
  HeatStrategy,
  NotifySettings,
  PriorityKey,
  SafetySettings,
} from '../../shared/model';
import { BoolCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, NameCol, PkCol, TsCol } from '../columns';

/* Singletons: one row each, id = 'main'. */

@Entity('settings')
export class SettingsRow {
  @PkCol() id: string;
  @NameCol() houseName: string;
  @JsonCol() outdoor: GeneralSettings['outdoor'];
  @EnumCol() units: GeneralSettings['units'];
  @EnumCol() notificationLanguage: GeneralSettings['notificationLanguage'];
  @EnumCol() uiLanguage: GeneralSettings['uiLanguage'];
  @IdCol() defaultProfileId: string;
  @IdCol() ecoProfileId: string;
  @JsonCol() targetLimits: GeneralSettings['targetLimits'];
  @EnumCol() haTargetChangeDuration: GeneralSettings['haTargetChangeDuration'];
  @BoolCol() adminOnlyConfig: boolean;
  @BoolCol() mqttConfigEntities: boolean;
  @FloatCol() glassCoefficient: number;
  @JsonCol() presence: GeneralSettings['presence'];
  @JsonCol() defaults: GeneralSettings['defaults'];
  @JsonCol() tariffs: GeneralSettings['tariffs'];
  @BoolCol() onboardingDismissed: boolean;
  @TsCol() updatedAt: number;
}

@Entity('safety_settings')
export class SafetySettingsRow {
  @PkCol() id: string;
  @FloatCol() frostC: number;
  @FloatCol() frostReleaseC: number;
  @FloatCol() frostSupplyAlertC: number;
  @FloatCol() overheatC: number;
  @FloatCol() overheatReleaseC: number;
  @FloatCol() noDataTrvSetpointC: number;
  @IntCol() sourceConfirmDefaultMin: number;
  @IntCol() relayWatchdogMin: number;
  @IntCol() relayRearmEveryMin: number;
  @BoolCol() reconcileOnRestart: boolean;
  @IntCol() haBlindAfterSec: number;
  @IntCol() haDisconnectAlertMin: number;
  @IntCol() startupDryRunSec: number;
  @BoolCol() trvHandbackOnStop: boolean;
  @JsonCol() pumpExercise: SafetySettings['pumpExercise'];
  @JsonCol() valveExercise: SafetySettings['valveExercise'];
  @JsonCol() commandRate: SafetySettings['commandRate'];
  @JsonCol() conflict: SafetySettings['conflict'];
  @TsCol() updatedAt: number;
}

@Entity('house_settings')
export class HouseSettingsRow {
  @PkCol() id: string;
  @EnumCol() mode: 'auto' | 'heat' | 'cool' | 'off';
  @TsCol() modeChangedAt: number;
  @JsonCol() modeChangedBy: Actor | null;
  @JsonCol() priority: PriorityKey[];
}

@Entity('heat_strategy')
export class HeatStrategyRow {
  @PkCol() id: string;
  @JsonCol() chain: ChainEntry[];
  @JsonCol() bivalence: HeatStrategy['bivalence'];
  @JsonCol() lag: HeatStrategy['lag'];
  @FloatCol(true) heatingCutoffOutdoorC: number | null;
}

@Entity('cool_strategy')
export class CoolStrategyRow {
  @PkCol() id: string;
  @JsonCol() chain: ChainEntry[];
  @EnumCol() hpModeSelection: CoolStrategy['hpModeSelection'];
  @FloatCol() dewMarginC: number;
  @FloatCol() changeoverMinH: number;
  @FloatCol() autoMinGapC: number;
  @JsonCol() dryInsteadOfCool: CoolStrategy['dryInsteadOfCool'];
  @FloatCol(true) floorExcludeAbovePct: number | null;
  @JsonCol() solarPrecool: CoolStrategy['solarPrecool'];
  @BoolCol() singleRoomCentralStart: boolean;
}

@Entity('season_config')
export class SeasonConfigRow {
  @PkCol() id: string;
  @IntCol() avgDays: number;
  @FloatCol() heatBelowC: number;
  @FloatCol() coolAboveC: number;
  @FloatCol() hysteresisC: number;
  @FloatCol() minDwellH: number;
  @FloatCol() confirmH: number;
  @JsonCol() heatingMonths: boolean[];
  @JsonCol() coolingMonths: boolean[];
  @FloatCol() neutralColdGuardC: number;
}

@Entity('energy_policy')
export class EnergyPolicyRow {
  @PkCol() id: string;
  @FloatCol() budgetKw: number;
  @FloatCol(true) inverterMaxKw: number | null;
  @IntCol() staggerSec: number;
  @JsonCol() shedOrder: string[];
  @BoolCol() shedOrderCustom: boolean;
  @JsonCol() exempt: EnergyPolicy['exempt'];
  @FloatCol() criticalSocPct: number;
  @JsonCol() entities: EnergyPolicy['entities'];
  @JsonCol() activeWhen: ConditionNode;
}

@Entity('notify_settings')
export class NotifySettingsRow {
  @PkCol() id: string;
  @JsonCol() telegram: NotifySettings['telegram'];
  @BoolCol() criticalBypassDnd: boolean;
  @JsonCol() quietHours: NotifySettings['quietHours'];
  @JsonCol() grouping: NotifySettings['grouping'];
  @JsonCol() repeatCritical: NotifySettings['repeatCritical'];
  @JsonCol() escalation: NotifySettings['escalation'];
  @BoolCol() recoveryMessages: boolean;
  @BoolCol() watchAllUsedEntities: boolean;
  @JsonCol() reports: NotifySettings['reports'];
  @IntCol() actionTtlH: number;
  @TsCol() updatedAt: number;
}

@Entity('device_health_settings')
export class DeviceHealthSettingsRow {
  @PkCol() id: string;
  @JsonCol() batteryLow: DeviceHealthSettings['batteryLow'];
  @JsonCol() offline: DeviceHealthSettings['offline'];
  @JsonCol() trvUnconfirmed: DeviceHealthSettings['trvUnconfirmed'];
  @JsonCol() weakSignal: DeviceHealthSettings['weakSignal'];
  @TsCol() updatedAt: number;
}
