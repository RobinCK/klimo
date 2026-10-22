/**
 * Notifications («Сповіщення»): where and about what the system tells people. Critical alerts
 * always arrive; the rest follows the routing table and the delivery rules. Wide screens show
 * the whole configuration under the open problems; a phone shows the inbox and this person's
 * own preferences.
 */
import type { NotificationsDto } from '@api/model';
import { useCodeContext, useLayout, useMe, useNow } from '@data';
import { AutoGrid, MobileTopBar, Page, Section, Skeleton, Stack, StatusBanner, TestButton } from '@ui';
import { navigate, paths } from '@app';
import { errorText, t } from '@i18n';
import { api } from '@api/endpoints';
import { ChannelsSection } from './Channels';
import { InboxList, useInbox, type InboxModel } from './Inbox';
import { PhoneNotifications } from './Phone';
import { RoutingSection } from './Routing';
import { PreviewSection, RulesSection } from './Rules';
import { SentLogSection } from './SentLog';
import { useNotifications, type NotificationsModel } from './useNotifications';
import { WatchSection } from './Watch';

async function testAll(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await api.notifications.test({ all: true });
    if (!r.results.length) return { ok: false, error: t('There is nowhere to send it yet') };
    const failed = r.results.filter((x) => !x.ok);
    return failed.length ? { ok: false, error: t('{count} targets did not get it', { count: failed.length }) } : { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) || t('Did not go through') };
  }
}

function Desktop({ dto, model, inbox, now, canEdit }: { dto: NotificationsDto; model: NotificationsModel; inbox: InboxModel; now: number; canEdit: boolean }) {
  const ctx = useCodeContext();
  return (
    <Page
      title={t('Notifications')}
      subtitle={t('Where and about what you are told. Critical alerts always arrive, the rest follows the rules below.')}
      actions={<TestButton label={t('Test notification')} successLabel={t('Sent to every channel')} run={testAll} />}
    >
      {!canEdit ? <StatusBanner tone="event" icon="lock" text={t('Only a Home Assistant administrator can change these settings.')} /> : null}
      {inbox.items.length ? (
        <Section title={t('Open now')} variant="plain" tag={inbox.openCount ? String(inbox.openCount) : undefined}>
          <InboxList inbox={inbox} ctx={ctx} now={now} grid />
        </Section>
      ) : null}
      <ChannelsSection dto={dto} model={model} canEdit={canEdit} />
      <RoutingSection dto={dto} model={model} canEdit={canEdit} />
      <AutoGrid min={560} gap="xl">
        <RulesSection dto={dto} model={model} canEdit={canEdit} />
        <PreviewSection dto={dto} />
      </AutoGrid>
      <WatchSection dto={dto} model={model} ctx={ctx} now={now} canEdit={canEdit} />
      <SentLogSection dto={dto} now={now} />
    </Page>
  );
}

function Loading({ phone, error, retry }: { phone: boolean; error: unknown; retry: () => void }) {
  if (error) {
    return <StatusBanner tone="err" icon="alert" text={errorText(error) || t('Could not load the notification settings.')} action={{ label: t('Try again'), onClick: retry }} />;
  }
  return (
    <Stack gap="xl">
      {phone ? null : <Skeleton height={56} width="50%" radius={12} />}
      <AutoGrid min={300} gap="md">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={phone ? 64 : 260} radius={18} />
        ))}
      </AutoGrid>
      {phone ? null : <Skeleton height={420} radius={20} />}
    </Stack>
  );
}

export default function NotificationsPage(): JSX.Element {
  const phone = useLayout() === 'phone';
  const now = useNow(30_000);
  const me = useMe();
  const canEdit = me?.canEditConfig ?? false;
  const model = useNotifications();
  const ctx = useCodeContext();
  const inbox = useInbox(model.data?.settings.quietHours.to, now);
  const dto = model.data;

  if (!dto) {
    const loading = <Loading phone={phone} error={model.res.settled ? model.res.error : undefined} retry={() => void model.res.reload()} />;
    return phone ? (
      <Stack gap="lg">
        <MobileTopBar title={t('Notifications')} onBack={() => navigate(paths.system())} />
        {loading}
      </Stack>
    ) : (
      <Page title={t('Notifications')}>{loading}</Page>
    );
  }
  return phone ? (
    <PhoneNotifications dto={dto} model={model} inbox={inbox} ctx={ctx} now={now} me={me} />
  ) : (
    <Desktop dto={dto} model={model} inbox={inbox} now={now} canEdit={canEdit} />
  );
}
