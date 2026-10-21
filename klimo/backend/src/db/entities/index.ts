import { IncidentRow, JournalRow, RunSpanRow, SentMessageRow } from './log.entity';
import { DeviceMetaRow, EventParamsRow, NotifyRoutingRow, NotifyTargetRow, PersonalPrefsRow, WatchRuleRow, Z2mInstanceRow } from './notify.entity';
import { ActivationRuleRow, ProfileRoomRow, ProfileRow, ScheduleExceptionRow, ScheduleRow } from './profile.entity';
import { EmitterDeviceRow, EmitterRow, RoomRow, RoomSensorRow } from './room.entity';
import {
  ActuatorStateRow,
  ConditionStateRow,
  KvRow,
  OverrideRow,
  PlantStateRow,
  PumpControlStateRow,
  RoomControlStateRow,
  SeasonStateRow,
  SourceControlStateRow,
} from './runtime.entity';
import {
  CoolStrategyRow,
  DeviceHealthSettingsRow,
  EnergyPolicyRow,
  HeatStrategyRow,
  HouseSettingsRow,
  NotifySettingsRow,
  SafetySettingsRow,
  SeasonConfigRow,
  SettingsRow,
} from './settings.entity';
import { CircuitRow, CircuitSourceRow, ManifoldRow, PumpRow, SourceRow } from './source.entity';
import { TriggerRow, TriggerRuleRow } from './trigger.entity';

export * from './log.entity';
export * from './notify.entity';
export * from './profile.entity';
export * from './room.entity';
export * from './runtime.entity';
export * from './settings.entity';
export * from './source.entity';
export * from './trigger.entity';

/** Every table of the database (TypeORM `synchronize` creates and extends them). */
export const ENTITIES = [
  // configuration (exported/imported)
  SettingsRow,
  SafetySettingsRow,
  HouseSettingsRow,
  RoomRow,
  RoomSensorRow,
  EmitterRow,
  EmitterDeviceRow,
  SourceRow,
  ManifoldRow,
  CircuitRow,
  CircuitSourceRow,
  PumpRow,
  ProfileRow,
  ProfileRoomRow,
  ActivationRuleRow,
  ScheduleRow,
  ScheduleExceptionRow,
  HeatStrategyRow,
  CoolStrategyRow,
  SeasonConfigRow,
  EnergyPolicyRow,
  TriggerRow,
  TriggerRuleRow,
  NotifySettingsRow,
  NotifyTargetRow,
  NotifyRoutingRow,
  EventParamsRow,
  WatchRuleRow,
  PersonalPrefsRow,
  Z2mInstanceRow,
  DeviceHealthSettingsRow,
  DeviceMetaRow,
  // runtime and logs (never exported)
  OverrideRow,
  RoomControlStateRow,
  SourceControlStateRow,
  PumpControlStateRow,
  ConditionStateRow,
  SeasonStateRow,
  PlantStateRow,
  ActuatorStateRow,
  IncidentRow,
  SentMessageRow,
  JournalRow,
  RunSpanRow,
  KvRow,
];
