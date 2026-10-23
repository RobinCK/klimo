# Changelog

## 0.2.14

- **The room cards' 6-hour chart shows the humidity too, and reads better.** On the dashboard cards and
  on the overview the humidity is a thin pale line on a scale of its own behind the temperature. The
  temperature's scale is at least 1° tall, so a tenth of a degree no longer looks like a wave; the
  target band only shapes the scale when it is close — a room 5° warmer than its target used to get a
  flat line with a sliver of band at the bottom, now it gets its own curve (the card's pill says how
  far off the target is).

## 0.2.13

- **A collector's pump gets its meter where it is set up.** The collector's settings had the pump and
  its run-on but no place for what it draws; now its *Electricity meter* sits under the pump and is
  saved with the collector (the plug's own energy sensor is offered first). It was only on the
  Consumption tab before.

## 0.2.12

- **Long names stay inside their cards on an iPhone.** The rule that breaks a long word, inherited from
  the page, did not reach a notification's title in the Home Assistant app on iOS: «Office window
  (binary_sensor.zig_contact_window_office_contact)» ran past the card's edge. Notification titles and
  texts, the lines under a device or a decision, the hints under a checkbox and the rooms and pumps of a
  circuit now break such a word themselves, in a way Safari has long understood. Ordinary words still
  wrap whole.

## 0.2.11

- **No sideways scrolling on a phone.** A long entity id or device name (`sensor.zig_plug_warm_floor_energy`,
  a window «(binary_sensor.…)» in a notification's title, a device's entity on the Devices page) did
  not break and pushed the page wider than the screen, so the Home Assistant app let it pan sideways.
  Such words now break where they would stick out, a drop-down never grows wider than its row (a long
  choice ends in «…»), iOS does not enlarge the text on its own, and the page itself can no longer get
  wider than the screen.

## 0.2.10

- **The room's chart on a phone opens from an icon.** The room page has a chart icon at the top, next
  to the settings: it opens today's temperature, target, heating periods and humidity in a sheet from
  the bottom. The «Today» row at the foot of the page, easy to miss below the dial, is gone.

## 0.2.9

- **What each source and each pump used, in one place: System → Consumption.** For a day, a week, a
  month or a year: the house's gas, electricity and cost against the period before, a chart of gas or
  electricity, and a row for every source and pump with its gas, electricity, cost and running time
  (on a phone the amounts sit next to the name). A row opens the source's page.
- **A pump counts what its plug draws.** A floor or radiator pump on a smart plug gets an electricity
  meter: the energy sensor of the plug (offered first) or a power sensor. Choose it under *Pump
  meters* on the new tab or on the pump's card in its circuit. The pumps' electricity is added to the
  house and to the overview's energy tile.
- The electricity meter of a source is what the source itself draws — for a gas boiler, the energy
  sensor of its own plug; the source page now says so, and that pumps have meters of their own. A
  pump's plug bound as the boiler's meter before should be moved: unbind it on the boiler and choose
  it for the pump.

## 0.2.8

- **A head turned by hand keeps the number it was turned to.** Heads such as the Aqara E1 report every
  step while the knob turns; Klimo took the first step (20.5 → 21) as the new target and, half a
  minute later, wrote it back over the head that already showed 23. Klimo now waits until the knob has
  rested for 5 s and takes the last step; it writes nothing to the head meanwhile.
- **The number turned is the room's target.** It used to move the target by the same degrees — a
  head showing 21.5 for a target of 21, turned to 23, gave 22.5. Now it gives 23, in the app and on the
  cards. While the room heats the head shows half a degree more (23.5), while it rests half a degree
  less — that is how Klimo opens and closes it around its band.

## 0.2.7

- **The room's «Today» chart shows the humidity too** — a thin pale line on a scale of its own, behind
  the temperature, with the current value at its end. A few percent of drift stays a gentle slope, so
  it does not pull the eye from the temperature.

## 0.2.6

- **The boiler relay only switches on and off.** Closed — the boiler heats, open — it does not. Klimo
  no longer uses the relay's own countdown: the add-source wizard does not bind it any more, and a
  countdown bound by an earlier version is unbound once when Klimo starts. The countdown already set
  on the relay may switch it off one last time; Klimo switches it straight back on and never sets it
  again.

## 0.2.5

- **The boiler relay no longer clicks off and back on every 5 minutes.** When a boiler relay has its
  own countdown (most Zigbee2MQTT relays do, and the add-source wizard binds it as the fail-safe by
  itself), Klimo renewed it with 15 — but those relays count seconds, so the relay switched itself off
  15 s after each renewal and Klimo switched it straight back on. The countdown is now written in the
  entity's own unit (900 s, 15 min or 0.25 h) and kept within its range; a countdown shorter than the
  renewal interval is renewed more often. Nothing to change in the settings.

## 0.2.4

- **A head turned by hand becomes the room's target also when Klimo holds it off.** Out of the heating
  season, or with the house off, Klimo switches the heads off; a knob turned on such a head was simply
  ignored. Now the number turned becomes the room's target, the same as on a working head (kept until
  the next slot, put back or saved into the profile — **If a valve is turned by hand** in the room's
  settings).
- **A head closed at 7° and turned to 21° asks for 21°.** On a head Klimo held closed, at frost
  protection or at its safe value, the turn was added to the room's target as a difference (+14° → 32°).
  The number on the head is now taken as it is; on a working head a turn still moves the target by the
  same number of degrees.

## 0.2.3

- **"What heats or cools the room?" reads at a glance.** The choices sit in two columns with a short
  line each, instead of five narrow cards of wrapped text, in the add-room wizard and in the room's
  settings.
- **The schema without a manifold is cleaner.** No empty manifold column and no dashed box under the
  arrows: sources lead straight into their circuits, and **Add a manifold** is a plain button under the
  schema.
- **No more "Energy · Energy"** when energy is not set up, and no white frame around the whole schema
  after a click — the frame shows only when the schema really scrolls and is reached with the keyboard.

## 0.2.2

- **An air conditioner or heater added from New source now works.** If you added an air conditioner or
  a heater with **System → Sources → Add a source** in 0.2.x, it was saved without the link to its room
  that the engine runs it through: the source page said "does not heat / does not cool", the schema
  still drew an arrow to the room, and it never ran. It is now linked when it is added, duplicated or
  moved to another room, and one already saved without the link is repaired once when Klimo starts —
  nothing to add again.

### The room's day

- **The «Today» chart shows the whole day, also after a restart.** It is drawn from the room's own
  sensors, combined the way the room's temperature is, so an update or a restart no longer leaves a lone
  dot at midnight; Klimo's own sensor, unavailable while Klimo is stopped, only stands in for a room
  whose sensors are not recorded. The lowest and highest values come from the exact readings, the target
  band covers the whole elapsed day (the schedule fills the time Klimo was not running), and a target
  held by hand is drawn ahead until it ends.
- **It stays current without a reload.** New readings extend the line; the day is fetched again when the
  tab comes back, when Home Assistant reconnects and after midnight. An answer given before the recorder
  could be read is asked again instead of being kept, and a restart under an open page leaves the last
  full day on screen. While it loads the chart says **Loading the temperature history…**, and with
  nothing recorded it says so instead of showing one value as the day's minimum and maximum.
- **The add-on log explains a day it draws**: with `log_level: debug`, one line per day names the
  entities read, how many readings each had and which source was used.

### Adding a room

- **Ordinary radiators no longer block «Next».** **Radiators with ordinary valves** — hand valves or
  mechanical thermostatic heads — need no device, only a thermometer, and are clearly apart from
  **Radiators with smart heads**; a room may have both. Smart heads ticked by mistake offer
  **Ordinary valves** to switch over in one click.
- **Devices by kind, with «Add a device» at the top.** The devices step has one block per kind — smart
  heads, temperature and humidity, windows, air conditioner, heater, floor, dehumidifier — with the
  area's devices ticked. **Add a device** asks what the device is, then searches all of Home Assistant,
  the area first; **+ Add** in a block opens it with the kind chosen. **Room and devices** of an
  existing room uses the same dialog. A combined sensor is added once and brings both readings.
- **Dropdowns you can read**: opaque, rows that never overlap, long names cut with "…", above dialogs
  and sticky footers, opening upward near the bottom of the screen and fitting above a phone keyboard.
- **A circulation pump is a pump.** A switch whose name or device says pump, насос or circulation is
  no longer ticked as a heater, and the circuit pump picker lists it first — a free one before pumps
  already in use.

### Manifold

- **Create and edit the manifold.** The System page has a **Manifold** card: the sources feeding it,
  the circuits on it, its primary pump with run-on, flow and return temperatures and the pump's state.
  Add one with **+ Manifold** or the dashed **Add a manifold** box on the schema, open it by clicking it
  there; phones get it on the System page too. Deleting it leaves its circuits fed directly by the same
  sources and switches its pump off.
- **The primary pump runs when it should**: with any source of the manifold, for its own run-on after
  the stop (or a circuit pump's longer one), and before a boiler starts — a boiler behind a manifold
  whose circuits have no pumps of their own no longer waits for water that never moves.
- **New source asks where it sends heat or cold.** A boiler or heat pump goes into the manifold (and so
  every circuit on it) and/or straight into circuits; an air conditioner or heater picks its room on the
  same step. **Change** next to **Where it delivers** on a source's page opens the same choice.
- **The schema reads well without a manifold**: sources feeding the same circuits each get their own
  lane, instead of arrows and labels drawn over one another.

### Steppers

- **Every press changes the number.** A stepper shows as many decimals as its step, so a boiler's rated
  power goes 24 → 25 → 26 kW instead of standing on "30 kW". Steps fit the field: power by 0.1 kW below
  2 kW, 0.5 up to 10 and whole kW above, the electronics in 10 W, a room limit by 0.5°, a pause in
  seconds, a budget of 10.5 kW reads 10.5 — and they land on round values.
- **Tap the number to type it.** «2,5» and «2.5 kW» both work, Enter applies, Escape cancels, and a
  value is kept within its limits; the room target and times of day can be typed too. Hold − or + to
  move faster. Prices keep four decimals as on the bill.

## 0.2.1

- **Klimo starts again after updating.** 0.2.0 stopped at boot with `exec docker-entrypoint.sh failed:
  Permission denied`: its new AppArmor profile let Docker's init run node but not the base image's
  entrypoint script in front of it. The container now runs node directly, the profile allows every
  program of the image, and it runs in **complain mode** — it logs what it would refuse and blocks
  nothing, so an access nobody foresaw can never stop the heating control again. It will enforce once
  real installs show the rules are complete; the security rating stays 8.

## 0.2.0

### Manual control

- **A room is under the schedule, under manual control or off — and you see which.** Next to the
  target, **By schedule | Manual | Off**: a manual room holds its own target with no end, and the
  schedule, a house profile change and presence leave it alone; an off room stays off, frost protection
  stays. An open window still pauses a manual room. **Resume schedule** brings it back, and it all
  survives a restart.
- **The whole house can pause its schedule.** The house profile tile switches between **By schedule**
  and **Manual** (the current profile holds); **Resume schedule for the whole house** also ends every
  room's manual or temporary change — rooms switched off stay off.
- **The same from Home Assistant.** `select.klimo_<room>_control`, `switch.klimo_schedule` and the
  resume buttons; on `climate.klimo_<room>` `heat` / `cool` mean manual, `auto` the schedule and `off`
  off; a script can fire the event `klimo_command` (`resume_schedule`, `set_manual`, `set_off`,
  `set_target` with a duration…). Settings → Integrations shows the examples with your own entity ids.
  The thermostat card switches the mode too, and the overview filters the rooms under manual control.

### Rooms and circuits

- **Rooms with ordinary radiators.** A room with plain valves and a thermometer works as a room
  thermostat: colder than its target, it starts the boiler or heat pump and the radiator pump; warm, it
  lets them go after the run-on.
- **Circuits belong to the house.** Set up the floor or the radiators once and rooms join them. A floor
  runs **as a whole with its source** (the familiar "floor pump with the boiler, 10 more minutes after")
  or **by zones**, a valve in each room; the radiator pump runs by the rooms or with the source. Rooms
  are added to or taken off a circuit on its card, and the separate circuits 0.1.0 made per room
  **merge into one**. The pump of the loop that asks is the one that pre-runs, so the radiator pump no
  longer runs for a floor zone.
- **Edit a room after it is created.** Rename it, move it to another area, change what heats it, add,
  replace or remove a valve, a sensor, an air conditioner or a heater, join or leave a circuit, or
  delete the room. A removed head gets its own sensor, a 20° target and an unlocked keypad back, and the
  journal records every change.
- **A faster add-room wizard.** One search box finds any device in Home Assistant — the room's area
  first — and adds it in the role it fits, with a choice when the role is unclear ("Heater" or "Floor
  zone valve"). A device you pick ticks what heats the room; a relay a source already switches cannot
  be added by mistake; a thermostat can measure the room by itself; a problem is shown on the device it
  is about. On a phone the wizard is full screen.

### Energy

- **Gas, electricity and heat meters for every source**, with a **Consumption** block on the source page:
  hours of a day, days of a week or a month, months of a year, under them the outdoor temperature and
  the running time, and for a day or a week every run with what it used. Tiles show the total, the
  change against the period before, the cost, the gas per degree-day and the boiler's efficiency or the
  heat pump's COP. The readings come from Home Assistant's long-term statistics, so a meter bound today
  shows its whole recorded past; m³, ft³, litres, kWh and MJ are understood and a reset meter is
  skipped, not counted.
- **Energy prices** in Settings — the currency, a kWh of electricity, gas per m³ or per kWh and its
  calorific value — and an **Energy** tile on the overview with today's gas, electricity and cost.
- **Several outdoor sensors**, combined like a room's: median, average, the coldest (for a wall the
  afternoon sun reaches), the warmest or the first. A silent one is left out and the others carry on;
  only with none left does Klimo hold the last value and then use the weather entity.

### Devices and notifications

- **The Devices page is live.** A device that comes back shows as back within about a second, its
  incident closes and the badge drops, without a reload. With MQTT, Klimo reads Zigbee2MQTT's own link
  quality, battery and last seen — including devices that only repeat the same value — and an unknown
  signal is a quiet «—», not a weak red one.
- **Every alert names the device.** "Bedroom · Dresser: offline 20 min" instead of "sensor offline";
  two devices with the same name get their entity id; a grouped message or the morning digest gives
  each device its own line. The overview, the inbox and the room cards use the same names.
- **«i» hints** explain every Home Assistant entity of a source, every circuit and pump binding, the
  room and house controls and the consumption tiles: what it is for, what to pick and what happens if it
  stays empty.
- **Room dialogs say what is wrong**, inside the dialog, next to the field: "Already in this room as
  «Humidity»", "Already used in «Kitchen»". A refused change keeps a "Not saved: …" line in its
  section, and the humidity section lists its sensors.

### Language and look

- **English from the start.** A new install names its profiles, triggers and actions in English and
  writes notifications in English, whatever Home Assistant speaks; the panel still follows each user.
- **The panel language for everyone wins** over each Home Assistant user's language and applies at
  once; a slow Home Assistant no longer shows the panel in another language for one visit.
- **Side panels hold their shape**: the close button stays in place over a long body, a long Zigbee name
  wraps instead of scrolling sideways, and on a phone the panel opens full width at once.

### Security

- **Klimo runs under its own AppArmor profile**, which raises the add-on's security rating to 8. It
  writes only its database, SQLite's temporary files and the card bundle; `secrets.yaml` and the rest of
  the Home Assistant configuration stay out of reach.

### Fixes

- A boiler run across midnight lists the same gas under **Runs** of both days (one such run showed
  0.63 m³ on the first day and 15.97 m³ on the second).
- A room left outside a limit by a later house setting (a higher frost protection floor) no longer
  refuses every change to the room.
- The source page saves an entity picked for a flow-temperature row, and a script source with no
  «Proof it runs» starts without waiting for a read-back it never gets.
- The outdoor sensor picker lists every temperature sensor, not only the ones named "outdoor"; a floor
  thermostat is offered as a heater, not as a zone valve.
- Steppers keep their decimals (no more "3 → 3.5"), the meter dialog no longer covers its own
  **Remove** button, and the phone overview keeps its **Today** row when no source leads.

### Upgrading from 0.1.0

- The names 0.1.0 created in Ukrainian — the house, profiles, triggers and actions — become English
  once if nobody changed them; names you changed are kept, and the notification language stays as you
  chose it. Automations that pick a profile by its old name (a `climate` preset,
  `select.klimo_house_profile`) need the new one.
- The outdoor sensor becomes a list of one; existing circuits keep their behaviour, their mode read from
  the pumps' rules. A house with a floor circuit per room can merge them on the System page.

## 0.1.0

- **Every room keeps its own climate.** A room has its own targets for heating and cooling, a
  tolerance band (target 20° with −0.2 / +0.2 starts heating at 19.8° and stops at 20.2°), any number
  of thermometers combined by median, average, weight or the coldest one, window contacts and the
  devices that heat or cool it. The room page says in plain words why it heats, waits or holds, and
  when the target will be reached.
- **Klimo picks the source, not a fixed automation.** Heat pumps, gas and electric boilers, air
  conditioners and electric heaters are controlled through Home Assistant entities — a relay, a
  `climate` entity, a flow temperature, scripts or any service calls — with minimum run and pause,
  starts per hour and a check that the source really runs. A source that does not answer is replaced
  by the next one on the same tick, and takes the lead back when it recovers.
- **A heat pump and a boiler work together** alternately, in parallel or partly in parallel around a
  bivalence point, and the boiler steps in when the heat pump does not keep up. The flow temperature
  follows a weather curve.
- **Pumps run when they should, and a little longer.** Each circuit's pumps follow the rooms, the
  source or both, with a run-on that takes the remaining heat out of the loop (3 min for radiators,
  10 min for a floor), duty and standby pumps, a mixing valve and a weekly anti-seize run.
- **Floors cool without condensation.** The supply water stays above the dew point of the most humid
  room plus a margin; humid rooms, and rooms whose humidity is unknown, are left out of floor cooling;
  a dew trip rests the floor for 30 minutes and three trips in two hours lock floor cooling until
  midnight.
- **Seasons switch themselves** from the 3-day average outdoor temperature, with hysteresis, a minimum
  dwell and month limits — or set heating only, cooling only or off by hand.
- **Profiles and schedules** — Home, Away, Eco, Night, Guests and Vacation, a weekly house schedule,
  room schedules and exceptions, presence ("everyone left", "someone is coming"), calendar events with
  pre-heating and vacations, in a priority order you choose. Every manual change has an end and an undo.
- **Blackouts on a budget.** Triggers watch the grid, the sun, the battery and the tariff; while the
  grid is down the electric sources share a power budget, start one by one, the least important is
  shed first, and below 20 % battery only frost protection runs. Free solar power can be stored as
  heat.
- **Radiator valves that do what the room needs.** The room temperature is written into the valve as
  its external sensor (or a calibration offset, on/off setpoints, or the opening in percent), every
  command is confirmed, the battery is spared, and a valve turned by hand keeps its value until the next
  slot, is reverted or saved into the profile.
- **A native `climate` entity for every room** through MQTT discovery, plus the house profile and the
  season mode as selects, sensors for the aggregated temperature, the target, humidity and demand, and
  buttons — usable from any thermostat card, HomeKit, voice assistants and automations.
- **Five Lovelace cards** — a room, all rooms, a thermostat dial with undo, the house and the system —
  deployed and registered automatically when MQTT is available.
- **Alerts that reach the right person.** The Home Assistant app with action buttons, Telegram through
  Home Assistant or Klimo's own bot (which keeps working while Home Assistant is down), the HA sidebar
  and an automation event; critical alerts bypass silent mode, repeat and escalate until somebody
  presses "Got it"; quiet hours with a morning digest, grouping, daily and weekly summaries.
- **Every decision explained.** The decision journal, a live schema of sources, circuits and rooms,
  "why it is so" for the whole plant, a what-if under frost, blackout or summer conditions, and a
  devices page with batteries, Zigbee signal and what needs a hand.
- **Safe when something fails.** A silent sensor is left out, a lost outdoor sensor falls back to the
  weather entity, a relay with a device countdown drops within 15 minutes if Klimo stops, and after a
  restart minimum run and pause, pump run-ons and valve retries continue where they were. A change by
  another automation is recognised and reported instead of fought.
- **Built for the household.** A mobile-first panel in English and Ukrainian that follows the Home
  Assistant language, light and dark, everyone controls their rooms and only administrators change the
  configuration; the configuration is backed up with Home Assistant and can be exported as one file.
