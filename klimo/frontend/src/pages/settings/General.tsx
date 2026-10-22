/**
 * House-wide settings: the house and its outdoor temperature, units and languages, and how the
 * system behaves — how long a change from Home Assistant lasts, who may change the
 * configuration, and the defaults a new room starts with. Every field saves by itself.
 */
import { useEffect, useMemo } from 'react';
import type { GeneralSettings, Lang, OutdoorAggregation, OutdoorReadout, OutdoorSensorReading, RoomDefaults, RoomTargetDuration, SettingsBundle, WindowReaction } from '@api/model';
import { OUTDOOR_AGGREGATIONS, ROOM_TARGET_DURATIONS, WINDOW_REACTIONS } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useEntitySearch, useLayout, useNow, useResource } from '@data';
import { applyPanelLanguage, languagePref, setLanguagePref, useColorScheme, type LangPref, type SchemePref } from '@app';
import { AutosaveStatus, CheckboxRow, EntityPicker, FallbackNote, KeyValueList, Section, SegmentedControl, Select, SensorRow, Stack, TextField, ValuePill } from '@ui';
import {
  LANG_NAMES,
  aggregationLabel,
  fmtAgo,
  fmtDur,
  fmtTemp,
  minRequestHint,
  outdoorAggregationHint,
  roomDurationLabel,
  sensorStaleHint,
  t,
  toleranceHint,
  windowDelayHints,
  windowReactionLabel,
} from '@i18n';

type Save = (bundle: SettingsBundle) => void;

/** A number setting as a pill; people who may not change the configuration just read it. */
export function NumPill(p: { text: string; label: string; value: number; min: number; max: number; step: number; unit?: string; canEdit: boolean; onChange: (v: number) => void }) {
  if (!p.canEdit) return <ValuePill text={p.text} ariaLabel={p.label} />;
  return <ValuePill text={p.text} ariaLabel={p.label} editor={{ kind: 'number', min: p.min, max: p.max, step: p.step, unit: p.unit }} value={p.value} onChange={p.onChange} />;
}

function useGeneral<K extends keyof GeneralSettings>(bundle: SettingsBundle, keys: readonly K[], onSaved: Save) {
  const value = useMemo(() => {
    const out = {} as Pick<GeneralSettings, K>;
    for (const k of keys) out[k] = bundle.general[k];
    return out;
    // the key list is a constant of each call site; only the settings themselves change
  }, [bundle.general]);
  return useAutosave(value, async (next) => onSaved(await api.settings.patchGeneral(next)), { debounceMs: 600 });
}

/** The outdoor temperature as Klimo combines it now; refreshed while Settings is open. */
function useOutdoorReadout(bundle: SettingsBundle): OutdoorReadout | null {
  const res = useResource('settings-outdoor', api.settings.outdoor, { reloadOn: ['settings'] });
  const reload = res.reload;
  useEffect(() => {
    const id = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(id);
  }, [reload]);
  return res.data ?? bundle.outdoor;
}

function outdoorNowText(r: OutdoorReadout | null): string {
  if (!r || r.nowC == null) return t('unknown');
  if (r.source === 'hold') return t('{t} — the last value, held for now', { t: fmtTemp(r.nowC) });
  if (r.source === 'weather') return t('{t} from the weather entity', { t: fmtTemp(r.nowC) });
  return t('now {t}', { t: fmtTemp(r.nowC) });
}

function readingMeta(r: OutdoorSensorReading | undefined, now: number): string {
  // an unavailable sensor's last report is the moment it went offline: its note says enough
  if (!r || r.status === 'unavailable') return '';
  if (r.status === 'ok') return r.lastReportedAt != null ? t('reported {ago}', { ago: fmtAgo(r.lastReportedAt, now) }) : '';
  return r.lastReportedAt != null ? t('no data for {dur}', { dur: fmtDur((now - r.lastReportedAt) / 60000) }) : t('no data');
}

function readingNote(r: OutdoorSensorReading | undefined): { note?: string; tone?: 'warn' | 'err' } {
  if (r?.status === 'unavailable') return { note: t('offline — the others are counted'), tone: 'err' };
  if (r?.status === 'stale') return { note: t('no fresh data — the others are counted'), tone: 'warn' };
  return {};
}

/**
 * Several outdoor thermometers, like a room's sensors: each with its reading and whether it counts
 * now, how they combine, and the one value everything outdoors-related reads.
 */
function OutdoorSensors({ outdoor, readout, canEdit, onChange }: { outdoor: GeneralSettings['outdoor']; readout: OutdoorReadout | null; canEdit: boolean; onChange: (p: Partial<GeneralSettings['outdoor']>) => void }) {
  const phone = useLayout() === 'phone';
  const now = useNow(30_000);
  const search = useEntitySearch('outdoor');
  const ids = outdoor.sensorEntityIds;
  const readings = new Map((readout?.sensors ?? []).map((r) => [r.entityId, r]));
  return (
    <Stack gap="md">
      {ids.length ? (
        <Stack gap="xs">
          {ids.map((id) => {
            const r = readings.get(id);
            const note = readingNote(r);
            const name = r?.name ?? id;
            return (
              <SensorRow
                key={id}
                name={name}
                entityId={phone || name === id ? undefined : id}
                valueText={fmtTemp(r?.valueC ?? null)}
                excluded={r?.status !== 'ok'}
                meta={readingMeta(r, now)}
                note={note.note}
                noteTone={note.tone}
                onRemove={canEdit ? () => onChange({ sensorEntityIds: ids.filter((x) => x !== id) }) : undefined}
              />
            );
          })}
        </Stack>
      ) : (
        <FallbackNote icon="thermometer" text={t('No outdoor sensor yet — the weather entity’s temperature is used.')} />
      )}
      {canEdit ? (
        <EntityPicker
          value={null}
          onChange={(id) => {
            if (id && !ids.includes(id)) onChange({ sensorEntityIds: [...ids, id] });
          }}
          search={search}
          placeholder={t('Add an outdoor temperature sensor')}
          ariaLabel={t('Add an outdoor temperature sensor')}
        />
      ) : null}
      {ids.length > 1 ? (
        <SegmentedControl<OutdoorAggregation>
          ariaLabel={t('How the outdoor sensors combine')}
          value={outdoor.aggregation}
          options={OUTDOOR_AGGREGATIONS.map((m) => ({ value: m, label: aggregationLabel(m), disabled: !canEdit }))}
          onChange={(aggregation) => onChange({ aggregation })}
          hint={outdoorAggregationHint(outdoor.aggregation)}
        />
      ) : null}
    </Stack>
  );
}

export function HouseSection({ bundle, onSaved, canEdit }: { bundle: SettingsBundle; onSaved: Save; canEdit: boolean }) {
  const auto = useGeneral(bundle, ['houseName', 'outdoor'] as const, onSaved);
  const v = auto.value;
  const readout = useOutdoorReadout(bundle);
  const weatherSearch = useEntitySearch('weather');
  const setOutdoor = (p: Partial<GeneralSettings['outdoor']>) => auto.set((prev) => ({ ...prev, outdoor: { ...prev.outdoor, ...p } }));
  return (
    <Section title={t('House')} icon="home" action={<AutosaveStatus state={auto.state} retry={auto.retry} />}>
      <Stack gap="md">
        <TextField label={t('House name')} value={v.houseName} onChange={(houseName) => auto.set((prev) => ({ ...prev, houseName }))} maxLength={40} disabled={!canEdit} />
        <Section variant="plain" level={3} title={t('Outdoor temperature sensors')} subtitle={t('Together they make one outdoor temperature: weather curves, the season and frost triggers read it.')}>
          <OutdoorSensors outdoor={v.outdoor} readout={readout} canEdit={canEdit} onChange={setOutdoor} />
          <KeyValueList
            rows={[
              { key: t('Outdoor temperature'), value: <ValuePill text={outdoorNowText(readout)} ariaLabel={t('Outdoor temperature')} /> },
              {
                key: t('Stale without updates for'),
                hint: t('An outdoor sensor that sends nothing for {dur} is left out; the others still count. Default: 30 min.', { dur: fmtDur(v.outdoor.staleAfterMin) }),
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('Stale without updates for')}
                    text={fmtDur(v.outdoor.staleAfterMin)}
                    value={v.outdoor.staleAfterMin}
                    min={5}
                    max={240}
                    step={5}
                    unit={t('min')}
                    onChange={(staleAfterMin) => setOutdoor({ staleAfterMin })}
                  />
                ),
              },
              {
                key: t('Hold the last value for'),
                hint: t('When every outdoor sensor is silent, the last combined value is kept for {dur}, so the season and the heat pump’s bivalence do not jump. Then the weather entity’s temperature is used; without one the outdoor temperature is unknown. Default: 30 min.', {
                  dur: fmtDur(v.outdoor.holdMin),
                }),
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('Hold the last value for')}
                    text={fmtDur(v.outdoor.holdMin)}
                    value={v.outdoor.holdMin}
                    min={0}
                    max={240}
                    step={5}
                    unit={t('min')}
                    onChange={(holdMin) => setOutdoor({ holdMin })}
                  />
                ),
              },
            ]}
          />
        </Section>
        <Section variant="plain" level={3} title={t('Weather entity')} subtitle={t('The backup temperature when every outdoor sensor is silent, and the forecast.')}>
          <EntityPicker
            value={v.outdoor.weatherEntityId}
            onChange={(weatherEntityId) => setOutdoor({ weatherEntityId })}
            search={weatherSearch}
            placeholder={t('Choose a weather entity')}
            ariaLabel={t('Weather entity')}
            clearable
          />
        </Section>
      </Stack>
    </Section>
  );
}

export function DisplaySection({ bundle, onSaved, canEdit, haUnits }: { bundle: SettingsBundle; onSaved: Save; canEdit: boolean; haUnits: 'metric' | 'us_customary' | null }) {
  const auto = useGeneral(bundle, ['units', 'notificationLanguage', 'uiLanguage'] as const, (saved) => {
    onSaved(saved);
    // a new panel language for everyone shows here as soon as the server has it
    applyPanelLanguage(saved.general.uiLanguage);
  });
  const v = auto.value;
  const scheme = useColorScheme();
  const lang = languagePref();
  const langOptions = (['uk', 'en'] as const).map((l) => ({ value: l, label: LANG_NAMES[l] }));
  return (
    <Section title={t('Units, languages and look')} icon="settings" action={<AutosaveStatus state={auto.state} retry={auto.retry} />}>
      <Stack gap="lg">
        <SegmentedControl<GeneralSettings['units']>
          ariaLabel={t('Temperature units')}
          value={v.units}
          full
          options={[
            { value: 'auto', label: haUnits === 'us_customary' ? t('As in HA (°F)') : t('As in HA (°C)'), disabled: !canEdit },
            { value: 'C', label: '°C', disabled: !canEdit },
            { value: 'F', label: '°F', disabled: !canEdit },
          ]}
          onChange={(units) => auto.set((prev) => ({ ...prev, units }))}
          hint={t('Only what you see; inside, everything is counted in °C.')}
        />
        <Select<Lang>
          label={t('Language of notifications and dashboard cards')}
          ariaLabel={t('Language of notifications and dashboard cards')}
          value={v.notificationLanguage}
          options={langOptions}
          disabled={!canEdit}
          fullWidth
          onChange={(notificationLanguage) => auto.set((prev) => ({ ...prev, notificationLanguage }))}
          help={t('Notifications, dashboard cards and entity names in Home Assistant — not this panel.')}
        />
        <Select<GeneralSettings['uiLanguage']>
          label={t('Panel language for everyone')}
          ariaLabel={t('Panel language for everyone')}
          value={v.uiLanguage}
          options={[{ value: 'auto', label: t('As the Home Assistant user') }, ...langOptions]}
          disabled={!canEdit}
          fullWidth
          onChange={(uiLanguage) => auto.set((prev) => ({ ...prev, uiLanguage }))}
          help={
            lang === 'auto'
              ? t('For everyone who has not picked a language in their browser; the page reloads.')
              : t('This browser keeps its own language ({lang}); choose Default below to follow this setting.', { lang: LANG_NAMES[lang] })
          }
        />
        <SegmentedControl<LangPref>
          ariaLabel={t('Language in this browser')}
          value={lang}
          full
          options={[{ value: 'auto', label: t('Default') }, ...langOptions]}
          onChange={(p) => setLanguagePref(p)}
          hint={t('Language in this browser only; Default follows the setting above. The page reloads.')}
        />
        <SegmentedControl<SchemePref>
          ariaLabel={t('Colour scheme')}
          value={scheme.pref}
          full
          options={[
            { value: 'auto', label: t('As in HA') },
            { value: 'dark', label: t('Dark') },
            { value: 'light', label: t('Light') },
          ]}
          onChange={scheme.setPref}
          hint={t('Colour scheme in this browser.')}
        />
      </Stack>
    </Section>
  );
}

export function BehaviourSection({ bundle, onSaved, canEdit }: { bundle: SettingsBundle; onSaved: Save; canEdit: boolean }) {
  const auto = useGeneral(bundle, ['haTargetChangeDuration', 'adminOnlyConfig', 'mqttConfigEntities', 'defaults'] as const, onSaved);
  const v = auto.value;
  const d = v.defaults;
  const setD = (p: Partial<RoomDefaults>) => auto.set((prev) => ({ ...prev, defaults: { ...prev.defaults, ...p } }));
  const delays = windowDelayHints({ openDelaySec: d.windowOpenDelaySec, resumeDelaySec: d.windowResumeDelaySec, remindAfterMin: d.windowRemindAfterMin });
  const band = (b: { below: number; above: number }) => `−${b.below.toFixed(1)} / +${b.above.toFixed(1)}°`;
  const bandPill = (mode: 'heat' | 'cool', side: 'below' | 'above', label: string) => (
    <NumPill
      canEdit={canEdit}
      label={label}
      text={`${side === 'below' ? '−' : '+'}${d.tolerance[mode][side].toFixed(1)}°`}
      value={d.tolerance[mode][side]}
      min={0.1}
      max={1}
      step={0.1}
      unit="°"
      onChange={(n) => setD({ tolerance: { ...d.tolerance, [mode]: { ...d.tolerance[mode], [side]: Math.round(n * 10) / 10 } } })}
    />
  );
  return (
    <Section title={t('Behaviour')} icon="sparkle" action={<AutosaveStatus state={auto.state} retry={auto.retry} />}>
      <Stack gap="lg">
        <Select<RoomTargetDuration>
          label={t('A target set in Home Assistant lasts')}
          ariaLabel={t('A target set in Home Assistant lasts')}
          value={v.haTargetChangeDuration}
          options={ROOM_TARGET_DURATIONS.filter((x) => x !== 'until').map((x) => ({ value: x, label: roomDurationLabel(x) }))}
          disabled={!canEdit}
          fullWidth
          hint={t('A target changed from Home Assistant — the climate card, HomeKit, a voice assistant, an automation — is a manual change of the room. It lasts this long, then the schedule takes over again.')}
          onChange={(haTargetChangeDuration) => auto.set((prev) => ({ ...prev, haTargetChangeDuration }))}
        />
        <Stack gap="xs">
          <CheckboxRow
            variant="well"
            checked={v.adminOnlyConfig}
            title={t('Only Home Assistant administrators change settings')}
            hint={t('Everyone can still control rooms: targets, boost, airing.')}
            disabled={!canEdit}
            onChange={(adminOnlyConfig) => auto.set((prev) => ({ ...prev, adminOnlyConfig }))}
          />
          <CheckboxRow
            variant="well"
            checked={v.mqttConfigEntities}
            title={t('Settings as Home Assistant entities')}
            hint={t('The bivalent point, source permissions and rules appear as MQTT entities; only administrators can change them.')}
            disabled={!canEdit}
            onChange={(mqttConfigEntities) => auto.set((prev) => ({ ...prev, mqttConfigEntities }))}
          />
        </Stack>
        <Section
          title={t('Defaults for new rooms')}
          variant="plain"
          level={3}
          subtitle={t('Heating {heat} · cooling {cool}', { heat: band(d.tolerance.heat), cool: band(d.tolerance.cool) })}
          hint={toleranceHint(d.tolerance.heat)}
        >
          <KeyValueList
            rows={[
              { key: t('Heating: switch on below the target by'), value: bandPill('heat', 'below', t('Heating: switch on below the target by')) },
              { key: t('Heating: switch off above the target by'), value: bandPill('heat', 'above', t('Heating: switch off above the target by')) },
              { key: t('Cooling: switch off below the target by'), value: bandPill('cool', 'below', t('Cooling: switch off below the target by')) },
              { key: t('Cooling: switch on above the target by'), value: bandPill('cool', 'above', t('Cooling: switch on above the target by')) },
              {
                key: t('Shortest request'),
                hint: minRequestHint(d.minRequestMin),
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('Shortest request')}
                    text={fmtDur(d.minRequestMin)}
                    value={d.minRequestMin}
                    min={0}
                    max={60}
                    step={1}
                    unit={t('min')}
                    onChange={(minRequestMin) => setD({ minRequestMin })}
                  />
                ),
              },
              {
                key: t('A sensor is offline without updates for'),
                hint: sensorStaleHint(d.staleAfterMin),
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('A sensor is offline without updates for')}
                    text={fmtDur(d.staleAfterMin)}
                    value={d.staleAfterMin}
                    min={15}
                    max={720}
                    step={15}
                    unit={t('min')}
                    onChange={(staleAfterMin) => setD({ staleAfterMin })}
                  />
                ),
              },
              {
                key: t('When a window opens'),
                value: canEdit ? (
                  <ValuePill
                    text={windowReactionLabel(d.windowReaction)}
                    ariaLabel={t('When a window opens')}
                    editor={{ kind: 'select', options: WINDOW_REACTIONS.map((r) => ({ value: r, label: windowReactionLabel(r) })) }}
                    value={d.windowReaction}
                    onChange={(r: string) => setD({ windowReaction: r as WindowReaction })}
                  />
                ) : (
                  <ValuePill text={windowReactionLabel(d.windowReaction)} />
                ),
              },
              {
                key: t('React after the window is open for'),
                hint: delays.open,
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('React after the window is open for')}
                    text={t('{s} s', { s: d.windowOpenDelaySec })}
                    value={d.windowOpenDelaySec}
                    min={0}
                    max={600}
                    step={15}
                    unit={t('s')}
                    onChange={(windowOpenDelaySec) => setD({ windowOpenDelaySec })}
                  />
                ),
              },
              {
                key: t('Resume after it is closed for'),
                hint: delays.resume,
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('Resume after it is closed for')}
                    text={t('{s} s', { s: d.windowResumeDelaySec })}
                    value={d.windowResumeDelaySec}
                    min={0}
                    max={900}
                    step={15}
                    unit={t('s')}
                    onChange={(windowResumeDelaySec) => setD({ windowResumeDelaySec })}
                  />
                ),
              },
              {
                key: t('Remind if still open after'),
                hint: delays.remind,
                value: (
                  <NumPill
                    canEdit={canEdit}
                    label={t('Remind if still open after')}
                    text={fmtDur(d.windowRemindAfterMin)}
                    value={d.windowRemindAfterMin}
                    min={5}
                    max={120}
                    step={5}
                    unit={t('min')}
                    onChange={(windowRemindAfterMin) => setD({ windowRemindAfterMin })}
                  />
                ),
              },
            ]}
          />
        </Section>
      </Stack>
    </Section>
  );
}
