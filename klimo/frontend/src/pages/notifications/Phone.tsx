/**
 * Notifications on a phone: the inbox first, then this person's own preferences — where their
 * messages go («КУДИ»), about what («ПРО ЩО») and whether quiet hours apply to them. Critical
 * alerts cannot be switched off here; everything else follows the person, not the house.
 */
import { useMemo } from 'react';
import type { EventKind, MeDto, NotificationsDto, PersonalPrefs, Severity } from '@api/model';
import { api, type Api } from '@api/endpoints';
import { useMutation, useResource } from '@data';
import { navigate, paths } from '@app';
import { CheckboxRow, EmptyState, Icon, MobileTopBar, RowList, Section, Skeleton, Stack, StatusDot } from '@ui';
import { t, type CodeContext } from '@i18n';
import { InboxList, type InboxModel } from './Inbox';
import type { Target } from './texts';
import type { NotificationsModel } from './useNotifications';

type Level = 'warning' | 'event' | 'report';

const LEVEL_KINDS = (dto: NotificationsDto, level: Level): EventKind[] =>
  level === 'report' ? ['report_daily'] : dto.catalogue.filter((c) => c.severity === (level as Severity)).map((c) => c.kind);

/** On for every own target, off for every one, or a mix set on the desktop table. */
function routingState(dto: NotificationsDto, kinds: readonly EventKind[], targets: readonly Target[]): 'on' | 'off' | 'mixed' | 'none' {
  if (!targets.length) return 'none';
  const ids = new Set(targets.map((x) => x.id));
  const cells = dto.routing.filter((c) => kinds.includes(c.kind) && ids.has(c.targetId));
  const on = cells.filter((c) => c.on).length;
  return on === 0 ? 'off' : on === cells.length ? 'on' : 'mixed';
}

function inboxSubtitle(count: number): string {
  return count === 0 ? t('all seen') : t('{count} new', { count });
}

export function PhoneNotifications({
  dto,
  model,
  inbox,
  ctx,
  now,
  me,
}: {
  dto: NotificationsDto;
  model: NotificationsModel;
  inbox: InboxModel;
  ctx: CodeContext;
  now: number;
  me: MeDto | null;
}) {
  const prefs = useResource('notify-me', api.notifications.me, { reloadOn: ['personal_prefs'] });
  const canEdit = me?.canEditConfig ?? false;
  const userId = me?.userId ?? null;

  const own = useMemo(() => dto.targets.filter((x) => userId != null && x.ownerUserId === userId), [dto.targets, userId]);
  // an administrator without a phone of their own looks after the house's main phone here
  const phones = useMemo(() => {
    const mine = own.filter((x) => x.channel === 'ha_mobile');
    return mine.length || !canEdit ? mine : dto.targets.filter((x) => x.channel === 'ha_mobile' && x.isPrimary);
  }, [own, dto.targets, canEdit]);
  const chats = useMemo(() => (canEdit ? dto.targets.filter((x) => x.channel === 'telegram') : own.filter((x) => x.channel === 'telegram')), [dto.targets, own, canEdit]);
  const panel = dto.targets.filter((x) => x.channel === 'ha_persistent');
  // levels are personal: they re-route only the targets this person owns, never the house's
  const personal = useMemo(() => own.filter((x) => x.channel === 'ha_mobile' || x.channel === 'telegram'), [own]);

  const patchMe = useMutation((p: Partial<PersonalPrefs>) => api.notifications.patchMe(p), {
    onSuccess: (r) => r && prefs.setData(r),
    onError: () => void prefs.reload(),
  });
  const bulk = useMutation((body: Parameters<Api['notifications']['routeBulk']>[0]) => api.notifications.routeBulk(body), {
    onSuccess: (r) => r && model.res.setData(r),
  });

  /** «Цей телефон» / «Telegram» / «Панель»: switch the targets themselves, or — for a household member — their routing. */
  const setWhere = (targets: readonly Target[], on: boolean) => {
    if (canEdit) {
      for (const x of targets) if (x.enabled !== on) void model.patchTarget(x.id, { enabled: on });
      return;
    }
    const kinds = dto.catalogue.filter((c) => c.severity !== 'critical').map((c) => c.kind);
    void bulk.run({ kinds, targetIds: targets.map((x) => x.id), on });
  };
  const whereOn = (targets: readonly Target[]) =>
    canEdit ? targets.some((x) => x.enabled) : routingState(dto, dto.catalogue.filter((c) => c.severity !== 'critical').map((c) => c.kind), targets) !== 'off';

  const setLevel = (level: Level, on: boolean) => {
    const p = prefs.data;
    if (!p) return;
    prefs.setData({ ...p, levels: { ...p.levels, [level]: on } });
    void patchMe.run({ levels: { ...p.levels, [level]: on } });
    if (personal.length) void bulk.run({ kinds: LEVEL_KINDS(dto, level), targetIds: personal.map((x) => x.id), on });
  };

  const levelRow = (level: Level, title: string, sub: string, tone: 'warn' | 'event' | 'off') => {
    const on = prefs.data?.levels[level] ?? true;
    const mixed = on && routingState(dto, LEVEL_KINDS(dto, level), personal) === 'mixed';
    return (
      <CheckboxRow
        key={level}
        variant="list"
        leading={<StatusDot tone={tone} size={10} />}
        checked={on}
        title={title}
        hint={mixed ? `${sub} · ${t('partly, as set in the table')}` : sub}
        disabled={!prefs.data || patchMe.pending}
        onChange={(v) => setLevel(level, v)}
      />
    );
  };

  const names = (targets: readonly Target[]) => targets.map((x) => x.name).join(' · ');
  const quiet = dto.settings.quietHours;

  return (
    <Stack gap="lg">
      <MobileTopBar
        title={t('Notifications')}
        subtitle={{ text: inboxSubtitle(inbox.openCount), strong: inbox.openCount > 0 }}
        onBack={() => navigate(paths.system())}
      />
      {inbox.items.length || inbox.loading ? (
        <InboxList inbox={inbox} ctx={ctx} now={now} />
      ) : (
        <EmptyState icon="checkCircle" tone="ok" title={t('Everything is in order')} text={t('Nothing waits for you.')} />
      )}

      <Section variant="plain" level={3} overline={t('Where')}>
        <RowList ariaLabel={t('Where')}>
          <CheckboxRow
            variant="list"
            leading={<Icon name="phone" size={20} />}
            checked={phones.length > 0 && whereOn(phones)}
            title={t('This phone')}
            hint={phones.length ? t('Home Assistant app · critical through «Do not disturb»') : t('Not connected — add it on a computer, in «Notifications».')}
            disabled={!phones.length}
            onChange={(on) => setWhere(phones, on)}
          />
          <CheckboxRow
            variant="list"
            leading={<Icon name="send" size={20} />}
            checked={chats.length > 0 && whereOn(chats)}
            title={t('Telegram')}
            hint={chats.length ? names(chats) : t('No chat connected yet')}
            disabled={!chats.length}
            onChange={(on) => setWhere(chats, on)}
          />
          <CheckboxRow
            variant="list"
            leading={<Icon name="bell" size={20} />}
            checked={panel.some((x) => x.enabled)}
            title={t('Home Assistant panel')}
            hint={t('stays until you close it · for everyone')}
            disabled={!canEdit || !panel.length}
            onChange={(on) => setWhere(panel, on)}
          />
        </RowList>
      </Section>

      <Section variant="plain" level={3} overline={t('About what')}>
        {prefs.data ? (
          <RowList ariaLabel={t('About what')}>
            <CheckboxRow
              variant="list"
              leading={<StatusDot tone="err" size={10} />}
              checked
              title={t('Critical')}
              hint={t('source failure, entity dropped out, frost')}
              locked={{ reason: t('always on') }}
              onChange={() => undefined}
            />
            {levelRow('warning', t('Warnings'), t('a sensor went silent, a valve did not answer, a battery'), 'warn')}
            {levelRow('event', t('Events'), t('reserve source, triggers, profile change'), 'event')}
            {levelRow('report', t('Daily summary at {time}', { time: dto.settings.reports.daily.time }), t('cycles, running hours, energy'), 'off')}
          </RowList>
        ) : (
          <Skeleton height={200} radius={16} />
        )}
      </Section>

      <RowList>
        <CheckboxRow
          variant="list"
          leading={<Icon name="moon" size={20} />}
          checked={prefs.data?.quietHours ?? true}
          title={t('Quiet hours {from}–{to}', { from: quiet.from, to: quiet.to })}
          hint={quiet.enabled ? t('critical ones arrive anyway') : t('switched off for the whole house')}
          disabled={!prefs.data || !quiet.enabled}
          onChange={(on) => {
            if (prefs.data) prefs.setData({ ...prefs.data, quietHours: on });
            void patchMe.run({ quietHours: on });
          }}
        />
      </RowList>
    </Stack>
  );
}
