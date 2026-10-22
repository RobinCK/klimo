# Changelog

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
