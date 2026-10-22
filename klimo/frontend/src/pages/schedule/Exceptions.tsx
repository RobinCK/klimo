/**
 * «Винятки»: dated days that do not follow the week — a public holiday on a Monday runs «як
 * неділя». Each exception replaces that one date of this schedule.
 */
import { useState } from 'react';
import type { Dow, Schedule, ScheduleException } from '@api/model';
import { api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { Button, DateField, Dialog, KeyValueList, Section, Select, Stack, TextField } from '@ui';
import { fmtDate, t, weekdayLong } from '@i18n';
import { DOWS } from './blocks';
import type { ScheduleContext } from './data';
import { localDate } from './dates';

const likeText = (e: ScheduleException) =>
  'likeDow' in e.plan ? t('like {day}', { day: weekdayLong(e.plan.likeDow).toLowerCase() }) : t('own plan for the day');

export function Exceptions({ c, schedule }: { c: ScheduleContext; schedule: Schedule }) {
  const res = useResource(`schedule-exceptions:${schedule.id}`, () => api.schedules.exceptions(schedule.id), { reloadOn: ['schedule'] });
  const [adding, setAdding] = useState(false);
  const remove = useMutation((date: string) => api.schedules.removeException(schedule.id, date), {
    onSuccess: () => void res.reload(),
    okToast: t('Exception removed'),
  });
  const list = [...(res.data ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  return (
    <Section
      variant="well"
      level={3}
      title={t('Exceptions')}
      subtitle={
        list.length || !res.settled
          ? t('Single dates that do not follow the week: holidays, a day off at home.')
          : t('None yet — every date follows the week. Add one for a holiday or a day off at home.')
      }
      action={
        c.canEdit ? (
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setAdding(true)}>
            {t('Exception')}
          </Button>
        ) : undefined
      }
    >
      {list.length ? (
        <KeyValueList
          rows={list.map((e) => ({
            key: fmtDate(Date.parse(`${e.date}T12:00:00Z`), 'weekday'),
            value: [likeText(e), e.note].filter(Boolean).join(' · '),
            action: c.canEdit ? { label: t('Remove'), onClick: () => void remove.run(e.date) } : undefined,
          }))}
        />
      ) : null}
      {adding ? <ExceptionDialog c={c} schedule={schedule} onClose={() => setAdding(false)} onSaved={() => void res.reload()} /> : null}
    </Section>
  );
}

function ExceptionDialog({ c, schedule, onClose, onSaved }: { c: ScheduleContext; schedule: Schedule; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(() => localDate(c.now, 1));
  const [like, setLike] = useState<Dow>(6);
  const [note, setNote] = useState('');
  const save = useMutation(() => api.schedules.setException(schedule.id, date, { plan: { likeDow: like }, note: note.trim() || null }), {
    onSuccess: () => {
      onSaved();
      onClose();
    },
    okToast: t('Exception added'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('New exception')}
      actions={[
        { label: t('Cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('Add'), onClick: () => void save.run(), disabled: !date, loading: save.pending },
      ]}
    >
      <Stack gap="md">
        <DateField label={t('Date')} value={date} min={localDate(c.now)} max={localDate(c.now, 366)} onChange={setDate} />
        <Select
          label={t('Runs like')}
          ariaLabel={t('Runs like')}
          value={like}
          options={DOWS.map((d) => ({ value: d, label: weekdayLong(d) }))}
          onChange={(v) => setLike(v as Dow)}
        />
        <TextField label={t('Note')} value={note} placeholder={t('Public holiday')} maxLength={60} onChange={setNote} />
      </Stack>
    </Dialog>
  );
}
