/**
 * «Резервна копія»: the whole configuration as one file, and restoring it. A restore is first
 * tried without writing anything, so the summary of what would change — and any problems — is
 * seen before the current settings are replaced.
 */
import { useRef, useState } from 'react';
import type { ExportBundle, ImportResult } from '@api/model';
import { api } from '@api/endpoints';
import { Button, ConfirmDialog, Dialog, KeyValueList, Row, Section, Stack, StatusBanner, toast } from '@ui';
import { errorText, issueText, t } from '@i18n';
import { Note } from './Note';

/** Names of the configuration tables as a person reads them. */
function tableLabel(key: string): string {
  switch (key) {
    case 'rooms':
      return t('Rooms');
    case 'sensors':
      return t('Sensors');
    case 'emitters':
      return t('Heat emitters');
    case 'emitterDevices':
      return t('Radiator valves and zone valves');
    case 'profiles':
      return t('Profiles');
    case 'schedules':
      return t('Schedules');
    case 'sources':
      return t('Sources');
    case 'circuits':
      return t('Circuits');
    case 'pumps':
      return t('Pumps');
    case 'triggers':
      return t('Triggers');
    case 'rules':
      return t('Rules');
    case 'activationRules':
      return t('Profile activation rules');
    case 'scheduleExceptions':
      return t('Schedule exceptions');
    case 'manifolds':
      return t('Manifolds');
    case 'notify.targets':
      return t('Notification targets');
    case 'notify.watch':
      return t('Watched entities');
    case 'devices.z2m':
      return t('Zigbee2MQTT instances');
    default:
      return key;
  }
}

function isBundle(v: unknown): v is ExportBundle {
  return typeof v === 'object' && v !== null && (v as { app?: unknown }).app === 'klimo' && (v as { version?: unknown }).version === 1;
}

export function BackupSection({ canEdit }: { canEdit: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const reset = () => {
    setBundle(null);
    setCheck(null);
    setConfirm(false);
    if (file.current) file.current.value = '';
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await f.text());
      if (!isBundle(parsed)) throw new Error(t('This is not a backup of this add-on.'));
      setBundle(parsed);
      setCheck(await api.importBundle(parsed, { dryRun: true }));
    } catch (e) {
      toast({ tone: 'err', message: errorText(e) || (e instanceof Error ? e.message : t('The file could not be read.')) });
      reset();
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const r = await api.importBundle(bundle);
      if (!r.ok) {
        setCheck(r);
        setConfirm(false);
        return;
      }
      toast({ tone: 'ok', message: t('Settings restored') });
      reset();
    } catch (e) {
      toast({ tone: 'err', message: errorText(e) || t('Did not go through') });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const counts = check ? Object.entries(check.counts).filter(([, n]) => n > 0) : [];

  return (
    <Section title={t('Backup')} icon="copy">
      <Stack gap="md">
        <Note text={t('Every setting — rooms, profiles, sources, notifications — in one file. History and the journal are not included, nor is the Telegram token.')} />
        <Row gap="sm" wrap>
          <Button variant="secondary" onClick={() => window.location.assign(api.exportUrl)}>
            {t('Download a backup')}
          </Button>
          {canEdit ? (
            <Button variant="outline" icon="undo" loading={busy && !bundle} onClick={() => file.current?.click()}>
              {t('Restore from a file…')}
            </Button>
          ) : null}
        </Row>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.currentTarget.files?.[0])} />
      </Stack>

      <Dialog
        open={check != null && !confirm}
        onClose={reset}
        title={t('Restore settings')}
        size="md"
        actions={[
          { label: t('Cancel'), onClick: reset },
          { label: t('Restore…'), onClick: () => setConfirm(true), disabled: !check?.ok },
        ]}
      >
        {check ? (
          <Stack gap="md">
            {check.ok ? (
              <StatusBanner tone="ok" icon="checkCircle" text={t('The file is fine. Restoring replaces the current settings with these:')} />
            ) : (
              <StatusBanner tone="err" icon="alert" text={t('The file cannot be restored as it is:')} />
            )}
            {check.issues.length ? (
              <Stack gap="2xs">
                {check.issues.slice(0, 8).map((i, n) => (
                  <Note key={`${i.path}-${n}`} text={`${i.path}: ${issueText(i)}`} />
                ))}
              </Stack>
            ) : null}
            {counts.length ? <KeyValueList rows={counts.map(([k, n]) => ({ key: tableLabel(k), value: String(n) }))} /> : null}
          </Stack>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={t('Replace the current settings?')}
        consequences={[t('Rooms, profiles, sources and notification settings are replaced by the ones from the file.'), t('Download a backup of the current settings first if you might need them.')]}
        confirm={{ label: t('Restore'), tone: 'danger', loading: busy, onClick: () => void restore() }}
        onCancel={() => setConfirm(false)}
      />
    </Section>
  );
}
