import { useEffect, useState } from 'react';
import type { SyncPhase } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { AutoGrid, Row, Stack } from '../../shell/Layout';
import { Button } from '../../basic/Button';
import { toast, undoToast } from '../feedback/toast';
import { CountdownBar, PendingChangePanel, SyncIndicator, UndoBar } from '../feedback/edit';
import { AutosaveStatus, EmptyState, InlineConfirm, Skeleton, StateBanner, StatusBanner } from '../feedback/status';
import { AlertCard, AttentionBanner, InboxCard } from '../feedback/alerts';
import { Group, Item } from './parts';

const SEND_S = 3;
const UNDO_S = 8;

/** The pending → applied flow of a target change, looping so both panels can be seen. */
function EditFlow() {
  const ut = useUiText();
  const [phase, setPhase] = useState<'pending' | 'applied'>('pending');
  const [left, setLeft] = useState(SEND_S);
  const [frozen, setFrozen] = useState(false);
  const [dur, setDur] = useState('slot');
  const [sync, setSync] = useState<SyncPhase>('sending');

  useEffect(() => {
    if (frozen) return undefined;
    const t = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => window.clearInterval(t);
  }, [frozen, phase]);

  useEffect(() => {
    if (left > 0) return;
    if (phase === 'pending') {
      setPhase('applied');
      setSync('sending');
      setLeft(UNDO_S);
    } else {
      setPhase('pending');
      setLeft(SEND_S);
    }
  }, [left, phase]);

  useEffect(() => {
    if (phase !== 'applied') return undefined;
    const a = window.setTimeout(() => setSync('partial'), 1200);
    const b = window.setTimeout(() => setSync('done'), 3200);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [phase]);

  const syncText: Record<SyncPhase, string> = {
    idle: ut('nothing to send'),
    sending: ut('sending to 2 valves…'),
    partial: ut('1 of 2 confirmed…'),
    retry: ut('no answer · retry 2/3'),
    done: ut('both confirmed'),
    failed: ut('a valve did not confirm'),
  };

  return phase === 'pending' ? (
    <PendingChangePanel
      consequence={{ tone: 'heat', icon: 'flame', text: ut('Will start heating · ≈ 25 min, until 19:40') }}
      duration={{
        value: dur,
        options: [
          { value: 'slot', label: ut('Until 23:00') },
          { value: '1h', label: ut('1 hour') },
          { value: '3h', label: ut('3 hours') },
          { value: 'forever', label: ut('Permanently, into the profile') },
        ],
        onChange: setDur,
        onFocusChange: setFrozen,
      }}
      countdown={{ remaining: left, total: SEND_S, text: frozen ? ut('Paused while you choose') : ut('Sending 20.5° to 2 valves in {n} s', { n: left }), frozen }}
      onCancel={() => setLeft(SEND_S)}
      cancelLabel={ut('Cancel')}
      editingLabel={ut('New target · not sent yet')}
    />
  ) : (
    <UndoBar text={ut('Target 20.5° until 23:00')} sync={{ phase: sync, text: syncText[sync] }} remaining={left} undoLabel={ut('Undo')} onUndo={() => setLeft(0)} />
  );
}

export function GalleryFeedback() {
  const ut = useUiText();
  const [confirm, setConfirm] = useState(true);
  return (
    <Group title={ut('Feedback')}>
      <Item name="toast · undoToast">
        <Row gap="sm" wrap>
          <Button variant="secondary" size="sm" onClick={() => toast({ tone: 'ok', message: ut('Saved') })}>
            ok
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast({ tone: 'warn', message: ut('The valve did not confirm yet') })}>
            warn
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast({ tone: 'err', message: ut('Not saved: the value must be between 0.1 and 1'), action: { label: ut('Retry'), onClick: () => undefined } })}
          >
            err
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast({ tone: 'info', message: ut('Profile «Home» until 23:00') })}>
            info
          </Button>
          <Button variant="secondary" size="sm" onClick={() => undoToast({ message: ut('The house switched to «Eco»'), onUndo: () => undefined, seconds: 8 })}>
            undoToast
          </Button>
        </Row>
      </Item>

      <Item name="PendingChangePanel · UndoBar · SyncIndicator · CountdownBar">
        <EditFlow />
        <Row gap="lg" wrap>
          <SyncIndicator phase="sending" text={ut('sending to 2 valves…')} />
          <SyncIndicator phase="partial" text={ut('1 of 2 confirmed…')} />
          <SyncIndicator phase="done" text={ut('both confirmed')} />
          <SyncIndicator phase="failed" text={ut('a valve did not confirm')} />
        </Row>
        <CountdownBar remaining={2} total={3} />
        <CountdownBar remaining={3} total={3} frozen />
      </Item>

      <Item name="InlineConfirm · AutosaveStatus">
        {confirm ? (
          <InlineConfirm
            title={ut('Switch the house off?')}
            text={ut('Heating and cooling stop everywhere. Frost protection stays on.')}
            confirm={{ label: ut('Switch off'), onClick: () => setConfirm(false) }}
            cancel={{ label: ut('Cancel'), onClick: () => setConfirm(false) }}
          />
        ) : (
          <Button variant="link" onClick={() => setConfirm(true)}>
            {ut('Show again')}
          </Button>
        )}
        <Row gap="lg" wrap>
          <AutosaveStatus state="saving" />
          <AutosaveStatus state="saved" />
          <AutosaveStatus state="error" retry={() => undefined} />
        </Row>
      </Item>

      <Item name="StatusBanner · StateBanner">
        <Stack gap="sm">
          <StatusBanner tone="ok" text={ut('6 devices found in the area «Bedroom» · Zigbee2MQTT')} />
          <StatusBanner tone="warn" icon="offline" text={ut('No live connection · updated 4 min ago')} />
          <StatusBanner tone="err" text={ut('Not connected to Home Assistant')} action={{ label: ut('Settings'), onClick: () => undefined }} />
          <StatusBanner tone="event" icon="sparkle" text={ut('Simulator — a virtual house; nothing real is switched.')} />
          <StateBanner tone="heat" label={ut('Heating')} detail={ut('since 19:04 · flow 38° · COP 3.1')} />
          <StateBanner tone="wait" label={ut('Waiting for a trigger')} detail={ut('«Night tariff» from 23:00')} />
          <StateBanner tone="off" label={ut('Off for the summer')} />
        </Stack>
      </Item>

      <Item name="EmptyState · Skeleton">
        <AutoGrid min={260} gap="md">
          <EmptyState icon="checkCircle" tone="ok" title={ut('All good')} text={ut('No warnings right now.')} />
          <EmptyState icon="radiator" title={ut('No sources yet')} text={ut('Add the boiler or heat pump that heats the house.')} action={{ label: ut('Add a source'), onClick: () => undefined }} />
          <Stack gap="sm">
            <Skeleton height={22} width="60%" />
            <Skeleton height={64} />
            <Skeleton height={64} />
          </Stack>
        </AutoGrid>
      </Item>

      <Item name="AttentionBanner · AlertCard · InboxCard">
        <AttentionBanner title={ut('5 need attention')} summary={ut('Bedroom: window open 12 min · Kids room: humidity 67%')} to="/" />
        <AutoGrid min={300} gap="sm">
          <AlertCard
            tone="warn"
            icon="windowOpen"
            title={ut('Bedroom: window open 12 min')}
            text={ut('Heating is paused; it resumes 2 min after the window closes.')}
            primary={{ label: ut('Open the room'), to: '/rooms/bedroom' }}
            secondary={{ label: ut('Hide for 30 min'), onClick: () => undefined }}
          />
          <AlertCard
            tone="err"
            icon="offline"
            title={ut('Kitchen: shelf sensor offline')}
            text={ut('The other two sensors keep the median — heating works as it should.')}
            primary={{ label: ut('Devices'), to: '/devices' }}
            secondary={{ label: ut('Hide'), onClick: () => undefined }}
          />
          <InboxCard
            time="19:04"
            tone="err"
            icon="heatPump"
            title={ut('Heat pump not responding')}
            text={ut('Heating moved to the gas boiler — the rooms stay warm.')}
            actions={[
              { label: ut('I see'), onClick: () => undefined },
              { label: ut('Open'), to: '/system' },
            ]}
          />
          <InboxCard time={ut('yesterday')} tone="warn" icon="battery" title={ut('Hall sensor battery 12%')} text={ut('About two weeks left.')} actions={[]} resolved={ut('Reminder set for 5%')} />
        </AutoGrid>
      </Item>
    </Group>
  );
}
