/**
 * «Резервна копія»: the whole configuration as one file, and restoring it. A restore is first
 * tried without writing anything, so the summary of what would change — and any problems — is
 * seen before the current settings are replaced.
 */
import { useState } from 'react';
import type { ExportBundle, ImportResult } from '@api/model';
import { api } from '@api/endpoints';
import { Button, ConfirmDialog, Dialog, FileButton, KeyValueList, Row, Section, Stack, StatusBanner, Text, toast } from '@ui';
import { errorText, issueText, t } from '@i18n';

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
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const reset = () => {
    setBundle(null);
    setCheck(null);
    setConfirm(false);
  };

  const pick = async (f: File) => {
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
        <Text>
          {t('Every setting — rooms, profiles, sources, notifications — in one file. History and the journal are not included, nor is the Telegram token.')}
        </Text>
        <Row gap="sm" wrap>
          <Button variant="secondary" onClick={() => window.location.assign(api.exportUrl)}>
            {t('Download a backup')}
          </Button>
          {canEdit ? (
            <FileButton label={t('Restore from a file…')} accept="application/json,.json" icon="undo" loading={busy && !bundle} onFile={(f) => void pick(f)} />
          ) : null}
        </Row>
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
                  <Text key={`${i.path}-${n}`}>{`${i.path}: ${issueText(i)}`}</Text>
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
