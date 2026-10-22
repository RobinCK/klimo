import { useState } from 'react';
import type { ConditionNode } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { AutoGrid, Stack } from '../../shell/Layout';
import { Icon } from '../../basic/Icon';
import { SensorRow } from '../rows/SensorRow';
import { ActionRuleCard, ChannelCard, CircuitCard, RuleCard, TriggerCard } from '../rows/cards';
import { DeviceTable, EntityBindingTable, WatchTable } from '../rows/tables';
import { ConditionEditor } from '../condition/ConditionEditor';
import { CheckboxRow } from '../inputs/toggles';
import { SegmentedControl } from '../inputs/choice';
import { GALLERY_CONDITION, galleryPreview, gallerySearch } from './fixtures';
import { Group, Item, galleryStyles as s } from './parts';

/** Gallery-only meter stand-in; the real battery and signal meters live with the charts. */
function Meter({ icon, text }: { icon: 'battery' | 'signal' | 'plug'; text: string }) {
  return (
    <span className={s.meter}>
      <Icon name={icon} size={14} />
      {text}
    </span>
  );
}

function Sensors() {
  const ut = useUiText();
  const [inc, setInc] = useState({ a: true, b: true, c: false });
  return (
    <Item name="SensorRow">
      <Stack gap="xs">
        <SensorRow
          included={inc.a}
          onToggle={(v) => setInc((x) => ({ ...x, a: v }))}
          name={ut('By the sofa')}
          entityId="sensor.living_sofa_temperature"
          weightText={ut('weight {w}', { w: '1.0' })}
          valueText="19.7°"
          excluded={false}
          meta={ut('SNZB-02D · seen 4 min ago')}
          onEdit={() => undefined}
        />
        <SensorRow
          included={inc.b}
          onToggle={(v) => setInc((x) => ({ ...x, b: v }))}
          name={ut('By the window, over the radiator')}
          entityId="sensor.living_window_temperature"
          weightText={ut('weight {w}', { w: '0.5' })}
          valueText="20.9°"
          excluded
          meta={ut('Aqara · seen 12 min ago')}
          note={ut('+1.1° from the others — left out for now')}
          noteTone="warn"
        />
        <SensorRow
          included={inc.c}
          onToggle={(v) => setInc((x) => ({ ...x, c: v }))}
          name={ut('Kitchen shelf')}
          entityId="sensor.kitchen_shelf_temperature"
          valueText="—"
          excluded
          meta={ut('Aqara · offline 1 h 40 min')}
          note={ut('not in the calculation')}
          noteTone="err"
        />
      </Stack>
    </Item>
  );
}

function Cards() {
  const ut = useUiText();
  const [on, setOn] = useState<Record<string, boolean>>({ blackout: true, solar: false, econ: true, preheat: false, pres: true });
  const [rule, setRule] = useState<'rooms' | 'source' | 'both'>('rooms');
  const [runOn, setRunOn] = useState(3);
  const [bypass, setBypass] = useState(true);
  const flip = (k: string) => setOn((o) => ({ ...o, [k]: !o[k] }));
  return (
    <>
      <Item name="TriggerCard">
        <AutoGrid min={400} gap="md">
          <TriggerCard
            icon="plug"
            name={ut('Blackout')}
            kindLabel={ut('entity state')}
            live={{ text: ut('yes · no grid'), active: true, disabled: !on.blackout }}
            code="binary_sensor.grid_offline = on"
            usages={[ut('energy budget'), ut('«Save energy»')]}
            usedByLabel={ut('used by:')}
            enabled={Boolean(on.blackout)}
            onToggle={() => flip('blackout')}
            onEdit={() => undefined}
          />
          <TriggerCard
            icon="sun"
            name={ut('Sun during a blackout')}
            kindLabel={ut('Home Assistant template')}
            live={{ text: ut('unavailable'), active: false, disabled: !on.solar, unavailable: true }}
            code="{{ states('sensor.pv_power') | float(0) > 1500 }}"
            usages={[ut('«Store heat»')]}
            usedByLabel={ut('used by:')}
            enabled={Boolean(on.solar)}
            onToggle={() => flip('solar')}
          />
          <TriggerCard
            icon="snow"
            name={ut('Frost')}
            kindLabel={ut('number with a threshold')}
            live={{ text: ut('no · 4.2°'), active: false, disabled: false }}
            code={ut('outdoor < −10° · exit at −8°')}
            usages={[ut('heating chain')]}
            usedByLabel={ut('used by:')}
            enabled
            locked={ut('The heating chain needs it')}
            onToggle={() => undefined}
          />
        </AutoGrid>
      </Item>
      <Item name="RuleCard · ActionRuleCard">
        <Stack gap="sm">
          <RuleCard tag={ut('Presence')} title={ut('Nobody home for 30 min → «Away»')} text="person.ihor, person.olha" enabled={Boolean(on.pres)} onToggle={() => flip('pres')} />
          <RuleCard tag={ut('Calendar')} title={ut('An event «Vacation» → «Vacation»')} text="calendar.family" />
          <ActionRuleCard
            when={ut('Blackout')}
            action={ut('Save energy')}
            effects={[ut('targets −2° in every room'), ut('the boiler instead of the heat pump'), ut('ACs only in the Kids room')]}
            last={ut('Last time: yesterday 18:20–21:05')}
            enabled={Boolean(on.econ)}
            active
            onToggle={() => flip('econ')}
            onEdit={() => undefined}
          />
          <ActionRuleCard
            when={ut('Night tariff')}
            action={ut('Electric pre-heat')}
            effects={[ut('the study convector warms up to 21°')]}
            last={ut('Never ran')}
            enabled={Boolean(on.preheat)}
            onToggle={() => flip('preheat')}
          />
        </Stack>
      </Item>
      <Item name="CircuitCard">
        <CircuitCard
          name={ut('Radiator circuit')}
          pumpEntity="switch.radiator_pump"
          extra={ut('Zigbee relay · LQI 128')}
          chip={{ tone: 'heat', label: ut('running') }}
          ruleLabel={ut('The pump runs when')}
          rule={{
            value: rule,
            onChange: setRule,
            ariaLabel: ut('When the radiator pump runs'),
            options: [
              { value: 'rooms', label: ut('a room of the circuit asks') },
              { value: 'source', label: ut('a source runs') },
              { value: 'both', label: ut('both') },
            ],
          }}
          runOn={{
            value: runOn,
            text: ut('{n} min', { n: runOn }),
            onChange: setRunOn,
            min: 0,
            max: 30,
            step: 1,
            label: ut('Run-on after stop'),
            sub: ut('takes the remaining heat out of the circuit'),
            ariaDec: ut('Shorter run-on'),
            ariaInc: ut('Longer run-on'),
          }}
          chips={[{ label: ut('from the heat pump and the boiler'), tone: 'heat' }, { label: ut('heating only') }, { label: ut('Living room') }, { label: ut('Bedroom') }]}
          note={ut('The pump does not spin idle: with every valve closed it stops even while the source runs.')}
        />
      </Item>
      <Item name="ChannelCard">
        <AutoGrid min={300} gap="md">
          <ChannelCard
            icon="phone"
            title={ut('Home Assistant app')}
            sub={ut('native push · 2 devices')}
            status={{ tone: 'ok', label: ut('working') }}
            test={{ label: ut('Send a test'), successLabel: ut('Sent'), run: () => new Promise((r) => window.setTimeout(() => r({ ok: true }), 600)) }}
          >
            <CheckboxRow checked={bypass} title={ut('Critical — even in «Do not disturb»')} hint={ut('with an alarm sound, on iOS and Android')} onChange={setBypass} />
          </ChannelCard>
          <ChannelCard icon="send" title={ut('Telegram bot')} sub={ut('messages with action buttons')} status={{ tone: 'warn', label: ut('webhook is set') }}>
            <SegmentedControl
              value="polling"
              onChange={() => undefined}
              full
              size="xs"
              ariaLabel={ut('How the bot is connected')}
              options={[
                { value: 'polling', label: ut('Polling') },
                { value: 'webhook', label: ut('Webhook') },
              ]}
            />
          </ChannelCard>
        </AutoGrid>
      </Item>
    </>
  );
}

function Tables() {
  const ut = useUiText();
  return (
    <>
      <Item name="EntityBindingTable">
        <EntityBindingTable
          rows={[
            { role: ut('On / mode'), value: 'climate.heat_pump', mono: true, live: 'heat', status: 'ok', statusLabel: ut('online'), onPick: () => undefined },
            { role: ut('Flow temperature'), value: 'sensor.hp_flow_temperature', mono: true, live: '38.2°', status: 'ok', statusLabel: ut('online') },
            { role: ut('Power'), value: ut('optional'), mono: false, status: 'info' },
            { role: ut('Fault'), value: ut('choose an entity'), mono: false, status: 'empty', statusLabel: ut('choose'), onPick: () => undefined },
          ]}
        />
      </Item>
      <Item name="WatchTable">
        <WatchTable
          rows={[
            {
              name: ut('Outdoor temperature'),
              role: ut('weather compensation'),
              entityId: 'sensor.outdoor_temperature',
              rule: ut('unavailable > 10 min'),
              severity: { tone: 'warn', label: ut('warning') },
              status: { tone: 'ok', text: ut('online · 4.2°') },
              onClick: () => undefined,
            },
            {
              name: ut('Heat pump'),
              role: ut('source'),
              entityId: 'climate.heat_pump',
              rule: ut('unavailable > 3 min'),
              severity: { tone: 'err', label: ut('critical') },
              status: { tone: 'err', text: ut('unavailable 12 min') },
            },
          ]}
        />
      </Item>
      <Item name="DeviceTable">
        <DeviceTable
          rows={[
            {
              key: 'trv-bath',
              icon: 'radiator',
              name: ut('Bath · towel rail'),
              entityId: 'climate.bathroom_towel_trv',
              room: ut('Bath'),
              model: 'SONOFF TRVZB',
              state: { tone: 'warn', label: ut('Did not confirm 24.0° · retry 2 of 3') },
              battery: <Meter icon="battery" text="64%" />,
              signal: <Meter icon="signal" text="LQI 54" />,
              seen: { text: ut('4 min ago'), title: '22.10 19:04' },
              via: 'Z2M #2',
              problem: true,
              onClick: () => undefined,
            },
            {
              key: 'hall',
              icon: 'thermometer',
              name: ut('Hall · temperature sensor'),
              entityId: 'sensor.hall_temperature',
              room: ut('Hall'),
              model: 'SONOFF SNZB-02',
              state: { tone: 'ok', label: ut('Online') },
              battery: <Meter icon="battery" text="12%" />,
              signal: <Meter icon="signal" text="LQI 140" />,
              seen: { text: ut('1 h 40 min ago'), tone: 'warn' },
              via: 'Z2M #2',
            },
            {
              key: 'hp',
              icon: 'heatPump',
              name: ut('Heat pump'),
              entityId: 'climate.heat_pump',
              room: ut('Boiler room'),
              model: 'Daikin Altherma',
              state: { tone: 'heat', label: ut('Heating') },
              battery: <Meter icon="plug" text={ut('mains')} />,
              signal: <Meter icon="signal" text={ut('integration')} />,
              seen: { text: ut('just now') },
              via: ut('HA integration'),
            },
          ]}
        />
      </Item>
    </>
  );
}

function Conditions() {
  const ut = useUiText();
  const [node, setNode] = useState<ConditionNode>(GALLERY_CONDITION);
  return (
    <Item name="ConditionEditor">
      <ConditionEditor
        value={node}
        onChange={setNode}
        preview={galleryPreview}
        search={gallerySearch}
        triggers={[
          { id: 'blackout', name: ut('Blackout') },
          { id: 'night', name: ut('Night tariff') },
        ]}
        rooms={[
          { id: 'living', name: ut('Living room') },
          { id: 'bedroom', name: ut('Bedroom') },
        ]}
        sources={[{ id: 'hp', name: ut('Heat pump') }]}
      />
    </Item>
  );
}

export function GalleryRows() {
  const ut = useUiText();
  return (
    <Group title={ut('Domain rows')}>
      <Sensors />
      <Cards />
      <Tables />
      <Conditions />
    </Group>
  );
}
