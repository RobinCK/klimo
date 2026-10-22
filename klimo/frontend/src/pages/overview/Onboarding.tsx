import type { OnboardingDto } from '@api/model';
import { api } from '@api/endpoints';
import { invalidate, useMutation } from '@data';
import { Button, KeyValueList, Section } from '@ui';
import { paths } from '@app';
import { t } from '@i18n';

type Step = OnboardingDto['steps'][number]['key'];

function stepText(key: Step): { label: string; to: string } {
  switch (key) {
    case 'outdoor':
      return { label: t('Outdoor temperature sensor'), to: paths.settings() };
    case 'sources':
      return { label: t('Heat and cold sources'), to: paths.sources() };
    case 'room':
      return { label: t('The first room'), to: paths.wizard() };
    case 'notifications':
      return { label: t('Where to send alerts'), to: paths.notifications() };
    case 'cards':
      return { label: t('Cards on the Home Assistant dashboard'), to: paths.settings() };
  }
}

/** A short checklist until the house is set up; it can be put away for good. */
export function Onboarding({ onboarding, canEdit }: { onboarding: OnboardingDto; canEdit: boolean }) {
  const dismiss = useMutation(() => api.settings.patchGeneral({ onboardingDismissed: true }), {
    onSuccess: () => invalidate('overview'),
  });
  const done = onboarding.steps.filter((s) => s.done).length;
  return (
    <Section
      id="onboarding"
      icon="sparkle"
      title={t('Getting started')}
      subtitle={t('{done} of {total} done — a few steps and the house is under control.', { done, total: onboarding.steps.length })}
      action={
        canEdit ? (
          <Button variant="ghost" size="sm" onClick={() => void dismiss.run()} loading={dismiss.pending}>
            {t('Hide')}
          </Button>
        ) : undefined
      }
    >
      <KeyValueList
        rows={onboarding.steps.map((s) => {
          const { label, to } = stepText(s.key);
          return { key: label, value: s.done ? t('✓ done') : t('not yet'), action: s.done ? undefined : { label: t('Set up'), to } };
        })}
      />
    </Section>
  );
}
