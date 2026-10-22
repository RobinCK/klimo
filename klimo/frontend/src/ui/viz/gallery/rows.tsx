import { useState } from 'react';
import { useUiText } from '../../UiTextContext';
import { ActivityLog, DecisionLog, NotificationPreview } from '../../climate/rows/logs';
import { ContactRow, EmitterRow, FallbackNote, InstanceRow, ProblemCard, TargetRow, TrvCard } from '../../climate/rows/devices';
import { ChainRow, ConditionRow, ConditionTreeView, FeedRow, GuardList, SourceListItem, TypePickerCard } from '../../climate/rows/sources';
import { TREE } from './fixtures';
import { Group, Item, Pair, Panel } from './parts';

export function GalleryRows() {
  const ut = useUiText();
  const [source, setSource] = useState('hp');
  const [type, setType] = useState('eboiler');
  const treeText: Record<string, string> = {
    root: ut('All of:'),
    grid: ut('Grid is off'),
    pv: ut('Solar above 1.5 kW'),
    any: ut('Any of:'),
    battery: ut('Battery at least 95%'),
    forecast: ut('Sunny forecast'),
    delay: ut('For 2 minutes'),
  };
  return (
    <Group title={ut('Read-only rows')}>
      <Item name="FallbackNote · ContactRow">
        <FallbackNote icon="shield" text={ut('Fallback — the radiator valves’ own sensors 22.6° and 21.8°, corrected. Only if every main sensor is offline.')} />
        <ContactRow name={ut('Left window')} entityId="binary_sensor.living_window_left" meta="91% · LQI 128" stateText={ut('closed')} open={false} />
        <ContactRow name={ut('Window')} entityId="binary_sensor.bedroom_window" meta="79% · LQI 104" stateText={ut('open for 12 min')} open />
        <ContactRow name={ut('Terrace door')} entityId="binary_sensor.terrace_door" meta="—" stateText={ut('offline')} open={false} unavailable />
      </Item>

      <Item name="TrvCard">
        <TrvCard
          name={ut('Radiator under the window')}
          entityId="climate.living_trv_window"
          meta="SONOFF TRVZB · Z2M #1"
          chips={[
            { tone: 'heat', icon: 'flame', label: ut('heats') },
            { tone: 'ok', icon: 'check', label: ut('target 20.0° confirmed at 19:04') },
          ]}
          stats={[
            { label: ut('Valve sensor'), value: '22.6°', sub: ut('+2.8° to the room') },
            { label: ut('Battery'), value: '82%' },
            { label: ut('Signal'), value: 'LQI 156', sub: ut('good') },
            { label: ut('Last seen'), value: ut('1 min ago') },
          ]}
          capabilities={[
            { label: ut('external sensor'), on: true },
            { label: ut('calibration'), on: true },
            { label: ut('child lock'), on: true },
            { label: ut('actual valve opening'), on: false },
          ]}
        />
        <Panel narrow>
          <TrvCard
            compact
            name={ut('Radiator by the door')}
            meta="SONOFF TRVZB · Z2M #1"
            chips={[{ tone: 'ok', icon: 'check', label: '20.0°' }]}
            stats={[
              { label: ut('valve'), value: '21.8°' },
              { label: ut('battery'), value: '57%' },
              { label: ut('signal'), value: 'LQI 132' },
            ]}
            capabilities={[]}
          />
        </Panel>
      </Item>

      <Item name="EmitterRow">
        <EmitterRow title={ut('Radiators · 2 valves')} sub={ut('from the heat pump, reserve — gas boiler')} role={{ label: ut('primary'), tone: 'heat' }} />
        <EmitterRow title={ut('Air conditioner')} entityId="climate.living_ac" role={{ label: ut('primary'), tone: 'cool' }} />
        <EmitterRow title={ut('Underfloor cooling')} role={{ label: ut('assist'), tone: 'cool' }} blocked={ut('excluded — humidity too high')} />
      </Item>

      <Item name="SourceListItem · TypePickerCard">
        <Pair min={280}>
          <SourceListItem icon="heatPump" name={ut('Heat pump')} sub={ut('heat pump · lead')} chip={{ tone: 'heat', label: ut('heats') }} selected={source === 'hp'} onClick={() => setSource('hp')} />
          <SourceListItem icon="boiler" name={ut('Gas boiler')} sub={ut('gas boiler · reserve')} chip={{ tone: 'hold', label: ut('reserve') }} selected={source === 'boiler'} onClick={() => setSource('boiler')} />
        </Pair>
        <Pair min={180}>
          <TypePickerCard icon="electricBoiler" name={ut('Electric boiler')} can={ut('heats')} how={ut('relay or climate')} selected={type === 'eboiler'} onClick={() => setType('eboiler')} />
          <TypePickerCard icon="heatPump" name={ut('Heat pump')} can={ut('heats and cools')} how={ut('climate or an integration')} selected={type === 'hp'} onClick={() => setType('hp')} />
          <TypePickerCard icon="anyEntity" name={ut('Any entity')} can={ut('whatever it can')} how={ut('switch, climate or scripts')} selected={type === 'any'} onClick={() => setType('any')} />
        </Pair>
      </Item>

      <Item name="ChainRow · FeedRow">
        <ChainRow rank={1} name={ut('Heat pump')} when={ut('lead while it is not below −10° outside')} chip={{ tone: 'heat', label: ut('heating now') }} grip />
        <ChainRow rank={2} name={ut('Gas boiler')} when={ut('below −10°, if the heat pump fails or cannot keep up')} chip={{ tone: 'hold', label: ut('reserve') }} grip />
        <FeedRow label={ut('Heating →')} tone="heat" chips={[{ label: ut('Radiators'), to: '/system' }, { label: ut('Underfloor heating') }]} empty={ut('does not heat')} />
        <FeedRow label={ut('Cooling →')} tone="cool" chips={[]} empty={ut('does not cool')} />
      </Item>

      <Item name="ConditionRow · ConditionTreeView">
        <ConditionRow met text={ut('Outside not below −10°')} sub={ut('now 4.2°')} badge={ut('met')} />
        <ConditionRow met={false} text={ut('Night tariff')} sub={ut('from 23:00')} badge={ut('not met')} />
        <ConditionRow met={null} text={ut('Sunny forecast')} sub={ut('weather.home unavailable')} badge={ut('unknown')} />
        <ConditionTreeView eval={TREE} render={(id) => treeText[id] ?? id} />
      </Item>

      <Item name="GuardList">
        <Panel>
          <GuardList
            items={[
              { icon: 'shield', title: ut('Frost protection — 7°'), text: ut('Works in every mode. The first available source heats, even one that waits for a trigger.') },
              { icon: 'swap', title: ut('A source did not respond — the next one'), text: ut('No confirmation in 5 min or the entity is unavailable — the next in the chain takes over.') },
              { icon: 'clock', title: ut('Relay watchdog'), text: ut('The boiler and the convector switch off by themselves after 15 min without a renewal.'), warn: true },
            ]}
          />
        </Panel>
      </Item>

      <Item name="ProblemCard · InstanceRow · TargetRow">
        <Pair min={300}>
          <ProblemCard
            icon="sync"
            tone="warn"
            title={ut('Bathroom · towel rail')}
            meta={{ entityId: 'climate.bathroom_towel_trv', text: 'SONOFF TRVZB · Z2M #2' }}
            chip={ut('Did not confirm 24.0° · retry 2 of 3')}
            hint={ut('The signal is weak (LQI 54). The simplest fix is a Zigbee plug or relay in the hall as a router.')}
            primary={{ label: ut('Retry now'), onClick: () => undefined }}
            secondary={{ label: ut('Open in Zigbee2MQTT'), onClick: () => undefined }}
          />
          <ProblemCard
            icon="offline"
            tone="err"
            title={ut('Kitchen · shelf sensor')}
            meta={{ entityId: 'sensor.kitchen_shelf_temperature', text: 'Aqara WSDCGQ11LM · Z2M #1' }}
            chip={ut('Offline for 1 h 40 min')}
            hint={ut('Press the button on the sensor briefly. Meanwhile the median uses the other two.')}
            primary={{ label: ut('Exclude from the room'), onClick: () => undefined }}
          />
        </Pair>
        <InstanceRow name="Z2M #1" topic="zigbee2mqtt" count={ut('{n} devices', { n: 20 })} status={{ tone: 'ok', label: ut('online') }} />
        <InstanceRow name="Z2M #2" topic="zigbee2mqtt_2" count={ut('{n} devices', { n: 6 })} status={{ tone: 'err', label: ut('offline') }} />
        <TargetRow name={ut('My phone')} entity="notify.mobile_app_phone" scope={ut('by the table')} onEdit={() => undefined} />
        <TargetRow name={ut('Kitchen tablet')} entity="notify.mobile_app_kitchen_tablet" scope={ut('critical only')} />
      </Item>

      <Item name="ActivityLog · DecisionLog">
        <Panel>
          <ActivityLog
            rows={[
              { time: '19:00', dot: 'warn', title: ut('Kitchen: shelf sensor offline'), where: ut('phone, Telegram · me, HA panel'), state: ut('delivered') },
              { time: '18:46', dot: 'off', title: ut('Bathroom: valve did not confirm · 2 of 3'), where: ut('waits for the 3rd attempt'), state: ut('not sent yet'), muted: true },
              { time: ut('yesterday {t}', { t: '16:05' }), dot: 'err', title: ut('Heat pump not responding — the boiler heats'), where: ut('all channels · critical'), state: ut('«I see it» at {t}', { t: '16:07' }) },
            ]}
          />
        </Panel>
        <Panel>
          <DecisionLog
            rows={[
              { time: '19:04', tone: 'heat', title: ut('Heat pump: heat'), why: ut('Living room 19.8° ≤ 19.8°, also Kids room and Bathroom. The valve confirmed in 40 s.'), to: '/rooms/living' },
              { time: '19:00', tone: 'err', title: ut('Kitchen · sensor went silent'), why: ut('No updates for 90 min, excluded from the median.') },
              { time: '18:59', tone: 'warn', title: ut('Bedroom · paused'), why: ut('Window open for longer than 60 s — valve closed.') },
              { time: '17:50', tone: 'off', title: ut('Heat pump: stop'), why: ut('Every room reached its target plus tolerance. Floor pump runs on until 18:00.') },
            ]}
          />
        </Panel>
      </Item>

      <Item name="NotificationPreview">
        <NotificationPreview
          push={{
            label: ut('Phone push · critical'),
            app: 'Home Assistant',
            title: ut('The heat pump is not responding'),
            body: ut('climate.heat_pump unavailable for 3 min. Heating switched to the gas boiler — the rooms are warm.'),
            actions: [ut('Open the app'), ut('I see it')],
            caption: ut('Goes through «Do not disturb». Repeats in 30 min unless someone taps «I see it».'),
          }}
          telegram={{
            label: ut('Telegram · warning'),
            sender: ut('Climate bot'),
            lines: [ut('Kitchen: the shelf sensor has been offline for 1 h 30 min.'), ut('Using the other 2 sensors — 20.9°, heating works as it should.')],
            buttons: [[ut('Ignore until morning'), ut('Exclude from the room')], [ut('Open the app')]],
            time: '19:00',
            caption: ut('Quiet hours: such messages wait from 23:00 to 07:00.'),
          }}
        />
      </Item>
    </Group>
  );
}
