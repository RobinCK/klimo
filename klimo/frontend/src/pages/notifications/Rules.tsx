/**
 * «Правила»: when messages are held back or repeated — quiet hours, grouping, repeating
 * critical alerts, escalation and recovery messages — and «Як це виглядатиме», a preview
 * rendered by the same templates that send the real messages.
 */
import { useState } from 'react';
import type { EventKind, NotificationsDto } from '@api/model';
import { api } from '@api/endpoints';
import { useNow, useResource } from '@data';
import { brand } from '@brand';
import { CheckboxRow, NotificationPreview, Row, Section, Select, Skeleton, Stack, ValuePill } from '@ui';
import { eventKindLabel, fmtDur, fmtTime, t } from '@i18n';
import type { NotificationsModel } from './useNotifications';

function NumPill(p: { text: string; label: string; value: number; min: number; max: number; step: number; unit?: string; canEdit: boolean; onChange: (v: number) => void }) {
  if (!p.canEdit) return <ValuePill text={p.text} ariaLabel={p.label} />;
  return <ValuePill text={p.text} ariaLabel={p.label} editor={{ kind: 'number', min: p.min, max: p.max, step: p.step, unit: p.unit }} value={p.value} onChange={p.onChange} />;
}

export function RulesSection({ dto, model, canEdit }: { dto: NotificationsDto; model: NotificationsModel; canEdit: boolean }) {
  const s = dto.settings;
  const escalationTargets = dto.targets.filter((x) => x.channel === 'telegram' || x.channel === 'ha_mobile' || x.channel === 'ha_notify');
  const escalationTarget = escalationTargets.find((x) => x.id === s.escalation.targetId) ?? null;
  const quiet = `${s.quietHours.from}–${s.quietHours.to}`;

  return (
    <Section title={t('Rules')}>
      <Stack gap="xs">
        <CheckboxRow
          variant="well"
          checked={s.quietHours.enabled}
          title={t('Quiet hours')}
          hint={t('Warnings, events and reports wait until morning. Critical alerts go at once.')}
          disabled={!canEdit}
          onChange={(enabled) => void model.patchSettings({ quietHours: { enabled } })}
          trailing={
            canEdit ? (
              <ValuePill
                text={quiet}
                ariaLabel={t('Quiet hours')}
                editor={{ kind: 'time_range' }}
                value={{ from: s.quietHours.from, to: s.quietHours.to }}
                onChange={(r: { from: string; to: string }) => void model.patchSettings({ quietHours: { from: r.from, to: r.to } })}
              />
            ) : (
              <ValuePill text={quiet} ariaLabel={t('Quiet hours')} />
            )
          }
        />
        {s.quietHours.enabled ? (
          <CheckboxRow
            variant="well"
            checked={s.quietHours.digest}
            title={t('A morning digest')}
            hint={t('«While you slept: …» — one message with what is still open, instead of the queued ones one by one.')}
            disabled={!canEdit}
            onChange={(digest) => void model.patchSettings({ quietHours: { digest } })}
          />
        ) : null}
        <CheckboxRow
          variant="well"
          checked={s.grouping.enabled}
          title={t('Group similar ones')}
          hint={t('Several alerts in a short time become one message: «3 sensors offline».')}
          disabled={!canEdit}
          onChange={(enabled) => void model.patchSettings({ grouping: { enabled } })}
          trailing={
            <NumPill
              canEdit={canEdit}
              label={t('Group similar ones')}
              text={t('within {dur}', { dur: fmtDur(s.grouping.windowMin) })}
              value={s.grouping.windowMin}
              min={1}
              max={10}
              step={1}
              unit={t('min')}
              onChange={(windowMin) => void model.patchSettings({ grouping: { windowMin } })}
            />
          }
        />
        <CheckboxRow
          variant="well"
          checked={s.repeatCritical.enabled}
          title={t('Repeat critical alerts')}
          hint={t('Until someone presses «I see it» or the problem is gone; at most {count} times.', { count: s.repeatCritical.maxTimes })}
          disabled={!canEdit}
          onChange={(enabled) => void model.patchSettings({ repeatCritical: { enabled } })}
          trailing={
            <Row gap="2xs" wrap>
              <NumPill
                canEdit={canEdit}
                label={t('Repeat critical alerts')}
                text={t('every {dur}', { dur: fmtDur(s.repeatCritical.everyMin) })}
                value={s.repeatCritical.everyMin}
                min={10}
                max={120}
                step={5}
                unit={t('min')}
                onChange={(everyMin) => void model.patchSettings({ repeatCritical: { everyMin } })}
              />
              <NumPill
                canEdit={canEdit}
                label={t('At most')}
                text={t('×{n}', { n: s.repeatCritical.maxTimes })}
                value={s.repeatCritical.maxTimes}
                min={1}
                max={20}
                step={1}
                onChange={(maxTimes) => void model.patchSettings({ repeatCritical: { maxTimes } })}
              />
            </Row>
          }
        />
        <CheckboxRow
          variant="well"
          checked={s.escalation.enabled}
          title={escalationTarget ? t('Escalate to «{name}»', { name: escalationTarget.name }) : t('Escalation')}
          hint={t('Nobody reacted to a critical alert — the message also goes to the escalation chat.')}
          disabled={!canEdit}
          onChange={(enabled) => void model.patchSettings({ escalation: { enabled } })}
          trailing={
            <Row gap="2xs" wrap>
              <NumPill
                canEdit={canEdit}
                label={t('Escalation')}
                text={t('after {dur}', { dur: fmtDur(s.escalation.afterMin) })}
                value={s.escalation.afterMin}
                min={5}
                max={60}
                step={5}
                unit={t('min')}
                onChange={(afterMin) => void model.patchSettings({ escalation: { afterMin } })}
              />
              {canEdit && escalationTargets.length ? (
                <ValuePill
                  text={escalationTarget?.shortName ?? escalationTarget?.name ?? t('choose')}
                  ariaLabel={t('Escalation target')}
                  editor={{ kind: 'select', options: escalationTargets.map((x) => ({ value: x.id, label: x.name })) }}
                  value={s.escalation.targetId ?? ''}
                  onChange={(targetId: string) => void model.patchSettings({ escalation: { targetId } })}
                />
              ) : null}
            </Row>
          }
        />
        <CheckboxRow
          variant="well"
          checked={s.recoveryMessages}
          title={t('Tell when it is over')}
          hint={t('A short silent message to whoever got the alert: «The heat pump is back».')}
          disabled={!canEdit}
          onChange={(recoveryMessages) => void model.patchSettings({ recoveryMessages })}
        />
      </Stack>
    </Section>
  );
}

type PreviewChoice = 'examples' | EventKind;

/** Kinds worth previewing: what a person actually receives. */
const PREVIEW_KINDS = (dto: NotificationsDto) => [...dto.catalogue].filter((c) => c.kind !== 'ha_disconnected').sort((a, b) => a.order - b.order);

export function PreviewSection({ dto }: { dto: NotificationsDto }) {
  const [choice, setChoice] = useState<PreviewChoice>('examples');
  const now = useNow(60_000);
  const pushKind: EventKind = choice === 'examples' ? 'source_unavailable' : choice;
  const tgKind: EventKind = choice === 'examples' ? 'sensor_offline' : choice;
  const push = useResource(`notify-preview:${pushKind}`, () => api.notifications.preview(pushKind));
  const tg = useResource(`notify-preview:${tgKind}`, () => api.notifications.preview(tgKind));
  const sev = (k: EventKind) => dto.catalogue.find((c) => c.kind === k)?.severity ?? 'warning';
  const caption = (k: EventKind) => {
    switch (sev(k)) {
      case 'critical':
        return t('Goes through «Do not disturb». Repeated in {dur} if nobody presses «I see it».', { dur: fmtDur(dto.settings.repeatCritical.everyMin) });
      case 'warning':
        return dto.settings.quietHours.enabled
          ? t('Quiet hours: from {from} to {to} such messages wait until morning.', { from: dto.settings.quietHours.from, to: dto.settings.quietHours.to })
          : t('Sent at once, grouped with similar ones.');
      default:
        return t('For information; waits for the end of quiet hours.');
    }
  };
  const sevLabel = (k: EventKind) => {
    switch (sev(k)) {
      case 'critical':
        return t('critical');
      case 'warning':
        return t('warning');
      case 'event':
        return t('event');
      case 'report':
        return t('report');
    }
  };
  const lines = (text: string) => text.split('\n').filter(Boolean);

  return (
    <Section
      title={t('How it will look')}
      subtitle={t('Buttons under a message act at once.')}
      action={
        <Select<PreviewChoice>
          ariaLabel={t('Preview for')}
          value={choice}
          size="sm"
          options={[{ value: 'examples', label: t('Examples') }, ...PREVIEW_KINDS(dto).map((c) => ({ value: c.kind, label: eventKindLabel(c.kind) }))]}
          onChange={setChoice}
        />
      }
    >
      {push.data && tg.data ? (
        <NotificationPreview
          push={{
            label: t('Push to a phone · {severity}', { severity: sevLabel(pushKind) }),
            app: 'Home Assistant',
            title: push.data.push.title,
            body: push.data.push.body,
            actions: push.data.push.actions.slice(0, 3),
            caption: caption(pushKind),
          }}
          telegram={{
            label: t('Telegram · {severity}', { severity: sevLabel(tgKind) }),
            sender: brand.productName,
            lines: lines(tg.data.telegram.text),
            buttons: tg.data.telegram.buttons,
            time: fmtTime(now),
            caption: caption(tgKind),
          }}
        />
      ) : (
        <Skeleton height={240} radius={16} />
      )}
    </Section>
  );
}
