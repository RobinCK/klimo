/**
 * «Коли вмикається сам»: add or change a rule that switches a profile on by itself — people
 * leaving or coming home, a calendar event, or a stay away until a date. An existing rule can
 * be checked against the house right now.
 */
import { useMemo, useState } from 'react';
import type { ActivationRule, ActivationRuleConfig, ProfileDto, Reason } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { paths } from '@app';
import {
  Button,
  CheckboxRow,
  Dialog,
  RadioCardList,
  SegmentedControl,
  Select,
  Stack,
  StatusBanner,
  Stepper,
  TextField,
  TimeStepper,
  type KitAction,
} from '@ui';
import { fmtDur, minuteToHhmm, renderReason, t, zonedParts } from '@i18n';
import type { ScheduleContext } from './data';
import { atMinute, upcomingDates } from './dates';

type Kind = ActivationRuleConfig['type'];
type Presence = Extract<ActivationRuleConfig, { type: 'presence' }>;
type Calendar = Extract<ActivationRuleConfig, { type: 'calendar' }>;
type Vacation = Extract<ActivationRuleConfig, { type: 'vacation' }>;

function initial(kind: Kind, c: ScheduleContext): ActivationRuleConfig {
  switch (kind) {
    case 'presence':
      return { type: 'presence', trigger: 'all_away', optimalStart: true };
    case 'calendar':
      return { type: 'calendar', calendarEntityId: '', match: { field: 'summary', contains: '' }, preheatMin: 60 };
    case 'vacation':
      return { type: 'vacation', from: null, until: null, returnProfileId: c.settings.data?.general.defaultProfileId ?? 'home', returnLeadH: 3 };
  }
}

interface Props {
  c: ScheduleContext;
  profile: ProfileDto;
  rule: ActivationRule | null;
  onClose: () => void;
}

export function RuleDialog({ c, profile, rule, onClose }: Props) {
  const { put } = c.profiles;
  const [config, setConfig] = useState<ActivationRuleConfig>(rule?.config ?? initial('presence', c));
  const [tested, setTested] = useState<{ wouldActivate: boolean; reason: Reason | null } | null>(null);
  const save = useMutation(() => (rule ? api.activationRules.patch(rule.id, { config }) : api.profiles.addRule(profile.id, config)), {
    onSuccess: (p) => (put(p), onClose()),
    okToast: rule ? t('Condition saved') : t('Condition added'),
  });
  const remove = useMutation(() => api.activationRules.remove((rule as ActivationRule).id), {
    onSuccess: (p) => (put(p), onClose()),
    okToast: t('Condition removed'),
  });
  const test = useMutation(() => api.activationRules.test((rule as ActivationRule).id), { onSuccess: setTested });

  const valid =
    config.type === 'calendar' ? Boolean(config.calendarEntityId && config.match.contains.trim()) : config.type === 'vacation' ? config.until != null : true;

  const actions: KitAction[] = [{ label: t('Cancel'), onClick: onClose, variant: 'secondary' }];
  if (rule) actions.unshift({ label: t('Remove'), onClick: () => void remove.run(), variant: 'danger', loading: remove.pending });
  actions.push({ label: t('Save'), onClick: () => void save.run(), disabled: !valid, loading: save.pending });

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule ? t('Condition for «{name}»', { name: profile.name }) : t('New condition for «{name}»', { name: profile.name })}
      actions={actions}
    >
      <Stack gap="lg">
        {rule ? null : (
          <SegmentedControl<Kind>
            full
            ariaLabel={t('What switches the profile on')}
            value={config.type}
            options={[
              { value: 'presence', label: t('Presence') },
              { value: 'calendar', label: t('Calendar') },
              { value: 'vacation', label: t('Until a date') },
            ]}
            onChange={(k) => setConfig(initial(k, c))}
          />
        )}
        {config.type === 'presence' ? <PresenceFields c={c} value={config} onChange={setConfig} /> : null}
        {config.type === 'calendar' ? <CalendarFields value={config} onChange={setConfig} /> : null}
        {config.type === 'vacation' ? <VacationFields c={c} value={config} onChange={setConfig} /> : null}
        {rule ? (
          <Stack gap="sm">
            <Button variant="outline" size="sm" icon="play" onClick={() => void test.run()} loading={test.pending}>
              {t('Check it now')}
            </Button>
            {tested ? (
              <StatusBanner
                tone={tested.wouldActivate ? 'ok' : 'event'}
                icon={tested.wouldActivate ? 'checkCircle' : 'info'}
                text={
                  (tested.wouldActivate ? t('Right now it would switch on «{name}».', { name: profile.name }) : t('Right now it would not switch on.')) +
                  (tested.reason ? ` ${renderReason(tested.reason, c.ctx)}` : '')
                }
              />
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Dialog>
  );
}

function PresenceFields({ c, value, onChange }: { c: ScheduleContext; value: Presence; onChange: (v: Presence) => void }) {
  const presence = c.settings.data?.general.presence;
  return (
    <Stack gap="md">
      {presence && !presence.enabled ? (
        <StatusBanner
          tone="warn"
          icon="users"
          text={t('Presence is not set up yet — choose the people in the settings first.')}
          action={{ label: t('Settings'), to: paths.settings() }}
        />
      ) : null}
      <RadioCardList
        ariaLabel={t('When')}
        value={value.trigger}
        onChange={(trigger) => onChange({ ...value, trigger })}
        options={[
          {
            value: 'all_away',
            title: t('Everyone has left'),
            hint: presence ? t('All people are away from home for longer than {dur}.', { dur: fmtDur(presence.awayDelayMin) }) : undefined,
          },
          { value: 'someone_home', title: t('Someone is home'), hint: t('Cancels «Away» even in the middle of a schedule slot.') },
          {
            value: 'approaching',
            title: t('Coming home'),
            hint: presence ? t('Someone is closer than {km} km.', { km: presence.approachKm }) : undefined,
          },
        ]}
      />
      <CheckboxRow
        checked={value.optimalStart}
        title={t('Start early')}
        hint={t('Begin heating ahead so the rooms are at their target on arrival.')}
        onChange={(optimalStart) => onChange({ ...value, optimalStart })}
      />
    </Stack>
  );
}

function CalendarFields({ value, onChange }: { value: Calendar; onChange: (v: Calendar) => void }) {
  const calendars = useResource('ha:calendars', api.ha.calendars);
  const options = useMemo(() => {
    const list = (calendars.data ?? []).map((x) => ({ value: x.entityId, label: x.name ? `${x.name} · ${x.entityId}` : x.entityId }));
    if (value.calendarEntityId && !list.some((o) => o.value === value.calendarEntityId))
      list.unshift({ value: value.calendarEntityId, label: value.calendarEntityId });
    return [{ value: '', label: t('Choose a calendar') }, ...list];
  }, [calendars.data, value.calendarEntityId]);
  return (
    <Stack gap="md">
      {calendars.settled && !(calendars.data ?? []).length ? (
        <StatusBanner tone="warn" icon="calendar" text={t('Home Assistant has no calendars yet.')} />
      ) : null}
      <Select
        label={t('Calendar')}
        ariaLabel={t('Calendar')}
        value={value.calendarEntityId}
        options={options}
        onChange={(calendarEntityId) => onChange({ ...value, calendarEntityId })}
      />
      <Select<Calendar['match']['field']>
        label={t('Look in the event’s')}
        ariaLabel={t('Look in the event’s')}
        value={value.match.field}
        options={[
          { value: 'summary', label: t('title') },
          { value: 'description', label: t('description') },
          { value: 'location', label: t('location') },
        ]}
        onChange={(field) => onChange({ ...value, match: { ...value.match, field } })}
      />
      <TextField
        label={t('Contains the text')}
        value={value.match.contains}
        placeholder={t('Guests')}
        onChange={(contains) => onChange({ ...value, match: { ...value.match, contains } })}
      />
      <Stepper
        variant="compact"
        label={t('Warm up before the event')}
        value={value.preheatMin}
        text={value.preheatMin ? fmtDur(value.preheatMin) : t('no')}
        min={0}
        max={240}
        step={15}
        onChange={(preheatMin) => onChange({ ...value, preheatMin })}
        ariaDec={t('Shorter')}
        ariaInc={t('Longer')}
      />
    </Stack>
  );
}

function VacationFields({ c, value, onChange }: { c: ScheduleContext; value: Vacation; onChange: (v: Vacation) => void }) {
  const dates = useMemo(() => upcomingDates(c.now), [c.now]);
  const untilParts = value.until != null ? zonedParts(value.until) : null;
  const date = untilParts?.date ?? '';
  const minute = untilParts?.minuteOfDay ?? 18 * 60;
  const setUntil = (d: string, m: number) => {
    const day = dates.find((x) => x.value === d);
    onChange({ ...value, until: day ? atMinute(day.start, m) : null });
  };
  const profiles = c.profiles.data ?? [];
  return (
    <Stack gap="md">
      <Select
        label={t('Return date')}
        ariaLabel={t('Return date')}
        value={date}
        options={[{ value: '', label: t('Choose a day') }, ...(date && !dates.some((d) => d.value === date) ? [{ value: date, label: date }] : []), ...dates]}
        onChange={(d) => setUntil(d, minute)}
      />
      <TimeStepper
        label={t('Arrival time')}
        value={minute}
        text={minuteToHhmm(minute)}
        min={0}
        max={1410}
        step={30}
        onChange={(m) => setUntil(date, m)}
        ariaEarlier={t('30 min earlier')}
        ariaLater={t('30 min later')}
      />
      <Select
        label={t('Then switch to')}
        ariaLabel={t('Then switch to')}
        value={value.returnProfileId}
        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
        onChange={(returnProfileId) => onChange({ ...value, returnProfileId })}
      />
      <Stepper
        variant="compact"
        label={t('Warm up before the return')}
        value={value.returnLeadH}
        text={value.returnLeadH ? t('{h} h', { h: value.returnLeadH }) : t('no')}
        min={0}
        max={12}
        step={1}
        onChange={(returnLeadH) => onChange({ ...value, returnLeadH })}
        ariaDec={t('Shorter')}
        ariaInc={t('Longer')}
      />
    </Stack>
  );
}
