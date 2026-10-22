import { isPlainObject, seedName, seedProfiles } from '../shared/defaults';
import type { Lang } from '../shared/model';

/**
 * The demo house is Ukrainian at heart; `KLIMO_SIM_LANG=en` renders it in English instead: room,
 * device and source names, the fake Home Assistant's language and friendly names, and through them
 * Klimo's notification language. Only display names change — ids, slugs and entity ids stay the same,
 * so scenarios, tests and the card harness work identically in both languages.
 */

const EN: Record<string, string> = {
  // rooms and areas
  Вітальня: 'Living room',
  Спальня: 'Bedroom',
  Дитяча: 'Kids’ room',
  Кабінет: 'Study',
  Кухня: 'Kitchen',
  Ванна: 'Bathroom',
  Коридор: 'Hall',
  Котельня: 'Boiler room',
  Гараж: 'Garage',
  Дім: 'Home',

  // entity names
  Батарея: 'Battery',
  'Якість зв’язку': 'Link quality',
  'Корекція температури': 'Temperature calibration',
  'Відкриття клапана': 'Valve opening',
  'Блокування від дітей': 'Child lock',
  'Відкрите вікно': 'Open window',
  'Зовнішня температура': 'External temperature',
  'Вибір датчика': 'Sensor select',
  'Відкриття клапана, макс.': 'Valve opening, max',
  'Закриття клапана, мін.': 'Valve closing, min',
  Температура: 'Temperature',
  Вологість: 'Humidity',
  Потужність: 'Power',
  'Вимкнути через': 'Switch off in',
  'Полум’я': 'Flame',
  Компресор: 'Compressor',
  Відтавання: 'Defrost',
  Подача: 'Supply',
  Обратка: 'Return',
  'Подача підлоги': 'Floor supply',
  'Код помилки': 'Error code',
  'Змішувальний клапан підлоги': 'Floor mixing valve',
  'Температура надворі': 'Outdoor temperature',
  'Вологість надворі': 'Outdoor humidity',
  'Немає мережі': 'Grid down',
  'Сонячні панелі': 'Solar panels',
  'Споживання будинку': 'House load',
  'Заряд батареї': 'Battery charge',
  'Стан з’єднання': 'Connection state',

  // devices, sensors and their places in the rooms
  'Радіатор під вікном': 'Radiator under the window',
  'Радіатор біля дверей': 'Radiator by the door',
  Радіатор: 'Radiator',
  Радіатори: 'Radiators',
  Рушникосушка: 'Towel rail',
  рушникосушка: 'towel rail',
  'Біля дивана': 'By the sofa',
  'Полиця біля ТВ': 'TV shelf',
  'Біля вікна, над радіатором': 'By the window, above the radiator',
  'Над ліжком': 'Above the bed',
  Комод: 'Dresser',
  Стіл: 'Desk',
  Полиця: 'Shelf',
  Острів: 'Island',
  'Біля вікна': 'By the window',
  Стеля: 'Ceiling',
  Вхід: 'Entrance',
  'Вікно ліве': 'Left window',
  'Двері на терасу': 'Terrace door',
  Вікно: 'Window',
  'Реле котла · сухий контакт': 'Boiler relay · dry contact',
  'Zigbee-реле': 'Zigbee relay',
  'Zigbee-розетка 16 А': 'Zigbee plug 16 A',
  'Насос радіаторів': 'Radiator pump',
  'Насос теплої підлоги': 'Floor heating pump',
  'Насос підлоги · резерв': 'Floor pump · standby',
  'Насос колектора': 'Manifold pump',
  'Конвектор · розетка': 'Convector · plug',
  Осушувач: 'Dehumidifier',
  'Тепловий насос': 'Heat pump',
  'Газовий котел': 'Gas boiler',
  Кондиціонер: 'Air conditioner',
  Кондиціонери: 'Air conditioners',
  'Кондиціонер у вітальні': 'Living room AC',
  'Кондиціонер у спальні': 'Bedroom AC',
  'Кондиціонер у дитячій': 'Kids’ room AC',
  Електроконвектор: 'Electric convector',
  Колектор: 'Manifold',
  'ESP32 · колектор': 'ESP32 · manifold',
  Метеостанція: 'Weather station',
  'ESP32 · метеостанція': 'ESP32 · weather station',
  Інвертор: 'Inverter',
  'Головка в гаражі': 'Garage head',
  'Датчик у гаражі': 'Garage sensor',
  'Розетка в гаражі': 'Garage plug',
  'повітря — вода': 'air to water',
  'Повітря — вода': 'Air to water',
  'спліт-система': 'split system',
  'Спліт-система': 'Split system',
  'Сухий контакт': 'Dry contact',
  'Розетка 16 А': 'Plug 16 A',

  // hydronics
  'Тепла підлога': 'Underfloor heating',
  'Контур радіаторів': 'Radiator circuit',
  'Контур теплої підлоги': 'Underfloor circuit',

  // people, notification targets, the rest of Home Assistant
  Ігор: 'Ihor',
  Оля: 'Olia',
  'Мій телефон': 'My phone',
  Телефон: 'Phone',
  'Планшет на кухні': 'Kitchen tablet',
  Планшет: 'Tablet',
  'Telegram · я': 'Telegram · me',
  'Telegram · сім’я': 'Telegram · family',
  'Сім’я': 'Family',
  Панель: 'Panel',
  Подія: 'Event',
  'Погода вдома': 'Home weather',
  Сонце: 'Sun',
  'Друзі на вечерю': 'Friends for dinner',
};

// the first-boot seed names its own profiles, triggers and rules; take those pairs from the seed itself
for (const [i, p] of seedProfiles('uk').entries()) EN[p.name] = seedProfiles('en')[i].name;
const SEED_KEYS: readonly Parameters<typeof seedName>[0][] = ['blackout', 'solar', 'night_tariff', 'frost', 'battery_low', 'economy', 'store_heat', 'preheat_night', 'panel', 'automations', 'acGroup'];
for (const k of SEED_KEYS) EN[seedName(k, 'uk')] = seedName(k, 'en');

/** Names that carry a number. */
const PATTERNS: readonly [RegExp, string][] = [[/^Радіатори · (\d+) головки$/, 'Radiators · $1 heads']];

/** One display string in the simulator's language; unknown strings pass through. */
export function simText(text: string, lang: Lang): string {
  if (lang === 'uk') return text;
  const exact = EN[text];
  if (exact !== undefined) return exact;
  for (const [re, out] of PATTERNS) if (re.test(text)) return text.replace(re, out);
  return text;
}

/** A copy of plain data with every known display string in the simulator's language. */
export function inSimLanguage<T>(value: T, lang: Lang): T {
  if (lang === 'uk') return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return simText(v, lang);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
