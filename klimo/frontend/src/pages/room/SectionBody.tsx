import { useCallback, useState } from 'react';
import type { RoomPatch } from '@api/model';
import { StatusBanner } from '@ui';
import { errorText, t } from '@i18n';
import type { SectionDef, SectionProps } from './sections';

/**
 * A settings section's body. A change the server refuses is undone with a toast that soon fades; the
 * reason also stays at the top of the section the change was made in, until a save there succeeds.
 */
export function SectionBody({ def, p }: { def: SectionDef; p: SectionProps }) {
  const [error, setError] = useState<string | null>(null);
  const base = p.save;
  const save = useCallback(
    async (patch: RoomPatch) => {
      try {
        const next = await base(patch);
        setError(null);
        return next;
      } catch (e) {
        setError(errorText(e) || null);
        throw e;
      }
    },
    [base],
  );
  const Body = def.Body;
  // the body keeps its place (and its state) whether or not the banner is shown; cards and accordions space their children
  return (
    <>
      {error ? (
        <StatusBanner tone="err" icon="alert" text={t('Not saved: {reason}', { reason: error })} action={{ label: t('Hide'), onClick: () => setError(null) }} />
      ) : null}
      <Body {...p} save={save} />
    </>
  );
}
