import type { HumidityMethod } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useEntitySearch, useMutation } from '@data';
import { AutoGrid, Button, ComfortBar, EntityId, EntityPicker, FallbackNote, KeyValueList, Section, SegmentedControl, SensorRow, Stack, StatTile } from '@ui';
import { fmtDelta, fmtNum, fmtPct, fmtTemp, humidityMethodLabel, t } from '@i18n';
import { AddEntityDialog } from '../AddEntityDialog';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import { lockable, SettingPill } from './readonly';
import { EditSensorDialog, readingOf, sensorMeta } from './Sensors';
import type { SectionDef, SectionProps } from './types';

const METHODS: HumidityMethod[] = ['average', 'median', 'max', 'min'];

function Body(p: SectionProps) {
  const { room, state } = p;
  const id = room.config.id;
  const hum = useAutosave(room.config.humidity, (v) => p.save({ humidity: v }));
  const search = useEntitySearch('switchable', { roomId: id });
  const dialog = useOpenDialog();
  const add = useMutation((entityId: string, name: string) => api.rooms.sensors.add(id, { entityId, role: 'humidity', name: name || undefined }), {
    onSuccess: (r) => {
      p.setRoom(r);
      closeDialog();
    },
  });
  const toggle = useMutation((sid: string, included: boolean) => api.rooms.sensors.patch(id, sid, { included }), { onSuccess: (r) => p.setRoom(r) });
  const h = state.humidity;
  // listed, so it is clear which hygrometers the room reads (a switched-off one included)
  const sensors = room.sensors.filter((s) => s.role === 'humidity').sort((a, b) => a.order - b.order);
  const editing = dialog?.startsWith('edit-sensor:') ? (sensors.find((s) => `edit-sensor:${s.id}` === dialog) ?? null) : null;
  const count = sensors.filter((s) => s.included).length;
  const v = hum.value;
  const dehum = v.dehumidifier;
  // a switch that already drives something else is refused; the reason belongs under the picker
  const dehumError = hum.formErrors({ entity: ['humidity.dehumidifier.entityId'] }).fields.entity;
  return (
    <Stack gap="lg">
      {sensors.length ? (
        <Stack gap="xs">
          {sensors.map((s) => {
            const r = readingOf(p, s.id);
            return (
              <SensorRow
                key={s.id}
                included={s.included}
                onToggle={(on) => p.canEdit && void toggle.run(s.id, on)}
                name={s.name}
                entityId={p.phone ? undefined : s.entityId}
                valueText={fmtPct(r?.humidityPct ?? null)}
                excluded={!s.included || (r?.status ?? 'ok') !== 'ok'}
                meta={sensorMeta(p, s, r)}
                onEdit={p.canEdit ? () => openDialog(`edit-sensor:${s.id}`) : undefined}
              />
            );
          })}
        </Stack>
      ) : null}
      {count ? (
        <>
          <AutoGrid min={100} columns={3} gap="sm">
            <StatTile
              variant="well"
              title={count > 1 ? t('{method} of {count} sensors', { method: humidityMethodLabel(v.method), count }) : t('Humidity')}
              value={fmtPct(h.valuePct)}
            />
            <StatTile
              variant="well"
              title={t('Dew point')}
              value={fmtTemp(h.dewPointC)}
              hint={t('The temperature at which this air starts to leave water on a surface. Anything colder than {dew} — a window pane, a cold wall corner, a floor cooled from below — gets damp. It rises with humidity: at {t} and 60% it is about {dew60}.', {
                dew: fmtTemp(h.dewPointC),
                t: fmtTemp(21, { decimals: 0 }),
                dew60: fmtTemp(13, { decimals: 0 }),
              })}
            />
            <StatTile
              variant="well"
              title={t('Absolute')}
              value={h.absGm3 != null ? t('{v} g/m³', { v: fmtNum(h.absGm3, 1) }) : '—'}
              hint={t('How many grams of water a cubic metre of this air holds, whatever its temperature. Cold outdoor air holds far less, so in the heating season airing dries the room even when it rains outside.')}
            />
          </AutoGrid>
          <ComfortBar
            valuePct={h.valuePct}
            comfort={v.comfortPct}
            labels={{ start: '0%', comfort: t('comfort {lo}–{hi}%', { lo: v.comfortPct[0], hi: v.comfortPct[1] }), end: '100%' }}
            ariaLabel={t('Humidity {v}, comfortable {lo}–{hi}%', { v: fmtPct(h.valuePct), lo: v.comfortPct[0], hi: v.comfortPct[1] })}
          />
          {count > 1 ? (
            <SegmentedControl<HumidityMethod>
              value={v.method}
              options={lockable(
                METHODS.map((m) => ({ value: m, label: humidityMethodLabel(m) })),
                p.canEdit,
              )}
              onChange={(m) => hum.set((x) => ({ ...x, method: m }))}
              ariaLabel={t('How to combine the humidity sensors')}
            />
          ) : null}
        </>
      ) : (
        <FallbackNote
          icon="droplet"
          text={
            sensors.length
              ? t('No humidity sensor counts — tick one in the list; the warnings and the dehumidifier need one.')
              : t('No humidity sensor in this room — the warnings and the dehumidifier need one.')
          }
        />
      )}
      <KeyValueList
        rows={[
          {
            key: t('Warn above'),
            value: (
              <SettingPill
                readOnly={!p.canEdit}
                text={fmtPct(v.warnAbovePct)}
                ariaLabel={t('Warn above')}
                editor={{ kind: 'number', min: 50, max: 90, step: 1, unit: '%' }}
                value={v.warnAbovePct}
                onChange={(x: number) => hum.set((c) => ({ ...c, warnAbovePct: x }))}
              />
            ),
          },
          {
            key: t('or when the glass is this close to the dew point'),
            hint: t('In the heating season the window glass is the coldest surface. Its temperature is estimated from the room and outdoor temperatures (or read from a glass sensor, if the room has one); when it comes closer than this to the dew point, a condensation warning is raised. Now: glass ≈ {glass}, dew point {dew}. Default: {def}.', {
              glass: fmtTemp(h.glassC),
              dew: fmtTemp(h.dewPointC),
              def: fmtDelta(3, { decimals: 0 }),
            }),
            value: (
              <SettingPill
                readOnly={!p.canEdit}
                text={fmtDelta(v.dewGlassMarginC)}
                ariaLabel={t('Margin to the dew point on the glass')}
                editor={{ kind: 'number', min: 0.5, max: 10, step: 0.5, unit: '°' }}
                value={v.dewGlassMarginC}
                onChange={(x: number) => hum.set((c) => ({ ...c, dewGlassMarginC: x }))}
              />
            ),
          },
        ]}
      />
      <SegmentedControl<'notify' | 'auto_pause'>
        value={v.airingHint}
        options={lockable(
          [
            { value: 'notify', label: t('Suggest airing') },
            { value: 'auto_pause', label: t('Pause the heat by itself') },
          ],
          p.canEdit,
        )}
        onChange={(x) => hum.set((c) => ({ ...c, airingHint: x }))}
        full={p.phone}
        ariaLabel={t('When the room should be aired')}
        hint={
          v.airingHint === 'auto_pause' ? t('The airing hint pauses the heating for 10 min by itself.') : t('A notification with an «Air the room» button.')
        }
      />
      <Section
        variant="plain"
        level={3}
        title={t('Dehumidifier')}
        subtitle={
          dehum
            ? t('Switched on above {on} and off below {off}.', { on: fmtPct(dehum.onAbovePct), off: fmtPct(dehum.offBelowPct) })
            : t('Optional: a plug or a dehumidifier switched by the humidity.')
        }
      >
        <Stack gap="sm">
          {p.canEdit ? (
            <EntityPicker
              value={dehum?.entityId ?? null}
              onChange={(entityId) =>
                hum.set((c) => ({
                  ...c,
                  dehumidifier: entityId
                    ? {
                        entityId,
                        onAbovePct: c.dehumidifier?.onAbovePct ?? 62,
                        offBelowPct: c.dehumidifier?.offBelowPct ?? 57,
                        minOnMin: c.dehumidifier?.minOnMin ?? 10,
                      }
                    : null,
                }))
              }
              search={search}
              placeholder={t('Pick a switch or a plug')}
              clearable
              error={dehumError}
            />
          ) : dehum ? (
            <EntityId id={dehum.entityId} />
          ) : null}
          {dehum ? (
            <KeyValueList
              rows={[
                {
                  key: t('Switch on above'),
                  value: (
                    <SettingPill
                      readOnly={!p.canEdit}
                      text={fmtPct(dehum.onAbovePct)}
                      ariaLabel={t('Switch on above')}
                      editor={{ kind: 'number', min: 40, max: 90, step: 1, unit: '%' }}
                      value={dehum.onAbovePct}
                      onChange={(x: number) =>
                        hum.set((c) =>
                          c.dehumidifier
                            ? { ...c, dehumidifier: { ...c.dehumidifier, onAbovePct: x, offBelowPct: Math.min(c.dehumidifier.offBelowPct, x - 1) } }
                            : c,
                        )
                      }
                    />
                  ),
                },
              ]}
            />
          ) : null}
        </Stack>
      </Section>
      {p.phone && p.canEdit ? (
        <Button variant="secondary" icon="plus" onClick={() => openDialog('add-humidity')} fullWidth>
          {t('Add a humidity sensor')}
        </Button>
      ) : null}
      <AddEntityDialog
        open={dialog === 'add-humidity'}
        title={t('Add a humidity sensor')}
        role="humidity"
        roomId={id}
        placeholder={t('Search a humidity sensor')}
        onClose={closeDialog}
        onSubmit={(entityId, name) => add.run(entityId, name)}
        errors={add}
      />
      <EditSensorDialog p={p} sensor={editing} weight={false} />
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const h = p.state.humidity;
  if (h.valuePct == null) return t('no humidity sensor');
  return [
    fmtPct(h.valuePct),
    t('dew point {t}', { t: fmtTemp(h.dewPointC) }),
    t('warning above {pct}', { pct: fmtPct(p.room.config.humidity.warnAbovePct) }),
  ].join(' · ');
}

export const humiditySection: SectionDef = {
  key: 'hum',
  icon: 'droplet',
  title: () => t('Humidity'),
  summary,
  action: (p) =>
    p.canEdit ? (
      <Button variant="secondary" size="sm" icon="plus" onClick={() => openDialog('add-humidity')}>
        {t('Add a sensor')}
      </Button>
    ) : null,
  Body,
};
