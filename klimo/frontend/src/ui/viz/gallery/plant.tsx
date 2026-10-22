import type { Reason, SchemaEdge, SchemaNode } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { ScrollX } from '../../shell/Layout';
import { PlantDiagram } from '../plant/PlantDiagram';
import { EnergyStrip, LoopTile, PlantNodeCard, RowList, SourceRow } from '../plant/parts';
import { BatteryBar, ComfortBar, SignalBars, ToleranceBar } from '../meters/meters';
import { said } from './fixtures';
import { Group, Item, Pair, Panel, galleryStyles as s } from './parts';

const textOf = (r: Reason) => String(r.params?.text ?? r.code);

function node(
  key: string,
  column: SchemaNode['column'],
  band: SchemaNode['band'],
  row: number,
  tone: SchemaNode['tone'],
  icon: SchemaNode['icon'],
  title: string,
  state: string,
  meta: string,
): SchemaNode {
  return { key, column, band, row, tone, icon, title, state: said(state), meta: meta ? said(meta) : null, roomIds: [], dashed: tone === 'idle' || tone === 'wait' || tone === 'off' };
}

export function GalleryPlant() {
  const ut = useUiText();
  const nodes: SchemaNode[] = [
    node('source:hp', 'sources', 'hydronic', 0, 'heat', 'heatPump', ut('Heat pump'), ut('Heating'), ut('38° · 2.1 kW · COP 3.1')),
    node('source:boiler', 'sources', 'hydronic', 1, 'idle', 'boiler', ut('Gas boiler'), ut('Reserve'), ut('below −10° or if the heat pump fails')),
    node('manifold:m1', 'manifolds', 'hydronic', 0, 'heat', 'manifold', ut('Manifold'), ut('Flow 38° · return 33°'), ut('shared by the heat pump and the boiler')),
    node('circuit:rad', 'circuits', 'hydronic', 0, 'heat', 'radiator', ut('Radiators'), ut('Pump running'), ut('asked by Living room, Kids room')),
    node('circuit:floor', 'circuits', 'hydronic', 1, 'heat', 'floor', ut('Underfloor heating'), ut('Pump running'), ut('asked by Bathroom · run-on 10 min')),
    node('rooms:rad', 'rooms', 'hydronic', 0, 'heat', 'home', ut('5 rooms with radiators'), ut('Living room 19.8° · Kids room 21.7°'), ut('Bedroom — paused, window open')),
    node('rooms:floor', 'rooms', 'hydronic', 1, 'heat', 'home', ut('3 rooms on the floor'), ut('Bathroom 23.7° asks for heat'), ut('Kitchen, Hall hold')),
    node('local:ac', 'sources', 'local', 0, 'idle', 'ac', ut('Air conditioners · 3'), ut('Not needed'), ut('assist when a room is 1.5° short')),
    node('rooms:ac', 'rooms', 'local', 0, 'idle', 'home', ut('Living room · Bedroom · Kids room'), ut('Radiators heat'), ut('air conditioners on standby')),
    node('local:conv', 'sources', 'local', 1, 'wait', 'convector', ut('Electric convector'), ut('Waiting for its trigger'), ut('«Sun during a blackout»')),
    node('rooms:conv', 'rooms', 'local', 1, 'off', 'home', ut('Study'), ut('Study 21.0°'), ut('manual until 20:30, holding')),
  ];
  const edges: SchemaEdge[] = [
    { from: 'source:hp', to: 'manifold:m1', tone: 'heat', dashed: false, label: said(ut('lead')) },
    { from: 'source:boiler', to: 'manifold:m1', tone: 'idle', dashed: true, label: said(ut('reserve')) },
    { from: 'manifold:m1', to: 'circuit:rad', tone: 'heat', dashed: false, label: null },
    { from: 'manifold:m1', to: 'circuit:floor', tone: 'heat', dashed: false, label: null },
    { from: 'circuit:rad', to: 'rooms:rad', tone: 'heat', dashed: false, label: null },
    { from: 'circuit:floor', to: 'rooms:floor', tone: 'heat', dashed: false, label: null },
    { from: 'local:ac', to: 'rooms:ac', tone: 'idle', dashed: true, label: said(ut('each room its own target')) },
    { from: 'local:conv', to: 'rooms:conv', tone: 'wait', dashed: true, label: said(ut('by trigger')) },
  ];
  const energy = (
    <EnergyStrip
      grid={{ present: true, label: ut('Grid on') }}
      items={[ut('solar {kw} kW', { kw: '0.0' }), ut('battery {pct}%', { pct: 78 }), ut('house {kw} kW', { kw: '3.4' })]}
      note={{ text: ut('night tariff from 23:00'), tone: 'warn' }}
    />
  );

  return (
    <>
      <Group title={ut('Plant')}>
        <Item name="PlantDiagram">
          <div className={s.well}>
            <ScrollX minWidth={1232} ariaLabel={ut('Plant diagram')}>
              <PlantDiagram
                nodes={nodes}
                edges={edges}
                columns={[
                  { key: 'sources', label: ut('Sources') },
                  { key: 'manifolds', label: ut('Manifold') },
                  { key: 'circuits', label: ut('Circuits & pumps') },
                  { key: 'rooms', label: ut('Rooms') },
                ]}
                renderState={textOf}
                bandLabel={ut('In the rooms — directly, without circuits')}
                energy={energy}
                onNodeClick={() => undefined}
              />
            </ScrollX>
          </div>
        </Item>
        <Item name="PlantNodeCard">
          <Pair min={240}>
            <PlantNodeCard icon="heatPump" title={ut('Heat pump')} state={ut('Cooling')} meta={ut('flow 18° · 1.4 kW')} tone="cool" size="source" />
            <PlantNodeCard icon="boiler" title={ut('Gas boiler')} state={ut('Off')} meta={ut('cannot cool')} tone="off" size="source" dashed />
            <PlantNodeCard icon="ac" title={ut('Air conditioners · 3')} state={ut('Living room cools')} meta={ut('Bedroom heats')} tone="mixed" size="source" />
            <PlantNodeCard icon="heatPump" title={ut('Heat pump')} state={ut('Not responding')} meta={ut('unavailable for 3 min')} tone="fault" size="source" />
          </Pair>
        </Item>
        <Item name="EnergyStrip">
          {energy}
          <EnergyStrip
            grid={{ present: false, label: ut('Grid off') }}
            items={[ut('solar {kw} kW', { kw: '5.2' }), ut('battery {pct}%', { pct: 97 }), ut('house {kw} kW', { kw: '1.4' })]}
            note={{ text: ut('to heat 3.6 of 4.0 kW'), tone: 'warn' }}
          />
          <Panel narrow>
            <EnergyStrip
              variant="compact"
              grid={{ present: true, label: ut('Grid on') }}
              items={[ut('solar {kw} kW', { kw: '0' }), ut('battery {pct}%', { pct: 78 }), ut('house {kw} kW', { kw: '3.4' })]}
            />
          </Panel>
        </Item>
        <Item name="LoopTile · SourceRow">
          <Pair min={160}>
            <LoopTile dotTone="heat" name={ut('Radiators')} state={ut('Pump running')} sub={ut('Living room, Kids room')} to="/system" />
            <LoopTile dotTone="off" name={ut('Underfloor heating')} state={ut('Pump stopped')} sub={ut('heating is off')} on={false} />
          </Pair>
          <span>
            <LoopTile dotTone="hold" name={ut('radiators')} />{' '}
            <LoopTile dotTone="hold" name={ut('radiators — summer')} on={false} />
          </span>
          <Panel narrow>
            <RowList ariaLabel={ut('Sources')}>
              <SourceRow icon="heatPump" name={ut('Heat pump')} meta={ut('since 19:04 · 38° · 2.1 kW · COP 3.1')} chip={{ tone: 'heat', label: ut('Heating') }} on to="/system/sources" />
              <SourceRow icon="boiler" name={ut('Gas boiler')} meta={ut('joins below −10° or if the heat pump fails')} chip={{ tone: 'hold', label: ut('Reserve') }} on={false} to="/system/sources" />
              <SourceRow icon="convector" name={ut('Convector · Study')} meta={ut('by the trigger «Sun during a blackout»')} chip={{ tone: 'wait', label: ut('Waiting') }} on={false} />
            </RowList>
          </Panel>
        </Item>
      </Group>

      <Group title={ut('Meters')}>
        <Item name="ToleranceBar">
          <Pair min={260}>
            <Panel>
              <ToleranceBar
                mode="heat"
                target={20}
                below={0.2}
                above={0.2}
                current={19.8}
                active
                labels={{ on: ut('on at ≤ {t}', { t: '19.8°' }), off: ut('off at ≥ {t}', { t: '20.2°' }), target: ut('target {t} · now {c}', { t: '20.0°', c: '19.8°' }) }}
              />
            </Panel>
            <Panel>
              <ToleranceBar
                mode="cool"
                target={25}
                below={0.3}
                above={0.3}
                current={25.6}
                labels={{ on: ut('on at ≥ {t}', { t: '25.3°' }), off: ut('off at ≤ {t}', { t: '24.7°' }), target: ut('target {t} · now {c}', { t: '25.0°', c: '25.6°' }) }}
                caption={ut('Cooling starts above the target and stops below it.')}
              />
            </Panel>
          </Pair>
        </Item>
        <Item name="ComfortBar">
          <Panel>
            <ComfortBar valuePct={46} comfort={[40, 60]} labels={{ start: '0%', comfort: ut('comfort {lo}–{hi}%', { lo: 40, hi: 60 }), end: '100%' }} />
            <ComfortBar valuePct={67} comfort={[40, 60]} labels={{ start: '0%', comfort: ut('comfort {lo}–{hi}%', { lo: 40, hi: 60 }), end: '100%' }} ariaLabel={ut('Humidity 67%, above comfort')} />
          </Panel>
        </Item>
        <Item name="BatteryBar · SignalBars">
          <Panel>
            <Pair min={120}>
              <BatteryBar pct={82} label="82%" />
              <BatteryBar pct={12} low label="12%" />
              <BatteryBar pct={null} mains label={ut('mains')} />
              <BatteryBar pct={55} stale label="55%" />
            </Pair>
            <Pair min={120}>
              <SignalBars bars={4} label="LQI 156" />
              <SignalBars bars={1} weak label="LQI 54" />
              <SignalBars bars={0} label="—" />
              <SignalBars bars={null} label="Wi‑Fi" />
            </Pair>
          </Panel>
        </Item>
      </Group>
    </>
  );
}
