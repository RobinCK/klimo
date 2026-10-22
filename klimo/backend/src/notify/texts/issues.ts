import type { IssueCode } from '../../shared/model';
import type { Row, Vars } from './format';

const offline = (v: Vars) => Math.max(0, (Number(v.total) || 0) - (Number(v.left) || 0));

/** Room issue chips (room card, rooms list), [en, uk]. Params per code: the room issue table. */
export const ISSUES: Record<IssueCode, Row> = {
  no_data: ['No temperature data', 'Немає даних про температуру'],
  sensor_offline: [
    (v) => `${offline(v)} of {total|sensor|sensors} offline`,
    (v) => `${offline(v)} з {total|датчика|датчиків|датчиків} не на зв’язку`,
  ],
  source_fault: ['{sourceId} failed[ — {fallbackId} took over]', '{sourceId}: аварія[ — працює {fallbackId}]'],
  trv_failed: [
    (v) => (v.deviceId ? '{deviceId} did not confirm the target' : 'A radiator valve did not confirm the target'),
    (v) => (v.deviceId ? '{deviceId}: головка не підтвердила ціль' : 'Головка не підтвердила ціль'),
  ],
  entity_missing: ['{entityId} is missing in Home Assistant', '{entityId}: немає в Home Assistant'],
  too_cold: ['{deltaC} colder than the target[ for {minutes}]', 'На {deltaC} холодніше за ціль[ уже {minutes}]'],
  too_hot: ['{deltaC} warmer than the target[ for {minutes}]', 'На {deltaC} тепліше за ціль[ уже {minutes}]'],
  trv_retry: ['Radiator valve did not confirm · retry {attempt}/{of}', 'Головка не підтвердила · повтор {attempt}/{of}'],
  overheat: ['Overheating: {t}', 'Перегрів: {t}'],
  source_wait: ['{sourceId} on a pause · starts at {until}', '{sourceId} на паузі · старт о {until}'],
  fallback_sensors: ['Using backup sensors', 'Резервні датчики'],
  actuator_conflict: ['Something else keeps changing {entityId}', '{entityId} постійно змінює щось інше'],
  condensation: ['Humidity {rh} · condensation risk', 'Вологість {rh} · ризик конденсату'],
  humidity_high: ['Humidity {rh}', 'Вологість {rh}'],
  floor_humid: ['Humid ({rh}) — no floor cooling', 'Волого ({rh}) — без охолодження підлогою'],
  battery_low: [
    (v) => (v.deviceKey ? '{deviceKey}: battery {pct}' : 'Sensor: battery {pct}'),
    (v) => (v.deviceKey ? '{deviceKey}: батарея {pct}' : 'Датчик: батарея {pct}'),
  ],
  window_long: ['Window open[ for {since:ago}]', 'Вікно відкрите[ {since:ago}]'],
  signal_weak: ['Weak signal (LQI {lqi})', 'Слабкий сигнал (LQI {lqi})'],
  humid_dry_hint: ['Humidity {rh} — drying would help', 'Вологість {rh} — варто осушити'],
  airing_hint: ['Humidity {rh} — time to air the room', 'Вологість {rh} — варто провітрити'],
};
