import { useState } from 'react';
import { useUiText } from '../../UiTextContext';
import { AutoGrid, Row, Stack } from '../../shell/Layout';
import { Button } from '../../basic/Button';
import { MiniTag } from '../../basic/Badges';
import { Section } from '../containers/Section';
import { Accordion } from '../containers/Accordion';
import { InlinePanel } from '../containers/InlinePanel';
import { BottomSheet, ConfirmDialog, Dialog, Drawer } from '../containers/overlays';
import { SegmentedProgress, WizardShell } from '../containers/WizardShell';
import { ToggleCard, CheckboxRow } from '../inputs/toggles';
import { TextField } from '../inputs/fields';
import { TimeStepper } from '../inputs/steppers';
import { minutesToHhmm } from '../internal/util';
import { Group, Item, galleryStyles as s } from './parts';

export function GalleryContainers() {
  const ut = useUiText();
  const [open, setOpen] = useState<Record<string, boolean>>({ temp: true });
  const [overlay, setOverlay] = useState<'dialog' | 'confirm' | 'drawer' | 'sheet' | null>(null);
  const [step, setStep] = useState(1);
  const [name, setName] = useState(ut('Bedroom'));
  const [kinds, setKinds] = useState({ trv: true, floor: false });
  const [start, setStart] = useState(6 * 60 + 30);
  const close = () => setOverlay(null);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <Group title={ut('Containers')}>
      <Item name="Section">
        <AutoGrid min={260} gap="md">
          <Section title={ut('Temperature sensors')} subtitle={ut('Median of 3 · 19.8°')} action={<Button variant="secondary" size="sm">{ut('+ Add a sensor')}</Button>}>
            <span>{ut('Card section with a header action.')}</span>
          </Section>
          <Section title={ut('Space heating')} subtitle={ut('Takes the first source whose conditions hold.')} icon="flame" accent="heat">
            <span>{ut('Accent: heat.')}</span>
          </Section>
          <Section title={ut('Space cooling')} icon="snow" accent="cool" tag={<MiniTag tone="cool">{ut('May–Sep')}</MiniTag>}>
            <span>{ut('Accent: cool.')}</span>
          </Section>
          <Section ariaLabel={ut('Delete')} accent="danger" title={ut('Delete the room')} subtitle={ut('The valves go back to their own mode at 20°.')} action={<Button variant="danger">{ut('Delete…')}</Button>} />
          <Section variant="well" accent="heat" overline={ut('HEATING')}>
            <span>{ut('Inset well with a tone overline.')}</span>
          </Section>
          <Section variant="plain" title={ut('Needs attention')} tag="3">
            <span>{ut('Plain: header and flow only.')}</span>
          </Section>
        </AutoGrid>
      </Item>

      <Item name="Accordion">
        <Stack gap="sm">
          <Accordion id="g-temp" icon="thermometer" title={ut('Temperature sensors')} summary={ut('Median of 3 · 19.8°')} open={Boolean(open.temp)} onToggle={() => toggle('temp')}>
            <CheckboxRow checked title={ut('Discard outliers > 1.5°')} hint={ut('A sensor that differs a lot is left out for a while.')} onChange={() => undefined} />
          </Accordion>
          <Accordion id="g-win" icon="windowClosed" title={ut('Windows and doors')} summary={ut('Pause heating · 2 contacts')} open={Boolean(open.win)} onToggle={() => toggle('win')}>
            <span>{ut('Window reaction settings.')}</span>
          </Accordion>
        </Stack>
      </Item>

      <Item name="InlinePanel">
        <InlinePanel
          title={ut('Change the house profile')}
          hint={ut('Nothing changes until you press «Switch».')}
          onClose={() => undefined}
          footer={
            <>
              <Button variant="secondary">{ut('Cancel')}</Button>
              <Button variant="primary">{ut('Switch over')}</Button>
            </>
          }
        >
          <span>{ut('Panel content.')}</span>
        </InlinePanel>
        <InlinePanel title={ut('Selected block')} hint={ut('Mon–Fri · Home 20°')} emphasis>
          <Row gap="md" wrap>
            <TimeStepper value={start} text={minutesToHhmm(start)} onChange={setStart} min={0} max={1410} label={ut('Start')} ariaEarlier={ut('30 min earlier')} ariaLater={ut('30 min later')} />
          </Row>
        </InlinePanel>
      </Item>

      <Item name="Dialog · ConfirmDialog · Drawer · BottomSheet">
        <Row gap="sm" wrap>
          <Button variant="secondary" onClick={() => setOverlay('dialog')}>
            Dialog
          </Button>
          <Button variant="secondary" onClick={() => setOverlay('confirm')}>
            ConfirmDialog
          </Button>
          <Button variant="secondary" onClick={() => setOverlay('drawer')}>
            Drawer
          </Button>
          <Button variant="secondary" onClick={() => setOverlay('sheet')}>
            BottomSheet
          </Button>
        </Row>
        <Dialog
          open={overlay === 'dialog'}
          onClose={close}
          title={ut('Target for «Home»')}
          actions={[
            { label: ut('Cancel'), onClick: close },
            { label: ut('Save'), onClick: close },
          ]}
        >
          <TextField label={ut('Name')} value={name} onChange={setName} autoFocus />
        </Dialog>
        <ConfirmDialog
          open={overlay === 'confirm'}
          title={ut('Delete the room «Bedroom»?')}
          body={ut('The room disappears from schedules and Home Assistant.')}
          consequences={[ut('The valves go back to their own mode at 20°.'), ut('Its history stays in Home Assistant.')]}
          confirm={{ label: ut('Delete'), tone: 'danger', onClick: close }}
          onCancel={close}
        />
        <Drawer
          open={overlay === 'drawer'}
          onClose={close}
          title={ut('Trigger «Blackout»')}
          footer={
            <>
              <Button variant="secondary" onClick={close}>
                {ut('Cancel')}
              </Button>
              <Button variant="primary" onClick={close}>
                {ut('Save')}
              </Button>
            </>
          }
        >
          <TextField label={ut('Name')} value={name} onChange={setName} />
        </Drawer>
        <BottomSheet
          open={overlay === 'sheet'}
          onClose={close}
          title={ut('Home · 06:30–08:30')}
          subtitle={ut('Monday')}
          footer={
            <>
              <Button variant="outline" onClick={close}>
                {ut('Delete')}
              </Button>
              <Button variant="primary" size="xl" onClick={close}>
                {ut('Done')}
              </Button>
            </>
          }
        >
          <TimeStepper value={start} text={minutesToHhmm(start)} onChange={setStart} min={0} max={1410} label={ut('Start')} ariaEarlier={ut('30 min earlier')} ariaLater={ut('30 min later')} variant="tile" />
        </BottomSheet>
      </Item>

      <Item name="WizardShell · SegmentedProgress">
        <SegmentedProgress value={2} total={4} label={ut('Step 2 of 4')} />
        <div className={s.frame}>
          <WizardShell
            step={step}
            total={4}
            title={step === 1 ? ut('New room') : ut('Devices')}
            stepLabel={ut('Step {n} of {total}', { n: step, total: 4 })}
            onClose={() => setStep(1)}
            back={step > 1 ? { label: ut('Back'), onClick: () => setStep((n) => n - 1) } : undefined}
            next={{ label: step < 4 ? ut('Next') : ut('Create the room'), onClick: () => setStep((n) => Math.min(4, n + 1)) }}
          >
            <TextField label={ut('Name')} value={name} onChange={setName} size="xl" />
            <ToggleCard pressed={kinds.trv} icon="radiator" title={ut('Radiators with valves')} hint={ut('Zigbee thermostatic heads')} onToggle={() => setKinds((k) => ({ ...k, trv: !k.trv }))} />
            <ToggleCard pressed={kinds.floor} icon="floor" title={ut('Floor heating')} hint={ut('a circuit with a pump')} onToggle={() => setKinds((k) => ({ ...k, floor: !k.floor }))} />
          </WizardShell>
        </div>
      </Item>
    </Group>
  );
}
