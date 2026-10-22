import { useState } from 'react';
import { useUiText } from '../../UiTextContext';
import { AutoGrid, Row, Stack } from '../../shell/Layout';
import { IconButton } from '../../basic/IconButton';
import { ToneBadge } from '../../basic/Badges';
import { CapabilityChip, CodeBlock, EntityId, KeyValueList, LegendSwatch, NumberedList, RelativeTime } from '../display/text';
import { BigReadout, ConsequencePreview, ExplainCallout, StatTile } from '../display/tiles';
import { NotificationBell, SeasonPill } from '../display/chrome';
import { DataTable } from '../display/DataTable';
import { RoutingMatrix, type MatrixCell } from '../display/RoutingMatrix';
import { Group, Item } from './parts';

function Matrix() {
  const ut = useUiText();
  const [cells, setCells] = useState<Record<string, MatrixCell[]>>({
    hp_fault: ['locked', 'on', 'on', 'on'],
    frost: ['locked', 'on', 'on', 'off'],
    offline: ['on', 'off', 'on', 'off'],
    window: ['off', 'off', 'off', 'on'],
    report: ['off', 'on', 'off', 'off'],
  });
  const columns = [
    { id: 'phone', label: ut('Phone'), icon: 'phone' as const },
    { id: 'tablet', label: ut('Tablet'), icon: 'tablet' as const },
    { id: 'telegram', label: 'Telegram', icon: 'send' as const },
    { id: 'ha', label: ut('In Home Assistant'), icon: 'bell' as const },
  ];
  const toggle = (rowId: string, colId: string) => {
    const c = columns.findIndex((x) => x.id === colId);
    setCells((all) => ({ ...all, [rowId]: all[rowId].map((v, i) => (i === c && v !== 'locked' ? (v === 'on' ? 'off' : 'on') : v)) }));
  };
  return (
    <RoutingMatrix
      columns={columns}
      onToggle={toggle}
      groups={[
        {
          key: 'crit',
          title: ut('Critical'),
          dotTone: 'err',
          sub: ut('· through «Do not disturb»'),
          rows: [
            { id: 'hp_fault', title: ut('A source failed'), sub: ut('heat pump, boiler, AC'), cells: cells.hp_fault },
            { id: 'frost', title: ut('Frost risk'), cells: cells.frost },
          ],
        },
        {
          key: 'warn',
          title: ut('Warnings'),
          dotTone: 'warn',
          rows: [
            { id: 'offline', title: ut('A device is offline'), sub: ut('longer than 90 min'), cells: cells.offline },
            { id: 'window', title: ut('A window is open too long'), cells: cells.window },
          ],
        },
        { key: 'info', title: ut('Reports'), dotTone: 'event', rows: [{ id: 'report', title: ut('Daily report'), cells: cells.report }] },
      ]}
    />
  );
}

export function GalleryDisplay() {
  const ut = useUiText();
  return (
    <Group title={ut('Data display')}>
      <Item name="StatTile">
        <AutoGrid min={236} gap="md">
          <StatTile
            title={ut('Sources')}
            icon="heatPump"
            dot={{ tone: 'heat', glow: true }}
            value={ut('Heat pump')}
            sub={ut('heating since 19:04 · flow 38°')}
            others={ut('boiler is the reserve')}
            to="/system/sources"
            footer={<ToneBadge tone="heat">{ut('2 h 44 min today')}</ToneBadge>}
          />
          <StatTile title={ut('Outdoors')} icon="thermometer" value="4.2°" sub={ut('min −1.5° at night')} footer={<ToneBadge tone="heat">{ut('heating season')}</ToneBadge>} />
          <StatTile variant="summary" emphasis="warn" title={ut('Need attention')} value="3" sub={ut('signal, confirmation, battery')} />
          <StatTile variant="summary" title={ut('Weakest signal')} value="LQI 54" sub={ut('Bath · towel rail')} />
        </AutoGrid>
        <AutoGrid min={150} gap="sm">
          <StatTile variant="well" title={ut('Heated today')} value={ut('1 h 49 min')} />
          <StatTile variant="well" title={ut('Minimum')} value={ut('18.6° at 16:00')} />
          <StatTile variant="well" title={ut('Warm-up rate')} value={ut('≈ {n}°/h', { n: 0.9 })} />
        </AutoGrid>
      </Item>

      <Item name="BigReadout · ExplainCallout · ConsequencePreview">
        <BigReadout caption={ut('Now · median of 3')} value="19.8°" aside={<span>{ut('Target 20.0° · Home until 23:00')}</span>} />
        <ExplainCallout title={ut('Heating: 19.6° is 0.4° below the target')} text={ut('The heat pump runs for the Living room and the Kids room.')} eta={ut('Reaches 20.2° at about 19:40')} />
        <Stack gap="sm">
          <ConsequencePreview tone="heat" icon="flame" main={ut('3 rooms will start heating')} chips={[ut('Living room'), ut('Kids room'), ut('Bath')]} />
          <ConsequencePreview tone="cool" icon="snow" main={ut('The ACs will cool 2 rooms')} />
          <ConsequencePreview tone="hold" icon="checkCircle" main={ut('Nothing changes — the targets are the same')} />
          <ConsequencePreview tone="warn" icon="windowOpen" main={ut('Bedroom stays paused: the window is open')} />
        </Stack>
      </Item>

      <Item name="KeyValueList · EntityId · RelativeTime · CapabilityChip">
        <KeyValueList
          rows={[
            { key: ut('Room climate'), value: <EntityId id="climate.klimo_living" copyable /> },
            { key: ut('Temperature'), value: 'sensor.klimo_living_temperature', mono: true },
            { key: ut('Profile'), value: ut('Home'), action: { label: ut('Change'), onClick: () => undefined } },
          ]}
        />
        <KeyValueList
          variant="stacked"
          rows={[
            { key: ut('Name'), value: ut('Bedroom'), action: { label: ut('Change'), onClick: () => undefined } },
            { key: ut('Heats with'), value: ut('2 radiator valves'), action: { label: ut('Change'), onClick: () => undefined } },
          ]}
        />
        <Row gap="md" wrap>
          <RelativeTime text={ut('4 min ago')} title="22.10 19:04" />
          <RelativeTime text={ut('1 h 40 min ago')} title="22.10 17:28" tone="warn" />
          <RelativeTime text={ut('3 days ago')} title="19.10 09:12" tone="err" />
          <CapabilityChip on label={ut('external sensor')} />
          <CapabilityChip on={false} label={ut('child lock')} />
        </Row>
      </Item>

      <Item name="CodeBlock · NumberedList · LegendSwatch">
        <CodeBlock code={'event_type: klimo_event\ndata:\n  kind: sensor_offline\n  severity: warning\n  room: kitchen'} ariaLabel={ut('Event example')} />
        <CodeBlock wrap code="{{ states('sensor.pv_power') | float(0) > 1500 and is_state('binary_sensor.grid_offline', 'on') }}" />
        <NumberedList items={[ut('Heat pump is the main source: 4.2° outdoors, above the bivalence point −10°.'), ut('Radiator pump runs for the Living room and the Kids room.')]} />
        <Row gap="md" wrap>
          <LegendSwatch tone="heat" label={ut('heat pump heats')} />
          <LegendSwatch tone="cool" label={ut('ACs cool')} />
          <LegendSwatch variant="band" label={ut('target ± tolerance')} />
          <LegendSwatch variant="dashed" color="var(--ui-text-2)" label={ut('planned by the schedule')} />
          <LegendSwatch variant="runon" color="var(--ui-control-off)" label={ut('pump run-on')} />
          <LegendSwatch variant="line" label={ut('temperature')} />
          <LegendSwatch color="var(--ui-profile-1)" label={ut('Home')} />
        </Row>
      </Item>

      <Item name="SeasonPill · NotificationBell">
        <Row gap="md" wrap>
          <SeasonPill tone="heat" label={ut('Auto · heating')} variant="outline" to="/system" />
          <SeasonPill tone="cool" label={ut('Auto · cooling')} variant="filled" to="/system" />
          <SeasonPill tone="off" label={ut('Off')} variant="outline" to="/system" />
          <NotificationBell count={2} to="/notifications" label={ut('Notifications, 2 new')} />
          <NotificationBell count={0} to="/notifications" label={ut('Notifications')} />
        </Row>
      </Item>

      <Item name="DataTable">
        <DataTable
          ariaLabel={ut('Targets by profile')}
          minWidth={480}
          columns={[
            { key: 'p', label: ut('Profile'), width: 'minmax(130px, 1.3fr)' },
            { key: 'h', label: ut('Heat target'), width: '84px' },
            { key: 'c', label: ut('Cool target'), width: '104px' },
            { key: 'src', label: ut('From'), width: 'minmax(120px, 1fr)' },
            { key: 'a', label: ut('Action'), width: '44px', hideLabel: true, align: 'end' },
          ]}
          rows={[
            {
              key: 'home',
              cells: {
                p: ut('Home'),
                h: '20.0°',
                c: '26.0°',
                src: ut('as the profile'),
                a: <IconButton icon="pencil" label={ut('Change')} size={40} variant="surface" />,
              },
            },
            { key: 'night', tone: 'warn', cells: { p: ut('Night'), h: '18.0°', c: '27.0°', src: ut('own target'), a: null } },
          ]}
        />
      </Item>

      <Item name="RoutingMatrix">
        <Matrix />
      </Item>
    </Group>
  );
}
