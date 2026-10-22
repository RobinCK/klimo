/**
 * «Надіслано нещодавно»: what went out, where to, and how it ended — delivered, waiting for the
 * morning, failed, or acknowledged with «Бачу». Texts are the ones frozen at sending time; new
 * messages appear live.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NotificationsDto, SentMessage, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useLiveEvent } from '@data';
import { ActivityLog, Button, Section, Skeleton, Stack } from '@ui';
import { errorText, fmtClock, fmtTime, t } from '@i18n';
import { columnLabel } from './texts';

const PAGE = 20;

function dotOf(m: SentMessage): Tone {
  if (m.kind === 'resolved') return 'ok';
  if (m.kind === 'test') return 'hold';
  if (m.targets.length && m.targets.every((x) => x.state === 'pending' || x.state === 'queued_quiet' || x.state === 'grouped')) return 'idle';
  switch (m.severity) {
    case 'critical':
      return 'err';
    case 'warning':
      return 'warn';
    case 'event':
      return 'event';
    default:
      return 'off';
  }
}

function stateOf(m: SentMessage, now: number): { text: string; muted: boolean } {
  const states = m.targets.map((x) => x.state);
  const ack = m.targets.find((x) => x.state === 'acknowledged');
  if (ack) return { text: t('«I see it» at {time}', { time: ack.at ? fmtTime(ack.at) : '—' }), muted: false };
  const failed = m.targets.filter((x) => x.state === 'failed');
  if (failed.length && failed.length === m.targets.length) return { text: t('error: {reason}', { reason: failed[0].error ?? t('not delivered') }), muted: false };
  if (states.includes('queued_quiet')) return { text: m.queuedUntil ? t('waits until {time}', { time: fmtClock(m.queuedUntil, now) }) : t('waits for the morning'), muted: true };
  if (states.length && states.every((s) => s === 'pending')) return { text: t('not sent yet'), muted: true };
  if (states.includes('grouped')) return { text: t('grouped'), muted: true };
  if (failed.length) return { text: t('delivered, {count} failed', { count: failed.length }), muted: false };
  if (states.length && states.every((s) => s === 'skipped')) return { text: t('skipped'), muted: true };
  return { text: t('delivered'), muted: false };
}

function whereOf(m: SentMessage, dto: NotificationsDto): string {
  const names = m.targets.map((x) => {
    const target = dto.targets.find((y) => y.id === x.targetId);
    return target ? columnLabel(target) : x.targetId;
  });
  const enabled = dto.targets.filter((x) => x.enabled && x.channel !== 'ha_event').length;
  if (names.length > 2 && names.length >= enabled) return m.severity === 'critical' ? t('all channels · critical') : t('all channels');
  return names.join(', ') || '—';
}

export function SentLogSection({ dto, now }: { dto: NotificationsDto; now: number }) {
  const [items, setItems] = useState<SentMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const page = await api.notifications.log({ before, limit: PAGE });
      setItems((prev) => (before ? [...prev, ...page.filter((x) => !prev.some((p) => p.id === x.id))] : page));
      setMore(page.length === PAGE);
      setError(null);
    } catch (e) {
      setError(errorText(e) || t('Could not load the log.'));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // a message is logged first and updated as targets report back: replace it in place
  useLiveEvent('notify.sent', (m) => setItems((prev) => [m, ...prev.filter((x) => x.id !== m.id)].sort((a, b) => b.at - a.at)));

  return (
    <Section title={t('Sent recently')}>
      {!loaded ? (
        <Skeleton height={160} radius={12} />
      ) : (
        <Stack gap="md">
          <ActivityLog
            emptyText={error ?? t('Nothing has been sent yet.')}
            rows={items.map((m) => {
              const st = stateOf(m, now);
              return { time: fmtClock(m.at, now), dot: dotOf(m), title: m.title, where: whereOf(m, dto), state: st.text, muted: st.muted };
            })}
          />
          {more ? (
            <Button variant="secondary" size="sm" loading={loading} onClick={() => void load(items[items.length - 1]?.at)}>
              {t('Show more')}
            </Button>
          ) : null}
        </Stack>
      )}
    </Section>
  );
}
