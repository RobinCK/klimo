# Changelog

## 0.2.42

- **The heat characteristic's chart reads cleanly.** The difference axis no longer steps by 2.5 K (which
  rounded to «3, 5, 8, 10, 13»), and the heat axis stops at zero instead of following the line below it,
  in the widget and on System → Consumption alike.
- The README shows the widgets in English.

## 0.2.41

- **Four dashboard widgets.** New Lovelace cards that chart the house rather than control it, each with a
  visual editor and a YAML snippet in Settings → Integrations:
  - **Rooms and heating** (`klimo-heating-card`): every room on one temperature scale — where it is against
    its target, what it is doing, the valve its heads report (or *pump* for a floor) — with how many rooms
    ask, their mean and the outdoor temperature. A row opens the room's details.
  - **Heat characteristic** (`klimo-heat-loss-card`): the house's heat loss in W/K, the heat it needs at
    −10 °C and −20 °C and the outdoor temperature above which it needs none.
  - **Boiler cycles** (`klimo-cycles-card`): a source's runs over the last 24 hours with the pumps of the
    floors that follow it, the hourly outdoor temperature, the starts per hour, the average run and pause
    and the short runs.
  - **Thermal inertia** (`klimo-inertia-card`): how fast the house cools without heat, from the boiler's
    night pauses of the last ten days — the time constant τ, the heat capacity, and the next 12 hours at
    0, −10 and −20 °C outdoors with the hours to 18 °C and 16 °C.
  They read the new `sensor.klimo_stats`, refreshed every 5 minutes; exclude it from the recorder like the
  other card sensors. The hub now carries each room's humidity, heating kind and valve opening.
- **The heat characteristic on System → Consumption.** Day by day over the last 30 days, the heat the
  sources gave (gas × calorific value × the boiler's efficiency, plus the heat meters of sources without
  gas) against the difference between the rooms and the outdoors, the line through the heating days, and
  what it says: heat loss, the load in a frost, the balance temperature. *Settings → Energy prices* has a
  new field for the boiler's efficiency (90 % by default).

## 0.2.40

- **No empty strip above the page on a phone.** Since 0.2.37 the panel left room for the notch or the
  Dynamic Island at the top of every page, the toasts and the setup wizard, and in the Home Assistant app,
  where the panel sits under Home Assistant's own toolbar, that showed as an empty band above the title.
  The page, its header, the toasts and the wizard start where they did before; only a tall sheet still
  stops short of the island. The tab bar keeps clear of the home bar as in 0.2.37.

## 0.2.39

- **A room's consumption counts the pumps' electricity too.** The energy sensor of a pump's plug was
  shown in the pump's own row only, so a room's share had the gas and the electricity of its sources
  and none of what the pumps working for it drew. A pump's meter is now shared out like a source's: each
  hour it ran, between the rooms of its loop (a collector's pump, of the collector's loops) by how long
  each took heat or cooling meanwhile. A floor's pump goes to the floor's rooms while it runs, on top of
  their share of the boiler for the same time; a radiator pump to the rooms that asked. Its standby and
  weekly exercise go under *No room took it*. *Where it came from* lists the pump with the room's part,
  the share tiles count it in «of what all the sources and pumps used», and *By room* on System →
  Consumption adds up the same numbers.

## 0.2.38

- **The room sheet of the dashboard cards keeps clear of the notch and the Dynamic Island.** A tall sheet
  grew up to the top of the phone's screen, so its header (the room, its mode and the close button) went
  under the status bar and the island; it now stops short of the top inset as well as the home bar, on
  a phone and on an iPad.

## 0.2.37

- **Nothing hides under the iPhone's notch or Dynamic Island.** iOS gives its safe-area insets to the top
  page only, so inside Home Assistant's frame the panel saw none: when the frame reached the top of the
  screen, the page's header, the toasts and a tall sheet went under the island, and the tab bar sat on
  the home bar. The panel now reads the insets of the page around it, less where the frame starts (under
  Home Assistant's toolbar nothing changes), and keeps the header, the toasts, the sheets, the wizard and
  the tab bar clear of them; a strip in the page's colour covers the island while the page scrolls.

## 0.2.36

- **The phone's room list lost its pencils.** A pencil beside every room card, outside it, opened the
  room's devices; it did not match the other lists and narrowed every card. The cards now take the full
  width alike — a tap opens the room, and its devices and heating are under **Edit room** there.

## 0.2.35

- **A room on a wide screen comes in three parts: Overview, Consumption, Settings.** The page held the
  room's state, its consumption and every setting one under another (eight screens long). The
  overview now shows the temperature, the target, why and today's chart, and the room at a glance — a
  row per part of its settings with its state («What heats · Heating», «Temperature sensors · 19.8°»,
  «Radiator valves · in sync»), each leading to that part. The settings list their parts with a live
  summary beside the one that is open, as the phone's settings do. Each part is its own address, and
  another room in the tabs opens on the same part, so settings compare room by room.

## 0.2.34

- **The day chart on a phone takes the full width.** Its temperature scale moved inside the plot (the
  column for it pushed the chart to the right), and the row of times above it is gone on a phone — the
  times are in the list of changes right under it.
- **Day types on a phone stand one under another**, as cards with their full name, their plan and its
  times, and **New day type** under them.

## 0.2.33

- **The Schedule page has tabs: Schedule, Profiles, Priority.** Each is its own address and the page
  shows one at a time, on a wide screen as on a phone (where Priority was a button at the end of the
  profiles).
- **A profile is lighter to work with.** Its name, its heating and cooling targets and when it switches
  on by itself come first; what each room does in it and its colour and icon fold away until opened,
  with a summary («2 with their own setting»); **Duplicate** and **Delete** moved to its end.
- **Quick setup took the place of «Today like a weekend»** in the «now» line, so the schedule's header
  keeps only whose schedule it is, and the phone loses the button at the bottom. A day like a weekend is
  still an exception in **Exceptions**.
- **The times above the day chart** take up to three rows, so three changes close together no longer
  overlap.

## 0.2.32

- **The schedule no longer slides sideways on a phone.** A finger on the day chart scrolls the page — a
  swipe that went a little sideways used to drag a stretch or a line along the day; a tap still selects
  a stretch, the times above the chart still drag, and with a profile picked under **Draw a stretch** a
  finger paints. The row of profiles no longer bleeds to the screen's edges, and a time near midnight
  ends at its line instead of sticking out of the chart.

## 0.2.31

- **The schedule on a phone is compact.** The «now» card puts the profile and **Today like a weekend**
  side by side; the day types are small tabs with a «+» for a new one; heating or cooling is one switch
  without a repeated title; the profiles to draw with are one row that scrolls sideways (the hint shows
  only while one is picked); the days of the type moved under the list of changes, with what they do;
  the times above the chart no longer overlap, and «until … the next day» is shorter.

## 0.2.30

- **Day types split and join the way you expect.** Switching a day off under a type makes it a type of
  its own and keeps you on the type you were editing, so Saturday and then Sunday can be taken out one
  after the other; switching Sunday on under Saturday puts them together as «Weekends». **New day type**
  picks the days of a type at once (a pair such as Saturday and Sunday). Types made by hand are
  remembered in the browser, even when their days have the same plan.
- **Dragging keeps things closed.** Moving a change on the chart or in the list no longer opens its
  details; an open change stays open and follows its stretch.
- **Dragging a change in the list** leaves its shadow in place, a copy follows the pointer and a line
  shows where it will go; the first and last places are easy to reach, and the page scrolls when the
  pointer comes near the window's edge.

## 0.2.29

- **The changes of a day swap places.** Each change in the list under the chart has a handle: drag it up or
  down (or press the arrow keys on it) to put that stretch in another place of the day. Every stretch keeps
  its length and the first one keeps its start time, so «Away 6 h» and «Home 12 h» trade places as whole
  periods; equal neighbours merge. One undo takes it back.

## 0.2.28

- **The day is edited right on the chart.** Drag the line between two stretches (on the chart or on the
  profile ribbon) to move that change; grab a stretch in the middle to move it whole, its start and end
  together; pick a profile under **Draw a stretch** and drag over the chart to paint it there — the
  painted stretch replaces what was under it on every day of the type. A click on a stretch opens its
  change below.

## 0.2.27

- **The weekly schedule is edited as day types and changes.** Days with the same plan form one day type
  («Weekdays», «Mon–Thu», «Friday», «Weekends»); editing a type changes all its days, so «Repeat on» and
  the three «Copy to…» buttons are gone. Switch a day on under the type to give it this plan, switch it
  off to edit it alone.
- **A day is a list of changes, not blocks**: «17:30 → Home» holds until the next change, and a night from
  23:00 to 06:30 is one change instead of two blocks. A change opens in place: its time (−/+ 15 min or
  typed), its profile with the target it gives, and deleting it; **Add a change** splits the longest stretch.
- **The targets are on sight**: the day is drawn as the heating or the cooling target over the profile
  stretches, with the switch times above to drag (or to move with the arrow keys); each change shows both
  targets, the one of the season larger. A room schedule shows the whole house's plan underneath to compare.
- **What runs now**: a line on top tells what the schedule gives right now, until when and what comes next;
  **Today like a weekend** turns today into a Saturday with one tap (an exception), **Back to the week**
  undoes it.
- **Quick setup** asks when you wake up, leave, come back and go to bed, on weekdays and at the weekend
  (or that someone stays at home), and writes the week from the answers, with one undo.
- **The schedule moves in 15-minute steps** (it was 30).

## 0.2.26

- **Paging the room's chart no longer makes it jump.** The profile strip above it stays and shows the
  plan of the day on screen (no now marker on a past day), and the four numbers under the chart keep
  their place with dashes while a day loads.

## 0.2.25

- **The room's chart pages back through the days.** Arrows above the room's day chart open yesterday and
  the days before, as long as Home Assistant's recorder keeps them: the temperature, the target band,
  when the room heated, the minimum, maximum and heating time of that day, with the crosshair. **Today**
  returns to the live day; past the oldest kept day the back arrow stops. On a phone the same arrows
  are in the chart's sheet.

## 0.2.24

- **Day by the hour: who asked for heat and what ran.** The overview's day timeline now has one row for
  when any room asked for heat (or cooling) and, under it, a row for each room that asked, with how long
  and a link to the room; the rooms that never asked are named below. Point at the bars (or touch them)
  for a line through every row at that moment and the list of what ran then; the arrows step through the
  days before. On a phone the **Today** row opens it as a page of its own, label above bar, with the
  moment picked kept in sight above the rows.
- **The house card shows the day**: a tap on the **Source** or **Pumps** tile opens the same day by the
  hour, read from Home Assistant's history — when each source and pump ran and which rooms asked for
  heat, with the days before.
- **The weekly schedule is edited by hand on the strips**: drag the line between two blocks to move it,
  drag along a day to draw a new block; the time shows while dragging, the days that repeat the edited
  one move along, and every drag can be undone. On a phone the line between two blocks has a grip to drag,
  and a block's sheet can split it.

## 0.2.23

- **A room's device opens Home Assistant's own dialog.** In the room's settings, under *Room and devices*,
  a tap on a device's name or value — a valve, a temperature or humidity sensor, a window contact, an
  air conditioner — opens Home Assistant's dialog of that entity with the history of its state, over the
  panel. Outside Home Assistant (the add-on's own port) the rows stay as they were.

## 0.2.22

- **A radiator valve is opened fully while its room asks for heat.** The room started at 19.7°, warmed to
  21° and fell back while asking for 22° until the valve was turned to the maximum by hand: a valve such as
  the Aqara E1 throttles on its own sensor and curve degrees short of a setpoint near the target (22.5°,
  or 24° since 0.2.19). Now an open valve gets the top of its range, as by hand, and once the room is warm
  a setpoint below the target — two writes a cycle.
- **«Not warming»**: a room asking for heat, a source running for it, that has not been warmer than its
  best for 45 min shows it (since when, at what temperature) and its valves get their setpoint again
  every 15 min. Measured on the best temperature, not on the half-hour trend a sensor by the door that
  reports seldom never gave.
- **Crosshair on the room's day chart**: under the pointer (or a finger) a vertical and a horizontal line,
  the time on the axis, the temperature on the scale, and the target, humidity and heating then.

## 0.2.21

- **A valve's card says what it was told and what it holds.** Room settings → *Radiator valves* shows,
  beside the valve's own sensor, the setpoint Klimo sent and the setpoint the valve reports holding, the
  valve's position when it reports one, and the room temperature sent into it with the external-sensor
  method — so a valve that keeps its own number, or closes while told to open, shows it.

## 0.2.20

- **The dashboard cards say how fresh a room's temperature is**: quietly, right of the temperature, when
  the room's temperature sensors last reported («3 хв тому») — in the warning colour after an hour of
  silence.
- **Every sensor in a room's details**: the card's details list the room's own sensors under
  **Sensors**, each with its reading, when it last reported and whether Klimo counts it.
- **A tap on a value opens its chart**: every row of the details — the room's temperature, humidity,
  target, a single sensor — opens Home Assistant's own dialog of that entity with its history.

## 0.2.19

- **A radiator valve no longer closes while its room still asks for heat.** An open valve got a setpoint of
  the target plus the tolerance (22.5° for 22°): a valve that throttles near its setpoint (the Aqara E1
  does) or reads its own sensor by the hot radiator closed short of the target, and the boiler ran on
  with no heat going in. While the room asks, the setpoint now stays at least 2° above what the valve
  reads itself — written again only when the reading comes within 1° — so the valve stays open until
  Klimo closes it at the target.
- **A safety net for a room that does not warm**: asking for heat for 40 min with a source running for it
  while its temperature rises less than 0.2° an hour, its valves are opened fully and the room's
  explanation says so.

## 0.2.18

- **An Aqara E1 valve regulates on the room's sensor.** Klimo sent the room temperature into the valve but
  did not find its switch to the external sensor — on the E1 it is called plainly *sensor* — so the valve
  kept regulating on its own sensor by the hot radiator: it closed before the room was warm while the
  boiler ran on. The switch is now recognised, and valves already set up get it filled in within two
  minutes of the update (nothing they have is replaced).
- **A flame or a snowflake on the room tabs** while a room asks for heat or for cooling.
- **Order of the rooms**: a button after **+** in the room tabs (on the phone, beside it on *Rooms*) drags
  the rooms into the order the tabs, the overview and the cards use.

## 0.2.17

- **Gas is blue and electricity yellow on the consumption charts** — of the house, a source and a room
  (gas was plum, electricity grey).

## 0.2.16

- **Each room's own consumption.** A room's page has a **Consumption** section under the hero (on a
  phone, the *Consumption* row of the room): its gas, electricity and cost for a day, a week, a month or
  a year, against the period before; how long it was heated or cooled; its part of what all the sources
  used; a chart per hour, day or month with the outdoor temperature and the heated time under the bars;
  and **Where it came from** — the boiler's gas, its plug, the heat pump, the room's own air conditioner — with
  the room's part of each and how long it took heat while that source ran. The numbers are the same as
  in *System → Consumption → By room*, whose rows now open the room on the same period. A meter only the
  room's own sources have is all the room's, standby included.
- **A Zigbee2MQTT instance you removed stays removed.** Every bridge on the broker announces itself with a
  retained message, so a removed second Zigbee2MQTT (say, the garden's) came back after each update or
  restart. Klimo now remembers the base topic of an instance removed by hand and does not add it again;
  adding an instance with that topic by hand brings it back. One removed before this version comes back
  once more — remove it again.
- The consumption charts keep their tooltip inside the screen on a phone. A date outside the years
  2000–2099 in a consumption link is refused instead of failing.

## 0.2.15

- **What each room cost.** *System → Consumption* has a **By room** block: each hour a source ran,
  what its meter counted is shared out between the rooms that took its heat meanwhile, by how long each
  took it — two rooms asking the whole hour get half each, one for the whole hour and one for half of
  it two thirds and one third. A warm floor that runs with the source counts while its pump runs. What
  ran while no room took it (run-on, frost protection, a stove on the gas meter) is shown apart; pumps
  keep their own rows. A row opens its room. When rooms asked for heat is now kept 400 days instead of
  30, so a year can be shared out too.

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
