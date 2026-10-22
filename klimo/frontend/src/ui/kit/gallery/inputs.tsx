import { useState } from 'react';
import type { IconName } from '../../types';
import { useUiText } from '../../UiTextContext';
import { AutoGrid, Row, Stack } from '../../shell/Layout';
import { IconTile } from '../../basic/Icon';
import { StatusDot } from '../../basic/Badges';
import { DurationPills, FilterPills, SegmentedControl } from '../inputs/choice';
import { RadioCardGrid, RadioCardList, RadioValueGrid } from '../inputs/radios';
import { CheckboxRow, ToggleCard, ToggleChip } from '../inputs/toggles';
import { AreaSelect, DateField, NumberField, Select, TextField, TimeRangeInput } from '../inputs/fields';
import { Stepper, TimeStepper } from '../inputs/steppers';
import { ValuePill } from '../inputs/ValuePill';
import { EntityMultiPicker, EntityPicker } from '../inputs/EntityPicker';
import { ColorSwatchPicker, DayOfWeekToggle, DayTabs, IconPicker, MonthToggleGrid } from '../inputs/pickers';
import { SortableList } from '../inputs/SortableList';
import { DashedAddButton, FileButton, QuickActionPill, TestButton } from '../inputs/actions';
import { minutesToHhmm } from '../internal/util';
import { GALLERY_PALETTE, gallerySearch } from './fixtures';
import { Group, Item } from './parts';

const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}°`;

function Choices() {
  const ut = useUiText();
  const [mode, setMode] = useState<'auto' | 'heat' | 'cool' | 'off'>('auto');
  const [tol, setTol] = useState<'heat' | 'cool'>('heat');
  const [room, setRoom] = useState<'inherit' | 'own' | 'off'>('inherit');
  const [filter, setFilter] = useState('all');
  const [dur, setDur] = useState('slot');
  const [strategy, setStrategy] = useState('external');
  const [method, setMethod] = useState('median');
  const [profile, setProfile] = useState('home');
  return (
    <>
      <Item name="SegmentedControl">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          pending="off"
          ariaLabel={ut('House mode')}
          hint={ut('«Off» waits for confirmation (dashed).')}
          options={[
            { value: 'auto', label: ut('Auto'), icon: 'sync' },
            { value: 'heat', label: ut('Heating only') },
            { value: 'cool', label: ut('Cooling only') },
            { value: 'off', label: ut('Off') },
          ]}
        />
        <SegmentedControl
          value={tol}
          onChange={setTol}
          full
          size="md"
          ariaLabel={ut('Tolerance for')}
          options={[
            { value: 'heat', label: ut('heating') },
            { value: 'cool', label: ut('cooling') },
          ]}
        />
        <SegmentedControl
          value={room}
          onChange={setRoom}
          size="xs"
          ariaLabel={ut('Living room in this profile')}
          options={[
            { value: 'inherit', label: ut('as the profile') },
            { value: 'own', label: ut('own target') },
            { value: 'off', label: ut('off'), disabled: true },
          ]}
        />
      </Item>
      <Item name="FilterPills">
        <FilterPills
          value={filter}
          onChange={setFilter}
          surface="page"
          ariaLabel={ut('Room filter')}
          options={[
            { value: 'all', label: ut('All'), count: 7 },
            { value: 'heating', label: ut('Heating'), count: 3 },
            { value: 'attention', label: ut('Attention'), count: 2 },
          ]}
        />
      </Item>
      <Item name="DurationPills">
        <DurationPills
          value={dur}
          onChange={setDur}
          options={[
            { value: 'slot', label: ut('Until 23:00'), hint: ut('then the schedule') },
            { value: '1h', label: ut('1 hour'), hint: ut('until 20:10') },
            { value: '3h', label: ut('3 hours'), hint: ut('until 22:10') },
            { value: 'forever', label: ut('Permanently'), hint: ut('until changed') },
          ]}
        />
      </Item>
      <Item name="RadioCardList">
        <RadioCardList
          value={strategy}
          onChange={setStrategy}
          ariaLabel={ut('How the valves are controlled')}
          options={[
            { value: 'external', title: ut('Room temperature into the valve'), hint: ut('The valve regulates by the room sensors.'), tech: 'external_temperature_input', badge: ut('recommended') },
            { value: 'offset', title: ut('Calibration offset'), hint: ut('Shifts the valve’s own sensor.'), tech: 'local_temperature_calibration' },
            { value: 'setpoint', title: ut('Target only'), hint: ut('Opens and closes the valve by the target.') },
            { value: 'valve', title: ut('Valve position'), disabled: true, disabledReason: ut('This valve does not report its position') },
          ]}
        />
        <RadioCardList
          compact
          value={strategy}
          onChange={setStrategy}
          ariaLabel={ut('Window open')}
          options={[
            { value: 'external', title: ut('Pause heating') },
            { value: 'offset', title: ut('Lower to frost protection') },
            { value: 'setpoint', title: ut('Do nothing') },
          ]}
        />
      </Item>
      <Item name="RadioValueGrid">
        <RadioValueGrid
          value={method}
          onChange={setMethod}
          ariaLabel={ut('Current temperature is')}
          hint={ut('Median: one odd sensor does not move the result.')}
          options={[
            { value: 'median', label: ut('Median'), valueText: '19.8°' },
            { value: 'average', label: ut('Average'), valueText: '20.1°' },
            { value: 'weighted', label: ut('Weighted'), valueText: '19.9°' },
            { value: 'min', label: ut('Coldest'), valueText: '19.7°' },
            { value: 'max', label: ut('Warmest'), valueText: '20.9°' },
            { value: 'primary', label: ut('Primary'), valueText: '19.7°' },
          ]}
        />
      </Item>
      <Item name="RadioCardGrid">
        <RadioCardGrid
          value={profile}
          onChange={setProfile}
          minWidth={190}
          ariaLabel={ut('Profile')}
          options={(
            [
              ['home', ut('Home'), 'home', 0, ut('now')],
              ['away', ut('Away'), 'away', 1, undefined],
              ['eco', ut('Eco'), 'leaf', 2, undefined],
              ['night', ut('Night'), 'moon', 3, undefined],
            ] as [string, string, IconName, number, string | undefined][]
          ).map(([value, title, icon, i, badge]) => ({
            value,
            title,
            badge,
            leading: <IconTile icon={icon} size={28} color={{ bg: GALLERY_PALETTE[i].color, fg: GALLERY_PALETTE[i].ink }} />,
            lines: [ut('20° · cooling 26°'), ut('3 rooms change')],
          }))}
        />
      </Item>
    </>
  );
}

function Toggles() {
  const ut = useUiText();
  const [on, setOn] = useState<Record<string, boolean>>({ trv: true, heat: true, dry: false, a: true, b: false, c: true });
  const flip = (k: string) => setOn((o) => ({ ...o, [k]: !o[k] }));
  const [minutes, setMinutes] = useState('90');
  const [grace, setGrace] = useState(5);
  const [quiet, setQuiet] = useState({ from: '23:00', to: '07:00' });
  return (
    <>
      <Item name="ToggleCard · ToggleChip">
        <AutoGrid min={260} gap="sm">
          <ToggleCard pressed={Boolean(on.trv)} icon="radiator" title={ut('Radiators with valves')} hint={ut('Zigbee thermostatic heads')} onToggle={() => flip('trv')} />
          <ToggleCard pressed={Boolean(on.floor)} icon="floor" title={ut('Floor heating')} hint={ut('a circuit with a pump')} onToggle={() => flip('floor')} />
        </AutoGrid>
        <Row gap="xs" wrap>
          <ToggleChip pressed={Boolean(on.heat)} icon="flame" label={ut('Heats')} accent="heat" onToggle={() => flip('heat')} />
          <ToggleChip pressed={Boolean(on.cool)} icon="snow" label={ut('Cools')} accent="cool" onToggle={() => flip('cool')} />
          <ToggleChip pressed={Boolean(on.dry)} icon="droplet" label={ut('Dries')} onToggle={() => flip('dry')} />
        </Row>
      </Item>
      <Item name="CheckboxRow">
        <Stack gap="sm">
          <CheckboxRow checked={Boolean(on.a)} title={ut('Discard outliers')} hint={ut('A sensor that differs from the others by more than 1.5° is left out for a while.')} onChange={() => flip('a')} />
          <CheckboxRow
            variant="well"
            checked={Boolean(on.b)}
            title={ut('Quiet hours')}
            hint={ut('Warnings wait until the morning; critical alerts still arrive.')}
            trailing={<ValuePill text={`${quiet.from}–${quiet.to}`} editor={{ kind: 'time_range' }} value={quiet} onChange={setQuiet} ariaLabel={ut('Quiet hours')} />}
            onChange={() => flip('b')}
          />
          <CheckboxRow variant="divided" checked={Boolean(on.c)} title={ut('Child lock on the valves')} onChange={() => flip('c')} />
          <CheckboxRow checked title={ut('Critical alerts')} hint={ut('frost, source failure')} locked={{ reason: ut('Always delivered to at least one phone') }} onChange={() => undefined} />
          <CheckboxRow checked={false} disabled title={ut('Dehumidifier')} hint={ut('No dehumidifier in this room')} onChange={() => undefined} />
          <div>
            <CheckboxRow variant="list" leading={<StatusDot tone="warn" size={10} />} checked={Boolean(on.a)} title={ut('Warnings')} hint={ut('window open, sensor offline')} onChange={() => flip('a')} />
            <CheckboxRow variant="list" leading={<StatusDot tone="event" size={10} />} checked={Boolean(on.b)} title={ut('Events')} hint={ut('season changed, profile switched')} onChange={() => flip('b')} />
          </div>
        </Stack>
      </Item>
      <Item name="ValuePill">
        <Row gap="sm" wrap>
          <ValuePill text={ut('90 min')} ariaLabel={ut('Unavailable without updates')} />
          <ValuePill
            text={minutes === '90' ? ut('90 min') : ut('{n} min', { n: minutes })}
            editor={{ kind: 'select', options: ['30', '60', '90', '120'].map((v) => ({ value: v, label: ut('{n} min', { n: v }) })) }}
            value={minutes}
            onChange={setMinutes}
            ariaLabel={ut('Unavailable without updates')}
          />
          <ValuePill text={ut('{n} min', { n: grace })} editor={{ kind: 'number', min: 0, max: 30, step: 1, unit: ut('min') }} value={grace} onChange={setGrace} ariaLabel={ut('Minimum request')} />
        </Row>
      </Item>
    </>
  );
}

function Numbers() {
  const ut = useUiText();
  const [target, setTarget] = useState(20.5);
  const [below, setBelow] = useState(-0.2);
  const [above, setAbove] = useState(0.2);
  const [heat, setHeat] = useState(20);
  const [biv, setBiv] = useState(-10);
  const [runOn, setRunOn] = useState(3);
  const [start, setStart] = useState(6 * 60 + 30);
  const [end, setEnd] = useState(8 * 60 + 30);
  const [range, setRange] = useState({ from: '23:00', to: '07:00' });
  return (
    <>
      <Item name="Stepper">
        <Stepper variant="round" value={target} text={`${target.toFixed(1)}°`} onChange={setTarget} min={5} max={30} step={0.5} ariaDec={ut('Lower the target by 0.5°')} ariaInc={ut('Raise the target by 0.5°')} />
        <AutoGrid min={260} gap="md">
          <Stepper variant="square" label={ut('Below the target')} sub={ut('when to start')} labelTone="heat" value={below} text={signed(below)} onChange={setBelow} min={-1} max={0} step={0.1} ariaDec={ut('Less')} ariaInc={ut('More')} />
          <Stepper variant="square" label={ut('Above the target')} sub={ut('when to stop')} labelTone="hold" value={above} text={signed(above)} onChange={setAbove} min={0} max={1} step={0.1} ariaDec={ut('Less')} ariaInc={ut('More')} />
        </AutoGrid>
        <AutoGrid min={220} gap="sm">
          <Stepper variant="big" label={ut('Heating · default target')} labelTone="heat" value={heat} text={`${heat.toFixed(1)}°`} onChange={setHeat} min={5} max={30} step={0.5} ariaDec={ut('Lower the heating target')} ariaInc={ut('Raise the heating target')} />
          <Stepper variant="tile" label={ut('Bivalence point')} sub={ut('below it the boiler joins')} value={biv} text={`${biv}°`} onChange={setBiv} min={-25} max={10} step={1} ariaDec={ut('Lower')} ariaInc={ut('Higher')} />
          <Stepper variant="tile" label={ut('Return to the heat pump')} sub={ut('fixed by the mode')} value={-8} text="−8°" onChange={() => undefined} min={-25} max={10} step={1} disabled ariaDec={ut('Lower')} ariaInc={ut('Higher')} />
        </AutoGrid>
        <Stepper variant="compact" label={ut('Run-on after stop')} sub={ut('takes the remaining heat out of the circuit')} value={runOn} text={ut('{n} min', { n: runOn })} onChange={setRunOn} min={0} max={30} step={1} ariaDec={ut('Shorter run-on')} ariaInc={ut('Longer run-on')} />
      </Item>
      <Item name="TimeStepper · TimeRangeInput">
        <Row gap="lg" wrap>
          <TimeStepper value={start} text={minutesToHhmm(start)} onChange={setStart} min={0} max={end - 30} label={ut('Start')} ariaEarlier={ut('30 min earlier')} ariaLater={ut('30 min later')} />
          <TimeStepper value={end} text={minutesToHhmm(end)} onChange={setEnd} min={start + 30} max={1440} label={ut('End')} ariaEarlier={ut('30 min earlier')} ariaLater={ut('30 min later')} />
        </Row>
        <AutoGrid min={200} gap="sm">
          <TimeStepper variant="tile" value={start} text={minutesToHhmm(start)} onChange={setStart} min={0} max={end - 30} label={ut('Start')} ariaEarlier={ut('30 min earlier')} ariaLater={ut('30 min later')} />
        </AutoGrid>
        <TimeRangeInput from={range.from} to={range.to} onChange={setRange} ariaLabel={ut('Quiet hours')} />
      </Item>
    </>
  );
}

function Fields() {
  const ut = useUiText();
  const [dur, setDur] = useState('slot');
  const [name, setName] = useState(ut('Home'));
  const [budget, setBudget] = useState<number | null>(2.5);
  const [entity, setEntity] = useState<string | null>('sensor.outdoor_temperature');
  const [many, setMany] = useState<string[]>(['sensor.living_sofa_temperature']);
  const [area, setArea] = useState<string | null>('bedroom');
  const [date, setDate] = useState('2026-12-31');
  return (
    <>
      <Item name="Select · TextField · NumberField · DateField · AreaSelect">
        <Row gap="md" wrap align="end">
          <Select
            value={dur}
            onChange={setDur}
            size="sm"
            ariaLabel={ut('How long the new value lasts')}
            options={[
              { value: 'slot', label: ut('Until 23:00') },
              { value: '1h', label: ut('1 hour') },
              { value: 'forever', label: ut('Permanently, into the profile') },
            ]}
          />
        </Row>
        <AutoGrid min={240} gap="md">
          <TextField label={ut('Profile name')} value={name} onChange={setName} size="lg" />
          <TextField label={ut('Name')} value="" onChange={() => undefined} placeholder={ut('e.g. Bedroom')} error={ut('Give the room a name')} />
          <NumberField label={ut('Budget for heat and cold')} value={budget} onChange={setBudget} min={0.5} max={10} step={0.1} unit={ut('kW')} />
          <DateField label={ut('Date')} value={date} onChange={setDate} min="2026-01-01" />
          <AreaSelect
            label={ut('Home Assistant area')}
            value={area}
            onChange={setArea}
            noneLabel={ut('No area')}
            areas={[
              { id: 'bedroom', name: ut('Bedroom'), hint: ut('6 devices found in the area — offered on the next step.') },
              { id: 'living', name: ut('Living room') },
            ]}
          />
        </AutoGrid>
      </Item>
      <Item name="EntityPicker · EntityMultiPicker">
        <AutoGrid min={280} gap="md">
          <EntityPicker value={entity} onChange={(id) => setEntity(id)} search={gallerySearch} placeholder={ut('Find a sensor…')} clearable />
          <EntityMultiPicker value={many} onChange={setMany} search={gallerySearch} placeholder={ut('Add a sensor…')} />
        </AutoGrid>
      </Item>
    </>
  );
}

function Pickers() {
  const ut = useUiText();
  const [color, setColor] = useState(GALLERY_PALETTE[0].color);
  const [icon, setIcon] = useState<IconName>('home');
  const [months, setMonths] = useState<boolean[]>([false, false, false, false, true, true, true, true, true, false, false, false]);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [day, setDay] = useState(2);
  const short = [ut('Mon'), ut('Tue'), ut('Wed'), ut('Thu'), ut('Fri'), ut('Sat'), ut('Sun')];
  const monthShort = [ut('Jan'), ut('Feb'), ut('Mar'), ut('Apr'), ut('May'), ut('Jun'), ut('Jul'), ut('Aug'), ut('Sep'), ut('Oct'), ut('Nov'), ut('Dec')];
  const monthFull = [
    ut('January'),
    ut('February'),
    ut('March'),
    ut('April'),
    ut('May'),
    ut('June'),
    ut('July'),
    ut('August'),
    ut('September'),
    ut('October'),
    ut('November'),
    ut('December'),
  ];
  const icons: { name: IconName; label: string }[] = [
    { name: 'home', label: ut('Home') },
    { name: 'away', label: ut('Away') },
    { name: 'leaf', label: ut('Eco') },
    { name: 'moon', label: ut('Night') },
    { name: 'users', label: ut('Guests') },
    { name: 'suitcase', label: ut('Vacation') },
  ];
  const first = months.indexOf(true);
  const last = months.lastIndexOf(true);
  const summary = first < 0 ? ut('never') : `${monthFull[first]} — ${monthFull[last]}`;
  return (
    <Item name="ColorSwatchPicker · IconPicker · MonthToggleGrid · DayOfWeekToggle · DayTabs">
      <ColorSwatchPicker value={color} palette={GALLERY_PALETTE.slice(0, 12)} onChange={(c) => setColor(c)} />
      <IconPicker value={icon} icons={icons} onChange={setIcon} />
      <MonthToggleGrid value={months} labels={monthShort} fullLabels={monthFull} onChange={setMonths} accent="cool" summary={summary} title={ut('When cooling is allowed')} />
      <DayOfWeekToggle value={days} labels={short} onChange={setDays} />
      <DayTabs value={day} today={2} labels={short} onChange={setDay} />
    </Item>
  );
}

function Lists() {
  const ut = useUiText();
  const [chain, setChain] = useState(['hp', 'boiler', 'convector']);
  const [prio, setPrio] = useState(['frost', 'window', 'manual', 'calendar', 'presence', 'schedule']);
  const chainItems: Record<string, { title: string; sub: string }> = {
    hp: { title: ut('Heat pump'), sub: ut('main while outdoors is above −10°') },
    boiler: { title: ut('Gas boiler'), sub: ut('below −10°, on a heat pump fault') },
    convector: { title: ut('Study convector'), sub: ut('when «Night tariff» is on') },
  };
  const prioItems: Record<string, { title: string; sub: string; locked?: boolean }> = {
    frost: { title: ut('Frost protection'), sub: ut('always first'), locked: true },
    window: { title: ut('Open window'), sub: ut('pauses the room'), locked: true },
    manual: { title: ut('Manual change'), sub: ut('until its end time') },
    calendar: { title: ut('Calendar'), sub: ut('vacation, guests') },
    presence: { title: ut('Presence'), sub: ut('nobody home → Away') },
    schedule: { title: ut('Schedule'), sub: ut('the week plan') },
  };
  return (
    <>
      <Item name="SortableList">
        <SortableList
          numbered
          ariaLabel={ut('Heating chain')}
          onReorder={setChain}
          items={chain.map((id) => ({ id, ...chainItems[id] }))}
        />
        <SortableList numbered size="sm" ariaLabel={ut('Who wins')} onReorder={setPrio} items={prio.map((id) => ({ id, ...prioItems[id] }))} />
      </Item>
      <Item name="TestButton · QuickActionPill · DashedAddButton · FileButton">
        <Row gap="sm" wrap>
          <TestButton label={ut('Send a test')} successLabel={ut('Sent ✓')} run={() => new Promise((r) => window.setTimeout(() => r({ ok: true }), 700))} />
          <TestButton label={ut('Check the token')} successLabel={ut('Token works ✓')} icon="sync" run={() => new Promise((r) => window.setTimeout(() => r({ ok: false, error: ut('Telegram answered 401: the token is wrong') }), 700))} />
        </Row>
        <Row gap="sm" wrap>
          <QuickActionPill icon="bolt" label={ut('+1° for 30 min')} onClick={() => undefined} />
          <QuickActionPill icon="airing" label={ut('Air for 10 min')} onClick={() => undefined} />
          <QuickActionPill icon="undo" label={ut('Back to the schedule')} onClick={() => undefined} />
        </Row>
        <DashedAddButton label={ut('New profile')} onClick={() => undefined} />
        <Row gap="sm" wrap>
          <FileButton label={ut('Restore from a file…')} icon="undo" accept="application/json,.json" onFile={() => undefined} />
        </Row>
      </Item>
    </>
  );
}

export function GalleryInputs() {
  const ut = useUiText();
  return (
    <Group title={ut('Inputs')}>
      <Choices />
      <Toggles />
      <Numbers />
      <Fields />
      <Pickers />
      <Lists />
    </Group>
  );
}
