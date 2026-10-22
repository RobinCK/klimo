/**
 * «Канали»: where messages go — phones through the Home Assistant app, Telegram chats, the HA
 * sidebar and the automation event — with their targets, a test per channel, and the dialogs
 * that add a phone, pair a Telegram chat and edit a target.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ChannelKind, ChannelStatus, NotificationsDto, NotifyServiceDto, NotifyTargetCreateRequest, TelegramPairDto, TelegramPairStatusDto, Tone } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useResource } from '@data';
import {
  AutoGrid,
  Button,
  ChannelCard,
  CheckboxRow,
  CodeBlock,
  ConfirmDialog,
  DashedAddButton,
  Dialog,
  EmptyState,
  KeyValueList,
  RadioCardList,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  StatusBanner,
  TargetRow,
  TestButton,
  Text,
  TextField,
} from '@ui';
import { brand } from '@brand';
import { channelStatusLabel, errorText, fmtTime, t } from '@i18n';
import { openTab } from './links';
import { scopeLabel, type Target } from './texts';
import type { NotificationsModel } from './useNotifications';

const STATUS_TONE: Record<ChannelStatus, Tone> = {
  ok: 'ok',
  error: 'err',
  unconfigured: 'off',
  disabled: 'off',
  polling_conflict: 'warn',
  webhook_set: 'warn',
};

function channelOf(dto: NotificationsDto, channel: ChannelKind) {
  return dto.channels.find((c) => c.channel === channel) ?? null;
}

function statusOf(dto: NotificationsDto, channel: ChannelKind, targets: readonly Target[]): { tone: Tone; label: string } {
  const c = channelOf(dto, channel);
  if (!c) return { tone: 'off', label: channelStatusLabel('unconfigured') };
  if (c.status === 'ok' && !targets.some((x) => x.enabled)) return { tone: 'off', label: channelStatusLabel('disabled') };
  return { tone: STATUS_TONE[c.status], label: channelStatusLabel(c.status) };
}

async function testRun(body: Parameters<typeof api.notifications.test>[0]): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await api.notifications.test(body);
    const failed = r.results.filter((x) => !x.ok);
    if (!r.results.length) return { ok: false, error: t('There is nowhere to send it yet') };
    return failed.length ? { ok: false, error: failed.map((f) => f.error ?? t('Not delivered')).join('; ') } : { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) || t('Did not go through') };
  }
}

/* ---------------- target editor ---------------- */

function TargetDialog({ target, model, onClose }: { target: Target; model: NotificationsModel; onClose: () => void }) {
  const [name, setName] = useState(target.name);
  const [shortName, setShortName] = useState(target.shortName ?? '');
  const [enabled, setEnabled] = useState(target.enabled);
  const [primary, setPrimary] = useState(target.isPrimary);
  const [escalation, setEscalation] = useState(target.isEscalation);
  const [confirm, setConfirm] = useState(false);
  const canBePrimary = target.channel === 'ha_mobile' || target.channel === 'telegram';
  const save = async () => {
    const r = await model.patchTarget(target.id, {
      name: name.trim() || target.name,
      shortName: shortName.trim() || null,
      enabled,
      ...(canBePrimary && primary !== target.isPrimary ? { isPrimary: primary } : {}),
      ...(target.channel === 'telegram' && escalation !== target.isEscalation ? { isEscalation: escalation } : {}),
    });
    if (r) onClose();
  };
  return (
    <>
      <Dialog
        open={!confirm}
        onClose={onClose}
        title={target.name}
        actions={[
          { label: t('Remove'), onClick: () => setConfirm(true), disabled: target.isPrimary },
          { label: t('Cancel'), onClick: onClose },
          { label: t('Save'), onClick: () => void save(), loading: model.pending },
        ]}
      >
        <Stack gap="md">
          <TextField label={t('Name')} value={name} onChange={setName} maxLength={40} autoFocus />
          <TextField
            label={t('Short name for the table')}
            value={shortName}
            onChange={setShortName}
            maxLength={24}
            placeholder={name}
            help={t('Shown above its column in «What goes where».')}
          />
          <CheckboxRow checked={enabled} title={t('Send to it')} hint={t('Off: nothing is sent here, the table keeps its ticks.')} onChange={setEnabled} />
          {canBePrimary ? (
            <CheckboxRow
              checked={primary}
              title={t('Main target for critical alerts')}
              hint={t('Critical alerts always reach it; exactly one target has this.')}
              locked={target.isPrimary ? { reason: t('Make another target the main one instead') } : undefined}
              onChange={setPrimary}
            />
          ) : null}
          {target.channel === 'telegram' ? (
            <CheckboxRow
              checked={escalation}
              title={t('Escalation chat')}
              hint={t('Gets a critical alert nobody reacted to, even where its cell is off.')}
              onChange={setEscalation}
            />
          ) : null}
        </Stack>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={t('Remove «{name}»?', { name: target.name })}
        consequences={[t('Its column disappears from the table; nothing is sent there any more.')]}
        confirm={{
          label: t('Remove'),
          tone: 'danger',
          loading: model.pending,
          onClick: () =>
            void model.removeTarget(target.id).then((r) => {
              if (r) onClose();
              else setConfirm(false);
            }),
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

const blankTarget = (p: Pick<NotifyTargetCreateRequest, 'channel' | 'name' | 'icon'> & Partial<NotifyTargetCreateRequest>): NotifyTargetCreateRequest => ({
  shortName: null,
  enabled: true,
  service: null,
  chatId: null,
  chatTitle: null,
  isPrimary: false,
  isEscalation: false,
  ownerUserId: null,
  ...p,
});

/* ---------------- add a phone ---------------- */

function AddPhoneDialog({ dto, model, onClose }: { dto: NotificationsDto; model: NotificationsModel; onClose: () => void }) {
  const services = useResource('ha:notify-services', api.ha.notifyServices);
  const used = new Set(dto.targets.map((x) => x.service).filter(Boolean));
  const free = (services.data ?? []).filter((s) => !used.has(s.service));
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const chosen: NotifyServiceDto | undefined = free.find((s) => s.service === pick);
  useEffect(() => {
    if (chosen) setName(chosen.deviceName ?? chosen.name);
  }, [chosen]);
  const add = async () => {
    if (!chosen) return;
    const r = await model.addTarget(
      blankTarget({
        channel: chosen.mobile ? 'ha_mobile' : 'ha_notify',
        name: name.trim() || chosen.name,
        icon: chosen.mobile ? 'phone' : 'bell',
        service: chosen.service,
        ownerUserId: chosen.haUserId,
      }),
    );
    if (r) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Add a phone')}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add'), onClick: () => void add(), disabled: !chosen, loading: model.pending },
      ]}
    >
      {!services.settled ? (
        <Skeleton height={120} />
      ) : free.length ? (
        <Stack gap="md">
          <RadioCardList<string>
            ariaLabel={t('Notify service')}
            value={pick ?? ''}
            onChange={setPick}
            compact
            options={free.map((s) => ({
              value: s.service,
              title: s.deviceName ?? s.name,
              hint: s.mobile ? t('Home Assistant app') : t('Notify service'),
              tech: s.service,
            }))}
          />
          {chosen ? <TextField label={t('Name')} value={name} onChange={setName} maxLength={40} /> : null}
        </Stack>
      ) : (
        <EmptyState
          icon="phone"
          title={t('No new phones')}
          text={t('Install the Home Assistant app on the phone and sign in; it then appears here as a notify service.')}
        />
      )}
    </Dialog>
  );
}

/* ---------------- add a Telegram chat ---------------- */

function PairDialog({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
  const [pair, setPair] = useState<TelegramPairDto | null>(null);
  const [status, setStatus] = useState<TelegramPairStatusDto['status'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.notifications.pairTelegram().then(
      (p) => alive && setPair(p),
      (e: unknown) => alive && setError(errorText(e) || t('Could not start pairing')),
    );
    return () => {
      alive = false;
    };
  }, []);

  // the bot sees «/start <code>» from the new chat; the panel only has to ask every 2 s
  useEffect(() => {
    if (!pair || status === 'paired' || status === 'expired') return;
    const id = window.setInterval(() => {
      api.notifications.pairStatus(pair.code).then(
        (s) => {
          setStatus(s.status);
          if (s.status === 'paired') onPaired();
        },
        () => undefined,
      );
    }, 2000);
    return () => window.clearInterval(id);
  }, [pair, status, onPaired]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Add a Telegram chat')}
      actions={[{ label: status === 'paired' ? t('Done') : t('Close'), onClick: onClose }]}
    >
      {error ? (
        <StatusBanner tone="err" icon="alert" text={error} />
      ) : !pair ? (
        <Skeleton height={140} />
      ) : status === 'paired' ? (
        <StatusBanner tone="ok" icon="checkCircle" text={t('The chat is connected. Pick what it gets in the table.')} />
      ) : status === 'expired' ? (
        <StatusBanner tone="warn" icon="clock" text={t('The code expired. Close this window and try again.')} />
      ) : (
        <Stack gap="md">
          <KeyValueList
            rows={[
              { key: t('Code'), value: pair.code, mono: true },
              { key: t('Valid until'), value: fmtTime(pair.expiresAt) },
            ]}
          />
          <CodeBlock code={`/start ${pair.code}`} ariaLabel={t('Message for the bot')} />
          <StatusBanner
            tone="event"
            icon="send"
            text={t('Open the bot and press «Start», or send it this message. For a family group, add the bot to the group first.')}
            action={pair.deepLink ? { label: t('Open the bot'), onClick: () => openTab(pair.deepLink as string) } : undefined}
          />
        </Stack>
      )}
    </Dialog>
  );
}

function ChatIdDialog({ model, onClose }: { model: NotificationsModel; onClose: () => void }) {
  const [chatId, setChatId] = useState('');
  const [name, setName] = useState('');
  const valid = /^-?\d{1,20}$/.test(chatId.trim()) && name.trim() !== '';
  const add = async () => {
    const id = chatId.trim();
    const r = await model.addTarget(
      blankTarget({ channel: 'telegram', name: name.trim(), icon: id.startsWith('-') ? 'users' : 'send', chatId: id, chatTitle: name.trim() }),
    );
    if (r) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Add a Telegram chat')}
      actions={[
        { label: t('Cancel'), onClick: onClose },
        { label: t('Add'), onClick: () => void add(), disabled: !valid, loading: model.pending },
      ]}
    >
      <Stack gap="md">
        <TextField label={t('Name')} value={name} onChange={setName} maxLength={40} placeholder={t('Family group')} autoFocus />
        <TextField
          label={t('Chat id')}
          value={chatId}
          onChange={setChatId}
          mono
          placeholder="-1001872345678"
          help={t('The chat must be allowed in the telegram_bot integration of Home Assistant; group ids start with a minus.')}
        />
      </Stack>
    </Dialog>
  );
}

/* ---------------- the cards ---------------- */

/** The HA service the integration mode sends through; saved after typing stops. */
function HaServiceField({ value, model }: { value: string | null; model: NotificationsModel }) {
  const auto = useAutosave(value ?? '', (next: string) => model.patchSettings({ telegram: { haService: next.trim() || null } }), { debounceMs: 800 });
  return (
    <TextField
      label={t('Home Assistant service')}
      value={auto.value}
      onChange={auto.set}
      onBlur={() => void auto.flush()}
      mono
      placeholder="telegram_bot.send_message"
    />
  );
}

type Open = { kind: 'target'; target: Target } | { kind: 'phone' } | { kind: 'pair' } | { kind: 'chat' } | null;

export function ChannelsSection({ dto, model, canEdit }: { dto: NotificationsDto; model: NotificationsModel; canEdit: boolean }) {
  const [open, setOpen] = useState<Open>(null);
  const [bot, setBot] = useState<string | null>(null);
  const phones = useMemo(() => dto.targets.filter((x) => x.channel === 'ha_mobile' || x.channel === 'ha_notify'), [dto.targets]);
  const chats = useMemo(() => dto.targets.filter((x) => x.channel === 'telegram'), [dto.targets]);
  const panel = dto.targets.find((x) => x.channel === 'ha_persistent') ?? null;
  const event = dto.targets.find((x) => x.channel === 'ha_event') ?? null;
  const tg = dto.settings.telegram;
  const tgChannel = channelOf(dto, 'telegram');
  const botName = bot ?? tg.botUsername ?? tgChannel?.botUsername ?? null;
  const panelChannel = channelOf(dto, 'ha_persistent');
  const openCount = panelChannel?.openCount ?? 0;
  const edit = (target: Target) => (canEdit ? () => setOpen({ kind: 'target', target }) : undefined);

  const panelStatus: { tone: Tone; label: string } =
    panel && panel.enabled && panelChannel?.status === 'ok'
      ? { tone: 'ok', label: t('{count} open', { count: openCount }) }
      : statusOf(dto, 'ha_persistent', panel ? [panel] : []);

  const example = [
    'event_type: klimo_event',
    'data:',
    '  kind: sensor_offline',
    '  severity: warning',
    '  state: open',
    '  room: kitchen',
    '  entity: sensor.kitchen_shelf_temperature',
  ].join('\n');

  return (
    <Section title={t('Channels')} variant="plain">
      <AutoGrid min={300} gap="md">
        <ChannelCard
          icon="phone"
          title={t('HA app')}
          sub={t('native push · {count} devices', { count: phones.length })}
          status={statusOf(dto, 'ha_mobile', phones)}
          test={phones.length ? { label: t('Send a test'), successLabel: t('Sent ✓'), run: () => testRun({ channel: 'ha_mobile' }) } : undefined}
        >
          <Stack gap="xs">
            {phones.map((x) => (
              <TargetRow
                key={x.id}
                name={x.enabled ? x.name : `${x.name} · ${t('off')}`}
                entity={x.service ?? '—'}
                scope={scopeLabel(x.scope)}
                onEdit={edit(x)}
                editLabel={t('Edit «{name}»', { name: x.name })}
              />
            ))}
            {canEdit ? <DashedAddButton label={t('Add a phone')} onClick={() => setOpen({ kind: 'phone' })} /> : null}
          </Stack>
          <CheckboxRow
            checked={dto.settings.criticalBypassDnd}
            title={t('Critical — even in «Do not disturb»')}
            hint={t('with an alarm sound, on iOS and Android')}
            disabled={!canEdit}
            onChange={(on) => void model.patchSettings({ criticalBypassDnd: on })}
          />
        </ChannelCard>

        <ChannelCard
          icon="send"
          title={t('Telegram bot')}
          sub={t('messages with action buttons')}
          status={statusOf(dto, 'telegram', chats)}
          test={chats.length ? { label: t('Send a test'), successLabel: t('Sent ✓'), run: () => testRun({ channel: 'telegram' }) } : undefined}
        >
          <SegmentedControl<'integration' | 'own'>
            value={tg.mode}
            full
            size="xs"
            surface="well"
            ariaLabel={t('How the bot is connected')}
            options={[
              { value: 'integration', label: t('Through HA'), disabled: !canEdit },
              { value: 'own', label: t('Own bot'), disabled: !canEdit },
            ]}
            onChange={(mode) => void model.patchSettings({ telegram: { mode } })}
            hint={
              tg.mode === 'integration'
                ? t('The bot is already set up in Home Assistant. Messages go through it; button presses come back as the telegram_callback event.')
                : t('A bot just for the climate: put the token from @BotFather into the add-on options, and {product} sends messages and receives button presses itself.', {
                    product: brand.productName,
                  })
            }
          />
          {tg.mode === 'own' ? (
            <Stack gap="xs">
              <StatusBanner
                tone={dto.telegramTokenPresent ? (tgChannel?.status === 'ok' ? 'ok' : 'warn') : 'warn'}
                icon={dto.telegramTokenPresent ? 'checkCircle' : 'alert'}
                text={
                  dto.telegramTokenPresent
                    ? botName
                      ? t('Token set · bot @{bot}', { bot: botName })
                      : t('Token set in the add-on options')
                    : t('No token yet: add telegram_bot_token in the add-on options and restart it.')
                }
              />
              {tgChannel?.detail ? <StatusBanner tone="warn" icon="info" text={tgChannel.detail} /> : null}
              {dto.telegramTokenPresent && canEdit ? (
                <TestButton
                  label={t('Verify')}
                  successLabel={botName ? `@${botName} ✓` : t('Works ✓')}
                  icon="checkCircle"
                  run={async () => {
                    try {
                      const r = await api.notifications.verifyTelegram();
                      if (r.botUsername) setBot(r.botUsername);
                      return { ok: r.ok, error: r.error ?? undefined };
                    } catch (e) {
                      return { ok: false, error: errorText(e) };
                    }
                  }}
                />
              ) : null}
            </Stack>
          ) : canEdit ? (
            <HaServiceField value={tg.haService} model={model} />
          ) : null}
          <Stack gap="xs">
            {chats.map((x) => (
              <TargetRow
                key={x.id}
                name={x.enabled ? x.name : `${x.name} · ${t('off')}`}
                entity={[x.chatTitle, x.chatId].filter(Boolean).join(' · ') || '—'}
                scope={scopeLabel(x.scope)}
                onEdit={edit(x)}
                editLabel={t('Edit «{name}»', { name: x.name })}
              />
            ))}
            {canEdit ? (
              <DashedAddButton
                label={t('Add a chat')}
                onClick={() => setOpen(tg.mode === 'own' ? { kind: 'pair' } : { kind: 'chat' })}
              />
            ) : null}
          </Stack>
        </ChannelCard>

        <ChannelCard icon="bell" title={t('Notifications in Home Assistant')} sub="persistent_notification" status={panelStatus}>
          <Stack gap="xs">
            <Text>{t('They stay in the HA sidebar until someone closes them. Every user of the house sees them.')}</Text>
            <Text>{t('{product} closes them itself once the problem is gone: the sensor is back, the valve confirmed.', { product: brand.productName })}</Text>
            {panel ? (
              <CheckboxRow
                checked={panel.enabled}
                title={t('Send to the HA sidebar')}
                disabled={!canEdit}
                onChange={(enabled) => void model.patchTarget(panel.id, { enabled })}
              />
            ) : canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                icon="plus"
                onClick={() => void model.addTarget(blankTarget({ channel: 'ha_persistent', name: t('HA panel'), icon: 'bell' }))}
              >
                {t('Turn on')}
              </Button>
            ) : null}
          </Stack>
        </ChannelCard>

        <ChannelCard icon="bolt" title={t('Automations')} sub="klimo_event · MQTT klimo/events" status={statusOf(dto, 'ha_event', event ? [event] : [])}>
          <Text>{t('Any automation or Node-RED flow receives the same event and does its own thing: blinks a light, speaks on a speaker.')}</Text>
          <CodeBlock code={example} ariaLabel={t('Example event')} />
        </ChannelCard>
      </AutoGrid>

      {open?.kind === 'target' ? <TargetDialog key={open.target.id} target={open.target} model={model} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'phone' ? <AddPhoneDialog dto={dto} model={model} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'pair' ? <PairDialog onClose={() => setOpen(null)} onPaired={() => void model.res.reload()} /> : null}
      {open?.kind === 'chat' ? <ChatIdDialog model={model} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

