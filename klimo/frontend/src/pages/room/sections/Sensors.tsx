import { useEffect, useState } from 'react';
import type { AggregationMethod, RoomSensor, SensorReading } from '@api/model';
import { AGGREGATION_METHODS } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useMutation } from '@data';
import { Button, CheckboxRow, Dialog, FallbackNote, KeyValueList, RadioValueGrid, SensorRow, Stack, Stepper, Text, TextField } from '@ui';
import { aggregationHint, aggregationLabel, fmtAgo, fmtDelta, fmtDur, fmtNum, fmtTemp, sensorStaleHint, t } from '@i18n';
import { AddEntityDialog, SENSOR_FIELDS } from '../AddEntityDialog';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import { SettingPill } from './readonly';
import type { SectionDef, SectionProps } from './types';

const STALE_OPTIONS = [15, 30, 60, 90, 120, 180, 240];
const SMOOTHING_OPTIONS = [0, 2, 5, 10, 15];

function temperatureSensors(p: SectionProps): RoomSensor[] {
  return p.room.sensors.filter((s) => s.role === 'temperature').sort((a, b) => a.order - b.order);
}

export function readingOf(p: SectionProps, id: string): SensorReading | undefined {
  return p.state.sensors.find((r) => r.sensorId === id);
}

export function sensorMeta(p: SectionProps, s: RoomSensor, r: SensorReading | undefined): string {
  const parts: string[] = [];
  if (s.model) parts.push(s.model);
  if (r?.status === 'stale' || r?.status === 'unavailable') {
    parts.push(r.lastReportedAt != null ? t('no data for {dur}', { dur: fmtDur((p.now - r.lastReportedAt) / 60000) }) : t('no data'));
  } else if (r?.lastReportedAt != null) parts.push(t('reported {ago}', { ago: fmtAgo(r.lastReportedAt, p.now) }));
  return parts.join(' · ');
}

function sensorNote(r: SensorReading | undefined, outlierC: number): { note?: string; tone?: 'warn' | 'err' } {
  if (!r) return {};
  if (r.status === 'outlier')
    return { note: t('{delta} from the others — not counted for now', { delta: fmtDelta(r.deviationC, { sign: true }) }), tone: 'warn' };
  if (r.status === 'unavailable') return { note: t('offline — the room is counted from the others'), tone: 'err' };
  if (r.status === 'stale') return { note: t('no fresh data — the room is counted from the others'), tone: 'warn' };
  if (r.deviationC != null && Math.abs(r.deviationC) >= Math.min(1, outlierC * 0.6))
    return { note: t('{delta} from the others', { delta: fmtDelta(r.deviationC, { sign: true }) }), tone: 'warn' };
  return {};
}

/** «Основний датчик»: which sensor counts while that method is chosen (the first in the room's order). */
interface MainChoice {
  isMain: boolean;
  make: () => void;
  pending: boolean;
}

/** Name and weight of one sensor of the room, or its removal; `weight` false for sensors no average weighs. */
export function EditSensorDialog({ p, sensor, weight: withWeight = true, main }: { p: SectionProps; sensor: RoomSensor | null; weight?: boolean; main?: MainChoice }) {
  const [name, setName] = useState('');
  const [weight, setWeight] = useState(1);
  const save = useMutation((id: string) => api.rooms.sensors.patch(p.room.config.id, id, { name: name.trim() || sensor?.name, weight }), {
    onSuccess: (r) => {
      p.setRoom(r);
      closeDialog();
    },
  });
  const remove = useMutation((id: string) => api.rooms.sensors.remove(p.room.config.id, id), {
    onSuccess: (r) => {
      p.setRoom(r);
      closeDialog();
    },
    okToast: t('The sensor is no longer used in this room.'),
  });
  useEffect(() => {
    if (sensor) {
      setName(sensor.name);
      setWeight(sensor.weight);
    }
  }, [sensor]);
  const sensorId = sensor?.id;
  const { reset: resetSave } = save;
  const { reset: resetRemove } = remove;
  // the verdict on the last attempt belongs to that opening, not to the next sensor
  useEffect(() => {
    resetSave();
    resetRemove();
  }, [sensorId, resetSave, resetRemove]);
  // the weight stepper has no error line: its problem is said, with its name, above the buttons
  const shown = save.formErrors({ name: SENSOR_FIELDS.name });
  return (
    <Dialog
      open={sensor != null}
      onClose={closeDialog}
      title={sensor?.name ?? ''}
      error={shown.message ?? remove.message}
      actions={[
        { label: t('Remove from the room'), variant: 'danger', onClick: () => sensor && void remove.run(sensor.id), loading: remove.pending },
        { label: t('Cancel'), onClick: closeDialog },
        { label: t('Save'), onClick: () => sensor && void save.run(sensor.id), loading: save.pending },
      ]}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={name} onChange={setName} maxLength={40} error={shown.fields.name} />
        {withWeight ? (
          <Stepper
            variant="square"
            label={t('Weight')}
            sub={t('for the weighted average: a sensor you trust more counts more')}
            value={weight}
            text={fmtNum(weight, 1)}
            min={0.1}
            max={2}
            step={0.1}
            onChange={setWeight}
            ariaDec={t('Lower the weight')}
            ariaInc={t('Raise the weight')}
          />
        ) : null}
        {main ? (
          main.isMain ? (
            <Text variant="caption">{t('The main sensor: it alone counts; the next one in the list steps in while it is silent.')}</Text>
          ) : (
            <Stack gap="xs" align="start">
              <Button variant="secondary" size="sm" icon="check" onClick={main.make} loading={main.pending}>
                {t('Make it the main sensor')}
              </Button>
              <Text variant="caption">{t('With «{method}» only the main sensor counts.', { method: aggregationLabel('primary') })}</Text>
            </Stack>
          )
        ) : null}
      </Stack>
    </Dialog>
  );
}

function Body(p: SectionProps) {
  const { room, state } = p;
  const id = room.config.id;
  const sensors = temperatureSensors(p);
  const temp = useAutosave(room.config.temperature, (v) => p.save({ temperature: v }));
  const toggle = useMutation((sid: string, included: boolean) => api.rooms.sensors.patch(id, sid, { included }), { onSuccess: (r) => p.setRoom(r) });
  const add = useMutation((entityId: string, name: string) => api.rooms.sensors.add(id, { entityId, role: 'temperature', name: name || undefined }), {
    onSuccess: (r) => {
      p.setRoom(r);
      closeDialog();
    },
  });
  const dialog = useOpenDialog();
  const editing = dialog?.startsWith('edit-sensor:') ? (sensors.find((s) => `edit-sensor:${s.id}` === dialog) ?? null) : null;
  const method = temp.value.method;
  // the main sensor is the first of the room's order; moving one up front makes it the main one
  const makeMain = useMutation(
    (sid: string) => api.rooms.sensors.reorder(id, { role: 'temperature', ids: [sid, ...sensors.filter((s) => s.id !== sid).map((s) => s.id)] }),
    {
      onSuccess: (r) => {
        p.setRoom(r);
        closeDialog();
      },
      okToast: (_r, sid) => t('«{name}» is the main sensor now.', { name: sensors.find((s) => s.id === sid)?.name ?? '' }),
    },
  );
  const mainId = method === 'primary' ? sensors[0]?.id : undefined;
  const values = state.aggregation.values;
  const trvs = state.aggregation.trvValues;
  const showWeight = method === 'weighted' || sensors.some((s) => s.weight !== 1);

  return (
    <Stack gap="lg">
      {sensors.length ? (
        <Stack gap="xs">
          {sensors.map((s) => {
            const r = readingOf(p, s.id);
            const note = sensorNote(r, temp.value.outlier.thresholdC);
            const counted = s.included && (r?.status ?? 'ok') === 'ok';
            return (
              <SensorRow
                key={s.id}
                included={s.included}
                onToggle={(on) => p.canEdit && void toggle.run(s.id, on)}
                name={s.name}
                entityId={p.phone ? undefined : s.entityId}
                weightText={s.id === mainId ? t('main') : showWeight ? t('weight {w}', { w: fmtNum(s.weight, 1) }) : undefined}
                valueText={fmtTemp(r?.smoothedC ?? r?.rawC ?? null)}
                excluded={!counted}
                meta={sensorMeta(p, s, r)}
                note={note.note}
                noteTone={note.tone}
                onEdit={p.canEdit ? () => openDialog(`edit-sensor:${s.id}`) : undefined}
              />
            );
          })}
        </Stack>
      ) : (
        <FallbackNote icon="thermometer" text={t('No temperature sensor yet — add one, or the radiator valves’ own readings are used.')} />
      )}
      {trvs.length ? (
        <FallbackNote
          icon="shield"
          text={
            state.aggregation.fallback === 'trv'
              ? t('All sensors are unavailable — counting from the radiator valves: {values} with their offset.', {
                  values: trvs.map((x) => fmtTemp(x.correctedC)).join(', '),
                })
              : t('Backup — the radiator valves: {values} with their offset. Only if all sensors are unavailable.', {
                  values: trvs.map((x) => fmtTemp(x.correctedC)).join(', '),
                })
          }
        />
      ) : null}
      <RadioValueGrid<AggregationMethod>
        value={method}
        columns={p.phone ? 3 : undefined}
        options={AGGREGATION_METHODS.map((m) => ({ value: m, label: aggregationLabel(m), valueText: fmtTemp(values[m]) }))}
        onChange={(m) => p.canEdit && temp.set((x) => ({ ...x, method: m }))}
        hint={aggregationHint(method)}
        ariaLabel={t('What counts as the current temperature')}
      />
      <CheckboxRow
        variant="divided"
        checked={temp.value.outlier.enabled}
        disabled={!p.canEdit}
        title={t('Drop outliers')}
        hint={t('A sensor that differs from the others by more than {delta} is not counted for a while.', { delta: fmtDelta(temp.value.outlier.thresholdC) })}
        trailing={
          <SettingPill
            readOnly={!p.canEdit}
            text={fmtDelta(temp.value.outlier.thresholdC)}
            ariaLabel={t('Outlier threshold')}
            editor={{ kind: 'number', min: 0.5, max: 3, step: 0.1, unit: '°' }}
            value={temp.value.outlier.thresholdC}
            onChange={(v: number) => temp.set((x) => ({ ...x, outlier: { ...x.outlier, thresholdC: v } }))}
          />
        }
        onChange={(on) => temp.set((x) => ({ ...x, outlier: { ...x.outlier, enabled: on } }))}
      />
      <KeyValueList
        rows={[
          {
            key: t('Unavailable without updates for'),
            hint: sensorStaleHint(temp.value.staleAfterMin),
            value: (
              <SettingPill
                readOnly={!p.canEdit}
                text={fmtDur(temp.value.staleAfterMin)}
                ariaLabel={t('Unavailable without updates for')}
                editor={{ kind: 'select', options: STALE_OPTIONS.map((m) => ({ value: String(m), label: fmtDur(m) })) }}
                value={String(temp.value.staleAfterMin)}
                onChange={(v: string) => temp.set((x) => ({ ...x, staleAfterMin: Number(v) }))}
              />
            ),
          },
          {
            key: t('Smoothing of jumps'),
            hint: t('Each sensor’s reading is smoothed over the chosen minutes, so a jump — a door opened next to it, a sunbeam — does not start or stop the heating by itself. Longer — calmer, but slower to react; off — the raw reading. Default: 5 min.'),
            value: (
              <SettingPill
                readOnly={!p.canEdit}
                text={temp.value.smoothingMin ? fmtDur(temp.value.smoothingMin) : t('off')}
                ariaLabel={t('Smoothing of jumps')}
                editor={{ kind: 'select', options: SMOOTHING_OPTIONS.map((m) => ({ value: String(m), label: m ? fmtDur(m) : t('off') })) }}
                value={String(temp.value.smoothingMin)}
                onChange={(v: string) => temp.set((x) => ({ ...x, smoothingMin: Number(v) }))}
              />
            ),
          },
        ]}
      />
      {p.phone && p.canEdit ? (
        <Button variant="secondary" icon="plus" onClick={() => openDialog('add-sensor')} fullWidth>
          {t('Add a sensor')}
        </Button>
      ) : null}
      <AddEntityDialog
        open={dialog === 'add-sensor'}
        title={t('Add a temperature sensor')}
        role="temperature"
        roomId={id}
        placeholder={t('Search a temperature sensor')}
        onClose={closeDialog}
        onSubmit={(entityId, name) => add.run(entityId, name)}
        errors={add}
      />
      <EditSensorDialog
        p={p}
        sensor={editing}
        main={editing && mainId ? { isMain: editing.id === mainId, make: () => void makeMain.run(editing.id), pending: makeMain.pending } : undefined}
      />
    </Stack>
  );
}

function subtitle(p: SectionProps): string {
  const a = p.state.aggregation;
  if (a.activeCount === 0) return t('No sensor counts right now');
  return t('Now {t} — {method} of {count} sensors', { t: fmtTemp(a.valueC), method: aggregationLabel(a.method).toLowerCase(), count: a.activeCount });
}

function summary(p: SectionProps): string {
  const a = p.state.aggregation;
  if (a.activeCount === 0) return t('no sensor counts');
  return t('{method} of {count} · now {t}', { method: aggregationLabel(a.method), count: a.activeCount, t: fmtTemp(a.valueC) });
}

export const sensorsSection: SectionDef = {
  key: 'temp',
  icon: 'thermometer',
  title: () => t('Temperature sensors'),
  subtitle,
  summary,
  action: (p) =>
    p.canEdit ? (
      <Button variant="secondary" size="sm" icon="plus" onClick={() => openDialog('add-sensor')}>
        {t('Add a sensor')}
      </Button>
    ) : null,
  Body,
};
