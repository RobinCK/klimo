# Klimo

Room-by-room heating and cooling for Home Assistant: rooms on top of your existing radiator valves,
thermometers and window contacts, any number of climate sources (heat pump, boiler, air conditioners,
electric heaters) chosen by season, weather and triggers, circuits and pumps with run-on, profiles and
schedules, a blackout power budget, native `climate` entities, Lovelace cards and notifications.

## Add-on options

| Option | Description |
|---|---|
| `log_level` | Backend log level (`trace`…`error`). Use `debug` while setting up or reporting a problem. |
| `database.driver` | `sqlite` (default, stored in `/data`, covered by HA backups), `mariadb` or `postgres`. |
| `database.host/port/name/username/password` | Connection details for an external database. For the official MariaDB add-on use host `core-mariadb`. The database name defaults to `klimo`. |
| `telegram_bot_token` | Optional. Token of Klimo's own bot from @BotFather; it keeps alerting while Home Assistant is down. Chats are paired in the UI (Notifications → Add a chat). |
| `mqtt_host/mqtt_port/mqtt_username/mqtt_password` | Optional. Only needed for a broker other than the Mosquitto add-on; with Mosquitto the credentials come from the Supervisor. Required for the Lovelace cards and the native entities. |

Changing options restarts the add-on. All climate configuration lives in the web UI and applies
instantly without restarts.

**MQTT status:** Settings → Integrations shows whether Klimo is connected to a broker, which one and how
many entities it published. Control does not depend on MQTT; the native entities and the cards do. MQTT
over TLS is not supported yet — use the broker's plain port (the Mosquitto add-on's default).

**Who may change what:** every Home Assistant user can open the panel and control rooms — targets,
boost, airing, the house profile. Configuration (rooms, sources, schedules, notifications, settings) is
limited to Home Assistant administrators while **Settings → Behaviour → Only Home Assistant
administrators change settings** is on (the default). The add-on answers only the Supervisor (ingress
and the watchdog) and its own container; other add-ons on the internal network are refused.

## Getting started

1. **System → Sources → Add a source** for every heat pump, boiler, air conditioner or electric heater.
   Pick the type, then how Klimo switches it and how it knows the source really runs; **Test for 2 min**
   checks the wiring.
2. **Rooms → Add a room**: a name and a Home Assistant area. Klimo searches the area for radiator
   valves, thermometers, humidity sensors and window contacts and offers them; anything else can be
   found by name. Then choose how the temperature is combined, the tolerance, the window reaction and how
   the valves are driven.
3. **System → Schema → Circuits & pumps** for hydronic systems: which sources feed which circuit, the
   pumps and their run-on.
4. **Schedule**: the house schedule ships with weekday and weekend plans over the six seeded profiles
   (Home, Away, Eco, Night, Guests, Vacation); adjust the targets and the blocks.

Profiles, triggers and actions are created with English names and notifications start in English,
whatever language Home Assistant speaks; rename anything, and pick the notification language in
**Settings → Units, languages and look**. An install that started on 0.1.0 gets the English name for
every seeded name nobody changed; its notification language stays as it was.

The panel has its own language, apart from notifications and cards: a browser's own choice comes
first, then **Panel language for everyone**, then the Home Assistant user's language, then the
browser's. A change applies at once — the panel reloads.

After every start Klimo watches for 20 seconds before it switches anything, and it compares every
device with what it expects before it sends a command.

## Concepts

- **Room** — a controlled space with its own targets, tolerance, sensors, windows and emitters. Its id
  never changes; its slug gives the entity id `climate.klimo_<slug>`. Switch **Klimo controls this room**
  off to only watch it.
- **Emitter** — how a room receives heat or cold: radiators, underfloor heating, a fan coil or a towel
  rail on a circuit, or a room-level source (an air conditioner, a convector). Each emitter has a role per
  mode: *primary*; *top-up* (joins when the room lacks more than 1.5°); *trigger* (runs only while its
  source's conditions hold, and may store heat up to 1.5° above the target); *reserve* (only when every
  primary path fails).
- **Climate source** — whatever makes heat or cold: gas or electric boiler, heat pump, air conditioner,
  electric radiator, electric floor, infrared panel, or anything else. *Whole-house* sources feed circuits;
  *room* sources serve one room.
- **Circuit and pumps** — a hydronic branch of the house (radiators, floor, fan coils) fed by sources and
  joined by rooms. It runs as a whole with its source or by zones and rooms, with any number of pumps
  sharing one run-on, optionally behind a manifold with supply/return sensors and its own pump.
- **Profile** — named targets for heating and cooling with per-room exceptions (own targets or off).
  Home, Away and Eco are system profiles (renamable, not deletable); Vacation is frost protection only.
- **Schedule** — a weekly plan of profile blocks (30-minute steps) for the house, optional room schedules
  and dated exceptions.
- **Override** — a time-boxed manual change: a room target, boost, airing, room off, a room or house
  profile, a source locked off. Each one has an end ("until the next slot", 1 h, 3 h…) and can be undone.
- **Season** — heating, between seasons, cooling. **House mode** — Auto, heating only, cooling only or
  off (off still keeps frost protection, exercise runs and notifications).
- **Trigger** — a named live condition over Home Assistant; **action** — what changes while a trigger
  holds.
- **Incident** — one problem with a severity, facts and actions; the attention lists, the notifications
  and the cards are all views of incidents.
- **Journal** — every decision with its reason.

## Rooms

### Sensors and aggregation

- Any number of temperature sensors per room, each with a weight (0.1–2) and an include switch. The
  first one is the *main sensor*.
- **What counts as the current temperature**: median (the default for three or more sensors), average
  (the default for two), weighted, coldest, warmest or the main sensor. All six values are shown live, so
  the choice is easy.
- **Smoothing** (5 min by default) takes the noise out of cheap sensors; a 1° step reaches 63 % of its
  size after the smoothing time.
- **Outliers**: with three or more live sensors, one that differs from the others by more than 1.5° is
  not counted for a while (the majority is always kept) — a sensor next to a radiator or in the sun no
  longer moves the result.
- **Unavailable or silent**: a sensor that is unavailable, or has not reported for 1 h 30 min, is left
  out and you are notified. With no sensor left, the radiator valves' own readings are used, corrected by
  an offset Klimo learns while the room sensors work. With no data at all the valves fall back to 17°.
- A sensor excluded from a notification ("Exclude from the calculation") comes back by itself after
  10 minutes of good data.
- Humidity sensors are combined the same way (average, median, most humid, driest).

### Tolerance and requests

Each mode has a band around the target: heating starts at *target − below* and stops at *target +
above*; in between the room keeps what it was doing. Defaults: heating −0.2 / +0.2, cooling −0.3 /
+0.3. Target 20° with −0.2 / +0.2: heating starts at 19.8°, stops at 20.2°. A request lasts at least
5 minutes (*Shortest request*), so a source is never switched for a moment.

Per room you also decide whether the room may **start a source** (the heat pump or boiler starts for it
alone), **only join** (it heats only while the source already runs for other rooms — good for rarely
used rooms) or **never asks** (only its own devices work).

### Windows

- A window or door contact open for **60 s** triggers the room's reaction: **do not heat** (close the
  valves, the room does not ask), **switch to Eco**, **lower the target by 3°**, or **only notify**.
  After all contacts are closed for **2 min** the room resumes.
- Without a contact (or with every contact unavailable) a temperature drop of 1° within 5 minutes counts
  as an open window, for up to 30 min.
- A reminder comes after 20 min if the window is still open while the room is heated or cooled;
  "Ignore the window 30 min" suppresses the reaction, never the display.
- Klimo can switch off the valves' own open-window detection, so two mechanisms do not fight.

### Humidity, dew point and condensation

- Dew point and absolute humidity are calculated from the room temperature and humidity.
- **Warn above** 65 % for 15 min; **condensation risk** when the glass temperature comes within 3° of the
  dew point. The glass temperature is read from a glass sensor or estimated from the indoor and outdoor
  temperatures (the coefficient in Settings fits double glazing by default).
- **Airing**: suggest airing in a notification, or pause the heat in the room for 10 minutes by itself.
- **Dehumidifier**: a switch that turns on above 62 % (for 2 min) and off below 57 % after at least
  10 min; off while a window is open or the room is aired.

### Radiator valves

Valves are found through Zigbee2MQTT (and any `climate` entity), with their capabilities: an external
temperature input, a calibration offset, valve opening limits, child lock, open-window detection. The
control method is chosen per room:

| Method | How it works |
|---|---|
| **Room temperature → into the valve** (recommended) | The valve gets the room temperature as its external sensor; Klimo sets the setpoint in step with its own band. The smoothest. |
| **Dynamic offset** | The valve's calibration offset is adjusted so it "sees" the room temperature. For valves without an external input. |
| **On / off** | Setpoint 30° when the room heats, 5° when it does not. Works with any valve; the swings are larger. |
| **Valve opening, %** | Klimo regulates the opening itself (PI control). The most precise; more commands drain the battery faster. |

- Every command is confirmed against what the valve reports: no answer in 2 min → retry, up to 3 times,
  then a warning, then a quiet retry every 15 min.
- **Save the battery**: the room temperature is sent at most every 5 min and only on a change of 0.2° or
  more (at once for 1°), with a keep-alive every 30 min.
- **If a valve is turned by hand**: keep it until the next schedule slot, revert it after a minute, or
  save it into the profile. With the child lock on, only changes from the HA UI count.
- **Resend the targets after Zigbee2MQTT restarts** — Klimo notices the bridge coming back and re-sends
  every target and setting.
- When a room or a valve is removed, the valve gets its own sensor back and a target of 20°. When the
  add-on stops, valves are handed back to their internal sensor with the current target.

### Air conditioners and room heaters

- An air conditioner can be the room's primary cooling, a top-up for heating (when the room lacks more
  than 1.5°, not below −5° outdoors) and a dehumidifier. **How to control the air conditioner**: *Room
  target* (Klimo corrects the AC's setpoint by the difference between its own sensor and the room, at most
  1° every 5 min), *On/off* (fixed setpoints, Klimo's band decides) or *As is* (the room target, the AC
  regulates itself).
- **Quiet fan at night** (23:00–07:00) and **Dry the air above 60 %** instead of cooling when the
  temperature is already fine.
- An electric heater stops at once when the room overheats or reaches its hard limit (26° by default),
  regardless of its minimum run.

### Smart functions

| Function | What it does |
|---|---|
| Optimal start | Learns how fast the room warms up and starts early, so the target is reached at the start of the slot, not after it. |
| Overheating protection | Above 26° the valves close even with a manual target. |
| Frost protection | Even when the room is off, keep at least 7° (always on). |
| Valve exercise in summer | Every Sunday at 10:00 the valves open and close, so they do not seize. |
| Weather compensation | In frost the room starts heating a little earlier (the threshold rises by 0.1° for every 5° of frost). |
| Sun in the windows | Rooms on the sunny side start cooling earlier, by the forecast. |

## Targets, profiles and schedules

- **Effective target** = the active profile's value for the room, after every layer and modifier, with
  where it comes from and until when. The room page shows it as "Target 20.0° · Home until 23:00".
- **Who wins when rules disagree** (Schedule page): frost protection › open window (both locked) ›
  manual change › calendar › presence › room schedule › house schedule; the last four can be reordered.
- **Manual changes** last until the end of the slot, a chosen time, until you resume the schedule
  (manual control, see below), or forever (which writes the value into the active profile). Boost (+1°
  for 30 min) and airing (10 min) are one tap. Every change can be undone for 30 seconds.
- **A target set in Home Assistant** (a thermostat card, HomeKit, voice) lasts until the next slot by
  default (Settings → Behaviour); in a room under manual control it stays manual with the new value.
- **Presence**: *everyone left* (all persons away for 15 min → Away), *someone is coming* (within 3 km),
  *someone is home* (cancels Away in the middle of a schedule slot). Choose the people in Settings first.
- **Calendar**: an event matching a text on a calendar entity switches to a profile, with pre-heating
  (Guests 60 min before "Guests" on the family calendar).
- **Vacation**: until a date, returning to normal 3 hours early so the house is warm on arrival.
- **Exceptions** in the schedule cover holidays and days off.

## Manual control

Every room is in one of three modes, chosen next to its target on the room page, on the thermostat
card or from Home Assistant:

| Mode | What it means |
|---|---|
| **Schedule** | The room follows its profiles and schedules. A change for 1 hour or until the next slot is temporary: the room page shows its end, and the room goes back by itself. |
| **Manual** | The room holds its own target with no end. The schedule, a house profile change and presence do not touch it. −/+ change the value without asking how long. |
| **Off** | The room is off with no end. Frost protection stays: below the frost limit (7° by default) it is heated anyway. |

An open window still pauses a room under manual control, and frost protection acts in every mode.
Rule offsets and blackout limits apply as to any manual change. A temporary change made in a manual or
switched-off room returns to that mode when it ends.

**Resume schedule** in a room ends its manual, temporary, boost and off changes. The house has two
modes on the house profile tile: **Schedule**, and **Manual** — the house schedule is paused and the
current house profile holds. **Resume schedule for the whole house** resumes the house schedule and
every room's manual or temporary change; rooms switched off stay off until they are resumed one by
one. Manual control survives a restart of the add-on. The journal records who changed a mode and
through which entity.

### From Home Assistant

An add-on cannot add services to Home Assistant; these entities and one event do the job:

| Entity | What it does |
|---|---|
| `climate.klimo_<room>` | `auto` resumes the schedule, `heat` / `cool` / `heat_cool` switch the room to manual control at its current target, `off` switches it off. A temperature set while the room is manual keeps it manual; otherwise it lasts as Settings → Behaviour says. |
| `select.klimo_<room>_control` | `Schedule`, `Manual` or `Off`. Attributes: `mode` (also `temporary`), `since`, `until`, `set_by`. A temporary change reads `Schedule`. |
| `switch.klimo_schedule` | On = the house follows the schedule, off = the house schedule is paused. Turning it on resumes the whole house. |
| `button.klimo_<room>_resume_schedule` | Resumes the room. |
| `button.klimo_resume_schedule` | Resumes the whole house; rooms switched off stay off. |

```yaml
# a room under manual control at 21°
action: climate.set_temperature
target:
  entity_id: climate.klimo_vitalnia
data:
  hvac_mode: heat
  temperature: 21

# back to the schedule
action: button.press
target:
  entity_id: button.klimo_vitalnia_resume_schedule

# the room's mode through its select
action: select.select_option
target:
  entity_id: select.klimo_vitalnia_control
data:
  option: Manual

# pause the house schedule (turn_on resumes the whole house)
action: switch.turn_off
target:
  entity_id: switch.klimo_schedule
```

Scripts and automations can also fire the event `klimo_command`:

```yaml
- event: klimo_command
  event_data:
    command: set_target      # resume_schedule | set_schedule | set_manual | set_off | set_target
    room: Living room        # room id, slug, name or one of its Klimo entities
    target: 21.5
    duration: 2h             # slot | 1h | 2h | 3h | morning | until | manual | forever
```

Without `room`, `resume_schedule`, `set_schedule` and `set_manual` act on the whole house. `set_manual`
with a `target` holds that value. `set_target` without a `duration` lasts as Settings → Behaviour says,
or stays manual in a room under manual control; `duration: until` takes `until` as a time (ISO or epoch
milliseconds). A command that cannot be applied — an unknown command or room, a missing target — is
written to the journal with the reason. Settings → Integrations has these examples with your rooms'
entity ids, ready to copy.

## Climate sources

### How Klimo controls a source

| Control | Switching | Notes |
|---|---|---|
| **Relay (dry contact)** | `switch` on/off, optional stages (electric boilers) and an inverted contact | Optional device watchdog: a countdown `number` (or a service) re-armed every 5 min, so the relay drops within 15 min if Klimo stops. |
| **Climate entity** | `hvac_mode` per Klimo mode, setpoint from the weather curve, the room target or a fixed value | Heat pumps, boilers with OpenTherm/eBUS bridges, air conditioners. |
| **Flow temperature** | an enable switch plus a flow setpoint `number` and an optional mode select | |
| **Scripts** | `script.turn_on` with `{mode, setpoint}` once per start and stop | |
| **Anything from HA** | your own service calls for on, off and setpoint changes | |

**Proof it runs** — each source confirms its start: the entity is on, power above a threshold, the
`hvac_action` reports heating/cooling, the relay reads back, or a state in a list. Defrosting counts as
running and pauses the timers.

### Guards and failover

| Type | Min run | Min pause | Starts / h | Confirm within | Unavailable after |
|---|---|---|---|---|---|
| Gas boiler | 5 min | 5 min | 6 | 3 min | 1 min |
| Electric boiler | 3 min | 3 min | 10 | 2 min | 1 min |
| Heat pump | 10 min | 5 min | — | 5 min | 3 min |
| Air conditioner | 5 min | 3 min | — | 2 min | 10 min |
| Electric radiator, IR panel | 2 min | 2 min | — | 1 min | 1 min |
| Electric floor | 5 min | 5 min | — | 2 min | 1 min |

- A stop asked by a person, a schedule or a rule honours the minimum run; safety stops (fault, overheat,
  dew guard, blackout emergency) do not.
- No confirmation, an error code, or unavailable for longer than the limit → **fault**: the source is
  switched off, the next eligible source starts **on the same tick**, and you get a critical
  notification. The source is retried after 15 min and takes the lead back when it confirms.
- A source commanded off that still draws power after 2 min is reported and switched off again every
  minute.
- **Test for 2 min** runs the source (minimum pause and safety still apply) and reports whether and
  when it confirmed; it never raises an incident.
- **Off for a while…** locks a source out until a time (frost protection may still use it as a last
  resort). **When it may run** adds per-source conditions (outdoor limits, triggers, tariffs).
- **Linked sources**: duplicate a source as *linked* and it follows its template for guards, energy,
  limits, conditions and curves, keeping only the fields you change.
- **Weather curve** of the flow temperature: points of outdoor → flow temperature, a shift, minimum and
  maximum; the setpoint is written when it changes by 0.5° or more, at most every 10 min.
- When the add-on stops, a relay without a watchdog is switched off; a relay with a watchdog and
  climate or flow sources are left as they are, and the watchdog or the device's own regulation takes
  over.

### Consumption and cost

A source can have **meters** — one for gas, one for electricity and one for heat — chosen on the source
page under *Consumption meters*:

- **Gas**: a counter in m³, ft³, L, kWh or MJ (device class `gas`, state class `total_increasing` or
  `total`). A boiler and a stove on one meter: the hours, days and months show everything the meter
  counted; a single run gets only the gas used while the boiler ran.
- **Electricity**: an energy counter in kWh, or a power sensor in W or kW, which is added up over time
  (an estimate). A source saved before meters existed uses its power sensor.
- **Heat**: a heat meter in kWh. With it the page shows the boiler's efficiency (heat ÷ the energy of
  the gas) or the heat pump's COP (heat ÷ electricity).

Klimo stores no readings. The **Consumption** block of a source reads the meters' long-term statistics
in Home Assistant — by the hour for a day, by the day for a week or a month, by the month for a year —
so a meter bound today shows its whole recorded past. Under the bars are the outdoor temperature and
the running time, each on its own scale; hover, tap or use the arrow keys for all values of one column,
or switch to the table. The tiles show the total, the change against the period before (up to the same
point while the period runs), the cost, the gas per degree-day and the running time. A degree-day is
one degree below 18° outdoors for a whole day; dividing by it takes the weather out, so a lower number
means the house or the boiler got more efficient, not that the month was warmer.

For a day or a week, **Runs** lists every start with what it used. A single run needs the meter's state
history, which the recorder keeps for `purge_keep_days` (10 days by default): older runs show only
their time. Values marked ≈ are estimates — the meter reported rarely, or one reading covered several
runs and was shared out by running time. A meter that is reset or replaced is skipped, not counted.
Without a state class Home Assistant keeps no statistics and the chart stays empty: set
`state_class: total_increasing` in the integration or with `homeassistant: customize:`.

**Prices** are set in *Settings → Energy prices*: the currency, the price of a kWh of electricity, the
price of gas per m³ or per kWh, and the calorific value of the gas (10.5 kWh per m³ unless the bill says
otherwise). The **Energy** tile of the overview adds today's gas, electricity and cost of all sources
with meters.

## Strategy

### Heating

- **Heat chain**: the order in which sources are tried (drag to reorder). Each source has a role —
  main, reserve, top-up — shown on the schema.
- **How the heat pump and the boiler work together** (bivalence):
  - *Alternately*: above the bivalence point (−10° by default) only the heat pump, below only the
    boiler; back to the heat pump when it warms up by the return hysteresis (2°).
  - *In parallel*: below the point both run.
  - *Partly in parallel*: both between the point and the heat pump limit (−15°), only the boiler below.
  - The outdoor temperature is a 10-minute average, so a gust does not flip sources.
- **The boiler helps a heat pump that is not keeping up**: rooms short of their target by 1° for 45 min
  bring in the next source (not in the first 30 min after the heat pump starts, nor while it defrosts).
- **Heating not needed** above 15° outdoors (10-minute average): central heating stays off.
- **Extras in the rooms**: room-level top-ups (air conditioners, convectors) can be allowed or not per
  source.

### Cooling

- **Cool chain**: air conditioners and a heat pump that can cool, in your order.
- **The heat pump mode is chosen** *by the rooms' requests* (switches to cooling when most floor rooms
  ask for it) or *by the weather*; it changes mode at most once every 3 hours.
- **Dew point guard for floors and fan coils**: the supply water is kept at the dew point of the most
  humid served room plus a margin (2°). If the water still gets too cold, the floor stops at once (hard
  guard), its pumps run on for 2 min, and the floor rests for **30 min**. Three trips within 2 hours lock
  floor cooling **until midnight**; the incident stays open meanwhile and the lock ends by itself.
- **No floor cooling in humid rooms**: a room above 65 % humidity is left out of the floor loop.
  A room whose every humidity reading is unavailable for 5 minutes is left out too, until the readings
  have been back for 5 minutes ("Humidity unknown — no floor cooling").
- **Drying instead of cooling**: an air conditioner switches to drying above 60 % when the temperature
  is already fine.
- **Sun in the windows**: sunny rooms start cooling 30 min earlier, by the forecast.
- **Start the heat pump for a single room** (off by default): a room that has its own air conditioner
  is cooled by it, not by the central heat pump.

## Season

- The outdoor temperature comes from **Settings → House → Outdoor temperature sensors**: one
  thermometer or several, combined like a room's — median, average, the coldest, the warmest or the
  first in the list. The coldest suits a sensor the afternoon sun can reach. A sensor that is
  unavailable or silent for 30 min is left out; with none left, the last value is held for 30 min,
  then the weather entity's temperature is used. The 10-minute and 3-day averages are taken over the
  combined value, hour by hour.
- In **Auto** the season follows the 3-day average outdoor temperature: heating below 15°, cooling
  above 22°, between seasons in the middle; 1° hysteresis to leave a season, the change has to hold for
  6 hours and a season stays at least a day.
- **When heating is allowed** / **when cooling is allowed**: month limits (heating September–May,
  cooling May–September by default).
- **Between seasons**: central heating still starts for a room colder than its target by 1°; each room
  can use whatever it has (an AC may cool one room and heat another).
- The house mode (Auto, heating only, cooling only, off) is in the header, on the System page, and in
  Home Assistant as `select.klimo_season_mode`.

## Circuits and pumps

Circuits belong to the house: set one up once (System → Schema → Circuits & pumps, or from the add-room
wizard) and rooms join it. Each card shows what feeds the circuit, how it runs, its pump and run-on, and
the rooms on it.

- **How a floor runs**: *the whole floor — together with the source* (the default; the usual "floor pump
  with the boiler": the pump runs whenever a source of the circuit runs, rooms only ask for heat by their
  temperature), or *by zones — a valve in each room* (a cold room opens its zone valve, the pump runs
  while any zone is open, the last zone closing starts the run-on).
- **When the radiator pump runs**: *by the rooms* (the default: while smart heads are open or a room with
  ordinary radiators is colder than its target) or *together with the source*. A room with ordinary
  valves works as a room thermostat in either mode: it starts the source and this pump.
- **Rooms on the circuit**: add a room, take one off (its heads get their own setpoints back, its zone
  valve is left open on a heating-only floor and closed on one that also cools), or give a room a zone
  valve on a zoned floor.
- **Merge into…**: a house set up with a circuit per room merges them into one; rooms and pumps move,
  the empty circuit goes.
- A zoned floor without a **bypass** never has its pump push against closed zones: while a source must
  keep running, all zones open.
- **Run-on after a stop** takes the remaining heat out of the loop: 3 min for radiators and 10 min for a
  floor by default, separately for heating and cooling. A new request during the run-on restarts it, it
  never stacks.
- A pump is also forced on for frost protection, while its source is held on by its minimum run, before
  a source that needs flow starts (20 s pre-run), during a source test, and for 2 min after a dew-guard
  stop.
- A heating-only circuit never gets chilled water: while a source cools, its pumps stay off and its zone
  valves closed.
- **Several pumps per circuit**: all together, or duty and standby — the standby pump takes over when
  the duty pump is unavailable for a minute, and the roles rotate at the weekly exercise.
- **Manifold**: supply and return sensors and a primary pump that runs while any of its circuits does.
- **Mixing valve**: a `number` with the floor supply temperature (35° heating, the dew-safe value when
  cooling).
- **Pump anti-seize run**: every Sunday at 10:00 a pump that has been off for a day runs for a minute.

## Triggers and actions

A **trigger** is a live condition built from blocks: an entity state, a number above or below a value
(with an exit hysteresis and a delay), a template, a time window or tariff, the sun, the weather, or other
triggers, joined by all/any/not. Each trigger decides what an unknown input means. The seeded ones:

| Trigger | Default condition |
|---|---|
| Blackout | `binary_sensor.<grid>` reports the grid offline |
| Sun during blackout | Blackout, PV power − house load above 1500 W for 5 min (exit at 1000 W) and battery ≥ 95 % (exit at 90 %) |
| Night tariff | 23:00–07:00 (or your tariff entity) |
| Frost | outdoor 10-minute average below the bivalence point (exit 2° higher) |
| Battery low | Blackout and battery below 40 % (exit at 45 %) |

An **action** applies while its trigger holds: allow only some sources, forbid others, shift the targets
(+1.5° in rooms that can store heat when the sun is free), cap the power, pre-heat to the next schedule
slot, make a source depend on the trigger, or run pumps only on demand. The seeded actions: *Save energy*
(battery low: gas boiler only, electric sources off, targets −1°), *Store heat* (sun during blackout) and
*Electric pre-heat* (night tariff). Actions on the System → Strategy & triggers page show when they last
fired.

## Energy during a blackout

While the *Blackout* trigger holds:

- Electric sources share a **budget** (4.0 kW by default, or the inverter's limit minus the house load);
  starts are staggered by 30 s and admitted only if they fit.
- Above the budget for 30 s, the first source in **What to switch off first** is shed (at most one per
  stagger); far above it (125 %) minimum run is ignored.
- Gas boiler and pumps are exempt while the battery is above 20 %. At **20 %** (critical) everything stops
  except frost protection.
- **Where Klimo learns about energy**: the grid, PV power, house load and battery entities.
  `sensor.klimo_power_used` shows what Klimo's sources draw.

## Notifications

### Channels

| Channel | Sending | Actions back |
|---|---|---|
| Home Assistant app | `notify.mobile_app_*`; critical alerts use iOS critical alerts and the Android alarm stream, so they sound through silent mode and Do Not Disturb | Buttons: Got it, Ignore 30 min / until morning, Exclude from the calculation, Retry now, Ignore the window, Air 10 min, Back to schedule, Open Klimo |
| Other notify services | any `notify.*` service | — |
| Telegram through HA | `telegram_bot.send_message` with inline buttons | `telegram_callback` events from known chats |
| Klimo's own Telegram bot | Bot API with `telegram_bot_token`; works while Home Assistant is down | inline buttons; chats are paired with a one-time `/start <code>` (valid 10 min) |
| HA sidebar | `persistent_notification`, dismissed when the problem is over | — |
| Automation event | the `klimo_event` event and the MQTT topic `klimo/events` on every change | — |

Klimo's own bot and Home Assistant's `telegram_bot` integration must not poll with the same token: if
another poller is found, Klimo stops polling and reports it (sending still works). Button presses are
accepted only from paired chats, known phones and the UI; a button older than 24 h answers that it
expired.

### Delivery

- **What goes where**: a matrix of events × targets. Exactly one target is primary; critical events are
  locked on for it. One target can be the escalation target (a family group).
- **Severity**: critical (a source failed or unavailable, frost risk, Zigbee2MQTT offline, Home Assistant
  disconnected, battery critically low) bypasses quiet hours, repeats every 30 min (up to 6 times) until
  someone presses **Got it**, and escalates after 10 min. Warnings and events wait for quiet hours and are
  grouped (similar messages within 2 min become one).
- **Quiet hours** 23:00–07:00 with a morning digest of what is still open.
- **When it is over**, a short silent message goes to the same targets; the phone notification is
  replaced, the sidebar one dismissed.
- **Daily summary** at 21:00 and a **weekly report** on Sunday: runtime and cycles per source, energy,
  room minimum and maximum, problems.
- **Personal settings**: each household member picks which of their own targets get which levels, and
  their own quiet hours.
- **Test notification** ignores quiet hours and grouping and reports the result per target.
- If every channel fails for a critical message, Klimo falls back to a persistent notification and
  retries; a channel that fails three times in a row is reported.

### Entity watch

Every entity Klimo uses is watched automatically — a source's command entity unavailable for its limit,
a relay for 1 min, a Zigbee2MQTT bridge offline for 1 min, each outdoor sensor silent for 30 min, room
sensors for 1 h 30 min, window contacts unavailable for 2 h, pumps and valves for 10 min. Add any other
entity with its own rule (unavailable, silent, offline, not confirmed, or a custom condition).

## Devices and health

The Devices page lists every device Klimo uses — per Home Assistant device, with its room, model,
transport (Zigbee2MQTT, Wi-Fi, ESPHome…), state, battery with an estimate of how long it lasts, Zigbee
signal (6-hour median LQI), last report and the entities. **Notify me when**: battery below 20 %, no
connection for longer than 1 h 30 min (mains devices 10 min, integrations 3 min), a valve did not confirm
after 3 attempts, signal steadily below LQI 60. Zigbee2MQTT instances (several are supported) can resend
all targets, and do so automatically after a restart.

**Last seen and signal.** The last report is the freshest sign of life of the device: the newest report
of any of its entities in Home Assistant, or Zigbee2MQTT's own last seen. A sensor that repeats the same
value changes no state that Home Assistant passes on, so with MQTT available Klimo also listens to the
Zigbee2MQTT topics: each device message brings its link quality, battery and last seen, and
`bridge/devices` names the devices. Zigbee2MQTT adds its link-quality and last-seen entities to Home
Assistant disabled, so this is usually where the signal comes from. Turn on **last seen** in Zigbee2MQTT
(Settings → Advanced, `advanced.last_seen: ISO_8601`) for exact times, including messages kept by the
broker while Klimo restarts. Without MQTT, or when Zigbee2MQTT does not send the link quality, the signal
shows a quiet «—»: unknown, not weak — red is only for a known weak link. A device that is back shows as
back within seconds and its incident closes at once; going offline still waits for the limits above.

## Decision journal

Every decision is journaled with its reason: sources started, stopped, failed over and recovered, pumps
and their run-on, valves confirmed or retried, windows, profile changes, triggers, manual changes (with
who made them), restarts. Filter by sources, rooms, devices or system. Kept for 30 days; run periods of
sources, pumps and profiles (the **Today** strips and runtime statistics) for up to 400 days.

## Lovelace cards

Five cards — `custom:klimo-room-card`, `custom:klimo-rooms-card`, `custom:klimo-thermostat-card`,
`custom:klimo-house-card` and `custom:klimo-system-card` — with visual editors. With MQTT available the
add-on copies `klimo-cards.js` into the `www` folder of the Home Assistant configuration and registers
`/local/klimo-cards.js` as a dashboard resource (module); Settings → Integrations → Dashboard cards shows
the status and a YAML snippet for any room. YAML-mode dashboards need the resource added by hand:

```yaml
lovelace:
  resources:
    - url: /local/klimo-cards.js
      type: module
```

The cards read `sensor.klimo_hub`, `sensor.klimo_<room>_card` and `sensor.klimo_reply`, find them by
their attributes (renamed ids keep working) and send commands through `mqtt.publish` on `klimo/command`.
Texts arrive in the notification language; the card chrome follows `language` (`auto` = Home Assistant).
A target change waits 3 s for more taps, then offers an undo for 8 s. The thermostat card switches the
room between Schedule, Manual and Off; under manual control a new target asks no duration, and the
house card's **Resume schedule for the whole house** works as on the house profile tile.

## Native entities

All entities belong to one **Klimo** device and use the notification language for their names. Entity
ids are pinned when they are created; renaming a room does not change them.

| Entity | Purpose |
|---|---|
| `climate.klimo_<room>` per room | Current temperature and humidity, target (low/high between seasons), modes `off` / `auto` / `heat` / `cool` / `heat_cool` by season, presets = profiles, action. `auto` resumes the schedule, `heat` / `cool` / `heat_cool` switch to manual control, `off` switches the room off; a target lasts per Settings (until the next slot by default) or stays manual in a manual room; a preset sets the room profile until the next slot, `none` clears it. |
| `select.klimo_<room>_control` | The room's mode: `Schedule`, `Manual`, `Off` ([Manual control](#manual-control)). |
| `sensor.klimo_<room>_temperature` | Klimo's aggregated room temperature (recorded; the room charts read it back). |
| `sensor.klimo_<room>_target` | The effective target (recorded; the target band in the charts). |
| `sensor.klimo_<room>_humidity` / `_dew_point` | With humidity sensors. |
| `binary_sensor.klimo_<room>_heat_demand` / `_cool_demand` | The room asks for heat or cold. |
| `binary_sensor.klimo_<room>_window` | The effective window state (contacts or a temperature drop). |
| `sensor.klimo_<room>_state` | heating, cooling, holding, window, off… (diagnostic). |
| `button.klimo_<room>_resume_schedule` / `_boost` | Back to the schedule (ends manual, temporary and off changes); +1° for 30 min. |
| `select.klimo_house_profile` | The house profile; selecting one sets it until the next slot. |
| `select.klimo_season_mode` | `auto`, `heat`, `cool`, `off`. |
| `sensor.klimo_season` | `heating`, `neutral`, `cooling`. |
| `sensor.klimo_outdoor_average` | The average the season follows. |
| `sensor.klimo_active_source` | The lead source, or `none`. |
| `binary_sensor.klimo_heat_demand` / `_cool_demand` | Any room asks. |
| `binary_sensor.klimo_problem` / `sensor.klimo_alerts` | An open warning or critical alert / the count. |
| `sensor.klimo_power_used` | kW drawn by Klimo's electric sources (with energy entities set up). |
| `switch.klimo_schedule` | On = the house follows the schedule, off = the house schedule is paused on the current profile. |
| `button.klimo_resume_schedule` / `button.klimo_resync` | Resume the schedule for the whole house — the house profile change and every room's manual or temporary change; rooms switched off stay off / resend every target. |
| `binary_sensor.klimo_source_<id>` | A source runs; attributes: mode, role, since, power, supply, COP, fault. |
| `binary_sensor.klimo_pump_<circuit>` | A pump of the circuit runs; attributes: reason, run-on deadline. |
| `binary_sensor.klimo_trigger_<id>` | A trigger holds. |
| `switch.klimo_source_<id>_allowed`, `switch.klimo_rule_<id>`, `number.klimo_bivalent_point` | Opt-in (Settings → Behaviour → Settings as Home Assistant entities); accepted only from administrators. |
| `sensor.klimo_hub`, `sensor.klimo_<room>_card`, `sensor.klimo_reply` | Transport for the Lovelace cards (diagnostic). |

Availability uses a last-will message on `klimo/status`: when the add-on stops, every entity shows
*unavailable*. Entities that no longer exist are removed from Home Assistant, also across restarts.

### Recorder

History comes from the Home Assistant recorder — keep the room temperature and target sensors recorded.
Exclude the card transport sensors; they change often and carry large attributes:

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.klimo_hub
      - sensor.klimo_reply
      - sensor.klimo_*_card
```

## Backup & restore

- With the default SQLite driver everything lives in `/data` and is included in Home Assistant backups.
  Before a backup Klimo flushes its memory, pauses its writes and folds the write-ahead log into the
  database file, so the copy is complete; writing resumes afterwards (or after 10 minutes at the latest).
- With MariaDB/PostgreSQL the data lives in your database server and is **not** part of the add-on
  backup — back the database up on its own.
- Settings → Backup: download the whole configuration (rooms, profiles, schedules, sources, triggers,
  notifications) as one JSON file, and restore it. The file never contains secrets (the Telegram token
  and database passwords stay in the add-on options); the journal and history are not included. A
  restore is checked completely before anything is written.

## Fail-safe

| Failure | Behaviour |
|---|---|
| A room sensor | Left out; the room is counted from the others; valve readings as the last fallback. |
| An outdoor sensor | Left out; the other outdoor sensors carry on. With none left: held 30 min, then the weather entity. The heat pump is never stopped for missing data; the season stays where it is. |
| A source | Fault → the next source on the same tick → critical notification → retry after 15 min. |
| A valve | 3 attempts, a warning, then a background retry every 15 min. |
| Home Assistant ≤ 2 min | Carry on with the last states. |
| Home Assistant > 2 min | Decide for the UI, send nothing; relays with a watchdog drop within 15 min by design. After 10 min Klimo's own Telegram bot reports it. On reconnect: re-subscribe, compare every device, resend where needed. |
| MQTT | Control unaffected; entities unavailable; cards say *Klimo is offline*. Reported after 5 min. |
| Database writes | Klimo continues from memory and retries every 5 s; commands are still sent. |
| Another writer | Detected from Home Assistant's context; two conflicting writes in 30 min → back off 10 min and a warning naming the entity and whether it was an automation or a person. |
| Klimo stops | Relays with a watchdog drop within 15 min; valves get their own sensor back with the current target; the MQTT entities go unavailable. |
| Klimo restarts | Reality is adopted: a source still on keeps its minimum run; a source that dropped while Klimo was away gets its whole minimum pause, counted from when it really stopped; one switched on by someone else starts a fresh minimum run; pump run-ons and valve retries continue; expired manual changes are removed. |

Guidance:

- Keep the **boiler's own frost protection** enabled — it works when neither Home Assistant nor Klimo
  does.
- Give a boiler relay a **device-side countdown** (most Zigbee relays have one) and enter it as the
  relay's watchdog: Klimo re-arms it every 5 minutes, and a stopped Klimo cannot leave the boiler
  running.
- For heat pumps and air conditioners controlled through a `climate` entity, the device keeps its own
  regulation when Klimo is away.

## Security

Home Assistant rates the add-on **8 of 8**: the panel is reached only through Ingress, the add-on asks for
no extra privileges, and it runs under its own AppArmor profile (`apparmor.txt`, loaded by the Supervisor
with the add-on). The profile allows:

- the network — Home Assistant, the Supervisor, MQTT, an external database, Telegram;
- reading the add-on image and running only node, Docker's init and the backup hook;
- reading `/data/options.json` and what node needs from `/proc` and `/sys`;
- writing only the database in `/data` (`klimo.sqlite` and its `-wal`, `-shm`, `-journal` files), SQLite's
  temporary files in `/tmp` / `/var/tmp`, and `www/klimo-cards.js` in the Home Assistant config folder
  (creating `www` when it is missing).

Everything else is refused: the rest of the Home Assistant config folder (`secrets.yaml`, `.storage`) is
neither read nor written, the add-on's own `addon_configs` folder is not touched, the image cannot be
changed, and the kernel files Docker keeps away from containers stay closed.

A refused access is logged by the host, not by Klimo: Settings → System → Logs, source **Host** (or
`ha host logs`) shows a kernel line such as

```
audit: type=1400 audit(1761134400.123:57): apparmor="DENIED" operation="open" class="file" profile="local_klimo" name="/homeassistant/secrets.yaml" pid=2154 comm="node" requested_mask="r" denied_mask="r" fsuid=0 ouid=0
```

`profile` ends in `_klimo`, `name` is the path and `requested_mask` what was asked (`r` read, `w` write,
`x` run). Klimo's own log shows the same moment as a *permission denied* (`EACCES`) error. Please report
such a line: it means Klimo needs a path the profile does not know yet.

## Migrating from automations

Klimo writes every entity it controls; an automation writing the same entity fights it. Disable before
you switch a room over:

- "Floor pump on with the boiler, off 10 min later" → a circuit pump with the rule *a source runs* and a
  10-min run-on.
- `generic_thermostat`, Better Thermostat or a scheduler on the same valves, relays or air conditioners.
- "Valve down when the window opens" → the room's window reaction.
- "Boiler on when any valve asks for heat" → room requests and the heat chain.
- The valves' own open-window detection → leave it to Klimo (**Switch off the valves' own "open window"
  detection**).

Automations that only read Klimo's entities (`binary_sensor.klimo_heat_demand`, `sensor.klimo_season`,
the `klimo_event` event) are welcome.

## Troubleshooting

- **A card says it is waiting for Klimo data** — check Settings → Devices & Services → MQTT → **Klimo**: entities that
  are *disabled* have no state, so the cards cannot see them (they land disabled when *Enable newly added
  entities* is off for the MQTT integration). If there are none at all, check that Home Assistant's MQTT
  integration uses the same broker as the add-on (Settings → Integrations in Klimo shows it).
- **The card resource is missing** — on storage dashboards Settings → Integrations → Dashboard cards
  shows the status and **Install again**; on YAML dashboards add the resource by hand.
- **A room does not heat** — open the room: *Why it heats / waits / cools* names the reason (inside the
  band, a window, the source's minimum pause, the season, a trigger, the dew point). The decision journal
  shows the history.
- **A valve is "not confirmed"** — weak signal or a sleeping battery valve. Check the LQI on the Devices
  page, add a mains-powered Zigbee router nearby, then **Retry now**.
- **Something keeps switching the pump or boiler back** — see the *Changed by something else* warning and
  [Migrating from automations](#migrating-from-automations).
- **Temperatures in °F** — supported for display and for devices reporting °F; Klimo calculates in °C.
  If Home Assistant reports units it cannot convert, control pauses and a banner says so.
- **Telegram stops answering buttons** — another program polls the same bot token (often HA's
  `telegram_bot` integration); use one or the other.
- **"permission denied" in Klimo's log** — the host's AppArmor refused a file access; the host log names
  the path (see [Security](#security)).
