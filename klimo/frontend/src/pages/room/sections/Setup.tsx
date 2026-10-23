import { useEffect } from 'react';
import { Button, Row, Stack } from '@ui';
import { brand } from '@brand';
import { heatingKindWords, t } from '@i18n';
import { openDialog } from '../dialogs';
import { RoomDevices } from '../edit/Devices';
import { HeatingKinds } from '../edit/Heating';
import { NameArea } from '../edit/NameArea';
import { useCircuits, useEditState, useRoomWrite } from '../edit/shared';
import type { SectionDef, SectionProps } from './types';

/** Everything the add-room wizard set up, editable afterwards: the name and area, what heats the room, its devices. */
function Body(p: SectionProps) {
  const edit = useEditState();
  const write = useRoomWrite(p);
  const circuits = useCircuits();
  const kinds = p.room.heating.kinds;
  const { pending, setPending } = edit;
  // a kind waiting for its first device is on once the device is in
  useEffect(() => {
    if (pending && kinds.includes(pending)) setPending(null);
  }, [pending, kinds, setPending]);
  return (
    <Stack gap="xl">
      <NameArea p={p} />
      <HeatingKinds p={p} edit={edit} circuits={circuits} write={write} />
      <RoomDevices p={p} edit={edit} write={write} />
      {p.canEdit ? (
        <Row>
          <Button variant="ghost" icon="trash" onClick={() => openDialog('delete-room')}>
            {t('Delete the room…')}
          </Button>
        </Row>
      ) : null}
    </Stack>
  );
}

function summary(p: SectionProps): string {
  const kinds = p.room.heating.kinds.map((k) => heatingKindWords(k, brand.productName).title.toLowerCase());
  const n = p.room.heating.bindings.length;
  return [t('{count} devices', { count: n }), ...kinds].join(' · ');
}

export const setupSection: SectionDef = {
  key: 'setup',
  icon: 'pencil',
  title: () => t('Room and devices'),
  subtitle: () => t('Name and area, what heats the room and every device — add, replace or remove.'),
  summary,
  Body,
};
