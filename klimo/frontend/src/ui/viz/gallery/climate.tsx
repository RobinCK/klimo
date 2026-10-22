import { useState } from 'react';
import { useUiText } from '../../UiTextContext';
import { RoomCard } from '../../climate/RoomCard';
import { RoomTabs } from '../../climate/RoomTabs';
import { ThermostatDial, type DialValue } from '../../climate/ThermostatDial';
import { TargetStepper } from '../../climate/TargetStepper';
import { ProfileIconTile, ProfileListItem, ProfileSwatch, ProfileTile } from '../../climate/profiles';
import { fmtNum } from '../internal/util';
import { P, SPARK } from './fixtures';
import { Group, Item, Pair, Panel, galleryStyles as s } from './parts';

const deg = (v: number) => `${fmtNum(v)}°`;

function DialDemo() {
  const ut = useUiText();
  const [value, setValue] = useState(20);
  const [dragging, setDragging] = useState(false);
  const editing = value !== 20;
  return (
    <ThermostatDial
      mode="heat"
      value={value}
      current={19.8}
      min={12}
      max={28}
      step={0.5}
      active={{ heat: true, cool: false }}
      editing={editing || dragging}
      centerTop={editing || dragging ? { text: ut('New target'), tone: 'neutral' } : { text: ut('Heating'), tone: 'heat' }}
      centerValue={deg(value)}
      centerSub={ut('now {t}', { t: '19.8°' })}
      onChange={(v) => typeof v === 'number' && setValue(v)}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      ariaLabels={{ slider: ut('Target'), dec: ut('Lower the target by 0.5°'), inc: ut('Raise the target by 0.5°') }}
    />
  );
}

function DualDemo() {
  const ut = useUiText();
  const [value, setValue] = useState<DialValue>({ lo: 20, hi: 25 });
  const [sel, setSel] = useState<'lo' | 'hi'>('hi');
  const v = typeof value === 'number' ? { lo: value, hi: value } : value;
  return (
    <ThermostatDial
      mode="dual"
      value={v}
      current={25.4}
      min={16}
      max={30}
      step={0.5}
      gap={2}
      selected={sel}
      onSelectBound={setSel}
      active={{ heat: false, cool: true }}
      centerTop={{ text: ut('Cooling'), tone: 'cool' }}
      centerValue=""
      dualLabels={{ lo: deg(v.lo), hi: deg(v.hi) }}
      centerSub={ut('now {t}', { t: '25.4°' })}
      onChange={setValue}
      ariaLabels={{
        slider: ut('Target'),
        lo: ut('Not colder than'),
        hi: ut('Not warmer than'),
        dec: sel === 'lo' ? ut('Lower «not colder than» by 0.5°') : ut('Lower «not warmer than» by 0.5°'),
        inc: sel === 'lo' ? ut('Raise «not colder than» by 0.5°') : ut('Raise «not warmer than» by 0.5°'),
      }}
    />
  );
}

export function GalleryClimate() {
  const ut = useUiText();
  const [stepValue, setStepValue] = useState(20);
  const [profile, setProfile] = useState('home');
  const aria = { slider: ut('Target'), dec: ut('Lower the target by 0.5°'), inc: ut('Raise the target by 0.5°') };
  return (
    <Group title={ut('Climate')}>
      <Item name="RoomCard · card">
        <Pair min={260}>
          <RoomCard
            variant="card"
            title={ut('Living room')}
            state="heat"
            stateLabel={ut('Heating')}
            tempText="19.8°"
            trend={{ cPerH: -0.2, text: ut('{v}°/h', { v: '−0.2' }) }}
            source={{ kind: 'schedule', text: ut('Target {t} · Home until 23:00', { t: '20.0°' }) }}
            spark={{ ...SPARK.heat, below: 0.2, above: 0.2 }}
            meta={[
              { icon: 'droplet', text: '46%' },
              { icon: 'windowClosed', text: ut('2 closed') },
              { icon: 'radiator', text: ut('radiators from the heat pump · 2/2') },
            ]}
            to="/rooms/living"
            ariaLabel={ut('Living room: 19.8°, heating, target 20.0°')}
          />
          <RoomCard
            variant="card"
            title={ut('Bedroom')}
            state="window"
            stateLabel={ut('Window')}
            tempText="17.6°"
            trend={{ cPerH: -2.8, text: ut('{v}°/h', { v: '−2.8' }) }}
            source={{ kind: 'window', text: ut('Paused · window open for 12 min') }}
            spark={{ ...SPARK.window, below: 0.3, above: 0.3 }}
            meta={[
              { icon: 'droplet', text: '52%' },
              { icon: 'windowOpen', text: ut('open for 12 min'), tone: 'warn' },
              { icon: 'radiator', text: ut('valve closed') },
            ]}
            to="/rooms/bedroom"
            ariaLabel={ut('Bedroom: 17.6°, window, paused')}
          />
          <RoomCard
            variant="card"
            title={ut('Kids room')}
            state="wait"
            tone="heat"
            stateLabel={ut('Waiting')}
            tempText="21.6°"
            trend={{ cPerH: -0.4, text: ut('{v}°/h', { v: '−0.4' }) }}
            source={{ kind: 'schedule', text: ut('Target {t} · Home until 21:00', { t: '22.0°' }) }}
            spark={{ values: SPARK.heat.values.map((v) => v + 2.7), target: SPARK.heat.target.map(() => 22), below: 0.3, above: 0.2 }}
            issue={{ tone: 'warn', icon: 'clock', text: ut('Heat pump paused · starts in 2 min') }}
            to="/rooms/kids"
            ariaLabel={ut('Kids room: 21.6°, waiting')}
          />
          <RoomCard
            variant="card"
            title={ut('Study')}
            state="off"
            stateLabel={ut('Off')}
            tempText="17.9°"
            trend={{ cPerH: -0.3, text: ut('{v}°/h', { v: '−0.3' }) }}
            source={{ kind: 'off', text: ut('Off in «Away» · frost guard 7°') }}
            spark={{ ...SPARK.off, below: 0.3, above: 0.3 }}
            meta={[{ icon: 'droplet', text: '43%' }]}
            to="/rooms/study"
            ariaLabel={ut('Study: 17.9°, off')}
          />
          <RoomCard
            variant="card"
            title={ut('Kitchen')}
            state="error"
            stateLabel={ut('No data')}
            tempText="—"
            source={{ kind: 'no_data', text: ut('No temperature — not controlling') }}
            spark={{ values: SPARK.gap.values.map((v, i) => (i > 9 ? null : v)), target: SPARK.gap.target, below: 0.5, above: 0.3 }}
            issue={{ tone: 'err', icon: 'offline', text: ut('3 of 3 sensors offline') }}
            to="/rooms/kitchen"
            ariaLabel={ut('Kitchen: no data')}
          />
        </Pair>
      </Item>

      <Item name="RoomCard · compact">
        <Pair min={300}>
          <RoomCard variant="compact" title={ut('Living room')} state="heat" stateLabel={ut('Heating')} tempText="19.8°" source={{ kind: 'schedule', text: ut('Home until 23:00') }} targetText="→ 20.0°" to="/rooms/living" ariaLabel={ut('Living room: 19.8°, heating, target 20.0°')} />
          <RoomCard variant="compact" title={ut('Bedroom')} state="window" stateLabel={ut('Window')} tempText="17.6°" source={{ kind: 'window', text: '' }} subText={ut('Paused · window open for 12 min')} targetText="→ 19.0°" to="/rooms/bedroom" ariaLabel={ut('Bedroom: 17.6°, window, paused')} />
          <RoomCard variant="compact" title={ut('Hall')} state="hold" stateLabel={ut('Holding')} tempText="19.1°" source={{ kind: 'schedule', text: ut('Home until 23:00') }} issue={{ tone: 'warn', icon: 'battery', text: ut('Sensor: battery 12%') }} targetText="→ 19.0°" to="/rooms/hall" ariaLabel={ut('Hall: 19.1°, holding')} />
          <RoomCard variant="compact" title={ut('Kids room')} state="cool" stateLabel={ut('Cooling')} tempText="25.3°" source={{ kind: 'schedule', text: ut('Home until 21:00') }} targetText="→ 24.5°" to="/rooms/kids" ariaLabel={ut('Kids room: 25.3°, cooling, target 24.5°')} />
        </Pair>
      </Item>

      <Item name="RoomTabs">
        <RoomTabs
          rooms={[
            { id: 'living', name: ut('Living room'), tempText: '19.8°', dotTone: 'heat' },
            { id: 'bedroom', name: ut('Bedroom'), tempText: '17.6°', dotTone: 'warn' },
            { id: 'kids', name: ut('Kids room'), tempText: '21.7°', dotTone: 'heat' },
            { id: 'study', name: ut('Study'), tempText: '21.0°', dotTone: 'off' },
            { id: 'kitchen', name: ut('Kitchen'), tempText: '20.9°', dotTone: 'err' },
            { id: 'bath', name: ut('Bathroom'), tempText: '23.7°', dotTone: 'heat' },
            { id: 'hall', name: ut('Hall'), tempText: '19.1°', dotTone: 'warn' },
          ]}
          current="living"
          hrefFor={(id) => `/rooms/${id}`}
          addTo="/rooms/new"
          addLabel={ut('Add a room')}
        />
      </Item>

      <Item name="ThermostatDial">
        <Pair min={240}>
          <Panel>
            <DialDemo />
          </Panel>
          <Panel>
            <ThermostatDial
              mode="cool"
              value={25}
              current={25.6}
              min={18}
              max={32}
              step={0.5}
              active={{ heat: false, cool: true }}
              centerTop={{ text: ut('Cooling'), tone: 'cool' }}
              centerValue="25.0°"
              centerSub={ut('now {t}', { t: '25.6°' })}
              onChange={() => undefined}
              ariaLabels={aria}
            />
          </Panel>
          <Panel>
            <DualDemo />
          </Panel>
          <Panel>
            <ThermostatDial
              mode="heat"
              value={20}
              current={19.8}
              min={12}
              max={28}
              step={0.5}
              locked
              active={{ heat: false, cool: false }}
              centerTop={{ text: ut('Holding'), tone: 'hold' }}
              centerValue="20.0°"
              centerSub={ut('now {t}', { t: '19.8°' })}
              onChange={() => undefined}
              ariaLabels={aria}
            />
          </Panel>
          <Panel>
            <ThermostatDial
              mode="heat"
              value={7}
              current={17.9}
              min={12}
              max={28}
              step={0.5}
              variant="off"
              active={{ heat: false, cool: false }}
              centerTop={{ text: ut('Off'), tone: 'off' }}
              centerValue="—"
              centerSub={ut('now {t}', { t: '17.9°' })}
              onChange={() => undefined}
              ariaLabels={aria}
            />
          </Panel>
          <Panel>
            <ThermostatDial
              mode="heat"
              value={20}
              current={null}
              min={12}
              max={28}
              step={0.5}
              variant="error"
              active={{ heat: false, cool: false }}
              centerTop={{ text: ut('No data'), tone: 'err' }}
              centerValue="—"
              centerSub={ut('sensors offline')}
              onChange={() => undefined}
              ariaLabels={aria}
            />
          </Panel>
        </Pair>
        <span className={s.note}>{ut('Below 200 px the dial becomes a row:')}</span>
        <div className={s.tiny}>
          <DialDemo />
        </div>
      </Item>

      <Item name="TargetStepper">
        <Panel narrow>
          <TargetStepper
            value={stepValue}
            text={deg(stepValue)}
            onChange={setStepValue}
            min={5}
            max={30}
            step={0.5}
            editing={stepValue !== 20}
            label={ut('Target')}
            ariaDec={ut('Lower the target by 0.5°')}
            ariaInc={ut('Raise the target by 0.5°')}
          />
        </Panel>
      </Item>

      <Item name="ProfileSwatch · ProfileIconTile · ProfileTile">
        <span>
          <ProfileSwatch color={P.home.color} /> <ProfileSwatch color={P.night.color} size={12} shape="round" />{' '}
          <ProfileIconTile icon="home" color={P.home.color} ink={P.home.ink} /> <ProfileIconTile icon="moon" color={P.night.color} ink={P.night.ink} size={48} />
        </span>
        <Pair min={120}>
          <ProfileTile name={ut('Home')} color={P.home.color} value="21.0°" />
          <ProfileTile name={ut('Away')} color={P.away.color} value="18.0°" />
          <ProfileTile name={ut('Eco')} color={P.eco.color} value="19.0°" />
        </Pair>
        <span>
          <ProfileTile variant="inline" name={ut('Home')} color={P.home.color} ink={P.home.ink} icon="home" value={ut('until 23:00')} />{' '}
          <ProfileTile variant="chip" name={ut('Guests')} color={P.guests.color} ink={P.guests.ink} icon="users" value="22.0°" />
        </span>
      </Item>

      <Item name="ProfileListItem">
        <Panel narrow>
          {(
            [
              ['home', ut('Home'), 'home', '21.0°', '25.0°', true],
              ['away', ut('Away'), 'away', '18.0°', '28.0°', false],
              ['night', ut('Night'), 'moon', '19.5°', '26.0°', false],
            ] as const
          ).map(([id, label, icon, heat, cool, live]) => (
            <ProfileListItem
              key={id}
              name={label}
              kindLabel={ut('system profile')}
              color={P[id].color}
              ink={P[id].ink}
              icon={icon}
              heatText={heat}
              coolText={cool}
              live={live}
              selected={profile === id}
              onClick={() => setProfile(id)}
            />
          ))}
        </Panel>
      </Item>
    </Group>
  );
}
