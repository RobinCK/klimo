/**
 * Zigbee2MQTT instances: which bridges carry the radiator valves and sensors, whether they are
 * online, and what happens after one restarts (every target is sent again and source relays are
 * read back).
 */
import { useState } from 'react';
import type { Id, Z2mInstanceCreateRequest, Z2mInstanceDto } from '@api/model';
import { api } from '@api/endpoints';
import { useEntitySearch, useMutation } from '@data';
import { Button, CheckboxRow, ConfirmDialog, DashedAddButton, Dialog, EmptyState, EntityPicker, InstanceRow, Row, Section, Stack, TextField } from '@ui';
import { brand } from '@brand';
import { fmtClock, t } from '@i18n';
import { openExternal } from './actions';

const BLANK: Z2mInstanceCreateRequest = { name: '', baseTopic: 'zigbee2mqtt', frontendUrl: null, bridgeEntityId: null, resendOnRestart: true };

function statusOf(i: Z2mInstanceDto): { tone: 'ok' | 'err' | 'off'; label: string } {
  if (i.online === true) return { tone: 'ok', label: t('online') };
  if (i.online === false) return { tone: 'err', label: t('offline') };
  return { tone: 'off', label: t('unknown') };
}

function InstanceDialog({
  open,
  initial,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Z2mInstanceCreateRequest;
  editing: Id | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const search = useEntitySearch('binary', { domain: ['binary_sensor'] });
  const save = useMutation(
    (body: Z2mInstanceCreateRequest) => (editing ? api.z2m.patch(editing, body) : api.z2m.create(body)),
    {
      okToast: editing ? t('Saved') : t('Instance added'),
      onSuccess: () => {
        onSaved();
        onClose();
      },
    },
  );
  const remove = useMutation((id: Id) => api.z2m.remove(id), {
    okToast: t('Instance removed'),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const issues = save.issues;
  const valid = v.name.trim() !== '' && v.baseTopic.trim() !== '';

  return (
    <>
      <Dialog
        open={open && !confirmDelete}
        onClose={onClose}
        title={editing ? t('Zigbee2MQTT instance') : t('Add a Zigbee2MQTT instance')}
        actions={[
          ...(editing ? [{ label: t('Remove'), onClick: () => setConfirmDelete(true) }] : []),
          { label: t('Cancel'), onClick: onClose },
          {
            label: editing ? t('Save') : t('Add'),
            loading: save.pending,
            disabled: !valid,
            onClick: () =>
              void save.run({ ...v, name: v.name.trim(), baseTopic: v.baseTopic.trim(), frontendUrl: v.frontendUrl?.trim() ? v.frontendUrl.trim() : null }),
          },
        ]}
      >
        <Stack gap="md">
          <TextField label={t('Name')} value={v.name} onChange={(name) => setV({ ...v, name })} placeholder="Z2M #1" error={issues.name} autoFocus />
          <TextField
            label={t('MQTT base topic')}
            value={v.baseTopic}
            onChange={(baseTopic) => setV({ ...v, baseTopic })}
            mono
            error={issues.baseTopic}
            help={t('As in the Zigbee2MQTT settings; every instance has its own.')}
          />
          <TextField
            label={t('Zigbee2MQTT web address')}
            value={v.frontendUrl ?? ''}
            onChange={(url) => setV({ ...v, frontendUrl: url })}
            mono
            placeholder="http://homeassistant.local:8080"
            error={issues.frontendUrl}
            help={t('For the «Open in Zigbee2MQTT» buttons; leave empty to hide them.')}
          />
          <EntityPicker
            value={v.bridgeEntityId}
            onChange={(id) => setV({ ...v, bridgeEntityId: id })}
            search={search}
            placeholder={t('Bridge connection entity (optional)')}
            ariaLabel={t('Bridge connection entity')}
            clearable
          />
        </Stack>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title={t('Remove «{name}»?', { name: v.name })}
        consequences={[
          t('Its devices stay in their rooms, but restarts of this bridge are no longer noticed.'),
          t('{product} will not add it back by itself when the bridge announces itself again; to bring it back, add an instance with the base topic «{topic}».', {
            product: brand.productName,
            topic: v.baseTopic,
          }),
        ]}
        confirm={{ label: t('Remove'), tone: 'danger', loading: remove.pending, onClick: () => editing && void remove.run(editing) }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

export function Z2mSection({ instances, onChanged, canEdit }: { instances: readonly Z2mInstanceDto[]; onChanged: () => void; canEdit: boolean }) {
  const [dialog, setDialog] = useState<{ id: Id | null; initial: Z2mInstanceCreateRequest } | null>(null);
  const resync = useMutation((id: Id) => api.z2m.resync(id), { okToast: t('Sending every target again…') });
  const patchAll = useMutation(
    async (resendOnRestart: boolean) => {
      for (const i of instances) if (i.config.resendOnRestart !== resendOnRestart) await api.z2m.patch(i.config.id, { resendOnRestart });
    },
    { onSuccess: onChanged, onError: onChanged },
  );
  const allResend = instances.length > 0 && instances.every((i) => i.config.resendOnRestart);

  return (
    <Section title={t('Zigbee2MQTT')} level={2}>
      <Stack gap="sm">
        {instances.length ? (
          instances.map((i) => (
            <Stack key={i.config.id} gap="3xs">
              <InstanceRow
                name={i.config.name}
                topic={i.config.baseTopic}
                count={[t('{count} devices', { count: i.deviceCount }), i.lastRestartAt ? t('restarted {time}', { time: fmtClock(i.lastRestartAt) }) : ''].filter(Boolean).join(' · ')}
                status={statusOf(i)}
              />
              <Row gap="lg" wrap>
                <Button variant="link" size="sm" onClick={() => void resync.run(i.config.id)}>
                  {t('Send all targets again')}
                </Button>
                {i.config.frontendUrl ? (
                  <Button variant="link" size="sm" iconRight="external" onClick={() => openExternal(i.config.frontendUrl as string)}>
                    {t('Open')}
                  </Button>
                ) : null}
                {canEdit ? (
                  <Button variant="link" size="sm" onClick={() => setDialog({ id: i.config.id, initial: { ...i.config } })}>
                    {t('Change')}
                  </Button>
                ) : null}
              </Row>
            </Stack>
          ))
        ) : (
          <EmptyState icon="zigbee" title={t('No Zigbee2MQTT instances')} text={t('Radiator valves and sensors paired through Zigbee2MQTT appear once an instance is added.')} />
        )}
        <CheckboxRow
          checked={allResend}
          title={t('After an instance restarts — send every target again')}
          hint={t('And read back the relays of sources and pumps.')}
          disabled={!canEdit || !instances.length || patchAll.pending}
          onChange={(on) => void patchAll.run(on)}
        />
        {canEdit ? <DashedAddButton label={t('Add an instance')} onClick={() => setDialog({ id: null, initial: { ...BLANK, name: `Z2M #${instances.length + 1}` } })} /> : null}
      </Stack>
      {dialog ? (
        <InstanceDialog key={dialog.id ?? 'new'} open editing={dialog.id} initial={dialog.initial} onClose={() => setDialog(null)} onSaved={onChanged} />
      ) : null}
    </Section>
  );
}
