import { api } from '@api/endpoints';
import { useMutation } from '@data';
import { Button, ConfirmDialog, Section } from '@ui';
import { navigate, paths } from '@app';
import { fmtTemp, t } from '@i18n';
import { closeDialog, openDialog, useOpenDialog } from '../dialogs';
import type { SectionProps } from './types';

/** «Видалити кімнату»: the valves go back to their own control, the Home Assistant entities go away. */
export function DangerZone({ p }: { p: SectionProps }) {
  const dialog = useOpenDialog();
  const { room } = p;
  const release = fmtTemp(room.config.trv.releaseSetpointC);
  const hasTrvs = room.emitters.some((e) => e.devices.some((d) => d.kind === 'trv'));
  const climate = room.haEntities.find((e) => e.role === 'climate')?.entityId;
  const remove = useMutation(() => api.rooms.remove(room.config.id, { releaseTrvs: true }), {
    onSuccess: () => {
      closeDialog();
      navigate(paths.overview(), { replace: true, force: true });
    },
    okToast: t('«{room}» is deleted.', { room: room.config.name }),
  });
  const consequences = [
    hasTrvs ? t('The radiator valves go back to their own mode with a target of {t}.', { t: release }) : '',
    climate ? t('{entity} and the room sensors disappear from Home Assistant.', { entity: climate }) : t('The room’s entities disappear from Home Assistant.'),
    t('The history stays in the Home Assistant recorder.'),
  ].filter(Boolean);
  const confirm = (
    <ConfirmDialog
      open={dialog === 'delete-room'}
      title={t('Delete «{room}»?', { room: room.config.name })}
      consequences={consequences}
      confirm={{ label: t('Delete «{room}»', { room: room.config.name }), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
      onCancel={closeDialog}
    />
  );
  if (p.phone) {
    return (
      <>
        <Button variant="danger" size="xl" fullWidth onClick={() => openDialog('delete-room')} disabled={!p.canEdit}>
          {t('Delete the room…')}
        </Button>
        {confirm}
      </>
    );
  }
  return (
    <Section
      accent="danger"
      title={t('Delete the room')}
      level={3}
      subtitle={
        hasTrvs ? t('The radiator valves go back to their own mode with a target of {t}.', { t: release }) : t('The room and its settings are removed.')
      }
      action={
        <Button variant="danger" onClick={() => openDialog('delete-room')} disabled={!p.canEdit}>
          {t('Delete…')}
        </Button>
      }
    >
      {confirm}
    </Section>
  );
}
