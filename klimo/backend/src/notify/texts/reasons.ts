import type { ReasonCode } from '../../shared/model';
import type { Row, Vars } from './format';

const isCool = (v: Vars) => v.mode === 'cool';

/** Every reason code in words, [en, uk]. Params per code: the reason-code table of the engine. */
export const REASONS: Record<ReasonCode, Row> = {
  // «Чому гріє»: the room latch
  'why.heat.below_on': ['{t} ≤ {on} (target {T} − {b}) — the room asks for heat.', '{t} ≤ {on} (ціль {T} − {b}) — кімната просить тепла.'],
  'why.heat.in_band_on': ['{t} is within {on}–{off}: heating until it reaches {off}.', '{t} у межах {on}–{off}: гріє, доки не стане {off}.'],
  'why.heat.in_band_off': ['{t} is within {on}–{off}: heating starts again at {on}.', '{t} у межах {on}–{off}: знову гріє з {on}.'],
  'why.heat.above_off': ['{t} ≥ {off} — warm enough.', '{t} ≥ {off} — досить тепло.'],
  'why.cool.above_on': ['{t} ≥ {on} (target {T} + {a}) — the room asks for cooling.', '{t} ≥ {on} (ціль {T} + {a}) — кімната просить прохолоди.'],
  'why.cool.in_band_on': ['{t} is within {off}–{on}: cooling until it reaches {off}.', '{t} у межах {off}–{on}: охолоджує, доки не стане {off}.'],
  'why.cool.in_band_off': ['{t} is within {off}–{on}: cooling starts again at {on}.', '{t} у межах {off}–{on}: знову охолоджує з {on}.'],
  'why.cool.below_off': ['{t} ≤ {off} — cool enough.', '{t} ≤ {off} — досить прохолодно.'],
  'why.dual.in_band': ['{t} is between {lo} and {hi} — nothing needs to run.', '{t} між {lo} і {hi} — нічого не потрібно вмикати.'],
  'why.cold_guard': ['Between seasons, but {t} is below {guardC} — heating anyway.', 'Міжсезоння, але {t} нижче {guardC} — гріє все одно.'],

  // «Чому гріє»: room states
  'why.no_data': ['No temperature data — the radiator valves hold a safe {safeC}.', 'Немає даних про температуру — головки тримають безпечні {safeC}.'],
  'why.fallback_trv': [
    'All room sensors are offline — using the radiator valves’ own readings ({n}).',
    'Датчики кімнати не на зв’язку — рахую за показами головок ({n}).',
  ],
  'why.window.pause': [
    'Window open since {since} — heating and cooling paused[, resuming at {resumeAt}].',
    'Вікно відкрите з {since} — опалення й охолодження на паузі[, відновлю о {resumeAt}].',
  ],
  'why.window.eco': ['Window open — using the «{profileId}» target.', 'Вікно відкрите — ціль із профілю «{profileId}».'],
  'why.window.lower': [
    (v) => (Number(v.deltaC) > 0 ? 'Window open — target raised by {deltaC}.' : 'Window open — target lowered by {deltaC}.'),
    (v) => (Number(v.deltaC) > 0 ? 'Вікно відкрите — ціль піднято на {deltaC}.' : 'Вікно відкрите — ціль знижено на {deltaC}.'),
  ],
  'why.window.notify': ['Window open since {since} — only a reminder will be sent.', 'Вікно відкрите з {since} — лише нагадаю.'],
  'why.window.delay': ['Window open — pausing at {at} if it stays open.', 'Вікно відкрите — якщо не закриють, пауза о {at}.'],
  'why.window.resuming': ['Windows closed — resuming at {at}.', 'Вікна закриті — відновлю о {at}.'],
  'why.window.ignored': ['The window is ignored until {until}.', 'Вікно ігнорується до {until}.'],
  'why.window.virtual': [
    'The temperature dropped {dropC} within minutes — treated as an open window.',
    'Температура впала на {dropC} за кілька хвилин — вважаю, що відкрите вікно.',
  ],
  'why.airing': ['Airing — paused until {until}.', 'Провітрювання — пауза до {until}.'],
  'why.off.room': ['The room is switched off[ until {until}].', 'Кімнату вимкнено[ до {until}].'],
  'why.off.profile': ['Off in «{profileId}».', 'Вимкнено в «{profileId}».'],
  'why.off.house_mode': ['The house is switched off — only frost protection works.', 'Будинок вимкнено — працює лише захист від морозу.'],
  'why.off.frost_only': ['«{profileId}»: frost protection only ({frostC}).', '«{profileId}»: лише захист від морозу ({frostC}).'],
  'why.frost': ['{t} is below the frost limit {frostC} — heating to protect the room.', '{t} нижче межі захисту {frostC} — гріє, щоб захистити кімнату.'],
  'why.overheat': ['{t} is above {maxC} — heating in the room is closed.', '{t} вище {maxC} — опалення в кімнаті закрито.'],
  'why.monitor.control_disabled': ['Monitoring only — control is switched off for this room.', 'Лише моніторинг — керування цією кімнатою вимкнене.'],
  'why.monitor.no_emitter': [
    (v) => (isCool(v) ? 'Nothing in this room can cool.' : 'Nothing in this room can heat.'),
    (v) => (isCool(v) ? 'У цій кімнаті нема чим охолоджувати.' : 'У цій кімнаті нема чим гріти.'),
  ],
  'why.monitor.dew_blocked': [
    'Floor cooling is blocked — at the dew point {dewC} the water would have to be warmer than {maxSupplyC}.',
    'Охолодження підлогою заблоковано — при точці роси {dewC} вода мала б бути теплішою за {maxSupplyC}.',
  ],
  'why.monitor.too_humid': [
    'Floor cooling is off — humidity {rh} is above {maxPct}, the floor could sweat.',
    'Охолодження підлогою вимкнене — вологість {rh} вища за {maxPct}, підлога може запотіти.',
  ],
  'why.monitor.humidity_unknown': [
    'Floor cooling is off — no humidity reading[ since {since}], so the dew point is unknown.',
    'Охолодження підлогою вимкнене — немає даних про вологість[ з {since}], тож точка роси невідома.',
  ],
  'why.monitor.dew_hold': [
    'Floor cooling rests after the dew point guard stopped it — back at {until}.',
    'Охолодження підлогою на паузі після спрацювання захисту від роси — знову о {until}.',
  ],
  'why.monitor.dew_lockout': [
    'Floor cooling is locked: the dew point guard stopped it {trips|time|times} — until {until} or a reset.',
    'Охолодження підлогою заблоковано: захист від роси спрацював {trips|раз|рази|разів} — до {until} або до скидання.',
  ],
  'why.season_blocks': [
    (v) => (isCool(v) ? 'Cooling is not allowed now ({season}).' : 'Heating is not allowed now ({season}).'),
    (v) => (isCool(v) ? 'Охолодження зараз не дозволене ({season}).' : 'Опалення зараз не дозволене ({season}).'),
  ],

  // «Чому гріє»: details
  'why.min_request': ['Keeps asking at least until {until}.', 'Просить щонайменше до {until}.'],
  'why.served': ['{sourceId} is working[ since {since}].', '{sourceId} працює[ з {since}].'],
  'why.trvs_open': ['Radiator valves open: {n} of {total}.', 'Головки відкриті: {n} з {total}.'],
  'why.rooms_asking': ['Rooms asking for heat: {n} of {total}.', 'Просять тепла кімнат: {n} з {total}.'],
  'why.trvs_closed': ['Radiator valves closed ({n}).', 'Головки закриті ({n}).'],
  'why.ac_running': ['{sourceId} is running: {mode}.', '{sourceId} працює: {mode}.'],
  'why.ac_assist': ['{sourceId} helps: the room is {deficitC} short of its target.', '{sourceId} допомагає: до цілі бракує {deficitC}.'],
  'why.ac_dry': ['{sourceId} dries the air — humidity {rh}.', '{sourceId} осушує повітря — вологість {rh}.'],
  'why.trigger_heat': ['{sourceId} heats because «{triggerId}» is active.', '{sourceId} гріє, бо активний тригер «{triggerId}».'],
  'why.preheat': ['Preheating for «{profileId}» at {at} ({T}).', 'Завчасно прогріває до «{profileId}» о {at} ({T}).'],
  'why.rule_offset': ['Rule «{ruleId}» shifts the target by {deltaC:sdelta}.', 'Правило «{ruleId}» зміщує ціль на {deltaC:sdelta}.'],
  'why.weather_comp': ['Outdoor {toutC}: the target is corrected by {shiftC}.', 'Надворі {toutC}: ціль скориговано на {shiftC}.'],
  'why.floor_limit': ['The floor is {floorC} — at its limit {maxC}.', 'Підлога {floorC} — на межі {maxC}.'],
  'why.eta.reach': [
    (v) => (v.confident === false ? '≈ {minutes} to {toC} (around {at}). A rough estimate for now.' : '≈ {minutes} to {toC} (around {at}).'),
    (v) => (v.confident === false ? '≈ {minutes} до {toC} (близько {at}). Поки що оцінка приблизна.' : '≈ {minutes} до {toC} (близько {at}).'),
  ],
  'why.eta.cooling_down': ['Cooling down by about {rate}.', 'Остигає приблизно на {rate}.'],
  'why.eta.warming_up': ['Warming up by about {rate}.', 'Нагрівається приблизно на {rate}.'],

  // waiting for a source
  'wait.min_off': ['{sourceId} is on a pause · starts at {until}', '{sourceId} на паузі · старт о {until}'],
  'wait.max_starts': ['{sourceId} has used its starts for this hour · next at {until}', '{sourceId} вичерпало запуски на цю годину · наступний о {until}'],
  'wait.trigger': ['{sourceId} waits for «{triggerId}»', '{sourceId} чекає на «{triggerId}»'],
  'wait.condition': ['{sourceId} waits for its run condition', '{sourceId} чекає на умову запуску'],
  'wait.budget': ['{sourceId} waits for power: {usedKw} of {budgetKw} in use', '{sourceId} чекає на потужність: зайнято {usedKw} з {budgetKw}'],
  'wait.stagger': ['{sourceId} starts at {until} (one after another)', '{sourceId} стартує о {until} (по черзі)'],
  'wait.starting': ['{sourceId} is starting', '{sourceId} запускається'],
  'wait.prerun': ['The pump runs first · {sourceId} starts at {until}', 'Спершу розганяється насос · {sourceId} стартує о {until}'],
  'wait.changeover': ['{sourceId} is switching between heating and cooling · until {until}', '{sourceId} перемикається між теплом і холодом · до {until}'],
  'wait.piggyback': ['Waits until another room starts a source', 'Чекає, поки джерело запустить інша кімната'],
  'wait.no_source': [
    (v) => (isCool(v) ? 'Nothing can cool right now' : 'Nothing can heat right now'),
    (v) => (isCool(v) ? 'Зараз нема чим охолоджувати' : 'Зараз нема чим гріти'),
  ],
  'wait.fault': ['{sourceId} has a fault', '{sourceId} в аварії'],
  'wait.season': [
    (v) => (isCool(v) ? 'Cooling is off for the season' : 'Heating is off for the season'),
    (v) => (isCool(v) ? 'Охолодження вимкнене сезоном' : 'Опалення вимкнене сезоном'),
  ],
  'wait.lock': ['{sourceId} is switched off[ until {until}]', '{sourceId} вимкнено[ до {until}]'],

  // target change previews
  'preview.same': ['Same target — nothing will be sent', 'Ціль та сама — нічого не надішлю'],
  'preview.start_heat': ['Starts heating · ≈ {etaMin} to {toC}, around {at}', 'Почне гріти · ≈ {etaMin} до {toC}, близько {at}'],
  'preview.keep_heat': ['Keeps heating · ≈ {etaMin} to {toC}, around {at}', 'Продовжить гріти · ≈ {etaMin} до {toC}, близько {at}'],
  'preview.heat_to_band': ['Will heat to {offC}, then hold', 'Грітиме до {offC}, далі тримає'],
  'preview.stop_heat': ['Heating will stop · already {t}', 'Опалення зупиниться · вже {t}'],
  'preview.no_heat_needed': ['No heating needed · already {t}', 'Гріти не потрібно · вже {t}'],
  'preview.no_change_band': ['No change · within {lo}–{hi}', 'Без змін · у межах {lo}–{hi}'],
  'preview.start_cool': ['Starts cooling · ≈ {etaMin} to {toC}, around {at}', 'Почне охолоджувати · ≈ {etaMin} до {toC}, близько {at}'],
  'preview.keep_cool': ['Keeps cooling · ≈ {etaMin} to {toC}, around {at}', 'Продовжить охолоджувати · ≈ {etaMin} до {toC}, близько {at}'],
  'preview.cool_to_band': ['Will cool to {offC}, then hold', 'Охолоджуватиме до {offC}, далі тримає'],
  'preview.stop_cool': ['Cooling will stop · already {t}', 'Охолодження зупиниться · вже {t}'],
  'preview.no_cool_needed': ['No cooling needed · already {t}', 'Охолоджувати не потрібно · вже {t}'],
  'preview.gap_too_small': ['The bounds must be at least {gapC} apart', 'Межі мають бути щонайменше на {gapC} одна від одної'],
  'preview.writes_profile': ['Becomes the «{profileId}» target', 'Стане ціллю «{profileId}»'],
  'preview.room_off': ['The room is off in «{profileId}»', 'У «{profileId}» кімната вимкнена'],
  'preview.window_applies_later': ['A window is open — the new target applies once it is closed', 'Вікно відкрите — нова ціль діятиме після закриття'],

  // house profile and house mode previews
  'house.preview.same': ['«{profileId}» is already active', '«{profileId}» уже діє'],
  'house.preview.will_heat': ['{n|room|rooms} will start heating[ · {sourceId}]', 'Почне гріти: {n|кімната|кімнати|кімнат}[ · {sourceId}]'],
  'house.preview.heating_stops': ['Heating stops in {n|room|rooms}', 'Опалення зупиниться: {n|кімната|кімнати|кімнат}'],
  'house.preview.will_cool': ['{n|room|rooms} will start cooling[ · {sourceId}]', 'Почне охолоджувати: {n|кімната|кімнати|кімнат}[ · {sourceId}]'],
  'house.preview.cooling_stops': ['Cooling stops in {n|room|rooms}', 'Охолодження зупиниться: {n|кімната|кімнати|кімнат}'],
  'house.preview.no_change': ['Nothing changes right now', 'Зараз нічого не зміниться'],
  'house.chip.up': ['↑ target: {n|room|rooms}', '↑ ціль: {n|кімната|кімнати|кімнат}'],
  'house.chip.down': ['↓ target: {n|room|rooms}', '↓ ціль: {n|кімната|кімнати|кімнат}'],
  'house.chip.frost_stays': ['frost protection {frostC} stays', 'захист від замерзання {frostC} лишається'],
  'house.chip.off': ['{n|room|rooms} off', 'вимкнено: {n|кімната|кімнати|кімнат}'],
  'mode.preview.stops': ['{sourceId} stops · affects {n|room|rooms}', '{sourceId} зупиниться · стосується {n|кімнати|кімнат|кімнат}'],
  'mode.preview.starts': ['{sourceId} starts · affects {n|room|rooms}', '{sourceId} запуститься · стосується {n|кімнати|кімнат|кімнат}'],
  'mode.preview.no_change': ['Nothing changes right now', 'Зараз нічого не зміниться'],
  'mode.preview.frost_only': ['Only frost protection will work', 'Працюватиме лише захист від морозу'],

  // why a source cannot run
  'source.blocked.min_off': ['Minimum pause — can start at {until}', 'Мінімальна пауза — запуск о {until}'],
  'source.blocked.min_run': ['Minimum run time — can stop at {until}', 'Мінімальний час роботи — зупинка о {until}'],
  'source.blocked.max_starts': ['{n|start|starts} this hour — next at {until}', '{n|запуск|запуски|запусків} за годину — наступний о {until}'],
  'source.blocked.budget': ['Power budget: {usedKw} of {budgetKw} in use, needs {needKw}', 'Бюджет потужності: зайнято {usedKw} з {budgetKw}, потрібно {needKw}'],
  'source.blocked.stagger': ['Starts one after another — at {until}', 'Запуск по черзі — о {until}'],
  'source.blocked.condition': ['Its run condition is not met', 'Умова запуску не виконується'],
  'source.blocked.trigger': ['Runs only with «{triggerId}»', 'Працює лише з «{triggerId}»'],
  'source.blocked.season': ['Not allowed: {season}', 'Не дозволено: {season}'],
  'source.blocked.outdoor_limit': ['Outdoor {toutC} is beyond its limit {limitC}', 'Надворі {toutC} — за межею роботи {limitC}'],
  'source.blocked.bivalence': ['Below the bivalence point {pointC} (outdoor {toutC})', 'Нижче точки бівалентності {pointC} (надворі {toutC})'],
  'source.blocked.cutoff': ['Warm outside ({toutC} above {cutoffC}) — heating not needed', 'Надворі тепло ({toutC}, вище {cutoffC}) — опалення не потрібне'],
  'source.blocked.changeover': ['Pause between heating and cooling — until {until}', 'Пауза між теплом і холодом — до {until}'],
  'source.blocked.lock': ['Switched off[ until {until}]', 'Вимкнено[ до {until}]'],
  'source.blocked.fault': ['Fault: {code}[ — retry at {retryAt}]', 'Аварія: {code}[ — повтор о {retryAt}]'],
  'source.blocked.unavailable': ['{entityId} unavailable[ since {since}]', '{entityId} недоступна[ з {since}]'],
  'source.blocked.rule': ['Blocked by the rule «{ruleId}»', 'Заблоковано правилом «{ruleId}»'],
  'source.blocked.carrier': ['Energy rule: {carrier} is not allowed', 'Правило енергії: {carrier} не дозволено'],
  'source.blocked.prerun': ['The pump runs first — until {until}', 'Спершу розганяється насос — до {until}'],
  'source.blocked.disabled': ['Disabled in its settings', 'Вимкнене в налаштуваннях'],
  'source.blocked.conflict': ['Something else keeps changing it — retry at {until}', 'Його постійно змінює щось інше — повтор о {until}'],

  // source state details and roles
  'source.detail.running': ['Running: {mode}[ since {since}][ · flow {flowC}]', 'Працює: {mode}[ з {since}][ · подача {flowC}]'],
  'source.detail.confirming': ['Starting — waiting for confirmation until {deadline}', 'Запуск — чекаю підтвердження до {deadline}'],
  'source.detail.defrost': ['Defrosting since {since}', 'Відтанення з {since}'],
  'source.detail.idle': ['Not running', 'Не працює'],
  'source.detail.test': ['Test run until {until}', 'Перевірка до {until}'],
  'source.detail.forced': ['Forced on: {mode}[ until {until}]', 'Примусово: {mode}[ до {until}]'],
  'source.detail.stage': ['Stage {stage} of {of}', 'Ступінь {stage} з {of}'],
  'role.lead': ['Main', 'Основне'],
  'role.together': ['Together with the main one', 'Разом з основним'],
  'role.reserve': ['Reserve', 'Резерв'],
  'role.reserve_below': ['Reserve below {pointC}', 'Резерв нижче {pointC}'],
  'role.lag_join': ['Joins when the main one is not keeping up', 'Долучається, коли основне не встигає'],
  'role.assist': ['Helps', 'Допомагає'],
  'role.trigger_only': ['Only with «{triggerId}»', 'Лише з «{triggerId}»'],
  'role.room_primary': ['Main for {roomId}', 'Основне для кімнати «{roomId}»'],
  'role.unused': ['Not used', 'Не використовується'],

  // «Чому саме так» of the plant
  'plant.season': ['Season: {season} (average outdoor {avgC})', 'Сезон: {season} (середня надворі {avgC})'],
  'plant.lead': ['{sourceId} leads ({mode}) at {toutC} outdoors', '{sourceId} — основне ({mode}) при {toutC} надворі'],
  'plant.bivalent_hp': ['Outdoor {toutC} is above {pointC} — the heat pump copes alone', 'Надворі {toutC}, вище {pointC} — тепловий насос справляється сам'],
  'plant.bivalent_reserve': ['Below {pointC} — {sourceId} takes over', 'Нижче {pointC} — працює {sourceId}'],
  'plant.lag': ['{sourceId} joined: rooms stayed short of their target for {minutes}', '{sourceId} долучилося: кімнати не добирали цілі {minutes}'],
  'plant.failover': ['{from:source} failed ({code}) — switched to {to:source}', '{from:source} — аварія ({code}), перемкнуто на {to:source}'],
  'plant.budget': ['Power budget: {usedKw} of {budgetKw}', 'Бюджет потужності: {usedKw} з {budgetKw}'],
  'plant.rule_active': ['Rule «{ruleId}» is active', 'Діє правило «{ruleId}»'],
  'plant.trigger_active': ['Trigger «{triggerId}» is active', 'Активний тригер «{triggerId}»'],
  'plant.no_demand': ['No room is asking for heat or cooling', 'Жодна кімната не просить тепла чи прохолоди'],
  'plant.dew_guard': ['{circuitId}: supply {supplyC} kept above the dew point {dewC}', '{circuitId}: подачу {supplyC} тримаю вище точки роси {dewC}'],
  'plant.dew_hold': ['{circuitId}: floor cooling rests after the dew point guard, until {until}', '{circuitId}: охолодження на паузі після захисту від роси, до {until}'],
  'plant.dew_lockout': [
    '{circuitId}: floor cooling locked after {trips|dew point stop|dew point stops}, until {until}',
    '{circuitId}: охолодження заблоковано після {trips|спрацювання|спрацювань|спрацювань} захисту від роси, до {until}',
  ],
  'plant.summer_idle': ['Summer: central heating rests', 'Літо: центральне опалення відпочиває'],
  'plant.neutral_guard': ['Between seasons: heating {n|cold room|cold rooms}', 'Міжсезоння: гріє {n|холодну кімнату|холодні кімнати|холодних кімнат}'],
  'plant.frost_fallback': ['Frost protection: {sourceId} heats {roomId}', 'Захист від морозу: {sourceId} гріє кімнату «{roomId}»'],
  'plant.flow_curve': ['Weather curve: outdoor {toutC} → flow {flowC}', 'Погодна крива: надворі {toutC} → подача {flowC}'],
  'plant.cutoff': ['Outdoor {toutC} is above {cutoffC} — central heating not needed', 'Надворі {toutC}, вище {cutoffC} — центральне опалення не потрібне'],
  'plant.house_off': ['The house is switched off', 'Будинок вимкнено'],
  // `since` is null while the plant has not seen the moment the link dropped
  'plant.blind': ['No connection to Home Assistant[ since {since}] — nothing is switched', 'Немає зв’язку з Home Assistant[ з {since}] — нічого не перемикаю'],
  'plant.cool_by_ac': ['Air conditioners cool {n|room|rooms}', 'Кондиціонери охолоджують {n|кімнату|кімнати|кімнат}'],

  // circuits
  'circuit.heating': ['Heating[ · supply {supplyC}][ · {sourceId}]', 'Гріє[ · подача {supplyC}][ · {sourceId}]'],
  'circuit.cooling': ['Cooling[ · supply {supplyC}][ · dew point {dewC}]', 'Охолоджує[ · подача {supplyC}][ · точка роси {dewC}]'],
  'circuit.run_on': ['Run-on until {until}', 'Вибіг до {until}'],
  'circuit.idle': ['Not running', 'Не працює'],
  'circuit.summer': ['Summer pause', 'Літня пауза'],
  'circuit.dew_blocked': ['Blocked by the dew point {dewC}', 'Заблоковано точкою роси {dewC}'],
  'circuit.dew_hold': ['Paused by the dew point guard until {until}', 'Пауза через точку роси до {until}'],
  'circuit.dew_lockout': ['Cooling locked until {until}[ · {trips|stop|stops} in 2 h]', 'Охолодження заблоковано до {until}[ · {trips|спрацювання|спрацювання|спрацювань} за 2 год]'],
  'circuit.no_source': ['No source available', 'Немає доступного джерела'],
  'circuit.heat_only_blocked': ['Heating only — closed while cooling', 'Лише для тепла — закритий, поки охолоджує'],

  // energy
  'energy.grid_ok': ['Grid power is on', 'Мережа є'],
  'energy.budget_used': ['Blackout: {usedKw} of {budgetKw}', 'Блекаут: {usedKw} з {budgetKw}'],
  // without a battery entity there is no charge to show
  'energy.economy': ['Economy[: battery {soc}]', 'Економія[: батарея {soc}]'],
  'energy.critical': ['Battery critically low ({soc}) — frost protection only', 'Критичний заряд батареї ({soc}) — лише захист від морозу'],
  'energy.night_tariff_at': ['Night tariff from {at}', 'Нічний тариф з {at}'],
  'energy.solar_to_heat': ['Solar surplus {pvKw} → heat', 'Надлишок сонця {pvKw} → тепло'],
  'energy.solar_to_cold': ['Solar surplus {pvKw} → cooling', 'Надлишок сонця {pvKw} → прохолода'],
  'energy.not_configured': ['Energy is not set up', 'Енергію не налаштовано'],

  // trigger live texts
  'trigger.live.value': [(v) => valueTpl('Now ', v), (v) => valueTpl('Зараз ', v)],
  'trigger.live.since': ['Active since {since}', 'Активний з {since}'],
  'trigger.live.next_change': ['Next change at {at}', 'Наступна зміна о {at}'],
  'trigger.live.unknown': ['{entityId} is unavailable', '{entityId} недоступна'],
  'trigger.live.disabled': ['Trigger disabled', 'Тригер вимкнено'],
  'trigger.live.error': ['Error: {error}', 'Помилка: {error}'],
  'trigger.live.inactive': ['Inactive', 'Неактивний'],

  // devices and hints
  'dev.trv_heating': ['Open · target {setpointC}[ · valve {valvePct}]', 'Відкрита · ціль {setpointC}[ · клапан {valvePct}]'],
  'dev.trv_closed': ['Closed · target {setpointC}', 'Закрита · ціль {setpointC}'],
  'dev.trv_idle': ['Waiting', 'Чекає'],
  'dev.reading': [(v) => valueTpl('', v), (v) => valueTpl('', v)],
  'dev.contact_open': ['Open[ for {since:ago}]', 'Відкрите[ {since:ago}]'],
  'dev.contact_closed': ['Closed', 'Закрите'],
  'dev.relay_on': ['On[ since {since}]', 'Увімкнено[ з {since}]'],
  'dev.relay_off': ['Off', 'Вимкнено'],
  'dev.source': ['{state:sstate}', '{state:sstate}'],
  'dev.offline': ['Offline[ since {since}]', 'Не на зв’язку[ з {since}]'],
  'dev.valve_pct': ['Valve {pct}', 'Клапан {pct}'],
  'dev.pump': ['{state:pstate}', '{state:pstate}'],
  'hint.aqara_rejoin': [
    'Aqara devices sometimes drop off — press the button on the device so it rejoins.',
    'Пристрої Aqara іноді відпадають — натисніть кнопку на пристрої, щоб він перепідключився.',
  ],
  'hint.add_router': [
    'Weak signal — add a Zigbee router (a mains-powered plug) nearby.',
    'Слабкий сигнал — додайте поруч Zigbee-роутер (розетку з живленням від мережі).',
  ],
  'hint.battery_type': ['Replace the battery[ ({type})].', 'Замініть батарейку[ ({type})].'],
  'hint.check_power': ['Check the power supply of the device.', 'Перевірте живлення пристрою.'],
  'hint.check_z2m': ['Check that Zigbee2MQTT is running.', 'Перевірте, чи працює Zigbee2MQTT.'],
  'hint.replace_entity': ['The entity is gone from Home Assistant — pick its replacement.', 'Сутності вже немає в Home Assistant — оберіть заміну.'],
  'hint.disable_automation': [
    'Something else keeps changing {entityId} — disable that automation.',
    '{entityId} постійно змінює щось інше — вимкніть ту автоматизацію.',
  ],
  'hint.check_trv': ['Check the radiator valve: batteries, mounting, child lock.', 'Перевірте головку: батарейки, кріплення, блокування.'],

  // season
  'season.auto': ['Auto: {season} · average {avgC}', 'Авто: {season} · середня {avgC}'],
  'season.forced': ['Set by hand: {mode:hmode}', 'Вручну: {mode:hmode}'],
  'season.pending': ['Switches to {to:season} at {eligibleAt}', 'Перемкнеться на {to:season} о {eligibleAt}'],
  'season.months_gate': ['Not allowed this month: {season}', 'Цього місяця не дозволено: {season}'],
  'season.no_data': ['No outdoor data — the season follows the calendar', 'Немає даних надворі — сезон за календарем'],
};

/** A reading with its unit: «20.5°», «46%», «2.1 kW», «on». */
function valueTpl(prefix: string, v: Vars): string {
  const unit = typeof v.unit === 'string' ? v.unit : '';
  if (unit === '°C' && typeof v.value === 'number') return `${prefix}{value:temp}`;
  if (unit === '%') return `${prefix}{value:pct}`;
  return unit ? `${prefix}{value} {unit:raw}` : `${prefix}{value}`;
}
