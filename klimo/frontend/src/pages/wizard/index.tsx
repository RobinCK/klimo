/**
 * Add-room wizard (`#/rooms/new`): full screen on phones, a centred panel over the previous page
 * on wide screens. Unsaved input asks before leaving.
 */
import { api } from '@api/endpoints';
import { useCodeContext, useResource } from '@data';
import { WizardShell } from '@ui';
import { navigate, paths, previousRoute, useLeaveGuard } from '@app';
import { t } from '@i18n';
import { StepControl, StepDevices, StepDone, StepName, StepReview } from './Steps';
import { useWizard } from './useWizard';

const TOTAL = 4;

export default function WizardPage(): JSX.Element {
  const w = useWizard();
  const ctx = useCodeContext();
  const profiles = useResource('names:profiles', api.profiles.list, { reloadOn: ['profile', 'profile_room'] });
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings'] });
  useLeaveGuard(w.dirty, t('Leave the wizard? The new room is not created yet.'));

  const close = () => {
    const prev = previousRoute();
    navigate(prev && prev.name !== 'wizard' ? prev.path : paths.overview());
  };
  const sorted = [...(profiles.data ?? [])].sort((a, b) => a.order - b.order);
  const titles = { 1: t('New room'), 2: t('Devices'), 3: t('How to control'), 4: t('Check'), 5: t('Done') } as const;
  const done = w.step === 5;
  const next = done
    ? { label: t('Open the room'), to: w.report ? paths.room(w.report.roomId) : paths.overview() }
    : { label: w.step === 4 ? t('Create the room') : t('Next'), onClick: w.next, loading: w.busy, disabled: w.busy };
  const back = done ? { label: t('Add another'), onClick: w.reset } : w.step > 1 ? { label: t('Back'), onClick: w.back, disabled: w.busy } : undefined;

  return (
    <WizardShell
      step={Math.min(w.step, TOTAL)}
      total={TOTAL}
      done={done}
      title={titles[w.step]}
      stepLabel={done ? t('Done') : t('Step {n} of {total}', { n: w.step, total: TOTAL })}
      onClose={close}
      back={back}
      next={next}
      revealKey={w.issueRound}
    >
      {w.step === 1 ? <StepName w={w} /> : null}
      {w.step === 2 ? <StepDevices w={w} ctx={ctx} /> : null}
      {w.step === 3 ? <StepControl w={w} profiles={sorted} defaultProfileId={settings.data?.general.defaultProfileId ?? 'home'} /> : null}
      {w.step === 4 ? <StepReview w={w} profiles={sorted} /> : null}
      {w.step === 5 ? <StepDone w={w} ctx={ctx} /> : null}
    </WizardShell>
  );
}
