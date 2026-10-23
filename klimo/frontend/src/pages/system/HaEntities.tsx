/**
 * «Сутності в Home Assistant»: what the add-on publishes through MQTT discovery, for
 * automations, voice and standard cards. Per-room entities are folded into one line each
 * («climate.klimo_* × 7»); the card transport entities are left out.
 */
import { useState } from 'react';
import type { ExposedEntityDto } from '@api/model';
import { api } from '@api/endpoints';
import { useResource } from '@data';
import { Button, EntityId, KeyValueList, Section, Skeleton, Stack } from '@ui';
import { t } from '@i18n';

/** Entities that only carry data to the dashboard cards. */
const HIDDEN = new Set(['hub', 'reply', 'card']);

function describe(e: ExposedEntityDto, perRoom: boolean): string {
  switch (e.role) {
    case 'climate':
      return t('thermostat of every room, with a range');
    case 'temperature':
      return perRoom ? t('room temperature') : t('temperature');
    case 'target':
      return t('room target');
    case 'humidity':
      return t('room humidity');
    case 'dew_point':
      return t('room dew point');
    case 'state':
      return t('what the room is doing');
    case 'window':
      return t('a window of the room is open');
    case 'boost':
      return t('a short boost in the room');
    case 'house_profile':
      return t('house profile');
    case 'season_mode':
      return t('mode: auto / heating / cooling / off');
    case 'season':
      return t('season now');
    case 'outdoor_average':
      return t('average outdoor temperature');
    case 'active_source':
      return t('which source runs');
    case 'heat_demand':
      return perRoom ? t('the room asks for heat') : t('there is a demand for heat');
    case 'cool_demand':
      return perRoom ? t('the room asks for cooling') : t('there is a demand for cooling');
    case 'problem':
      return t('something needs attention');
    case 'alerts':
      return t('open alerts');
    case 'power_used':
      return t('power used by heating and cooling');
    case 'resume_schedule':
      return perRoom ? t('back to the schedule in the room') : t('back to the schedule for the whole house');
    case 'control':
      return t('room control: schedule, manual or off');
    case 'schedule':
      return t('the house follows the schedule (off = paused)');
    case 'resync':
      return t('send the targets to every device again');
    case 'source':
      return t('the source runs');
    case 'trigger':
      return t('the trigger is active');
    case 'pump':
      return t('the pump runs');
    default:
      return e.role;
  }
}

/** «climate.klimo_*» for a group, from the ids' common start and end. */
function pattern(ids: readonly string[]): string {
  if (ids.length === 1) return ids[0];
  let pre = ids[0];
  let suf = ids[0];
  for (const id of ids) {
    while (!id.startsWith(pre)) pre = pre.slice(0, -1);
    while (!id.endsWith(suf)) suf = suf.slice(1);
  }
  if (pre.length + suf.length > Math.min(...ids.map((x) => x.length))) suf = '';
  return `${pre}*${suf}`;
}

/** The lines shown first, in this order; the rest opens on request. */
const FIRST = ['season_mode', 'house_profile', 'schedule', 'resume_schedule', 'active_source', 'heat_demand', 'cool_demand', 'climate', 'control', 'problem'];
/** Per-room lines that are shown first too: the ways to control a room. */
const ROOM_FIRST = new Set(['climate', 'control', 'resume_schedule']);

export function HaEntitiesSection() {
  const [all, setAll] = useState(false);
  const res = useResource('system:exposed', api.system.exposedEntities, { reloadOn: ['room', 'source', 'trigger', 'pump', 'circuit', 'settings'] });
  const list = (res.data ?? []).filter((e) => !HIDDEN.has(e.role));
  const groups = new Map<string, ExposedEntityDto[]>();
  for (const e of list) {
    // per-room entities and per-object switches are one line per kind
    const key = e.roomId || ['source', 'trigger', 'pump'].includes(e.role) ? `${e.component}:${e.role}:group` : e.entityId;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const rank = (g: ExposedEntityDto[]) => {
    const i = FIRST.indexOf(g[0].role);
    // the room-level demand lines come after the house-level ones of the same role
    return i >= 0 && !(g[0].roomId && !ROOM_FIRST.has(g[0].role)) ? i : FIRST.length + (g[0].roomId ? 1 : 0);
  };
  const sorted = [...groups.values()].sort((a, b) => rank(a) - rank(b));
  const shown = all ? sorted : sorted.filter((g) => rank(g) < FIRST.length);
  const rows = shown.map((g) => ({
    key: describe(g[0], Boolean(g[0].roomId)),
    value: g.length > 1 ? `${pattern(g.map((x) => x.entityId))} × ${g.length}` : <EntityId id={g[0].entityId} copyable />,
    mono: true,
  }));
  return (
    <Section id="entities" title={t('Entities in Home Assistant')} subtitle={t('MQTT discovery — for automations, voice and standard cards.')}>
      {res.data ? (
        <Stack gap="sm">
          <KeyValueList rows={rows} />
          {sorted.length > shown.length || all ? (
            <Button variant="link" size="sm" onClick={() => setAll((x) => !x)}>
              {all ? t('Show fewer') : t('All entities ({count})', { count: list.length })}
            </Button>
          ) : null}
        </Stack>
      ) : (
        <Skeleton height={240} radius={12} />
      )}
    </Section>
  );
}
